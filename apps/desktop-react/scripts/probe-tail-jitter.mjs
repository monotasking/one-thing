#!/usr/bin/env node
/**
 * **「正在生成」那一格在抖** —— 逐帧量法(G 线 P1c,2026-09-21)。
 *
 * 用户原话:「感觉 generating 在抖动,不知道是不是上面正在生成的内容也有抖动,因为他
 * 在滚动所以看不出来。另外就是这个滚动是上下滚动,幅度很小,鼠标放上去的时候能够看出来
 * 这个元素的位置确实有些变化」。
 *
 * ── 这只探针只量,不判 ────────────────────────────────────────────────────
 * 它要回答四个问题,每个都得有数:
 *  ① **抖的是哪一种**:亚像素来回 / `tail-snap` 重认跳 1.5px / 一帧滞后整行回弹 /
 *     读数那 100ms 一跳带来的别的位移;
 *  ② **多大**:尾槽 `top` 的取值集合、帧间 Δ 直方图、峰峰值(px 与设备像素)、方向反转;
 *  ③ **多快**:每秒变几次;
 *  ④ **上面的正文抖不抖**:贴底跟随时正文每一帧上移的步长,与内容增量对不对得上,
 *     有没有「先多走再退回」的帧。
 *
 * ── 量法的三条纪律 ────────────────────────────────────────────────────────
 *  · **dpr 必须钉 2**(CDP `Emulation.setDeviceMetricsOverride`),否则量的是 dpr1 的
 *    机器,而 `tail-snap` 的整个判据按设备像素走 —— dpr 不对,结论就不对;
 *  · **每帧的活儿是 O(1),且一次 `getComputedStyle` 都不许有**(09-10「探针自伤」判例,
 *    P1b 又踩过一次):`translate` 读的是产品自己写的**内联**样式(`el.style.translate`),
 *    不是 computed;
 *  · 屏外档 `ONETHING_GATE_OFFSCREEN=1`(老那一档 headless 会把整扇窗节流到 1Hz,
 *    量的是节流器不是产品),临时 store + 临时 user-data-dir,**绝不连 `~/.onething`**,
 *    收尾逐个收尸并自查。
 *
 * 跑法:`node scripts/probe-tail-jitter.mjs`(dev,默认)/ `... --prod`
 * (仓根先 `bun run server:build`;两档都要 `npm run electron:build`,`--prod` 再 `app:build`)
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

const PROD = process.argv.includes('--prod')
const LANE = PROD ? 'prod' : 'dev'
/** 端口另挑:5175 是用户自己的,5207/5217 是几何门的。 */
const DEV_PORT = Number(process.env.ONETHING_PROBE_VITE_PORT ?? 5227)
const VIEWPORT = { width: 1280, height: 800 }
/** **钉死 dpr**:`tail-snap` 的判据以设备像素计,dpr 不对整份读数不成立。 */
const DPR = Number(process.env.ONETHING_PROBE_DPR ?? 2)

/** 第一个字之前静默多久(ms)—— 等待那一段要活得比观察它的节拍长。 */
const FIRST_BYTE_DELAY_MS = 900
/** 长正文:每行都长,行高 22.4px(`--pr-fs` 14 × `--pr-lh` 1.6,分数)。 */
const REPLY_LINES = 96
const REPLY_CHUNKS = 64
const REPLY_GAP_MS = 110
/*
 * **记号按轮分家**(几何门第一趟真机踩出来的同一个坑):自动起名是一次**独立的**
 * 模型调用,提示词里带着用户原话、因此也带着记号,只在一条会话的第一条用户消息上发。
 * 两轮共用一个记号时,热身那一轮把配额用掉两份,正式那一轮当场没配额 → 假 provider
 * 两帧收尾 → 这一轮一个字都不长。
 */
const MARK_WARM = '@@tail-warm@@'
/**
 * 三个场景,一个记号一条:
 *  · `text`   —— 纯长正文(第一趟量的就是它);
 *  · `think`  —— 先一段长思考(收起态那一行每帧换字、带扫光),再正文;
 *  · `tools`  —— 思考 → 工具卡 → 思考 → 正文,与用户真会话同形。
 */
const SCENARIOS = ['text', 'think', 'tools']
const MARK_OF = { text: '@@tail-text@@', think: '@@tail-think@@', tools: '@@tail-tools@@' }
const ONLY = (() => {
  const at = process.argv.indexOf('--scenario')
  const v = at >= 0 ? process.argv[at + 1] : undefined
  return SCENARIOS.includes(v) ? v : undefined
})()
/**
 * **真店规模**(`--big`):≥50MB 账本 / 400 条消息 / 900 张工具卡,与用户真会话同量
 * (壳 CLAUDE.md 第 5 轴的夹具)。小会话上量不出来的东西不等于用户那儿没有 ——
 * 跳渲的行(`content-visibility: auto`,估高 240px)第一次渲出真高时列会矮一截,
 * 那是**只有在几百行的账本上才发生**的事。
 */
const BIG = process.argv.includes('--big')
const OPEN_TIMEOUT_MS = 120_000

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 与真数据同形的长正文:成段、段内不带换行、中英混排(定种 LCG,每趟逐字相同)。 */
function buildReply() {
  let x = 20260921 >>> 0
  const rnd = () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 4294967296
  }
  const zh = '这一段是抖动探针造出来的正文它要和真回答同形所以每一行都长到会换行'
  const en = ' alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi '
  const lines = []
  let cursor = 0
  for (let i = 0; i < REPLY_LINES; i += 1) {
    const width = 90 + Math.floor(rnd() * 60)
    let line = `第 ${i + 1} 行:`
    while (line.length < width) {
      line += rnd() < 0.6 ? zh.slice(cursor % zh.length) : en
      cursor += 7
    }
    lines.push(line)
  }
  return lines.join('\n\n')
}
const REPLY = buildReply()

/** 与真数据同形的思考:成段、段内不带换行(收起态那一行显示它的末尾 240 字)。 */
function buildThought(total) {
  let x = 777 >>> 0
  const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296 }
  const zh = '这一段是抖动探针造出来的思考正文它要和真数据同形所以成段而且段内不带换行'
  const en = ' alpha beta gamma delta epsilon zeta eta theta iota kappa '
  const out = []
  let n = 0
  let cursor = 0
  while (n < total) {
    const width = 300 + Math.floor(rnd() * 400)
    let para = ''
    while (para.length < width) { para += rnd() < 0.6 ? zh.slice(cursor % zh.length) : en; cursor += 7 }
    out.push(para)
    n += para.length + 2
  }
  return out.join('\n\n')
}
const THOUGHT = buildThought(12_000)

/* ══ 假 provider ══════════════════════════════════════════════════════════ */

function startProvider(state) {
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
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (obj) => {
        if (res.writableEnded || res.destroyed) return
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      const frame = (d, finish = null) => ({
        id: 'chatcmpl-jitter',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta: d, finish_reason: finish }],
      })
      const bye = () => {
        if (!res.destroyed) { send(frame({}, 'stop')); res.write('data: [DONE]\n\n') }
        res.end()
      }
      const toolTurns = msgs.filter((m) => m?.role === 'tool').length
      /* 每个记号各认两发(真的那一发 + 自动起名那一发),之后照旧两帧收尾。 */
      let mark = lastUser.includes(MARK_WARM) ? 'warm' : null
      for (const id of SCENARIOS) if (lastUser.includes(MARK_OF[id])) mark = id
      if (!mark) { bye(); return }
      /* `tools` 一轮要跑三发 HTTP,按 `toolTurns` 分轮,不计配额。 */
      if (mark !== 'tools') {
        state[mark] = (state[mark] ?? 0) + 1
        if (state[mark] > 2) { bye(); return }
      }
      const streamText = async (text, chunks, gap) => {
        const size = Math.ceil(text.length / chunks)
        for (let at = 0; at < text.length; at += size) {
          if (res.destroyed) return false
          send(frame({ content: text.slice(at, at + size) }))
          await delay(gap)
        }
        return true
      }
      const streamThought = async (text, chunk, gap) => {
        for (let at = 0; at < text.length; at += chunk) {
          if (res.destroyed) return false
          send(frame({ reasoning_content: text.slice(at, at + chunk) }))
          await delay(gap)
        }
        return true
      }
      const toolCall = async (id, command) => {
        send(frame({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'bash', arguments: '' } }] }))
        const args = JSON.stringify({ command })
        for (const piece of [args.slice(0, 12), args.slice(12)]) {
          send(frame({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))
          await delay(60)
        }
        if (!res.destroyed) { send(frame({}, 'tool_calls')); res.write('data: [DONE]\n\n') }
        res.end()
      }
      await delay(FIRST_BYTE_DELAY_MS)
      if (res.destroyed) return
      if (mark === 'tools') {
        if (toolTurns === 0) {
          await streamThought(THOUGHT.slice(0, 4_000), 70, 16)
          await delay(60)
          await toolCall('call_a', 'sleep 1; echo one')
          return
        }
        if (toolTurns === 1) {
          await streamText('第一条跑完了,再跑一条。\n\n', 4, 90)
          await toolCall('call_b', 'echo two')
          return
        }
        await streamThought(THOUGHT.slice(0, 4_000), 70, 16)
        await delay(80)
        await streamText(REPLY, REPLY_CHUNKS, REPLY_GAP_MS)
        bye()
        return
      }
      if (mark === 'think') {
        await streamThought(THOUGHT, 80, 16)
        await delay(80)
      }
      await streamText(REPLY, REPLY_CHUNKS, REPLY_GAP_MS)
      bye()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/* ══ core ═════════════════════════════════════════════════════════════════ */

function readDiscovery(store) {
  try { return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8')) } catch { return undefined }
}
function portConnects(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok) => { socket.destroy(); resolve(ok) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    setTimeout(() => done(false), 1500)
  })
}
async function waitFor(label, predicate, timeoutMs = 60_000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value !== undefined && value !== false) {
      waitFor.lastMs = Date.now() - started
      return value
    }
    if (Date.now() - started > timeoutMs) throw new Error(`等不到:${label}(${timeoutMs}ms)`)
    await delay(120)
  }
}
async function rpc(record, domain, method, payload = {}) {
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${record.token}` },
    body: JSON.stringify({ id: `probe-${Date.now()}`, domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  const body = await response.json()
  if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  return body.data
}

const LEAF_PROBE = `
window.__jLeaf = function () {
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

/* ══ 逐帧采样 ═════════════════════════════════════════════════════════════ */

async function startSampler(page) {
  await page.evaluate(() => {
    window.__jFrames = []
    window.__jStop = false
    window.__jAnchor = undefined
    const tick = (t) => {
      if (window.__jStop) return
      const pane = window.__jLeaf()
      const scroll = pane.querySelector('[data-testid="chat-stream"]')
      const column = scroll?.firstElementChild
      if (scroll && column) {
        const slot = column.querySelector(':scope > [data-tail-slot]')
        const seat = column.querySelector(':scope > [data-seat]')
        const stop = slot?.querySelector('[data-testid="chat-stop"]')
        const readout = slot?.querySelector('[data-testid="chat-readout"]')
        const cursor = slot?.querySelector('[data-testid="chat-streaming"]')
        const colRect = column.getBoundingClientRect()
        const slotRect = slot?.getBoundingClientRect()
        const stopRect = stop?.getBoundingClientRect()
        const readRect = readout?.getBoundingClientRect()
        /** 读数那一行的**第一段字**(「正在生成 · 3.9s」那一段)—— 横向抖的嫌疑犯。 */
        const line = readout?.firstElementChild
        const lineRect = line?.getBoundingClientRect()
        const cursorRect = cursor?.getBoundingClientRect()
        /*
         * **读内联样式,不读 computed**(探针自伤判例):产品那一格 `translate` 是
         * `tail.style.translate = '0 <nudge>px'` 写进去的,内联样式白拿;
         * `getComputedStyle` 会逼一次全量样式重算,在 400 行的列上自己造长帧。
         */
        const inlineTranslate = slot instanceof HTMLElement ? (slot.style.translate || '') : ''
        /* 人正在读的那一块正文(开录之后第一帧钉下来,之后逐帧跟) */
        const anchor = window.__jAnchor && window.__jAnchor.isConnected
          ? window.__jAnchor.getBoundingClientRect()
          : undefined
        window.__jFrames.push({
          t,
          st: scroll.scrollTop,
          sh: scroll.scrollHeight,
          ch: scroll.clientHeight,
          /* 列的**分数**总高 —— 最大滚动位那个分数就是从它来的 */
          colH: colRect.height,
          colBottom: colRect.bottom,
          vBottom: scroll.getBoundingClientRect().bottom,
          slotTop: slotRect ? slotRect.top : null,
          slotBottom: slotRect ? slotRect.bottom : null,
          slotH: slotRect ? slotRect.height : null,
          tr: inlineTranslate,
          stopTop: stopRect ? stopRect.top : null,
          stopLeft: stopRect ? stopRect.left : null,
          readLeft: readRect ? readRect.left : null,
          readW: readRect ? readRect.width : null,
          lineLeft: lineRect ? lineRect.left : null,
          lineW: lineRect ? lineRect.width : null,
          lineText: line ? (line.textContent || '') : null,
          curTop: cursorRect ? cursorRect.top : null,
          seatH: seat ? seat.getBoundingClientRect().height : null,
          anchorTop: anchor ? anchor.top : null,
          rows: column.children.length,
          running: slot ? slot.getAttribute('data-face') === 'run' : false,
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopSampler(page) {
  return page.evaluate(() => {
    window.__jStop = true
    const frames = window.__jFrames ?? []
    window.__jFrames = []
    return frames
  })
}

/* ══ 事后那一遍算 ═════════════════════════════════════════════════════════ */

const r3 = (v) => Number(v.toFixed(3))

/** 一串数的取值集合 + 各值出现帧数(按出现次数排,只留前 N 个)。 */
function valueHistogram(values, top = 12) {
  const map = new Map()
  for (const v of values) {
    const key = r3(v)
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1])
  return { distinct: map.size, top: rows.slice(0, top) }
}

/** 帧间 Δ 的直方图(按绝对值分桶,桶宽 = 半个设备像素)。 */
function deltaHistogram(values, devicePx) {
  const map = new Map()
  let moves = 0
  for (let i = 1; i < values.length; i += 1) {
    const d = values[i] - values[i - 1]
    if (Math.abs(d) < 1e-6) { map.set('0', (map.get('0') ?? 0) + 1); continue }
    moves += 1
    const bucket = `${d > 0 ? '+' : '−'}${(Math.ceil(Math.abs(d) / (devicePx / 2)) * (devicePx / 2)).toFixed(2)}`
    map.set(bucket, (map.get(bucket) ?? 0) + 1)
  }
  return { moves, buckets: [...map.entries()].sort((a, b) => b[1] - a[1]) }
}

/** 峰峰值 / 方向反转 / 每秒变化次数。 */
function jitterOf(values, times, devicePx) {
  if (values.length < 2) return { frames: values.length, empty: true, bigSteps: 0 }
  let min = Infinity
  let max = -Infinity
  let flips = 0
  let dir = 0
  let changes = 0
  /**
   * **人眼看得见的那一种移动**:一帧里挪了**≥ 一个设备像素**。
   *
   * 亚像素的来回不会换一个设备像素行,字的栅格化结果基本不动;挪过一整个设备像素
   * 才是「这一行跳了一下」。所以门判的是这一格,不是「反转次数」—— 后者在亚像素
   * 噪声上永远不可能是 0,写进门就是一条迟早被人加 `|| true` 的断言。
   */
  let bigSteps = 0
  for (let i = 0; i < values.length; i += 1) {
    min = Math.min(min, values[i])
    max = Math.max(max, values[i])
    if (i === 0) continue
    const d = values[i] - values[i - 1]
    if (Math.abs(d) >= devicePx - 1e-6) bigSteps += 1
    if (Math.abs(d) < 1e-6) continue
    changes += 1
    const nd = Math.sign(d)
    if (dir !== 0 && nd !== dir) flips += 1
    dir = nd
  }
  const spanMs = times[times.length - 1] - times[0]
  const peak = max - min
  return {
    frames: values.length,
    spanMs: Math.round(spanMs),
    minPx: r3(min),
    maxPx: r3(max),
    peakPx: r3(peak),
    peakDevicePx: r3(peak / devicePx),
    flips,
    changes,
    bigSteps,
    perSecond: spanMs > 0 ? r3((changes / spanMs) * 1000) : 0,
  }
}

function analyze(frames, devicePx) {
  if (frames.length < 5) return { empty: true, frames: frames.length }
  const t0 = frames[0].t
  /** **贴底跟随那一段**:座位已经吃光、这一轮还在跑、而且真的贴着底。 */
  const pinned = frames.filter((f) =>
    f.running && (f.seatH === null || f.seatH <= 0.5) && f.st + f.ch >= f.sh - 2)

  /** 这一轮在跑的**全部**帧(座位期 + 跟随期 + 收场之前)。 */
  const running = frames.filter((f) => f.running)
  /** 座位期:座位还在(还没被吃光)。 */
  const seated = running.filter((f) => f.seatH !== null && f.seatH > 0.5)

  const slotTops = pinned.map((f) => f.slotTop).filter((v) => v !== null)
  const slotTimes = pinned.filter((f) => f.slotTop !== null).map((f) => f.t)
  const stopTops = pinned.map((f) => f.stopTop).filter((v) => v !== null)
  const stopTimes = pinned.filter((f) => f.stopTop !== null).map((f) => f.t)

  /*
   * ── 「一帧滞后」:内容已经长了而 `scrollTop` 还没跟上 ──────────────────────
   * 判据是**同一帧**里 `gap = sh − ch − st > 一个设备像素`(而且此刻是跟随态)。
   * 那一帧尾槽会被推下 gap 那么多,下一帧贴底再拉回来 —— 人看见的是一次整行回弹。
   */
  const lagged = []
  for (const f of pinned) {
    const gap = f.sh - f.ch - f.st
    if (gap > devicePx) lagged.push({ ms: Math.round(f.t - t0), gap: r3(gap) })
  }

  /* ── `translate` 的变化序列(产品每改一次记一条) ───────────────────────── */
  const translateSeq = []
  let lastTr = null
  for (const f of frames) {
    if (f.tr === lastTr) continue
    translateSeq.push({ ms: Math.round(f.t - t0), tr: f.tr || '(无)', running: f.running })
    lastTr = f.tr
  }

  /*
   * ── 残值:`(视口内容盒下缘 − 列下缘)`,09-15 那一篇量的就是它 ───────────────
   * 它是「最大滚动位是分数、`scrollTop` 只能取整数个设备像素」剩下的那一截。
   */
  const residuals = pinned.map((f) => f.vBottom - f.colBottom)

  /*
   * ── 上面的正文动得匀不匀(用户的第二问)────────────────────────────────
   * 每一帧正文上移多少(`−Δanchor.top`)与同一帧内容长了多少(`Δsh`)对比:
   * 贴底跟随时两者该逐帧相等。差出来的那一格就是「先多走再退回」。
   */
  const anchorRows = pinned.filter((f) => f.anchorTop !== null)
  const anchorSteps = []
  let anchorBack = 0
  for (let i = 1; i < anchorRows.length; i += 1) {
    const dTop = anchorRows[i].anchorTop - anchorRows[i - 1].anchorTop
    const dSh = anchorRows[i].sh - anchorRows[i - 1].sh
    if (Math.abs(dTop) < 1e-6 && dSh === 0) continue
    /* 正文往**下**走(dTop > 一个设备像素)= 先多走再退回的那一下 */
    if (dTop > devicePx) anchorBack += 1
    anchorSteps.push({ up: r3(-dTop), grew: dSh })
  }
  const mismatched = anchorSteps.filter((s) => Math.abs(s.up - s.grew) > devicePx)

  return {
    frames: frames.length,
    spanMs: Math.round(frames[frames.length - 1].t - t0),
    fps: Math.round((frames.length / Math.max(1, frames[frames.length - 1].t - t0)) * 1000),
    pinnedFrames: pinned.length,
    pinnedMs: pinned.length > 1 ? Math.round(pinned[pinned.length - 1].t - pinned[0].t) : 0,
    slot: {
      ...jitterOf(slotTops, slotTimes, devicePx),
      values: valueHistogram(slotTops),
      deltas: deltaHistogram(slotTops, devicePx),
    },
    stop: jitterOf(stopTops, stopTimes, devicePx),
    /* 整轮(座位期也算)与座位期各一份 —— 抖不抖不许只看跟随那一段 */
    slotWhole: jitterOf(
      running.map((f) => f.slotTop).filter((v) => v !== null),
      running.filter((f) => f.slotTop !== null).map((f) => f.t), devicePx),
    slotSeated: jitterOf(
      seated.map((f) => f.slotTop).filter((v) => v !== null),
      seated.filter((f) => f.slotTop !== null).map((f) => f.t), devicePx),
    /*
     * ── 横向(2026-09-21 补的第二把尺)────────────────────────────────────
     * 读数那一行是「正在生成 · 3.9s」,每 100ms 换一次数字。字体的数字不等宽时
     * 整段字的宽度跟着变,而它排在 `flex: 1` 的指示格右边 —— 于是**那段字的左缘
     * 每 100ms 挪一次**。纵向一像素不动也能这么抖,所以这把尺必须单独量。
     */
    lineX: {
      ...jitterOf(
        running.map((f) => f.lineLeft).filter((v) => v !== null),
        running.filter((f) => f.lineLeft !== null).map((f) => f.t), devicePx),
      widths: valueHistogram(running.map((f) => f.lineW).filter((v) => v !== null), 10),
      texts: valueHistogram(
        running.map((f) => (f.lineText === null ? null : f.lineText.length)).filter((v) => v !== null), 6),
    },
    stopX: jitterOf(
      running.map((f) => f.stopLeft).filter((v) => v !== null),
      running.filter((f) => f.stopLeft !== null).map((f) => f.t), devicePx),
    residual: {
      ...jitterOf(residuals, slotTimes, devicePx),
      values: valueHistogram(residuals, 8),
    },
    lagged: { count: lagged.length, first: lagged.slice(0, 6) },
    translateChanges: translateSeq.length,
    translateSeq: translateSeq.slice(0, 20),
    anchor: {
      frames: anchorRows.length,
      steps: anchorSteps.length,
      wentBack: anchorBack,
      mismatched: mismatched.length,
      sample: anchorSteps.slice(0, 8),
    },
  }
}

/* ══ 驱动 ═════════════════════════════════════════════════════════════════ */

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
    const box = window.__jLeaf().querySelector('[data-testid="composer-input"]')
    if (!box) return false
    box.textContent = value
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, text)
  if (!ok) throw new Error('打不进去:没有 composer-input')
  await delay(200)
  const sent = await page.evaluate(() => {
    const send = window.__jLeaf().querySelector('[data-testid="composer-send"]')
    if (!(send instanceof HTMLElement) || send.hasAttribute('disabled')) return false
    send.click()
    return true
  })
  if (!sent) throw new Error('发送键点不动')
}

const stopShown = (page) => page.evaluate(() =>
  Boolean(window.__jLeaf().querySelector('[data-testid="chat-stop"]')))

function report(name, m) {
  console.log(`\n══ ${name} ══════════════════════════════════════════════`)
  if (m.empty) { console.log(`  一帧都没采到(${m.frames})`); return }
  console.log(`\n  整轮 ${m.frames} 帧 @${m.fps}fps / ${m.spanMs}ms`
    + ` · 贴底跟随段 ${m.pinnedFrames} 帧 / ${m.pinnedMs}ms`)
  const s = m.slot
  console.log(`\n  ── 尾槽 top ──────────────────────────────────────────────`)
  console.log(`  峰峰 ${s.peakPx}px = ${s.peakDevicePx} 设备像素`
    + `(${s.minPx} → ${s.maxPx})· 方向反转 ${s.flips} · 变化 ${s.changes} 次`
    + ` = ${s.perSecond}/s · **挪过整个设备像素的帧 ${s.bigSteps}**`)
  console.log(`  取值集合 ${s.values.distinct} 个:`
    + s.values.top.map(([v, n]) => `${v}×${n}`).join('  '))
  console.log(`  帧间 Δ(桶宽半个设备像素,动了 ${s.deltas.moves} 帧):`
    + s.deltas.buckets.map(([b, n]) => `${b}×${n}`).join('  '))
  console.log(`  停止钮 top:峰峰 ${m.stop.peakPx}px / 反转 ${m.stop.flips} / 变化 ${m.stop.changes}`)
  console.log(`  整轮(含座位期)${m.slotWhole.frames} 帧:峰峰 ${m.slotWhole.peakPx}px`
    + ` / 反转 ${m.slotWhole.flips} / 变化 ${m.slotWhole.changes} = ${m.slotWhole.perSecond}/s`)
  console.log(`  座位期 ${m.slotSeated.frames} 帧:峰峰 ${m.slotSeated.peakPx ?? '—'}px`
    + ` / 反转 ${m.slotSeated.flips ?? '—'} / 变化 ${m.slotSeated.changes ?? '—'}`)
  console.log(`\n  ── 横向:读数那一行的左缘(「正在生成 · N.Ns」)────────────`)
  console.log(`  峰峰 ${m.lineX.peakPx}px = ${m.lineX.peakDevicePx} 设备像素`
    + ` · 反转 ${m.lineX.flips} · 变化 ${m.lineX.changes} 次 = ${m.lineX.perSecond}/s`)
  console.log(`  那段字的宽 ${m.lineX.widths.distinct} 种:`
    + m.lineX.widths.top.map(([v, n]) => `${v}×${n}`).join('  '))
  console.log(`  停止钮 left:峰峰 ${m.stopX.peakPx}px / 变化 ${m.stopX.changes} 次`)
  console.log(`\n  ── 残值(视口下缘 − 列下缘)──────────────────────────────`)
  console.log(`  峰峰 ${m.residual.peakPx}px(${m.residual.minPx} → ${m.residual.maxPx})`
    + ` · 取值 ${m.residual.values.distinct} 个:`
    + m.residual.values.top.map(([v, n]) => `${v}×${n}`).join('  '))
  console.log(`\n  ── 一帧滞后(gap > 1 设备像素)────────────────────────────`)
  console.log(`  ${m.lagged.count} 帧` + (m.lagged.first.length
    ? `:${m.lagged.first.map((l) => `${l.ms}ms/${l.gap}px`).join('  ')}` : ''))
  console.log(`\n  ── translate(产品每改一次一条,共 ${m.translateChanges} 次)──`)
  for (const row of m.translateSeq) console.log(`    ${row.ms}ms  ${row.tr}${row.running ? '' : '(未在跑)'}`)
  console.log(`\n  ── 上面的正文(用户第二问)───────────────────────────────`)
  console.log(`  锚点 ${m.anchor.frames} 帧 / ${m.anchor.steps} 次移动`
    + ` · **往回走** ${m.anchor.wentBack} 次 · 步长与内容增量对不上 ${m.anchor.mismatched} 次`)
  console.log(`  前几步(上移 px / 同帧内容增量 px):`
    + m.anchor.sample.map((s2) => `${s2.up}/${s2.grew}`).join('  '))
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[tail-jitter] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry)) {
    console.error('[tail-jitter] 找不到主进程产物 —— 先跑 `npm run electron:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'jit-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'jit-udd-'))
  const providerState = {}
  let provider; let server; let app; let vite

  try {
    console.log(`\n[tail-jitter] 档位:${LANE} · dpr 钉 ${DPR}`)
    provider = await startProvider(providerState)
    writeFileSync(path.join(store, 'settings.json'), JSON.stringify({
      ai: fakeProviderAiSettings(provider.address().port),
      tools: { enableToolCalls: false },
      diagnostics: { enabled: false },
    }, null, 2))

    const child = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ...FAKE_PROVIDER_ENV, ONETHING_STORE_PATH: store },
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server = child
    const err = []
    child.stderr.on('data', (c) => err.push(c.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === child.pid ? found : undefined
    }).catch((e) => { throw new Error(`${e.message}\nserver stderr:\n${err.join('').slice(-2000)}`) })
    if (!(await portConnects(record.host, record.port))) throw new Error('core 端口连不上')

    const sessionId = (await rpc(record, 'sessions', 'create', { name: '抖动探针' }))?.session?.id
    if (!sessionId) throw new Error('会话没建出来')
    let seeded
    if (BIG) {
      /* 直写账本要停 core(它是这条会话的唯一写者),写完再起回来。 */
      server.kill('SIGTERM')
      await delay(1200)
      seeded = seedLargeLedger(store, sessionId, {})
      console.log(`[tail-jitter] 超量夹具 ${(seeded.bytes / 1024 / 1024).toFixed(1)}MB / ${seeded.messages} 条`)
      const again = spawn(process.execPath, [serverEntry], {
        env: { ...process.env, ...FAKE_PROVIDER_ENV, ONETHING_STORE_PATH: store },
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      server = again
      await waitFor('core 重新写出发现文件', () => {
        const found = readDiscovery(store)
        return found && found.pid === again.pid ? found : undefined
      })
    }

    let rendererUrl
    if (!PROD) {
      const { createServer } = await import('vite')
      vite = await createServer({
        configFile: path.join(appRoot, 'vite.config.ts'),
        server: { port: DEV_PORT, strictPort: true },
        logLevel: 'warn',
      })
      await vite.listen()
      rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`
    }

    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ...(rendererUrl ? { ONETHING_REACT_DEV_SERVER_URL: rendererUrl } : {}),
        ONETHING_GATE_OFFSCREEN: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: DPR, mobile: false,
    })
    await page.addInitScript(LEAF_PROBE)
    await page.evaluate(LEAF_PROBE)
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const v = await page.evaluate(() => window.__d0 ?? null)
      return v && v.rpcOk ? v : undefined
    })

    const realDpr = await page.evaluate(() => window.devicePixelRatio)
    console.log(`[tail-jitter] 页面 devicePixelRatio = ${realDpr}`)
    if (realDpr !== DPR) throw new Error(`dpr 钉不住(要 ${DPR},实得 ${realDpr})—— 读数不成立`)
    const devicePx = 1 / realDpr

    /* 打开那条会话 */
    const rowShown = () => page.evaluate((id) =>
      Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId)
    for (let n = 0; n < 3 && !(await rowShown()); n += 1) {
      await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
      await delay(600)
    }
    await waitFor('总览画出那一行', rowShown)
    await clickTestId(page, `session-row-${sessionId}`)
    await waitFor('聊天区就位', () => page.evaluate(() =>
      Boolean(window.__jLeaf().querySelector('[data-testid="chat-stream"]'))))
    if (BIG) {
      await waitFor('账本起完底', async () => {
        const n = await page.evaluate(() => window.__jLeaf()
          .querySelectorAll('[data-testid="chat-stream"] [data-message-id]').length)
        return n >= 8 ? n : undefined
      }, OPEN_TIMEOUT_MS)
      /* 等按屏进的历史补完(它与这一轮的几何正交,判词同几何门的 `settleBackfill`)。 */
      const rows = () => page.evaluate(() => {
        const scroll = window.__jLeaf().querySelector('[data-testid="chat-stream"]')
        return scroll?.firstElementChild?.children.length ?? 0
      })
      const started = Date.now()
      let last = await rows()
      let stable = 0
      while (Date.now() - started < 120_000 && stable < 5) {
        await delay(300)
        const now = await rows()
        stable = now === last ? stable + 1 : 0
        last = now
      }
      console.log(`      补历史补完:${last} 格(等了 ${Date.now() - started}ms)`)
    }
    await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
    await delay(800)

    /* 热身一轮(吃掉自动起名那一发与冷开张),不量 */
    console.log('[tail-jitter] 热身一轮(不量)')
    await sendViaComposer(page, `热身 ${MARK_WARM}`)
    await waitFor('热身开张', () => stopShown(page), OPEN_TIMEOUT_MS)
    await waitFor('热身收场', async () => !(await stopShown(page)), 300_000)
    await delay(1200)

    const readings = {}
    for (const id of SCENARIOS.filter((x) => !ONLY || x === ONLY)) {
      console.log(`\n[tail-jitter] 场景 ${id}`)
      await page.evaluate(() => {
        const scroll = window.__jLeaf().querySelector('[data-testid="chat-stream"]')
        if (scroll) scroll.scrollTop = scroll.scrollHeight
      })
      await delay(400)
      await startSampler(page)
      await sendViaComposer(page, `抖动探针 ${MARK_OF[id]}`)
      await waitFor('开张', () => stopShown(page), OPEN_TIMEOUT_MS)
      /* 等这一轮真的长出正文,再钉一块当锚(用户第二问要它) */
      await waitFor('这一轮长出了正文', () => page.evaluate(() => {
        const leaf = window.__jLeaf()
        const kids = leaf.querySelector('[data-testid="chat-stream"]')?.firstElementChild?.children ?? []
        for (let i = kids.length - 1; i >= 0 && i >= kids.length - 7; i -= 1) {
          const el = kids[i]
          if (!el.hasAttribute('data-message-id')) continue
          if (el.getAttribute('data-role') === 'user') break
          const blocks = el.querySelectorAll('[data-prose]:not([data-testid="chat-thought"]), [data-block-kind]')
          if (blocks.length >= 3) { window.__jAnchor = blocks[1]; return true }
          break
        }
        return false
      }), 120_000)
      await waitFor('收场', async () => !(await stopShown(page)), 300_000)
      await delay(600)
      const frames = await stopSampler(page)
      const m = analyze(frames, devicePx)
      readings[id] = m
      report(id, m)
    }
    console.log(`\n[tail-jitter] JSON(${LANE} · dpr${DPR}):${JSON.stringify(readings)}`)
  } finally {
    if (app) await app.close().catch(() => undefined)
    if (vite) await vite.close().catch(() => undefined)
    if (server) server.kill('SIGTERM')
    await delay(400)
    if (server && !server.killed) server.kill('SIGKILL')
    if (provider) {
      provider.closeAllConnections?.()
      await new Promise((resolve) => provider.close(resolve))
    }
    await rm(store, { recursive: true, force: true }).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  }

  try {
    const ps = execFileSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf-8' })
    const mine = ps.split('\n').filter((line) =>
      line.includes('jit-store-') || line.includes('jit-udd-')
      || (!PROD && line.includes(`:${DEV_PORT}`)))
    console.log(mine.length
      ? `\n[tail-jitter] **残留自查:还有 ${mine.length} 条**\n  ${mine.join('\n  ')}`
      : '\n[tail-jitter] 残留自查:干净')
  } catch {
    console.log('\n[tail-jitter] 残留自查:ps 跑不起来,跳过')
  }
}

main().catch((error) => {
  console.error(`\n[tail-jitter] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
