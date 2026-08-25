import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, RotateCcw, ShieldCheck, Square, Volume2 } from 'lucide-react';
import { sendMessage, type Message, VOICE_MODEL_ID, warmVoiceModel } from '../lib/ai';
import { isLocalSTTSupported, isTTSSupported, listenOnceLocal, speak, stopSpeaking } from '../lib/voice';
import { type ContactTurn, ULTRON_PRESENCE_COPY, type UltronPresenceState } from '../lib/ultronPresence';
import { UltronAvatar } from './UltronAvatar';

const VOICE_SYSTEM_PROMPT = [
  'Ты Альтрон, локальный голосовой ассистент Eclipse Forge.',
  'Начинай сразу с прямого ответа. Отвечай по-русски естественно и кратко: одно или два коротких предложения.',
  'Не используй Markdown без прямой просьбы пользователя.',
  'Не утверждай, что выполнил действие, если нет проверяемого receipt.',
].join(' ');

interface UltronVoiceConversationProps {
  messages: Message[];
  onMessagesChange: (messages: Message[]) => void;
  externalTurn?: ContactTurn | null;
  onExternalTurnApplied: () => void;
  presence: UltronPresenceState;
  onPresenceChange: (state: UltronPresenceState) => void;
  motionEnabled: boolean;
}

export function UltronVoiceConversation({
  messages,
  onMessagesChange,
  externalTurn,
  onExternalTurnApplied,
  presence,
  onPresenceChange,
  motionEnabled,
}: UltronVoiceConversationProps) {
  const [capturing, setCapturing] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const turnSequenceRef = useRef(0);
  const appliedTurnRef = useRef<number | null>(null);
  const localVoiceAvailable = isLocalSTTSupported();
  const ttsAvailable = isTTSSupported();
  const presenceCopy = ULTRON_PRESENCE_COPY[presence];
  const busy = capturing || streaming || speaking;

  const lastQuestion = useMemo(
    () => [...messages].reverse().find((message) => message.role === 'user')?.content || '',
    [messages],
  );
  const lastAnswer = useMemo(
    () => [...messages].reverse().find((message) => message.role === 'assistant' && message.content.trim())?.content || '',
    [messages],
  );

  const stopTurn = useCallback(() => {
    turnSequenceRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    stopSpeaking();
    setStreaming(false);
    setSpeaking(false);
    onPresenceChange('idle');
  }, [onPresenceChange]);

  const respondTo = useCallback(async (transcript: string) => {
    const text = transcript.trim();
    if (!text || streaming || speaking) return;

    const turnId = ++turnSequenceRef.current;
    const userMessage: Message = { role: 'user', content: text };
    const modelMessages = [...messages.slice(-8), userMessage];
    const assistantMessage: Message = { role: 'assistant', content: '' };
    onMessagesChange([...modelMessages, assistantMessage]);
    setError('');
    setStreaming(true);
    onPresenceChange('thinking');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await sendMessage(
        modelMessages,
        (chunk) => {
          assistantMessage.content += chunk;
          onMessagesChange([...modelMessages, { ...assistantMessage }]);
        },
        controller.signal,
        VOICE_MODEL_ID,
        VOICE_SYSTEM_PROMPT,
        { maxTokens: 160, reasoningEffort: 'none' },
      );

      if (!assistantMessage.content.trim()) throw new Error('Локальная модель не вернула ответ.');
      if (turnSequenceRef.current !== turnId) return;

      setStreaming(false);
      setSpeaking(true);
      onPresenceChange('speaking');
      await speak(assistantMessage.content);
      setSpeaking(false);
      if (turnSequenceRef.current === turnId) onPresenceChange('success');
    } catch (turnError: unknown) {
      const errorName = turnError instanceof Error ? turnError.name : '';
      if (errorName !== 'AbortError') {
        const message = turnError instanceof Error ? turnError.message : 'Не удалось получить ответ.';
        setError(message.includes('fetch') || message.includes('Ollama')
          ? 'Быстрая локальная модель Qwen 3 8B недоступна. Проверьте Ollama на 127.0.0.1:11434.'
          : message);
        onPresenceChange('error');
      }
    } finally {
      if (turnSequenceRef.current === turnId) {
        setStreaming(false);
        setSpeaking(false);
        abortRef.current = null;
      }
    }
  }, [messages, onMessagesChange, onPresenceChange, speaking, streaming]);

  const startVoiceTurn = async () => {
    if (!localVoiceAvailable || busy) return;
    stopSpeaking();
    void warmVoiceModel();
    setError('');
    setCapturing(true);
    onPresenceChange('listening');

    try {
      const result = await listenOnceLocal();
      if (!result.ok) {
        setError(result.error.message);
        onPresenceChange('error');
        return;
      }
      setCapturing(false);
      await respondTo(result.text);
    } catch {
      setError('Не удалось запустить локальное распознавание речи.');
      onPresenceChange('error');
    } finally {
      setCapturing(false);
    }
  };

  const repeatAnswer = async () => {
    if (!lastAnswer || busy || !ttsAvailable) return;
    setSpeaking(true);
    onPresenceChange('speaking');
    try {
      await speak(lastAnswer);
      onPresenceChange('success');
    } finally {
      setSpeaking(false);
    }
  };

  useEffect(() => {
    if (!externalTurn || externalTurn.mode !== 'voice' || appliedTurnRef.current === externalTurn.id) return;
    appliedTurnRef.current = externalTurn.id;
    onExternalTurnApplied();
    void respondTo(externalTurn.text);
  }, [externalTurn, onExternalTurnApplied, respondTo]);

  useEffect(() => () => {
    abortRef.current?.abort();
    stopSpeaking();
    onPresenceChange('idle');
  }, [onPresenceChange]);

  return (
    <section className="ultron-voice" data-motion={motionEnabled ? 'on' : 'off'} data-state={presence} aria-labelledby="ultron-voice-title">
      <div className="ultron-voice__ambient" aria-hidden="true" />
      <header className="ultron-voice__header">
        <p>Eclipse Forge · local voice</p>
        <h1 id="ultron-voice-title">Альтрон на связи</h1>
        <span><ShieldCheck size={13} aria-hidden="true" /> Микрофон включается только после нажатия</span>
      </header>

      <div className="ultron-voice__stage" role="status" aria-live="polite" aria-atomic="true">
        <UltronAvatar presence={presence} size="stage" motionEnabled={motionEnabled} />
        <div className="ultron-voice__presence">
          <strong>{presenceCopy.label}</strong>
          <span>{presence === 'idle' && !lastAnswer ? 'Нажмите кнопку и говорите' : presenceCopy.detail}</span>
        </div>

        <button
          type="button"
          className={`ultron-voice__primary ${busy ? 'is-active' : ''}`}
          disabled={capturing}
          onClick={streaming || speaking ? stopTurn : startVoiceTurn}
        >
          {streaming || speaking ? <Square size={20} aria-hidden="true" /> : <Mic size={22} aria-hidden="true" />}
          <span>
            <strong>{capturing ? 'Слушаю…' : streaming ? 'Остановить ответ' : speaking ? 'Остановить голос' : 'Говорить с Альтроном'}</strong>
            <small>{capturing ? 'Скажите фразу обычным голосом' : streaming ? 'Модель формирует ответ' : speaking ? 'Озвучивание можно прервать' : 'Одна реплика на одно нажатие'}</small>
          </span>
        </button>
      </div>

      <div className="ultron-voice__dialog" aria-label="Последний голосовой обмен">
        <section data-speaker="user">
          <span>Вы сказали</span>
          <p>{lastQuestion || 'Здесь появится распознанная фраза.'}</p>
        </section>
        <section data-speaker="ultron" aria-busy={streaming}>
          <span>Альтрон</span>
          {streaming && !lastAnswer ? <div className="ultron-voice__thinking" aria-label="Альтрон формирует ответ"><i /><i /><i /></div> : <p>{lastAnswer || 'Ответ появится здесь и прозвучит вслух.'}</p>}
          {lastAnswer && !busy && (
            <button type="button" disabled={!ttsAvailable} onClick={repeatAnswer}>
              <RotateCcw size={13} aria-hidden="true" /> Повторить ответ
            </button>
          )}
        </section>
      </div>

      {error && <p className="ultron-voice__error" role="alert">{error}</p>}

      <footer className="ultron-voice__footer">
        <span><Volume2 size={13} aria-hidden="true" /> Qwen 3 8B · быстрый локальный профиль</span>
        <span>Whisper offline · мужской голос и скорость настраиваются · без фоновой записи</span>
      </footer>
    </section>
  );
}
