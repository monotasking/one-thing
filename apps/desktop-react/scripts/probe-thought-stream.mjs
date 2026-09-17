/**
 * 探针(2026-09-14,不进 verify):**思考流按真实节奏喂进来,屏幕跟不跟得上、抖不抖**。
 *
 * 起因:用户录屏(会话 cd4351d3,deepseek-v4-flash 第 166 号请求)里流每秒到 ~404 个
 * token(≈150 段 `OK.\n\n`),屏幕每秒只画 1–2 段,且并排帧里有「最后半行消失、整体
 * 下移一段、再长回来」的形。录屏内容周期重复,像素法量不准,所以在真机上按同一节奏
 * 重放,直接读 DOM。
 *
 * 量什么(页面里每一帧一采):
 *   · 思考段的字数(`[data-testid="chat-thought"]` 的 textContent)与 `<p>` 数
 *   · 滚动容器的 scrollTop / scrollHeight / clientHeight
 * 报什么:
 *   · 上屏滞后:发出第 N 个字的时刻 vs 屏幕上出现第 N 个字的时刻(p50 / p95 / 最大)
 *   · 缩水:字数或 scrollHeight 比上一帧**小**的帧数(= 用户看到的「上下抖」)
 *   · 离底:流式中 gap > 2px 的帧数与最长连续时长(贴底该恒为 0)
 *   · 长帧:相邻两次 rAF 间隔 > 50ms 的次数
 *   · 水位表计数:`window.__perf.dump()` 里 stream.water.* 那几格
 *
 * 用法:先 `npm run build`(渲染层)且仓根有 `dist/server/main.js`,然后
 *   node scripts/probe-thought-stream.mjs [--tps=404] [--seconds=40]
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

/** `PROBE_APP_ROOT` 可以指到另一份构建(反证:分块流式之前的那一版壳)。 */
const appRoot = process.env.PROBE_APP_ROOT
  ? path.resolve(process.env.PROBE_APP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? Number(hit.slice(name.length + 3)) : fallback
}
const TPS = arg('tps', 404)
const SECONDS = arg('seconds', 40)
const MARKER = '@@probe-thought@@'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ── 与录屏同形的 token 流:分词器切法,循环 ────────────────────────────── */
const PROSE = 'Confirmed both hypotheses:\n\n**A) MBG handler case**: `routeTo=""`, and ALL sip_h_* empty. Hmm. Let me check the current siteHandlers.LA in the repo.\n\nLet me go.\n\n'
const PROSE_TOKENS = PROSE.match(/[^\s]+|\s+/g) ?? []
const LOOP = ['OK', '.\n\n', 'E', 'mit', '.\n\n', 'OK', '.\n\n', 'Let', ' me', ' go', '.\n\n']
function* tokens(total) {
  let n = 0
  for (const t of PROSE_TOKENS) { if (n++ >= total) return; yield t }
  while (n < total) { for (const t of LOOP) { if (n++ >= total) return; yield t } }
}

function startMockProvider(port, state) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* 兜底 */ }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const flat = messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))).join('\n')
      const send = obj => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`) }
      const frame = (delta, finish = null, usage) => ({
        id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
      })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const measured = flat.includes(MARKER) && !state.served
      if (!measured) {
        send(frame({}, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      state.served = true
      state.startAt = Date.now()
      const total = Math.round(TPS * SECONDS)
      // 每 10ms 一小批(TPS/100 个 token),每个 token 一帧 SSE —— 与真 provider 同形。
      const perTick = Math.max(1, Math.round(TPS / 100))
      let chars = 0
      let count = 0
      const it = tokens(total)
      while (true) {
        if (res.destroyed) return
        let done = false
        for (let i = 0; i < perTick; i += 1) {
          const next = it.next()
          if (next.done) { done = true; break }
          send(frame({ reasoning_content: next.value }))
          chars += next.value.length
          count += 1
        }
        state.emitted.push([Date.now(), chars])
        if (done) break
        await delay(10)
      }
      state.doneAt = Date.now()
      state.tokens = count
      state.chars = chars
      send(frame({ content: '思考结束,下面是结论。' }))
      send(frame({}, 'stop', { prompt_tokens: 100, completion_tokens: count, total_tokens: 100 + count, completion_tokens_details: { reasoning_tokens: count } }))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

function settingsFor(mockPort) {
  return {
    ai: {
      provider: 'deepseek',
      providers: {
        deepseek: {
          baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: 'deepseek-chat', selectedModels: ['deepseek-chat'], enabled: true,
          modelCapabilitiesByModel: { 'deepseek-chat': { tools: true, reasoning: true, vision: false } },
        },
      },
      customProviders: [], modelCatalog: {},
    },
    tools: { enableToolCalls: true, permissionMode: 'dangerously-allow-all', tools: {} },
    chat: { contextCompactEnabled: false },
    diagnostics: { enabled: false },
  }
}

function readDiscovery(store) {
  try { return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8')) } catch { return undefined }
}
function portConnects(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = v => { socket.destroy(); resolve(v) }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true)); socket.once('timeout', () => settle(false)); socket.once('error', () => settle(false))
  })
}
async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) { last = await predicate(); if (last) return last; await delay(100) }
  throw new Error(`超时(${timeoutMs}ms)等待:${label};最后一次读数:${JSON.stringify(last)}`)
}
async function rpc(record, domain, method, payload = {}) {
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${record.token}` },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  const body = await response.json()
  if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  return body.data
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

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }

async function main() {
  if (!existsSync(serverEntry)) throw new Error('缺 dist/server/main.js —— 仓根 `bun run server:build`')
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) throw new Error('缺构建产物 —— `npm run build` / `npm run electron:build`')
  const store = await mkdtemp(path.join(tmpdir(), 'probe-thought-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'probe-thought-userdata-'))
  const state = { served: false, startAt: 0, doneAt: 0, tokens: 0, chars: 0, emitted: [] }
  let server, app, mock
  try {
    const mockPort = 45100 + Math.floor(Math.random() * 400)
    mock = await startMockProvider(mockPort, state)
    writeFileSync(path.join(store, 'settings.json'), JSON.stringify(settingsFor(mockPort), null, 2), 'utf-8')
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot, env: { ...process.env, ONETHING_STORE_PATH: store, DEEPSEEK_API_KEY: 'sk-probe' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', c => serverErr.push(c.toString()))
    const rec = await waitFor('core 写出发现文件', () => { const f = readDiscovery(store); return f && f.pid === server.pid ? f : undefined })
      .catch(e => { throw new Error(`${e.message}\nserver stderr:\n${serverErr.join('')}`) })
    if (!(await portConnects(rec.host, rec.port))) throw new Error('core 端口连不上')
    const created = await rpc(rec, 'sessions', 'create', { name: 'probe-thought' })
    const sessionId = created?.session?.id
    if (!sessionId) throw new Error('sessions.create 没给 id')
    console.log(`[probe] core 起来了(port ${rec.port}),会话 ${sessionId}`)

    app = await electron.launch({
      executablePath: electronBinary, args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '', ONETHING_GATE_OFFSCREEN: '1' },
    })
    const page = await app.firstWindow()
    const appErr = []
    app.process().stderr?.on('data', c => appErr.push(c.toString()))
    app.process().stdout?.on('data', c => appErr.push(c.toString()))
    page.on('crash', () => { state.crashedAt = Date.now(); console.log(`[probe] 渲染进程崩了(流式开始后 ${((Date.now() - state.startAt) / 1000).toFixed(1)}s)`) })
    page.on('close', () => { state.closedAt = Date.now(); console.log(`[probe] 页面关闭(流式开始后 ${((Date.now() - state.startAt) / 1000).toFixed(1)}s)`) })
    state.appErr = appErr
    await waitFor('渲染层完成一次 RPC 往返', async () => { const v = await page.evaluate(() => window.__d0 ?? null); return v && v.rpcOk ? v : undefined })
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await enterSession(page, sessionId)
    console.log('[probe] 壳离屏起好,会话已打开')

    // 页面内采样器:每帧一采。
    await page.evaluate(() => {
      const samples = []
      let scroller = null
      const findScroller = el => { let n = el; while (n && n !== document.body) { const o = getComputedStyle(n).overflowY; if (o === 'auto' || o === 'scroll') return n; n = n.parentElement } return null }
      let last = performance.now()
      const tick = () => {
        const now = performance.now()
        const el = document.querySelector('[data-testid="chat-thought"]')
        if (el && !scroller) scroller = findScroller(el)
        const ps = el ? el.querySelectorAll('p') : []
        samples.push({
          t: now, dt: now - last,
          chars: el ? (el.textContent ?? '').length : -1,
          p: ps.length,
          tail: ps.length ? (ps[ps.length - 1].textContent ?? '').length : 0,
          expanded: el ? el.getAttribute('aria-expanded') : null,
          st: scroller ? scroller.scrollTop : -1, sh: scroller ? scroller.scrollHeight : -1, ch: scroller ? scroller.clientHeight : -1,
          wall: Date.now(),
        })
        last = now
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      window.__probeSamples = samples
    })

    await rpc(rec, 'session-command', 'emit', { sessionId, command: { type: 'command:send-message', content: `${MARKER} 请仔细想一想` } })
    await waitFor('假 provider 开始吐', () => state.startAt > 0, 30_000)
    console.log(`[probe] 开始流式:目标 ${TPS} token/s × ${SECONDS}s`)
    // 流式期间每 2s 把采样搬回 node 一份:页面崩了也留得住读数。
    let samples = []
    let perf = 'null'
    const pull = async () => {
      try {
        const got = await page.evaluate(n => window.__probeSamples.slice(n), samples.length)
        samples = samples.concat(got)
        const last = samples[samples.length - 1]
        if (last) console.log(`[probe] +${((Date.now() - state.startAt) / 1000).toFixed(0)}s 屏幕 ${last.chars} 字 / <p> ${last.p} / 发出 ${state.emitted[state.emitted.length - 1]?.[1] ?? 0} 字 / 采样 ${samples.length} 帧`)
      } catch { /* 页面没了 */ }
    }
    const deadline = Date.now() + (SECONDS + 60) * 1000
    while (state.doneAt === 0 && !state.crashedAt && !state.closedAt && Date.now() < deadline) { await delay(2000); await pull() }
    if (state.doneAt > 0) {
      await waitFor('思考段收尾折回', () => page.evaluate(() => { const el = document.querySelector('[data-testid="chat-thought"]'); return el ? el.getAttribute('aria-expanded') !== 'true' : false }), 60_000).catch(() => {})
      await delay(500)
      await pull()
      try { perf = await page.evaluate(() => { try { return JSON.stringify(window.__perf?.dump?.() ?? null) } catch (e) { return String(e) } }) } catch { /* */ }
    } else {
      console.log(`[probe] 流没吐完就停了:crashed=${Boolean(state.crashedAt)} closed=${Boolean(state.closedAt)};electron 输出尾巴:\n${state.appErr.slice(-12).join('')}`)
      if (!state.doneAt) state.doneAt = Date.now()
    }

    /* ── 分析 ─────────────────────────────────────────────────────────── */
    const emitted = state.emitted // [wallMs, cumChars]
    const live = samples.filter(s => s.expanded === 'true' && s.wall >= state.startAt && s.wall <= state.doneAt + 100)
    const frameGaps = live.map(s => s.dt)
    const long = frameGaps.filter(d => d > 50).length
    // 滞后:屏幕上第 N 个字出现时刻 − 它被发出时刻。
    const lags = []
    let ei = 0
    for (const s of live) {
      if (s.chars <= 0) continue
      // 屏幕字数 = 思考段全文(含 preview 时不在 live 里),找到发出到达该字数的时刻
      while (ei < emitted.length && emitted[ei][1] < s.chars) ei += 1
      const emitAt = ei < emitted.length ? emitted[ei][0] : emitted[emitted.length - 1][0]
      lags.push(s.wall - emitAt)
      ei = Math.max(0, ei - 1)
    }
    // 屏幕上的字数 vs 发出字数:最大落后多少字
    const behind = live.map(s => { let e = 0; for (let i = emitted.length - 1; i >= 0; i -= 1) { if (emitted[i][0] <= s.wall) { e = emitted[i][1]; break } } return e - s.chars })
    let shrinkChars = 0, shrinkHeight = 0, offBottom = 0, offBottomMaxRun = 0, run = 0, maxGap = 0
    for (let i = 1; i < live.length; i += 1) {
      const a = live[i - 1], b = live[i]
      if (b.chars < a.chars) shrinkChars += 1
      if (b.sh < a.sh) shrinkHeight += 1
      const gap = b.sh - b.ch - b.st
      if (gap > 2) { offBottom += 1; run += 1; offBottomMaxRun = Math.max(offBottomMaxRun, run); maxGap = Math.max(maxGap, gap) } else run = 0
    }
    const durationS = (state.doneAt - state.startAt) / 1000
    const lastLive = live[live.length - 1]
    console.log('\n===== 读数 =====')
    console.log(`发出:${state.tokens} token / ${state.chars} 字,用时 ${durationS.toFixed(1)}s(${(state.tokens / durationS).toFixed(0)} token/s)`)
    console.log(`流式期间采样帧:${live.length},帧间隔 p50 ${pct(frameGaps, 0.5).toFixed(1)}ms / p95 ${pct(frameGaps, 0.95).toFixed(1)}ms / 最长 ${Math.max(...frameGaps).toFixed(0)}ms,>50ms 长帧 ${long} 次`)
    console.log(`上屏滞后:p50 ${pct(lags, 0.5)}ms / p95 ${pct(lags, 0.95)}ms / 最大 ${Math.max(...lags)}ms;落后字数最大 ${Math.max(...behind)} 字(流末尾屏幕 ${lastLive?.chars} 字 / 发出 ${state.chars} 字)`)
    console.log(`<p> 数:${live[0]?.p} → ${lastLive?.p},活动尾最长 ${Math.max(...live.map(s => s.tail))} 字`)
    console.log(`缩水帧:字数变少 ${shrinkChars} 次,scrollHeight 变小 ${shrinkHeight} 次`)
    console.log(`离底帧(gap>2px):${offBottom} 帧,最长连续 ${offBottomMaxRun} 帧,最大 gap ${maxGap.toFixed(0)}px`)
    console.log(`__perf 里 water 相关:${(perf.match(/"[^"]*water[^"]*":\s*[^,}]*/g) ?? []).join('  ') || '(没有 water 计数)'}`)
    // 落后曲线:每 5s 一行
    console.log('\n时间(s)  发出字数  屏幕字数  落后字数')
    for (let sec = 0; sec <= Math.ceil(durationS); sec += 5) {
      const wall = state.startAt + sec * 1000
      let e = 0; for (const [t, c] of emitted) { if (t <= wall) e = c; else break }
      let s = live.find(x => x.wall >= wall)
      console.log(String(sec).padStart(6), String(e).padStart(9), String(s?.chars ?? '-').padStart(9), String(s ? e - s.chars : '-').padStart(9))
    }
    writeFileSync(path.join(tmpdir(), 'probe-thought-samples.json'), JSON.stringify({ emitted, samples, perf }), 'utf-8')
    console.log(`\n原始采样写在 ${path.join(tmpdir(), 'probe-thought-samples.json')}`)
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
