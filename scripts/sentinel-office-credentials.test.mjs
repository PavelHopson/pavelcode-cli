import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { inspect } from 'node:util'
import test from 'node:test'
import {
  createWindowsOfficeCredentialStore,
  credentialDeleteConfirmation,
  OfficeCredentialError,
} from '../office/windows-office-credential-store.mjs'
import { createCredentialBackedOfficeIngestClient } from '../office/credential-backed-office-client.mjs'

const IDENTITY = Object.freeze({ producerId: 'eclipse-hopson-sentinel', keyId: 'sentinel-test-01' })
const SECRET = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8')

function memoryRunner() {
  let stored = null
  const calls = []
  return {
    calls,
    async run(request) {
      calls.push({ ...request })
      if (request.operation === 'status') return stored === null ? 'MISSING' : 'PRESENT'
      if (request.operation === 'write') {
        if (stored !== null) return 'EXISTS'
        stored = request.input
        return 'STORED'
      }
      if (request.operation === 'read') return stored === null ? 'MISSING' : `SECRET:${stored}`
      if (request.operation === 'delete') {
        const existed = stored !== null
        stored = null
        return existed ? 'DELETED' : 'MISSING'
      }
      throw new Error('unexpected test operation')
    },
  }
}

test('credential identity and secret validation fail closed before invoking the helper', async () => {
  const memory = memoryRunner()
  const store = createWindowsOfficeCredentialStore({ runner: memory.run })
  await assert.rejects(
    () => store.status({ producerId: '../escape', keyId: IDENTITY.keyId }),
    (error) => error instanceof OfficeCredentialError && error.code === 'INVALID_IDENTITY',
  )
  await assert.rejects(
    () => store.provision({ ...IDENTITY, secret: Buffer.alloc(31) }),
    (error) => error instanceof OfficeCredentialError && error.code === 'INVALID_SECRET',
  )
  assert.equal(memory.calls.length, 0)
})

test('provision, read lease, status and confirmed delete never serialize secret bytes', async () => {
  const memory = memoryRunner()
  const store = createWindowsOfficeCredentialStore({ runner: memory.run })
  const provisioned = await store.provision({ ...IDENTITY, secret: SECRET })
  assert.equal(provisioned.provisioned, true)
  assert.equal(JSON.stringify(provisioned).includes(SECRET.toString('utf8')), false)

  const status = await store.status(IDENTITY)
  assert.equal(status.provisioned, true)
  assert.equal(status.deleteConfirmation, 'DELETE eclipse-hopson-sentinel/sentinel-test-01')

  const lease = await store.read(IDENTITY)
  assert.equal(lease.withBytes((bytes) => bytes.equals(SECRET)), true)
  assert.deepEqual(JSON.parse(JSON.stringify(lease)), { redacted: true, disposed: false })
  assert.doesNotMatch(inspect(lease), /0123456789abcdef/)
  lease.dispose()
  await assert.rejects(
    async () => lease.withBytes(() => true),
    (error) => error instanceof OfficeCredentialError && error.code === 'DISPOSED',
  )

  await assert.rejects(
    () => store.delete({ ...IDENTITY, confirmation: 'yes' }),
    (error) => error instanceof OfficeCredentialError && error.code === 'CONFIRMATION_REQUIRED',
  )
  assert.equal((await store.status(IDENTITY)).provisioned, true)
  const deleted = await store.delete({ ...IDENTITY, confirmation: credentialDeleteConfirmation(IDENTITY) })
  assert.equal(deleted.deleted, true)
  assert.equal((await store.status(IDENTITY)).provisioned, false)
})

test('existing credential cannot be overwritten implicitly and helper failures are redacted', async () => {
  const memory = memoryRunner()
  const store = createWindowsOfficeCredentialStore({ runner: memory.run })
  await store.provision({ ...IDENTITY, secret: SECRET })
  await assert.rejects(
    () => store.provision({ ...IDENTITY, secret: Buffer.alloc(32, 7) }),
    (error) => error instanceof OfficeCredentialError && error.code === 'ALREADY_EXISTS',
  )

  const secretText = 'must-never-escape'
  const failing = createWindowsOfficeCredentialStore({ runner: async () => { throw new Error(secretText) } })
  await assert.rejects(
    () => failing.status(IDENTITY),
    (error) => error instanceof OfficeCredentialError
      && error.code === 'HELPER_FAILED'
      && !error.message.includes(secretText),
  )
})

test('credential-backed transport clones the secret and disposes its lease before returning', async () => {
  let disposed = false
  let temporary = null
  const credentialStore = {
    async read() {
      return {
        withBytes(callback) {
          temporary = Buffer.from(SECRET)
          try { return callback(temporary) } finally { temporary.fill(0) }
        },
        dispose() { disposed = true },
      }
    },
  }
  const client = await createCredentialBackedOfficeIngestClient({
    credentialStore,
    producerId: IDENTITY.producerId,
    keyId: IDENTITY.keyId,
    workspaceId: 'workspace-test',
    baseUrl: 'http://127.0.0.1:43210',
    allowedOrigins: ['http://127.0.0.1:43210'],
    allowHttpLoopback: true,
    maxAttempts: 1,
    fetch: async () => new Response(null, { status: 503 }),
  })
  assert.equal(disposed, true)
  assert.equal(temporary.every((byte) => byte === 0), true)
  client.dispose()
})

test('credential CLI never accepts a secret argument and keeps delete confirmation interactive', async () => {
  const source = await readFile(new URL('../bin/sentinel-office-credentials', import.meta.url), 'utf8')
  assert.match(source, /process\.argv\.slice\(2\)/)
  assert.doesNotMatch(source, /--secret|--password|secret.*process\.argv/i)
  assert.match(source, /Producer secret \(base64url, hidden\)/)
  assert.match(source, /Type exactly/)
  assert.match(source, /store\.delete\(\{ \.\.\.identity, confirmation \}\)/)
})
