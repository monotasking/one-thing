#!/usr/bin/env node
// `bun run memory:report` —— 问正在服务这个 store 的 core 要一份内存预算表。
//
// 读 `<store>/run/http.json`(谁在服务这个 store 谁写它:桌面或 server:start),
// 走通用 `POST /api/rpc` 的 `memory.report`。按进程、按持有者各打一张表。
//
//   bun run memory:report              # 打表
//   bun run memory:report --json       # 原样 JSON
//   bun run memory:report --trim       # 先叫一次 hard 松手,再打表(需本机可信的 core)
//   bun run memory:report --trim soft
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
  process.stderr.write(`没有正在服务 ${storePath} 的 core(读不到 ${discoveryFile})。先把桌面或 server:start 起来。\n`)
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
// 管道那头先关了(`| head`)就安静退出,不打一屏 EPIPE。
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
    out(`松手(${trimmed.pressure}):释放 ${trimmed.releasedEntries} 条,约 ${mb(trimmed.releasedBytes)}`)
    for (const row of trimmed.holders) out(`  ${pad(row.id, 26)} ${row.releasedEntries}${row.error ? `  ✗ ${row.error}` : ''}`)
    out('')
  }
  out(`总计 ${mb(report.totalBytes)}${report.partial ? '(有进程量不到,偏小)' : ''}  ·  预算 soft ${mb(report.budget.softBytes)} / hard ${mb(report.budget.hardBytes)}`)
  out(`core 堆:已用 ${mb(report.heap.usedBytes)} / ${mb(report.heap.totalBytes)},external ${mb(report.heap.externalBytes)}`)
  out('')
  out('进程')
  for (const row of [...report.processes].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))) {
    out(`  ${pad(row.pid, 8)} ${pad(row.kind, 9)} ${pad(mb(row.bytes), 11)} ${row.name}`)
  }
  out('')
  out('持有者')
  for (const row of report.holders) {
    const limit = row.limit ? ` / 上限 ${row.limit.entries ?? '—'}${row.limit.bytes ? `, ${mb(row.limit.bytes)}` : ''}` : ''
    const detail = row.detail ? `  ${Object.entries(row.detail).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''
    out(`  ${pad(row.id, 26)} ${row.entries} ${row.unit}${row.bytes !== undefined ? ` ≈ ${mb(row.bytes)}` : ''}${limit}${detail}${row.error ? `  ✗ ${row.error}` : ''}`)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
