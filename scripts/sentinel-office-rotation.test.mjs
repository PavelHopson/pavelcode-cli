import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  inspectOfficeCredentialRotation,
  OfficeCredentialRotationError,
  stageOfficeCredentialRotation,
} from '../office/office-credential-rotation.mjs'

const PRODUCER_ID = 'eclipse-hopson-sentinel'
const CURRENT_KEY_ID = 'sentinel-current-01'
const NEXT_KEY_ID = 'sentinel-next-02'
const CURRENT_SECRET = Buffer.from('0123456789abcdef0123456789abcdef')
const NEXT_SECRET = Buffer.from('fedcba9876543210fedcba9876543210')

function memoryStore(entries = []) {
  const secrets = new Map(entries.map(([keyId, secret]) => [keyId, Buffer.from(secret)]))
  const calls = []
  return {
    calls,
    secrets,
    async status({ producerId, keyId }) {
      calls.push({ operation: 'status', producerId, keyId })
      return { producerId, keyId, provisioned: secrets.has(keyId) }
    },
    async read({ producerId, keyId }) {
      calls.push({ operation: 'read', producerId, keyId })
      const stored = secrets.get(keyId)
      if (!stored) throw new Error('missing test credential')
      let disposed = false
      return {
        withBytes(callback) {
          if (disposed) throw new Error('disposed test lease')
          const temporary = Buffer.from(stored)
          try { return callback(temporary) } finally { temporary.fill(0) }
        },
        dispose() { disposed = true },
      }
    },
    async provision({ producerId, keyId, secret }) {
      calls.push({ operation: 'provision', producerId, keyId })
      if (secrets.has(keyId)) throw new Error('test overwrite')
      secrets.set(keyId, Buffer.from(secret))
      return { producerId, keyId, provisioned: true }
    },
  }
}

function request(store, extra = {}) {
  return {
    credentialStore: store,
    producerId: PRODUCER_ID,
    currentKeyId: CURRENT_KEY_ID,
    nextKeyId: NEXT_KEY_ID,
    ...extra,
  }
}

test('rotation inspection reports every bounded dual-key state', async () => {
  const cases = [
    { entries: [[CURRENT_KEY_ID, CURRENT_SECRET]], state: 'ready-to-stage' },
    { entries: [[CURRENT_KEY_ID, CURRENT_SECRET], [NEXT_KEY_ID, NEXT_SECRET]], state: 'staged' },
    { entries: [[NEXT_KEY_ID, NEXT_SECRET]], state: 'next-only' },
    { entries: [], state: 'blocked' },
  ]
  for (const example of cases) {
    const status = await inspectOfficeCredentialRotation(request(memoryStore(example.entries)))
    assert.equal(status.state, example.state)
    assert.equal(Object.isFrozen(status), true)
  }
})

test('staging requires a current key, an empty next slot and a distinct key ID', async () => {
  await assert.rejects(
    () => stageOfficeCredentialRotation(request(memoryStore(), { nextSecret: NEXT_SECRET })),
    (error) => error instanceof OfficeCredentialRotationError && error.code === 'CURRENT_NOT_FOUND',
  )
  await assert.rejects(
    () => stageOfficeCredentialRotation(request(memoryStore([
      [CURRENT_KEY_ID, CURRENT_SECRET],
      [NEXT_KEY_ID, NEXT_SECRET],
    ]), { nextSecret: Buffer.alloc(32, 7) })),
    (error) => error instanceof OfficeCredentialRotationError && error.code === 'NEXT_ALREADY_EXISTS',
  )
  await assert.rejects(
    () => inspectOfficeCredentialRotation(request(memoryStore(), { nextKeyId: CURRENT_KEY_ID.toUpperCase() })),
    (error) => error instanceof OfficeCredentialRotationError && error.code === 'SAME_KEY_ID',
  )
})

test('staging blocks secret reuse and never writes or deletes a credential', async () => {
  const store = memoryStore([[CURRENT_KEY_ID, CURRENT_SECRET]])
  await assert.rejects(
    () => stageOfficeCredentialRotation(request(store, { nextSecret: CURRENT_SECRET })),
    (error) => error instanceof OfficeCredentialRotationError && error.code === 'SECRET_REUSE',
  )
  assert.equal(store.secrets.has(NEXT_KEY_ID), false)
  assert.equal(store.calls.some((call) => call.operation === 'provision'), false)
  assert.equal(store.calls.some((call) => call.operation === 'delete'), false)
})

test('staging preserves the current key and returns a secret-free dual-key receipt', async () => {
  const store = memoryStore([[CURRENT_KEY_ID, CURRENT_SECRET]])
  const receipt = await stageOfficeCredentialRotation(request(store, { nextSecret: NEXT_SECRET }))
  assert.deepEqual(receipt, {
    schemaVersion: 'sentinel.office.credential-rotation.v1',
    producerId: PRODUCER_ID,
    currentKeyId: CURRENT_KEY_ID,
    nextKeyId: NEXT_KEY_ID,
    currentProvisioned: true,
    nextProvisioned: true,
    state: 'staged',
  })
  assert.equal(store.secrets.get(CURRENT_KEY_ID).equals(CURRENT_SECRET), true)
  assert.equal(store.secrets.get(NEXT_KEY_ID).equals(NEXT_SECRET), true)
  assert.equal(JSON.stringify(receipt).includes(NEXT_SECRET.toString('utf8')), false)
  assert.equal(store.calls.some((call) => call.operation === 'delete'), false)
})

test('rotation implementation has no credential deletion or secret logging path', async () => {
  const source = await readFile(new URL('../office/office-credential-rotation.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\.delete\s*\(/)
  assert.doesNotMatch(source, /console\.|stdout|stderr|JSON\.stringify\([^)]*secret/i)
  assert.match(source, /timingSafeEqual/)
  assert.match(source, /nextSecret\.fill\(0\)/)
})

test('credential CLI stages rotation from hidden input and keeps retirement separate', async () => {
  const source = await readFile(new URL('../bin/sentinel-office-credentials', import.meta.url), 'utf8')
  assert.match(source, /stage-rotation <producer-id> <current-key-id> <next-key-id>/)
  assert.match(source, /Next producer secret \(base64url, hidden\)/)
  assert.match(source, /stageOfficeCredentialRotation\(\{ \.\.\.rotation, nextSecret \}\)/)
  assert.match(source, /separate delete command/)
  assert.doesNotMatch(source, /--secret|--password|secret.*process\.argv/i)
})

test('rotation rejects a status response for a different credential identity', async () => {
  const store = memoryStore([[CURRENT_KEY_ID, CURRENT_SECRET]])
  store.status = async ({ producerId }) => ({
    producerId,
    keyId: 'spoofed-key',
    provisioned: true,
  })
  await assert.rejects(
    () => inspectOfficeCredentialRotation(request(store)),
    (error) => error instanceof OfficeCredentialRotationError && error.code === 'INVALID_STORE_RESPONSE',
  )
})

test('a concurrent current-key change fails the dual-key postcondition without automatic deletion', async () => {
  const store = memoryStore([[CURRENT_KEY_ID, CURRENT_SECRET]])
  const stableStatus = store.status.bind(store)
  let currentChecks = 0
  store.status = async (identity) => {
    const status = await stableStatus(identity)
    if (identity.keyId === CURRENT_KEY_ID && ++currentChecks > 1) {
      return { ...status, provisioned: false }
    }
    return status
  }
  await assert.rejects(
    () => stageOfficeCredentialRotation(request(store, { nextSecret: NEXT_SECRET })),
    (error) => error instanceof OfficeCredentialRotationError && error.code === 'POSTCONDITION_FAILED',
  )
  assert.equal(store.secrets.has(NEXT_KEY_ID), true)
  assert.equal(store.calls.some((call) => call.operation === 'delete'), false)
})
