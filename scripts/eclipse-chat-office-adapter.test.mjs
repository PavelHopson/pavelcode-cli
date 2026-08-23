import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSafeOperatorPlan,
  createSafeOperatorExecutor,
  createSafeOperatorRequest,
} from '../dashboard/electron/sentinel-safe-operator.mjs'
import {
  createSentinelOfficeBridge,
  SENTINEL_OFFICE_EVENT_TYPES,
} from '../office/sentinel-office-bridge.mjs'
import {
  createEclipseChatOfficePublisher,
  ECLIPSE_CHAT_OFFICE_SCHEMA,
  EclipseChatOfficeAdapterError,
  mapSentinelProjectionToOfficeInputs,
  validateEclipseChatOfficeEvent,
  validateEclipseChatOfficeInput,
} from '../office/eclipse-chat-office-adapter.mjs'

const NOW = new Date('2026-08-23T12:00:00.000Z')
const WORKSPACE_ID = 'eclipse-forge'

function ids(start = 700) {
  let next = start
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
}

function plan() {
  return buildSafeOperatorPlan('Покажи память OPENAI_API_KEY=never-export-this', 'memory.preview', {
    now: NOW,
    idFactory: () => '00000000-0000-4000-8000-000000000701',
  })
}

async function projectionsFor(method, value) {
  const projections = []
  const bridge = createSentinelOfficeBridge({
    publish: (projection) => projections.push(projection),
    now: () => NOW,
    idFactory: ids(710),
  })
  await bridge[method](value)
  return projections
}

test('plan projection maps to exact Office Core inputs without canonical server fields', async () => {
  const [projection] = await projectionsFor('projectPlan', plan())
  const inputs = mapSentinelProjectionToOfficeInputs(projection, WORKSPACE_ID)

  assert.deepEqual(inputs.map((input) => input.type), ['task.created', 'approval.requested'])
  assert.deepEqual(Object.keys(inputs[0]).sort(), ['metadata', 'subject', 'summary', 'type', 'workspaceId'])
  assert.equal(inputs[0].workspaceId, WORKSPACE_ID)
  assert.equal(inputs[0].subject.id, plan().id)
  assert.equal('id' in inputs[0], false)
  assert.equal('sequence' in inputs[0], false)
  assert.equal('cursor' in inputs[0], false)
  assert.equal('occurredAt' in inputs[0], false)
  assert.doesNotMatch(JSON.stringify(inputs), /OPENAI_API_KEY|never-export-this|command|speech|lines/i)
})

test('receipt mapping preserves receipt correlation and only bounded safe primitives', async () => {
  const operatorPlan = plan()
  const executor = createSafeOperatorExecutor({
    transport: 'electron-ipc',
    now: () => NOW,
    idFactory: () => '00000000-0000-4000-8000-000000000703',
  })
  const receipt = executor.execute(createSafeOperatorRequest(operatorPlan, {
    now: NOW,
    idFactory: () => '00000000-0000-4000-8000-000000000702',
  }))
  const [projection] = await projectionsFor('projectReceipt', receipt)
  const [input] = mapSentinelProjectionToOfficeInputs(projection, WORKSPACE_ID)

  assert.equal(input.type, 'task.completed')
  assert.equal(input.metadata.receiptId, receipt.receiptId)
  assert.equal(input.metadata.requestId, receipt.requestId)
  assert.equal(input.metadata.protectedDataAccess, 'blocked')
  assert.equal(input.metadata.shellAllowed, false)
  assert.equal(input.metadata.networkAllowed, false)
  assert.equal(input.metadata.filesystemWriteAllowed, false)
  assert.equal(Object.values(input.metadata).every((value) => value === null || ['string', 'number', 'boolean'].includes(typeof value)), true)
  assert.doesNotMatch(JSON.stringify(input.metadata), /summary|speech|lines|secretsAllowed/i)
})

test('publisher accepts only canonical Office Core output for its bound workspace', async () => {
  const projections = await projectionsFor('projectSafetyBoundary')
  let sequence = 0
  const publisher = createEclipseChatOfficePublisher({
    workspaceId: WORKSPACE_ID,
    publishBatch: async (inputs) => inputs.map((input) => ({
        ...input,
        schemaVersion: ECLIPSE_CHAT_OFFICE_SCHEMA,
        id: `00000000-0000-4000-8000-${String(800 + sequence).padStart(12, '0')}`,
        sequence: ++sequence,
        occurredAt: NOW.toISOString(),
      })),
  })

  const result = await publisher.publish(projections[0])
  assert.equal(result.accepted, true)
  assert.equal(result.officeEvents.length, 1)
  assert.equal(result.officeEvents[0].sequence, 1)
  assert.equal(result.officeEvents[0].workspaceId, WORKSPACE_ID)
  assert.equal(Object.isFrozen(result.officeEvents[0]), true)
})

test('publisher rejects a canonical event returned for another workspace', async () => {
  const [projection] = await projectionsFor('projectSafetyBoundary')
  const publisher = createEclipseChatOfficePublisher({
    workspaceId: WORKSPACE_ID,
    publishBatch: async (inputs) => inputs.map((input, index) => ({
      ...input,
      workspaceId: 'another-workspace',
      schemaVersion: ECLIPSE_CHAT_OFFICE_SCHEMA,
      id: `00000000-0000-4000-8000-${String(900 + index).padStart(12, '0')}`,
      sequence: index + 1,
      occurredAt: NOW.toISOString(),
    })),
  })

  await assert.rejects(
    () => publisher.publish(projection),
    (error) => error instanceof EclipseChatOfficeAdapterError && error.code === 'WORKSPACE_MISMATCH',
  )
})

test('workspace mismatch and sensitive metadata fail closed', async () => {
  const valid = {
    workspaceId: WORKSPACE_ID,
    type: 'agent.state.changed',
    subject: { kind: 'agent', id: 'sentinel' },
    summary: 'Sentinel presence changed',
    metadata: { state: 'idle' },
  }
  for (const key of ['apiKey', 'password', 'secretsAllowed', 'private-key']) {
    assert.throws(
      () => validateEclipseChatOfficeInput({ ...valid, metadata: { [key]: 'blocked' } }),
      (error) => error instanceof EclipseChatOfficeAdapterError && error.code === 'SENSITIVE_METADATA',
    )
  }

  assert.throws(
    () => validateEclipseChatOfficeEvent({
      ...valid,
      workspaceId: 'another-workspace',
      schemaVersion: ECLIPSE_CHAT_OFFICE_SCHEMA,
      id: '00000000-0000-4000-8000-000000000900',
      sequence: 1,
      occurredAt: NOW.toISOString(),
      cursor: 1,
    }),
    (error) => error instanceof EclipseChatOfficeAdapterError && error.code === 'INVALID_CONTRACT',
  )
})

test('every Sentinel projection type has an allowlisted Office mapping', async () => {
  const operatorPlan = plan()
  const executor = createSafeOperatorExecutor({
    transport: 'electron-ipc',
    now: () => NOW,
    idFactory: () => '00000000-0000-4000-8000-000000000706',
  })
  const receipt = executor.execute(createSafeOperatorRequest(operatorPlan, {
    now: NOW,
    idFactory: () => '00000000-0000-4000-8000-000000000705',
  }))
  const cases = [
    ...(await projectionsFor('projectPlan', operatorPlan)),
    ...(await projectionsFor('projectExecutionAccepted', {
      requestId: '00000000-0000-4000-8000-000000000704',
      planId: operatorPlan.id,
      skillId: operatorPlan.skillId,
      effect: operatorPlan.effect,
      acceptedAt: NOW.toISOString(),
    })),
    ...(await projectionsFor('projectReceipt', receipt)),
    ...(await projectionsFor('projectBlocked', {
      planId: operatorPlan.id,
      skillId: operatorPlan.skillId,
      code: 'POLICY_BLOCKED',
      blockedAt: NOW.toISOString(),
    })),
    ...(await projectionsFor('projectSafetyBoundary')),
  ]

  assert.deepEqual(new Set(cases.map((projection) => projection.type)), new Set([
    SENTINEL_OFFICE_EVENT_TYPES.plan,
    SENTINEL_OFFICE_EVENT_TYPES.execution,
    SENTINEL_OFFICE_EVENT_TYPES.receipt,
    SENTINEL_OFFICE_EVENT_TYPES.blocked,
    SENTINEL_OFFICE_EVENT_TYPES.presence,
    SENTINEL_OFFICE_EVENT_TYPES.safety,
  ]))
  for (const projection of cases) {
    for (const input of mapSentinelProjectionToOfficeInputs(projection, WORKSPACE_ID)) {
      assert.equal(validateEclipseChatOfficeInput(input), input)
    }
  }
})
