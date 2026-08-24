import { inspect } from 'node:util'

import { createCredentialBackedOfficeIngestClient } from './credential-backed-office-client.mjs'
import { createEclipseChatOfficePublisher } from './eclipse-chat-office-adapter.mjs'
import { createSentinelOfficeLifecycle } from './sentinel-office-lifecycle.mjs'

const PRODUCER_ID = 'eclipse-hopson-sentinel'
const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const SENSITIVE_ENV_PATTERN = /^SENTINEL_OFFICE_.*(?:SECRET|TOKEN|PASSWORD|API_KEY)/i

const DIAGNOSTICS = Object.freeze({
  OFFICE_DISABLED: 'Office projection is disabled.',
  OFFICE_CONFIGURATION_INVALID: 'Office projection configuration is invalid.',
  OFFICE_SECRET_CONFIGURATION_BLOCKED: 'Office producer secrets must be stored only in Windows Credential Manager.',
  OFFICE_CREDENTIAL_NOT_PROVISIONED: 'Office producer credential is not provisioned in Windows Credential Manager.',
  OFFICE_PLATFORM_UNSUPPORTED: 'Office credential storage is unavailable on this platform.',
  OFFICE_INITIALIZATION_FAILED: 'Office projection could not initialize.',
  OFFICE_READY: 'Office projection is connected to the authenticated Office Core ingest boundary.',
  OFFICE_DISPOSED: 'Office projection has been stopped.',
})

function status(enabled, ready, code) {
  return Object.freeze({ enabled, ready, code, message: DIAGNOSTICS[code] })
}

export class SentinelOfficeRuntimeError extends Error {
  constructor(code) {
    super(DIAGNOSTICS[code] || DIAGNOSTICS.OFFICE_CONFIGURATION_INVALID)
    this.name = 'SentinelOfficeRuntimeError'
    this.code = code
    Object.freeze(this)
  }

  toJSON() {
    return Object.freeze({ name: this.name, code: this.code, message: this.message })
  }

  [inspect.custom]() {
    return `${this.name} { code: ${this.code} }`
  }
}

function fail(code) {
  throw new SentinelOfficeRuntimeError(code)
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function exactIdentifier(value, maxLength = 128) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || value !== value.trim()
    || !IDENTIFIER_PATTERN.test(value)) {
    fail('OFFICE_CONFIGURATION_INVALID')
  }
  return value
}

function exactOrigin(value, allowHttpLoopback) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail('OFFICE_CONFIGURATION_INVALID')
  }
  const isHttps = parsed.protocol === 'https:'
  const isAllowedLoopback = parsed.protocol === 'http:' && allowHttpLoopback && isLoopback(parsed.hostname)
  if ((!isHttps && !isAllowedLoopback)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin !== value.replace(/\/$/, '')) {
    fail('OFFICE_CONFIGURATION_INVALID')
  }
  return parsed.origin
}

function exactBasePath(value) {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string'
    || value.length > 128
    || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value)) {
    fail('OFFICE_CONFIGURATION_INVALID')
  }
  return value
}

function requestedBy(environment) {
  return environment?.SENTINEL_OFFICE_ENABLED !== undefined
    && environment.SENTINEL_OFFICE_ENABLED !== '0'
}

export function readSentinelOfficeRuntimeConfig(environment = process.env) {
  if (!environment || typeof environment !== 'object') fail('OFFICE_CONFIGURATION_INVALID')
  if (Object.keys(environment).some((key) => SENSITIVE_ENV_PATTERN.test(key))) {
    fail('OFFICE_SECRET_CONFIGURATION_BLOCKED')
  }

  const enabledValue = environment.SENTINEL_OFFICE_ENABLED
  if (enabledValue === undefined || enabledValue === '' || enabledValue === '0') {
    return Object.freeze({ enabled: false })
  }
  if (enabledValue !== '1') fail('OFFICE_CONFIGURATION_INVALID')

  const allowHttpLoopbackValue = environment.SENTINEL_OFFICE_ALLOW_HTTP_LOOPBACK
  if (allowHttpLoopbackValue !== undefined
    && allowHttpLoopbackValue !== ''
    && allowHttpLoopbackValue !== '0'
    && allowHttpLoopbackValue !== '1') {
    fail('OFFICE_CONFIGURATION_INVALID')
  }
  const allowHttpLoopback = allowHttpLoopbackValue === '1'
  const baseUrl = exactOrigin(environment.SENTINEL_OFFICE_BASE_URL, allowHttpLoopback)
  const basePath = exactBasePath(environment.SENTINEL_OFFICE_BASE_PATH)
  const workspaceId = exactIdentifier(environment.SENTINEL_OFFICE_WORKSPACE_ID, 160)
  const keyId = environment.SENTINEL_OFFICE_KEY_ID
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    fail('OFFICE_CONFIGURATION_INVALID')
  }

  return Object.freeze({
    enabled: true,
    baseUrl,
    basePath,
    allowedOrigins: Object.freeze([baseUrl]),
    allowHttpLoopback,
    workspaceId,
    producerId: PRODUCER_ID,
    keyId,
  })
}

function dormantRuntime(runtimeStatus) {
  const emptyStats = Object.freeze({ pending: 0, queued: 0, completed: 0, failed: 0, retained: 0, dropped: 0 })
  return Object.freeze({
    recordSuccess() { return { queued: false, code: runtimeStatus.code } },
    recordBlocked() { return { queued: false, code: runtimeStatus.code } },
    status() { return runtimeStatus },
    async flush() { return emptyStats },
    dispose() {},
  })
}

function initializationFailure(error) {
  if (error?.code === 'NOT_FOUND') return 'OFFICE_CREDENTIAL_NOT_PROVISIONED'
  if (error?.code === 'UNSUPPORTED_PLATFORM') return 'OFFICE_PLATFORM_UNSUPPORTED'
  return 'OFFICE_INITIALIZATION_FAILED'
}

export async function createSentinelOfficeRuntime(options = {}) {
  const environment = options.environment || process.env
  let config
  try {
    config = readSentinelOfficeRuntimeConfig(environment)
  } catch (error) {
    const code = error instanceof SentinelOfficeRuntimeError
      ? error.code
      : 'OFFICE_CONFIGURATION_INVALID'
    return dormantRuntime(status(requestedBy(environment), false, code))
  }
  if (!config.enabled) return dormantRuntime(status(false, false, 'OFFICE_DISABLED'))

  const createClient = options.createClient || createCredentialBackedOfficeIngestClient
  const createPublisher = options.createPublisher || createEclipseChatOfficePublisher
  const createLifecycle = options.createLifecycle || createSentinelOfficeLifecycle
  let client = null
  try {
    client = await createClient({
      ...config,
      credentialStore: options.credentialStore,
      fetch: options.fetch,
      now: options.transportNow,
      nonceFactory: options.nonceFactory,
      sleep: options.sleep,
      timeoutMs: options.timeoutMs,
      maxAttempts: options.maxAttempts ?? 2,
      idempotentReplay: true,
    })
    const publisher = createPublisher({
      workspaceId: config.workspaceId,
      publishBatch: (events) => client.publishBatch(events),
    })
    const lifecycle = createLifecycle({
      publish: (projection) => publisher.publish(projection),
      now: options.lifecycleNow,
      idFactory: options.idFactory,
      maxEventsPerSecond: options.maxEventsPerSecond,
    })
    let disposed = false
    const readyStatus = status(true, true, 'OFFICE_READY')
    const disposedStatus = status(true, false, 'OFFICE_DISPOSED')

    return Object.freeze({
      recordSuccess(request, receipt) {
        return disposed
          ? { queued: false, code: disposedStatus.code }
          : lifecycle.recordSuccess(request, receipt)
      },
      recordBlocked(request, error) {
        return disposed
          ? { queued: false, code: disposedStatus.code }
          : lifecycle.recordBlocked(request, error)
      },
      status() { return disposed ? disposedStatus : readyStatus },
      flush() { return lifecycle.flush() },
      dispose() {
        if (disposed) return
        disposed = true
        client.dispose()
      },
    })
  } catch (error) {
    if (client && typeof client.dispose === 'function') client.dispose()
    return dormantRuntime(status(true, false, initializationFailure(error)))
  }
}
