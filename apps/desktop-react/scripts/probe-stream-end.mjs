/**
 * 探针(2026-09-14,不进 verify):**一条完整的流式消息,每个阶段边界上 UI 有没有跳**。
 *
 * 流的形:思考 → 工具调用(参数逐片流)→ 工具结果 → 第二段思考 → markdown 正文 → 收尾。
 * 页面里每帧一采,记:
 *   · 最后一条助手消息里 **新建 / 移除** 的元素节点数(重挂 = 一批同时移除又新建)
 *   · 锚点位移:最后一条**用户**消息的 top(内容整体上下挪就在这一格)
 *   · 滚动几何(scrollTop / scrollHeight / clientHeight / gap)
 *   · 思考段 aria-expanded、整条消息字数、`p / pre / li` 数、工具卡数
 * 报每个边界前后 1s 的帧,以及全程「锚点挪动 >2px」「scrollHeight 变小」「重挂爆发」的帧。
 *
 * 用法:node scripts/probe-stream-end.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'

const appRoot = process.env.PROBE_APP_ROOT
  ? path.resolve(process.env.PROBE_APP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')
const MARKER = '@@probe-end@@'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const LOOP = ['OK', '.\n\n', 'E', 'mit', '.\n\n', 'Let', ' me', ' go', '.\n\n', 'Hmm', ',', ' the', ' test', ' needs', ' lua', '5', '.', '4', '.\n\n']
function* loopTokens(total) { let n = 0; while (n < total) for (const t of LOOP) { if (n++ >= total) return; yield t } }
const ANSWER = [
  '两个差异都定位清楚了(都是**测试用例本身的问题**,不是代码问题):\n\n',
  '## 差异一:MBG handler\n\n',
  '- `routeTo` 为空时应走 `Refer`,用例里期望的是 `CallFlowKafkaWrite`。\n',
  '- 修法:把用例第 12 行的期望换成 `Refer(\"ServiceRequest\", …)`。\n\n',
  '```lua\nlocal function handle(config)\n  if config.routeTo == "" then\n    Refer(intent, config.language, config.site)\n    return false\n  end\n  return true\nend\n```\n\n',
  '## 差异二:FAC 单条用例\n\n',
  '单条 FAC 用例单独跑**通过了**,批量跑失败是因为 `SITE_NODE` 缺 LA 国家,已在 0928 分支补上。\n\n',
  '| 用例 | 单跑 | 批量 |\n| --- | --- | --- |\n| MBG | 过 | 过 |\n| FAC | 过 | 失败 → 已修 |\n\n',
  '下一步:把两条用例的期望改掉,重跑 `nlp_test.lua`,确认 `ALL REFER PARAMETERS MATCH XLSX`。\n',
].join('')

function startMockProvider(port, state) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* */ }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const flat = messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))).join('\n')
      const send = obj => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`) }
      const frame = (delta, finish = null, usage) => ({
        id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
      })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const mine = flat.includes(MARKER)
      const lastUser = messages.map(m => m.role).lastIndexOf('user')
      const toolTurns = messages.slice(lastUser + 1).filter(m => m.role === 'tool').length
      if (!mine || state.phase === 'done') {
        send(frame({}, 'stop')); res.write('data: [DONE]\n\n'); res.end(); return
      }
      const mark = name => { state.marks.push([name, Date.now()]); console.log(`[mock] ${name} @ +${((Date.now() - state.marks[0][1]) / 1000).toFixed(1)}s`) }
      if (toolTurns === 0) {
        state.phase = 'r1'
        mark('reasoning1:start')
        for (const t of loopTokens(6000)) { if (res.destroyed) return; send(frame({ reasoning_content: t })); await delay(2.5) }
        mark('reasoning1:end')
        // 工具调用:参数逐片流(内建 time 工具,零副作用;多余的键会被 zod strip)。
        send(frame({ tool_calls: [{ index: 0, id: 'call_probe_0', type: 'function', function: { name: 'time', arguments: '' } }] }))
        const args = JSON.stringify({ note: 'x'.repeat(400), timezone: 'Asia/Shanghai' })
        for (let i = 0; i < args.length; i += 8) { send(frame({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 8) } }] })); await delay(10) }
        mark('toolcall:end')
        send(frame({}, 'tool_calls', { prompt_tokens: 100, completion_tokens: 6100, total_tokens: 6200 }))
        res.write('data: [DONE]\n\n'); res.end()
        return
      }
      state.phase = 'r2'
      mark('reasoning2:start')
      for (const t of loopTokens(1500)) { if (res.destroyed) return; send(frame({ reasoning_content: t })); await delay(2.5) }
      mark('reasoning2:end')
      mark('text:start')
      for (let i = 0; i < ANSWER.length; i += 12) { if (res.destroyed) return; send(frame({ content: ANSWER.slice(i, i + 12) })); await delay(10) }
      mark('text:end')
      send(frame({}, 'stop', { prompt_tokens: 100, completion_tokens: 2000, total_tokens: 2100 }))
      res.write('data: [DONE]\n\n'); res.end()
      state.phase = 'done'
      mark('stop:sent')
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

function settingsFor(mockPort) {
  return {
    ai: { provider: 'deepseek', providers: { deepseek: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: 'deepseek-chat', selectedModels: ['deepseek-chat'], enabled: true, modelCapabilitiesByModel: { 'deepseek-chat': { tools: true, reasoning: true, vision: false } } } }, customProviders: [], modelCatalog: {} },
    tools: { enableToolCalls: true, permissionMode: 'dangerously-allow-all', tools: {} },
    chat: { contextCompactEnabled: false },
    diagnostics: { enabled: false },
  }
}
function readDiscovery(store) { try { return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8')) } catch { return undefined } }
function portConnects(host, port) {
  return new Promise(resolve => { const s = connect({ host, port }); const settle = v => { s.destroy(); resolve(v) }; s.setTimeout(500); s.once('connect', () => settle(true)); s.once('timeout', () => settle(false)); s.once('error', () => settle(false)) })
}
async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs; let last
  while (Date.now() < deadline) { last = await predicate(); if (last) return last; await delay(100) }
  throw new Error(`超时(${timeoutMs}ms)等待:${label};最后一次读数:${JSON.stringify(last)}`)
}
async function rpc(record, domain, method, payload = {}) {
  const r = await fetch(`http://${record.host}:${record.port}/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${record.token}` }, body: JSON.stringify({ domain, method, payload }) })
  if (!r.ok) throw new Error(`rpc ${domain}.${method} HTTP ${r.status}`)
  const b = await r.json(); if (!b || b.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(b?.error ?? b)}`)
  return b.data
}
async function clickTestId(page, testId) {
  const ok = await page.evaluate(id => { const el = document.querySelector(`[data-testid="${id}"]`); if (!el) return false; el.click(); return true }, testId)
  if (!ok) throw new Error(`点不到:[data-testid="${testId}"]`)
}
async function enterSession(page, sessionId) {
  const there = () => page.evaluate(id => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId)
  for (let attempt = 0; attempt < 2; attempt += 1) { if (await there()) break; await clickTestId(page, 'dock-tile-sessions'); await delay(600) }
  await waitFor('总览画出那一行', there)
  await clickTestId(page, `session-row-${sessionId}`)
  await waitFor('聊天区起底', () => page.evaluate(() => Boolean(document.querySelector('[data-testid="chat-stream"]'))))
}

async function main() {
  if (!existsSync(serverEntry) || !existsSync(mainEntry)) throw new Error('缺构建产物')
  const store = await mkdtemp(path.join(tmpdir(), 'probe-end-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'probe-end-userdata-'))
  const state = { phase: 'idle', marks: [] }
  let server, app, mock
  try {
    const mockPort = 45600 + Math.floor(Math.random() * 300)
    mock = await startMockProvider(mockPort, state)
    writeFileSync(path.join(store, 'settings.json'), JSON.stringify(settingsFor(mockPort), null, 2), 'utf-8')
    server = spawn(process.execPath, [serverEntry], { cwd: repoRoot, env: { ...process.env, ONETHING_STORE_PATH: store, DEEPSEEK_API_KEY: 'sk-probe' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const serverErr = []; server.stderr.on('data', c => serverErr.push(c.toString()))
    const rec = await waitFor('core 写出发现文件', () => { const f = readDiscovery(store); return f && f.pid === server.pid ? f : undefined }).catch(e => { throw new Error(`${e.message}\n${serverErr.join('')}`) })
    if (!(await portConnects(rec.host, rec.port))) throw new Error('core 端口连不上')
    const sessionId = (await rpc(rec, 'sessions', 'create', { name: 'probe-end' }))?.session?.id
    if (!sessionId) throw new Error('sessions.create 没给 id')
    app = await electron.launch({ executablePath: electronBinary, args: [mainEntry, `--user-data-dir=${userDataDir}`], env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '', ONETHING_GATE_OFFSCREEN: '1' } })
    const page = await app.firstWindow()
    page.on('crash', () => console.log('[probe] 渲染进程崩了'))
    await waitFor('渲染层完成一次 RPC 往返', async () => { const v = await page.evaluate(() => window.__d0 ?? null); return v && v.rpcOk ? v : undefined })
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await enterSession(page, sessionId)
    console.log(`[probe] 壳离屏起好,会话 ${sessionId}`)

    await page.evaluate(() => {
      const samples = []
      const tracked = new Set()
      let scroller = null
      const findScroller = el => { let n = el; while (n && n !== document.body) { const o = getComputedStyle(n).overflowY; if (o === 'auto' || o === 'scroll') return n; n = n.parentElement } return null }
      let last = performance.now()
      const tick = () => {
        const now = performance.now()
        const rows = document.querySelectorAll('[data-testid="chat-stream"] [data-message-id]')
        const lastRow = rows[rows.length - 1] ?? null
        const anchorRow = rows.length >= 2 ? rows[rows.length - 2] : null
        if (lastRow && !scroller) scroller = findScroller(lastRow)
        let created = 0, removed = 0
        if (lastRow) {
          for (const el of lastRow.querySelectorAll('*')) { if (!tracked.has(el)) { tracked.add(el); created += 1 } }
          for (const el of tracked) { if (!el.isConnected) { tracked.delete(el); removed += 1 } }
        }
        const thought = lastRow?.querySelector('[data-testid="chat-thought"]') ?? null
        const thoughts = lastRow ? lastRow.querySelectorAll('[data-testid="chat-thought"]').length : 0
        samples.push({
          t: now, dt: now - last, wall: Date.now(),
          chars: lastRow ? (lastRow.textContent ?? '').length : -1,
          nodes: lastRow ? lastRow.querySelectorAll('*').length : -1,
          created, removed,
          p: lastRow ? lastRow.querySelectorAll('p').length : 0,
          pre: lastRow ? lastRow.querySelectorAll('pre').length : 0,
          li: lastRow ? lastRow.querySelectorAll('li').length : 0,
          thoughts, expanded: thought ? thought.getAttribute('aria-expanded') : null,
          anchorTop: anchorRow ? Math.round(anchorRow.getBoundingClientRect().top) : null,
          lastTop: lastRow ? Math.round(lastRow.getBoundingClientRect().top) : null,
          lastH: lastRow ? Math.round(lastRow.getBoundingClientRect().height) : null,
          st: scroller ? scroller.scrollTop : -1, sh: scroller ? scroller.scrollHeight : -1, ch: scroller ? scroller.clientHeight : -1,
        })
        last = now
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      window.__probeSamples = samples
    })

    // 首帧那一采是空的(第一条消息还没来),记号 0 = 发送时刻。
    state.marks.push(['send', Date.now()])
    await rpc(rec, 'session-command', 'emit', { sessionId, command: { type: 'command:send-message', content: `${MARKER} 请仔细想一想再回答` } })
    await waitFor('整条流走完', () => state.phase === 'done', 120_000)
    await delay(6000) // 收尾之后再看 6s:账本结算、折回、锚点
    state.marks.push(['+6s', Date.now()])
    const samples = await page.evaluate(() => window.__probeSamples)
    writeFileSync(path.join(tmpdir(), 'probe-end-samples.json'), JSON.stringify({ marks: state.marks, samples }), 'utf-8')

    /* ── 报告 ────────────────────────────────────────────────────────── */
    const t0 = state.marks[0][1]
    const fmt = s => `${((s.wall - t0) / 1000).toFixed(2).padStart(6)}s dt=${s.dt.toFixed(0).padStart(4)} chars=${String(s.chars).padStart(6)} nodes=${String(s.nodes).padStart(5)} +${s.created}/-${s.removed} p=${s.p} pre=${s.pre} li=${s.li} thoughts=${s.thoughts} exp=${s.expanded} anchorTop=${s.anchorTop} lastTop=${s.lastTop} lastH=${s.lastH} sh=${s.sh} gap=${s.sh >= 0 ? (s.sh - s.ch - s.st).toFixed(0) : '-'}`
    console.log('\n===== 阶段边界前后各 1s 里「有事发生」的帧(节点增删 / 锚点挪 / 高度变) =====')
    for (const [name, at] of state.marks) {
      console.log(`\n── ${name} @ +${((at - t0) / 1000).toFixed(2)}s`)
      const win = samples.filter(s => Math.abs(s.wall - at) <= 1000)
      let prev = null
      for (const s of win) {
        const busy = s.created + s.removed > 0 || (prev && (s.anchorTop !== prev.anchorTop || s.sh !== prev.sh || s.expanded !== prev.expanded || s.thoughts !== prev.thoughts)) || s.dt > 50
        if (busy) console.log('  ' + fmt(s))
        prev = s
      }
    }
    console.log('\n===== 全程汇总 =====')
    let anchorMoves = 0, shrinks = 0, remountBursts = 0, longFrames = 0, offBottom = 0, maxGap = 0
    for (let i = 1; i < samples.length; i += 1) {
      const a = samples[i - 1], b = samples[i]
      if (a.anchorTop !== null && b.anchorTop !== null && Math.abs(b.anchorTop - a.anchorTop) > 2) anchorMoves += 1
      if (b.sh >= 0 && a.sh >= 0 && b.sh < a.sh) shrinks += 1
      if (b.removed >= 20 && b.created >= 20) remountBursts += 1
      if (b.dt > 50) longFrames += 1
      const gap = b.sh - b.ch - b.st
      if (b.sh >= 0 && gap > 2) { offBottom += 1; maxGap = Math.max(maxGap, gap) }
    }
    console.log(`采样 ${samples.length} 帧;锚点(上一条用户消息)挪动 >2px 的帧 ${anchorMoves};scrollHeight 变小的帧 ${shrinks};重挂爆发(同一帧 ≥20 删且 ≥20 建)${remountBursts};>50ms 长帧 ${longFrames};离底帧 ${offBottom}(最大 gap ${maxGap.toFixed(0)}px)`)
    console.log(`原始采样:${path.join(tmpdir(), 'probe-end-samples.json')}`)
  } finally {
    try { await app?.close() } catch { /* */ }
    try { server?.kill('SIGTERM') } catch { /* */ }
    try { mock?.close() } catch { /* */ }
    await delay(500)
    await rm(store, { recursive: true, force: true }).catch(() => {})
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}
main().catch(error => { console.error(`[probe] 失败:${error?.stack ?? error}`); process.exit(1) })
