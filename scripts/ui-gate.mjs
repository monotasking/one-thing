#!/usr/bin/env node
// UI style ratchet gate: fail only on NEW violations vs the recorded baseline.
//
// 与 boundary:gate 同构(scripts/boundary-gate.mjs),包括它踩过的坑:
//   - 两侧走同一个解析函数,并剥掉整条 ANSI CSI 序列,否则"同一条红"对不上;
//   - 空集当硬错处理 —— 检查脚本崩了、输出格式变了,长得跟"全治愈了"一模一样,
//     上一次的假绿就是从那里溜过去的。
//
// 比对口径是 (文件, 规则) 的计数,不含行号 —— 行号级比对在无关编辑挪动行号时
// 会制造假新增(P1 期实测:RightWorkbenchPanel 被顺手编辑,6 条老违规全部
// "变新"),棘轮会因此失去公信力。计数口径下:数量不超基线=不报;数量下降=
// 治愈。代价是"同文件同规则一增一减"会被抵消看不见 —— 接受,棘轮要的是
// 总量单调下降,不是逐行审计。
//
// 基线是存量债(docs/design/ui-system-consolidation.md 的分期表按类别逐期消)。
// 治愈的项会打印出来,提示重新生成基线把棘轮收紧:
//   node scripts/ui-style-check.mjs > docs/audit/ui-baseline-<date>.txt
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 2026-08-13 重录(Media Panel 设计落地 P5):97 → 81,净治愈 16 条(五兄弟面板套
// PanelShell 骨架顺手消掉的 surface-literal / focus-bare / native-select),新增
// 0 条。规则数 11 → 12(`overscroll-contain-chat`,存量 0)。
// 2026-08-11 那轮(G7-3):新增第 11 条 `surface-literal`,12 → 97(旧五条计数
// 一条没变,+85 全是新规则的存量 —— 那 85 条就是波 6 区域面迁移的自动待办清单)。
// 2026-08-10 那轮是 58 → 12(title-attr 豁免名单扩到组件 prop)。
// **基线录的必须是与它同批落库的状态** —— 检查器读的是工作树,所以重录要么在
// `git worktree add --detach <tmp> HEAD` 出来的干净树里跑(新规则的实现要 cp 进去),
// 要么确认工作树上的改动与新基线进同一个提交(2026-08-13 这轮是后者);把不会落库
// 的工作(healed 的、以及新引入的红)录进去,棘轮当场失去公信力。
const baselinePath = path.join(root, 'docs/audit/ui-baseline-2026-08-13.txt')

const ANSI_CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')
const FAILURE_PREFIX = '[ui] failed:'
// [ui] failed: <file>:<line> <rule>
const FAILURE_SHAPE = /^\[ui\] failed:\s+(.+):(\d+)\s+(\S+)$/

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
  output = execFileSync(process.execPath, [path.join(root, 'scripts/ui-style-check.mjs')], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
} catch (error) {
  // 检查脚本有违规就 exit 1 —— 那是常态,不是崩溃。输出照收。
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`
}

const baseline = failuresOf(readFileSync(baselinePath, 'utf8'))
const current = failuresOf(output)

if (current.total === 0 && baseline.total > 0) {
  console.error('[ui-gate] 解析不出任何失败行 —— 检查脚本崩了或输出格式变了,不认这次结果:')
  console.error(output.slice(-2000))
  process.exit(1)
}

const fresh = []   // { key, over }   当前数量超出基线的部分
const healed = []  // { key, under }  当前数量低于基线的部分
for (const [key, count] of current.counts) {
  const base = baseline.counts.get(key) ?? 0
  if (count > base) fresh.push({ key, over: count - base })
}
for (const [key, base] of baseline.counts) {
  const count = current.counts.get(key) ?? 0
  if (count < base) healed.push({ key, under: base - count })
}

if (healed.length > 0) {
  const n = healed.reduce((sum, h) => sum + h.under, 0)
  console.log(`[ui-gate] ${n} baseline violation(s) healed — consider re-recording the baseline:`)
  for (const h of healed.slice(0, 40)) console.log(`  - ${describe(h.key)} (-${h.under})`)
  if (healed.length > 40) console.log(`  … and ${healed.length - 40} more`)
}

if (fresh.length > 0) {
  const n = fresh.reduce((sum, f) => sum + f.over, 0)
  console.error(`[ui-gate] ${n} NEW UI style violation(s) — 规则见 docs/design/ui-system.md:`)
  for (const f of fresh) console.error(`  + ${describe(f.key)} (+${f.over})`)
  process.exit(1)
}

console.log(`[ui-gate] ok — ${current.total} known violation(s), none new`)
