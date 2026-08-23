import { executeReadOnlyPlan, type VoicePlan, type VoiceSkillId } from './voiceCommandPolicy';

export type OperatorTransport = 'electron-ipc' | 'browser-preview';

export type OperatorReceipt = {
  schemaVersion: 'eclipse.sentinel.operator-receipt.v1';
  receiptId: string;
  requestId: string;
  planId: string;
  skillId: VoiceSkillId;
  status: 'succeeded';
  effect: 'read-only';
  transport: OperatorTransport | 'sentinel-voice-cli';
  summary: string;
  speech: string;
  lines: string[];
  boundaries: string[];
  startedAt: string;
  completedAt: string;
};

type OperatorRequest = {
  schemaVersion: 'eclipse.sentinel.operator-request.v1';
  requestId: string;
  plan: Omit<VoicePlan, 'skill'> & { effect: 'read-only' };
  approval: {
    confirmed: true;
    killSwitchReleased: true;
    confirmedAt: string;
  };
};

type OperatorResponse =
  | { ok: true; receipt: OperatorReceipt }
  | { ok: false; error: { code: string; message: string } };

declare global {
  interface Window {
    sentinelOperator?: {
      execute(request: OperatorRequest): Promise<OperatorResponse>;
    };
  }
}

function requestFromPlan(plan: VoicePlan, approvedAt: string): OperatorRequest {
  const { skill: _skill, ...serializablePlan } = plan;
  void _skill;
  return {
    schemaVersion: 'eclipse.sentinel.operator-request.v1',
    requestId: crypto.randomUUID(),
    plan: { ...serializablePlan, effect: 'read-only' },
    approval: {
      confirmed: true,
      killSwitchReleased: true,
      confirmedAt: approvedAt,
    },
  };
}

function browserPreview(plan: VoicePlan, request: OperatorRequest): OperatorReceipt {
  const startedAt = new Date().toISOString();
  const lines = executeReadOnlyPlan(plan);
  const completedAt = new Date().toISOString();
  return {
    schemaVersion: 'eclipse.sentinel.operator-receipt.v1',
    receiptId: crypto.randomUUID(),
    requestId: request.requestId,
    planId: plan.id,
    skillId: plan.skill.id,
    status: 'succeeded',
    effect: 'read-only',
    transport: 'browser-preview',
    summary: 'Browser preview завершён. Реальное выполнение доступно только в Sentinel Desktop.',
    speech: 'Предпросмотр готов. Для подтверждённого локального запуска откройте Sentinel Desktop.',
    lines,
    boundaries: ['read-only', 'no-shell', 'no-network', 'no-filesystem-write', 'no-secrets', 'preview-only'],
    startedAt,
    completedAt,
  };
}

export function getOperatorTransport(): OperatorTransport {
  return window.sentinelOperator ? 'electron-ipc' : 'browser-preview';
}

export async function executeOperatorPlan(plan: VoicePlan, approvedAt: string): Promise<OperatorReceipt> {
  const request = requestFromPlan(plan, approvedAt);
  if (!window.sentinelOperator) return browserPreview(plan, request);

  const response = await window.sentinelOperator.execute(request);
  if (!response.ok) throw new Error(response.error.code + ': ' + response.error.message);
  return response.receipt;
}
