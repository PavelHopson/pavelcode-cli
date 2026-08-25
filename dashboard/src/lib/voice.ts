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

function finishActiveSpeech(id: number) {
  if (!activeSpeech || activeSpeech.id !== id) return;
  window.clearTimeout(activeSpeech.timeoutId);
  const resolve = activeSpeech.resolve;
  activeSpeech = null;
  resolve();
}

export function speak(text: string, lang: string = 'ru-RU'): Promise<void> {
  return new Promise((resolve) => {
    if (!isTTSSupported()) { resolve(); return; }

    stopSpeaking();

    // Clean markdown from text
    const clean = text
      .replace(/```[\s\S]*?```/g, 'блок кода')
      .replace(/`[^`]+`/g, '')
      .replace(/(?:[#*_~>()]|\[|\])/g, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .trim();

    if (!clean) { resolve(); return; }

    // Take first 500 chars for TTS
    const short = clean.length > 500 ? clean.slice(0, 500) + '...' : clean;

    const utterance = new SpeechSynthesisUtterance(short);
    const speechId = ++speechSequence;
    utterance.lang = lang;
    utterance.rate = 1.05;
    utterance.pitch = 0.95;
    utterance.volume = 0.9;

    // Try to find a good Russian voice
    const voices = speechSynthesis.getVoices();
    const ruVoice = voices.find(v => v.lang.startsWith('ru') && v.name.includes('Google'))
      || voices.find(v => v.lang.startsWith('ru'))
      || voices.find(v => v.lang.startsWith('en') && v.name.includes('Google'));
    if (ruVoice) utterance.voice = ruVoice;

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
