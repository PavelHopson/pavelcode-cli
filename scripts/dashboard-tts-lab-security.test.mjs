import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('experimental Qwen3-TTS adapter stays loopback-only, bounded and transcript-silent', async () => {
  const source = await readFile(new URL('./qwen3-tts-server.py', import.meta.url), 'utf8')

  assert.match(source, /HOST: Final = "127\.0\.0\.1"/)
  assert.match(source, /MAX_BODY_BYTES: Final = 8 \* 1024/)
  assert.match(source, /MAX_TEXT_CHARS: Final = 400/)
  assert.match(source, /_generation_lock = threading\.Lock\(\)/)
  assert.match(source, /ECLIPSE_QWEN_TTS_MODEL_DIR/)
  assert.match(source, /path\.name != MODEL_NAME/)
  assert.match(source, /def log_message\([\s\S]*?return/)
  assert.match(source, /if not _generation_lock\.acquire\(blocking=False\)/)
  assert.match(source, /Cache-Control", "no-store"/)
  assert.doesNotMatch(source, /0\.0\.0\.0|subprocess|os\.system|eval\(|exec\(/)
})
