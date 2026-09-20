#!/usr/bin/env node
/**
 * **只量不改** —— 聊天消息流「发送 → 等待 → 流式 → 收尾」全过程里,所有会让
 * 用户正在看的内容上下挪动的布局变化。
 *
 * 这是一只**探针**,不是门:它不判红,只把逐帧量到的事实按「源头 → 后果」摊成
 * 一张带毫秒与像素的清单。判据一句话:**scrollHeight 在长、而且页面贴着底,
 * 那是设计要的跟底;除此之外元素相对视口的位移都是「屏幕自己动了」。**
 *
 * 支架整只照 `gate-send-flow.mjs`:临时 store + 临时 user-data-dir、`dist/server/main.js`
 * 起 core、记号驱动的假 provider、playwright `_electron`、**屏外档**
 * (`ONETHING_GATE_OFFSCREEN=1` —— 老那一档 headless 会把整扇窗节流到 1Hz,量的
 * 就成了节流器)、所有输入走 `page.evaluate`、`finally` 里逐个收尸。
 * **绝不连 `~/.onething`,绝不用 5175。**
 *
 * 跑法:`node scripts/probe-layout-shift.mjs [--only A,B,C] [--trace]`
 * (仓根先有 `dist/server/main.js`,本目录先有 `dist-electron/main.cjs` —— 两样
 *  都在就直接吃,这只探针**不重建**任何产物。)
 */
import { spawn } from 'node:child_process'
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

/** dev 档的 vite 端口。**不是 5175**(用户自己的 `app:dev` 占着),也不是 5196(gate:send-flow)。 */
const DEV_PORT = Number(process.env.ONETHING_PROBE_VITE_PORT ?? 5203)
const VIEWPORT = { width: 1280, height: 800 }
const OUT = process.env.ONETHING_PROBE_OUT
  ?? path.join(tmpdir(), `layout-shift-${Date.now()}.json`)

const ONLY = (() => {
  const at = process.argv.indexOf('--only')
  if (at < 0) return null
  return new Set((process.argv[at + 1] ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))
})()
const want = (id) => !ONLY || ONLY.has(id.toUpperCase()) || ONLY.has(id[0].toUpperCase())

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ══ 假 provider ═══════════════════════════════════════════════════════════
 * 记号驱动:请求里**最后一条 user 消息**带哪个记号,决定这一发吐什么。
 * 工具那一支要跨好几轮(每轮一发 HTTP),所以记号要从最后一条 user 往回找,
 * 不是看最后一条消息(那时候它是 role:'tool')。
 * 每个记号只服务约定的次数;多出来的(自动起名之类)两帧收尾。
 */
const MARKS = {
  ctx: '@@ls-ctx@@',
  text: '@@ls-text@@',
  head: '@@ls-head@@',
  code: '@@ls-code@@',
  think: '@@ls-think@@',
  long: '@@ls-longthink@@',
  tools: '@@ls-tools@@',
  blocks: '@@ls-blocks@@',
  abort: '@@ls-abort@@',
}
/** 第一个字之前静默多久 —— 等待折痕要活得够久,逐帧采样才录得到。 */
const FIRST_BYTE_DELAY_MS = 900

function buildThought(totalChars, seed) {
  let x = seed >>> 0
  const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296 }
  const zh = '这一段是布局探针造出来的思考正文它要和真数据同形所以成段而且段内不带换行'
  const en = ' alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu '
  const paras = []
  let total = 0
  let cursor = 0
  while (total < totalChars) {
    const width = 300 + Math.floor(rnd() * 601)
    let para = ''
    while (para.length < width) {
      para += rnd() < 0.6 ? zh.slice(cursor % zh.length) : en
      cursor += 7
    }
    paras.push(para)
    total += para.length + 2
  }
  return paras.join('\n\n')
}

/** ≈3 屏(1280×800 下正文列约 720px 宽、一行约 26px):给足 6 万字,展开约 6000px+。 */
const LONG_THOUGHT = buildThought(60_000, 20260920)
const SHORT_THOUGHT = buildThought(3_000, 777)

const REPLY_PLAIN = '这是一段普通的正文回答,它要够长,好切成十几段真的流一遍,'
  + '让每一段都逼出一次提交、一次排版。第一块是一行正文 —— 和折痕那一行的上边距、'
  + '行高都不一样,所以换手那一帧的高度差全落在这一块身上。'
  + '再补几句把这一段撑到两三行,免得整条回答短到连座位都吃不满。'

const REPLY_HEADING = '## 这是一个二级标题\n\n'
  + '标题块的上下外边距与正文块不同,所以「折痕 → 标题」与「折痕 → 正文」换手那一帧'
  + '的高度差不是同一个数。下面再跟一段正文,好让这一轮有内容可流。\n\n'
  + REPLY_PLAIN

const CODE_LINES = Array.from({ length: 14 }, (_, i) =>
  `const line${i + 1} = compute(${i + 1}, 'layout-shift-probe', { retries: ${i % 3} })`)
const REPLY_CODE = '```ts\n' + CODE_LINES.join('\n') + '\n```\n\n'
  + '上面那块代码围栏在流式里会经历「未闭合 → 闭合」,而高亮是异步到位的。'

const TABLE_ROWS = Array.from({ length: 10 }, (_, i) =>
  `| 第 ${i + 1} 行 | 数值 ${(i + 1) * 37} | 说明文字若干个汉字 |`)
const REPLY_BLOCKS = '先来一段正文,让这一轮有个正常的起头。\n\n'
  + '```js\n' + Array.from({ length: 10 }, (_, i) => `function f${i}() { return ${i} }`).join('\n') + '\n```\n\n'
  + '| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n' + TABLE_ROWS.join('\n') + '\n\n'
  + '下面是一条公式:\n\n$$\n\\sum_{i=1}^{n} \\frac{x_i^2 + 1}{\\sqrt{2\\pi\\sigma}} = \\int_0^\\infty e^{-t^2}\\,dt\n$$\n\n'
  + Array.from({ length: 12 }, (_, i) => `- 列表第 ${i + 1} 项,后面跟一句稍微长一点的说明文字`).join('\n')
  + '\n\n最后再补一段正文收尾。'

const REPLY_ABORT = Array.from({ length: 60 }, (_, i) =>
  `第 ${i + 1} 段:这一段存在的理由是让流跑得够久,好在中途按下停止键。`).join('\n\n')

function startProvider(state) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* 形状不对走兜底 */ }
      const msgs = Array.isArray(payload.messages) ? payload.messages : []
      const textOf = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''))
      /* 记号从**最后一条 user** 往回找:工具那一支的最后一条是 role:'tool'。 */
      let lastUser = ''
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i]?.role === 'user') { lastUser = textOf(msgs[i]); break }
      }
      const toolTurns = msgs.filter((m) => m?.role === 'tool').length

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (obj) => {
        if (res.writableEnded || res.destroyed) return
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      const frame = (delta, finish = null) => ({
        id: 'chatcmpl-ls',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const bye = (finish = 'stop') => {
        if (!res.destroyed) { send(frame({}, finish)); res.write('data: [DONE]\n\n') }
        res.end()
      }
      /** 一段正文切片流出去。 */
      const stream = async (text, pieces, gap) => {
        const size = Math.max(1, Math.ceil(text.length / pieces))
        for (let at = 0; at < text.length; at += size) {
          if (res.destroyed) return false
          send(frame({ content: text.slice(at, at + size) }))
          await delay(gap)
        }
        return true
      }
      const streamThought = async (text, chunk, gap, rampParts = 20, rampGap = 60) => {
        let cursor = 0
        let parts = 0
        while (cursor < text.length) {
          if (res.destroyed) return false
          send(frame({ reasoning_content: text.slice(cursor, cursor + chunk) }))
          cursor += chunk
          parts += 1
          await delay(parts <= rampParts ? rampGap : gap)
        }
        return true
      }

      let kind = null
      for (const [name, mark] of Object.entries(MARKS)) {
        if (lastUser.includes(mark)) { kind = name; break }
      }
      /* 一个记号只服务约定的次数;工具那一支按 toolTurns 分轮,所以不计数。 */
      const budget = { ctx: 1, text: 2, head: 1, code: 1, think: 1, long: 2, tools: 3, blocks: 1, abort: 1 }
      if (kind && kind !== 'tools') {
        state[kind] = (state[kind] ?? 0) + 1
        if (state[kind] > (budget[kind] ?? 1)) kind = null
      }
      if (!kind) { bye(); return }

      await delay(FIRST_BYTE_DELAY_MS)
      if (res.destroyed) return

      if (kind === 'tools') {
        if (toolTurns === 0) {
          await streamThought(SHORT_THOUGHT, 80, 16, 10, 50)
          await delay(60)
          send(frame({ tool_calls: [{ index: 0, id: 'call_slow', type: 'function', function: { name: 'bash', arguments: '' } }] }))
          const args = JSON.stringify({ command: 'sleep 1.3; echo slow-done' })
          for (const piece of [args.slice(0, 14), args.slice(14)]) {
            send(frame({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))
            await delay(60)
          }
          bye('tool_calls')
          return
        }
        if (toolTurns === 1) {
          send(frame({ content: '第一条跑完了,再跑一条快的。\n\n' }))
          await delay(80)
          send(frame({ tool_calls: [{ index: 0, id: 'call_fast', type: 'function', function: { name: 'bash', arguments: '' } }] }))
          const args = JSON.stringify({ command: 'echo fast-done' })
          for (const piece of [args.slice(0, 10), args.slice(10)]) {
            send(frame({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))
            await delay(60)
          }
          bye('tool_calls')
          return
        }
        await streamThought(SHORT_THOUGHT, 80, 16, 10, 50)
        await delay(80)
        await stream('两条都跑完了,下面是结论正文。' + REPLY_PLAIN, 10, 100)
        bye()
        return
      }

      if (kind === 'think') {
        await streamThought(SHORT_THOUGHT, 70, 16)
        await delay(80)
        await stream(REPLY_PLAIN, 10, 100)
        bye()
        return
      }
      if (kind === 'long') {
        await streamThought(LONG_THOUGHT, 90, 16, 24, 60)
        await delay(80)
        await stream('思考结束,下面是结论。\n\n' + REPLY_PLAIN, 10, 100)
        bye()
        return
      }
      const table = {
        ctx: [REPLY_PLAIN, 10, 110],
        text: [REPLY_PLAIN, 10, 110],
        head: [REPLY_HEADING, 14, 100],
        code: [REPLY_CODE, 16, 100],
        blocks: [REPLY_BLOCKS, 40, 90],
        abort: [REPLY_ABORT, 60, 120],
      }
      const [text, pieces, gap] = table[kind]
      await stream(text, pieces, gap)
      bye()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/* ══ core / 发现文件 ═══════════════════════════════════════════════════════ */

function readDiscovery(store) {
  try { return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8')) } catch { return undefined }
}
function portConnects(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const settle = (v) => { socket.destroy(); resolve(v) }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}
async function waitFor(label, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(100)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}
async function rpc(record, domain, method, payload = {}) {
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
    },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  const body = await response.json()
  if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  return body.data
}

/** 屏上那一片会话叶(判词与 gate-send-flow 的 `__seatLeaf` 逐字同源)。 */
const LEAF_PROBE = `
window.__lsLeaf = function () {
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

/* ══ 逐帧采样器 ════════════════════════════════════════════════════════════
 * 一次 rAF 取完这一帧要的全部矩形 —— 分几次取就不是同一瞬间的同一份布局了。
 * 每个被跟踪的节点第一次见到时盖一个号(`__lsId`),于是「同一件东西的高度变了」
 * 与「换了一件东西」在事后那一遍算里分得开。
 */
async function startSampler(page) {
  await page.evaluate(() => {
    const leaf = window.__lsLeaf()
    window.__lsFrames = []
    window.__lsStop = false
    /*
     * ── 大笔滚动是**谁写的** ────────────────────────────────────────────────
     * 逐帧采样答得出「`scrollTop` 从 A 跳到了 B」,答不出「这一跳是浏览器钳的还是
     * 有人赋的」—— 而这两件事的修法完全不同。所以在**那一个**滚动容器实例上
     * 盖一层 `scrollTop` 存取器(自有属性,盖在实例上,产品源码一个字不动;
     * 浏览器自己的钳位不走 setter,所以它天然只录得到 JS 的赋值),
     * 超过 200px 的赋值连**调用栈**一起记下来。
     */
    window.__lsWrites = []
    const scroller = leaf.querySelector('[data-testid="chat-stream"]')
    if (scroller && !scroller.__lsPatched) {
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get() { return desc.get.call(this) },
        set(v) {
          const from = desc.get.call(this)
          if (Math.abs(v - from) > 200) {
            window.__lsWrites.push({
              t: performance.now(),
              from: Math.round(from),
              to: Math.round(v),
              sh: this.scrollHeight,
              ch: this.clientHeight,
              stack: String(new Error().stack ?? '').split('\n').slice(1, 7).join(' <- '),
            })
          }
          desc.set.call(this, v)
        },
      })
      scroller.__lsPatched = true
    }
    /*
     * **号要按趟分家**(第一版在这儿栽了一次):`__lsId` 是写在 DOM 节点上的,
     * 上一趟留下的号活过了这一趟的重置(`seq = 0` 只重置闭包)。于是这一趟新长出来
     * 的节点拿到 `n1`,而屏上某个老节点身上也写着 `n1` —— 两件东西一个号,
     * `indexFrame` 那张表后写的盖掉先写的,`a.get(id)` 与 `b.get(id)` 于是永远是
     * 同一件东西,**位移恒为 0**。表现是「事件有十几条、位移一条都没有」
     * (D / E / G / H 四档第一版全报 0,正是它)。
     */
    const run = (window.__lsRun = (window.__lsRun ?? 0) + 1)
    let seq = 0
    const idOf = (el) => {
      if (el.__lsRun !== run) {
        el.__lsRun = run
        el.__lsId = `r${run}n${(seq += 1)}`
      }
      return el.__lsId
    }
    const labelOf = (el) => {
      if (el.__lsLabel) return el.__lsLabel
      const bits = [el.tagName.toLowerCase()]
      const tid = el.getAttribute?.('data-testid')
      if (tid) bits.push(`#${tid}`)
      const prose = el.getAttribute?.('data-prose')
      if (prose) bits.push(`prose=${prose}`)
      if (el.hasAttribute?.('data-tool-card')) bits.push('toolcard')
      if (el.hasAttribute?.('data-seat')) bits.push('seat')
      if (el.hasAttribute?.('data-context-of')) bits.push('context-of')
      if (el.hasAttribute?.('data-retry-of')) bits.push('retry-of')
      const cls = typeof el.className === 'string' ? el.className : ''
      const frag = cls.split(/\s+/).filter(Boolean)
        .map((c) => c.replace(/^_/, '').replace(/_[a-z0-9]{5,}_\d+$/, ''))
        .slice(0, 2).join('.')
      if (frag) bits.push(`.${frag}`)
      el.__lsLabel = bits.join(' ')
      return el.__lsLabel
    }
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { id: idOf(el), label: labelOf(el), top: r.top, h: r.height }
    }
    const tailRows = (column, n = 8) => {
      const kids = column.children
      const out = []
      for (let i = kids.length - 1; i >= 0 && out.length < n; i -= 1) out.push(kids[i])
      return out.reverse()
    }
    const tick = (t) => {
      if (window.__lsStop) return
      const pane = window.__lsLeaf()
      const scroll = pane.querySelector('[data-testid="chat-stream"]')
      const column = scroll?.firstElementChild
      if (scroll && column) {
        const sr = scroll.getBoundingClientRect()
        let live = null; let user = null; let ctxRow = null; let retryRow = null; let seat = null
        for (const el of tailRows(column)) {
          if (el.hasAttribute('data-seat')) { seat = el; continue }
          if (el.hasAttribute('data-context-of')) { ctxRow = el; continue }
          if (el.hasAttribute('data-retry-of')) { retryRow = el; continue }
          if (!el.hasAttribute('data-message-id')) continue
          if (el.getAttribute('data-role') === 'user') { user = el; continue }
          live = el
        }
        /* 活消息那一行的**直接子元素**逐个记(这就是「谁在推谁」的那一层)。 */
        const kids = []
        if (live) {
          /* article > (prose fragment) —— fragment 不产生元素,所以直接子元素就是
             折痕 / 各段 / 来源条 / 光标 / 收场通知 / 外缘那一行。 */
          for (const el of live.children) kids.push(rect(el))
        }
        const thoughtEl = live?.querySelector('[data-testid="chat-thought"]') ?? null
        const named = {
          user: rect(user),
          ctx: ctxRow ? { ...rect(ctxRow), state: ctxRow.querySelector('[data-testid="context-delta-seam"]')?.getAttribute('data-state') ?? null } : null,
          retry: rect(retryRow),
          seat: seat ? { ...rect(seat) } : null,
          waiting: rect(live?.querySelector('[data-testid="waiting-seam"]') ?? retryRow?.querySelector('[data-testid="waiting-seam"]') ?? null),
          readout: rect(live?.querySelector('[data-testid="chat-readout"]') ?? null),
          chrome: rect(live?.querySelector('[data-testid="chat-chrome"]') ?? null),
          cursor: rect(live?.querySelector('[data-testid="chat-streaming"]') ?? null),
          thought: thoughtEl ? { ...rect(thoughtEl), expanded: thoughtEl.getAttribute('aria-expanded') } : null,
          follow: rect(pane.querySelector('[data-testid="chat-follow-pill"]') ?? null),
          anchor: rect(window.__lsAnchor && window.__lsAnchor.isConnected ? window.__lsAnchor : null),
          tools: live ? Array.prototype.map.call(live.querySelectorAll('[data-tool-card]'), rect) : [],
        }
        window.__lsFrames.push({
          t,
          st: scroll.scrollTop,
          sh: scroll.scrollHeight,
          ch: scroll.clientHeight,
          vTop: sr.top,
          vBottom: sr.bottom,
          streaming: Boolean(live?.querySelector('[data-testid="chat-stop"]')),
          /* 这一轮那条助手行的身份 —— 换了就是换了一轮(尾窗滑动带来的「消失」
             不是布局回缩,必须与真的回缩分开,否则整张表全是假因)。 */
          liveId: live ? idOf(live) : null,
          /* 滚动容器自己的身份:它换了人,`scrollTop` 从 0 起 —— 那不是钳位,是重挂。 */
          scrollId: idOf(scroll),
          /* 「这一轮画得出内容了」—— **等待折痕不算**(它自己也报 `data-prose="object"`,
             算进去的话落位窗会在折痕挂上来那一帧就关掉,落位那一段整段被读成跳动)。 */
          hasContent: Boolean(live?.querySelector(
            '[data-prose]:not([data-testid="waiting-seam"]), [data-testid="chat-thought"], [data-tool-card]')),
          kids,
          named,
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopSampler(page) {
  return page.evaluate(() => {
    window.__lsStop = true
    const frames = window.__lsFrames ?? []
    const writes = window.__lsWrites ?? []
    window.__lsFrames = []
    window.__lsWrites = []
    for (const f of frames) f.__writes = undefined
    if (frames.length) frames[0].__writes = writes.map((w) => ({ ...w, t: Math.round(w.t - frames[0].t) }))
    return frames
  })
}

/* ══ 事后那一遍算 ══════════════════════════════════════════════════════════ */

const EPS = 1.0            // 「动了」的判据(px)。亚像素钳位不算。
const SHRINK_EPS = 2.0     // 「高度变小」的判据(px)。
const BOTTOM_SLACK = 6     // 贴底判据:st + ch >= sh - 6。

/** 把一帧摊成 id → 矩形 的表(kids + named + tools 全收)。 */
function indexFrame(f) {
  const map = new Map()
  const put = (r, role) => { if (r && r.id) map.set(r.id, { ...r, role }) }
  for (const k of f.kids) put(k, 'kid')
  for (const [name, v] of Object.entries(f.named)) {
    if (!v) continue
    if (Array.isArray(v)) { for (const r of v) put(r, name); continue }
    put(v, name)
  }
  return map
}

const atBottom = (f) => f.st + f.ch >= f.sh - BOTTOM_SLACK
const inViewport = (r, f) => r && r.h > 0 && r.top < f.ch + f.vTop && r.top + r.h > f.vTop

/**
 * 从逐帧采样里导出「事件」清单。
 *  (a) 被跟踪元素高度变小 / 从树上消失;
 *  (b) 元素出现并把下面的东西推下去;
 * 每条事件带上同一帧里**视口内其他元素的位移**,并区分「跟底正常上推」与
 * 「回缩 / 插入造成的跳动」。
 */
function extractEvents(frames, t0) {
  const events = []
  /*
   * **这一轮**第一块内容上屏的那一帧 —— 在它之前的滚动是「发送落位」(规矩 ①
   * 那一次有控制的滑动),是设计要的,不是跳动。
   * 判据要认身份:开录那一刻列尾还是**上一轮**那条满是内容的助手行,不认身份的话
   * `hasContent` 第 0 帧就为真,落位段整段被算成跳动。
   */
  const baseLive = frames[0].liveId
  const firstContent = frames.findIndex((f) => f.liveId !== baseLive && f.hasContent)
  for (let i = 1; i < frames.length; i += 1) {
    const prev = frames[i - 1]
    const cur = frames[i]
    /* 换了一轮(助手行换人)或换了滚动容器 = 尾窗滑动 / 重挂,那一帧的因全是假因。 */
    if (prev.liveId !== cur.liveId || prev.scrollId !== cur.scrollId) continue
    const a = indexFrame(prev)
    const b = indexFrame(cur)
    const causes = []
    /** 这一帧里**长高**了的元素的顶 —— 只参与「改动点在哪」的计算,不进清单。 */
    const grewTops = []
    for (const [id, ra] of a) {
      const rb = b.get(id)
      if (!rb) {
        if (ra.h >= SHRINK_EPS) causes.push({ kind: 'gone', id, label: ra.label, role: ra.role, dh: -ra.h })
        continue
      }
      const dh = rb.h - ra.h
      if (dh <= -SHRINK_EPS) causes.push({ kind: 'shrink', id, label: ra.label, role: ra.role, dh })
      /*
       * **长高也是一个改动点**,只是它不报进清单(清单只要回缩与插入)。
       * 不把它算进改动点的话:一帧里思考段长高 19.2px、座位同时缩 19.2px,唯一被
       * 认出来的「因」是座位(它在最底下),于是它上面的读数行 / 光标被判成
       * 「改动点以上的东西动了」—— 一条**假跳动**。真正的改动点在思考段那里,
       * 读数行在它**下面**,往下挪 19.2px 正是正常的阅读流。
       */
      else if (dh >= SHRINK_EPS) grewTops.push(rb.top)
    }
    for (const [id, rb] of b) {
      if (a.has(id)) continue
      if (rb.h >= SHRINK_EPS) causes.push({ kind: 'appear', id, label: rb.label, role: rb.role, dh: rb.h })
    }
    if (!causes.length) continue

    /* 后果:同一帧里视口内其他元素的 viewport top 位移了多少。 */
    const moves = []
    for (const [id, ra] of a) {
      const rb = b.get(id)
      if (!rb) continue
      if (causes.some((c) => c.id === id && c.kind !== 'shrink')) continue
      if (!inViewport(ra, prev) && !inViewport(rb, cur)) continue
      const d = rb.top - ra.top
      if (Math.abs(d) < EPS) continue
      moves.push({ id, label: ra.label, role: ra.role, d })
    }
    const dSh = cur.sh - prev.sh
    const dSt = cur.st - prev.st
    const pinned = atBottom(prev) && atBottom(cur)
    const grew = dSh > 0
    const maxMove = moves.reduce((m, x) => Math.max(m, Math.abs(x.d)), 0)

    /*
     * ── 判据的核心:**改动点以上的东西动没动** ────────────────────────────
     * 人正在读的字在改动点**上面**。改动点下面的东西被推下去(新内容长出来)
     * 是正常的阅读流;改动点上面的东西挪了,才是「屏幕自己动了」。
     */
    const causeTop = causes.reduce((m, c) => {
      const r = b.get(c.id) ?? a.get(c.id)
      return r ? Math.min(m, r.top) : m
    }, grewTops.length ? Math.min(...grewTops) : Number.POSITIVE_INFINITY)
    const above = moves.filter((m) => {
      const ra = a.get(m.id)
      return ra && ra.top + ra.h <= causeTop + 1
    })
    const aboveShift = above.reduce((m, x) => Math.max(m, Math.abs(x.d)), 0)

    /* 「跟底正常上推」:scrollHeight 在长、两帧都贴着底、所有位移都是往上。 */
    const normalFollow = pinned && grew && moves.every((m) => m.d <= 0)
    const landing = firstContent >= 0 && i <= firstContent
    let classify = 'quiet'
    if (landing) classify = 'landing'
    else if (aboveShift >= EPS) classify = normalFollow ? 'follow' : 'jank'
    else if (normalFollow) classify = 'follow'
    else if (maxMove >= EPS) classify = 'growth'

    events.push({
      i,
      ms: Math.round(cur.t - t0),
      dtMs: Math.round(cur.t - prev.t),
      causes,
      moves: moves.sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 8),
      above: above.map((x) => `${x.label} ${x.d > 0 ? '+' : ''}${x.d.toFixed(1)}`),
      maxMove,
      aboveShift,
      dSh: Number(dSh.toFixed(1)),
      dSt: Number(dSt.toFixed(1)),
      pinned,
      classify,
    })
  }
  return events
}

/** 一条元素的整段轨迹读数(动过几次 / 最大单帧位移 / 方向反转)。 */
function trackTrajectory(frames, pick) {
  let moves = 0
  let maxStep = 0
  let flips = 0
  let dir = 0
  let present = 0
  let firstTop
  let lastTop
  let prev
  for (const f of frames) {
    const r = pick(f)
    if (!r) { prev = undefined; continue }
    present += 1
    if (firstTop === undefined) firstTop = r.top
    lastTop = r.top
    if (prev !== undefined) {
      const d = r.top - prev
      if (Math.abs(d) >= EPS) {
        moves += 1
        maxStep = Math.max(maxStep, Math.abs(d))
        const nd = Math.sign(d)
        if (dir !== 0 && nd !== 0 && nd !== dir) flips += 1
        if (nd !== 0) dir = nd
      }
    }
    prev = r.top
  }
  return {
    frames: present,
    moves,
    maxStepPx: Number(maxStep.toFixed(1)),
    flips,
    firstTop: firstTop === undefined ? null : Number(firstTop.toFixed(1)),
    lastTop: lastTop === undefined ? null : Number(lastTop.toFixed(1)),
  }
}

/** scrollTop 有没有被钳一下再补回(方向反转)。 */
function scrollReversals(frames) {
  const out = []
  let dir = 0
  for (let i = 1; i < frames.length; i += 1) {
    const d = frames[i].st - frames[i - 1].st
    if (Math.abs(d) < 0.5) continue
    const nd = Math.sign(d)
    if (dir !== 0 && nd !== dir) {
      out.push({ ms: Math.round(frames[i].t - frames[0].t), from: Number(frames[i - 1].st.toFixed(1)), to: Number(frames[i].st.toFixed(1)) })
    }
    dir = nd
  }
  return out
}

/**
 * **换手那一下**(等待折痕在扫的最后一帧 → 此后 300ms):用户报的第一条就问这个。
 * 报三格:自己那条气泡、读数行、活消息行本身,各动了多少。
 */
function handoffMetrics(frames) {
  const sweeping = (f) => Boolean(f.named.waiting) || f.named.ctx?.state === 'running'
  const last = frames.map(sweeping).lastIndexOf(true)
  if (last < 0) return { sawSweep: false }
  const base = frames[last]
  const until = base.t + 300
  const win = frames.filter((f) => f.t >= base.t && f.t <= until)
  const delta = (pick) => {
    const b = pick(base)
    if (!b) return null
    let max = 0
    let end = null
    for (const f of win) {
      const r = pick(f)
      if (!r) continue
      max = Math.max(max, Math.abs(r.top - b.top))
      end = r.top - b.top
    }
    return { maxPx: Number(max.toFixed(1)), endPx: end === null ? null : Number(end.toFixed(1)) }
  }
  return {
    sawSweep: true,
    kind: base.named.waiting ? 'waiting-seam' : 'context-delta-seam',
    atMs: Math.round(base.t - frames[0].t),
    windowFrames: win.length,
    seamHeightPx: Number((base.named.waiting ?? base.named.ctx)?.h?.toFixed(1) ?? 0),
    userBubble: delta((f) => f.named.user),
    readout: delta((f) => f.named.readout),
    liveRowTop: delta((f) => f.kids[0] ?? null),
    scrollTop: {
      from: Number(base.st.toFixed(1)),
      to: Number((win[win.length - 1]?.st ?? base.st).toFixed(1)),
    },
  }
}

function analyze(frames, marks = {}) {
  if (!frames.length) return { frames: 0, empty: true, ...marks }
  const t0 = frames[0].t
  const events = extractEvents(frames, t0)
  const janks = events.filter((e) => e.classify === 'jank' && e.aboveShift >= 2)
  const growths = events.filter((e) => e.classify === 'growth' && e.maxMove >= 2)
  const streamFrames = frames.filter((f) => f.streaming).length
  const span = frames[frames.length - 1].t - t0
  return {
    frames: frames.length,
    spanMs: Math.round(span),
    fps: Math.round((frames.length / Math.max(1, span)) * 1000),
    streamFrames,
    waitingFrames: frames.filter((f) => f.named.waiting).length,
    ctxFrames: frames.filter((f) => f.named.ctx).length,
    ctxSweepFrames: frames.filter((f) => f.named.ctx?.state === 'running').length,
    seatMax: Math.max(0, ...frames.map((f) => f.named.seat?.h ?? 0)),
    readout: trackTrajectory(frames, (f) => f.named.readout),
    user: trackTrajectory(frames, (f) => f.named.user),
    anchor: trackTrajectory(frames, (f) => f.named.anchor),
    thought: trackTrajectory(frames, (f) => f.named.thought),
    scrollFlips: scrollReversals(frames),
    /** >200px 的 `scrollTop` **赋值**(浏览器钳位不走 setter,所以这里全是 JS 写的)。 */
    bigScrollWrites: frames[0].__writes ?? [],
    /** 滚动容器换过几次人(重挂)—— 换了就别把那一帧的 `scrollTop` 归零读成钳位。 */
    scrollRemounts: frames.filter((f, i) => i > 0 && f.scrollId !== frames[i - 1].scrollId).length,
    handoff: handoffMetrics(frames),
    eventCount: events.length,
    landingEvents: events.filter((e) => e.classify === 'landing').length,
    followEvents: events.filter((e) => e.classify === 'follow').length,
    growthEvents: growths.length,
    jankEvents: janks.length,
    jankMaxPx: Number(janks.reduce((m, e) => Math.max(m, e.aboveShift), 0).toFixed(1)),
    /** **改动点以上的东西挪了** —— 报告第一张表读的就是这一串。 */
    topJank: janks.sort((x, y) => y.aboveShift - x.aboveShift).slice(0, 12).map((e) => ({
      ms: e.ms,
      dtMs: e.dtMs,
      abovePx: Number(e.aboveShift.toFixed(1)),
      dSh: e.dSh,
      dSt: e.dSt,
      pinned: e.pinned,
      causes: e.causes.map((c) => `${c.kind} ${c.label} ${c.dh > 0 ? '+' : ''}${c.dh.toFixed(1)}px`),
      above: e.above,
    })),
    /** 改动点**以下**被推挤的(正常阅读流,只报不判)—— 读数行的那些跳都在这里。 */
    topGrowth: growths.sort((x, y) => y.maxMove - x.maxMove).slice(0, 8).map((e) => ({
      ms: e.ms,
      maxMovePx: Number(e.maxMove.toFixed(1)),
      dSh: e.dSh,
      dSt: e.dSt,
      pinned: e.pinned,
      causes: e.causes.map((c) => `${c.kind} ${c.label} ${c.dh > 0 ? '+' : ''}${c.dh.toFixed(1)}px`),
      moves: e.moves.map((m) => `${m.label} ${m.d > 0 ? '+' : ''}${m.d.toFixed(1)}`),
    })),
    ...marks,
  }
}

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
    const pane = window.__lsLeaf()
    const box = pane.querySelector('[data-testid="composer-input"]')
    if (!box) return false
    box.textContent = value
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, text)
  if (!ok) throw new Error('打不进去:没有 composer-input')
  await delay(200)
  const sent = await page.evaluate(() => {
    const send = window.__lsLeaf().querySelector('[data-testid="composer-send"]')
    if (!(send instanceof HTMLElement) || send.hasAttribute('disabled')) return false
    send.click()
    return true
  })
  if (!sent) throw new Error('发送键点不动')
}

const stopShown = (page) => page.evaluate(() =>
  Boolean(window.__lsLeaf().querySelector('[data-testid="chat-stream"] [data-testid="chat-stop"]')))

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[layout-shift] 缺 ${path.relative(repoRoot, serverEntry)} —— 仓根 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry)) {
    console.error('[layout-shift] 缺 dist-electron/main.cjs —— `npm run electron:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'ls-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'ls-udd-'))
  const providerState = {}
  let provider; let server; let app; let vite
  const readings = { viewport: VIEWPORT, lane: 'dev', scenarios: {} }
  const rawFrames = {}

  const startCore = async () => {
    const child = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ...FAKE_PROVIDER_ENV, ONETHING_STORE_PATH: store },
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const err = []
    child.stderr.on('data', (c) => err.push(c.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === child.pid ? found : undefined
    }).catch((e) => { throw new Error(`${e.message}\nstderr:\n${err.join('').slice(-2000)}`) })
    if (!(await portConnects(record.host, record.port))) throw new Error('core 端口连不上')
    return { child, record }
  }
  const stopCore = async (child) => {
    if (!child) return
    child.kill('SIGTERM')
    await delay(1200)
    if (!child.killed) child.kill('SIGKILL')
    await delay(300)
  }

  try {
    console.log('\n[1/5] 起假 provider + core,建两条会话')
    provider = await startProvider(providerState)
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
    const idA = (await rpc(core.record, 'sessions', 'create', { name: '布局探针 · A/B' }))?.session?.id
    const idB = (await rpc(core.record, 'sessions', 'create', { name: '布局探针 · C-H' }))?.session?.id
    if (!idA || !idB) throw new Error('会话没建出来')

    console.log('[2/5] 停 core,直写账本起底,再起回来')
    await stopCore(server)
    const fixture = { messages: 10, toolCallsPerTurn: [1], targetBytes: 0, targetToolCalls: 0, largeResults: 0, images: 0 }
    const seeded = {
      a: seedLargeLedger(store, idA, fixture),
      b: seedLargeLedger(store, idB, fixture),
    }
    console.log(`      A ${(seeded.a.bytes / 1024).toFixed(0)}KB/${seeded.a.messages} 条 · `
      + `B ${(seeded.b.bytes / 1024).toFixed(0)}KB/${seeded.b.messages} 条`)
    core = await startCore()
    server = core.child

    console.log(`[3/5] 起 vite dev(端口 ${DEV_PORT},不是 5175)`)
    const { createServer } = await import('vite')
    vite = await createServer({
      configFile: path.join(appRoot, 'vite.config.ts'),
      server: { port: DEV_PORT, strictPort: true },
      logLevel: 'warn',
    })
    await vite.listen()
    const rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`

    console.log('[4/5] 拉起应用(屏外档 · 独立 user-data-dir)')
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
    await page.addInitScript(LEAF_PROBE)
    await page.evaluate(LEAF_PROBE)
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const v = await page.evaluate(() => window.__d0 ?? null)
      return v && v.rpcOk ? v : undefined
    })

    const openSession = async (sessionId, expect) => {
      const rowShown = () => page.evaluate((id) =>
        Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId)
      for (let n = 0; n < 3 && !(await rowShown()); n += 1) {
        await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
        await delay(600)
      }
      await waitFor('总览画出那一行', rowShown)
      await clickTestId(page, `session-row-${sessionId}`)
      await waitFor('聊天区起底', async () => {
        const n = await page.evaluate(() => window.__lsLeaf()
          .querySelectorAll('[data-testid="chat-stream"] [data-message-id]').length)
        return n >= Math.min(expect, 8) ? n : undefined
      })
      await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
      await delay(600)
    }

    /**
     * 跑一轮:开录 → 发 → 等开张 → (可选的中途动作)→ 等收场 → 收录。
     * `during` 收到 `{ page }`,由它自己决定什么时候动手(滚动 / 按停止)。
     */
    /**
     * **每一轮开录之前先回到底**。理由是一次实测事故:C 收尾那一下 `scrollTop`
     * 被钳到 0(见那一档的读数),此后 D / E / G / H 四档全程在离活消息一万五千
     * 像素以外的地方采样 —— `moves` 那道「在视口里」的筛子于是把一切都筛掉了,
     * 四档一齐报 0。**人发下一条消息时是在底部**,这一句就是把夹具摆回那个姿势。
     */
    const scrollToBottom = async () => {
      await page.evaluate(() => {
        const scroll = window.__lsLeaf().querySelector('[data-testid="chat-stream"]')
        if (scroll) scroll.scrollTop = scroll.scrollHeight
      })
      await delay(500)
    }

    const runOnce = async (label, text, { timeoutMs = 180_000, during, tailMs = 1500, keepScroll = false, keepAnchor = false } = {}) => {
      console.log(`  · ${label}`)
      if (!keepScroll) await scrollToBottom()
      if (!keepAnchor) await page.evaluate(() => { window.__lsAnchor = undefined })
      await startSampler(page)
      const wall = Date.now()
      await sendViaComposer(page, text)
      await waitFor(`${label} 开张`, () => stopShown(page), 120_000)
      let duringNote
      if (during) duringNote = await during({ page })
      await waitFor(`${label} 收场`, async () => !(await stopShown(page)), timeoutMs)
      await delay(tailMs)
      const frames = await stopSampler(page)
      /* 原始帧另存一份:再算一遍判据不必再跑一趟真机(一趟十几分钟)。 */
      rawFrames[label] = frames
      const out = analyze(frames, { label, laneMs: Date.now() - wall, duringNote })
      console.log(`      ${out.frames} 帧 @${out.fps}fps · **跳动** ${out.jankEvents}(最大 ${out.jankMaxPx}px)`
        + ` · 下推 ${out.growthEvents} · 跟底 ${out.followEvents} · 落位 ${out.landingEvents}`
        + ` · 读数行动 ${out.readout.moves} 次/最大 ${out.readout.maxStepPx}px/反转 ${out.readout.flips}`
        + ` · scrollTop 反转 ${out.scrollFlips.length}`)
      const h = out.handoff
      console.log(`      换手(${h.sawSweep ? `${h.kind} @${h.atMs}ms,折痕高 ${h.seamHeightPx}px,窗内 ${h.windowFrames} 帧` : '没采到在扫的折痕'})`
        + (h.sawSweep ? ` · 气泡 最远 ${h.userBubble?.maxPx}/终 ${h.userBubble?.endPx}px`
          + ` · 读数行 最远 ${h.readout?.maxPx}/终 ${h.readout?.endPx}px`
          + ` · 活消息行顶 最远 ${h.liveRowTop?.maxPx}/终 ${h.liveRowTop?.endPx}px` : ''))
      for (const s of out.topJank.slice(0, 6)) {
        console.log(`        [跳动 ${s.ms}ms +${s.dtMs}ms] 上方位移 ${s.abovePx}px dSh=${s.dSh} dSt=${s.dSt}`
          + ` pinned=${s.pinned}\n           因:${s.causes.join(' | ')}\n           果(上方):${s.above.join(' | ')}`)
      }
      if (process.argv.includes('--trace')) {
        for (const s of out.topGrowth.slice(0, 5)) {
          console.log(`        [下推 ${s.ms}ms] ${s.maxMovePx}px dSh=${s.dSh} dSt=${s.dSt} pinned=${s.pinned}`
            + `\n           因:${s.causes.join(' | ')}\n           果:${s.moves.join(' | ')}`)
        }
      }
      return out
    }

    console.log('\n[5/5] 场景')

    /* ── B:有上下文更新行的那一轮(同一条会话的第一轮 live turn)────────── */
    await openSession(idA, seeded.a.messages)
    if (want('B')) {
      readings.scenarios.B_contextDelta = await runOnce(
        'B 上下文更新行那一轮', `布局探针 B ${MARKS.ctx}`)
    }
    /* ── A:没有上下文更新行的那几轮(第二轮起,turnContext 被去重) ──────── */
    if (want('A')) {
      readings.scenarios.A_text = await runOnce('A1 首块=一行正文', `布局探针 A1 ${MARKS.text}`)
      readings.scenarios.A_heading = await runOnce('A2 首块=标题', `布局探针 A2 ${MARKS.head}`)
      readings.scenarios.A_code = await runOnce('A3 首块=代码块', `布局探针 A3 ${MARKS.code}`)
      readings.scenarios.A_thought = await runOnce('A4 首块=思考段', `布局探针 A4 ${MARKS.think}`)
    }

    await openSession(idB, seeded.b.messages)

    /* ── C:≈3 屏思考 → 正文,一直贴底 ─────────────────────────────────── */
    if (want('C')) {
      readings.scenarios.C_longThoughtPinned = await runOnce(
        'C 长思考(贴底)', `布局探针 C ${MARKS.long}`, { tailMs: 2000 })
    }

    /* ── D:思考流到一半往上拨半屏(人停下来读) ───────────────────────── */
    if (want('D')) {
      readings.scenarios.D_scrolledAway = await runOnce(
        'D 长思考(中途上拨半屏)', `布局探针 D ${MARKS.long}`, {
          tailMs: 2000,
          during: async () => {
            /*
             * 等思考真的长起来,再往上拨半屏,并把此刻视口中央那一块钉成锚点。
             * **问的是活消息那一行里的那一段** —— `querySelector` 拿到的是文档序里
             * 第一条,那是上一轮那段早已折起、而且因为 `content-visibility: auto`
             * 高度读作 0 的思考(第一版在这儿等了 60s 等了个寂寞)。
             */
            await waitFor('活消息里的思考段长到一屏以上', async () => page.evaluate(() => {
              const rows = window.__lsLeaf().querySelectorAll('[data-testid="chat-stream"] [data-message-id]')
              const live = rows[rows.length - 1]
              const th = live?.querySelector('[data-testid="chat-thought"]')
              return th ? th.getBoundingClientRect().height > 900 : false
            }), 90_000)
            await delay(1200)
            return page.evaluate(() => {
              const scroll = window.__lsLeaf().querySelector('[data-testid="chat-stream"]')
              const before = scroll.scrollTop
              scroll.scrollTop = Math.max(0, before - Math.round(scroll.clientHeight / 2))
              const r = scroll.getBoundingClientRect()
              /* 视口正中那一块字 —— 「用户正在读的那一段」。 */
              let el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
              while (el && el !== scroll && !(el.tagName === 'P' || el.hasAttribute?.('data-prose'))) el = el.parentElement
              if (el && el !== scroll) window.__lsAnchor = el
              return {
                scrolledFrom: before,
                scrolledTo: scroll.scrollTop,
                anchor: window.__lsAnchor
                  ? { tag: window.__lsAnchor.tagName, top: window.__lsAnchor.getBoundingClientRect().top }
                  : null,
              }
            })
          },
        })
      readings.scenarios.D_olderThoughtAfter = await page.evaluate(() => {
        const th = window.__lsOlderThought
        if (!th || !th.isConnected) return { gone: true }
        const r = th.getBoundingClientRect()
        return { top: r.top, h: r.height, expanded: th.getAttribute('aria-expanded') }
      })
    }

    /* ── E:思考 → 工具(慢 + 快)→ 思考 → 正文 ────────────────────────── */
    if (want('E')) {
      readings.scenarios.E_tools = await runOnce('E 思考→工具→思考→正文', `布局探针 E ${MARKS.tools}`, { tailMs: 2000 })
    }

    /* ── G:块级内容流式成形 ──────────────────────────────────────────── */
    if (want('G')) {
      readings.scenarios.G_blocks = await runOnce('G 代码/表格/公式/列表', `布局探针 G ${MARKS.blocks}`, { tailMs: 2500 })
    }

    /* ── H:中途按停止(顺带 F 的 StopNotice)──────────────────────────── */
    if (want('H') || want('F')) {
      readings.scenarios.H_abort = await runOnce('H 中途按停止', `布局探针 H ${MARKS.abort}`, {
        during: async () => {
          await delay(3500)
          return page.evaluate(() => {
            const btn = window.__lsLeaf().querySelector('[data-testid="chat-stop"]')
            if (!(btn instanceof HTMLElement)) return { aborted: false }
            btn.click()
            return { aborted: true, at: performance.now() }
          })
        },
        tailMs: 2500,
      })
    }

    /*
     * ── D2:人手动展开过的、**更早一轮**的思考段,在新一轮里会不会被动到 ────────
     * 放在最后跑:它把视口停在一段一万五千像素高的展开思考中间,之后任何一档都
     * 不再是「人在底部发消息」那个姿势(第一版把它排在 C 之后,后面四档全废)。
     */
    if (want('D')) {
      console.log('  · D2 更早一轮的思考段被手动展开着')
      readings.scenarios.D2_before = await page.evaluate(() => {
        const rows = window.__lsLeaf().querySelectorAll('[data-testid="chat-stream"] [data-message-id]')
        /* 取**倒数第二条**带思考的助手行 —— 最后一条是刚收摊那一轮,不算「更早」。 */
        const hits = []
        for (const row of rows) {
          const th = row.querySelector('[data-testid="chat-thought"]')
          if (th) hits.push(th)
        }
        const th = hits[Math.max(0, hits.length - 2)]
        if (!th) return null
        th.scrollIntoView({ block: 'center' })
        th.click()
        window.__lsOlderThought = th
        return { expandedNow: th.getAttribute('aria-expanded') }
      })
      await delay(900)
      /* 展开之后把视口停在它中间,并把此刻屏幕正中那一段字钉成锚点。 */
      readings.scenarios.D2_parked = await page.evaluate(() => {
        const th = window.__lsOlderThought
        if (!th) return null
        const scroll = window.__lsLeaf().querySelector('[data-testid="chat-stream"]')
        const r0 = th.getBoundingClientRect()
        scroll.scrollTop += r0.top - scroll.getBoundingClientRect().top + Math.round(r0.height / 2)
        const sr = scroll.getBoundingClientRect()
        let el = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2)
        while (el && el !== scroll && el.tagName !== 'P') el = el.parentElement
        if (el && el !== scroll) window.__lsAnchor = el
        const r = th.getBoundingClientRect()
        return {
          thoughtTop: Number(r.top.toFixed(1)),
          thoughtHeight: Number(r.height.toFixed(1)),
          expanded: th.getAttribute('aria-expanded'),
          scrollTop: Number(scroll.scrollTop.toFixed(1)),
          anchorTop: window.__lsAnchor ? Number(window.__lsAnchor.getBoundingClientRect().top.toFixed(1)) : null,
        }
      })
      await delay(400)
      readings.scenarios.D2_turn = await runOnce('D2 新一轮开始/结束时它动不动',
        `布局探针 D2 ${MARKS.text}`, { keepScroll: true, keepAnchor: true, tailMs: 2000 })
      readings.scenarios.D2_after = await page.evaluate(() => {
        const th = window.__lsOlderThought
        if (!th || !th.isConnected) return { gone: true }
        const r = th.getBoundingClientRect()
        return {
          thoughtTop: Number(r.top.toFixed(1)),
          thoughtHeight: Number(r.height.toFixed(1)),
          expanded: th.getAttribute('aria-expanded'),
          anchorTop: window.__lsAnchor?.isConnected
            ? Number(window.__lsAnchor.getBoundingClientRect().top.toFixed(1)) : null,
        }
      })
      console.log(`      D2 停靠 ${JSON.stringify(readings.scenarios.D2_parked)}`)
      console.log(`      D2 之后 ${JSON.stringify(readings.scenarios.D2_after)}`)
    }

    /* 块级内容真的渲染出来了吗 —— G 那一档的自证(没渲染出来的形不该拿去报数)。 */
    readings.blockCensus = await page.evaluate(() => {
      const leaf = window.__lsLeaf()
      const rows = leaf.querySelectorAll('[data-testid="chat-stream"] [data-message-id]')
      const n = (sel) => leaf.querySelectorAll(sel).length
      return {
        rows: rows.length,
        katex: n('.katex, .katex-display'),
        pre: n('pre'),
        shikiHighlighted: n('pre span[style*="color"]'),
        tables: n('table'),
        toolCards: n('[data-tool-card]'),
        stopNotice: n('[data-testid="chat-stop-notice"]') || n('[class*="stopNotice"]'),
      }
    })
    console.log(`      块级内容清点:${JSON.stringify(readings.blockCensus)}`)

    writeFileSync(OUT, JSON.stringify(readings, null, 2))
    writeFileSync(`${OUT}.frames.json`, JSON.stringify(rawFrames))
    console.log(`\n[layout-shift] 读数写在 ${OUT}(原始帧 ${OUT}.frames.json)`)
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
}

main().catch((error) => {
  console.error(`\n[layout-shift] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
