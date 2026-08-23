import { useEffect, useMemo, useState } from 'react';
import {
  Ban,
  Check,
  CircleAlert,
  FileDiff,
  LoaderCircle,
  LockKeyhole,
  MicOff,
  ShieldCheck,
  Speaker,
  Square,
  TerminalSquare,
  Volume2,
} from 'lucide-react';
import { executeOperatorPlan, getOperatorTransport, type OperatorReceipt } from '../lib/operatorClient';
import { isTTSSupported, speak, stopSpeaking } from '../lib/voice';
import {
  buildVoicePlan,
  VOICE_SKILL_ALLOWLIST,
  type VoicePlan,
  type VoiceSkillId,
} from '../lib/voiceCommandPolicy';

type Stage = 'command' | 'plan' | 'approved' | 'executing' | 'receipt' | 'error';

const FLOW_STAGES: Stage[] = ['command', 'plan', 'approved', 'receipt'];

export function VoiceCommandRoom() {
  const [skillId, setSkillId] = useState<VoiceSkillId>('workspace.status');
  const [command, setCommand] = useState('Покажи безопасный статус рабочего места');
  const [plan, setPlan] = useState<VoicePlan | null>(null);
  const [stage, setStage] = useState<Stage>('command');
  const [killSwitch, setKillSwitch] = useState(true);
  const [approvedAt, setApprovedAt] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<OperatorReceipt | null>(null);
  const [error, setError] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const transport = getOperatorTransport();
  const selectedSkill = useMemo(
    () => VOICE_SKILL_ALLOWLIST.find((skill) => skill.id === skillId)!,
    [skillId],
  );

  useEffect(() => () => stopSpeaking(), []);

  const reset = () => {
    stopSpeaking();
    setPlan(null);
    setReceipt(null);
    setError('');
    setApprovedAt(null);
    setSpeaking(false);
    setKillSwitch(true);
    setStage('command');
  };

  const createPlan = () => {
    const next = buildVoicePlan(skillId, command);
    if (!next) return;
    setPlan(next);
    setReceipt(null);
    setError('');
    setApprovedAt(null);
    setKillSwitch(true);
    setStage('plan');
  };

  const approve = () => {
    setApprovedAt(new Date().toISOString());
    setKillSwitch(true);
    setStage('approved');
  };

  const execute = async () => {
    if (!plan || !approvedAt || killSwitch || stage !== 'approved') return;
    setError('');
    setStage('executing');
    try {
      const nextReceipt = await executeOperatorPlan(plan, approvedAt);
      setReceipt(nextReceipt);
      setKillSwitch(true);
      setStage('receipt');
    } catch (executionError) {
      setError(executionError instanceof Error ? executionError.message : 'Safe operator failed');
      setKillSwitch(true);
      setStage('error');
    }
  };

  const speakSummary = async () => {
    if (!receipt || speaking || !isTTSSupported()) return;
    setSpeaking(true);
    try {
      await speak(receipt.speech);
    } finally {
      setSpeaking(false);
    }
  };

  const currentStep = stage === 'executing' || stage === 'error'
    ? 2
    : Math.max(0, FLOW_STAGES.indexOf(stage));

  return (
    <section className="voice-room" aria-labelledby="voice-command-title">
      <header className="voice-room__header">
        <div>
          <p className="voice-room__eyebrow">Sentinel local operator · first working slice</p>
          <h1 id="voice-command-title">Voice Command Room</h1>
          <p>Один видимый read-only handler: plan → approval → STOP release → receipt → ручное озвучивание.</p>
        </div>
        <button
          className={`kill-switch ${killSwitch ? 'is-on' : ''}`}
          type="button"
          aria-pressed={killSwitch}
          disabled={stage !== 'approved'}
          onClick={() => setKillSwitch((value) => !value)}
        >
          <Ban size={16} />
          <span>
            <strong>{killSwitch ? 'STOP включён' : 'Разрешён один запуск'}</strong>
            <small>{stage === 'approved' ? 'Нажмите, чтобы изменить' : 'Сначала подтвердите план'}</small>
          </span>
        </button>
      </header>

      <div className="voice-hud" aria-label="Состояние operator-контура">
        <HudState icon={<MicOff size={15} />} label="Микрофон" value="CLI PTT отдельно" tone="safe" />
        <HudState icon={<Speaker size={15} />} label="TTS" value={isTTSSupported() ? 'Ручной запуск' : 'Недоступен'} tone="safe" />
        <HudState icon={<LockKeyhole size={15} />} label="Контур" value={transport === 'electron-ipc' ? 'Desktop IPC' : 'Browser preview'} tone={transport === 'electron-ipc' ? 'live' : 'warn'} />
        <HudState icon={<ShieldCheck size={15} />} label="Эффект" value="Read-only" tone="live" />
      </div>

      <div className="voice-room__grid">
        <aside className="skill-panel" aria-labelledby="skill-allowlist-title">
          <div className="panel-heading">
            <div><span>Allowlist</span><h2 id="skill-allowlist-title">Разрешённые навыки</h2></div>
            <strong>{VOICE_SKILL_ALLOWLIST.length}</strong>
          </div>
          {VOICE_SKILL_ALLOWLIST.map((skill) => (
            <button
              key={skill.id}
              type="button"
              className={skill.id === skillId ? 'is-selected' : ''}
              aria-pressed={skill.id === skillId}
              onClick={() => {
                setSkillId(skill.id);
                reset();
              }}
            >
              <Check size={13} />
              <span><strong>{skill.label}</strong><small>{skill.description}</small></span>
            </button>
          ))}
          <div className="blocked-skills">
            <strong>Заблокировано</strong>
            <span>shell · write · network · install · deploy · secrets</span>
          </div>
        </aside>

        <main className="command-flow" aria-busy={stage === 'executing'}>
          <div className="flow-steps" aria-label="Этапы команды">
            {['Команда', 'План', 'Approval', 'Receipt'].map((label, index) => (
              <span key={label} data-state={index < currentStep ? 'done' : index === currentStep ? 'current' : 'waiting'}>
                <i>{index < currentStep ? '✓' : index + 1}</i>{label}
              </span>
            ))}
          </div>

          <label className="command-field">
            <span>Команда</span>
            <textarea
              value={command}
              maxLength={500}
              disabled={stage === 'executing'}
              onChange={(event) => {
                setCommand(event.target.value);
                reset();
              }}
            />
            <small>{command.length}/500 · команда остаётся локальной</small>
          </label>
          <div className="command-meta">
            <span><TerminalSquare size={13} /> {selectedSkill.id}</span>
            <span><LockKeyhole size={13} /> exact contract · one-shot</span>
          </div>

          {plan && (
            <div className="plan-diff">
              <section>
                <p>План</p>
                <ol>{plan.steps.map((step) => <li key={step}>{step}</li>)}</ol>
              </section>
              <section>
                <p><FileDiff size={13} /> Diff до запуска</p>
                <ul>{plan.diff.map((line) => <li key={line}>{line}</li>)}</ul>
              </section>
            </div>
          )}

          {stage === 'executing' && (
            <section className="execution-state" role="status" aria-live="polite">
              <LoaderCircle size={17} aria-hidden="true" />
              <div><strong>Выполняется один handler</strong><span>STOP включится автоматически после receipt.</span></div>
            </section>
          )}

          {stage === 'error' && (
            <section className="execution-state is-error" role="alert">
              <CircleAlert size={17} aria-hidden="true" />
              <div><strong>Выполнение заблокировано</strong><span>{error}</span></div>
            </section>
          )}

          {receipt && (
            <section className="receipt" aria-live="polite">
              <div className="receipt__heading">
                <div><p>Receipt · {receipt.transport}</p><strong>{receipt.summary}</strong></div>
                <span>{receipt.receiptId.slice(0, 8)}</span>
              </div>
              <pre>{receipt.lines.join('\n')}</pre>
              <small>{receipt.boundaries.join(' · ')}</small>
              <div className="receipt__actions">
                <button type="button" disabled={!isTTSSupported() || speaking} onClick={speakSummary}>
                  <Volume2 size={14} />{speaking ? 'Озвучиваю…' : 'Озвучить итог'}
                </button>
                <button type="button" disabled={!speaking} onClick={() => { stopSpeaking(); setSpeaking(false); }}>
                  <Square size={12} />Стоп
                </button>
              </div>
            </section>
          )}

          <footer className="command-actions">
            {stage === 'command' && (
              <button type="button" className="primary-action" disabled={!command.trim()} onClick={createPlan}>
                Собрать план и diff
              </button>
            )}
            {stage === 'plan' && (
              <button type="button" className="primary-action" onClick={approve}>Подтвердить read-only план</button>
            )}
            {stage === 'approved' && (
              <button type="button" className="primary-action" disabled={killSwitch} onClick={execute}>
                {killSwitch ? 'Сначала разрешите один запуск' : transport === 'electron-ipc' ? 'Выполнить локально' : 'Запустить preview'}
              </button>
            )}
            {stage === 'executing' && <button type="button" className="primary-action" disabled>Выполняется…</button>}
            {stage === 'error' && <button type="button" className="primary-action" onClick={() => setStage('plan')}>Вернуться к плану</button>}
            {stage === 'receipt' && <button type="button" className="primary-action" onClick={reset}>Новая команда</button>}
            <p>{killSwitch ? 'Kill switch блокирует execute.' : 'Разрешение сгорит после одного receipt.'}</p>
          </footer>
        </main>
      </div>
    </section>
  );
}

function HudState({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: 'safe' | 'warn' | 'live';
}) {
  return <div className="hud-state" data-tone={tone}>{icon}<span><small>{label}</small><strong>{value}</strong></span></div>;
}
