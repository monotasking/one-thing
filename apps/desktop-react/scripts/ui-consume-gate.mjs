#!/usr/bin/env node
/**
 * `npm run ui:consume` —— ui-consume-check 的**棘轮**(照 log-gate / squeeze-gate 谱系)。
 *
 * 基线 `docs/audit/ui-consume-baseline-2026-09-01.txt` 是 09-01 收敛批交卷时的存量。
 * 三句话:
 *  · 出现基线里没有的条目 = **红**(新代码不许再手写 ui/ 已有职责的东西);
 *  · 基线里的条目消失了 = 绿,并提醒把那一行从基线删掉(**只减不增**);
 *  · `debt` 档(结构件裸钮欠基座)与 `violation` 档同样只减不增 ——
 *    「不违例」说的是不用改写法,不是可以随便再长一个。
 *
 * 比对的键是**规则 + 文件**,不含行号:上下加一行不该把一条存量算成新增,
 * 而同一文件同一规则的**条数**要算 —— 所以键带序号(第 n 条),
 * 与 squeeze-gate 只用「文件 + 选择器」不同:那边一个块只可能有一条,这边会有 33 条。
 *
 * ── 响应链那三条(keydown / focus / activeElement)是**零基线硬闸** ──────────
 * 09-02 R0 立它们时用的是 `report` 档(只打读数不判红):那时树零消费者,判红
 * 等于要求一批干完三批的活。R2 内容面接树之后三条读数归零,R3(09-03)把
 * severity 改成 `violation` —— 它们于是走这道棘轮的**普通路**,而基线文件里
 * 一条都没有,所以「基线零」不是另一套逻辑,就是这道门原本的算法:
 * 命中不在基线里 = 新增 = 红。一条新命中直接红,没有先记一笔账那条路。
 *
 * `report` 档的机制留着(今天零条规则用它),它是「先立门、后分期还账」这条路
 * 本身 —— 下一条要分期还的规则照 R0→R3 走一遍。
 *
 * 想看全表:`node scripts/ui-consume-check.mjs`。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RULE_SEVERITY, findViolations } from './ui-consume-check.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselineFile = path.resolve(appRoot, '../../docs/audit/ui-consume-baseline-2026-09-01.txt')

/** `规则 文件:行 备注` → `规则 文件#n`(n = 该文件该规则里的第几条)。 */
function keys(lines) {
  const seen = new Map()
  return lines.map((line) => {
    const [rule, where] = line.split(/\s+/)
    const file = (where ?? '').split(':')[0]
    const base = `${rule} ${file}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return `${base}#${n}`
  })
}

const baselineLines = readFileSync(baselineFile, 'utf-8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))

const baseline = new Set(keys(baselineLines))

const all = findViolations()
const reported = all.filter((h) => RULE_SEVERITY[h.rule] === 'report')
const current = all
  .filter((h) => RULE_SEVERITY[h.rule] !== 'report')
  .map((h) => `${h.rule} ${h.file}:${h.line} ${h.note}`)
const currentKeys = keys(current)
const byKey = new Map(currentKeys.map((k, i) => [k, current[i]]))

const added = [...byKey].filter(([k]) => !baseline.has(k)).map(([, line]) => line)
const gone = [...baseline].filter((k) => !byKey.has(k))

if (gone.length) {
  console.log(`[ui-consume] 基线里这 ${gone.length} 条已经不在了,可以从基线删掉:`)
  for (const k of gone) console.log(`  - ${k}`)
}

if (added.length) {
  console.error(`\n[ui-consume] FAILED —— ${added.length} 条新的「业务面手写 ui/ 已有职责」:`)
  for (const line of added) {
    const rule = line.split(/\s+/)[0]
    console.error(`  ${line}   [${RULE_SEVERITY[rule] ?? '?'}]`)
  }
  console.error(
    '\n  法条:CLAUDE.md 施工纪律「基础件先行」—— 动手写交互行为之前先查 src/ui/,'
      + '\n  有则必须消费,没有则先立件入库再消费。对照表:'
      + '\n    kbd-select-*  → src/ui/a11y/list-selection(候选列表)/ roving(焦点真在项上)'
      + '\n    tooltip-*     → src/ui/Tooltip'
      + '\n    icon-button-* → src/ui/IconButton'
      + '\n    bare-button-text / -icon → src/ui/Button · AsyncButton / IconButton'
      + '\n    bare-button-structural   → src/ui/ButtonBase(只清 UA 的基座)'
      + '\n    keydown-outside-focus / focus-outside-focus / active-element-read'
      + '\n                  → src/focus/(响应链;设计 react-shell-focus-2026-09.md §3 的 I2/I3)'
      + '\n                    键盘监听收进 focus/dispatch;跨作用域搬焦点改 activate();'
      + '\n                    「我是不是当前」改问 useFocusScopeActive()'
      + '\n  确实不该改的,在命中处上方 8 行内写 `ui-consume-allow: <规则> — <理由>`(理由必填)。',
  )
  process.exit(1)
}

const debt = current.filter((l) => RULE_SEVERITY[l.split(/\s+/)[0]] === 'debt').length
console.log(
  `\n[ui-consume] ok —— ${current.length} 条,全在基线内(基线 ${baseline.size} 条;`
    + `其中 debt/待迁基座 ${debt} 条)`,
)

/*
 * 响应链三条**报个零**。它们已经在上面那道棘轮里判过了(零基线,一条即红),
 * 这一行不是第二次判,是把「今天仍然是零」说出口 —— 一道永远沉默的门,
 * 读者没法从输出里知道它跑过没有。
 */
const FOCUS_RULES = ['keydown-outside-focus', 'focus-outside-focus', 'active-element-read']
const focusHits = current.filter((l) => FOCUS_RULES.includes(l.split(/\s+/)[0])).length
console.log(
  `[ui-consume] 响应链三条(I2/I3,零基线硬闸):${focusHits} 条`
    + `${focusHits === 0 ? ' —— keydown 监听 / 跨作用域 .focus() / 读 activeElement 全在 src/focus/ 里' : ''}`,
)

if (reported.length) {
  const byRule = new Map()
  for (const h of reported) byRule.set(h.rule, (byRule.get(h.rule) ?? 0) + 1)
  console.log(
    `[ui-consume] 另有 report 档 ${reported.length} 条(**不判红**,分期还账中的规则):`
      + `${[...byRule].sort().map(([rule, n]) => `\n  ${rule.padEnd(24)} ${n}`).join('')}`
      + '\n  全表:node scripts/ui-consume-check.mjs',
  )
}
