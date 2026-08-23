import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const UTF8_FILES = [
  '../dashboard/index.html',
  '../dashboard/electron/main.cjs',
  '../dashboard/electron/sentinel-safe-operator.mjs',
  '../dashboard/src/components/VoiceCommandRoomV2.tsx',
  '../dashboard/src/lib/operatorClient.ts',
  '../dashboard/src/lib/voiceCommandPolicy.ts',
  '../docs/sentinel-engineering-log.md',
  '../docs/sentinel-eclipse-chat-contract-sync.md',
  '../docs/sentinel-office-bridge.md',
  '../docs/sentinel-roadmap.md',
  '../docs/sentinel-safe-operator.md',
  '../docs/contracts/eclipse-chat-office-ingest-v1.md',
  '../docs/contracts/sentinel-office-event-v1.schema.json',
  '../docs/contracts/eclipse-chat-office-event-v1.schema.json',
  '../office/eclipse-chat-office-adapter.mjs',
  '../office/eclipse-chat-office-ingest-client.mjs',
  '../office/sentinel-office-bridge.mjs',
  '../office/sentinel-office-lifecycle.mjs',
  './eclipse-chat-office-adapter.test.mjs',
  './eclipse-chat-office-ingest-client.test.mjs',
  './eclipse-chat-office-schema.test.mjs',
  './sentinel-office-bridge.test.mjs',
  './sentinel-office-lifecycle.test.mjs',
  './sentinel-office-packaging.test.mjs',
  './sentinel-office-schema.test.mjs',
]

const MOJIBAKE_MARKERS = [
  '\u00d0',
  '\u00d1',
  '\u00e2\u20ac',
  '\u00ef\u00bb\u00bf',
  '\u0420\u045f\u0421\u0402',
  '\u0420\u00b5\u0420',
  '\u0420\u00b0\u0420',
  '\u0421\u201a\u0420',
]

async function decodeStrict(relativePath) {
  const bytes = await readFile(new URL(relativePath, import.meta.url))
  assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false, `${relativePath}: UTF-8 BOM is not allowed`)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

test('Office and operator surfaces are strict UTF-8 without mojibake', async () => {
  for (const relativePath of UTF8_FILES) {
    const source = await decodeStrict(relativePath)
    assert.equal(source.includes('\ufffd'), false, `${relativePath}: replacement character found`)
    for (const marker of MOJIBAKE_MARKERS) {
      assert.equal(source.includes(marker), false, `${relativePath}: mojibake marker ${JSON.stringify(marker)} found`)
    }
  }
})

test('Russian operator copy survives source decoding exactly', async () => {
  const operator = await decodeStrict('../dashboard/electron/sentinel-safe-operator.mjs')
  const room = await decodeStrict('../dashboard/src/components/VoiceCommandRoomV2.tsx')
  const client = await decodeStrict('../dashboard/src/lib/operatorClient.ts')

  assert.match(operator, /Статус рабочего места/)
  assert.match(operator, /Предпросмотр памяти готов\. Ничего не сохранено\./)
  assert.match(room, /Подтвердить read-only план/)
  assert.match(room, /Выполнить локально/)
  assert.match(client, /Предпросмотр готов\. Для подтверждённого локального запуска откройте Sentinel Desktop\./)
})

test('dashboard declares UTF-8 and Russian document language', async () => {
  const html = await decodeStrict('../dashboard/index.html')
  assert.match(html, /<meta charset="UTF-8"\s*\/>/)
  assert.match(html, /<html lang="ru">/)
})
