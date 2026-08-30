#!/usr/bin/env node
/**
 * `npm run squeeze-gate` —— squeeze-check 的**棘轮**。
 *
 * 基线 `docs/audit/squeeze-baseline-2026-08-30.txt` 是开工时的存量(7 条)。
 * 规则只有两句:
 *  · 出现基线里没有的条目 = 红(新代码不许再写「会拉伸却不能收缩」的块);
 *  · 基线里的条目消失了 = 绿,并提醒把那一行从基线里删掉(只减不增)。
 *
 * 比对的键是**文件 + 选择器**,不含行号 —— 理由写在基线文件的头几行。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findViolations } from './squeeze-check.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselineFile = path.resolve(appRoot, '../../docs/audit/squeeze-baseline-2026-08-30.txt')

/** `src/x.module.css:66 .title` → `src/x.module.css .title` */
const key = (line) => line.replace(/:\d+\s+/, ' ')

const baseline = new Set(
  readFileSync(baselineFile, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')),
)

const current = findViolations()
const currentKeys = new Map(current.map((line) => [key(line), line]))

const added = [...currentKeys].filter(([k]) => !baseline.has(k)).map(([, line]) => line)
const gone = [...baseline].filter((k) => !currentKeys.has(k))

if (gone.length) {
  console.log(`[squeeze-gate] 基线里这 ${gone.length} 条已经不在了,可以从基线删掉:`)
  for (const k of gone) console.log(`  - ${k}`)
}

if (added.length) {
  console.error(`\n[squeeze-gate] FAILED —— ${added.length} 条新的「会拉伸、却没解开收缩下界」:`)
  for (const line of added) console.error(`  ${line}`)
  console.error(
    '\n  律一:一行里可伸缩的文本件必须同时有 min-width: 0(column flex 里是 min-height: 0)'
      + '\n  与一条截断策略;不承担伸缩的件一律 flex: none。'
      + '\n  法条见 docs/design/react-shell-squeeze-rules-2026-08.md。',
  )
  process.exit(1)
}

console.log(`\n[squeeze-gate] ok —— ${current.length} 条,全在基线内(基线 ${baseline.size} 条)`)
