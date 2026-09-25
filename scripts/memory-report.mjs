#!/usr/bin/env node
// `bun run memory:report`:显示正在运行的 onething 的内存占用,按进程和缓存分别列出。
//
// 从 `<store>/run/http.json` 读取服务地址与令牌,调用 `memory.report` 接口。
//
//   bun run memory:report              # 输出表格
//   bun run memory:report --json       # 输出原始 JSON
//   bun run memory:report --trim       # 先释放缓存(硬上限档),再输出表格
//   bun run memory:report --trim soft  # 按软上限档释放
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const json = args.includes('--json')
const trimIndex = args.indexOf('--trim')
const trimPressure = trimIndex === -1 ? null : (args[trimIndex + 1] === 'soft' ? 'soft' : 'hard')

const storePath = process.env.ONETHING_STORE_PATH || path.join(os.homedir(), '.onething')
const discoveryFile = path.join(storePath, 'run', 'http.json')

let discovery
try {
  discovery = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'))
} catch {
  process.stderr.write(`未找到正在运行的 onething(无法读取 ${discoveryFile})。请先启动桌面应用或 server:start。\n`)
  process.exit(1)
}

const base = `http://${discovery.host && discovery.host !== '0.0.0.0' ? discovery.host : '127.0.0.1'}:${discovery.port}`
async function rpc(method, payload = {}) {
  const response = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(discovery.token ? { authorization: `Bearer ${discovery.token}` } : {}),
    },
    body: JSON.stringify({ domain: 'memory', method, payload }),
  })
  if (!response.ok) throw new Error(`memory.${method} HTTP ${response.status}`)
  const body = await response.json()
  if (!body || body.ok !== true) throw new Error(`memory.${method}: ${body?.error?.message ?? JSON.stringify(body)}`)
  return body.data
}

const mb = bytes => (typeof bytes === 'number' ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '—')
const pad = (value, width) => String(value).padEnd(width)
// 输出被管道提前关闭时(如 `| head`)直接退出。
process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(0); throw error })
const out = line => process.stdout.write(`${line}\n`)

try {
  const trimmed = trimPressure ? await rpc('trim', { pressure: trimPressure }) : null
  const report = await rpc('report')
  if (json) {
    out(JSON.stringify({ trimmed, report }, null, 2))
    process.exit(0)
  }
  if (trimmed) {
    out(`已释放缓存(${trimmed.pressure === 'soft' ? '软上限档' : '硬上限档'}):${trimmed.releasedEntries} 项,约 ${mb(trimmed.releasedBytes)}`)
    for (const row of trimmed.holders) out(`  ${pad(row.id, 26)} ${row.releasedEntries}${row.error ? `  ✗ ${row.error}` : ''}`)
    out('')
  }
  out(`总占用 ${mb(report.totalBytes)}${report.partial ? '(部分进程无法测量,总量偏低)' : ''}  ·  软上限 ${mb(report.budget.softBytes)}  ·  硬上限 ${mb(report.budget.hardBytes)}`)
  out(`主进程 JS 堆:已用 ${mb(report.heap.usedBytes)} / ${mb(report.heap.totalBytes)},堆外 ${mb(report.heap.externalBytes)}`)
  out('')
  out('进程')
  for (const row of [...report.processes].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))) {
    out(`  ${pad(row.pid, 8)} ${pad(row.kind, 9)} ${pad(mb(row.bytes), 11)} ${row.name}`)
  }
  out('')
  out('缓存')
  for (const row of report.holders) {
    const limit = row.limit ? ` / 上限 ${row.limit.entries ?? '—'}${row.limit.bytes ? `, ${mb(row.limit.bytes)}` : ''}` : ''
    const detail = row.detail ? `  ${Object.entries(row.detail).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''
    out(`  ${pad(row.id, 26)} ${row.entries} ${row.unit}${row.bytes !== undefined ? ` ≈ ${mb(row.bytes)}` : ''}${limit}${detail}${row.error ? `  ✗ ${row.error}` : ''}`)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
