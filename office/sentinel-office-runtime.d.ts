import type { OfficeCredentialStore } from './windows-office-credential-store.mjs'

export interface SentinelOfficeRuntimeStatus {
  enabled: boolean
  ready: boolean
  code: string
  message: string
}

export interface SentinelOfficeRuntimeConfig {
  enabled: true
  baseUrl: string
  basePath: string
  allowedOrigins: readonly string[]
  allowHttpLoopback: boolean
  workspaceId: string
  producerId: 'eclipse-hopson-sentinel'
  keyId: string
}

export interface SentinelOfficeRuntime {
  recordSuccess(request: unknown, receipt: unknown): { queued: boolean; code: string | null }
  recordBlocked(request: unknown, error: unknown): { queued: boolean; code: string | null }
  status(): SentinelOfficeRuntimeStatus
  flush(): Promise<unknown>
  dispose(): void
}

export class SentinelOfficeRuntimeError extends Error {
  readonly code: string
  toJSON(): { name: string; code: string; message: string }
}

export function readSentinelOfficeRuntimeConfig(
  environment?: Record<string, string | undefined>,
): Readonly<{ enabled: false }> | Readonly<SentinelOfficeRuntimeConfig>

export function createSentinelOfficeRuntime(options?: {
  environment?: Record<string, string | undefined>
  credentialStore?: OfficeCredentialStore
  fetch?: typeof fetch
  transportNow?: () => number
  lifecycleNow?: () => Date
  nonceFactory?: () => string
  sleep?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
  maxAttempts?: number
  idFactory?: () => string
  maxEventsPerSecond?: number
}): Promise<SentinelOfficeRuntime>
