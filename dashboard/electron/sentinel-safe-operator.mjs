import { randomUUID } from 'node:crypto'

export const SAFE_OPERATOR_PLAN_SCHEMA = 'eclipse.sentinel.operator-plan.v1'
export const SAFE_OPERATOR_REQUEST_SCHEMA = 'eclipse.sentinel.operator-request.v1'
export const SAFE_OPERATOR_RECEIPT_SCHEMA = 'eclipse.sentinel.operator-receipt.v1'

const APPROVAL_TTL_MS = 5 * 60 * 1000
const PLAN_TTL_MS = 30 * 60 * 1000
const MAX_EXECUTIONS_PER_MINUTE = 6
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const SKILLS = Object.freeze({
  'workspace.status': Object.freeze({
    id: 'workspace.status',
    label: 'Статус рабочего места',
    description: 'Показать безопасный локальный runtime без путей, hostname и секретов.',
  }),
  'memory.preview': Object.freeze({
    id: 'memory.preview',
    label: 'Предпросмотр памяти',
    description: 'Сформировать локальный Markdown preview без сохранения.',
  }),
  'skills.status': Object.freeze({
    id: 'skills.status',
    label: 'Статус навыков',
    description: 'Показать точный read-only allowlist и заблокированные эффекты.',
  }),
})

const PLAN_STEPS = Object.freeze([
  'Проверить exact skill allowlist',
  'Проверить свежесть ручного подтверждения',
  'Выполнить один read-only handler',
  'Сформировать локальный receipt и снова включить STOP',
])

const PLAN_DIFF = Object.freeze([
  'Файлы и память: без изменений',
  'Shell, сеть и запуск программ: запрещены',
  'Секреты, hostname и локальные пути: не читаются',
  'Повторный запуск того же requestId: запрещён',
])

const BOUNDARIES = Object.freeze([
  'read-only',
  'no-shell',
  'no-network',
  'no-filesystem-write',
  'no-secrets',
  'one-shot',
])

export class SafeOperatorError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SafeOperatorError'
    this.code = code
  }
}

function fail(code, message) {
  throw new SafeOperatorError(code, message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected, name) {
  if (!isRecord(value)) fail('INVALID_REQUEST', `${name} должен быть объектом`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('INVALID_REQUEST', `${name} содержит неизвестные или отсутствующие поля`)
  }
}

function parseIsoDate(value, name) {
  if (typeof value !== 'string') fail('INVALID_REQUEST', `${name} должен быть ISO timestamp`)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail('INVALID_REQUEST', `${name} должен быть каноническим ISO timestamp`)
  }
  return timestamp
}

function requireUuid(value, name) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('INVALID_REQUEST', `${name} должен быть UUID`)
  }
}

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index])
}

export function normalizeOperatorCommand(rawCommand) {
  if (typeof rawCommand !== 'string') return ''
  return rawCommand.trim().replace(/\s+/g, ' ').slice(0, 500)
}

export function listSafeOperatorSkills() {
  return Object.values(SKILLS).map((skill) => ({ ...skill, effect: 'read-only' }))
}

export function resolveSafeOperatorSkill(rawCommand) {
  const command = normalizeOperatorCommand(rawCommand).toLocaleLowerCase('ru-RU')
  if (!command) return null
  if (/(памят|memory|заметк|preview)/u.test(command)) return 'memory.preview'
  if (/(навык|skill|allowlist|разрешен)/u.test(command)) return 'skills.status'
  if (/(статус|состояни|runtime|system|система|рабоч)/u.test(command)) return 'workspace.status'
  return null
}

export function buildSafeOperatorPlan(rawCommand, preferredSkillId, options = {}) {
  const command = normalizeOperatorCommand(rawCommand)
  const skillId = preferredSkillId || resolveSafeOperatorSkill(command)
  const skill = SKILLS[skillId]
  if (!command || !skill) return null

  const now = options.now instanceof Date ? options.now : new Date()
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : randomUUID
  return {
    schemaVersion: SAFE_OPERATOR_PLAN_SCHEMA,
    id: idFactory(),
    createdAt: now.toISOString(),
    skillId: skill.id,
    label: skill.label,
    command,
    steps: [...PLAN_STEPS],
    diff: [...PLAN_DIFF],
    effect: 'read-only',
  }
}

export function createSafeOperatorRequest(plan, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date()
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : randomUUID
  return {
    schemaVersion: SAFE_OPERATOR_REQUEST_SCHEMA,
    requestId: idFactory(),
    plan,
    approval: {
      confirmed: true,
      killSwitchReleased: true,
      confirmedAt: now.toISOString(),
    },
  }
}

function validatePlan(plan, nowMs) {
  exactKeys(plan, ['schemaVersion', 'id', 'createdAt', 'skillId', 'label', 'command', 'steps', 'diff', 'effect'], 'plan')
  if (plan.schemaVersion !== SAFE_OPERATOR_PLAN_SCHEMA) fail('SCHEMA_MISMATCH', 'Версия plan не поддерживается')
  requireUuid(plan.id, 'plan.id')
  const createdAt = parseIsoDate(plan.createdAt, 'plan.createdAt')
  if (createdAt > nowMs + 5_000 || nowMs - createdAt > PLAN_TTL_MS) fail('PLAN_EXPIRED', 'План устарел; соберите его заново')
  const skill = SKILLS[plan.skillId]
  if (!skill || plan.label !== skill.label || plan.effect !== 'read-only') fail('SKILL_BLOCKED', 'Навык не входит в read-only allowlist')
  if (plan.command !== normalizeOperatorCommand(plan.command) || !plan.command) fail('INVALID_REQUEST', 'Команда должна быть нормализована и не пуста')
  if (!sameStrings(plan.steps, PLAN_STEPS) || !sameStrings(plan.diff, PLAN_DIFF)) fail('PLAN_TAMPERED', 'План или diff были изменены после создания')
  return { skill, createdAt }
}

function validateRequest(request, nowMs) {
  exactKeys(request, ['schemaVersion', 'requestId', 'plan', 'approval'], 'request')
  if (request.schemaVersion !== SAFE_OPERATOR_REQUEST_SCHEMA) fail('SCHEMA_MISMATCH', 'Версия request не поддерживается')
  requireUuid(request.requestId, 'requestId')
  const validatedPlan = validatePlan(request.plan, nowMs)
  exactKeys(request.approval, ['confirmed', 'killSwitchReleased', 'confirmedAt'], 'approval')
  if (request.approval.confirmed !== true || request.approval.killSwitchReleased !== true) {
    fail('APPROVAL_REQUIRED', 'Нужно явное подтверждение и одноразовое снятие STOP')
  }
  const confirmedAt = parseIsoDate(request.approval.confirmedAt, 'approval.confirmedAt')
  if (confirmedAt < validatedPlan.createdAt || confirmedAt > nowMs + 5_000 || nowMs - confirmedAt > APPROVAL_TTL_MS) {
    fail('APPROVAL_EXPIRED', 'Подтверждение устарело; подтвердите план снова')
  }
  return validatedPlan.skill
}

function defaultRuntimeSnapshot() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    electron: process.versions.electron || null,
    packaged: false,
  }
}

function executeSkill(skillId, command, runtimeSnapshot) {
  if (skillId === 'workspace.status') {
    const electron = runtimeSnapshot.electron ? `Electron ${runtimeSnapshot.electron}` : 'CLI runtime'
    return {
      summary: 'Локальный runtime доступен; опасные эффекты заблокированы.',
      speech: 'Сентинел работает локально. Команды записи, сеть и shell заблокированы.',
      lines: [
        `Runtime: ${electron}`,
        `Platform: ${runtimeSnapshot.platform}/${runtimeSnapshot.arch}`,
        `Node: ${runtimeSnapshot.node}`,
        `Mode: ${runtimeSnapshot.packaged ? 'packaged' : 'development'}`,
        'Boundary: read-only, no shell, no network, no writes',
      ],
    }
  }
  if (skillId === 'memory.preview') {
    return {
      summary: 'Предпросмотр памяти создан без сохранения.',
      speech: 'Предпросмотр памяти готов. Ничего не сохранено.',
      lines: ['# Sentinel memory proposal', '', `- Command: ${command}`, '- Status: preview only', '- Persistence: blocked'],
    }
  }
  if (skillId === 'skills.status') {
    return {
      summary: 'Доступны три read-only навыка; изменяющие действия заблокированы.',
      speech: 'Разрешены только три навыка чтения. Изменения системы заблокированы.',
      lines: [
        ...listSafeOperatorSkills().map((skill) => `${skill.id}: allowed (read-only)`),
        'blocked: shell, write, network, install, deploy, secrets',
      ],
    }
  }
  fail('SKILL_BLOCKED', 'Навык не поддерживается')
}

export function createSafeOperatorExecutor(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : randomUUID
  const runtimeProvider = typeof options.runtimeProvider === 'function' ? options.runtimeProvider : defaultRuntimeSnapshot
  const transport = options.transport === 'electron-ipc' ? 'electron-ipc' : 'sentinel-voice-cli'
  const usedRequestIds = new Set()
  const recentExecutions = []

  return {
    execute(request) {
      const started = now()
      const nowMs = started.getTime()
      const skill = validateRequest(request, nowMs)
      if (usedRequestIds.has(request.requestId)) fail('REPLAY_BLOCKED', 'Этот requestId уже был выполнен')

      while (recentExecutions.length && nowMs - recentExecutions[0] >= 60_000) recentExecutions.shift()
      if (recentExecutions.length >= MAX_EXECUTIONS_PER_MINUTE) fail('RATE_LIMITED', 'Слишком много запусков; подождите минуту')
      usedRequestIds.add(request.requestId)
      recentExecutions.push(nowMs)

      const result = executeSkill(skill.id, request.plan.command, runtimeProvider())
      const completed = now()
      return {
        schemaVersion: SAFE_OPERATOR_RECEIPT_SCHEMA,
        receiptId: idFactory(),
        requestId: request.requestId,
        planId: request.plan.id,
        skillId: skill.id,
        status: 'succeeded',
        effect: 'read-only',
        transport,
        summary: result.summary,
        speech: result.speech,
        lines: result.lines.slice(0, 12).map((line) => String(line).slice(0, 500)),
        boundaries: [...BOUNDARIES],
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
      }
    },
  }
}
