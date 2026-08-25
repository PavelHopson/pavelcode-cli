import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const readText = (relativePath) => readFile(path.join(repoRoot, relativePath), 'utf8')

test('desktop usage guide is discoverable on first run and remains reopenable', async () => {
  const app = await readText('dashboard/src/App.tsx')

  assert.match(app, /ultron-usage-guide-seen-v1/)
  assert.match(app, /localStorage\.getItem\(USAGE_GUIDE_STORAGE_KEY\) !== '1'/)
  assert.match(app, /aria-label="Открыть руководство"/)
  assert.doesNotMatch(app, /components\/Sidebar/)
})

test('guide describes only the current local voice and read-only operator paths', async () => {
  const guide = await readText('dashboard/src/components/UsageGuide.tsx')

  assert.match(guide, /Как пользоваться Eclipse Ultron/)
  assert.match(guide, /Qwen 3 8B/)
  assert.match(guide, /Включить живой разговор/)
  assert.match(guide, /говорите свободно/i)
  assert.match(guide, /через tray/i)
  assert.match(guide, /проверьте план и diff/i)
  assert.match(guide, /Operator не пишет файлы, не запускает shell и не использует сеть/)
  assert.doesNotMatch(guide, /автономн|полный доступ|управляет компьютером/i)
})

test('guide keeps modal keyboard and responsive contracts explicit', async () => {
  const [guide, css] = await Promise.all([
    readText('dashboard/src/components/UsageGuide.tsx'),
    readText('dashboard/src/eclipse-forge.css'),
  ])

  assert.match(guide, /aria-modal="true"/)
  assert.match(guide, /event\.key === 'Escape'/)
  assert.match(guide, /event\.key !== 'Tab'/)
  assert.match(guide, /previousFocus\?\.focus\(\)/)
  assert.match(css, /\.usage-guide-dialog/)
  assert.match(css, /max-height: min\(760px, calc\(100vh - 40px\)\)/)
  assert.match(css, /@media \(max-width: 720px\)/)
})
