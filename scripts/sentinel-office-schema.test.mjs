import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  createSentinelOfficeBridge,
  SENTINEL_OFFICE_AUDIENCE,
  SENTINEL_OFFICE_EVENT_TYPES,
  SENTINEL_OFFICE_SOURCE,
} from '../office/sentinel-office-bridge.mjs'

const NOW = new Date('2026-08-23T12:00:00.000Z')

function ids() {
  let next = 500
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
}

test('machine-readable Office schema matches runtime event types and rejects extra fields', async () => {
  const schema = JSON.parse(await readFile(
    new URL('../docs/contracts/sentinel-office-event-v1.schema.json', import.meta.url),
    'utf8',
  ))
  assert.equal(schema.properties.source.const, SENTINEL_OFFICE_SOURCE)
  assert.deepEqual(schema.properties.type.enum, Object.values(SENTINEL_OFFICE_EVENT_TYPES))
  assert.deepEqual(schema.properties.audience.prefixItems.map((item) => item.const), SENTINEL_OFFICE_AUDIENCE)

  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    formats: {
      uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'date-time': (value) => Number.isFinite(Date.parse(value)),
    },
  })
  const validate = ajv.compile(schema)
  let event
  const bridge = createSentinelOfficeBridge({
    publish: (nextEvent) => { event = nextEvent },
    now: () => NOW,
    idFactory: ids(),
  })
  await bridge.projectSafetyBoundary()

  assert.equal(validate(event), true, JSON.stringify(validate.errors))
  assert.equal(validate({ ...event, approval: true }), false)
  assert.equal(validate({ ...event, data: { ...event.data, token: 'forbidden' } }), false)
})
