#!/usr/bin/env node
/**
 * **流式时每帧的活,有多少与历史长度成正比** —— 探针(只量不判;G 线 P4-0,正本
 * `apps/desktop-react/docs/stream-geometry-2026-09.md` §21.1 Q1 / §21.2)。
 *
 * ══ 它问的那一句 ══════════════════════════════════════════════════════════
 * 同一份 delta 流分别喂**短会话**与**超量夹具**(`seed-large-ledger` 缺省档:≥50MB /
 * 400 条),逐帧把主线程的**自调时间**归到下面几格,再看哪一格 big 比 short 多出来的
 * 量与消息数 / 节点数同量级:
 *
 *   compose   —— `chat-source` 那一格 `perfSpan('chat.compose', …)` 里面
 *   assemble  —— `assemble/index` 那一格 `perfSpan('assemble', …)` 里面(含 markdown 增量解析)
 *   render    —— React 渲染期(`renderWithHooks` / `beginWork` / … 里、不在上两格里的)
 *   commit    —— React 提交期(`commitRoot` / `flush*Effects` / `commit*OnFiber` …)
 *   ro        —— ResizeObserver 回调(页面里给 `ResizeObserver` 包了一层有名字的壳)
 *   js        —— 其余 JS(SSE 解析、事件中枢、zustand 派发、…)
 *   gc        —— V8 垃圾回收
 *   style+layout —— trace 里的 `UpdateLayoutTree` / `Layout`(**含强制排版**:脚本栈上
 *               被逼出来的那一截从 JS 格里扣掉,只记在这一格)
 *   其余      —— 主线程忙着、但以上都不是的(绘制前后的原生活、任务调度、探针自己)
 *
 * ══ 量法 ══════════════════════════════════════════════════════════════════
 * CDP Tracing(抄 `gate-perf.mjs` 的 `recordTrace`),多开两条分类:
 * `disabled-by-default-v8.cpu_profiler` + `.hires`(V8 在 hires 在场时按 100µs 采样,
 * 否则 1ms —— 一帧 16ms 只够采十几下,不够分格)。于是同一条时间轴上既有事件
 * (任务 / 样式 / 排版)又有 JS 调用栈样本:
 *  · **帧** = 页面里一只常驻 rAF 环每帧打的 `performance.mark('cost:f')`,相邻两枚之间
 *    是一帧(这一帧的 rAF → 样式 → 排版 → RO → 绘制,以及紧跟着的 SSE 任务里的
 *    compose / 渲染 / 提交)。
 *  · **一个样本归哪一格**:从叶往根走它的调用栈,**碰到的第一个记号**说了算(自调
 *    时间的意思 —— 渲染期里的装配算装配,不算渲染)。`perfSpan` 那一帧看它的**调用者**
 *    在哪个文件;markdown 增量解析也是一格 `perfSpan`,它住在装配里,越过去接着走。
 *  · 样本落在一段 `Layout` / `UpdateLayoutTree` 里 → 不进 JS 格(那段时间已经记在
 *    style+layout 上)。
 * 两条近似,都写在这儿:样本权重 = 到下一个样本的间隔(V8 自己就是这么算的);
 * 「忙」= 主线程 toplevel 任务区间的并集,一段任务跨帧时按帧边界切开。
 *
 * ══ 夹具与节奏 ════════════════════════════════════════════════════════════
 * 两档同一台机器、同一个进程、同一份流:3 千字思考(每段 70 字 / 16ms,前 20 段
 * 60ms 爬坡)→ 26 段长正文(40 片 / 60ms)。每档先热身一轮(不量;起名那一发 +
 * 冷开张),再**量 3 趟取中位**(每一格的 p50 / p95 / 最大 / 整轮合计各自取中位)。
 * 超量档开量之前先等列把历史补完(抄 `gate-stream-geometry` 的 `settleBackfill`)。
 * 每档报消息数与 DOM 节点数 —— 差的那一格像不像历史长度,要拿它们对着看。
 *
 * ══ 纪律 ══════════════════════════════════════════════════════════════════
 * 与 `gate-stream-geometry` 同:屏外档(`ONETHING_GATE_OFFSCREEN=1`)、临时 store 与
 * `--user-data-dir`,**绝不连 `~/.onething`**;dev 档自起 vite(端口 5293,不是 5175);
 * 输入只走 `page.evaluate`;`finally` 里逐个收尸。**它只报不判**,退出码恒 0(除非
 * 跑不起来)。
 *
 * 跑法:`node scripts/probe-stream-cost.mjs` [`--runs 3`] [`--only short|big`] [`--keep-trace`]
 * (仓根先 `bun run server:build`;先 `npm run electron:build`。)
 */
import { spawn, execFileSync } from 'node:child_process'
import http from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { fakeProviderAiSettings, FAKE_PROVIDER_ENV } from '../../../scripts/lib/gate-fake-provider.mjs'
import { seedLargeLedger } from './lib/seed-large-ledger.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const argOf = (name) => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const RUNS = Math.max(1, Number(argOf('--runs') ?? 3))
const ONLY_LANE = argOf('--only')
const KEEP_TRACE = process.argv.includes('--keep-trace')
const DEV_PORT = Number(process.env.ONETHING_GATE_VITE_PORT ?? 5293)
const VIEWPORT = { width: 1280, height: 800 }
const FIRST_BYTE_DELAY_MS = 900

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ══ 素材(与 `gate-stream-geometry` 的 `buildThought` / `REPLY_*` 逐字同源)══════ */

function buildThought(totalChars, seed) {
  let x = seed >>> 0
  const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296 }
  const zh = '这一段是几何门造出来的思考正文它要和真数据同形所以每隔几十个字就断一次行'
  const en = ' alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu '
  const paras = []
  let total = 0
  let cursor = 0
  while (total < totalChars) {
    const lines = 4 + Math.floor(rnd() * 5)
    const rows = []
    for (let i = 0; i < lines; i += 1) {
      const width = 30 + Math.floor(rnd() * 31)
      let row = ''
      while (row.length < width) {
        row += rnd() < 0.6 ? zh.slice(cursor % zh.length) : en
        cursor += 7
      }
      rows.push(row.slice(0, width))
      total += width + 1
    }
    paras.push(rows.join('\n'))
    total += 1
  }
  return paras.join('\n\n')
}

const THOUGHT_3K = buildThought(3_000, 777)
const REPLY_PLAIN = '这是一段普通的正文回答,它要够长,好切成十几段真的流一遍,'
  + '让每一段都逼出一次提交、一次排版。第一块是一行正文 —— 和等待那一格的行高不一样,'
  + '所以换手那一帧的高度差全落在这一块身上。'
  + '再补几句把这一段撑到两三行,免得整条回答短到连座位都吃不满。'
const REPLY_LONG = Array.from({ length: 26 }, (_, i) => `第 ${i + 1} 段:${REPLY_PLAIN}`).join('\n\n')

const MARK_WARM = '@@cost-warm@@'
const MARK_RUN = '@@cost-run@@'

/* ══ 假 provider:记号决定吐什么;两档吐的是**同一份**流 ══════════════════════ */

function startProvider() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* 形状不对走兜底 */ }
      const msgs = Array.isArray(payload.messages) ? payload.messages : []
      const textOf = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''))
      let lastUser = ''
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i]?.role === 'user') { lastUser = textOf(msgs[i]); break }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = (obj) => {
        if (res.writableEnded || res.destroyed) return
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      const frame = (delta, finish = null) => ({
        id: 'chatcmpl-cost', object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: 'deepseek-chat',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const bye = () => {
        if (!res.destroyed) { send(frame({}, 'stop')); res.write('data: [DONE]\n\n') }
        res.end()
      }
      const warm = lastUser.includes(MARK_WARM)
      const run = lastUser.includes(MARK_RUN)
      if (!warm && !run) { bye(); return }
      /* 静默一段:「开张」那一闸是轮询的,要被看见的事得活得比观察它的节拍长。 */
      await delay(FIRST_BYTE_DELAY_MS)
      if (warm) {
        const text = '热身一轮,这一段不量 —— 它把起名那一发与冷开张那一段花掉。'
        for (let at = 0; at < text.length; at += 8) { send(frame({ content: text.slice(at, at + 8) })); await delay(90) }
        bye()
        return
      }
      let cursor = 0
      let parts = 0
      while (cursor < THOUGHT_3K.length) {
        if (res.destroyed) return
        send(frame({ reasoning_content: THOUGHT_3K.slice(cursor, cursor + 70) }))
        cursor += 70
        parts += 1
        await delay(parts <= 20 ? 60 : 16)
      }
      await delay(80)
      const size = Math.ceil(REPLY_LONG.length / 40)
      for (let at = 0; at < REPLY_LONG.length; at += size) {
        if (res.destroyed) return
        send(frame({ content: REPLY_LONG.slice(at, at + size) }))
        await delay(60)
      }
      bye()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/* ══ core / 发现文件 / RPC(与 `gate-stream-geometry` 同源)══════════════════ */

function readDiscovery(store) {
  const file = path.join(store, 'run', 'http.json')
  if (!existsSync(file)) return undefined
  try { return JSON.parse(readFileSync(file, 'utf-8')) } catch { return undefined }
}

function portConnects(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port }, () => { socket.destroy(); resolve(true) })
    socket.on('error', () => resolve(false))
    setTimeout(() => { socket.destroy(); resolve(false) }, 2000)
  })
}

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`等不到:${label}(${timeoutMs}ms)`)
    await delay(120)
  }
}

async function rpc(record, domain, method, payload = {}) {
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${record.token}` },
    body: JSON.stringify({ id: `cost-${Date.now()}`, domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  const body = await response.json()
  if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  return body.data
}

/* ══ 页面里的三件探针(都在门脚本里,产品代码一个字不改)═══════════════════════ */

const LEAF_PROBE = `
window.__cLeaf = function () {
  var panes = Array.prototype.slice.call(document.querySelectorAll('[data-pane-on]'))
  for (var i = 0; i < panes.length; i += 1) {
    if (panes[i].querySelector('[data-testid="chat-stream"]')
      && panes[i].querySelector('[data-testid="composer-input"]')) return panes[i]
  }
  for (var j = 0; j < panes.length; j += 1) {
    if (panes[j].querySelector('[data-testid="chat-stream"]')) return panes[j]
  }
  return document
}
`

/**
 * **ResizeObserver 回调套一层有名字的壳**,好让 CPU 样本认出「这是 RO 回调」——
 * 浏览器交付 RO 时栈底没有 JS 调用者,不包的话它只是一段无名的产品函数。
 * 必须在产品 `new ResizeObserver` 之前装:所以走 init script + 重载一次页面。
 */
const RO_WRAP = `
(function () {
  if (window.__cRoWrapped || typeof window.ResizeObserver !== 'function') return
  window.__cRoWrapped = true
  var Native = window.ResizeObserver
  window.ResizeObserver = class extends Native {
    constructor(cb) {
      super(function __costResizeObserverCallback(entries, observer) { return cb.call(this, entries, observer) })
    }
  }
})()
`

/* ══ 驱动 ══════════════════════════════════════════════════════════════════ */

async function clickTestId(page, id) {
  const ok = await page.evaluate((x) => {
    const el = document.querySelector(`[data-testid="${x}"]`)
    if (!el) return false
    el.click()
    return true
  }, id)
  if (!ok) throw new Error(`点不到 [data-testid="${id}"]`)
}

async function sendViaComposer(page, text) {
  const ok = await page.evaluate((value) => {
    const box = window.__cLeaf().querySelector('[data-testid="composer-input"]')
    if (!box) return false
    box.textContent = value
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, text)
  if (!ok) throw new Error('打不进去:没有 composer-input')
  await delay(200)
  const sent = await page.evaluate(() => {
    const send = window.__cLeaf().querySelector('[data-testid="composer-send"]')
    if (!(send instanceof HTMLElement) || send.hasAttribute('disabled')) return false
    send.click()
    return true
  })
  if (!sent) throw new Error('发送键点不动')
}

const stopShown = (page) => page.evaluate(() =>
  Boolean(window.__cLeaf().querySelector('[data-testid="chat-stream"]')
    && window.__cLeaf().querySelector('[data-testid="chat-stop"]')))

/* ══ trace ═════════════════════════════════════════════════════════════════ */

const TRACE_CATEGORIES = [
  'toplevel',
  'devtools.timeline',
  'blink.user_timing',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-v8.cpu_profiler.hires',
].join(',')

async function recordTrace(cdp, body) {
  const events = []
  const onData = (params) => { for (const e of params.value ?? []) events.push(e) }
  cdp.on('Tracing.dataCollected', onData)
  const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
  await cdp.send('Tracing.start', { transferMode: 'ReportEvents', categories: TRACE_CATEGORIES })
  await delay(150)
  const result = await body()
  await cdp.send('Tracing.end')
  await complete
  cdp.off('Tracing.dataCollected', onData)
  return { events, result }
}

/* ── 一个 CPU 样本归哪一格 ───────────────────────────────────────────────── */

const COMMIT_FRAMES = new Set([
  'commitRoot', 'commitRootImpl', 'flushMutationEffects', 'flushLayoutEffects', 'flushPassiveEffects',
  'flushPassiveEffectsImpl', 'flushSpawnedWork', 'commitMutationEffects', 'commitMutationEffectsOnFiber',
  'commitLayoutEffects', 'commitLayoutEffectOnFiber', 'commitPassiveMountEffects', 'commitPassiveMountOnFiber',
  'commitPassiveUnmountEffects', 'commitPassiveUnmountOnFiber', 'commitHookEffectListMount',
  'commitHookEffectListUnmount', 'commitBeforeMutationEffects', 'recursivelyTraverseMutationEffects',
  'recursivelyTraverseLayoutEffects', 'recursivelyTraversePassiveMountEffects', 'commitAttachRef',
])
const RENDER_FRAMES = new Set([
  'renderRootSync', 'renderRootConcurrent', 'workLoopSync', 'workLoopConcurrent',
  'workLoopConcurrentByScheduler', 'performUnitOfWork', 'beginWork', 'completeWork', 'completeUnitOfWork',
  'renderWithHooks', 'reconcileChildren', 'performWorkOnRoot', 'performSyncWorkOnRoot',
])
const CELLS = ['compose', 'assemble', 'render', 'commit', 'ro', 'js', 'gc', 'styleLayout', 'rest', 'busy']
const CELL_LABEL = {
  compose: 'chat.compose',
  assemble: 'assemble',
  render: 'React render',
  commit: 'React commit',
  ro: 'RO 回调',
  js: '其余 JS',
  gc: 'GC',
  styleLayout: 'style+layout',
  rest: '其余(原生)',
  busy: '主线程忙(合计)',
}

function classifier(nodes) {
  const memo = new Map()
  const classify = (id) => {
    if (memo.has(id)) return memo.get(id)
    const leaf = nodes.get(id)
    let answer = 'js'
    const leafName = leaf?.callFrame?.functionName ?? ''
    if (leafName === '(idle)') answer = 'idle'
    else if (leafName === '(garbage collector)') answer = 'gc'
    else if (leafName === '(program)' || leafName === '(root)') answer = 'native'
    else {
      answer = 'js'
      /*
       * **探针自己经 CDP 注进页面的那几段脚本也算 `probe`**(G 线 P4-a 补,正本 §21.6):
       * `page.evaluate` 送进来的函数没有 URL,`window.__cLeaf` 也是一段 `addInitScript`
       * 注进来的无 URL 脚本。它们在超量档每一轮扫 4 万个节点找「停止」钮在不在
       * (`querySelectorAll('[data-pane-on]')` + 几次 `querySelector`),一轮约 40ms ——
       * P4-0 那一版把它记进了「其余 JS」,§21.3 读成了 TOC 锚点扫描的一部分。
       * 判据:整条栈上**一帧带 URL 的都没有** = 它不是页面自己的代码(产品与依赖库的
       * 每一帧都带 vite 的 http URL,原生函数只会挂在它们底下)。
       */
      let hasUrl = false
      for (let cur = leaf; cur; cur = nodes.get(cur.parent)) {
        if (cur.callFrame?.url) { hasUrl = true; break }
      }
      if (!hasUrl) answer = 'probe'
      for (let cur = hasUrl ? leaf : null; cur; cur = nodes.get(cur.parent)) {
        const fn = cur.callFrame?.functionName ?? ''
        const url = cur.callFrame?.url ?? ''
        if (fn === 'perfSpan' && url.includes('/services/perf')) {
          const callerUrl = nodes.get(cur.parent)?.callFrame?.url ?? ''
          if (callerUrl.includes('/data/chat-source')) { answer = 'compose'; break }
          if (callerUrl.includes('/content/assemble/index')) { answer = 'assemble'; break }
          continue
        }
        if (fn === '__costResizeObserverCallback') { answer = 'ro'; break }
        if (fn.startsWith('__cost')) { answer = 'probe'; break }
        if (COMMIT_FRAMES.has(fn)) { answer = 'commit'; break }
        if (RENDER_FRAMES.has(fn)) { answer = 'render'; break }
      }
    }
    memo.set(id, answer)
    return answer
  }
  return classify
}

/** 区间并集(已排序、合并)。 */
function unionOf(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** 一组并集区间在 [lo, hi) 里的长度。 */
function overlap(union, lo, hi) {
  let sum = 0
  for (const [a, b] of union) {
    if (b <= lo) continue
    if (a >= hi) break
    sum += Math.min(b, hi) - Math.max(a, lo)
  }
  return sum
}

/** 点 t 在不在并集里(二分)。 */
function inside(union, t) {
  let lo = 0
  let hi = union.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [a, b] = union[mid]
    if (t < a) hi = mid - 1
    else if (t >= b) lo = mid + 1
    else return true
  }
  return false
}

/**
 * 一趟 trace → 每帧一行 `{compose, assemble, …, busy}`(毫秒)。
 * 窗口 = `cost:send` 之后第一枚帧标记 → `cost:end` 之前最后一枚。
 */
function analyzeTrace(events) {
  const marks = events.filter((e) => e.cat?.includes('user_timing'))
  const markOf = (name) => marks.find((e) => e.name === name)
  const send = markOf('cost:send')
  const end = markOf('cost:end')
  if (!send || !end) throw new Error('trace 里找不到 cost:send / cost:end —— 窗口圈不出来')
  const thread = `${send.pid}:${send.tid}`
  const onMain = (e) => `${e.pid}:${e.tid}` === thread
  const frameMarks = marks.filter((e) => e.name === 'cost:f' && onMain(e)).map((e) => e.ts).sort((a, b) => a - b)
  const bounds = frameMarks.filter((ts) => ts >= send.ts && ts <= end.ts)
  if (bounds.length < 3) throw new Error(`窗口里帧标记太少(${bounds.length})`)

  /* 任务并集:窄分类下 toplevel 给的名字是 ThreadControllerImpl::RunTask。 */
  const taskName = events.some((e) => e.name === 'ThreadControllerImpl::RunTask' && onMain(e))
    ? 'ThreadControllerImpl::RunTask' : 'RunTask'
  const tasks = unionOf(events.filter((e) => e.ph === 'X' && e.name === taskName && onMain(e) && typeof e.dur === 'number')
    .map((e) => [e.ts, e.ts + e.dur]))
  const styleLayout = unionOf(events.filter((e) => e.ph === 'X' && onMain(e) && typeof e.dur === 'number'
    && (e.name === 'Layout' || e.name === 'UpdateLayoutTree')).map((e) => [e.ts, e.ts + e.dur]))

  /* CPU profile:挑落在主线程上的那一份(Profile 事件的 tid 就是被采的线程)。 */
  const profiles = new Map()
  for (const e of events) {
    if (e.name === 'Profile' && e.ph === 'P') {
      profiles.set(`${e.pid}:${e.id}`, { tid: e.tid, pid: e.pid, startTime: e.args?.data?.startTime, chunks: [] })
    }
  }
  for (const e of events) {
    if (e.name !== 'ProfileChunk') continue
    const p = profiles.get(`${e.pid}:${e.id}`)
    if (p) p.chunks.push(e)
  }
  const profile = [...profiles.values()].find((p) => `${p.pid}:${p.tid}` === thread)
    ?? [...profiles.values()].sort((a, b) => b.chunks.length - a.chunks.length)[0]
  if (!profile) throw new Error('trace 里没有 CPU profile —— cpu_profiler 分类没生效')
  const nodes = new Map()
  const samples = []
  let t = profile.startTime
  for (const chunk of profile.chunks.sort((a, b) => a.ts - b.ts)) {
    const data = chunk.args?.data ?? {}
    for (const n of data.cpuProfile?.nodes ?? []) nodes.set(n.id, n)
    const ids = data.cpuProfile?.samples ?? []
    const deltas = data.timeDeltas ?? []
    for (let i = 0; i < ids.length; i += 1) {
      t += deltas[i] ?? 0
      samples.push({ t, id: ids[i] })
    }
  }
  samples.sort((a, b) => a.t - b.t)
  const classify = classifier(nodes)
  /*
   * **格里是谁**:对 render / commit / js 三格,把每个样本记到「离叶最近的那一帧**产品**
   * 代码」(`/src/` 下的文件)名下 —— React 与库自己的函数只是搬运工,问的是「谁让它搬」。
   * 找不到产品帧就记在叶子自己名下。
   */
  const ownerMemo = new Map()
  const ownerUrls = new Map()
  const ownerOf = (id) => {
    if (ownerMemo.has(id)) return ownerMemo.get(id)
    const leaf = nodes.get(id)
    let answer = null
    for (let cur = leaf; cur; cur = nodes.get(cur.parent)) {
      const url = cur.callFrame?.url ?? ''
      if (url.includes('/src/')) {
        /* 带上行号(dev 下是 vite 变换之后那份代码的行,事后回页面里取那一行原文对照)。 */
        answer = `${cur.callFrame.functionName || '(匿名)'} @ ${url.replace(/^.*\/src\//, '').replace(/\?.*$/, '')}`
          + `:${(cur.callFrame.lineNumber ?? -1) + 1}`
        ownerUrls.set(answer, { url, line: (cur.callFrame.lineNumber ?? -1) + 1 })
        break
      }
    }
    if (!answer) {
      const url = leaf?.callFrame?.url ?? ''
      answer = `${leaf?.callFrame?.functionName || '(匿名)'} @ ${url.replace(/^.*\//, '').replace(/\?.*$/, '') || '(原生)'}`
    }
    ownerMemo.set(id, answer)
    return answer
  }
  const owners = { render: new Map(), commit: new Map(), js: new Map(), compose: new Map() }

  const rows = []
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const lo = bounds[i]
    const hi = bounds[i + 1]
    const row = Object.fromEntries(CELLS.map((c) => [c, 0]))
    row.busy = overlap(tasks, lo, hi)
    row.styleLayout = overlap(styleLayout, lo, hi)
    rows.push({ lo, hi, row })
  }
  /* 样本按时刻落进帧;权重 = 到下一个样本的间隔(封顶 2ms,防一段空闲把权重拉长)。 */
  let f = 0
  for (let k = 0; k + 1 < samples.length; k += 1) {
    const s = samples[k]
    if (s.t < bounds[0] || s.t >= bounds[bounds.length - 1]) continue
    while (f < rows.length && s.t >= rows[f].hi) f += 1
    if (f >= rows.length) break
    if (inside(styleLayout, s.t)) continue
    const cell = classify(s.id)
    if (cell === 'idle' || cell === 'native' || cell === 'probe') continue
    const w = Math.min(samples[k + 1].t - s.t, 2000)
    rows[f].row[cell] += w
    const book = owners[cell]
    if (book) {
      const key = ownerOf(s.id)
      book.set(key, (book.get(key) ?? 0) + w)
    }
  }
  const perFrame = rows.map(({ row }) => {
    const out = {}
    for (const c of CELLS) out[c] = row[c] / 1000
    const attributed = out.compose + out.assemble + out.render + out.commit + out.ro + out.js + out.gc + out.styleLayout
    out.rest = Math.max(0, out.busy - attributed)
    return out
  })
  const topOwners = Object.fromEntries(Object.entries(owners).map(([cell, book]) => [cell,
    [...book.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => [k, Math.round(v / 100) / 10])]))
  /*
   * **「其余(原生)」那一格里是谁**:窗口内主线程上每种 X 事件的合计时长(只报不归格;
   * 事件互相嵌套,合计会重叠 —— 它回答「大头是绘制还是别的」,不是一张账)。
   */
  const lo0 = bounds[0]
  const hi0 = bounds[bounds.length - 1]
  const byName = new Map()
  for (const e of events) {
    if (e.ph !== 'X' || !onMain(e) || typeof e.dur !== 'number') continue
    if (e.ts < lo0 || e.ts > hi0) continue
    if (e.name === taskName || e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') continue
    byName.set(e.name, (byName.get(e.name) ?? 0) + e.dur)
  }
  const eventTally = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([k, v]) => [k, Math.round(v / 100) / 10])
  const ownerSource = {}
  for (const list of Object.values(topOwners)) {
    for (const [k] of list) if (ownerUrls.has(k)) ownerSource[k] = ownerUrls.get(k)
  }
  return { frames: perFrame, sampleCount: samples.length, windowMs: (bounds[bounds.length - 1] - bounds[0]) / 1000,
    topOwners, ownerSource, eventTally }
}

/* ── 统计 ─────────────────────────────────────────────────────────────────── */

function quantile(values, q) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[idx]
}
const median = (values) => quantile(values, 0.5)
const r2 = (v) => Math.round(v * 100) / 100

function statsOf(frames) {
  const out = {}
  for (const c of CELLS) {
    const vs = frames.map((fr) => fr[c])
    out[c] = { p50: quantile(vs, 0.5), p95: quantile(vs, 0.95), max: Math.max(0, ...vs), sum: vs.reduce((a, b) => a + b, 0) }
  }
  return out
}

/** 3 趟 → 每一格每一个统计量各取中位。 */
function medianOfRuns(runStats) {
  const out = {}
  for (const c of CELLS) {
    out[c] = {}
    for (const k of ['p50', 'p95', 'max', 'sum']) out[c][k] = median(runStats.map((s) => s[c][k]))
  }
  return out
}

function printTable(title, stats, order = CELLS) {
  console.log(`\n${title}`)
  console.log(`  ${'格'.padEnd(16)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'max'.padStart(9)}${'整轮Σ'.padStart(10)}`)
  for (const c of order) {
    const s = stats[c]
    console.log(`  ${CELL_LABEL[c].padEnd(16)}${r2(s.p50).toFixed(2).padStart(9)}${r2(s.p95).toFixed(2).padStart(9)}`
      + `${r2(s.max).toFixed(2).padStart(9)}${r2(s.sum).toFixed(1).padStart(10)}`)
  }
}

/* ══ 主程序 ════════════════════════════════════════════════════════════════ */

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[stream-cost] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry)) {
    console.error('[stream-cost] 找不到主进程产物 —— 先跑 `npm run electron:build`')
    process.exit(1)
  }
  const load = () => { try { return execFileSync('uptime', { encoding: 'utf-8' }).trim() } catch { return '(uptime 不可用)' } }
  console.log(`[stream-cost] 开跑时负载:${load()}`)

  const store = await mkdtemp(path.join(tmpdir(), 'cost-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'cost-udd-'))
  let provider; let server; let app; let vite
  const report = { runs: RUNS, lanes: {}, loadBefore: load() }

  const startCore = async () => {
    const child = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ...FAKE_PROVIDER_ENV, ONETHING_STORE_PATH: store },
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const err = []
    child.stderr.on('data', (chunk) => err.push(chunk.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === child.pid ? found : undefined
    }).catch((error) => { throw new Error(`${error.message}\nserver stderr:\n${err.join('').slice(-2000)}`) })
    if (!(await portConnects(record.host, record.port))) throw new Error('core 端口连不上')
    return { child, record }
  }

  try {
    provider = await startProvider()
    writeFileSync(path.join(store, 'settings.json'), JSON.stringify({
      ai: (() => {
        const ai = fakeProviderAiSettings(provider.address().port)
        const caps = ai.providers.deepseek.modelCapabilitiesByModel['deepseek-chat']
        caps.reasoning = true
        caps.tools = true
        return ai
      })(),
      tools: {
        enableToolCalls: true,
        permissionMode: 'dangerously-allow-all',
        bash: { enableSandbox: false, confirmDangerousCommands: false },
      },
      diagnostics: { enabled: false },
    }, null, 2))

    let core = await startCore()
    server = core.child
    const shortId = (await rpc(core.record, 'sessions', 'create', { name: '流式代价 · 短会话' }))?.session?.id
    const bigId = (await rpc(core.record, 'sessions', 'create', { name: '流式代价 · 超量' }))?.session?.id
    if (!shortId || !bigId) throw new Error('会话没建出来')
    server.kill('SIGTERM')
    await delay(1500)
    const seeded = seedLargeLedger(store, bigId, {})
    console.log(`[stream-cost] 超量夹具 ${(seeded.ledgerBytes / 1024 / 1024).toFixed(1)}MB / ${seeded.messages} 条`)
    core = await startCore()
    server = core.child

    const { createServer } = await import('vite')
    vite = await createServer({
      configFile: path.join(appRoot, 'vite.config.ts'),
      server: { port: DEV_PORT, strictPort: true },
      logLevel: 'warn',
    })
    await vite.listen()
    const rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`

    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: rendererUrl,
        ONETHING_GATE_OFFSCREEN: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 0, mobile: false,
    })
    await page.addInitScript(RO_WRAP)
    await page.addInitScript(LEAF_PROBE)
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const v = await page.evaluate(() => window.__d0 ?? null).catch(() => null)
      return v && v.rpcOk ? v : undefined
    })
    /* RO 的壳要在产品 `new ResizeObserver` 之前装 —— 重载一次,让 init script 先跑。 */
    await page.reload()
    await waitFor('重载之后渲染层完成一次 RPC 往返', async () => {
      const v = await page.evaluate(() => window.__d0 ?? null).catch(() => null)
      return v && v.rpcOk ? v : undefined
    })
    const wrapped = await page.evaluate(() => Boolean(window.__cRoWrapped))
    if (!wrapped) throw new Error('RO 的壳没装上')

    const openSession = async (sessionId, expect) => {
      const rowShown = () => page.evaluate((id) =>
        Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId)
      for (let n = 0; n < 3 && !(await rowShown()); n += 1) {
        await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
        await delay(600)
      }
      await waitFor('总览画出那一行', rowShown)
      await clickTestId(page, `session-row-${sessionId}`)
      await waitFor('聊天区就位', () => page.evaluate(() =>
        Boolean(window.__cLeaf().querySelector('[data-testid="chat-stream"]'))))
      if (expect > 0) {
        await waitFor('账本起完底', async () => {
          const n = await page.evaluate(() => window.__cLeaf()
            .querySelectorAll('[data-testid="chat-stream"] [data-message-id]').length)
          return n >= Math.min(expect, 8) ? n : undefined
        }, 120_000)
      }
      await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
      await delay(800)
      await settleBackfill()
    }

    /*
     * 等列把历史补完(判词在 `gate-stream-geometry` 的 `settleBackfill` 上)。
     * **热身之后再等一次**(第一趟真机踩出来的):超量档开场只摆了 27 格就稳住了,
     * 热身那一轮之后才一路补到 417 格 —— 不再等一次,量的那几趟里就混着补历史的活。
     * 连着 10 次(3s)不再长才算补完。
     */
    const rowsNow = () => page.evaluate(() =>
      window.__cLeaf().querySelector('[data-testid="chat-stream"]')?.firstElementChild?.children.length ?? 0)
    const settleBackfill = async () => {
      const started = Date.now()
      let last = await rowsNow()
      let stable = 0
      while (Date.now() - started < 120_000 && stable < 10) {
        await delay(300)
        const now = await rowsNow()
        stable = now === last ? stable + 1 : 0
        last = now
      }
      console.log(`      补历史补完:${last} 格(等了 ${Date.now() - started}ms)`)
    }

    const scrollToBottom = async () => {
      await page.evaluate(() => {
        const scroll = window.__cLeaf().querySelector('[data-testid="chat-stream"]')
        if (scroll) scroll.scrollTop = scroll.scrollHeight
      })
      await delay(500)
    }

    const census = () => page.evaluate(() => {
      const scroll = window.__cLeaf().querySelector('[data-testid="chat-stream"]')
      return {
        messages: scroll ? scroll.querySelectorAll('[data-message-id]').length : 0,
        rows: scroll?.firstElementChild?.children.length ?? 0,
        chatNodes: scroll ? scroll.getElementsByTagName('*').length : 0,
        docNodes: document.getElementsByTagName('*').length,
        scrollHeight: scroll?.scrollHeight ?? 0,
      }
    })

    /** 一轮:圈 trace → 打标记 → 发 → 等开张 → 等收场 → 收标记。 */
    const runTurn = async (text) => {
      await scrollToBottom()
      const { events, result } = await recordTrace(cdp, async () => {
        await page.evaluate(() => {
          window.__cFrames = 0
          window.__cStop = false
          const loop = function __costFrameMark() {
            if (window.__cStop) return
            window.__cFrames += 1
            performance.mark('cost:f')
            requestAnimationFrame(loop)
          }
          requestAnimationFrame(loop)
          performance.mark('cost:send')
        })
        await sendViaComposer(page, text)
        await waitFor('这一轮开张', () => stopShown(page), 120_000)
        await waitFor('这一轮收场', async () => !(await stopShown(page)), 180_000)
        await page.evaluate(() => performance.mark('cost:end'))
        await delay(300)
        return page.evaluate(() => { window.__cStop = true; return window.__cFrames })
      })
      if (KEEP_TRACE) {
        const file = path.join(tmpdir(), `stream-cost-${Date.now()}.json`)
        writeFileSync(file, JSON.stringify({ traceEvents: events }))
        console.log(`      trace 留在 ${file}`)
      }
      const analyzed = analyzeTrace(events)
      return { ...analyzed, rafFrames: result, events: events.length }
    }

    const lanes = [
      { id: 'short', name: '短会话', sessionId: shortId, expect: 0 },
      { id: 'big', name: '超量', sessionId: bigId, expect: seeded.messages },
    ].filter((l) => !ONLY_LANE || l.id === ONLY_LANE)

    for (const lane of lanes) {
      console.log(`\n—— ${lane.name} ——`)
      await openSession(lane.sessionId, lane.expect)
      console.log('      热身一轮(不量)')
      await sendViaComposer(page, `流式代价 热身 ${MARK_WARM}`)
      await waitFor('热身开张', () => stopShown(page), 180_000)
      await waitFor('热身收场', async () => !(await stopShown(page)), 180_000)
      await delay(1500)
      await settleBackfill()
      const runs = []
      for (let n = 0; n < RUNS; n += 1) {
        const loadNow = load()
        const rowsBefore = await rowsNow()
        const turn = await runTurn(`流式代价 第 ${n + 1} 趟 ${MARK_RUN}`)
        const rowsAfter = await rowsNow()
        const stats = statsOf(turn.frames)
        const long = turn.frames.filter((fr) => fr.busy > 50).length
        console.log(`      第 ${n + 1} 趟:${turn.frames.length} 帧 / ${turn.windowMs.toFixed(0)}ms`
          + ` · CPU 样本 ${turn.sampleCount} · >50ms 帧 ${long}`
          + ` · 忙 p95 ${r2(stats.busy.p95)}ms / 最大 ${r2(stats.busy.max)}ms · 列 ${rowsBefore}→${rowsAfter} 行`
          + ` · 负载 ${loadNow.split('load averages:')[1]?.trim() ?? loadNow}`)
        runs.push({ stats, frames: turn.frames.length, windowMs: turn.windowMs, longFrames: long, load: loadNow,
          rowsBefore, rowsAfter, topOwners: turn.topOwners, eventTally: turn.eventTally })
        /* 产品帧那几名:回页面里取 vite 变换后那一行原文(行号只在这份代码里成立)。 */
        if (n === RUNS - 1) {
          const lines = await page.evaluate(async (src) => {
            const out = {}
            const cache = new Map()
            for (const [k, { url, line }] of Object.entries(src)) {
              try {
                if (!cache.has(url)) cache.set(url, (await (await fetch(url)).text()).split('\n'))
                out[k] = (cache.get(url)[line - 1] ?? '').trim().slice(0, 140)
              } catch { out[k] = '(取不到)' }
            }
            return out
          }, turn.ownerSource ?? {})
          runs[runs.length - 1].ownerLines = lines
        }
        await delay(1200)
      }
      const shape = await census()
      console.log(`      规模:${JSON.stringify(shape)}`)
      report.lanes[lane.id] = { name: lane.name, census: shape, runs, median: medianOfRuns(runs.map((r) => r.stats)) }
    }
    report.loadAfter = load()

    /* ══ 三张表 ══════════════════════════════════════════════════════════ */
    for (const lane of lanes) {
      const L = report.lanes[lane.id]
      printTable(`【${L.name}】每帧自调时间(ms,${RUNS} 趟中位)· 消息 ${L.census.messages} 条 / 列 ${L.census.rows} 行`
        + ` / 聊天区节点 ${L.census.chatNodes} / 整页节点 ${L.census.docNodes}`, L.median)
    }
    if (report.lanes.short && report.lanes.big) {
      const diff = {}
      for (const c of CELLS) {
        diff[c] = {}
        for (const k of ['p50', 'p95', 'max', 'sum']) diff[c][k] = report.lanes.big.median[c][k] - report.lanes.short.median[c][k]
      }
      report.diff = diff
      const order = CELLS.filter((c) => c !== 'busy').sort((a, b) => diff[b].p95 - diff[a].p95)
      order.push('busy')
      const S = report.lanes.short.census
      const B = report.lanes.big.census
      printTable(`【差 = 超量 − 短会话】(按 p95 差降序)· 消息 ×${(B.messages / Math.max(1, S.messages)).toFixed(0)}`
        + ` / 聊天区节点 ×${(B.chatNodes / Math.max(1, S.chatNodes)).toFixed(0)}`, diff, order)
    }
    /* 格里是谁(每档最后一趟,整轮合计 ms):render / commit / js / compose 四格的前几名。 */
    for (const lane of lanes) {
      const last = report.lanes[lane.id].runs[report.lanes[lane.id].runs.length - 1]
      console.log(`\n【${report.lanes[lane.id].name}】格里是谁(第 ${RUNS} 趟,整轮合计 ms,按离叶最近的产品帧归)`)
      for (const [cell, list] of Object.entries(last.topOwners ?? {})) {
        console.log(`  ${cell}:`)
        for (const [k, v] of list.slice(0, 8)) {
          console.log(`    ${String(v).padStart(7)}  ${k}`)
          const text = last.ownerLines?.[k]
          if (text) console.log(`             ↳ ${text}`)
        }
      }
      console.log(`  主线程事件合计(会重叠,只看大头):`)
      for (const [k, v] of last.eventTally ?? []) console.log(`    ${String(v).padStart(7)}  ${k}`)
    }
    console.log(`\n[stream-cost] 收尾负载:${report.loadAfter}`)
    const out = path.join(tmpdir(), 'stream-cost.json')
    writeFileSync(out, JSON.stringify(report, null, 2))
    console.log(`[stream-cost] 读数留在 ${out}`)
  } finally {
    await app?.close().catch(() => undefined)
    await vite?.close().catch(() => undefined)
    server?.kill('SIGTERM')
    provider?.close()
    await delay(600)
    await rm(store, { recursive: true, force: true }).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error('[stream-cost]', error)
  process.exit(1)
})
