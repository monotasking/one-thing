#!/usr/bin/env node
/**
 * 影子期的**性能门**(S1b,`docs/design/session-event-sourcing-2026-08.md` §10.4
 * 最后一条)。
 *
 *   bun run sessions:shadow-overhead [--tools 50] [--keep]
 *
 * 起一个临时 store + 一个假 provider(OpenAI 兼容 SSE),让一次回合里带 N 个
 * 工具调用(缺省 50),分别在**影子开**与 `ONETHING_SESSION_SHADOW=0` 下各跑一次,
 * 报四个数:
 *
 *   - `events.jsonl` 字节数与行数(账本的体量)
 *   - fsync 次数(语义检查点的真实代价)
 *   - 端到端墙钟(开 vs 关)
 *   - **主线程最长同步阻塞**:服务端进程里一个 1ms 定时器的迟到量(event-loop
 *     lag)。门是 < 16ms —— 桌面端那一帧的预算。
 *
 * 后两个数要在**服务端进程内**量,而产品代码里不该长一段只为量测存在的探针,
 * 所以探针是一个临时的 `--require` 前置脚本(见 `writeProbe`):它把
 * `fs.promises.open(...).sync` 计数,并按 200ms 把当前最大 lag 写进一个文件。
 * 产品代码一行不改。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { tools: 50, keep: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--tools') args.tools = Number(argv[++index])
    else if (arg.startsWith('--tools=')) args.tools = Number(arg.slice('--tools='.length))
    else if (arg === '--keep') args.keep = true
  }
  if (!Number.isFinite(args.tools) || args.tools < 1) args.tools = 50
  return args
}

const ARGS = parseArgs(process.argv.slice(2))

/** 服务端进程里的探针:fsync 计数 + 1ms 间隔的 event-loop lag。 */
function writeProbe(dir) {
  const target = path.join(dir, 'perf-probe.cjs')
  fs.writeFileSync(target, `
const fs = require('node:fs')
const out = process.env.ONETHING_PERF_OUT
let fsyncs = 0
let maxLag = 0
let maxLagAt = 0
let armedTime = 0
let lastTick = Date.now()

const originalOpen = fs.promises.open
fs.promises.open = async function patchedOpen(...args) {
  const handle = await originalOpen.apply(this, args)
  if (String(args[0]).endsWith('events.jsonl')) {
    const originalSync = handle.sync.bind(handle)
    handle.sync = async () => { fsyncs += 1; return originalSync() }
  }
  return handle
}

// 1ms 间隔的迟到量 = 那一刻主线程被同步代码占住了多久。
const tick = setInterval(() => {
  const now = Date.now()
  const lag = now - lastTick - 1
  if (lag > maxLag) { maxLag = lag; maxLagAt = armedTime ? now - armedTime : 0 }
  lastTick = now
}, 1)
if (tick.unref) tick.unref()

// 起服的那一段(装配、加载单文件包)本来就会把主线程占住几百毫秒,
// 而这道门问的是"一个回合最长阻塞多久"。所以量测窗口由外面的 .arm 文件
// 划开:它一出现就把 maxLag 清零,从那一刻起量的才是回合。
const armPath = out + '.arm'
let armedAt = ''
const flush = setInterval(() => {
  try {
    const arm = fs.existsSync(armPath) ? fs.readFileSync(armPath, 'utf8') : ''
    if (arm && arm !== armedAt) { armedAt = arm; maxLag = 0; maxLagAt = 0; armedTime = Date.now() }
  } catch { /* ignore */ }
  try { fs.writeFileSync(out, JSON.stringify({ fsyncs, maxLag, maxLagAt, armed: Boolean(armedAt) })) } catch { /* ignore */ }
}, 200)
if (flush.unref) flush.unref()
process.on('SIGTERM', () => {
  try { fs.writeFileSync(out, JSON.stringify({ fsyncs, maxLag, maxLagAt })) } catch { /* ignore */ }
  process.exit(0)
})
`, 'utf8')
  return target
}

function writeStore(store, mockPort) {
  fs.mkdirSync(path.join(store, 'workspaces', 'default'), { recursive: true })
  fs.writeFileSync(
    path.join(store, 'workspaces', 'default', 'providers.json'),
    JSON.stringify({
      ai: {
        provider: 'openai',
        providers: {
          openai: {
            enabled: true, apiKey: 'mock-key', baseUrl: `http://127.0.0.1:${mockPort}/v1`,
            model: 'gpt-4o', selectedModels: ['gpt-4o'],
            modelCapabilitiesByModel: { 'gpt-4o': { tools: true, vision: false, reasoning: false } },
          },
        },
        customProviders: [],
      },
    }, null, 2),
  )
  fs.writeFileSync(
    path.join(store, 'workspaces', 'default', 'credentials.json'),
    JSON.stringify({
      version: 2, encryption: 'none',
      providers: {
        openai: {
          policy: 'single',
          entries: [{ id: 'mock', label: 'mock', authType: 'apiKey', apiKey: 'mock-key', source: 'user', baseUrl: `http://127.0.0.1:${mockPort}/v1` }],
        },
      },
    }, null, 2),
  )
  fs.writeFileSync(
    path.join(store, 'settings.json'),
    JSON.stringify({ chat: { contextCompactEnabled: false }, tools: { enabled: true } }, null, 2),
  )
}

/** 一次回合 N 个工具调用,收到工具结果之后收尾。 */
function startMock(port, toolCount) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (!req.url.includes('/chat/completions')) { res.writeHead(404).end(); return }
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* ignore */ }
      const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const sawTool = messages.some(message => message.role === 'tool')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const base = { id: 'chatcmpl-perf', object: 'chat.completion.chunk', model: 'gpt-4o' }

      if (!hasTools || sawTool) {
        send({ ...base, choices: [{ index: 0, delta: { content: sawTool ? 'all done' : 'A title' } }] })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      send({ ...base, choices: [{ index: 0, delta: { content: 'running the batch' } }] })
      for (let index = 0; index < toolCount; index++) {
        send({
          ...base,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index, id: `call_perf_${index}`, type: 'function',
                function: { name: 'time', arguments: '{"action":"now"}' },
              }],
            },
          }],
        })
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

async function runOnce({ label, shadow, tools, ports, probePath }) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), `onething-perf-${label}-`))
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `onething-perf-${label}-work-`))
  writeStore(store, ports.mock)
  const perfOut = path.join(store, 'perf.json')
  const token = 'perf-token'
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  const server = spawn('node', [path.join(REPO, 'dist/server/main.js')], {
    cwd: REPO,
    env: {
      ...process.env,
      ONETHING_STORE_PATH: store,
      ONETHING_SERVER_PORT: String(ports.server),
      ONETHING_SERVER_TOOLS: 'full',
      ONETHING_SERVER_TOKEN: token,
      ONETHING_PERF_OUT: perfOut,
      NODE_OPTIONS: `--require ${probePath}`,
      ...(shadow ? {} : { ONETHING_SESSION_SHADOW: '0' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  server.stdout.on('data', d => { log += d })
  server.stderr.on('data', d => { log += d })

  let up = false
  for (let attempt = 0; attempt < 120 && !up; attempt++) {
    try {
      // P4c 第十一批:`GET /api/settings` 随 settings 四条迁 `settingsRouter` 一起删了;
      // 活性探针改用 `/api/capabilities`(与 `shadow-battery.mjs` 同一条)。
      const res = await fetch(`http://127.0.0.1:${ports.server}/api/capabilities`, { headers })
      up = res.ok
    } catch { /* not up */ }
    if (!up) await new Promise(r => setTimeout(r, 500))
  }
  if (!up) {
    server.kill('SIGKILL')
    throw new Error(`[${label}] server did not come up:\n${log.slice(-2000)}`)
  }

  const created = await (await fetch(`http://127.0.0.1:${ports.server}/api/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ name: `perf-${label}` }),
  })).json()
  const sessionId = created.session?.id ?? created.sessionId ?? created.id
  // 会话域整只迁进了 router(结构债 P4c 第五批);
  // `POST /api/sessions/:id/working-directory` 已随之删除。
  await fetch(`http://127.0.0.1:${ports.server}/api/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      domain: 'sessions',
      method: 'updateWorkingDirectory',
      payload: { sessionId, workingDirectory: workdir },
    }),
  })

  const eventsPath = path.join(store, 'sessions', sessionId, 'events.jsonl')
  // 量测窗口从这里开始:起服那几百毫秒的装配阻塞不算这道门的账。
  fs.writeFileSync(`${perfOut}.arm`, String(Date.now()), 'utf8')
  await new Promise(r => setTimeout(r, 400))
  let fsyncsBefore = 0
  try { fsyncsBefore = JSON.parse(fs.readFileSync(perfOut, 'utf8')).fsyncs ?? 0 } catch { /* none */ }
  const startedAt = Date.now()
  // 命令总线的入口是 `session-command` RPC 域(结构债 P4c 第四批);
  // `POST /api/sessions/:id/commands` 已随之删除。
  await fetch(`http://127.0.0.1:${ports.server}/api/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      domain: 'session-command',
      method: 'emit',
      payload: { sessionId, command: { type: 'command:send-message', content: `run ${tools} time checks` } },
    }),
  })

  let finishedAt = 0
  for (let attempt = 0; attempt < 600; attempt++) {
    await new Promise(r => setTimeout(r, 100))
    if (!fs.existsSync(eventsPath)) continue
    if (fs.readFileSync(eventsPath, 'utf8').includes('"run/end"')) { finishedAt = Date.now(); break }
  }

  // 影子断言排在 run/end 的 fsync 之后一个宏任务;统计表 1s 节流。
  await new Promise(r => setTimeout(r, 2000))
  server.kill('SIGTERM')
  await new Promise(r => setTimeout(r, 800))
  server.kill('SIGKILL')

  fs.writeFileSync(path.join(os.tmpdir(), `onething-perf-${label}.log`), log, 'utf8')
  const text = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8') : ''
  let probe = { fsyncs: 0, maxLag: 0 }
  try { probe = JSON.parse(fs.readFileSync(perfOut, 'utf8')) } catch { /* probe missing */ }
  let stats = {}
  try { stats = JSON.parse(fs.readFileSync(path.join(store, 'log', 'session-shadow-stats.json'), 'utf8')) } catch { /* none */ }

  const result = {
    label,
    shadow,
    wallMs: finishedAt ? finishedAt - startedAt : -1,
    eventBytes: Buffer.byteLength(text, 'utf8'),
    eventLines: text.split('\n').filter(Boolean).length,
    toolCallEvents: text.split('\n').filter(line => line.includes('"tool/call"')).length,
    fsyncs: probe.fsyncs - fsyncsBefore,
    maxBlockMs: probe.maxLag,
    maxBlockAtMs: probe.maxLagAt,
    stats,
    store,
  }
  if (!ARGS.keep) {
    fs.rmSync(store, { recursive: true, force: true })
    fs.rmSync(workdir, { recursive: true, force: true })
  }
  return result
}

const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-perf-probe-'))
const probePath = writeProbe(probeDir)
const mock = await startMock(8797, ARGS.tools)

const results = []
try {
  results.push(await runOnce({ label: 'shadow-on', shadow: true, tools: ARGS.tools, ports: { mock: 8797, server: 8798 }, probePath }))
  results.push(await runOnce({ label: 'shadow-off', shadow: false, tools: ARGS.tools, ports: { mock: 8797, server: 8798 }, probePath }))
} finally {
  mock.close()
  if (!ARGS.keep) fs.rmSync(probeDir, { recursive: true, force: true })
}

console.log(`\n[perf] one turn with ${ARGS.tools} tool calls\n`)
for (const result of results) {
  console.log(`[perf] ${result.label}`)
  console.log(`  wall time        : ${result.wallMs} ms`)
  console.log(`  events.jsonl     : ${result.eventBytes} bytes / ${result.eventLines} lines (${result.toolCallEvents} tool/call)`)
  console.log(`  fsync count      : ${result.fsyncs}`)
  console.log(`  max block (lag)  : ${result.maxBlockMs} ms (at +${result.maxBlockAtMs} ms into the turn window)`)
  console.log(`  shadow stats     : ${JSON.stringify(result.stats.runs !== undefined ? { runs: result.stats.runs, mismatches: result.stats.mismatches, appendFailures: result.stats.appendFailures } : {})}`)
}

const on = results[0]
const off = results[1]
console.log(`\n[perf] shadow overhead: ${on.wallMs - off.wallMs} ms wall (${off.wallMs > 0 ? (((on.wallMs - off.wallMs) / off.wallMs) * 100).toFixed(1) : '?'}%), max block ${on.maxBlockMs} ms vs ${off.maxBlockMs} ms`)
if (on.maxBlockMs >= 16) {
  console.error(`[perf] GATE RED: max block ${on.maxBlockMs} ms ≥ 16 ms`)
  process.exit(1)
}
console.log('[perf] GATE GREEN (max block < 16 ms)')
