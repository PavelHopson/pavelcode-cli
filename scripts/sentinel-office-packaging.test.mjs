import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Office runtime modules are included in npm and Electron packages', async () => {
  const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const dashboardPackage = JSON.parse(await readFile(new URL('../dashboard/package.json', import.meta.url), 'utf8'))
  const officeResource = dashboardPackage.build?.extraResources?.find(
    (resource) => resource.from === '../office' && resource.to === 'office',
  )

  assert.equal(rootPackage.files.includes('office/'), true)
  assert.deepEqual(officeResource?.filter, ['*.mjs', '*.ps1'])
})

test('Electron resolves packaged Office modules from resources without exposing a renderer path', async () => {
  const main = await readFile(new URL('../dashboard/electron/main.cjs', import.meta.url), 'utf8')

  assert.match(main, /process\.resourcesPath/)
  assert.match(main, /path\.join\(process\.resourcesPath, 'office', 'sentinel-office-runtime\.mjs'\)/)
  assert.doesNotMatch(main, /contextBridge.*office|ipcRenderer.*office|office-credential|windows-credential|\.env|Authorization|Bearer/)
})
