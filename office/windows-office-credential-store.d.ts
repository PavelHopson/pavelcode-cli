export interface OfficeCredentialIdentity {
  producerId: string
  keyId: string
}

export interface OfficeCredentialStatus extends OfficeCredentialIdentity {
  provider: 'windows-credential-manager'
  provisioned: boolean
  deleteConfirmation: string
}

export class OfficeCredentialError extends Error {
  readonly code: string
  toJSON(): { name: string; code: string; message: string }
}

export class OfficeProducerSecretLease {
  constructor(secret: Uint8Array)
  readonly disposed: boolean
  withBytes<T>(callback: (secret: Uint8Array) => T): T
  dispose(): void
  toJSON(): { redacted: true; disposed: boolean }
}

export interface OfficeCredentialStore {
  status(identity: OfficeCredentialIdentity): Promise<OfficeCredentialStatus>
  provision(request: OfficeCredentialIdentity & { secret: Uint8Array }): Promise<OfficeCredentialIdentity & {
    provider: 'windows-credential-manager'
    provisioned: true
  }>
  read(identity: OfficeCredentialIdentity): Promise<OfficeProducerSecretLease>
  delete(request: OfficeCredentialIdentity & { confirmation: string }): Promise<OfficeCredentialIdentity & {
    provider: 'windows-credential-manager'
    deleted: boolean
  }>
}

export function credentialDeleteConfirmation(identity: OfficeCredentialIdentity): string
export function createWindowsOfficeCredentialStore(options?: {
  timeoutMs?: number
  runner?: (request: {
    operation: 'status' | 'write' | 'read' | 'delete'
    target: string
    producerId: string
    keyId: string
    input?: string
    timeoutMs: number
  }) => Promise<string>
}): OfficeCredentialStore
