import { createEclipseChatOfficeIngestClient } from './eclipse-chat-office-ingest-client.mjs'
import { createWindowsOfficeCredentialStore } from './windows-office-credential-store.mjs'

export async function createCredentialBackedOfficeIngestClient(options = {}) {
  const credentialStore = options.credentialStore || createWindowsOfficeCredentialStore()
  if (!credentialStore || typeof credentialStore.read !== 'function') {
    throw new TypeError('A typed Office credential store is required')
  }
  const lease = await credentialStore.read({ producerId: options.producerId, keyId: options.keyId })
  try {
    return lease.withBytes((secret) => createEclipseChatOfficeIngestClient({
      baseUrl: options.baseUrl,
      basePath: options.basePath,
      allowedOrigins: options.allowedOrigins,
      allowHttpLoopback: options.allowHttpLoopback,
      workspaceId: options.workspaceId,
      keyId: options.keyId,
      secret,
      timeoutMs: options.timeoutMs,
      maxAttempts: options.maxAttempts,
      idempotentReplay: options.idempotentReplay,
      fetch: options.fetch,
      now: options.now,
      nonceFactory: options.nonceFactory,
      sleep: options.sleep,
    }))
  } finally {
    lease.dispose()
  }
}
