import type { OfficeCredentialStore } from './windows-office-credential-store.mjs'

export interface OfficeCredentialRotationRequest {
  credentialStore: OfficeCredentialStore
  producerId: string
  currentKeyId: string
  nextKeyId: string
}

export interface OfficeCredentialRotationStatus {
  schemaVersion: 'sentinel.office.credential-rotation.v1'
  producerId: string
  currentKeyId: string
  nextKeyId: string
  currentProvisioned: boolean
  nextProvisioned: boolean
  state: 'ready-to-stage' | 'staged' | 'next-only' | 'blocked'
}

export class OfficeCredentialRotationError extends Error {
  readonly code: string
  toJSON(): { name: string; code: string; message: string }
}

export function inspectOfficeCredentialRotation(
  request: OfficeCredentialRotationRequest,
): Promise<OfficeCredentialRotationStatus>

export function stageOfficeCredentialRotation(
  request: OfficeCredentialRotationRequest & { nextSecret: Uint8Array },
): Promise<OfficeCredentialRotationStatus>
