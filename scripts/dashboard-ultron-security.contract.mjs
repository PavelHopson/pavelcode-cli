import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const readText = (relativePath) => readFile(path.join(repoRoot, relativePath), 'utf8')

test('Ultron one-shot STT uses a fixed, bounded and trusted Electron IPC contract', async () => {
  const [main, preload, packageText, stt] = await Promise.all([
    readText('dashboard/electron/main.cjs'),
    readText('dashboard/electron/preload.cjs'),
    readText('dashboard/package.json'),
    readText('scripts/sentinel-stt.ps1'),
  ])
  const packageJson = JSON.parse(packageText)

  assert.match(main, /const \{ spawn \} = require\('child_process'\)/)
  assert.doesNotMatch(main, /\bexec(?:File|Sync)?\s*\(/)
  assert.match(main, /shell: false/)
  assert.match(main, /VOICE_OUTPUT_LIMIT_BYTES = 8 \* 1024/)
  assert.match(main, /VOICE_PROCESS_TIMEOUT_MS = 25_000/)
  assert.match(main, /VOICE_RATE_LIMIT_MS = 1_500/)
  assert.match(main, /voiceListenInFlight/)
  assert.match(main, /ipcMain\.handle\(VOICE_LISTEN_CHANNEL, async \(event, \.\.\.args\)/)
  assert.match(main, /args\.length !== 0/)
  assert.match(main, /isTrustedOperatorSender\(event\)/)
  assert.match(main, /setPermissionRequestHandler[\s\S]*callback\(false\)/)
  assert.match(main, /path\.join\(process\.resourcesPath, 'voice', 'sentinel-stt\.ps1'\)/)
  assert.match(main, /path\.join\(eclipseProgramsRoot, 'Eclipse AI Runtime'\)/)
  assert.match(main, /'-RuntimeRoot',[\s\S]*eclipseAiRuntimeRoot/)
  assert.match(main, /app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), 'Eclipse Sentinel'\)\)/)
  assert.match(preload, /listenOnce\(\)[\s\S]*ipcRenderer\.invoke\(VOICE_LISTEN_CHANNEL\)/)
  assert.doesNotMatch(preload, /listenOnce\([^)]*[A-Za-z]/)
  assert.ok(packageJson.build.extraResources.some((resource) => resource.to === 'voice/sentinel-stt.ps1'))
  assert.match(stt, /Console\]::OutputEncoding = \$utf8/)
  assert.match(stt, /whisper\\Release\\whisper-stream\.exe/)
  assert.match(stt, /ggml-large-v3-turbo-q5_0\.bin/)
  assert.match(stt, /System\.Diagnostics\.ProcessStartInfo/)
  assert.match(stt, /CreateNoWindow = \$true/)
  assert.match(stt, /UseShellExecute = \$false/)
  assert.match(stt, /ReadToEndAsync\(\)/)
  assert.doesNotMatch(stt, /--save-audio|-sa\b|stt-\$token\.txt|RedirectStandardOutput = \$stdoutPath/)
  assert.match(stt, /WHISPER_RUNTIME_MISSING/)
  assert.match(stt, /WHISPER_MODEL_MISSING/)
  assert.match(stt, /RUSSIAN_SPEECH_PACK_MISSING/)
  assert.match(stt, /SpeechRecognitionEngine\]::new\(\$russianRecognizer\.Culture\)/)
  assert.match(stt, /\$recognizer\.Dispose\(\)/)
  assert.match(stt, /\$script:whisperProcess\.Kill\(\)/)
  assert.match(main, /WHISPER_RUNTIME_MISSING: 'Локальный голосовой runtime не найден/)
})

test('Ultron Lab routes the abliterated model to a separate local endpoint without tools', async () => {
  const [ai, settings, main, html] = await Promise.all([
    readText('dashboard/src/lib/ai.ts'),
    readText('dashboard/src/components/SettingsPanel.tsx'),
    readText('dashboard/electron/main.cjs'),
    readText('dashboard/index.html'),
  ])

  assert.match(ai, /huihui_ai\/qwen3\.8-abliterated:27b/)
  assert.match(ai, /lab: 'http:\/\/127\.0\.0\.1:11435'/)
  assert.match(ai, /У тебя нет инструментов, shell, доступа к файлам, сети, секретам, установке или deployment/)
  assert.doesNotMatch(ai, /tools\s*:/)
  assert.match(settings, /Экспериментальный Lab-профиль/)
  assert.match(settings, /Shell, файлы, сеть, секреты и operator execute ей недоступны/)
  assert.match(main, /OLLAMA_HOST: '127\.0\.0\.1:11435'/)
  assert.match(main, /OLLAMA_MODELS: labOllamaModels/)
  assert.match(main, /OLLAMA_LOAD_TIMEOUT: '15m'/)
  assert.match(main, /spawn\(labOllamaExecutable, \['serve'\]/)
  assert.match(html, /connect-src[^;]*http:\/\/127\.0\.0\.1:11435/)
  assert.doesNotMatch(`${ai}\n${main}`, /0\.0\.0\.0:11435/)
})

test('Ultron command center exposes explicit safety, voice and accessible motion controls', async () => {
  const [app, room, chat, core, avatar, contact, voice, css] = await Promise.all([
    readText('dashboard/src/App.tsx'),
    readText('dashboard/src/components/VoiceCommandRoomV2.tsx'),
    readText('dashboard/src/components/Chat.tsx'),
    readText('dashboard/src/components/UltronCore.tsx'),
    readText('dashboard/src/components/UltronAvatar.tsx'),
    readText('dashboard/src/components/UltronContactDock.tsx'),
    readText('dashboard/src/lib/voice.ts'),
    readText('dashboard/src/ultron.css'),
  ])

  assert.match(room, /isLocalSTTSupported/)
  assert.match(room, /listenOnceLocal/)
  assert.match(chat, /listenOnceLocal/)
  assert.match(chat, /Голос заполнит поле — проверьте текст перед отправкой/)
  assert.match(chat, /externalTurn\.mode === 'voice'/)
  assert.match(chat, /forceSpeak: true/)
  assert.match(chat, /speak\(assistantMsg\.content\)/)
  assert.doesNotMatch(chat, /createRecognition|webkitSpeechRecognition/)
  assert.match(room, /STOP активен/)
  assert.match(room, /aria-pressed=\{motionEnabled\}/)
  assert.match(app, /ultron-motion-enabled-v1/)
  assert.match(app, /prefers-reduced-motion: reduce/)
  assert.match(app, /media\.addEventListener\('change'/)
  assert.match(core, /aria-live="polite"/)
  assert.match(core, /role="status"/)
  assert.match(core, /ultron-core__voice/)
  assert.match(avatar, /data-presence=\{presence\}/)
  assert.match(avatar, /ultron-avatar-presence__voice/)
  assert.match(contact, /listenOnceLocal/)
  assert.match(contact, /Спросить голосом/)
  assert.match(contact, /Только продиктовать/)
  assert.match(contact, /Каждая новая реплика требует отдельного нажатия/)
  assert.match(contact, /onVoiceTurn\(result\.text\)/)
  assert.match(contact, /onDraft\(result\.text\)/)
  assert.doesNotMatch(contact, /sendMessage|handleSend|createRecognition|webkitSpeechRecognition/)
  assert.doesNotMatch(contact, /setInterval|wake.?word|background.?listen/i)
  assert.match(contact, /role="dialog"/)
  assert.match(contact, /aria-expanded=\{open\}/)
  assert.match(contact, /event\.key !== 'Escape'/)
  assert.match(voice, /45_000/)
  assert.match(voice, /speechSynthesis\.cancel\(\)/)
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /\.ultron-contact__launcher/)
  assert.match(css, /@keyframes ultron-avatar-voice/)
  assert.match(css, /@keyframes ultron-core-voice/)
  assert.match(css, /\.ultron-avatar-presence\[data-motion="on"\]/)
  assert.doesNotMatch(`${app}\n${room}\n${chat}\n${core}\n${avatar}\n${contact}\n${css}`, /Marvel|Avengers|Iron Man|Tony Stark/i)
})
