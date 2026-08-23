import { timingSafeEqual } from 'node:crypto'

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i
const SCHEMA_VERSION = 'sentinel.office.credential-rotation.v1'

const MESSAGES = Object.freeze({
  INVALID_STORE: 'A typed Office credential store is required.',
  INVALID_IDENTITY: 'Office credential rotation identity is invalid.',
  SAME_KEY_ID: 'Credential rotation requires a distinct next key ID.',
  INVALID_SECRET: 'The next Office producer secret must contain 32–128 bytes.',
  CURRENT_NOT_FOUND: 'The current Office producer credential is not provisioned.',
  NEXT_ALREADY_EXISTS: 'The next Office producer credential is already provisioned.',
  SECRET_REUSE: 'Credential rotation requires a new producer secret.',
  INVALID_STORE_RESPONSE: 'The Office credential store returned an invalid response.',
  POSTCONDITION_FAILED: 'Credential staging finished without the required dual-key state; inspect rotation status before continuing.',
})

export class OfficeCredentialRotationError extends Error {
  constructor(code) {
    super(MESSAGES[code] || 'Office credential rotation failed.')
    this.name = 'OfficeCredentialRotationError'
    this.code = code
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message }
  }
}

function fail(code) {
  throw new OfficeCredentialRotationError(code)
}

function validateIdentifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) fail('INVALID_IDENTITY')
  return value
}

function normalizeRequest(request = {}) {
  const producerId = validateIdentifier(request.producerId)
  const currentKeyId = validateIdentifier(request.currentKeyId)
  const nextKeyId = validateIdentifier(request.nextKeyId)
  if (currentKeyId.toLowerCase() === nextKeyId.toLowerCase()) fail('SAME_KEY_ID')
  return Object.freeze({
    producerId,
    currentKeyId,
    nextKeyId,
    currentIdentity: Object.freeze({ producerId, keyId: currentKeyId }),
    nextIdentity: Object.freeze({ producerId, keyId: nextKeyId }),
  })
}

function validateStore(store, { stage = false } = {}) {
  if (!store || typeof store.status !== 'function') fail('INVALID_STORE')
  if (stage && (typeof store.read !== 'function' || typeof store.provision !== 'function')) fail('INVALID_STORE')
  return store
}

function validateStatus(status, expected) {
  if (!status || typeof status !== 'object'
    || status.producerId !== expected.producerId
    || status.keyId !== expected.keyId
    || typeof status.provisioned !== 'boolean') {
    fail('INVALID_STORE_RESPONSE')
  }
  return status.provisioned
}

function rotationState(currentProvisioned, nextProvisioned) {
  if (currentProvisioned && nextProvisioned) return 'staged'
  if (currentProvisioned) return 'ready-to-stage'
  if (nextProvisioned) return 'next-only'
  return 'blocked'
}

function statusReceipt(descriptor, currentProvisioned, nextProvisioned) {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    producerId: descriptor.producerId,
    currentKeyId: descriptor.currentKeyId,
    nextKeyId: descriptor.nextKeyId,
    currentProvisioned,
    nextProvisioned,
    state: rotationState(currentProvisioned, nextProvisioned),
  })
}

export async function inspectOfficeCredentialRotation(request = {}) {
  const descriptor = normalizeRequest(request)
  const store = validateStore(request.credentialStore)
  const [currentStatus, nextStatus] = await Promise.all([
    store.status(descriptor.currentIdentity),
    store.status(descriptor.nextIdentity),
  ])
  return statusReceipt(
    descriptor,
    validateStatus(currentStatus, descriptor.currentIdentity),
    validateStatus(nextStatus, descriptor.nextIdentity),
  )
}

export async function stageOfficeCredentialRotation(request = {}) {
  const descriptor = normalizeRequest(request)
  const store = validateStore(request.credentialStore, { stage: true })
  if (!(request.nextSecret instanceof Uint8Array)
    || request.nextSecret.byteLength < 32
    || request.nextSecret.byteLength > 128) {
    fail('INVALID_SECRET')
  }

  const nextSecret = Buffer.from(request.nextSecret)
  try {
    const before = await inspectOfficeCredentialRotation({ ...descriptor, credentialStore: store })
    if (!before.currentProvisioned) fail('CURRENT_NOT_FOUND')
    if (before.nextProvisioned) fail('NEXT_ALREADY_EXISTS')

    const currentLease = await store.read(descriptor.currentIdentity)
    if (!currentLease || typeof currentLease.withBytes !== 'function' || typeof currentLease.dispose !== 'function') {
      fail('INVALID_STORE_RESPONSE')
    }
    let reused
    try {
      reused = currentLease.withBytes((currentSecret) => {
        if (!(currentSecret instanceof Uint8Array)) fail('INVALID_STORE_RESPONSE')
        const comparable = Buffer.from(currentSecret)
        try {
          return comparable.byteLength === nextSecret.byteLength && timingSafeEqual(comparable, nextSecret)
        } finally {
          comparable.fill(0)
        }
      })
    } finally {
      currentLease.dispose()
    }
    if (typeof reused !== 'boolean') fail('INVALID_STORE_RESPONSE')
    if (reused) fail('SECRET_REUSE')

    const provisioned = await store.provision({ ...descriptor.nextIdentity, secret: nextSecret })
    if (!provisioned || typeof provisioned !== 'object'
      || provisioned.producerId !== descriptor.producerId
      || provisioned.keyId !== descriptor.nextKeyId
      || provisioned.provisioned !== true) {
      fail('INVALID_STORE_RESPONSE')
    }

    const after = await inspectOfficeCredentialRotation({ ...descriptor, credentialStore: store })
    if (!after.currentProvisioned || !after.nextProvisioned || after.state !== 'staged') {
      fail('POSTCONDITION_FAILED')
    }
    return after
  } finally {
    nextSecret.fill(0)
  }
}
