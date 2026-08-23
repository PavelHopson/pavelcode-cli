import {
  createSentinelOfficeBridge,
  validateOfficeProjectionEvent,
} from './sentinel-office-bridge.mjs'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_SKILL_IDS = new Set(['workspace.status', 'memory.preview', 'skills.status'])
const SAFE_BLOCK_CODES = new Set([
  'APPROVAL_REQUIRED',
  'APPROVAL_EXPIRED',
  'PLAN_EXPIRED',
  'REPLAY_BLOCKED',
  'RATE_LIMITED',
  'INVALID_REQUEST',
  'SCHEMA_MISMATCH',
  'SKILL_BLOCKED',
  'PLAN_TAMPERED',
  'OPERATOR_FAILED',
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function freezeClone(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeClone))
  if (!isRecord(value)) return value
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, freezeClone(entry)]),
  ))
}

function projectionSucceeded(result) {
  if (!isRecord(result)) return false
  if (typeof result.published === 'boolean') return result.published
  if (typeof result.accepted === 'boolean') return result.accepted
  return Array.isArray(result.results)
    && result.results.length > 0
    && result.results.every((entry) => entry?.published === true)
}

function safeBlockedContext(request, error, blockedAt) {
  const plan = isRecord(request) && isRecord(request.plan) ? request.plan : null
  const planId = typeof plan?.id === 'string' && UUID_PATTERN.test(plan.id) ? plan.id : null
  const skillId = typeof plan?.skillId === 'string' && SAFE_SKILL_IDS.has(plan.skillId) ? plan.skillId : null
  const candidateCode = isRecord(error) || error instanceof Error ? error.code : null
  const code = typeof candidateCode === 'string' && SAFE_BLOCK_CODES.has(candidateCode)
    ? candidateCode
    : 'OPERATOR_FAILED'
  return { planId, skillId, code, blockedAt }
}

export function createInMemoryOfficeProjectionOutbox(options = {}) {
  const maxEvents = Number.isSafeInteger(options.maxEvents)
    ? Math.min(Math.max(options.maxEvents, 1), 256)
    : 128
  const events = []
  const retainedIds = new Set()
  let dropped = 0

  return Object.freeze({
    publish(event) {
      validateOfficeProjectionEvent(event)
      if (retainedIds.has(event.eventId)) return { accepted: false, code: 'REPLAY_BLOCKED' }
      const safeEvent = freezeClone(event)
      events.push(safeEvent)
      retainedIds.add(safeEvent.eventId)
      if (events.length > maxEvents) {
        const removed = events.shift()
        retainedIds.delete(removed.eventId)
        dropped += 1
      }
      return { accepted: true }
    },
    snapshot() {
      return Object.freeze([...events])
    },
    stats() {
      return Object.freeze({ retained: events.length, dropped })
    },
  })
}

export function createSentinelOfficeLifecycle(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const localOutbox = createInMemoryOfficeProjectionOutbox({ maxEvents: options.maxEvents })
  const publish = typeof options.publish === 'function'
    ? options.publish
    : (event) => localOutbox.publish(event)
  const bridge = createSentinelOfficeBridge({
    publish,
    now,
    idFactory: options.idFactory,
    maxEventsPerSecond: options.maxEventsPerSecond,
  })
  const pending = new Set()
  let queued = 0
  let completed = 0
  let failed = 0

  function stats() {
    const outbox = localOutbox.stats()
    return Object.freeze({
      pending: pending.size,
      queued,
      completed,
      failed,
      retained: typeof options.publish === 'function' ? 0 : outbox.retained,
      dropped: typeof options.publish === 'function' ? 0 : outbox.dropped,
    })
  }

  function track(task) {
    queued += 1
    const tracked = Promise.resolve(task)
      .then((success) => {
        if (success) completed += 1
        else failed += 1
      })
      .catch(() => { failed += 1 })
      .finally(() => { pending.delete(tracked) })
    pending.add(tracked)
    return { queued: true, code: null }
  }

  return Object.freeze({
    recordSuccess(request, receipt) {
      try {
        if (!isRecord(request) || !isRecord(receipt)) return { queued: false, code: 'PROJECTION_REJECTED' }
        const planProjection = bridge.projectPlan(request.plan)
        const executionContext = {
          requestId: receipt.requestId,
          planId: receipt.planId,
          skillId: receipt.skillId,
          effect: receipt.effect,
          acceptedAt: receipt.startedAt,
        }
        const task = (async () => {
          const results = [await planProjection]
          results.push(await bridge.projectExecutionAccepted(executionContext))
          results.push(await bridge.projectReceipt(receipt))
          return results.every(projectionSucceeded)
        })()
        return track(task)
      } catch {
        return { queued: false, code: 'PROJECTION_REJECTED' }
      }
    },
    recordBlocked(request, error) {
      try {
        const blockedAt = now().toISOString()
        return track(bridge.projectBlocked(safeBlockedContext(request, error, blockedAt)).then(projectionSucceeded))
      } catch {
        return { queued: false, code: 'PROJECTION_REJECTED' }
      }
    },
    snapshot() {
      return typeof options.publish === 'function' ? Object.freeze([]) : localOutbox.snapshot()
    },
    stats,
    async flush() {
      while (pending.size > 0) await Promise.all([...pending])
      return stats()
    },
  })
}
