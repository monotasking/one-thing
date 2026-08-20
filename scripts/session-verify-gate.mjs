#!/usr/bin/env node
// 棘轮门(2026-08-20,§10.17):sessions:verify 的红线基线 —— legacy 会话里
// "修复前的引擎 bug 已写死在盘上"的已知残余。新增红线 = 新代码弄坏了旧文件,
// 直接失败;治愈的打印出来提示收紧基线。与 boundary-gate 同款口径。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(root, 'docs/audit/session-verify-baseline-2026-08-20.txt')

let output = ''
try {
  output = execFileSync('bun', ['scripts/session-verify.ts', '--all'], { cwd: root, encoding: 'utf8' })
} catch (error) {
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`
}
const lines = output.split('\n').map(l => l.trim()).filter(l => l.startsWith('messages:') || l.startsWith('seq') || /^(surface|projection|blob|unclosed-run|messages):/.test(l))
// 归一:FAIL 块里的 issue 行带上会话 id
const issues = []
let current = ''
for (const raw of output.split('\n')) {
  const line = raw.trim()
  const fail = line.match(/^FAIL\s+(\S+)/)
  if (fail) { current = fail[1]; continue }
  if (line.startsWith('ok ') || line.startsWith('[verify]')) { current = ''; continue }
  if (current && /^(seq|surface|projection|blob|unclosed-run|messages):/.test(line)) issues.push(`${current} ${line}`)
}
const baseline = new Set(readFileSync(baselinePath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).filter(l => !l.startsWith('#')))
const deduped = [...new Set(issues)]
const currentSet = new Set(deduped)
const fresh = deduped.filter(l => !baseline.has(l))
const healed = [...baseline].filter(l => !currentSet.has(l))
if (healed.length) {
  console.log(`[session-verify-gate] ${healed.length} healed — consider re-recording the baseline:`)
  for (const l of healed) console.log(`  - ${l}`)
}
if (fresh.length) {
  console.error(`[session-verify-gate] FAILED: ${fresh.length} NEW issue(s) vs baseline:`)
  for (const l of fresh) console.error(`  + ${l}`)
  process.exit(1)
}
console.log(`[session-verify-gate] ok — ${deduped.length} known issue(s), none new`)
