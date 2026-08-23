import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildSafeOperatorPlan,
  createSafeOperatorExecutor,
  createSafeOperatorRequest,
  resolveSafeOperatorSkill,
  SafeOperatorError,
} from '../dashboard/electron/sentinel-safe-operator.mjs'

const NOW = new Date('2026-08-23T10:00:00.000Z')
const IDS = {
  plan: '00000000-0000-4000-8000-000000000001',
  request: '00000000-0000-4000-8000-000000000002',
  receipt: '00000000-0000-4000-8000-000000000003',
}

function plan(command = 'Покажи статус системы') {
  return buildSafeOperatorPlan(command, undefined, {
    now: NOW,
    idFactory: () => IDS.plan,
  })
}

function request(operatorPlan = plan()) {
  return createSafeOperatorRequest(operatorPlan, {
    now: NOW,
    idFactory: () => IDS.request,
  })
}

function executor() {
  return createSafeOperatorExecutor({
    transport: 'electron-ipc',
    now: () => NOW,
    idFactory: () => IDS.receipt,
    runtimeProvider: () => ({
      platform: 'win32',
      arch: 'x64',
      node: '24.0.0',
      electron: '41.2.0',
      packaged: true,
    }),
  })
}

test('safe router recognizes only the three first-party read-only intents', () => {
  assert.equal(resolveSafeOperatorSkill('Покажи статус системы'), 'workspace.status')
  assert.equal(resolveSafeOperatorSkill('Покажи разрешённые навыки'), 'skills.status')
  assert.equal(resolveSafeOperatorSkill('Сделай preview памяти'), 'memory.preview')
  assert.equal(resolveSafeOperatorSkill('Установи программу'), null)
})

test('one-shot executor returns a bounded receipt and blocks replay', () => {
  const instance = executor()
  const operatorRequest = request()
  const receipt = instance.execute(operatorRequest)

  assert.equal(receipt.schemaVersion, 'eclipse.sentinel.operator-receipt.v1')
  assert.equal(receipt.status, 'succeeded')
  assert.equal(receipt.effect, 'read-only')
  assert.equal(receipt.transport, 'electron-ipc')
  assert.deepEqual(receipt.boundaries, [
    'read-only',
    'no-shell',
    'no-network',
    'no-filesystem-write',
    'no-secrets',
    'one-shot',
  ])
  assert.throws(
    () => instance.execute(operatorRequest),
    (error) => error instanceof SafeOperatorError && error.code === 'REPLAY_BLOCKED',
  )
})

test('executor rejects approval bypass and unknown request fields', () => {
  const denied = request()
  denied.approval.confirmed = false
  assert.throws(
    () => executor().execute(denied),
    (error) => error instanceof SafeOperatorError && error.code === 'APPROVAL_REQUIRED',
  )

  const extended = { ...request(), role: 'admin' }
  assert.throws(
    () => executor().execute(extended),
    (error) => error instanceof SafeOperatorError && error.code === 'INVALID_REQUEST',
  )
})

test('executor accepts only the exact canonical plan contract', () => {
  assert.equal(executor().execute(request()).skillId, 'workspace.status')
  const tamperedPlan = { ...plan(), steps: ['Запустить shell'] }
  assert.throws(
    () => executor().execute(request(tamperedPlan)),
    (error) => error instanceof SafeOperatorError && error.code === 'PLAN_TAMPERED',
  )
})

test('safe operator source contains no shell, network or filesystem executor', async () => {
  const source = await readFile(
    new URL('../dashboard/electron/sentinel-safe-operator.mjs', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(source, /node:child_process|\bspawn\s*\(|\bexec\s*\(|\bfetch\s*\(|writeFile|rmSync|unlinkSync/)
  assert.match(source, /MAX_EXECUTIONS_PER_MINUTE/)
  assert.match(source, /APPROVAL_TTL_MS/)
})
