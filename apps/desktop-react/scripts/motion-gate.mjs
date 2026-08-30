#!/usr/bin/env node
/**
 * `npm run motion-gate` —— motion-check 的**棘轮**,形制照抄 squeeze-gate。
 *
 * 基线 `docs/audit/motion-baseline-2026-08-31.txt` 是收口**之后**的存量:0 条。
 * 收口前它是 23 条(23 段 @keyframes 散在 20 个文件里),那份读数记在汇报里 ——
 * 基线文件记的是「现在允许有多少」,不是「历史上有过多少」。
 *
 * 规则两句:
 *  · 出现基线里没有的条目 = 红(新代码不许再散 keyframes、不许再写字面时长);
 *  · 基线里的条目消失了 = 绿,并提醒把那一行删掉(只减不增)。
 *
 * 比对的键是**文件 + 违例种类 + 名字**,不含行号 —— 同 squeeze-gate:上面加一行
 * 注释不该让一条既有违例"变成新的"。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findViolations } from './motion-check.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselineFile = path.resolve(appRoot, '../../docs/audit/motion-baseline-2026-08-31.txt')

/** `src/x.module.css:66 keyframes spin` → `src/x.module.css keyframes spin` */
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
  console.log(`[motion-gate] 基线里这 ${gone.length} 条已经不在了,可以从基线删掉:`)
  for (const k of gone) console.log(`  - ${k}`)
}

if (added.length) {
  console.error(`\n[motion-gate] FAILED —— ${added.length} 条新的动效违例:`)
  for (const line of added) console.error(`  ${line}`)
  console.error(
    '\n  三条规矩:'
      + '\n   · @keyframes 只许住在 src/styles/motion.css(全仓唯一的动效产地);'
      + '\n   · transition / animation 的**时长**只许 var(--dur-*),不许字面 ms/s;'
      + '\n   · animation 的**名字**只许 var(--kf-*),不许字面名 —— CSS Modules 会把'
      + '\n     字面名改写成 hash,而全局产地里的关键帧不叫那个名字,动画会静默全哑。'
      + '\n  法条、分类表与那次全哑的病历见 src/styles/motion.css 的文件头。',
  )
  process.exit(1)
}

console.log(`\n[motion-gate] ok —— ${current.length} 条,全在基线内(基线 ${baseline.size} 条)`)
