import type { OfficeCredentialStore } from './windows-office-credential-store.mjs'

export interface CredentialBackedOfficeClientOptions {
  baseUrl: string
  allowedOrigins: string[]
  allowHttpLoopback?: boolean
  workspaceId: string
  producerId: string
  keyId: string
  timeoutMs?: number
  maxAttempts?: number
  idempotentReplay?: boolean
  credentialStore?: OfficeCredentialStore
  fetch?: typeof fetch
  now?: () => number
  nonceFactory?: () => string
  sleep?: (milliseconds: number) => Promise<void>
}

export interface OfficeIngestClient {
  publishBatch(events: unknown[]): Promise<unknown[]>
  dispose(): void
}

export function createCredentialBackedOfficeIngestClient(
  options: CredentialBackedOfficeClientOptions,
): Promise<OfficeIngestClient>
