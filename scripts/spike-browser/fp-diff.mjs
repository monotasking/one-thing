/**
 * B0 spike ①-㈢ 的差分器:把 fp.html 在两个浏览器里各 dump 的 JSON 逐键比对,打一张差异表。
 *
 *   node scripts/spike-browser/fp-diff.mjs <a.json> <b.json> [--labels=Electron,Flow] [--all]
 *
 * 缺省只打**不一样的**格;`--all` 连相同的一起打。
 * 「EME / Widevine」那几格单独标出来 —— 官方核与 castlabs 核的真差只该在那里;
 * 若差异表里除了它还有别的格,那些就是 ㈢ 阶要补齐的。
 */
import fs from 'node:fs'

const args = process.argv.slice(2)
const files = args.filter((a) => !a.startsWith('--'))
const arg = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const SHOW_ALL = args.includes('--all')
const [labelA, labelB] = arg('labels', 'A,B').split(',')

if (files.length !== 2) {
  console.error('用法:node fp-diff.mjs <a.json> <b.json> [--labels=Electron,Flow] [--all]')
  process.exit(2)
}

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const a = load(files[0])
const b = load(files[1])

/** 拍平成「点路径 → 值」,数组按 JSON 串整块比(顺序有意义,比如 brands) */
function flatten(obj, prefix = '', out = {}) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    out[prefix] = obj
    return out
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v
  }
  return out
}

const fa = flatten(a)
const fb = flatten(b)
const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()

/** 这些键的差是「本来就该差」的,不算缺口 */
const EXPECTED_DIFF = /^(collectedAt|timezoneOffset)$/
/** EME 那一族:官方核没有 Widevine CDM,这是**结构性**的差,不是能补的 */
const EME_KEY = /^widevine\./

const rows = []
for (const k of keys) {
  const va = JSON.stringify(fa[k] ?? null)
  const vb = JSON.stringify(fb[k] ?? null)
  const same = va === vb
  if (same && !SHOW_ALL) continue
  rows.push({
    key: k,
    same,
    kind: EME_KEY.test(k) ? 'EME(结构性,补不了)' : EXPECTED_DIFF.test(k) ? '无关' : same ? '同' : '**要补**',
    a: va,
    b: vb,
  })
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const w = (s, n) => clip(String(s), n).padEnd(n)

console.log('')
console.log(`指纹差分:${labelA} = ${files[0]}`)
console.log(`          ${labelB} = ${files[1]}`)
console.log('')
console.log(w('键', 34) + ' ' + w('判', 20) + ' ' + w(labelA, 52) + ' ' + labelB)
console.log('-'.repeat(160))
for (const r of rows) console.log(w(r.key, 34) + ' ' + w(r.kind, 20) + ' ' + w(r.a, 52) + ' ' + clip(r.b, 52))

const gaps = rows.filter((r) => r.kind === '**要补**')
const eme = rows.filter((r) => r.kind.startsWith('EME'))
console.log('')
console.log(`合计:${rows.length} 行差异 —— 其中 EME(结构性)${eme.length} 行,**要补的** ${gaps.length} 行。`)
if (gaps.length === 0) console.log('→ 除 EME 外两边逐格一致:官方核上还登不上的话,差的就是 EME 本身。')
else console.log('→ 要补的格:' + gaps.map((r) => r.key).join(', '))
