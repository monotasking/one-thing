#!/usr/bin/env node
// Boundary ratchet gate: fail only on NEW failures vs the recorded baseline.
// The baseline carries known legacy reds (stale checks pending rewrite); the
// gate keeps them from silently growing. Shrinkage is reported so the
// baseline can be re-tightened.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(root, 'docs/audit/boundary-baseline-2026-08-07.txt')

// 检查脚本给失败行上了色,而且色码在被管道接走时照样写出来(它不判 isTTY)。
// 于是每条红实际长这样:`ESC[0m ESC[31m [boundary] failed: … ESC[0m` —— 原先的
// startsWith 一条都对不上,current 恒为空集,gate 于是永远报 "ok",并把整份基线
// 当成「已治愈」。那不是绿,是根本没在看。
//
// 剥的是整条 CSI 序列(连 ESC 字节一起):只剥 `[31m` 会把 ESC 留在行首行尾,
// 比对照样错位。正则用 fromCharCode 拼,免得源码里塞一个看不见的控制字符。
const ANSI_CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

const FAILURE_PREFIX = '[boundary] failed:'

// 基线文件是干净文本,剥一次对它无副作用 —— 两侧走同一个函数,才谈得上「同一条
// 红是同一个字符串」。
function failuresOf(text) {
  return new Set(
    text
      .split('\n')
      .map(line => line.replace(ANSI_CSI, '').trimEnd())
      // includes 而不是 startsWith:剥完仍可能有残留前缀(缩进之类),而这条前缀
      // 本身已经足够独一无二。
      .filter(line => line.includes(FAILURE_PREFIX))
      // 归一到前缀处再截,两侧对齐。
      .map(line => line.slice(line.indexOf(FAILURE_PREFIX))),
  )
}

let output = ''
try {
  output = execFileSync('bun', [path.join(root, 'scripts/headless-boundary-check.ts')], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (error) {
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`
}

const baseline = failuresOf(readFileSync(baselinePath, 'utf8'))
const current = failuresOf(output)

// 半程运行也是假绿的一种,而且比空集更阴:检查器崩在中途时,崩之前打出的红是
// 「非空」的,下面那道空集护栏根本不响,gate 照常报 ok —— 只是它比对的是一份残缺
// 的当前集,后半程所有检查连跑都没跑,基线里剩下的红全被当成「已治愈」。
// 检查器在文件末尾无条件打一行 complete;没有它就说明这次没跑到底,不认。
const COMPLETION_MARKER = '[boundary] complete:'
if (!output.includes(COMPLETION_MARKER)) {
  console.error('[boundary-gate] 检查器没跑到底(缺 complete 标记)—— 中途崩了,这次结果不算数:')
  console.error(output.slice(-2000))
  process.exit(1)
}

// 空集是可疑而不是干净:检查脚本自己崩了、输出格式变了、正则再次失配,都长这样。
// 上一次的假绿就是从这里溜过去的,所以把它当硬错处理。
if (current.size === 0 && baseline.size > 0) {
  console.error('[boundary-gate] 解析不出任何失败行 —— 检查脚本崩了或输出格式变了,不认这次结果:')
  console.error(output.slice(-2000))
  process.exit(1)
}

const fresh = [...current].filter(line => !baseline.has(line))
const healed = [...baseline].filter(line => !current.has(line))

if (healed.length > 0) {
  console.log(`[boundary-gate] ${healed.length} baseline failure(s) healed — consider re-recording the baseline:`)
  for (const line of healed) console.log('  -', line)
}

if (fresh.length > 0) {
  console.error(`[boundary-gate] ${fresh.length} NEW boundary failure(s):`)
  for (const line of fresh) console.error('  +', line)
  process.exit(1)
}

console.log(`[boundary-gate] ok — ${current.size} known failure(s), none new`)
