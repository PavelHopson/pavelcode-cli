import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildSafeOperatorPlan,
  createSafeOperatorExecutor,
  createSafeOperatorRequest,
} from '../dashboard/electron/sentinel-safe-operator.mjs'
import {
  authorizeOfficePublish,
  authorizeOfficeSubscription,
  createInMemoryOfficeProjectionChannel,
  createSentinelOfficeBridge,
  SENTINEL_OFFICE_EVENT_TYPES,
  SENTINEL_OFFICE_SOURCE,
  SentinelOfficeBridgeError,
  validateOfficeProjectionEvent,
} from '../office/sentinel-office-bridge.mjs'

const NOW = new Date('2026-08-23T12:00:00.000Z')

function ids(start = 10) {
  let next = start
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
}

function operatorPlan(command = 'Покажи память OPENAI_API_KEY=never-project-this') {
  return buildSafeOperatorPlan(command, 'memory.preview', {
    now: NOW,
    idFactory: () => '00000000-0000-4000-8000-000000000001',
  })
}

function operatorReceipt(plan = operatorPlan()) {
  const executor = createSafeOperatorExecutor({
    transport: 'electron-ipc',
    now: () => NOW,
    idFactory: () => '00000000-0000-4000-8000-000000000003',
  })
  return executor.execute(createSafeOperatorRequest(plan, {
    now: NOW,
    idFactory: () => '00000000-0000-4000-8000-000000000002',
  }))
}

test('Office Bridge projects plan and receipt without raw command or receipt content', async () => {
  const channel = createInMemoryOfficeProjectionChannel({ now: () => NOW })
  const received = []
  const unsubscribe = channel.presenceSubscriber.subscribe({
    serviceId: 'eclipse-chat.office-core',
    eventTypes: Object.values(SENTINEL_OFFICE_EVENT_TYPES),
  }, (event) => received.push(event))
  const bridge = createSentinelOfficeBridge({
    publish: (event) => channel.sentinelPublisher.publish(event),
    now: () => NOW,
    idFactory: ids(),
  })

  const plan = operatorPlan()
  const planProjection = await bridge.projectPlan(plan)
  const receiptProjection = await bridge.projectReceipt(operatorReceipt(plan))
  unsubscribe()

  assert.equal(planProjection.published, true)
  assert.equal(receiptProjection.published, true)
  assert.equal(received.length, 4)
  assert.deepEqual(received.map((event) => event.type), [
    SENTINEL_OFFICE_EVENT_TYPES.plan,
    SENTINEL_OFFICE_EVENT_TYPES.presence,
    SENTINEL_OFFICE_EVENT_TYPES.receipt,
    SENTINEL_OFFICE_EVENT_TYPES.presence,
  ])

  const serialized = JSON.stringify(received)
  assert.doesNotMatch(serialized, /OPENAI_API_KEY|never-project-this|Command:|speech|summary|lines/i)
  assert.match(serialized, /awaiting-approval/)
  assert.match(serialized, /electron-ipc/)
  assert.equal(Object.isFrozen(received[0]), true)
  assert.equal(Object.isFrozen(received[0].data), true)
  assert.throws(() => { received[0].data.phase = 'executing' }, TypeError)
})

test('Presence consumers receive no publish, approve, or execute capability', () => {
  const channel = createInMemoryOfficeProjectionChannel({ now: () => NOW })
  assert.equal(channel.presenceSubscriber.publish, undefined)
  assert.equal(channel.presenceSubscriber.approve, undefined)
  assert.equal(channel.presenceSubscriber.execute, undefined)
  assert.equal(authorizeOfficePublish('eclipse-chat.office-core', SENTINEL_OFFICE_EVENT_TYPES.receipt), false)
  assert.equal(authorizeOfficePublish(SENTINEL_OFFICE_SOURCE, SENTINEL_OFFICE_EVENT_TYPES.receipt), true)
  assert.equal(authorizeOfficeSubscription('eclipse-chat.presence-2d', SENTINEL_OFFICE_EVENT_TYPES.presence), true)
  assert.equal(authorizeOfficeSubscription('unknown-service', SENTINEL_OFFICE_EVENT_TYPES.presence), false)
  assert.throws(
    () => channel.presenceSubscriber.subscribe({
      serviceId: 'unknown-service',
      eventTypes: [SENTINEL_OFFICE_EVENT_TYPES.presence],
    }, () => {}),
    (error) => error instanceof SentinelOfficeBridgeError && error.code === 'SUBSCRIPTION_BLOCKED',
  )
})

test('Event validation rejects mass assignment, replay, and out-of-order sequence', async () => {
  const channel = createInMemoryOfficeProjectionChannel({ now: () => NOW })
  const bridge = createSentinelOfficeBridge({
    publish: (event) => channel.sentinelPublisher.publish(event),
    now: () => NOW,
    idFactory: ids(100),
  })
  const result = await bridge.projectSafetyBoundary()
  assert.equal(result.published, true)
  const event = result.event

  assert.throws(
    () => validateOfficeProjectionEvent({ ...event, approval: true }, { now: NOW }),
    (error) => error instanceof SentinelOfficeBridgeError && error.code === 'INVALID_CONTRACT',
  )
  assert.throws(
    () => channel.sentinelPublisher.publish(event),
    (error) => error instanceof SentinelOfficeBridgeError && error.code === 'REPLAY_BLOCKED',
  )
  const outOfOrder = { ...event, eventId: '00000000-0000-4000-8000-000000000999' }
  assert.throws(
    () => channel.sentinelPublisher.publish(outOfOrder),
    (error) => error instanceof SentinelOfficeBridgeError && error.code === 'OUT_OF_ORDER',
  )
})

test('Projection transport failure never changes Sentinel authority outcome', async () => {
  const bridge = createSentinelOfficeBridge({
    publish: async () => { throw new Error('transport details must stay private') },
    now: () => NOW,
    idFactory: ids(200),
  })
  const receipt = operatorReceipt()
  const result = await bridge.projectReceipt(receipt)

  assert.equal(receipt.status, 'succeeded')
  assert.equal(result.published, false)
  assert.deepEqual(result.results.map((item) => item.code), ['PROJECTION_UNAVAILABLE', 'PROJECTION_UNAVAILABLE'])
  assert.doesNotMatch(JSON.stringify(result), /transport details must stay private/)
})

test('Bridge rate limit is bounded and fail-closed', async () => {
  const published = []
  const bridge = createSentinelOfficeBridge({
    publish: (event) => published.push(event),
    now: () => NOW,
    idFactory: ids(300),
    maxEventsPerSecond: 1,
  })
  const result = await bridge.projectPlan(operatorPlan())

  assert.equal(result.published, false)
  assert.equal(result.results[0].published, true)
  assert.equal(result.results[1].code, 'RATE_LIMITED')
  assert.equal(published.length, 1)
})

test('Office Bridge source has no shell, filesystem, network, or secret-bearing transport', async () => {
  const source = await readFile(new URL('../office/sentinel-office-bridge.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /node:child_process|node:fs|\bspawn\s*\(|\bexec\s*\(|\bfetch\s*\(|writeFile|OPENAI_API_KEY/)
  assert.match(source, /projectionCanApprove:\s*false/)
  assert.match(source, /projectionCanExecute:\s*false/)
  assert.match(source, /credentialPlacement:\s*'transport-only'/)
})
