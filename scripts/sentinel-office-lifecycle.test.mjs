import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildSafeOperatorPlan,
  createSafeOperatorExecutor,
  createSafeOperatorRequest,
  SafeOperatorError,
} from '../dashboard/electron/sentinel-safe-operator.mjs'
import {
  createInMemoryOfficeProjectionOutbox,
  createSentinelOfficeLifecycle,
} from '../office/sentinel-office-lifecycle.mjs'
import { SENTINEL_OFFICE_EVENT_TYPES } from '../office/sentinel-office-bridge.mjs'

const NOW = new Date('2026-08-23T15:00:00.000Z')

function ids(start = 1_100) {
  let next = start
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
}

function operatorArtifacts() {
  const plan = buildSafeOperatorPlan('Покажи память OPENAI_API_KEY=never-project-this', 'memory.preview', {
    now: NOW,
    idFactory: () => '00000000-0000-4000-8000-000000001101',
  })
  const request = createSafeOperatorRequest(plan, {
    now: NOW,
    idFactory: () => '00000000-0000-4000-8000-000000001102',
  })
  const executor = createSafeOperatorExecutor({
    transport: 'electron-ipc',
    now: () => NOW,
    idFactory: () => '00000000-0000-4000-8000-000000001103',
  })
  return { plan, request, receipt: executor.execute(request) }
}

test('successful authority result projects an ordered secret-free lifecycle', async () => {
  const lifecycle = createSentinelOfficeLifecycle({ now: () => NOW, idFactory: ids() })
  const { request, receipt } = operatorArtifacts()

  assert.deepEqual(lifecycle.recordSuccess(request, receipt), { queued: true, code: null })
  const status = await lifecycle.flush()
  const events = lifecycle.snapshot()

  assert.equal(status.pending, 0)
  assert.equal(status.completed, 1)
  assert.equal(status.failed, 0)
  assert.deepEqual(events.map((event) => event.type), [
    SENTINEL_OFFICE_EVENT_TYPES.plan,
    SENTINEL_OFFICE_EVENT_TYPES.presence,
    SENTINEL_OFFICE_EVENT_TYPES.execution,
    SENTINEL_OFFICE_EVENT_TYPES.presence,
    SENTINEL_OFFICE_EVENT_TYPES.receipt,
    SENTINEL_OFFICE_EVENT_TYPES.presence,
  ])
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6])
  assert.doesNotMatch(JSON.stringify(events), /OPENAI_API_KEY|never-project-this|speech|summary|lines/i)
})

test('projection transport failure is isolated from an already issued receipt', async () => {
  const lifecycle = createSentinelOfficeLifecycle({
    publish: async () => { throw new Error('private transport details') },
    now: () => NOW,
    idFactory: ids(1_200),
  })
  const { request, receipt } = operatorArtifacts()

  const queued = lifecycle.recordSuccess(request, receipt)
  const status = await lifecycle.flush()

  assert.deepEqual(queued, { queued: true, code: null })
  assert.equal(receipt.status, 'succeeded')
  assert.equal(status.completed, 0)
  assert.equal(status.failed, 1)
  assert.equal(lifecycle.snapshot().length, 0)
  assert.doesNotMatch(JSON.stringify(status), /private transport details/)
})

test('blocked projection keeps only a public failure class', async () => {
  const lifecycle = createSentinelOfficeLifecycle({ now: () => NOW, idFactory: ids(1_300) })
  const { request } = operatorArtifacts()
  const error = new SafeOperatorError('APPROVAL_EXPIRED', 'OPENAI_API_KEY=never-project-this')

  assert.deepEqual(lifecycle.recordBlocked(request, error), { queued: true, code: null })
  await lifecycle.flush()
  const serialized = JSON.stringify(lifecycle.snapshot())

  assert.match(serialized, /stale-request/)
  assert.doesNotMatch(serialized, /OPENAI_API_KEY|never-project-this|APPROVAL_EXPIRED/)
})

test('outbox is bounded, immutable, and rejects invalid mass-assigned events', () => {
  const outbox = createInMemoryOfficeProjectionOutbox({ maxEvents: 2 })
  const makeEvent = (sequence) => ({
    schemaVersion: 'eclipse.office.event.v1',
    eventId: `00000000-0000-4000-8000-${String(1_400 + sequence).padStart(12, '0')}`,
    streamId: '00000000-0000-4000-8000-000000001400',
    sequence,
    type: SENTINEL_OFFICE_EVENT_TYPES.safety,
    source: 'eclipse-hopson-sentinel',
    subject: 'agent:sentinel',
    time: NOW.toISOString(),
    correlationId: null,
    audience: ['eclipse-chat.office-core', 'eclipse-chat.presence-2d', 'eclipse-chat.presence-3d'],
    data: {
      authority: 'eclipse-hopson-sentinel',
      projectionCanApprove: false,
      projectionCanExecute: false,
      allowedEffect: 'read-only',
      blockedEffects: ['shell', 'write', 'network', 'install', 'deploy', 'secrets'],
    },
  })

  assert.deepEqual(outbox.publish(makeEvent(1)), { accepted: true })
  assert.deepEqual(outbox.publish(makeEvent(2)), { accepted: true })
  assert.deepEqual(outbox.publish(makeEvent(3)), { accepted: true })
  assert.deepEqual(outbox.snapshot().map((event) => event.sequence), [2, 3])
  assert.deepEqual(outbox.stats(), { retained: 2, dropped: 1 })
  assert.equal(Object.isFrozen(outbox.snapshot()), true)
  assert.throws(() => outbox.publish({ ...makeEvent(4), execute: true }), /unknown or missing fields/i)
})

test('lifecycle source has no shell, filesystem, network, logs, or secret transport', async () => {
  const source = await readFile(new URL('../office/sentinel-office-lifecycle.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /node:child_process|node:fs|\bspawn\s*\(|\bexec\s*\(|\bfetch\s*\(|console\.|writeFile|localStorage|OPENAI_API_KEY/)
})
