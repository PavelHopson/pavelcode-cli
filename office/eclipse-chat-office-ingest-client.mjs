import { createHash, createHmac, randomUUID } from 'node:crypto'

import {
  ECLIPSE_CHAT_OFFICE_SCHEMA,
  validateEclipseChatOfficeEvent,
  validateEclipseChatOfficeInput,
} from './eclipse-chat-office-adapter.mjs'

export const ECLIPSE_CHAT_OFFICE_INGEST_SCHEMA = 'office.ingest.v1'

const MAX_BATCH_SIZE = 50
const MAX_BODY_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 256 * 1024
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const ERROR_MESSAGES = Object.freeze({
  BODY_TOO_LARGE: 'Office ingest body exceeds 64 KiB',
  CLIENT_DISPOSED: 'Office ingest client is no longer available',
  HTTP_4XX: 'Office Core rejected the authenticated ingest request',
  INVALID_CONFIGURATION: 'Office ingest client configuration is invalid',
  INVALID_RESPONSE: 'Office Core returned an invalid ingest response',
  OFFICE_CORE_UNAVAILABLE: 'Office Core is unavailable',
  WORKSPACE_MISMATCH: 'Office event workspace does not match the configured workspace',
})

export class EclipseChatOfficeIngestError extends Error {
  constructor(code, message = ERROR_MESSAGES[code] || 'Office ingest failed') {
    super(message)
    this.name = 'EclipseChatOfficeIngestError'
    this.code = code
  }
}

function fail(code, message) {
  throw new EclipseChatOfficeIngestError(code, message)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function canonicalize(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON numbers must be finite')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value !== 'object') throw new TypeError('Canonical JSON does not support this value')
  if (ancestors.has(value)) throw new TypeError('Canonical JSON does not support cyclic values')

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const propertyNames = Object.getOwnPropertyNames(value)
      if (Object.getPrototypeOf(value) !== Array.prototype
        || Object.getOwnPropertySymbols(value).length > 0
        || propertyNames.length !== value.length + 1) {
        throw new TypeError('Canonical JSON requires a dense plain array')
      }
      const items = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError('Canonical JSON requires a dense plain array')
        }
        items.push(canonicalize(descriptor.value, ancestors))
      }
      return `[${items.join(',')}]`
    }
    if (!isPlainObject(value)) throw new TypeError('Canonical JSON requires a plain JSON object')
    const stringKeys = Object.keys(value)
    if (Object.getOwnPropertySymbols(value).length > 0
      || Reflect.ownKeys(value).length !== stringKeys.length) {
      throw new TypeError('Canonical JSON requires enumerable string keys')
    }

    const entries = stringKeys.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('Canonical JSON does not support accessors')
      }
      return `${JSON.stringify(key)}:${canonicalize(descriptor.value, ancestors)}`
    })
    return `{${entries.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function stableCanonicalJson(value) {
  return canonicalize(value, new WeakSet())
}

function validateBoundedString(value, name, maxLength) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > maxLength) {
    throw new TypeError(`${name} is invalid`)
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must not contain control characters`)
  }
  return value
}

function validateKeyId(keyId) {
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) throw new TypeError('Office keyId is invalid')
  return keyId
}

function validateNonce(nonce) {
  if (typeof nonce !== 'string' || !UUID_PATTERN.test(nonce)) throw new TypeError('Office nonce must be a UUID')
  return nonce
}

function validateTimestamp(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new TypeError('Office timestamp must be Unix milliseconds')
  return timestamp
}

function validateSecret(secret) {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
    throw new TypeError('Office signing secret must contain at least 32 bytes')
  }
  return Buffer.from(secret)
}

export function createOfficeIngestSignature({ keyId, workspaceId, timestamp, nonce, body, secret }) {
  const safeKeyId = validateKeyId(keyId)
  const safeWorkspaceId = validateBoundedString(workspaceId, 'workspaceId', 160)
  const safeTimestamp = validateTimestamp(timestamp)
  const safeNonce = validateNonce(nonce)
  const bodyJson = stableCanonicalJson(body)
  const bodyHash = createHash('sha256').update(bodyJson, 'utf8').digest('hex')
  const canonical = `${ECLIPSE_CHAT_OFFICE_INGEST_SCHEMA}\n${safeKeyId}\n${safeWorkspaceId}\n${safeTimestamp}\n${safeNonce}\n${bodyHash}`
  const secretBytes = validateSecret(secret)
  try {
    const digest = createHmac('sha256', secretBytes).update(canonical, 'utf8').digest('hex')
    return Object.freeze({ bodyJson, bodyHash, canonical, signature: `v1=${digest}` })
  } finally {
    secretBytes.fill(0)
  }
}

function cloneInput(input) {
  validateEclipseChatOfficeInput(input)
  return Object.freeze({
    workspaceId: input.workspaceId,
    type: input.type,
    subject: Object.freeze({ kind: input.subject.kind, id: input.subject.id }),
    summary: input.summary,
    metadata: Object.freeze({ ...input.metadata }),
  })
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function samePrimitiveRecord(left, right) {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && Object.is(left[key], right[key]))
}

function persistedMatchesInput(event, input) {
  return event.workspaceId === input.workspaceId
    && event.type === input.type
    && event.subject.kind === input.subject.kind
    && event.subject.id === input.subject.id
    && event.summary === input.summary
    && samePrimitiveRecord(event.metadata, input.metadata)
}

function freezeEvent(event) {
  return Object.freeze({
    ...event,
    subject: Object.freeze({ ...event.subject }),
    metadata: Object.freeze({ ...event.metadata }),
  })
}

async function readBoundedResponse(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) fail('INVALID_RESPONSE')
    return text
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        fail('INVALID_RESPONSE')
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } catch (error) {
    if (error instanceof EclipseChatOfficeIngestError) throw error
    fail('INVALID_RESPONSE')
  } finally {
    reader.releaseLock()
  }
}


async function cancelResponseBody(response) {
  try {
    if (response?.body && typeof response.body.cancel === 'function') {
      await response.body.cancel()
    }
  } catch {
    // Response cleanup must not expose or replace the bounded transport result.
  }
}
async function parseSuccessResponse(response, inputs) {
  const contentType = response.headers?.get?.('content-type') || ''
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) fail('INVALID_RESPONSE')

  let payload
  try {
    payload = JSON.parse(await readBoundedResponse(response))
  } catch (error) {
    if (error instanceof EclipseChatOfficeIngestError) throw error
    fail('INVALID_RESPONSE')
  }

  if (!exactKeys(payload, ['schemaVersion', 'source', 'events', 'cursor'])
    || payload.schemaVersion !== ECLIPSE_CHAT_OFFICE_SCHEMA
    || payload.source !== 'office-core-runtime'
    || !Array.isArray(payload.events)
    || payload.events.length !== inputs.length
    || !Number.isSafeInteger(payload.cursor)
    || payload.cursor < 1) {
    fail('INVALID_RESPONSE')
  }

  let previousSequence = 0
  const events = payload.events.map((event, index) => {
    try {
      validateEclipseChatOfficeEvent(event)
    } catch {
      fail('INVALID_RESPONSE')
    }
    if (!persistedMatchesInput(event, inputs[index]) || event.sequence <= previousSequence) {
      fail('INVALID_RESPONSE')
    }
    previousSequence = event.sequence
    return freezeEvent(event)
  })
  if (payload.cursor !== previousSequence) fail('INVALID_RESPONSE')
  return Object.freeze(events)
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function validateBaseUrl(baseUrl, allowedOrigins, allowHttpLoopback) {
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new TypeError('Office baseUrl is invalid')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new TypeError('Office baseUrl must contain only an origin')
  }
  if (parsed.protocol !== 'https:'
    && !(parsed.protocol === 'http:' && allowHttpLoopback === true && isLoopback(parsed.hostname))) {
    throw new TypeError('Office baseUrl requires HTTPS; explicit HTTP is limited to loopback')
  }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length < 1
    || allowedOrigins.some((origin) => typeof origin !== 'string')
    || !allowedOrigins.includes(parsed.origin)) {
    throw new TypeError('Office baseUrl origin is not in the allowlist')
  }
  return parsed.origin
}

function validateBasePath(basePath) {
  if (basePath === undefined || basePath === '') return ''
  if (typeof basePath !== 'string'
    || basePath.length > 128
    || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(basePath)) {
    throw new TypeError('Office basePath must be an absolute normalized path prefix')
  }
  return basePath
}

function integerOption(value, fallback, minimum, maximum, name) {
  const selected = value === undefined ? fallback : value
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new TypeError(`${name} is out of range`)
  }
  return selected
}

export function createEclipseChatOfficeIngestClient(options = {}) {
  const baseOrigin = validateBaseUrl(options.baseUrl, options.allowedOrigins, options.allowHttpLoopback)
  const basePath = validateBasePath(options.basePath)
  const workspaceId = validateBoundedString(options.workspaceId, 'workspaceId', 160)
  const keyId = validateKeyId(options.keyId)
  const secret = validateSecret(options.secret)
  const fetchImpl = options.fetch || globalThis.fetch
  const now = options.now || Date.now
  const nonceFactory = options.nonceFactory || randomUUID
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const timeoutMs = integerOption(options.timeoutMs, 5_000, 250, 15_000, 'timeoutMs')
  const maxAttempts = integerOption(options.maxAttempts, 2, 1, 3, 'maxAttempts')

  if (typeof fetchImpl !== 'function' || typeof now !== 'function'
    || typeof nonceFactory !== 'function' || typeof sleep !== 'function') {
    secret.fill(0)
    fail('INVALID_CONFIGURATION')
  }
  if (maxAttempts > 1 && options.idempotentReplay !== true) {
    secret.fill(0)
    throw new TypeError('Retries require an idempotent replay response contract')
  }

  const endpoint = `${baseOrigin}${basePath}/api/servers/${encodeURIComponent(workspaceId)}/office/events/ingest`
  let disposed = false

  function publishBatch(batch) {
    if (disposed) fail('CLIENT_DISPOSED')
    if (!Array.isArray(batch) || batch.length < 1 || batch.length > MAX_BATCH_SIZE) {
      throw new TypeError('Office ingest batch must contain 1 to 50 events')
    }

    const inputs = Object.freeze(batch.map((item) => cloneInput(item)))
    if (inputs.some((item) => item.workspaceId !== workspaceId)) fail('WORKSPACE_MISMATCH')
    const body = Object.freeze({ schemaVersion: ECLIPSE_CHAT_OFFICE_INGEST_SCHEMA, events: inputs })
    const timestamp = validateTimestamp(now())
    const nonce = validateNonce(nonceFactory())
    const signed = createOfficeIngestSignature({ keyId, workspaceId, timestamp, nonce, body, secret })
    if (Buffer.byteLength(signed.bodyJson, 'utf8') > MAX_BODY_BYTES) fail('BODY_TOO_LARGE')

    const headers = Object.freeze({
      'content-type': 'application/json',
      'x-office-key-id': keyId,
      'x-office-timestamp': String(timestamp),
      'x-office-nonce': nonce,
      'x-office-signature': signed.signature,
    })

    return (async () => {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), timeoutMs)
        let response
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers,
            body: signed.bodyJson,
            redirect: 'error',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
          })
        } catch {
          response = null
        } finally {
          clearTimeout(timeout)
        }

        if (response && Number.isSafeInteger(response.status)) {
          if (response.status >= 200 && response.status < 300) {
            return parseSuccessResponse(response, inputs)
          }
          if (response.status >= 400 && response.status < 500) {
            await cancelResponseBody(response)
            fail('HTTP_4XX')
          }
        }
        if (response) await cancelResponseBody(response)
        if (attempt < maxAttempts) await sleep(Math.min(100 * (2 ** (attempt - 1)), 500))
      }
      fail('OFFICE_CORE_UNAVAILABLE')
    })()
  }

  function dispose() {
    if (!disposed) secret.fill(0)
    disposed = true
  }

  return Object.freeze({ publishBatch, dispose })
}
