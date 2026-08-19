#!/usr/bin/env node
// 日志迁移棘轮:只允许 `console.*` 调用点**下降**(与 ui-gate / boundary-gate 同构)。
//
// 为什么是棘轮而不是一次性 `no-console: error`:全仓 800+ 个调用点,一次性堵死
// 只会催生一堆 `eslint-disable`(拍板 F①)。L4 每迁一区,数字下降一批,基线重录
// 一次;迁完的目录再单独开 ESLint error。
//
// 比对口径 = (文件, 规则) 计数,不含行号 —— 行号级比对在无关编辑挪动行号时会
// 制造假新增(ui-gate 实测过)。
//
// 重录基线:
//   node scripts/log-check.mjs > docs/audit/log-gate-baseline-<date>.txt
// 基线录的必须是**与它同批落库**的状态。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 2026-08-20 首录(logging L1):854 条 = 迁移前的存量。L4 按区消。
const baselinePath = path.join(root, 'docs/audit/log-gate-baseline-2026-08-20.txt')

const ANSI_CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')
const FAILURE_PREFIX = '[log] failed:'
// [log] failed: <file>:<line> console.<method>
const FAILURE_SHAPE = /^\[log\] failed:\s+(.+):(\d+)\s+(\S+)$/

/** @returns {{ total: number, counts: Map<string, number> }} key = `<file>\0<rule>` */
function failuresOf(text) {
  const counts = new Map()
  let total = 0
  for (const raw of text.split('\n')) {
    const line = raw.replace(ANSI_CSI, '').trimEnd()
    const at = line.indexOf(FAILURE_PREFIX)
    if (at === -1) continue
    const match = FAILURE_SHAPE.exec(line.slice(at))
    if (!match) continue
    total += 1
    const key = `${match[1]}\0${match[3]}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return { total, counts }
}

const describe = key => key.replace('\0', '  ')

let output = ''
try {
  output = execFileSync(process.execPath, [path.join(root, 'scripts/log-check.mjs')], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
} catch (error) {
  // 有调用点就 exit 1 —— 那是常态,不是崩溃。输出照收。
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`
}

const baseline = failuresOf(readFileSync(baselinePath, 'utf8'))
const current = failuresOf(output)

// 空集当硬错:检查脚本崩了 / 输出格式变了,长得和"全迁完了"一模一样。
if (current.total === 0 && baseline.total > 0) {
  console.error('[log-gate] 解析不出任何调用点 —— 检查脚本崩了或输出格式变了,不认这次结果:')
  console.error(output.slice(-2000))
  process.exit(1)
}

const fresh = []
const healed = []
for (const [key, count] of current.counts) {
  const base = baseline.counts.get(key) ?? 0
  if (count > base) fresh.push({ key, over: count - base })
}
for (const [key, base] of baseline.counts) {
  const count = current.counts.get(key) ?? 0
  if (count < base) healed.push({ key, under: base - count })
}

if (healed.length > 0) {
  const n = healed.reduce((sum, item) => sum + item.under, 0)
  console.log(`[log-gate] ${n} console call site(s) migrated — consider re-recording the baseline:`)
  for (const item of healed.slice(0, 40)) console.log(`  - ${describe(item.key)} (-${item.under})`)
  if (healed.length > 40) console.log(`  … and ${healed.length - 40} more`)
}

if (fresh.length > 0) {
  const n = fresh.reduce((sum, item) => sum + item.over, 0)
  console.error(`[log-gate] ${n} NEW console call site(s) — 用 getLogger(ns) 代替(docs/design/logging-system-2026-08.md §2):`)
  for (const item of fresh) console.error(`  + ${describe(item.key)} (+${item.over})`)
  process.exit(1)
}

console.log(`[log-gate] ok — ${current.total} known console call site(s), none new`)
