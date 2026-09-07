import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { findSourceControlCharacters } from '../lib/source-text-policy.mjs'

let root
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-source-policy-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })
function write(relative, content) {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

it('detects raw controls in source, tests and styles after a local build', () => {
  write('apps/example/src/main.ts', 'const ok = true\n' + String.fromCharCode(1))
  write('packages/example/__tests__/source.test.ts', String.fromCharCode(0))
  write('apps/example/src/style.css', String.fromCharCode(31))
  write('apps/example/dist-strict/assets/bundle.js', String.fromCharCode(1))
  expect(findSourceControlCharacters(root).sort((a, b) => a.file.localeCompare(b.file))).toEqual([
    { file: 'apps/example/src/main.ts', line: 2, byte: 1 },
    { file: 'apps/example/src/style.css', line: 1, byte: 31 },
    { file: 'packages/example/__tests__/source.test.ts', line: 1, byte: 0 },
  ])
})

it('has the same clean-source result before and after generated artifacts exist', () => {
  write('apps/example/src/main.ts', 'const escaped = "\\u0000";\r\n\t// 说明\n')
  const clean = findSourceControlCharacters(root)
  write('apps/example/dist-strict/assets/bundle.js', String.fromCharCode(1))
  write('apps/example/dist-electron/main.cjs', String.fromCharCode(0))
  write('packages/example/node_modules/dependency/index.js', String.fromCharCode(11))
  expect(clean).toEqual([])
  expect(findSourceControlCharacters(root)).toEqual(clean)
})
