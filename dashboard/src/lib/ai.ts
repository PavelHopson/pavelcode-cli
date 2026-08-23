export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  model: string;
  createdAt: number;
}

export const MODELS = [
  { id: 'qwen3:32b', name: 'Qwen 3 32B', desc: 'Мощная, локальная' },
  { id: 'qwen3:8b', name: 'Qwen 3 8B', desc: 'Быстрая, локальная' },
  { id: 'llama3:8b', name: 'Llama 3 8B', desc: 'Meta, локальная' },
  { id: 'deepseek-coder-v2:16b', name: 'DeepSeek Coder', desc: 'Для кода' },
] as const;

const OLLAMA_URL = 'http://localhost:11434/v1/chat/completions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function streamContent(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null;
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.delta)) return null;
  return typeof first.delta.content === 'string' ? first.delta.content : null;
}

function providerModelNames(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return [];
  return payload.models.flatMap((entry) => (
    isRecord(entry) && typeof entry.name === 'string' ? [entry.name] : []
  ));
}

export function getSelectedModel(): string {
  const saved = localStorage.getItem('sentinel-model');
  if (saved && MODELS.some(m => m.id === saved)) return saved;
  return MODELS[0].id;
}

export function setSelectedModel(id: string) {
  localStorage.setItem('sentinel-model', id);
}

// Chat history
export function loadSessions(): ChatSession[] {
  try {
    return JSON.parse(localStorage.getItem('sentinel-sessions') || '[]');
  } catch { return []; }
}

export function saveSessions(sessions: ChatSession[]) {
  localStorage.setItem('sentinel-sessions', JSON.stringify(sessions));
}

export function createSession(model: string): ChatSession {
  return {
    id: Date.now().toString(36),
    title: 'Новый чат',
    messages: [],
    model,
    createdAt: Date.now(),
  };
}

export async function sendMessage(
  messages: Message[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  model?: string,
): Promise<void> {
  const resp = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ollama',
    },
    body: JSON.stringify({
      model: model || getSelectedModel(),
      messages: [
        { role: 'system', content: 'Ты — Eclipse Sentinel, AI-оператор для разработки, автоматизации и кодинга. Отвечай чётко, по делу. Поддерживаешь русский и английский. Используй markdown для форматирования кода.' },
        ...messages,
      ],
      stream: true,
      max_tokens: 4096,
    }),
    signal,
  });

  if (!resp.ok) {
    void resp.body?.cancel();
    throw new Error(`Ollama request failed (${resp.status})`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;
      try {
        const json: unknown = JSON.parse(data);
        const delta = streamContent(json);
        if (delta) onChunk(delta);
      } catch {
        continue;
      }
    }
  }
}

export async function checkProviderStatus(model?: string): Promise<{
  provider: string; model: string; healthy: boolean; latency: number;
}> {
  const m = model || getSelectedModel();
  const start = performance.now();
  try {
    const resp = await fetch('http://localhost:11434/api/tags');
    if (!resp.ok) {
      return { provider: 'Ollama (локально)', model: m, healthy: false, latency: Math.round(performance.now() - start) };
    }
    const data: unknown = await resp.json();
    const models = providerModelNames(data);
    const hasModel = models.some((n: string) => n.startsWith(m.split(':')[0]));
    return {
      provider: 'Ollama (локально)',
      model: m,
      healthy: resp.ok && hasModel,
      latency: Math.round(performance.now() - start),
    };
  } catch {
    return { provider: 'Ollama (локально)', model: m, healthy: false, latency: -1 };
  }
}
