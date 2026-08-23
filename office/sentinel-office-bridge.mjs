import { randomUUID } from 'node:crypto'

export const OFFICE_EVENT_SCHEMA = 'eclipse.office.event.v1'
export const SENTINEL_OFFICE_SOURCE = 'eclipse-hopson-sentinel'
export const SENTINEL_OFFICE_SUBJECT = 'agent:sentinel'

export const SENTINEL_OFFICE_EVENT_TYPES = Object.freeze({
  presence: 'sentinel.presence.snapshot.v1',
  plan: 'sentinel.operator.plan-projected.v1',
  execution: 'sentinel.operator.execution-projected.v1',
  receipt: 'sentinel.operator.receipt-projected.v1',
  blocked: 'sentinel.operator.blocked.v1',
  safety: 'sentinel.safety.boundary.v1',
})

export const SENTINEL_OFFICE_AUDIENCE = Object.freeze([
  'eclipse-chat.office-core',
  'eclipse-chat.presence-2d',
  'eclipse-chat.presence-3d',
])

export const OFFICE_TRANSPORT_SECURITY = Object.freeze({
  maxEventBytes: 16 * 1024,
  maxEventsPerSecond: 30,
  maxFutureSkewMs: 5_000,
  replayWindowMs: 5 * 60 * 1000,
  credentialPlacement: 'transport-only',
  defaultNetworkBoundary: 'loopback-or-os-local-ipc',
})

const PLAN_SCHEMA = 'eclipse.sentinel.operator-plan.v1'
const RECEIPT_SCHEMA = 'eclipse.sentinel.operator-receipt.v1'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SKILL_IDS = new Set(['workspace.status', 'memory.preview', 'skills.status'])
const EFFECTS = new Set(['read-only'])
const RECEIPT_STATUSES = new Set(['succeeded'])
const RECEIPT_TRANSPORTS = new Set(['electron-ipc', 'browser-preview', 'sentinel-voice-cli'])
const PRESENCE_MODES = new Set(['idle', 'planning', 'awaiting-approval', 'executing', 'speaking', 'blocked', 'offline'])
const AVAILABILITY = new Set(['available', 'busy', 'unavailable'])
const ATTENTION = new Set(['none', 'approval', 'blocked'])
const PUBLIC_BLOCK_REASONS = new Set(['approval-required', 'stale-request', 'policy-blocked', 'rate-limited', 'internal'])
const ALLOWED_BOUNDARIES = new Set([
  'read-only',
  'no-shell',
  'no-network',
  'no-filesystem-write',
  'no-secrets',
  'one-shot',
  'preview-only',
])
const EVENT_TYPE_SET = new Set(Object.values(SENTINEL_OFFICE_EVENT_TYPES))
const SENSITIVE_KEY_PATTERN = /(?:command|prompt|summary|speech|lines|path|hostname|secret|token|authorization|cookie|environment|stack|message)/iu

const SUBSCRIBER_ACL = Object.freeze({
  'eclipse-chat.office-core': Object.freeze([...EVENT_TYPE_SET]),
  'eclipse-chat.presence-2d': Object.freeze([...EVENT_TYPE_SET]),
  'eclipse-chat.presence-3d': Object.freeze([...EVENT_TYPE_SET]),
})

export class SentinelOfficeBridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SentinelOfficeBridgeError'
    this.code = code
  }
}

function fail(code, message) {
  throw new SentinelOfficeBridgeError(code, message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected, name) {
  if (!isRecord(value)) fail('INVALID_CONTRACT', `${name} must be an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('INVALID_CONTRACT', `${name} contains unknown or missing fields`)
  }
}

function requireUuid(value, name, nullable = false) {
  if (nullable && value === null) return
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('INVALID_CONTRACT', `${name} must be a UUID`)
}

function parseIso(value, name) {
  if (typeof value !== 'string') fail('INVALID_CONTRACT', `${name} must be a canonical ISO timestamp`)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail('INVALID_CONTRACT', `${name} must be a canonical ISO timestamp`)
  }
  return timestamp
}

function requireEnum(value, allowed, name) {
  if (typeof value !== 'string' || !allowed.has(value)) fail('INVALID_CONTRACT', `${name} is not allowlisted`)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  Object.values(value).forEach(deepFreeze)
  return value
}

function cloneAndFreeze(value) {
  return deepFreeze(JSON.parse(JSON.stringify(value)))
}

function assertNoSensitiveProjectionKeys(value, path = 'event') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveProjectionKeys(item, `${path}[${index}]`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) fail('SENSITIVE_PROJECTION', `${path}.${key} is forbidden in Office projections`)
    assertNoSensitiveProjectionKeys(item, `${path}.${key}`)
  }
}

function validatePlan(plan) {
  exactKeys(plan, ['schemaVersion', 'id', 'createdAt', 'skillId', 'label', 'command', 'steps', 'diff', 'effect'], 'plan')
  if (plan.schemaVersion !== PLAN_SCHEMA) fail('SCHEMA_MISMATCH', 'Unsupported Sentinel plan schema')
  requireUuid(plan.id, 'plan.id')
  parseIso(plan.createdAt, 'plan.createdAt')
  requireEnum(plan.skillId, SKILL_IDS, 'plan.skillId')
  requireEnum(plan.effect, EFFECTS, 'plan.effect')
  if (typeof plan.command !== 'string' || !plan.command || !Array.isArray(plan.steps) || !Array.isArray(plan.diff)) {
    fail('INVALID_CONTRACT', 'Plan payload is incomplete')
  }
  return plan
}

function validateReceipt(receipt) {
  exactKeys(receipt, [
    'schemaVersion', 'receiptId', 'requestId', 'planId', 'skillId', 'status', 'effect', 'transport',
    'summary', 'speech', 'lines', 'boundaries', 'startedAt', 'completedAt',
  ], 'receipt')
  if (receipt.schemaVersion !== RECEIPT_SCHEMA) fail('SCHEMA_MISMATCH', 'Unsupported Sentinel receipt schema')
  requireUuid(receipt.receiptId, 'receipt.receiptId')
  requireUuid(receipt.requestId, 'receipt.requestId')
  requireUuid(receipt.planId, 'receipt.planId')
  requireEnum(receipt.skillId, SKILL_IDS, 'receipt.skillId')
  requireEnum(receipt.status, RECEIPT_STATUSES, 'receipt.status')
  requireEnum(receipt.effect, EFFECTS, 'receipt.effect')
  requireEnum(receipt.transport, RECEIPT_TRANSPORTS, 'receipt.transport')
  parseIso(receipt.startedAt, 'receipt.startedAt')
  parseIso(receipt.completedAt, 'receipt.completedAt')
  if (!Array.isArray(receipt.boundaries) || receipt.boundaries.some((item) => !ALLOWED_BOUNDARIES.has(item))) {
    fail('INVALID_CONTRACT', 'receipt.boundaries contains an unknown boundary')
  }
  return receipt
}

function validatePresenceData(data) {
  exactKeys(data, ['mode', 'availability', 'attention', 'activePlanId', 'activeSkillId'], 'presence data')
  requireEnum(data.mode, PRESENCE_MODES, 'presence.mode')
  requireEnum(data.availability, AVAILABILITY, 'presence.availability')
  requireEnum(data.attention, ATTENTION, 'presence.attention')
  requireUuid(data.activePlanId, 'presence.activePlanId', true)
  if (data.activeSkillId !== null) requireEnum(data.activeSkillId, SKILL_IDS, 'presence.activeSkillId')
}

function validateEventData(type, data) {
  if (type === SENTINEL_OFFICE_EVENT_TYPES.presence) {
    validatePresenceData(data)
    return
  }
  if (type === SENTINEL_OFFICE_EVENT_TYPES.plan) {
    exactKeys(data, ['phase', 'planId', 'skillId', 'effect', 'requiresApproval', 'killSwitch', 'createdAt'], 'plan projection')
    if (data.phase !== 'awaiting-approval' || data.requiresApproval !== true || data.killSwitch !== 'engaged') {
      fail('INVALID_CONTRACT', 'Plan projection cannot grant execution authority')
    }
    requireUuid(data.planId, 'plan projection.planId')
    requireEnum(data.skillId, SKILL_IDS, 'plan projection.skillId')
    requireEnum(data.effect, EFFECTS, 'plan projection.effect')
    parseIso(data.createdAt, 'plan projection.createdAt')
    return
  }
  if (type === SENTINEL_OFFICE_EVENT_TYPES.execution) {
    exactKeys(data, ['phase', 'requestId', 'planId', 'skillId', 'effect', 'acceptedAt'], 'execution projection')
    if (data.phase !== 'executing') fail('INVALID_CONTRACT', 'Execution projection phase is invalid')
    requireUuid(data.requestId, 'execution projection.requestId')
    requireUuid(data.planId, 'execution projection.planId')
    requireEnum(data.skillId, SKILL_IDS, 'execution projection.skillId')
    requireEnum(data.effect, EFFECTS, 'execution projection.effect')
    parseIso(data.acceptedAt, 'execution projection.acceptedAt')
    return
  }
  if (type === SENTINEL_OFFICE_EVENT_TYPES.receipt) {
    exactKeys(data, [
      'phase', 'receiptId', 'requestId', 'planId', 'skillId', 'status', 'effect', 'transport',
      'boundaries', 'startedAt', 'completedAt',
    ], 'receipt projection')
    if (data.phase !== 'completed') fail('INVALID_CONTRACT', 'Receipt projection phase is invalid')
    requireUuid(data.receiptId, 'receipt projection.receiptId')
    requireUuid(data.requestId, 'receipt projection.requestId')
    requireUuid(data.planId, 'receipt projection.planId')
    requireEnum(data.skillId, SKILL_IDS, 'receipt projection.skillId')
    requireEnum(data.status, RECEIPT_STATUSES, 'receipt projection.status')
    requireEnum(data.effect, EFFECTS, 'receipt projection.effect')
    requireEnum(data.transport, RECEIPT_TRANSPORTS, 'receipt projection.transport')
    if (!Array.isArray(data.boundaries) || data.boundaries.some((item) => !ALLOWED_BOUNDARIES.has(item))) {
      fail('INVALID_CONTRACT', 'Receipt projection boundaries are invalid')
    }
    parseIso(data.startedAt, 'receipt projection.startedAt')
    parseIso(data.completedAt, 'receipt projection.completedAt')
    return
  }
  if (type === SENTINEL_OFFICE_EVENT_TYPES.blocked) {
    exactKeys(data, ['phase', 'planId', 'skillId', 'reason', 'blockedAt'], 'blocked projection')
    if (data.phase !== 'blocked') fail('INVALID_CONTRACT', 'Blocked projection phase is invalid')
    requireUuid(data.planId, 'blocked projection.planId', true)
    if (data.skillId !== null) requireEnum(data.skillId, SKILL_IDS, 'blocked projection.skillId')
    requireEnum(data.reason, PUBLIC_BLOCK_REASONS, 'blocked projection.reason')
    parseIso(data.blockedAt, 'blocked projection.blockedAt')
    return
  }
  if (type === SENTINEL_OFFICE_EVENT_TYPES.safety) {
    exactKeys(data, ['authority', 'projectionCanApprove', 'projectionCanExecute', 'allowedEffect', 'blockedEffects'], 'safety projection')
    if (data.authority !== SENTINEL_OFFICE_SOURCE || data.projectionCanApprove !== false || data.projectionCanExecute !== false) {
      fail('INVALID_CONTRACT', 'Safety projection would weaken Sentinel authority')
    }
    if (data.allowedEffect !== 'read-only' || !Array.isArray(data.blockedEffects)) {
      fail('INVALID_CONTRACT', 'Safety projection effects are invalid')
    }
    return
  }
  fail('EVENT_TYPE_BLOCKED', 'Office event type is not allowlisted')
}

export function validateOfficeProjectionEvent(event, options = {}) {
  exactKeys(event, ['schemaVersion', 'eventId', 'streamId', 'sequence', 'type', 'source', 'subject', 'time', 'correlationId', 'audience', 'data'], 'event')
  if (event.schemaVersion !== OFFICE_EVENT_SCHEMA) fail('SCHEMA_MISMATCH', 'Unsupported Office event schema')
  requireUuid(event.eventId, 'event.eventId')
  requireUuid(event.streamId, 'event.streamId')
  requireUuid(event.correlationId, 'event.correlationId', true)
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) fail('INVALID_CONTRACT', 'event.sequence must be a positive integer')
  requireEnum(event.type, EVENT_TYPE_SET, 'event.type')
  if (event.source !== SENTINEL_OFFICE_SOURCE || event.subject !== SENTINEL_OFFICE_SUBJECT) {
    fail('PRODUCER_BLOCKED', 'Office event producer identity is invalid')
  }
  const timestamp = parseIso(event.time, 'event.time')
  if (!Array.isArray(event.audience) || event.audience.length !== SENTINEL_OFFICE_AUDIENCE.length
    || event.audience.some((value, index) => value !== SENTINEL_OFFICE_AUDIENCE[index])) {
    fail('AUDIENCE_BLOCKED', 'Office event audience is invalid')
  }
  validateEventData(event.type, event.data)
  assertNoSensitiveProjectionKeys(event.data, 'event.data')
  const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
  if (bytes > OFFICE_TRANSPORT_SECURITY.maxEventBytes) fail('EVENT_TOO_LARGE', 'Office event exceeds the size limit')

  if (options.now instanceof Date) {
    const nowMs = options.now.getTime()
    if (timestamp > nowMs + OFFICE_TRANSPORT_SECURITY.maxFutureSkewMs
      || nowMs - timestamp > OFFICE_TRANSPORT_SECURITY.replayWindowMs) {
      fail('EVENT_EXPIRED', 'Office event is outside the replay window')
    }
  }
  return event
}

export function authorizeOfficeSubscription(serviceId, eventType) {
  const allowed = SUBSCRIBER_ACL[serviceId]
  return Array.isArray(allowed) && allowed.includes(eventType)
}

export function authorizeOfficePublish(serviceId, eventType) {
  return serviceId === SENTINEL_OFFICE_SOURCE && EVENT_TYPE_SET.has(eventType)
}

function presenceFor(mode, activePlanId = null, activeSkillId = null) {
  const availability = mode === 'offline' ? 'unavailable' : mode === 'idle' ? 'available' : 'busy'
  const attention = mode === 'awaiting-approval' ? 'approval' : mode === 'blocked' ? 'blocked' : 'none'
  return { mode, availability, attention, activePlanId, activeSkillId }
}

function publicBlockReason(code) {
  if (code === 'APPROVAL_REQUIRED') return 'approval-required'
  if (code === 'PLAN_EXPIRED' || code === 'APPROVAL_EXPIRED' || code === 'REPLAY_BLOCKED') return 'stale-request'
  if (code === 'RATE_LIMITED') return 'rate-limited'
  if (code === 'OPERATOR_FAILED') return 'internal'
  return 'policy-blocked'
}

export function createSentinelOfficeBridge(options = {}) {
  if (typeof options.publish !== 'function') fail('PUBLISHER_REQUIRED', 'A publish-only Office port is required')
  const publish = options.publish
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : randomUUID
  const maxEventsPerSecond = Number.isSafeInteger(options.maxEventsPerSecond)
    ? Math.min(Math.max(options.maxEventsPerSecond, 1), OFFICE_TRANSPORT_SECURITY.maxEventsPerSecond)
    : OFFICE_TRANSPORT_SECURITY.maxEventsPerSecond
  const streamId = idFactory()
  requireUuid(streamId, 'streamId')
  let sequence = 0
  const recentEvents = []

  async function emit(type, data, correlationId = null) {
    const emittedAt = now()
    const nowMs = emittedAt.getTime()
    while (recentEvents.length && nowMs - recentEvents[0] >= 1_000) recentEvents.shift()
    if (recentEvents.length >= maxEventsPerSecond) {
      return { published: false, code: 'RATE_LIMITED', event: null }
    }
    recentEvents.push(nowMs)

    const event = cloneAndFreeze({
      schemaVersion: OFFICE_EVENT_SCHEMA,
      eventId: idFactory(),
      streamId,
      sequence: ++sequence,
      type,
      source: SENTINEL_OFFICE_SOURCE,
      subject: SENTINEL_OFFICE_SUBJECT,
      time: emittedAt.toISOString(),
      correlationId,
      audience: [...SENTINEL_OFFICE_AUDIENCE],
      data,
    })
    validateOfficeProjectionEvent(event, { now: emittedAt })

    try {
      const outcome = await publish(event)
      if (outcome === false || outcome?.accepted === false) {
        return { published: false, code: 'PROJECTION_UNAVAILABLE', event }
      }
      return { published: true, code: null, event }
    } catch {
      return { published: false, code: 'PROJECTION_UNAVAILABLE', event }
    }
  }

  async function emitMany(entries) {
    const results = []
    for (const entry of entries) results.push(await emit(entry.type, entry.data, entry.correlationId))
    return { published: results.every((result) => result.published), results }
  }

  return Object.freeze({
    projectPresence(snapshot) {
      validatePresenceData(snapshot)
      return emit(SENTINEL_OFFICE_EVENT_TYPES.presence, { ...snapshot }, snapshot.activePlanId)
    },
    projectPlan(operatorPlan) {
      const plan = validatePlan(operatorPlan)
      return emitMany([
        {
          type: SENTINEL_OFFICE_EVENT_TYPES.plan,
          correlationId: plan.id,
          data: {
            phase: 'awaiting-approval',
            planId: plan.id,
            skillId: plan.skillId,
            effect: plan.effect,
            requiresApproval: true,
            killSwitch: 'engaged',
            createdAt: plan.createdAt,
          },
        },
        {
          type: SENTINEL_OFFICE_EVENT_TYPES.presence,
          correlationId: plan.id,
          data: presenceFor('awaiting-approval', plan.id, plan.skillId),
        },
      ])
    },
    projectExecutionAccepted(context) {
      exactKeys(context, ['requestId', 'planId', 'skillId', 'effect', 'acceptedAt'], 'execution context')
      requireUuid(context.requestId, 'execution context.requestId')
      requireUuid(context.planId, 'execution context.planId')
      requireEnum(context.skillId, SKILL_IDS, 'execution context.skillId')
      requireEnum(context.effect, EFFECTS, 'execution context.effect')
      parseIso(context.acceptedAt, 'execution context.acceptedAt')
      return emitMany([
        {
          type: SENTINEL_OFFICE_EVENT_TYPES.execution,
          correlationId: context.planId,
          data: { phase: 'executing', ...context },
        },
        {
          type: SENTINEL_OFFICE_EVENT_TYPES.presence,
          correlationId: context.planId,
          data: presenceFor('executing', context.planId, context.skillId),
        },
      ])
    },
    projectReceipt(operatorReceipt) {
      const receipt = validateReceipt(operatorReceipt)
      return emitMany([
        {
          type: SENTINEL_OFFICE_EVENT_TYPES.receipt,
          correlationId: receipt.planId,
          data: {
            phase: 'completed',
            receiptId: receipt.receiptId,
            requestId: receipt.requestId,
            planId: receipt.planId,
            skillId: receipt.skillId,
            status: receipt.status,
            effect: receipt.effect,
            transport: receipt.transport,
            boundaries: [...receipt.boundaries],
            startedAt: receipt.startedAt,
            completedAt: receipt.completedAt,
          },
        },
        {
          type: SENTINEL_OFFICE_EVENT_TYPES.presence,
          correlationId: receipt.planId,
          data: presenceFor('idle'),
        },
      ])
    },
    projectBlocked(context) {
      exactKeys(context, ['planId', 'skillId', 'code', 'blockedAt'], 'blocked context')
      requireUuid(context.planId, 'blocked context.planId', true)
      if (context.skillId !== null) requireEnum(context.skillId, SKILL_IDS, 'blocked context.skillId')
      if (typeof context.code !== 'string' || !/^[A-Z_]{3,40}$/.test(context.code)) {
        fail('INVALID_CONTRACT', 'blocked context.code is invalid')
      }
      parseIso(context.blockedAt, 'blocked context.blockedAt')
      const reason = publicBlockReason(context.code)
      return emitMany([
        {
          type: SENTINEL_OFFICE_EVENT_TYPES.blocked,
          correlationId: context.planId,
          data: { phase: 'blocked', planId: context.planId, skillId: context.skillId, reason, blockedAt: context.blockedAt },
        },
        {
          type: SENTINEL_OFFICE_EVENT_TYPES.presence,
          correlationId: context.planId,
          data: presenceFor('blocked', context.planId, context.skillId),
        },
      ])
    },
    projectSafetyBoundary() {
      return emit(SENTINEL_OFFICE_EVENT_TYPES.safety, {
        authority: SENTINEL_OFFICE_SOURCE,
        projectionCanApprove: false,
        projectionCanExecute: false,
        allowedEffect: 'read-only',
        blockedEffects: ['shell', 'write', 'network', 'install', 'deploy', 'secrets'],
      })
    },
  })
}

export function createInMemoryOfficeProjectionChannel(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const maxEvents = Number.isSafeInteger(options.maxEvents) ? Math.min(Math.max(options.maxEvents, 1), 1_024) : 256
  const listeners = new Set()
  const events = []
  const seenIds = new Set()
  const seenQueue = []
  const lastSequenceByStream = new Map()

  const sentinelPublisher = Object.freeze({
    publish(event) {
      validateOfficeProjectionEvent(event, { now: now() })
      if (!authorizeOfficePublish(event.source, event.type)) fail('PRODUCER_BLOCKED', 'Producer cannot publish this topic')
      if (seenIds.has(event.eventId)) fail('REPLAY_BLOCKED', 'Office eventId was already accepted')
      const previousSequence = lastSequenceByStream.get(event.streamId) || 0
      if (event.sequence <= previousSequence) fail('OUT_OF_ORDER', 'Office event sequence is not monotonic')

      const acceptedEvent = cloneAndFreeze(event)
      seenIds.add(acceptedEvent.eventId)
      seenQueue.push(acceptedEvent.eventId)
      lastSequenceByStream.set(acceptedEvent.streamId, acceptedEvent.sequence)
      events.push(acceptedEvent)
      while (events.length > maxEvents) events.shift()
      while (seenQueue.length > maxEvents * 4) seenIds.delete(seenQueue.shift())

      for (const subscription of listeners) {
        if (!subscription.eventTypes.has(acceptedEvent.type)) continue
        try {
          const outcome = subscription.listener(acceptedEvent)
          if (outcome && typeof outcome.catch === 'function') outcome.catch(() => {})
        } catch {
          // Projection consumers cannot interrupt the Sentinel authority path.
        }
      }
      return { accepted: true }
    },
  })

  const presenceSubscriber = Object.freeze({
    subscribe(request, listener) {
      exactKeys(request, ['serviceId', 'eventTypes'], 'subscription')
      if (typeof listener !== 'function' || !Array.isArray(request.eventTypes) || request.eventTypes.length === 0) {
        fail('INVALID_CONTRACT', 'Subscription requires a listener and event types')
      }
      const uniqueTypes = new Set(request.eventTypes)
      if (uniqueTypes.size !== request.eventTypes.length
        || request.eventTypes.some((type) => !authorizeOfficeSubscription(request.serviceId, type))) {
        fail('SUBSCRIPTION_BLOCKED', 'Subscriber is not allowed for the requested topic')
      }
      const subscription = { serviceId: request.serviceId, eventTypes: uniqueTypes, listener }
      listeners.add(subscription)
      return () => listeners.delete(subscription)
    },
    snapshot(request) {
      exactKeys(request, ['serviceId', 'eventTypes'], 'snapshot request')
      if (!Array.isArray(request.eventTypes) || request.eventTypes.some((type) => !authorizeOfficeSubscription(request.serviceId, type))) {
        fail('SUBSCRIPTION_BLOCKED', 'Subscriber is not allowed for the requested snapshot')
      }
      const wanted = new Set(request.eventTypes)
      return Object.freeze(events.filter((event) => wanted.has(event.type)))
    },
  })

  return Object.freeze({ sentinelPublisher, presenceSubscriber })
}
