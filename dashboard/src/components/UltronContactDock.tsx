import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Command, MessageSquareText, Mic, Radio, ShieldCheck, Square, Type, X } from 'lucide-react';
import { isLocalSTTSupported, listenOnceLocal, stopSpeaking } from '../lib/voice';
import { ULTRON_PRESENCE_COPY, type UltronPresenceState } from '../lib/ultronPresence';
import { UltronAvatar } from './UltronAvatar';

interface UltronContactDockProps {
  surface: 'chat' | 'voice';
  presence: UltronPresenceState;
  motionEnabled: boolean;
  motionLocked: boolean;
  onOpenChat: () => void;
  onOpenOperator: () => void;
  onDraft: (text: string) => void;
  onVoiceTurn: (text: string) => void;
  onPresenceChange: (state: UltronPresenceState) => void;
  onMotionChange: () => void;
}

type CaptureMode = 'voice' | 'draft';

export function UltronContactDock({
  surface,
  presence,
  motionEnabled,
  motionLocked,
  onOpenChat,
  onOpenOperator,
  onDraft,
  onVoiceTurn,
  onPresenceChange,
  onMotionChange,
}: UltronContactDockProps) {
  const [open, setOpen] = useState(false);
  const [captureMode, setCaptureMode] = useState<CaptureMode | null>(null);
  const [voiceError, setVoiceError] = useState('');
  const panelRef = useRef<HTMLElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const restoreFocusOnCloseRef = useRef(false);
  const voiceAvailable = isLocalSTTSupported();
  const copy = ULTRON_PRESENCE_COPY[presence];
  const busy = presence === 'listening' || presence === 'thinking' || presence === 'speaking';
  const statusMessage = presence === 'error' && voiceError ? voiceError : copy.detail;

  const closePanel = useCallback((restoreFocus = true) => {
    restoreFocusOnCloseRef.current = restoreFocus;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (open || !restoreFocusOnCloseRef.current) return;
    restoreFocusOnCloseRef.current = false;
    const frameId = window.requestAnimationFrame(() => launcherRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closePanel();
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!panelRef.current?.contains(target) && !launcherRef.current?.contains(target)) closePanel(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [closePanel, open]);

  const captureVoice = async (mode: CaptureMode) => {
    if (!voiceAvailable || busy || captureMode) return;
    stopSpeaking();
    setVoiceError('');
    setCaptureMode(mode);
    onPresenceChange('listening');

    try {
      const result = await listenOnceLocal();
      if (!result.ok) {
        setVoiceError(result.error.message);
        onPresenceChange('error');
        return;
      }

      if (mode === 'voice') {
        onPresenceChange('thinking');
        onVoiceTurn(result.text);
      } else {
        onPresenceChange('success');
        onDraft(result.text);
        setOpen(false);
      }
    } catch {
      setVoiceError('Не удалось запустить локальное распознавание. Повторите попытку.');
      onPresenceChange('error');
    } finally {
      setCaptureMode(null);
    }
  };

  const openSurface = (nextSurface: 'chat' | 'voice') => {
    setOpen(false);
    if (nextSurface === 'chat') onOpenChat();
    else onOpenOperator();
  };

  const stopVoiceReply = () => {
    stopSpeaking();
    onPresenceChange('idle');
  };

  return (
    <div className="ultron-contact" data-motion={motionEnabled ? 'on' : 'off'} data-open={open ? 'true' : 'false'} data-state={presence}>
      {open && (
        <section
          aria-label="Связь с Альтроном"
          aria-modal="false"
          className="ultron-contact__panel"
          id="ultron-contact-panel"
          ref={panelRef}
          role="dialog"
        >
          <header className="ultron-contact__header">
            <UltronAvatar presence={presence} size="panel" motionEnabled={motionEnabled} />
            <div>
              <p>Eclipse Forge · local-first</p>
              <h2>Альтрон на связи</h2>
            </div>
            <button type="button" aria-label="Закрыть связь с Альтроном" onClick={() => closePanel()}>
              <X size={15} aria-hidden="true" />
            </button>
          </header>

          <div className="ultron-contact__status" data-tone={presence} role="status" aria-live="polite">
            <Radio size={14} aria-hidden="true" />
            <span><strong>{copy.label}</strong>{statusMessage}</span>
          </div>

          <button
            type="button"
            className="ultron-contact__voice"
            disabled={!voiceAvailable || busy || captureMode !== null}
            onClick={() => captureVoice('voice')}
          >
            <span className="ultron-contact__voice-icon"><Mic size={18} aria-hidden="true" /></span>
            <span>
              <strong>{captureMode === 'voice' ? 'Слушаю…' : presence === 'thinking' ? 'Готовлю ответ…' : presence === 'speaking' ? 'Альтрон отвечает…' : 'Спросить голосом'}</strong>
              <small>{voiceAvailable ? 'Фраза отправится в Chat, ответ прозвучит вслух' : 'Доступно в desktop-приложении'}</small>
            </span>
          </button>

          {presence === 'speaking' ? (
            <button type="button" className="ultron-contact__secondary" onClick={stopVoiceReply}>
              <Square size={13} aria-hidden="true" /> Остановить голос
            </button>
          ) : (
            <button
              type="button"
              className="ultron-contact__secondary"
              disabled={!voiceAvailable || busy || captureMode !== null}
              onClick={() => captureVoice('draft')}
            >
              <Type size={13} aria-hidden="true" />
              {captureMode === 'draft' ? 'Слушаю…' : 'Только продиктовать'}
            </button>
          )}

          <div className="ultron-contact__routes" aria-label="Рабочие поверхности Альтрона">
            <button type="button" aria-current={surface === 'chat' ? 'page' : undefined} onClick={() => openSurface('chat')}>
              <MessageSquareText size={15} aria-hidden="true" />
              <span><strong>Открыть чат</strong><small>Обсудить задачу</small></span>
            </button>
            <button type="button" aria-current={surface === 'voice' ? 'page' : undefined} onClick={() => openSurface('voice')}>
              <Command size={15} aria-hidden="true" />
              <span><strong>Ultron Core</strong><small>План · approval · receipt</small></span>
            </button>
          </div>

          <button
            type="button"
            className="ultron-contact__motion"
            aria-pressed={motionEnabled}
            disabled={motionLocked}
            onClick={onMotionChange}
          >
            <Activity size={13} aria-hidden="true" />
            <span>{motionLocked ? 'Анимация отключена в Windows' : motionEnabled ? 'Живой режим включён' : 'Живой режим выключен'}</span>
          </button>

          <footer><ShieldCheck size={13} aria-hidden="true" /> Микрофон работает только после клика. Каждая новая реплика требует отдельного нажатия.</footer>
        </section>
      )}

      <button
        type="button"
        aria-controls="ultron-contact-panel"
        aria-expanded={open}
        aria-label={`Альтрон: ${copy.label}. Открыть голосовую связь`}
        className="ultron-contact__launcher"
        onClick={() => setOpen((value) => !value)}
        ref={launcherRef}
      >
        <UltronAvatar presence={presence} size="launcher" motionEnabled={motionEnabled} />
        <span className="ultron-contact__launcher-copy">
          <strong>Альтрон · {copy.label}</strong>
          <small>{copy.detail}</small>
        </span>
        <Mic size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
