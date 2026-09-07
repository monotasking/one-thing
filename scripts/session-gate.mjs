#!/usr/bin/env node
// 会话写/读路径棘轮:只在**新增**违规时挂,基线里的存量红照旧放行。
//
// 与 ui:gate / boundary:gate 同构(连它们踩过的坑一起继承):
//   - 两侧走同一个解析函数,并剥掉整条 ANSI CSI 序列;
//   - 空集当硬错处理 —— 检查脚本崩了、输出格式变了,长得跟"全治愈了"一模一样;
//   - 检查器末尾无条件打一行 complete,没有它说明半程崩了,这次结果不算数。
//
// 比对口径是 (文件, 规则) 的计数,不含行号:行号级比对在无关编辑挪动行号时会制造
// 假新增,棘轮会因此失去公信力。
//
// 基线曾经 = 0(P0.4 收口后重录)。2026-09-07(工单 4 D2)变成 **4 条**:那四条
// 从前是藏在 `session-check.mjs` 里逐字比对源码表达式的就地豁免 —— 豁免属于基线,
// 不属于检查器,检查器只该回答「这里有没有命中」。判据不变:任何**新**命中直接红。
// 重录:
//   node scripts/session-check.mjs > docs/audit/session-gate-baseline-2026-08-19.txt
// 重录之后**必须**把基线文件顶部那段逐条理由补上(基线里的 `#` 行不参与比对)。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(root, 'docs/audit/session-gate-baseline-2026-08-19.txt')

const ANSI_CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')
const FAILURE_PREFIX = '[session] failed:'
const COMPLETION_MARKER = '[session] complete:'
// [session] failed: <file>:<line> <rule>
const FAILURE_SHAPE = /^\[session\] failed:\s+(.+):(\d+)\s+(\S+)$/

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
  output = execFileSync(process.execPath, [path.join(root, 'scripts/session-check.mjs')], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
} catch (error) {
  // 检查脚本有违规就 exit 1 —— 那是常态,不是崩溃。输出照收。
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`
}

if (!output.includes(COMPLETION_MARKER)) {
  console.error('[session-gate] 检查器没跑到底(缺 complete 标记)—— 中途崩了,这次结果不算数:')
  console.error(output.slice(-2000))
  process.exit(1)
}

const baseline = failuresOf(readFileSync(baselinePath, 'utf8'))
const current = failuresOf(output)

if (current.total === 0 && baseline.total > 0) {
  console.error('[session-gate] 解析不出任何失败行 —— 检查脚本崩了或输出格式变了,不认这次结果:')
  console.error(output.slice(-2000))
  process.exit(1)
}

// 基线为 0 时"没解析到失败行"是**正常**的,上面那道空集硬错帮不上忙 —— 换成
// 核对扫描规模:检查器少扫了文件同样会假装干净。
const SCANNED_SHAPE = /\[session\] complete:\s+(\d+) file\(s\) scanned/
const scanned = Number(SCANNED_SHAPE.exec(output)?.[1] ?? 0)
const MIN_SCANNED_FILES = 1500
if (scanned < MIN_SCANNED_FILES) {
  console.error(
    `[session-gate] 只扫到 ${scanned} 个文件(下限 ${MIN_SCANNED_FILES})—— 程序没建起来,不认这次结果。`,
  )
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
  console.log(`[session-gate] ${n} baseline violation(s) healed — consider re-recording the baseline:`)
  for (const item of healed.slice(0, 40)) console.log(`  - ${describe(item.key)} (-${item.under})`)
  if (healed.length > 40) console.log(`  … and ${healed.length - 40} more`)
}

if (fresh.length > 0) {
  const n = fresh.reduce((sum, item) => sum + item.over, 0)
  console.error(
    `[session-gate] ${n} NEW session write/read violation(s) —— 会话消息只能过 sessionCommands / sessionReads,` +
    '规则见 docs/design/session-commands-p0-2026-08.md §4:',
  )
  for (const item of fresh) console.error(`  + ${describe(item.key)} (+${item.over})`)
  process.exit(1)
}

console.log(`[session-gate] ok — ${current.total} known violation(s), none new`)
