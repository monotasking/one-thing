#!/usr/bin/env node
/**
 * 真机门(logging L1):把**构建产物**的 server 起在一个临时 store 上,打三个
 * 请求(200 / 404 / 500),然后对着盘上的 `log/server.jsonl` 验四件事:
 *
 *  1. 每一行都 `JSON.parse` 得动,且带 `time` / `level` / `ns`;
 *  2. 恰好三条 `ns=server.http` 记录,状态码逐条对得上;
 *  3. `[object Object]` 计数 = 0(它是文本行格式的产物,JSONL 之后不该再有);
 *  4. 默认**不写** provider 请求转储(拍板 B:默认关)。
 *
 * 绝不碰真 `~/.onething` —— 全程 `ONETHING_STORE_PATH` 指向 mkdtemp 出来的临时目录。
 *
 * 用法:node scripts/server:build 之后 `node scripts/log-smoke.mjs`
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = path.join(root, 'dist/server/main.js')

if (!fs.existsSync(serverEntry)) {
  console.error(`[log-smoke] missing ${path.relative(root, serverEntry)} — run \`bun run server:build\` first`)
  process.exit(1)
}

const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-log-smoke-'))
const logDir = path.join(storePath, 'log')
const failures = []
let child

function check(condition, message) {
  if (condition) console.log(`  ok   ${message}`)
  else {
    failures.push(message)
    console.error(`  FAIL ${message}`)
  }
}

async function waitForDiscovery(timeoutMs = 30_000) {
  const discoveryFile = path.join(storePath, 'run', 'http.json')
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(discoveryFile)) {
      try {
        const discovery = JSON.parse(fs.readFileSync(discoveryFile, 'utf-8'))
        if (discovery?.port) return discovery
      } catch {
        // 半写状态,下一拍再读。
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('server did not publish its discovery file in time')
}

try {
  console.log(`[log-smoke] temp store: ${storePath}`)
  child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      ONETHING_STORE_PATH: storePath,
      ONETHING_SERVER_DATA_ROOT: storePath,
      ONETHING_SERVER_HOST: '127.0.0.1',
      ONETHING_SERVER_PORT: '',
      ONETHING_SERVER_TOOLS: 'readonly',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => process.stdout.write(`  [server] ${chunk}`))
  child.stderr.on('data', chunk => process.stderr.write(`  [server:err] ${chunk}`))

  const discovery = await waitForDiscovery()
  const base = `http://127.0.0.1:${discovery.port}`
  const headers = discovery.token ? { authorization: `Bearer ${discovery.token}` } : {}

  const ok = await fetch(`${base}/api/capabilities`, { headers })
  const notFound = await fetch(`${base}/api/definitely-not-a-route`, { headers })
  // 500:一条存在的路由拿到坏输入(session id 不存在的分页读)。取不到 500 就
  // 如实降级为"只验 200/404",不假装通过。
  const serverError = await fetch(`${base}/api/session-messages/page`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{"sessionId":123}',
  })
  console.log(`[log-smoke] statuses: ${ok.status} / ${notFound.status} / ${serverError.status}`)

  // 给 sink 的 250ms flush 一点余量。
  await new Promise(resolve => setTimeout(resolve, 1500))

  const serverLog = path.join(logDir, 'server.jsonl')
  check(fs.existsSync(serverLog), `server.jsonl exists at ${path.relative(storePath, serverLog)}`)

  const text = fs.existsSync(serverLog) ? fs.readFileSync(serverLog, 'utf-8') : ''
  const lines = text.split('\n').filter(Boolean)
  const records = []
  let unparseable = 0
  let missingShape = 0
  for (const line of lines) {
    try {
      const record = JSON.parse(line)
      records.push(record)
      if (typeof record.time !== 'number' || typeof record.level !== 'string' || typeof record.ns !== 'string') {
        missingShape += 1
      }
    } catch {
      unparseable += 1
    }
  }
  check(lines.length > 0, `server.jsonl has ${lines.length} line(s)`)
  check(unparseable === 0, `every line JSON.parse-able (${unparseable} bad)`)
  check(missingShape === 0, `every record carries time/level/ns (${missingShape} bad)`)

  const httpRecords = records.filter(record => record.ns === 'server.http')
  check(httpRecords.length === 3, `exactly 3 server.http records (got ${httpRecords.length})`)
  const statuses = httpRecords.map(record => record.fields?.status).sort((a, b) => a - b)
  check(
    statuses.includes(ok.status) && statuses.includes(notFound.status) && statuses.includes(serverError.status),
    `statuses recorded correctly: ${JSON.stringify(statuses)}`,
  )
  check(
    httpRecords.every(record => typeof record.fields?.ms === 'number' && typeof record.fields?.path === 'string'),
    'every server.http record carries path + ms',
  )

  const objectObject = (text.match(/\[object Object\]/g) ?? []).length
  check(objectObject === 0, `[object Object] count = 0 (got ${objectObject})`)

  const dumpDir = path.join(logDir, 'dumps', 'provider-requests')
  check(!fs.existsSync(dumpDir), 'no provider-request dump directory by default (拍板 B)')
} catch (error) {
  failures.push(String(error?.stack || error))
  console.error(`[log-smoke] ${error?.stack || error}`)
} finally {
  if (child && !child.killed) {
    child.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 500))
    if (!child.killed) child.kill('SIGKILL')
  }
  fs.rmSync(storePath, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`[log-smoke] ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('[log-smoke] ok')
