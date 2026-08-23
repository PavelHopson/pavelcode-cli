import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  ECLIPSE_CHAT_OFFICE_EVENT_TYPES,
  ECLIPSE_CHAT_OFFICE_SCHEMA,
} from '../office/eclipse-chat-office-adapter.mjs'

const NOW = '2026-08-23T12:00:00.000Z'

test('Eclipse Chat Office schema matches the audited runtime contract', async () => {
  const schema = JSON.parse(await readFile(
    new URL('../docs/contracts/eclipse-chat-office-event-v1.schema.json', import.meta.url),
    'utf8',
  ))
  assert.equal(schema.$defs.officeEvent.properties.schemaVersion.const, ECLIPSE_CHAT_OFFICE_SCHEMA)
  assert.deepEqual(schema.$defs.eventType.enum, ECLIPSE_CHAT_OFFICE_EVENT_TYPES)

  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    formats: {
      uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'date-time': (value) => Number.isFinite(Date.parse(value)),
    },
  })
  ajv.addSchema(schema)
  const validateEvent = ajv.getSchema(`${schema.$id}#/$defs/officeEvent`)
  const validateInput = ajv.getSchema(`${schema.$id}#/$defs/officeEventInput`)
  assert.equal(typeof validateEvent, 'function')
  assert.equal(typeof validateInput, 'function')

  const input = {
    workspaceId: 'eclipse-forge',
    type: 'agent.state.changed',
    subject: { kind: 'agent', id: 'sentinel' },
    summary: 'Sentinel presence changed',
    metadata: { state: 'idle', readOnly: true },
  }
  assert.equal(validateInput(input), true, JSON.stringify(validateInput.errors))

  const event = {
    ...input,
    schemaVersion: ECLIPSE_CHAT_OFFICE_SCHEMA,
    id: '00000000-0000-4000-8000-000000001000',
    sequence: 1,
    occurredAt: NOW,
  }
  assert.equal(validateEvent(event), true, JSON.stringify(validateEvent.errors))
  assert.equal(validateEvent({ ...event, cursor: 1 }), false)
  assert.equal(validateEvent({ ...event, metadata: { nested: { forbidden: true } } }), false)
  assert.equal(validateInput({ ...input, sequence: 1 }), false)
})
