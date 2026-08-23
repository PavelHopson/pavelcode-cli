import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import test from 'node:test'

import {
  createSentinelOfficeRuntime,
  readSentinelOfficeRuntimeConfig,
  SentinelOfficeRuntimeError,
} from '../office/sentinel-office-runtime.mjs'

const SECRET_TEXT = '0123456789abcdef0123456789abcdef'
const CONFIG = Object.freeze({
  SENTINEL_OFFICE_ENABLED: '1',
  SENTINEL_OFFICE_ALLOW_HTTP_LOOPBACK: '1',
  SENTINEL_OFFICE_BASE_URL: 'http://127.0.0.1:43210',
  SENTINEL_OFFICE_WORKSPACE_ID: 'workspace-test',
  SENTINEL_OFFICE_KEY_ID: 'sentinel-test-01',
})

test('Office runtime is opt-in and does not touch credentials or network while disabled', async () => {
  let clientCalls = 0
  const runtime = await createSentinelOfficeRuntime({
    environment: {},
    createClient: async () => { clientCalls += 1 },
  })

  assert.deepEqual(readSentinelOfficeRuntimeConfig({}), { enabled: false })
  assert.deepEqual(runtime.status(), {
    enabled: false,
    ready: false,
    code: 'OFFICE_DISABLED',
    message: 'Office projection is disabled.',
  })
  assert.equal(clientCalls, 0)
  assert.deepEqual(runtime.recordSuccess({}, {}), { queued: false, code: 'OFFICE_DISABLED' })
})

test('Office runtime requires an exact origin and blocks secret-bearing environment config', async () => {
  assert.throws(
    () => readSentinelOfficeRuntimeConfig({ ...CONFIG, SENTINEL_OFFICE_BASE_URL: 'http://example.com' }),
    (error) => error instanceof SentinelOfficeRuntimeError && error.code === 'OFFICE_CONFIGURATION_INVALID',
  )
  assert.throws(
    () => readSentinelOfficeRuntimeConfig({ ...CONFIG, SENTINEL_OFFICE_BASE_URL: 'http://127.0.0.1:43210/path' }),
    (error) => error instanceof SentinelOfficeRuntimeError && error.code === 'OFFICE_CONFIGURATION_INVALID',
  )

  assert.throws(
    () => readSentinelOfficeRuntimeConfig({ ...CONFIG, SENTINEL_OFFICE_KEY_ID: 'UPPERCASE' }),
    (error) => error instanceof SentinelOfficeRuntimeError && error.code === 'OFFICE_CONFIGURATION_INVALID',
  )
  let clientCalls = 0
  const runtime = await createSentinelOfficeRuntime({
    environment: { ...CONFIG, SENTINEL_OFFICE_PRODUCER_SECRET: SECRET_TEXT },
    createClient: async () => { clientCalls += 1 },
  })
  assert.equal(clientCalls, 0)
  assert.equal(runtime.status().code, 'OFFICE_SECRET_CONFIGURATION_BLOCKED')
  assert.doesNotMatch(JSON.stringify(runtime.status()), new RegExp(SECRET_TEXT))
  assert.doesNotMatch(inspect(runtime), new RegExp(SECRET_TEXT))
})

test('missing credential fails closed with a bounded diagnostic', async () => {
  const runtime = await createSentinelOfficeRuntime({
    environment: CONFIG,
    createClient: async () => { throw Object.assign(new Error(SECRET_TEXT), { code: 'NOT_FOUND' }) },
  })

  assert.deepEqual(runtime.status(), {
    enabled: true,
    ready: false,
    code: 'OFFICE_CREDENTIAL_NOT_PROVISIONED',
    message: 'Office producer credential is not provisioned in Windows Credential Manager.',
  })
  assert.doesNotMatch(JSON.stringify(runtime), new RegExp(SECRET_TEXT))
})

test('enabled runtime reads the credential in main memory and publishes through signed Office ingest', async () => {
  const secret = Buffer.from(SECRET_TEXT, 'utf8')
  let leaseDisposed = false
  let fetchCalls = 0
  let cursor = 0
  const requestBodies = []
  const credentialStore = {
    async read(identity) {
      assert.deepEqual(identity, { producerId: 'eclipse-hopson-sentinel', keyId: 'sentinel-test-01' })
      return {
        withBytes(callback) {
          const temporary = Buffer.from(secret)
          try { return callback(temporary) } finally { temporary.fill(0) }
        },
        dispose() { leaseDisposed = true },
      }
    },
  }
  const fetch = async (url, request) => {
    fetchCalls += 1
    assert.equal(url, 'http://127.0.0.1:43210/api/servers/workspace-test/office/events/ingest')
    assert.equal(request.method, 'POST')
    assert.equal(request.redirect, 'error')
    assert.equal(request.credentials, 'omit')
    assert.match(request.headers['x-office-signature'], /^v1=[0-9a-f]{64}$/)
    assert.doesNotMatch(JSON.stringify(request.headers), new RegExp(SECRET_TEXT))
    const body = JSON.parse(request.body)
    requestBodies.push(body)
    const events = body.events.map((input) => {
      cursor += 1
      return {
        schemaVersion: 'office.event.v1',
        id: `00000000-0000-4000-8000-${String(8_000 + cursor).padStart(12, '0')}`,
        workspaceId: input.workspaceId,
        sequence: cursor,
        occurredAt: '2026-08-23T18:00:00.000Z',
        type: input.type,
        subject: input.subject,
        summary: input.summary,
        metadata: input.metadata,
      }
    })
    return new Response(JSON.stringify({
      schemaVersion: 'office.event.v1',
      source: 'office-core-runtime',
      events,
      cursor,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  let nextId = 7_000
  const runtime = await createSentinelOfficeRuntime({
    environment: CONFIG,
    credentialStore,
    fetch,
    transportNow: () => 1_777_777_777_777,
    lifecycleNow: () => new Date('2026-08-23T18:00:00.000Z'),
    nonceFactory: () => '00000000-0000-4000-8000-000000007777',
    idFactory: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
    maxAttempts: 1,
  })

  assert.equal(leaseDisposed, true)
  assert.equal(runtime.status().code, 'OFFICE_READY')
  assert.deepEqual(runtime.recordBlocked({}, { code: 'OPERATOR_FAILED' }), { queued: true, code: null })
  const stats = await runtime.flush()
  assert.equal(stats.completed, 1)
  assert.equal(stats.failed, 0)
  assert.equal(fetchCalls > 0, true)
  assert.doesNotMatch(JSON.stringify(requestBodies), new RegExp(SECRET_TEXT))

  runtime.dispose()
  assert.equal(runtime.status().code, 'OFFICE_DISPOSED')
  assert.deepEqual(runtime.recordBlocked({}, {}), { queued: false, code: 'OFFICE_DISPOSED' })
  secret.fill(0)
})
