#!/usr/bin/env node
// 日志迁移棘轮的检查器:数**非测试源码**里的 `console.*` 调用点。
//
// 口径(docs/design/logging-system-2026-08.md §2.6):
//   - 扫 packages/{core,onething-runtime/src,backend,renderer,gateway/src,shared} 与
//     apps/{electron,server,web}/src(以及 apps/web 的少量根文件);
//   - 跳过测试(`__tests__/`、`*.test.*`、`*.spec.*`)、类型声明、构建产物;
//   - 白名单:`scripts/`(本来就是给人看的终端输出)与
//     `apps/electron/src/main/cli/stdout.ts`(CLI 的产品输出口);
//   - `console.` 出现在注释 / 字符串里不算 —— 只认 `console.<method>(` 这个调用形状,
//     并剥掉行注释与整块注释。
//
// 输出格式与 ui-style-check 同构:`[log] failed: <file>:<line> console.<method>`,
// 末尾一行汇总。棘轮见 scripts/log-gate.mjs。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ROOTS = [
  'packages/core',
  'packages/onething-runtime/src',
  'packages/backend',
  'packages/renderer',
  'packages/gateway/src',
  'packages/shared',
  'apps/electron/src',
  'apps/server/src',
  'apps/web',
]

/** 不计入棘轮的产品输出口 / 工具脚本。 */
const WHITELIST = new Set([
  'apps/electron/src/main/cli/stdout.ts',
])

const SKIP_DIR = new Set(['node_modules', 'dist', 'out', 'release', '__tests__', '__mocks__', 'coverage'])
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.vue'])
const CONSOLE_CALL = /console\.(log|info|warn|error|debug|trace|dir|table|group|groupEnd|time|timeEnd|count|assert)\s*\(/g

function isTestFile(relPath) {
  return /(^|\/)__tests__\//.test(relPath)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relPath)
    || /\.d\.ts$/.test(relPath)
}

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue
      yield* walk(abs)
      continue
    }
    if (!entry.isFile()) continue
    if (!EXTENSIONS.has(path.extname(entry.name))) continue
    yield abs
  }
}

/** 剥掉块注释与行注释,免得把注释里的 `console.log` 当调用点。 */
function stripComments(source) {
  let out = ''
  let index = 0
  let state = 'code'
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'code') {
      if (char === '/' && next === '*') { state = 'block'; out += '  '; index += 2; continue }
      if (char === '/' && next === '/') { state = 'line'; out += '  '; index += 2; continue }
      out += char
      index += 1
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; out += '  '; index += 2; continue }
      out += char === '\n' ? '\n' : ' '
      index += 1
      continue
    }
    // line comment
    if (char === '\n') { state = 'code'; out += '\n'; index += 1; continue }
    out += ' '
    index += 1
  }
  return out
}

const failures = []
const seenFiles = new Set()

for (const rootDir of ROOTS) {
  const abs = path.join(root, rootDir)
  try {
    if (!statSync(abs).isDirectory()) continue
  } catch {
    continue
  }
  for (const file of walk(abs)) {
    const relPath = path.relative(root, file).split(path.sep).join('/')
    if (seenFiles.has(relPath)) continue
    seenFiles.add(relPath)
    if (isTestFile(relPath)) continue
    if (WHITELIST.has(relPath)) continue
    const source = stripComments(readFileSync(file, 'utf8'))
    const lines = source.split('\n')
    for (const [index, line] of lines.entries()) {
      CONSOLE_CALL.lastIndex = 0
      let match
      while ((match = CONSOLE_CALL.exec(line))) {
        failures.push({ file: relPath, line: index + 1, rule: `console.${match[1]}` })
      }
    }
  }
}

failures.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
for (const failure of failures) {
  console.log(`[log] failed: ${failure.file}:${failure.line} ${failure.rule}`)
}
console.log(`[log] ${failures.length} console call site(s) in non-test source`)
process.exit(failures.length > 0 ? 1 : 0)
