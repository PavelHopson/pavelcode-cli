// Web Speech API — STT + TTS

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  results: { [index: number]: SpeechRecognitionResultLike };
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

export type LocalSpeechResult =
  | { ok: true; text: string; confidence: number | null }
  | { ok: false; error: { code: string; message: string } };

type UltronVoiceWindow = Window & {
  ultronVoice?: {
    listenOnce(): Promise<LocalSpeechResult>;
  };
};

export function isLocalSTTSupported(): boolean {
  return typeof (window as UltronVoiceWindow).ultronVoice?.listenOnce === 'function';
}

export async function listenOnceLocal(): Promise<LocalSpeechResult> {
  const bridge = (window as UltronVoiceWindow).ultronVoice;
  if (!bridge) {
    return {
      ok: false,
      error: { code: 'VOICE_DESKTOP_REQUIRED', message: 'Локальный микрофон доступен только в Eclipse Ultron Desktop.' },
    };
  }
  return bridge.listenOnce();
}

export function isSpeechSupported(): boolean {
  return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
}

export function isTTSSupported(): boolean {
  return 'speechSynthesis' in window;
}

export function createRecognition(
  onResult: (text: string) => void,
  onEnd: () => void,
  lang: string = 'ru-RU',
): SpeechRecognitionLike | null {
  const speechWindow = window as SpeechRecognitionWindow;
  const SR = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
  if (!SR) return null;

  const recognition = new SR();
  recognition.lang = lang;
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event: SpeechRecognitionEventLike) => {
    const text = event.results[0][0].transcript;
    onResult(text);
  };

  recognition.onend = onEnd;
  recognition.onerror = () => onEnd();

  return recognition;
}

let speechSequence = 0;
let activeSpeech: { id: number; resolve: () => void; timeoutId: number } | null = null;

const VOICE_PREFERENCES_KEY = 'ultron-voice-preferences-v1';
const DEFAULT_VOICE_RATE = 1.2;
const DEFAULT_VOICE_PITCH = 0.82;

export interface VoicePreferences {
  voiceName: string;
  rate: number;
  pitch: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function loadVoicePreferences(): VoicePreferences {
  const fallback: VoicePreferences = {
    voiceName: 'Microsoft Pavel',
    rate: DEFAULT_VOICE_RATE,
    pitch: DEFAULT_VOICE_PITCH,
  };

  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(VOICE_PREFERENCES_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const candidate = parsed as Partial<VoicePreferences>;
    return {
      voiceName: typeof candidate.voiceName === 'string' ? candidate.voiceName.slice(0, 120) : fallback.voiceName,
      rate: typeof candidate.rate === 'number' && Number.isFinite(candidate.rate)
        ? clamp(candidate.rate, 0.9, 1.4)
        : fallback.rate,
      pitch: typeof candidate.pitch === 'number' && Number.isFinite(candidate.pitch)
        ? clamp(candidate.pitch, 0.7, 1.05)
        : fallback.pitch,
    };
  } catch {
    return fallback;
  }
}

export function saveVoicePreferences(preferences: VoicePreferences): VoicePreferences {
  const normalized: VoicePreferences = {
    voiceName: preferences.voiceName.slice(0, 120),
    rate: clamp(preferences.rate, 0.9, 1.4),
    pitch: clamp(preferences.pitch, 0.7, 1.05),
  };
  localStorage.setItem(VOICE_PREFERENCES_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function getAvailableVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!isTTSSupported()) return [];
  const current = speechSynthesis.getVoices();
  if (current.length) return current;

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      speechSynthesis.removeEventListener('voiceschanged', finish);
      resolve(speechSynthesis.getVoices());
    };
    const timeoutId = window.setTimeout(finish, 900);
    speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
  });
}

function selectPreferredVoice(voices: SpeechSynthesisVoice[], voiceName: string, lang: string) {
  const exact = voices.find((voice) => voice.name.toLocaleLowerCase() === voiceName.toLocaleLowerCase());
  if (exact) return exact;

  const russian = voices.filter((voice) => voice.lang.toLocaleLowerCase().startsWith('ru'));
  return russian.find((voice) => /pavel|павел/i.test(voice.name))
    || russian.find((voice) => /dmitr|дмитр|maxim|максим/i.test(voice.name))
    || russian[0]
    || voices.find((voice) => voice.lang.toLocaleLowerCase().startsWith(lang.slice(0, 2).toLocaleLowerCase()))
    || null;
}

function finishActiveSpeech(id: number) {
  if (!activeSpeech || activeSpeech.id !== id) return;
  window.clearTimeout(activeSpeech.timeoutId);
  const resolve = activeSpeech.resolve;
  activeSpeech = null;
  resolve();
}

export async function speak(text: string, lang: string = 'ru-RU'): Promise<void> {
  if (!isTTSSupported()) return;

  stopSpeaking();

  // Clean markdown from text
  const clean = text
    .replace(/```[\s\S]*?```/g, 'блок кода')
    .replace(/`[^`]+`/g, '')
    .replace(/(?:[#*_~>()]|\[|\])/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();

  if (!clean) return;

  // Take first 500 chars for TTS
  const short = clean.length > 500 ? clean.slice(0, 500) + '...' : clean;
  const preferences = loadVoicePreferences();
  const voices = await getAvailableVoices();

  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(short);
    const speechId = ++speechSequence;
    utterance.lang = lang;
    utterance.rate = preferences.rate;
    utterance.pitch = preferences.pitch;
    utterance.volume = 0.96;

    // Chromium loads OneCore/SAPI voices asynchronously. Waiting briefly avoids
    // the unpredictable default voice on the first reply.
    const preferredVoice = selectPreferredVoice(voices, preferences.voiceName, lang);
    if (preferredVoice) utterance.voice = preferredVoice;

    const timeoutId = window.setTimeout(() => {
      speechSynthesis.cancel();
      finishActiveSpeech(speechId);
    }, 45_000);

    activeSpeech = { id: speechId, resolve, timeoutId };
    utterance.onend = () => finishActiveSpeech(speechId);
    utterance.onerror = () => finishActiveSpeech(speechId);
    try {
      speechSynthesis.speak(utterance);
    } catch {
      finishActiveSpeech(speechId);
    }
  });
}

export function stopSpeaking() {
  if (isTTSSupported()) speechSynthesis.cancel();
  if (activeSpeech) finishActiveSpeech(activeSpeech.id);
}
