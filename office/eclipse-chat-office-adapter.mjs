import {
  SENTINEL_OFFICE_EVENT_TYPES,
  SENTINEL_OFFICE_SOURCE,
  validateOfficeProjectionEvent,
} from './sentinel-office-bridge.mjs'

export const ECLIPSE_CHAT_OFFICE_SCHEMA = 'office.event.v1'

export const ECLIPSE_CHAT_OFFICE_EVENT_TYPES = Object.freeze([
  'task.created',
  'task.started',
  'task.progressed',
  'task.cancelled',
  'task.completed',
  'task.failed',
  'approval.requested',
  'approval.resolved',
  'agent.state.changed',
  'deliverable.ready',
])

const OFFICE_TYPE_SET = new Set(ECLIPSE_CHAT_OFFICE_EVENT_TYPES)
const SUBJECT_KIND_SET = new Set(['task', 'run', 'approval', 'agent', 'deliverable'])
const SENSITIVE_METADATA_KEY = /(authorization|cookie|credential|password|private.?key|secret|token|api.?key)/i
const MAX_METADATA_KEYS = 20

const SUMMARY = Object.freeze({
  taskCreated: 'Sentinel read-only task created',
  approvalRequested: 'Sentinel requires manual approval',
  approvalResolved: 'Sentinel approval accepted',
  taskStarted: 'Sentinel read-only task started',
  taskCompleted: 'Sentinel read-only task completed',
  taskFailed: 'Sentinel task blocked by policy',
  presence: 'Sentinel presence changed',
  safety: 'Sentinel safety boundary confirmed',
})

export class EclipseChatOfficeAdapterError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'EclipseChatOfficeAdapterError'
    this.code = code
  }
}

function fail(code, message) {
  throw new EclipseChatOfficeAdapterError(code, message)
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

function parseIso(value, name) {
  if (typeof value !== 'string') fail('INVALID_CONTRACT', `${name} must be a date-time`)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail('INVALID_CONTRACT', `${name} must be a canonical date-time`)
  }
  return timestamp
}

function validateWorkspaceId(workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId !== workspaceId.trim()
    || workspaceId.length < 1 || workspaceId.length > 160) {
    fail('WORKSPACE_REQUIRED', 'workspaceId must match the authenticated Office Core workspace')
  }
  return workspaceId
}

function validateSubject(subject) {
  exactKeys(subject, ['kind', 'id'], 'subject')
  if (!SUBJECT_KIND_SET.has(subject.kind) || typeof subject.id !== 'string'
    || subject.id !== subject.id.trim() || subject.id.length < 1 || subject.id.length > 160) {
    fail('INVALID_CONTRACT', 'Office subject is invalid')
  }
}

function validateMetadata(metadata) {
  if (!isRecord(metadata)) fail('INVALID_CONTRACT', 'metadata must be an object')
  const entries = Object.entries(metadata)
  if (entries.length > MAX_METADATA_KEYS) fail('METADATA_TOO_LARGE', 'metadata has too many fields')
  for (const [key, value] of entries) {
    if (key.length < 1 || key.length > 64 || SENSITIVE_METADATA_KEY.test(key)) {
      fail('SENSITIVE_METADATA', 'metadata key is not allowed')
    }
    const validValue = value === null
      || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && value === value.trim() && value.length <= 240)
    if (!validValue) fail('INVALID_CONTRACT', `metadata.${key} must be a bounded primitive`)
  }
}

export function validateEclipseChatOfficeInput(input) {
  exactKeys(input, ['workspaceId', 'type', 'subject', 'summary', 'metadata'], 'OfficeEventInput')
  validateWorkspaceId(input.workspaceId)
  if (!OFFICE_TYPE_SET.has(input.type)) fail('EVENT_TYPE_BLOCKED', 'Office event type is not allowlisted')
  validateSubject(input.subject)
  if (typeof input.summary !== 'string' || input.summary !== input.summary.trim()
    || input.summary.length < 1 || input.summary.length > 320) {
    fail('INVALID_CONTRACT', 'Office summary is invalid')
  }
  validateMetadata(input.metadata)
  return input
}

export function validateEclipseChatOfficeEvent(event) {
  exactKeys(event, [
    'workspaceId', 'type', 'subject', 'summary', 'metadata',
    'schemaVersion', 'id', 'sequence', 'occurredAt',
  ], 'OfficeEvent')
  validateEclipseChatOfficeInput({
    workspaceId: event.workspaceId,
    type: event.type,
    subject: event.subject,
    summary: event.summary,
    metadata: event.metadata,
  })
  if (event.schemaVersion !== ECLIPSE_CHAT_OFFICE_SCHEMA) fail('SCHEMA_MISMATCH', 'Office event schema is not supported')
  if (typeof event.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.id)) {
    fail('INVALID_CONTRACT', 'Office event id must be a server-generated UUID')
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    fail('INVALID_CONTRACT', 'Office event sequence must be positive and server-assigned')
  }
  parseIso(event.occurredAt, 'Office event occurredAt')
  return event
}

function baseMetadata() {
  return {
    producer: SENTINEL_OFFICE_SOURCE,
    authority: 'sentinel-runtime',
  }
}

function eventInput(workspaceId, type, subject, summary, metadata) {
  const input = {
    workspaceId,
    type,
    subject,
    summary,
    metadata: { ...baseMetadata(), ...metadata },
  }
  validateEclipseChatOfficeInput(input)
  return Object.freeze({ ...input, subject: Object.freeze({ ...subject }), metadata: Object.freeze({ ...input.metadata }) })
}

function receiptBoundaryMetadata(boundaries) {
  const has = (name) => boundaries.includes(name)
  return {
    readOnly: has('read-only'),
    shellAllowed: !has('no-shell'),
    networkAllowed: !has('no-network'),
    filesystemWriteAllowed: !has('no-filesystem-write'),
    protectedDataAccess: has('no-secrets') ? 'blocked' : 'unspecified',
    oneShot: has('one-shot'),
    previewOnly: has('preview-only'),
  }
}

export function mapSentinelProjectionToOfficeInputs(projection, workspaceId) {
  validateOfficeProjectionEvent(projection)
  const tenant = validateWorkspaceId(workspaceId)
  const data = projection.data

  if (projection.type === SENTINEL_OFFICE_EVENT_TYPES.plan) {
    return Object.freeze([
      eventInput(tenant, 'task.created', { kind: 'task', id: data.planId }, SUMMARY.taskCreated, {
        taskId: data.planId,
        sentinelPlanId: data.planId,
        skillId: data.skillId,
        effect: data.effect,
      }),
      eventInput(tenant, 'approval.requested', { kind: 'approval', id: data.planId }, SUMMARY.approvalRequested, {
        approvalId: data.planId,
        taskId: data.planId,
        skillId: data.skillId,
        requiresApproval: true,
        killSwitch: 'engaged',
      }),
    ])
  }

  if (projection.type === SENTINEL_OFFICE_EVENT_TYPES.execution) {
    return Object.freeze([
      eventInput(tenant, 'approval.resolved', { kind: 'approval', id: data.planId }, SUMMARY.approvalResolved, {
        approvalId: data.planId,
        resolutionId: data.requestId,
        taskId: data.planId,
        decision: 'approved',
        skillId: data.skillId,
      }),
      eventInput(tenant, 'task.started', { kind: 'task', id: data.planId }, SUMMARY.taskStarted, {
        taskId: data.planId,
        requestId: data.requestId,
        skillId: data.skillId,
        effect: data.effect,
      }),
    ])
  }

  if (projection.type === SENTINEL_OFFICE_EVENT_TYPES.receipt) {
    return Object.freeze([
      eventInput(tenant, 'task.completed', { kind: 'task', id: data.planId }, SUMMARY.taskCompleted, {
        taskId: data.planId,
        requestId: data.requestId,
        receiptId: data.receiptId,
        skillId: data.skillId,
        status: data.status,
        effect: data.effect,
        transport: data.transport,
        ...receiptBoundaryMetadata(data.boundaries),
      }),
    ])
  }

  if (projection.type === SENTINEL_OFFICE_EVENT_TYPES.blocked) {
    const taskId = data.planId || 'sentinel-policy'
    return Object.freeze([
      eventInput(tenant, 'task.failed', { kind: 'task', id: taskId }, SUMMARY.taskFailed, {
        taskId,
        skillId: data.skillId,
        failureReason: data.reason,
      }),
    ])
  }

  if (projection.type === SENTINEL_OFFICE_EVENT_TYPES.presence) {
    return Object.freeze([
      eventInput(tenant, 'agent.state.changed', { kind: 'agent', id: 'sentinel' }, SUMMARY.presence, {
        state: data.mode,
        availability: data.availability,
        attention: data.attention,
        activeTaskId: data.activePlanId,
        activeSkillId: data.activeSkillId,
      }),
    ])
  }

  if (projection.type === SENTINEL_OFFICE_EVENT_TYPES.safety) {
    return Object.freeze([
      eventInput(tenant, 'agent.state.changed', { kind: 'agent', id: 'sentinel' }, SUMMARY.safety, {
        state: 'safety-boundary',
        projectionCanApprove: false,
        projectionCanExecute: false,
        readOnly: true,
        shellAllowed: false,
        networkAllowed: false,
        filesystemWriteAllowed: false,
        protectedDataAccess: 'blocked',
      }),
    ])
  }

  fail('EVENT_TYPE_BLOCKED', 'Sentinel projection has no Office Core mapping')
}

function sameMetadata(left, right) {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && Object.is(left[key], right[key]))
}

function persistedMatchesInput(event, input) {
  return event.workspaceId === input.workspaceId
    && event.type === input.type
    && event.subject.kind === input.subject.kind
    && event.subject.id === input.subject.id
    && event.summary === input.summary
    && sameMetadata(event.metadata, input.metadata)
}

export function createEclipseChatOfficePublisher(options = {}) {
  const workspaceId = validateWorkspaceId(options.workspaceId)
  if (typeof options.publishBatch !== 'function') {
    fail('PUBLISHER_REQUIRED', 'Atomic Office Core publishBatch adapter is required')
  }
  const publishBatch = options.publishBatch

  return Object.freeze({
    async publish(projection) {
      const inputs = mapSentinelProjectionToOfficeInputs(projection, workspaceId)
      try {
        const persistedBatch = await publishBatch(inputs)
        if (!Array.isArray(persistedBatch) || persistedBatch.length !== inputs.length) {
          fail('INVALID_CONTRACT', 'Office Core batch result does not match the submitted batch')
        }
        const officeEvents = persistedBatch.map((persisted, index) => {
          validateEclipseChatOfficeEvent(persisted)
          if (persisted.workspaceId !== workspaceId) fail('WORKSPACE_MISMATCH', 'Office Core returned another workspace')
          if (!persistedMatchesInput(persisted, inputs[index])) {
            fail('OFFICE_CORE_MISMATCH', 'Office Core changed the validated event input')
          }
          return Object.freeze({
            ...persisted,
            subject: Object.freeze({ ...persisted.subject }),
            metadata: Object.freeze({ ...persisted.metadata }),
          })
        })
        return { accepted: true, code: null, officeEvents: Object.freeze(officeEvents) }
      } catch (error) {
        if (error instanceof EclipseChatOfficeAdapterError) throw error
        return { accepted: false, code: 'OFFICE_CORE_UNAVAILABLE', officeEvents: Object.freeze([]) }
      }
    },
  })
}
