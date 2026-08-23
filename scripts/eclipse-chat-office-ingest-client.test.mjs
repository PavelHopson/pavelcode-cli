import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createEclipseChatOfficeIngestClient,
  createOfficeIngestSignature,
  EclipseChatOfficeIngestError,
  stableCanonicalJson,
} from '../office/eclipse-chat-office-ingest-client.mjs'
import {
  createEclipseChatOfficePublisher,
  ECLIPSE_CHAT_OFFICE_SCHEMA,
} from '../office/eclipse-chat-office-adapter.mjs'
import { createSentinelOfficeBridge } from '../office/sentinel-office-bridge.mjs'
import { createSentinelOfficeLifecycle } from '../office/sentinel-office-lifecycle.mjs'

const WORKSPACE_ID = 'eclipse-forge'
const KEY_ID = 'sentinel-local-01'
const SECRET = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8')
const NOW_MS = Date.parse('2026-08-23T16:00:00.000Z')
const NONCE = '00000000-0000-4000-8000-000000001501'

function input(overrides = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    type: 'agent.state.changed',
    subject: { kind: 'agent', id: 'sentinel' },
    summary: 'Sentinel presence changed',
    metadata: { state: 'idle', readOnly: true },
    ...overrides,
  }
}

function persisted(eventInput, sequence = 1) {
  return {
    ...eventInput,
    schemaVersion: ECLIPSE_CHAT_OFFICE_SCHEMA,
    id: `00000000-0000-4000-8000-${String(1_600 + sequence).padStart(12, '0')}`,
    sequence,
    occurredAt: new Date(NOW_MS).toISOString(),
  }
}

function successResponse(inputs, extra = {}) {
  return new Response(JSON.stringify({
    schemaVersion: ECLIPSE_CHAT_OFFICE_SCHEMA,
    source: 'office-core-runtime',
    events: inputs.map((eventInput, index) => persisted(eventInput, index + 1)),
    cursor: inputs.length,
    ...extra,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function clientOptions(fetchImpl, overrides = {}) {
  return {
    baseUrl: 'https://office.example.test',
    allowedOrigins: ['https://office.example.test'],
    workspaceId: WORKSPACE_ID,
    keyId: KEY_ID,
    secret: SECRET,
    fetch: fetchImpl,
    now: () => NOW_MS,
    nonceFactory: () => NONCE,
    sleep: async () => {},
    timeoutMs: 1_000,
    maxAttempts: 2,
    idempotentReplay: true,
    ...overrides,
  }
}

test('stable canonical JSON is recursive, deterministic, and rejects ambiguous values', () => {
  const value = { z: 1, a: { b: 2, a: 'й' }, list: [3, { y: false, x: null }] }
  assert.equal(
    stableCanonicalJson(value),
    '{"a":{"a":"й","b":2},"list":[3,{"x":null,"y":false}],"z":1}',
  )
  assert.throws(() => stableCanonicalJson({ value: undefined }), /canonical JSON/i)
  assert.throws(() => stableCanonicalJson({ value: Number.NaN }), /finite/i)
  assert.throws(() => stableCanonicalJson({ value: new Date() }), /plain JSON object/i)
  const sparse = []
  sparse.length = 1
  assert.throws(() => stableCanonicalJson(sparse), /canonical JSON/i)
})

test('HMAC signing matches the canonical v1 vector exactly', () => {
  const body = { schemaVersion: 'office.ingest.v1', events: [input()] }
  const signed = createOfficeIngestSignature({
    keyId: KEY_ID,
    workspaceId: WORKSPACE_ID,
    timestamp: NOW_MS,
    nonce: NONCE,
    body,
    secret: SECRET,
  })
  const expectedHash = createHash('sha256').update(signed.bodyJson, 'utf8').digest('hex')
  const expectedCanonical = `office.ingest.v1\n${KEY_ID}\n${WORKSPACE_ID}\n${NOW_MS}\n${NONCE}\n${expectedHash}`
  const expectedHmac = createHmac('sha256', SECRET).update(expectedCanonical, 'utf8').digest('hex')

  assert.equal(signed.bodyHash, expectedHash)
  assert.equal(signed.canonical, expectedCanonical)
  assert.equal(signed.signature, `v1=${expectedHmac}`)
})

test('client sends an exact signed request and returns validated canonical events', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, init })
    return successResponse(JSON.parse(init.body).events)
  }
  const client = createEclipseChatOfficeIngestClient(clientOptions(fetchImpl))
  const events = await client.publishBatch([input()])

  assert.equal(events.length, 1)
  assert.equal(events[0].sequence, 1)
  assert.equal(requests[0].url, 'https://office.example.test/api/servers/eclipse-forge/office/events/ingest')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.redirect, 'error')
  assert.equal(requests[0].init.headers['content-type'], 'application/json')
  assert.equal(requests[0].init.headers['x-office-key-id'], KEY_ID)
  assert.equal(requests[0].init.headers['x-office-timestamp'], String(NOW_MS))
  assert.equal(requests[0].init.headers['x-office-nonce'], NONCE)
  assert.match(requests[0].init.headers['x-office-signature'], /^v1=[0-9a-f]{64}$/)
  assert.equal('authorization' in requests[0].init.headers, false)
  assert.equal(requests[0].init.body, stableCanonicalJson({ schemaVersion: 'office.ingest.v1', events: [input()] }))
})

test('ambiguous retry reuses the exact signed idempotency tuple', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, init })
    if (requests.length === 1) throw new TypeError('network details must not escape')
    return successResponse(JSON.parse(init.body).events)
  }
  const client = createEclipseChatOfficeIngestClient(clientOptions(fetchImpl))

  const events = await client.publishBatch([input()])
  assert.equal(events.length, 1)
  assert.equal(requests.length, 2)
  for (const field of ['body', 'headers']) assert.deepEqual(requests[1].init[field], requests[0].init[field])
})

test('definite 4xx stops retries and never returns server error details', async () => {
  let attempts = 0
  let rejectionResponse
  const client = createEclipseChatOfficeIngestClient(clientOptions(async () => {
    attempts += 1
    rejectionResponse = new Response(JSON.stringify({ error: 'private stack and credential details' }), { status: 401 })
    return rejectionResponse
  }))

  await assert.rejects(
    () => client.publishBatch([input()]),
    (error) => error instanceof EclipseChatOfficeIngestError
      && error.code === 'HTTP_4XX'
      && !/private stack|credential details/i.test(error.message),
  )
  assert.equal(rejectionResponse.bodyUsed, true)
  assert.equal(attempts, 1)
})

test('5xx and timeout are bounded, while an invalid definite 2xx is never retried', async () => {
  let serverAttempts = 0
  const retryingClient = createEclipseChatOfficeIngestClient(clientOptions(async (_url, init) => {
    serverAttempts += 1
    if (serverAttempts === 1) return new Response(null, { status: 503 })
    return successResponse(JSON.parse(init.body).events)
  }))
  assert.equal((await retryingClient.publishBatch([input()])).length, 1)
  assert.equal(serverAttempts, 2)

  let invalidAttempts = 0
  const invalidClient = createEclipseChatOfficeIngestClient(clientOptions(async () => {
    invalidAttempts += 1
    return successResponse([input()], { unexpected: true })
  }))
  await assert.rejects(
    () => invalidClient.publishBatch([input()]),
    (error) => error instanceof EclipseChatOfficeIngestError && error.code === 'INVALID_RESPONSE',
  )
  assert.equal(invalidAttempts, 1)

  let aborted = false
  const timedClient = createEclipseChatOfficeIngestClient(clientOptions(async (_url, init) => (
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
      aborted = true
      reject(new DOMException('timed out', 'AbortError'))
    }, { once: true }))
  ), { maxAttempts: 1, timeoutMs: 250 }))
  await assert.rejects(
    () => timedClient.publishBatch([input()]),
    (error) => error instanceof EclipseChatOfficeIngestError && error.code === 'OFFICE_CORE_UNAVAILABLE',
  )
  assert.equal(aborted, true)
})

test('client fails closed for unsafe origins, unsafe retries, cross-workspace and oversized bodies', () => {
  const unusedFetch = async () => { throw new Error('must not run') }
  assert.throws(
    () => createEclipseChatOfficeIngestClient(clientOptions(unusedFetch, {
      baseUrl: 'http://169.254.169.254',
      allowedOrigins: ['http://169.254.169.254'],
    })),
    /HTTPS|loopback/i,
  )
  assert.throws(
    () => createEclipseChatOfficeIngestClient(clientOptions(unusedFetch, {
      allowedOrigins: ['https://another.example.test'],
    })),
    /allowlist/i,
  )
  assert.throws(
    () => createEclipseChatOfficeIngestClient(clientOptions(unusedFetch, {
      workspaceId: 'eclipse\nforge',
      maxAttempts: 1,
    })),
    /control/i,
  )
  assert.throws(
    () => createEclipseChatOfficeIngestClient(clientOptions(unusedFetch, {
      keyId: 'Sentinel-Local',
      maxAttempts: 1,
    })),
    /keyId/i,
  )
  assert.throws(
    () => createEclipseChatOfficeIngestClient(clientOptions(unusedFetch, {
      idempotentReplay: false,
    })),
    /idempotent replay/i,
  )

  const client = createEclipseChatOfficeIngestClient(clientOptions(unusedFetch, { maxAttempts: 1 }))
  assert.throws(() => client.publishBatch([input({ workspaceId: 'another-workspace' })]), /workspace/i)
  const metadata = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, 'x'.repeat(240)]))
  assert.throws(() => client.publishBatch(Array.from({ length: 50 }, () => input({ metadata }))), /64 KiB/i)
})

test('ingest client is the atomic publishBatch port for the existing adapter', async () => {
  const fetchImpl = async (_url, init) => successResponse(JSON.parse(init.body).events)
  const ingest = createEclipseChatOfficeIngestClient(clientOptions(fetchImpl, { maxAttempts: 1 }))
  const publisher = createEclipseChatOfficePublisher({
    workspaceId: WORKSPACE_ID,
    publishBatch: ingest.publishBatch,
  })
  const projections = []
  const bridge = createSentinelOfficeBridge({
    publish: (projection) => projections.push(projection),
    now: () => new Date(NOW_MS),
    idFactory: (() => {
      let next = 1_700
      return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
    })(),
  })
  await bridge.projectSafetyBoundary()

  const result = await publisher.publish(projections[0])
  assert.equal(result.accepted, true)
  assert.equal(result.officeEvents.length, 1)
})


test('signed publisher composes with the non-blocking Sentinel lifecycle contract', async () => {
  const fetchImpl = async (_url, init) => successResponse(JSON.parse(init.body).events)
  const ingest = createEclipseChatOfficeIngestClient(clientOptions(fetchImpl, { maxAttempts: 1 }))
  const publisher = createEclipseChatOfficePublisher({
    workspaceId: WORKSPACE_ID,
    publishBatch: ingest.publishBatch,
  })
  const lifecycle = createSentinelOfficeLifecycle({
    publish: publisher.publish,
    now: () => new Date(NOW_MS),
    idFactory: (() => {
      let next = 1_800
      return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
    })(),
  })

  assert.deepEqual(
    lifecycle.recordBlocked({}, Object.assign(new Error('private detail'), { code: 'INVALID_REQUEST' })),
    { queued: true, code: null },
  )
  const status = await lifecycle.flush()
  assert.equal(status.completed, 1)
  assert.equal(status.failed, 0)
})
test('ingest source has no logging, persistence, redirect following, or secret-bearing errors', async () => {
  const source = await readFile(new URL('../office/eclipse-chat-office-ingest-client.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /console\.|localStorage|writeFile|node:fs|Authorization|Bearer/)
  assert.match(source, /redirect:\s*'error'/)
  assert.match(source, /OFFICE_CORE_UNAVAILABLE/)
})
