import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('desktop operator IPC exposes one invoke-only capability', async () => {
  const preload = await readFile(new URL('../dashboard/electron/preload.cjs', import.meta.url), 'utf8')
  const operatorStart = preload.indexOf("contextBridge.exposeInMainWorld('sentinelOperator'")
  const operatorEnd = preload.indexOf("contextBridge.exposeInMainWorld('ultronVoice'", operatorStart)
  const operatorBridge = preload.slice(operatorStart, operatorEnd)

  assert.equal(operatorStart >= 0, true)
  assert.equal(operatorEnd > operatorStart, true)
  assert.match(operatorBridge, /ipcRenderer\.invoke\(EXECUTE_CHANNEL, request\)/)
  assert.doesNotMatch(operatorBridge, /ipcRenderer\.(?:send|sendSync|on|once|removeListener)/)
  assert.doesNotMatch(preload, /ipcRenderer\.(?:send|sendSync|once)/)
  assert.match(preload, /ipcRenderer\.on\(channel, listener\)/)
  assert.match(preload, /ipcRenderer\.removeListener\(entry\.channel, entry\.listener\)/)
  assert.doesNotMatch(preload, /shell|child_process|fs\b/)
})

test('desktop operator validates sender and keeps the Electron renderer sandboxed', async () => {
  const main = await readFile(new URL('../dashboard/electron/main.cjs', import.meta.url), 'utf8')
  assert.match(main, /sandbox:\s*true/)
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /event\.sender !== win\.webContents/)
  assert.match(main, /senderUrl\.origin === 'http:\/\/localhost:3939'/)
  assert.match(main, /target\.protocol === 'https:'/)
  assert.match(main, /will-navigate/)
  assert.match(main, /event\.preventDefault\(\)/)
  assert.doesNotMatch(main, /callback\(true\)/)
})

test('Office runtime stays a non-blocking side effect after operator authority', async () => {
  const main = await readFile(new URL('../dashboard/electron/main.cjs', import.meta.url), 'utf8')
  const executeIndex = main.indexOf('safeOperatorExecutor.execute(request)')
  const projectionIndex = main.indexOf('projectOfficeSuccess(request, receipt)', executeIndex)
  const responseIndex = main.indexOf('return { ok: true, receipt }')

  assert.match(main, /sentinel-office-runtime\.mjs/)
  assert.match(main, /\.catch\(\(\) => null\)/)
  assert.match(main, /void officeRuntimePromise\.then/)
  assert.match(main, /projectOfficeBlocked\(request, error\)/)
  assert.equal(executeIndex >= 0, true)
  assert.equal(executeIndex < projectionIndex, true)
  assert.equal(projectionIndex < responseIndex, true)
  assert.doesNotMatch(main, /await projectOffice(?:Success|Blocked)/)
  assert.doesNotMatch(main, /ipcMain\.(?:handle|on)\([^\n]*office|contextBridge.*office|office.*(?:secret|credential)/i)
})

test('dashboard CSP blocks remote scripts, objects and form submission', async () => {
  const html = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8')
  assert.match(html, /default-src 'self'/)
  assert.match(html, /script-src 'self'/)
  assert.match(html, /object-src 'none'/)
  assert.match(html, /form-action 'none'/)
  assert.doesNotMatch(html, /https:\/\/fonts\.|https:\/\/cdn\./)
})

test('dashboard provider responses are parsed defensively without leaking response bodies', async () => {
  const ai = await readFile(new URL('../dashboard/src/lib/ai.ts', import.meta.url), 'utf8')

  assert.match(ai, /const data: unknown = await resp\.json\(\)/)
  assert.match(ai, /function providerModelNames\(payload: unknown\)/)
  assert.match(ai, /throw new Error\(`Ollama request failed \(\$\{resp\.status\}\)`\)/)
  assert.doesNotMatch(ai, /await resp\.text\(\)/)
})

test('dashboard keeps mobile navigation and reduced-motion safeguards available', async () => {
  const css = await readFile(new URL('../dashboard/src/index.css', import.meta.url), 'utf8')

  assert.match(css, /@media \(max-width: 520px\).*\.surface-switcher \{ display: flex; \}/s)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\).*\.sentinel-shell \*/s)
  assert.match(css, /animation: none !important/)
})
