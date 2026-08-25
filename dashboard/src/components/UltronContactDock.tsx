import { useEffect, useRef, useState } from 'react';
import { Command, MessageSquareText, Mic, Radio, ShieldCheck, X } from 'lucide-react';
import { isLocalSTTSupported, listenOnceLocal } from '../lib/voice';

const ULTRON_AVATAR_SRC = './brand/ultron-avatar.png';

interface UltronContactDockProps {
  surface: 'chat' | 'voice';
  onOpenChat: () => void;
  onOpenOperator: () => void;
  onTranscript: (text: string) => void;
}

type ContactState = 'idle' | 'listening' | 'success' | 'error';

export function UltronContactDock({ surface, onOpenChat, onOpenOperator, onTranscript }: UltronContactDockProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ContactState>('idle');
  const [message, setMessage] = useState('Готов к локальной голосовой команде');
  const panelRef = useRef<HTMLElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const voiceAvailable = isLocalSTTSupported();

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      launcherRef.current?.focus();
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!panelRef.current?.contains(target) && !launcherRef.current?.contains(target)) setOpen(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open]);

  const captureVoice = async () => {
    if (!voiceAvailable || state === 'listening') return;
    setState('listening');
    setMessage('Слушаю до 12 секунд…');

    try {
      const result = await listenOnceLocal();
      if (!result.ok) {
        setState('error');
        setMessage(result.error.message);
        return;
      }

      setState('success');
      setMessage('Речь распознана — текст готов к проверке');
      onTranscript(result.text);
      setOpen(false);
    } catch {
      setState('error');
      setMessage('Не удалось запустить локальное распознавание. Повторите попытку.');
    }
  };

  const openSurface = (nextSurface: 'chat' | 'voice') => {
    setOpen(false);
    if (nextSurface === 'chat') onOpenChat();
    else onOpenOperator();
  };

  return (
    <div className="ultron-contact" data-state={state}>
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
            <div className="ultron-avatar ultron-avatar--panel" aria-hidden="true">
              <img alt="" src={ULTRON_AVATAR_SRC} />
              <span />
            </div>
            <div>
              <p>Eclipse Forge · local-first</p>
              <h2>Альтрон на связи</h2>
            </div>
            <button type="button" aria-label="Закрыть связь с Альтроном" onClick={() => setOpen(false)}>
              <X size={15} aria-hidden="true" />
            </button>
          </header>

          <div className="ultron-contact__status" data-tone={state} role="status" aria-live="polite">
            <Radio size={14} aria-hidden="true" />
            <span>{message}</span>
          </div>

          <button
            type="button"
            className="ultron-contact__voice"
            disabled={!voiceAvailable || state === 'listening'}
            onClick={captureVoice}
          >
            <span className="ultron-contact__voice-icon"><Mic size={18} aria-hidden="true" /></span>
            <span>
              <strong>{state === 'listening' ? 'Слушаю…' : 'Сказать Альтрону'}</strong>
              <small>{voiceAvailable ? 'Текст появится в чате перед отправкой' : 'Доступно в desktop-приложении'}</small>
            </span>
          </button>

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

          <footer><ShieldCheck size={13} aria-hidden="true" /> Микрофон включается только по нажатию. Автоотправки нет.</footer>
        </section>
      )}

      <button
        type="button"
        aria-controls="ultron-contact-panel"
        aria-expanded={open}
        className="ultron-contact__launcher"
        onClick={() => setOpen((value) => !value)}
        ref={launcherRef}
      >
        <span className="ultron-avatar" aria-hidden="true">
          <img alt="" src={ULTRON_AVATAR_SRC} />
          <span />
        </span>
        <span className="ultron-contact__launcher-copy">
          <strong>Альтрон</strong>
          <small>{state === 'listening' ? 'Слушаю…' : 'Всегда на связи'}</small>
        </span>
        <Mic size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
