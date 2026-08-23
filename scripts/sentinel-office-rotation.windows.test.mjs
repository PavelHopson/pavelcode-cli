import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { stageOfficeCredentialRotation } from '../office/office-credential-rotation.mjs'
import {
  createWindowsOfficeCredentialStore,
  credentialDeleteConfirmation,
} from '../office/windows-office-credential-store.mjs'

if (process.platform === 'win32' && process.env.SENTINEL_WINDOWS_CREDENTIAL_E2E === '1') test('Windows Credential Manager stages an isolated dual-key rotation', {
  timeout: 30_000,
}, async () => {
  const store = createWindowsOfficeCredentialStore()
  const producerId = 'eclipse-hopson-sentinel-rotation-test'
  const suffix = randomUUID()
  const currentIdentity = { producerId, keyId: `qa-current-${suffix}` }
  const nextIdentity = { producerId, keyId: `qa-next-${suffix}` }
  const currentSecret = randomBytes(32)
  const nextSecret = randomBytes(32)

  try {
    await store.provision({ ...currentIdentity, secret: currentSecret })
    const receipt = await stageOfficeCredentialRotation({
      credentialStore: store,
      producerId,
      currentKeyId: currentIdentity.keyId,
      nextKeyId: nextIdentity.keyId,
      nextSecret,
    })
    assert.equal(receipt.state, 'staged')
    assert.equal((await store.status(currentIdentity)).provisioned, true)
    assert.equal((await store.status(nextIdentity)).provisioned, true)
    assert.equal(JSON.stringify(receipt).includes(nextSecret.toString('base64')), false)
  } finally {
    currentSecret.fill(0)
    nextSecret.fill(0)
    for (const identity of [nextIdentity, currentIdentity]) {
      if ((await store.status(identity)).provisioned) {
        await store.delete({ ...identity, confirmation: credentialDeleteConfirmation(identity) })
      }
    }
  }

  assert.equal((await store.status(currentIdentity)).provisioned, false)
  assert.equal((await store.status(nextIdentity)).provisioned, false)
})
