import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Radio, RotateCcw, ShieldCheck, Square, Volume2 } from 'lucide-react';
import { sendMessage, type Message, VOICE_MODEL_ID, warmVoiceModel } from '../lib/ai';
import {
  isLiveSTTSupported,
  isLocalSTTSupported,
  isTTSSupported,
  listenOnceLocal,
  pauseLiveLocal,
  resumeLiveLocal,
  speak,
  startLiveLocal,
  stopLiveLocal,
  stopSpeaking,
  subscribeLiveVoice,
  type LiveVoiceStateName,
} from '../lib/voice';
import { type ContactTurn, ULTRON_PRESENCE_COPY, type UltronPresenceState } from '../lib/ultronPresence';
import { UltronAvatar } from './UltronAvatar';

const VOICE_SYSTEM_PROMPT = [
  'Ты Альтрон, локальный голосовой ассистент Eclipse Forge.',
  'Начинай сразу с прямого ответа. Отвечай по-русски естественно и кратко: одно или два коротких предложения.',
  'Говори живо, без канцелярита, повторов вопроса и вводных фраз.',
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
  const [liveState, setLiveState] = useState<LiveVoiceStateName>('idle');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const turnSequenceRef = useRef(0);
  const appliedTurnRef = useRef<number | null>(null);
  const liveRequestedRef = useRef(false);
  const busyRef = useRef(false);
  const messagesRef = useRef(messages);
  const respondRef = useRef<(text: string) => Promise<void>>(async () => {});
  const localVoiceAvailable = isLocalSTTSupported();
  const liveVoiceAvailable = isLiveSTTSupported();
  const ttsAvailable = isTTSSupported();
  const presenceCopy = ULTRON_PRESENCE_COPY[presence];
  const busy = capturing || streaming || speaking;
  const liveActive = liveState === 'starting' || liveState === 'listening' || liveState === 'paused';

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const lastQuestion = useMemo(
    () => [...messages].reverse().find((message) => message.role === 'user')?.content || '',
    [messages],
  );
  const lastAnswer = useMemo(
    () => [...messages].reverse().find((message) => message.role === 'assistant' && message.content.trim())?.content || '',
    [messages],
  );

  const resumeLiveAfterTurn = useCallback(async () => {
    if (!liveRequestedRef.current) return;
    const result = await resumeLiveLocal();
    if (!result.ok) {
      liveRequestedRef.current = false;
      setLiveState('error');
      setError(result.error?.message || 'Не удалось вернуть живой микрофон в режим прослушивания.');
      onPresenceChange('error');
    }
  }, [onPresenceChange]);

  const stopTurn = useCallback(() => {
    turnSequenceRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    stopSpeaking();
    busyRef.current = false;
    setCapturing(false);
    setStreaming(false);
    setSpeaking(false);
    if (liveRequestedRef.current) void resumeLiveAfterTurn();
    else onPresenceChange('idle');
  }, [onPresenceChange, resumeLiveAfterTurn]);

  const respondTo = useCallback(async (transcript: string) => {
    const text = transcript.trim();
    if (!text || busyRef.current) return;

    busyRef.current = true;
    if (liveRequestedRef.current) await pauseLiveLocal();
    stopSpeaking();

    const turnId = ++turnSequenceRef.current;
    const userMessage: Message = { role: 'user', content: text };
    const modelMessages = [...messagesRef.current.slice(-8), userMessage];
    const assistantMessage: Message = { role: 'assistant', content: '' };
    onMessagesChange([...modelMessages, assistantMessage]);
    setError('');
    setStreaming(true);
    onPresenceChange('thinking');

    const controller = new AbortController();
    abortRef.current = controller;
    let spokenThrough = 0;
    let queuedSpeech = false;
    let speechQueue = Promise.resolve();

    const queueSpeech = (sentence: string) => {
      const clean = sentence.trim();
      if (!clean || turnSequenceRef.current !== turnId) return;
      queuedSpeech = true;
      setSpeaking(true);
      onPresenceChange('speaking');
      speechQueue = speechQueue.then(async () => {
        if (turnSequenceRef.current === turnId) await speak(clean);
      });
    };

    const queueCompletedSentences = () => {
      let remainder = assistantMessage.content.slice(spokenThrough);
      let boundary = /[.!?]+(?:\s|$)/.exec(remainder);
      while (boundary) {
        const length = boundary.index + boundary[0].length;
        queueSpeech(remainder.slice(0, length));
        spokenThrough += length;
        remainder = assistantMessage.content.slice(spokenThrough);
        boundary = /[.!?]+(?:\s|$)/.exec(remainder);
      }
    };

    try {
      await sendMessage(
        modelMessages,
        (chunk) => {
          assistantMessage.content += chunk;
          onMessagesChange([...modelMessages, { ...assistantMessage }]);
          queueCompletedSentences();
        },
        controller.signal,
        VOICE_MODEL_ID,
        VOICE_SYSTEM_PROMPT,
        { maxTokens: 120, reasoningEffort: 'none' },
      );

      if (!assistantMessage.content.trim()) throw new Error('Локальная модель не вернула ответ.');
      if (turnSequenceRef.current !== turnId) return;

      setStreaming(false);
      const tail = assistantMessage.content.slice(spokenThrough).trim();
      if (tail) queueSpeech(tail);
      if (queuedSpeech) await speechQueue;
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
        busyRef.current = false;
        await resumeLiveAfterTurn();
      }
    }
  }, [onMessagesChange, onPresenceChange, resumeLiveAfterTurn]);

  useEffect(() => {
    respondRef.current = respondTo;
  }, [respondTo]);

  useEffect(() => subscribeLiveVoice(
    ({ state, detail }) => {
      setLiveState(state);
      if (state === 'listening' && !busyRef.current) onPresenceChange('listening');
      if (state === 'idle') {
        liveRequestedRef.current = false;
        if (!busyRef.current) onPresenceChange('idle');
      }
      if (state === 'error') {
        liveRequestedRef.current = false;
        setError(detail || 'Живой микрофон остановлен из-за ошибки.');
        onPresenceChange('error');
      }
    },
    ({ text }) => {
      if (liveRequestedRef.current && !busyRef.current) void respondRef.current(text);
    },
  ), [onPresenceChange]);

  const startLiveConversation = async () => {
    if (!liveVoiceAvailable || busyRef.current) return;
    void warmVoiceModel();
    setError('');
    liveRequestedRef.current = true;
    setLiveState('starting');
    onPresenceChange('listening');
    const result = await startLiveLocal();
    if (!result.ok) {
      liveRequestedRef.current = false;
      setLiveState('error');
      setError(result.error?.message || 'Не удалось включить живой разговор.');
      onPresenceChange('error');
    }
  };

  const stopLiveConversation = async () => {
    liveRequestedRef.current = false;
    stopTurn();
    await stopLiveLocal();
    setLiveState('idle');
    onPresenceChange('idle');
  };

  const startVoiceTurn = async () => {
    if (!localVoiceAvailable || liveActive || busyRef.current) return;
    busyRef.current = true;
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
      busyRef.current = false;
      await respondTo(result.text);
    } catch {
      setError('Не удалось запустить локальное распознавание речи.');
      onPresenceChange('error');
    } finally {
      setCapturing(false);
      if (!streaming && !speaking) busyRef.current = false;
    }
  };

  const repeatAnswer = async () => {
    if (!lastAnswer || busyRef.current || !ttsAvailable) return;
    busyRef.current = true;
    if (liveRequestedRef.current) await pauseLiveLocal();
    setSpeaking(true);
    onPresenceChange('speaking');
    try {
      await speak(lastAnswer);
      onPresenceChange('success');
    } finally {
      busyRef.current = false;
      setSpeaking(false);
      await resumeLiveAfterTurn();
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
    busyRef.current = false;
    onPresenceChange('idle');
  }, [onPresenceChange]);

  const primaryAction = liveActive
    ? stopLiveConversation
    : busy
      ? () => Promise.resolve(stopTurn())
      : startLiveConversation;

  return (
    <section className="ultron-voice" data-motion={motionEnabled ? 'on' : 'off'} data-state={presence} data-live={liveActive ? 'on' : 'off'} aria-labelledby="ultron-voice-title">
      <div className="ultron-voice__ambient" aria-hidden="true" />
      <header className="ultron-voice__header">
        <p>Eclipse Forge · local voice</p>
        <h1 id="ultron-voice-title">Альтрон на связи</h1>
        <span>
          <ShieldCheck size={13} aria-hidden="true" />
          {liveActive ? 'Живой микрофон включён · аудио не сохраняется' : 'Микрофон включается только по вашей команде'}
        </span>
      </header>

      <div className="ultron-voice__stage" role="status" aria-live="polite" aria-atomic="true">
        <UltronAvatar presence={presence} size="stage" motionEnabled={motionEnabled} />
        <div className="ultron-voice__presence">
          <strong>{liveState === 'starting' ? 'ЗАГРУЖАЮ СЛУХ' : presenceCopy.label}</strong>
          <span>{liveState === 'listening' && !busy ? 'Говорите — Альтрон ответит сам' : presenceCopy.detail}</span>
        </div>

        <button
          type="button"
          className={`ultron-voice__primary ${busy || liveActive ? 'is-active' : ''}`}
          disabled={!liveVoiceAvailable && !busy}
          onClick={() => void primaryAction()}
          aria-pressed={liveActive}
        >
          {liveActive || busy ? <Square size={20} aria-hidden="true" /> : <Radio size={22} aria-hidden="true" />}
          <span>
            <strong>{liveActive ? 'Остановить живой режим' : busy ? 'Остановить ответ' : 'Включить живой разговор'}</strong>
            <small>{liveActive ? 'Альтрон слышит новые реплики без повторного нажатия' : busy ? 'Текущую реплику можно прервать' : 'Один раз включите — дальше говорите свободно'}</small>
          </span>
        </button>

        <button
          type="button"
          className="ultron-voice__single"
          disabled={!localVoiceAvailable || liveActive || busy}
          onClick={() => void startVoiceTurn()}
        >
          <Mic size={15} aria-hidden="true" />
          {capturing ? 'Слушаю одну фразу…' : 'Сказать одну фразу'}
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
            <button type="button" disabled={!ttsAvailable} onClick={() => void repeatAnswer()}>
              <RotateCcw size={13} aria-hidden="true" /> Повторить ответ
            </button>
          )}
        </section>
      </div>

      {error && <p className="ultron-voice__error" role="alert">{error}</p>}

      <footer className="ultron-voice__footer">
        <span><Volume2 size={13} aria-hidden="true" /> Qwen 3 8B · ответ начинает звучать до завершения генерации</span>
        <span>Whisper offline · локально · без сохранения аудио и фоновых автозапусков</span>
      </footer>
    </section>
  );
}
