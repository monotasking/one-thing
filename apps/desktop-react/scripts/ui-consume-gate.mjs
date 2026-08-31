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

const current = findViolations().map((h) => `${h.rule} ${h.file}:${h.line} ${h.note}`)
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
      + '\n  确实不该改的,在命中处上方 8 行内写 `ui-consume-allow: <规则> — <理由>`(理由必填)。',
  )
  process.exit(1)
}

const debt = current.filter((l) => RULE_SEVERITY[l.split(/\s+/)[0]] === 'debt').length
console.log(
  `\n[ui-consume] ok —— ${current.length} 条,全在基线内(基线 ${baseline.size} 条;`
    + `其中 debt/待迁基座 ${debt} 条)`,
)
