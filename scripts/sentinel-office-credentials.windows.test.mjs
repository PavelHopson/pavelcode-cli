import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  createWindowsOfficeCredentialStore,
  credentialDeleteConfirmation,
} from '../office/windows-office-credential-store.mjs'

test('Windows Credential Manager stores and removes an isolated Office test secret', {
  skip: process.platform !== 'win32' ? 'Windows Credential Manager is Windows-only' : false,
  timeout: 30_000,
}, async () => {
  const store = createWindowsOfficeCredentialStore({ timeoutMs: 20_000 })
  const identity = {
    producerId: 'eclipse-hopson-sentinel-test',
    keyId: `qa-${randomUUID()}`,
  }
  const secret = randomBytes(32)
  try {
    assert.equal((await store.status(identity)).provisioned, false)
    await store.provision({ ...identity, secret })
    assert.equal((await store.status(identity)).provisioned, true)
    const lease = await store.read(identity)
    try {
      assert.equal(lease.withBytes((bytes) => bytes.equals(secret)), true)
    } finally {
      lease.dispose()
    }
  } finally {
    await store.delete({ ...identity, confirmation: credentialDeleteConfirmation(identity) })
    secret.fill(0)
  }
  assert.equal((await store.status(identity)).provisioned, false)
})

test('concurrent provision keeps exactly one producer secret', {
  skip: process.platform !== 'win32' ? 'Windows Credential Manager is Windows-only' : false,
  timeout: 30_000,
}, async () => {
  const store = createWindowsOfficeCredentialStore({ timeoutMs: 20_000 })
  const identity = {
    producerId: 'eclipse-hopson-sentinel-test',
    keyId: `qa-race-${randomUUID()}`,
  }
  const secrets = [randomBytes(32), randomBytes(32)]
  try {
    const results = await Promise.allSettled([
      store.provision({ ...identity, secret: secrets[0] }),
      store.provision({ ...identity, secret: secrets[1] }),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason?.code, 'ALREADY_EXISTS')
    const lease = await store.read(identity)
    try {
      const matched = lease.withBytes((bytes) => secrets.some((secret) => bytes.equals(secret)))
      assert.equal(matched, true)
    } finally {
      lease.dispose()
    }
  } finally {
    await store.delete({ ...identity, confirmation: credentialDeleteConfirmation(identity) })
    for (const secret of secrets) secret.fill(0)
  }
  assert.equal((await store.status(identity)).provisioned, false)
})
