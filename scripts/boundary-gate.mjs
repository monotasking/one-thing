#!/usr/bin/env node
// Boundary gate: **零基线硬门** —— 任何一行 `[boundary] failed:` 就红。
//
// 08-21(结构债方案 P2):棘轮机制退役。它当初的用处是把 13 条已知旧红围起来、
// 只拦新增;P2 把 13 条清到 0(4 条改源修绿、9 条判定为断言过期/假阳性后改 checker),
// 基线文件 `docs/audit/boundary-baseline-2026-08-07.txt` 随之删除。
// 一个恒为空的基线不需要 diff 机制,只需要一句"不许有红"。
//
// 保留的是两道**防呆**:输出解析不出来 / 检查器没跑到底,都按红处理 —— 假绿比红危险。
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 检查脚本给失败行上了色,而且色码在被管道接走时照样写出来(它不判 isTTY)。
// 于是每条红实际长这样:`ESC[0m ESC[31m [boundary] failed: … ESC[0m` —— 裸的
// startsWith 一条都对不上,曾经因此整份基线被当成「已治愈」。那不是绿,是根本没在看。
//
// 剥的是整条 CSI 序列(连 ESC 字节一起):只剥 `[31m` 会把 ESC 留在行首行尾。
// 正则用 fromCharCode 拼,免得源码里塞一个看不见的控制字符。
const ANSI_CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

const FAILURE_PREFIX = '[boundary] failed:'
const COMPLETION_MARKER = '[boundary] complete:'

function failuresOf(text) {
  return [
    ...new Set(
      text
        .split('\n')
        .map(line => line.replace(ANSI_CSI, '').trimEnd())
        // includes 而不是 startsWith:剥完仍可能有残留前缀(缩进之类),而这条前缀
        // 本身已经足够独一无二。
        .filter(line => line.includes(FAILURE_PREFIX))
        // 归一到前缀处再截。
        .map(line => line.slice(line.indexOf(FAILURE_PREFIX))),
    ),
  ]
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

// 半程运行是假绿里最阴的一种:检查器崩在中途时,崩之前那段输出看着完全正常,
// 后半程所有检查连跑都没跑。检查器在末尾无条件打一行 complete;没有它就不认。
if (!output.includes(COMPLETION_MARKER)) {
  console.error('[boundary-gate] 检查器没跑到底(缺 complete 标记)—— 中途崩了,这次结果不算数:')
  console.error(output.slice(-2000))
  process.exit(1)
}

// 一条 ok 都没有 = 输出格式变了 / 正则失配 / 脚本没真的跑。当硬错处理,别让它冒充绿。
if (!output.includes('[boundary] ok:')) {
  console.error('[boundary-gate] 解析不出任何检查结果 —— 输出格式变了或脚本没跑,不认这次结果:')
  console.error(output.slice(-2000))
  process.exit(1)
}

const failures = failuresOf(output)

if (failures.length > 0) {
  console.error(`[boundary-gate] ${failures.length} boundary failure(s) —— 零基线硬门,一条都不许有:`)
  for (const line of failures) console.error('  +', line)
  process.exit(1)
}

console.log('[boundary-gate] ok — 0 boundary failures')
