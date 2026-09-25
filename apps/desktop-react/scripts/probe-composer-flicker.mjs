#!/usr/bin/env node
/**
 * **输入框闪烁**的真机探针(2026-09-21 报障:「滚动的时候 composer 偶尔会闪烁
 * (消失又出现)」)。
 *
 * 支架、假 provider、离屏档、收尸纪律全部照抄 `gate-stream-geometry.mjs` 与
 * `gate-send-flow.mjs`;**闪烁类报障禁纸上诊断**(壳 CLAUDE.md 施工纪律),所以这一支
 * 两层同时开,量出读数再说话:
 *
 * ── 两层检测 ──────────────────────────────────────────────────────────────
 *  · **DOM / 样式层**(rAF 逐帧,60Hz):`[data-composer-dock]` 与它里面那块
 *    `[data-testid="composer-panel"]` 的 `isConnected` / 矩形 / computed
 *    `display·visibility·opacity·content-visibility·transform·backdrop-filter`、
 *    `.chatArea` 上那格 `--composer-h` 的值,外加一枚写在面板节点上的 expando 号
 *    —— **号变了 = 换了节点 = React 重挂**(错误边界兜了一次也是这个形)。
 *    同时挂一只 MutationObserver(childList/attributes/subtree)记下每一次改动。
 *  · **像素层**:CDP `Page.startScreencast`(png)整窗抽帧,事后在 node 里解码
 *    (`lib/png.mjs`,零依赖),对三块地各算一格读数:
 *      ① **发送键芯**(`.sendBtn` 是 `background: var(--accent)`,**不透明**)——
 *         它压在玻璃上面,底下正文怎么滚它一个字节都不该变。**这一格是主判据**;
 *      ② **面板整块**的帧间差 + **横向梯度能量**(玻璃把底下糊掉 = 低梯度;
 *         `backdrop-filter` 掉一帧 = 底下的字当场变清晰 = 梯度飙)。
 *      ③ **面板上方一条控制带**(正文区)—— 用来分辨「整屏在动」与「只有输入框在动」。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * 屏外档(`ONETHING_GATE_OFFSCREEN=1`):这支每一格读数都与**页面的时间**有关,
 * `ONETHING_GATE_HEADLESS` 下 Chromium 把整扇窗节流到 1Hz,量的会是节流器。
 * 输入一律走 CDP `Input.dispatchMouseEvent`(只进这扇窗,不动真光标、不抢前台)。
 * store 与 `--user-data-dir` 都是临时目录,跑完删干净,**绝不连 `~/.onething`**。
 * 端口挑 5221 —— 避开用户的 5175 与同机可能并跑的 5196 / 5203 / 5207。
 *
 * ── 2026-09-21 第一趟真机的结论(dev 档 · 官方 Electron 41 · dpr 2 · 120Hz)──
 * **复现不出来。** 17 个场景、DOM 层 15376 帧、像素层 6088 帧,`spike`(= 报障说的
 * 「消失又出现」)**0 个**;DOM 层的面板重挂 / 被藏 / 高度塌 / computed 变化
 * **各 0 次**。同一支探针、同一份夹具在 P1 之前那一版(`d569c5c3d`)上再跑一遍
 * (8 个场景 / DOM 10092 帧 / 像素 2985 帧),读数逐格对得上、同样 0 个 —— 所以
 * **它不是 G 线 P1/P1b 带出来的**。唯一的真发现是一条**多余重渲**:见
 * `Composer.tsx` 的 `ComposerBody` 文件头(超量夹具上快滚 4.3s 提交 94 次、
 * 一路滚到顶 160 次、一分钟杂滚 428 次;`memo` 之后前三格全是 0)。
 * **没覆盖到的条件**逐条写在报告里:真触控板的惯性滚与 macOS 橡皮筋回弹
 * (CDP `mouseWheel` 造不出相位与 overscroll)、真上屏窗口的合成路径、HMR 在跑
 * 的 `electron:dev`、以及「一两帧的闪」在 ~86fps 抽帧下的漏采率
 * (自证那一档人为藏**两**帧,三次里像素层稳定抓到三次;藏**一**帧会漏)。
 *
 * 跑法:`node scripts/probe-composer-flicker.mjs [--only a,b,c] [--selftest] [--prod]`
 *      [--pix-w 2560] [--max-frames 700] [--out <目录>] [--json <路径>]
 * (仓根先 `bun run server:build`;两档都先 `npm run electron:build`,
 *  `--prod` 还要 `npm run app:build`。)
 * **判红**:自证那一档两层都必须红,其余场景 `spike` 与 DOM 命中都必须为 0。
 */
import { spawn, execFileSync } from 'node:child_process'
import http from 'node:http'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { fakeProviderAiSettings, FAKE_PROVIDER_ENV } from '../../../scripts/lib/gate-fake-provider.mjs'
import { seedLargeLedger } from './lib/seed-large-ledger.mjs'
import { installComposerDockProbe } from './lib/composer-dock.mjs'
import { decodePng } from './lib/png.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const PROD = process.argv.includes('--prod')
const LANE = PROD ? 'prod' : 'dev'
const DEV_PORT = Number(process.env.ONETHING_PROBE_VITE_PORT ?? 5221)
const VIEWPORT = { width: 1280, height: 800 }
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : fallback
}
/** `--only a,b,c`:逗号分隔的场景名单(迭代与对照用;不给就是整张矩阵)。 */
const ONLY = (() => {
  const v = argOf('--only')
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null
})()
/** 抽帧图宽(CSS px 口径;窗口 1280 宽时 1280 = 1:1,2560 = retina 原样)。 */
const PIX_W = Number(argOf('--pix-w', 1280))
const OUT_DIR = argOf('--out', path.join(
  process.env.TMPDIR ?? '/tmp', `composer-flicker-${Date.now()}`))
/** 一次抽帧最多存这么多帧(防内存爆:1280×800 的 png 约 200–500KB)。 */
const MAX_PIX_FRAMES = Number(argOf('--max-frames', 700))

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
/** 判红闩。收尸与读数落盘走完之后才 `exit(1)` —— 先收尸,再判。 */
let failed = false

/* ══ 假 provider(照抄 gate-stream-geometry,只留这支要的四个记号)══════════ */

function buildThought(totalChars, seed) {
  let x = seed >>> 0
  const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296 }
  const zh = '这一段是闪烁探针造出来的思考正文它要和真数据同形所以每隔几十个字就断一次行'
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
const THOUGHT_60K = buildThought(60_000, 20260921)
const THOUGHT_3K = buildThought(3_000, 555)
const REPLY_PLAIN = '这是一段普通的正文回答,它要够长,好切成十几段真的流一遍,'
  + '让每一段都逼出一次提交、一次排版。再补几句把这一段撑到两三行。'
const REPLY_LONG = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段:${REPLY_PLAIN}`).join('\n\n')

/**
 * **markdown 块混排**(2026-09-23 追加:用户怀疑「经过 markdown 不同渲染块时 composer 闪」)。
 * 前 17 个场景的料只有散文 / 无围栏代码行 / 少量表格 —— 带围栏的代码块(块壳 +
 * `overflow-x: auto` 横滚 + 高亮)、宽表格、数学块、引用、diff 一格都没有。这份料把
 * 注册表里会进块壳 / 自己横滚的种类轮着排,每一轮都有一行超宽的代码逼出横向滚动条。
 */
const LONG_LINE = 'const x = ' + Array.from({ length: 24 }, (_, i) => `veryLongIdentifier${i}`).join(' + ') + '\n'
const WIDE_TABLE = [
  '| ' + Array.from({ length: 12 }, (_, i) => `列${i + 1}标题比较长`).join(' | ') + ' |',
  '| ' + Array.from({ length: 12 }, () => '---').join(' | ') + ' |',
  ...Array.from({ length: 6 }, (_, r) => '| ' + Array.from({ length: 12 }, (_, i) => `r${r}c${i} 单元格内容`).join(' | ') + ' |'),
].join('\n')
function mdRound(i) {
  return [
    `## 第 ${i + 1} 节:混排`,
    `这一段是普通段落,带 \`inline code\` 与 **粗体**,还有行内公式 $a^2+b^2=c^2$。${REPLY_PLAIN}`,
    '```ts\n' + LONG_LINE + 'export function f(a: number): number {\n  return a * 2\n}\n```',
    '> 引用块:这一段是引用,用来看引用块的左边线与底色。\n> 第二行引用。',
    WIDE_TABLE,
    '$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3} \\qquad \\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n$$',
    '- 列表一\n- 列表二 `code`\n  - 嵌套\n1. 有序一\n2. 有序二',
    '```diff\n- const a = 1\n+ const a = 2\n  unchanged line\n```',
    '```python\n' + 'def g(x):\n    return [i * x for i in range(100)]  # ' + 'long comment '.repeat(20) + '\n```',
    '---',
  ].join('\n\n')
}
const REPLY_MD = Array.from({ length: 8 }, (_, i) => mdRound(i)).join('\n\n')

const MARKS = { warm: '@@f-warm@@', long: '@@f-long@@', think60k: '@@f-think60k@@', tools: '@@f-tools@@', md: '@@f-md@@' }
const LANES = ['short', 'big']
const MARK_BUDGET = 2
const markFor = (mark, lane) => `${mark.slice(0, -2)}-${lane}@@`
const FIRST_BYTE_DELAY_MS = 700

function startProvider(state) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* 形状不对走兜底 */ }
      const msgs = Array.isArray(payload.messages) ? payload.messages : []
      const textOf = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''))
      let lastUser = ''
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i]?.role === 'user') { lastUser = textOf(msgs[i]); break }
      }
      const toolTurns = msgs.filter((m) => m?.role === 'tool').length
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = (o) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(o)}\n\n`) }
      const frame = (delta, finish = null) => ({
        id: 'chatcmpl-flicker', object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: 'deepseek-chat',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const bye = (finish = 'stop') => {
        if (!res.destroyed) { send(frame({}, finish)); res.write('data: [DONE]\n\n') }
        res.end()
      }
      const stream = async (text, pieces, gap) => {
        const size = Math.max(1, Math.ceil(text.length / pieces))
        for (let at = 0; at < text.length; at += size) {
          if (res.destroyed) return
          send(frame({ content: text.slice(at, at + size) }))
          await delay(gap)
        }
      }
      const streamThought = async (text, chunk, gap) => {
        let cursor = 0
        while (cursor < text.length) {
          if (res.destroyed) return
          send(frame({ reasoning_content: text.slice(cursor, cursor + chunk) }))
          cursor += chunk
          await delay(gap)
        }
      }
      let kind = null
      let slot = null
      for (const [name, mark] of Object.entries(MARKS)) {
        for (const lane of LANES) {
          if (lastUser.includes(markFor(mark, lane))) { kind = name; slot = `${name}:${lane}` }
        }
        if (kind) break
      }
      if (kind && kind !== 'tools') {
        state[slot] = (state[slot] ?? 0) + 1
        if (state[slot] > MARK_BUDGET) kind = null
      }
      if (!kind) { bye(); return }
      await delay(FIRST_BYTE_DELAY_MS)
      if (res.destroyed) return
      if (kind === 'tools') {
        if (toolTurns === 0) {
          await streamThought(THOUGHT_3K, 80, 16)
          send(frame({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'bash', arguments: '' } }] }))
          const args = JSON.stringify({ command: 'sleep 0.8; echo done-a' })
          send(frame({ tool_calls: [{ index: 0, function: { arguments: args } }] }))
          bye('tool_calls')
          return
        }
        await stream('工具跑完了,下面是结论。\n\n' + REPLY_LONG, 40, 90)
        bye()
        return
      }
      if (kind === 'think60k') {
        await streamThought(THOUGHT_60K, 90, 16)
        await delay(60)
        await stream('思考结束,下面是结论。\n\n' + REPLY_LONG, 40, 90)
        bye()
        return
      }
      const table = {
        warm: ['热身一轮,不量。', 6, 90],
        long: [REPLY_LONG, 60, 90],
        md: [REPLY_MD, 160, 60],
      }
      const [text, pieces, gap] = table[kind]
      await stream(text, pieces, gap)
      bye()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/* ══ core / 发现文件(照抄)═══════════════════════════════════════════════ */
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
  const started = Date.now()
  let last
  while (Date.now() < started + timeoutMs) {
    last = await predicate()
    if (last) { waitFor.lastMs = Date.now() - started; return last }
    await delay(100)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}
async function rpc(record, domain, method, payload = {}) {
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(record.token ? { authorization: `Bearer ${record.token}` } : {}) },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  const b = await response.json()
  if (!b || b.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(b?.error ?? b)}`)
  return b.data
}

const LEAF_PROBE = `
window.__fLeaf = function () {
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

/* ══ DOM / 样式层:逐帧采样 + MutationObserver ═════════════════════════════ */

async function startDomSampler(page) {
  await page.evaluate(() => {
    window.__cfFrames = []
    window.__cfMuts = []
    window.__cfStop = false
    const run = (window.__cfRun = (window.__cfRun ?? 0) + 1)
    let seq = 0
    const idOf = (el) => {
      if (!el) return null
      if (el.__cfRun !== run) { el.__cfRun = run; el.__cfId = `r${run}n${(seq += 1)}` }
      return el.__cfId
    }
    /*
     * **重挂判据**:号写在**节点**上,而且**不按趟重置** —— 与 `gate-stream-geometry`
     * 的 `__gId` 反着来,理由也反着:那一支比的是「两帧里的两件东西是不是同一件」,
     * 要防的是**跨趟撞号**;这一支问的是「这块面板从头到尾是不是同一个 DOM 节点」,
     * 号一旦按趟重置,重挂就再也看不出来了。所以另开一格 `__cfLife`,进程级递增。
     */
    window.__cfLife = window.__cfLife ?? 0
    const lifeOf = (el) => {
      if (!el) return null
      if (el.__cfLife === undefined) { window.__cfLife += 1; el.__cfLife = window.__cfLife }
      return el.__cfLife
    }
    const dockOf = () => window.__composerDock?.() ?? null

    /* ── MutationObserver:dock 子树上每一次改动 ────────────────────────── */
    let mo = window.__cfMo
    if (mo) mo.disconnect()
    const dock0 = dockOf()
    if (dock0) {
      mo = window.__cfMo = new MutationObserver((records) => {
        for (const r of records) {
          if (window.__cfMuts.length > 4000) break
          const target = r.target instanceof Element ? r.target : r.target?.parentElement
          window.__cfMuts.push({
            t: Math.round(performance.now()),
            type: r.type,
            attr: r.attributeName ?? null,
            tag: target?.tagName ?? null,
            testid: target?.getAttribute?.('data-testid') ?? null,
            cls: (target?.className && typeof target.className === 'string')
              ? target.className.slice(0, 60) : null,
            added: r.addedNodes?.length ?? 0,
            removed: r.removedNodes?.length ?? 0,
          })
        }
      })
      mo.observe(dock0, { childList: true, attributes: true, subtree: true, characterData: false })
    }

    /*
     * **每帧的活儿要便宜**(09-10「探针自伤」判例:量长帧的探针自己制造长帧)。
     * 这一支非读 computed 不可 —— 报障说的就是「样式上消失了」。折中:
     * computed 只读面板那一格(一次 `getComputedStyle` + 6 个属性),不读 dock、
     * 不读别人;`--composer-h` 从 `.chatArea` 的 inline style 上直接读(它就是
     * `useComposerGeometry` 写进去的那一格,不必经过 computed)。
     */
    const tick = (t) => {
      if (window.__cfStop) return
      const pane = window.__fLeaf()
      const dock = dockOf()
      const panel = dock?.querySelector('[data-testid="composer-panel"]') ?? null
      const send = dock?.querySelector('[data-testid="composer-send"]') ?? null
      /*
       * **面板里那只隐藏的 `<input type=file>`**(第一趟真机的唯一异常):滚动期间
       * MutationObserver 报出成串的 `attributes:name@INPUT` / `type@INPUT`,而
       * **2 个 name + 1 个 type 恰好是 React 给一只 input 落地时的签名**
       * (`postMountWrapper`:先把 `name` 清空、设完 `defaultChecked` 再写回去,
       *  加上落 `type` 那一下)。那到底是**换了节点**还是同一个节点被重写属性,
       * 只有节点身份答得出 —— 所以这里单记一格它的号。
       */
      const file = dock?.querySelector('input[type="file"]') ?? null
      const area = dock?.parentElement ?? null
      const scroll = pane.querySelector('[data-testid="chat-stream"]')
      const column = scroll?.firstElementChild ?? null
      const row = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          x: Number(r.left.toFixed(2)), y: Number(r.top.toFixed(2)),
          w: Number(r.width.toFixed(2)), h: Number(r.height.toFixed(2)),
        }
      }
      let cs = null
      if (panel) {
        const c = getComputedStyle(panel)
        cs = {
          display: c.display,
          visibility: c.visibility,
          opacity: c.opacity,
          cv: c.contentVisibility,
          transform: c.transform === 'none' ? 'none' : c.transform,
          bf: (c.backdropFilter || c.webkitBackdropFilter || 'none'),
          bg: c.backgroundColor,
        }
      }
      window.__cfFrames.push({
        t,
        dockThere: Boolean(dock),
        dockConn: dock ? dock.isConnected : null,
        dockLife: lifeOf(dock),
        dockId: idOf(dock),
        dockRect: row(dock),
        panelThere: Boolean(panel),
        panelConn: panel ? panel.isConnected : null,
        panelLife: lifeOf(panel),
        panelRect: row(panel),
        sendRect: row(send),
        fileLife: lifeOf(file),
        cs,
        composerH: area?.style?.getPropertyValue('--composer-h') || null,
        centerH: area?.style?.getPropertyValue('--center-h') || null,
        st: scroll ? scroll.scrollTop : null,
        sh: scroll ? scroll.scrollHeight : null,
        ch: scroll ? scroll.clientHeight : null,
        rows: column ? column.children.length : null,
        /* 「正在取更早的」—— 列头那一格加载态(有就记,没有就 null)。 */
        older: scroll ? Boolean(scroll.querySelector('[data-older-loading], [data-testid="chat-older-loading"]')) : null,
        streaming: Boolean(pane.querySelector('[data-testid="chat-stop"]')),
      })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopDomSampler(page) {
  return page.evaluate(() => {
    window.__cfStop = true
    window.__cfMo?.disconnect()
    const frames = window.__cfFrames ?? []
    const muts = window.__cfMuts ?? []
    window.__cfFrames = []
    window.__cfMuts = []
    return { frames, muts }
  })
}

/* ══ 像素层:screencast 抽帧 ═══════════════════════════════════════════════ */

function startScreencast(cdp, bag) {
  cdp.on('Page.screencastFrame', (ev) => {
    /* **先 ack 再存**:ack 慢一拍,下一帧就不来了(帧率被探针自己压住)。 */
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => undefined)
    if (bag.frames.length >= MAX_PIX_FRAMES) return
    bag.frames.push({ ts: ev.metadata?.timestamp ?? null, b64: ev.data })
  })
  return cdp.send('Page.startScreencast', {
    format: 'png', everyNthFrame: 1, maxWidth: PIX_W, maxHeight: Math.round(PIX_W * VIEWPORT.height / VIEWPORT.width),
  })
}

/**
 * 一块地的读数。`img` 是 decodePng 的结果,`r` 是 CSS px 矩形,`k` 是 `{x, y}` 两轴
 * 缩放 —— **两轴分开量**:screencast 抽的是**这扇窗真实的合成面**按 `maxWidth/
 * maxHeight` 等比缩下来的图,而窗口的实际大小与 `setDeviceMetricsOverride` 给的
 * 那一格并不一定相等(第一趟真机实测 1280 的视口抽出来 1190 宽)。一轴一个数,
 * 两个数对不上时报告里看得见。
 */
function regionStats(img, r, k) {
  const x0 = Math.max(0, Math.round(r.x * k.x))
  const y0 = Math.max(0, Math.round(r.y * k.y))
  const x1 = Math.min(img.width, Math.round((r.x + r.w) * k.x))
  const y1 = Math.min(img.height, Math.round((r.y + r.h) * k.y))
  if (x1 - x0 < 2 || y1 - y0 < 2) return null
  const { data, bpp, width } = img
  let sum = 0
  let grad = 0
  let n = 0
  for (let y = y0; y < y1; y += 1) {
    let prev = -1
    for (let x = x0; x < x1; x += 1) {
      const at = (y * width + x) * bpp
      const lum = (data[at] * 299 + data[at + 1] * 587 + data[at + 2] * 114) / 1000
      sum += lum
      if (prev >= 0) grad += Math.abs(lum - prev)
      prev = lum
      n += 1
    }
  }
  return { mean: sum / n, grad: grad / n, x0, y0, x1, y1, n }
}

/** 两张图在同一块地上的平均绝对差(亮度口径)。 */
function regionDiff(a, b, box) {
  if (!box) return null
  const { x0, y0, x1, y1 } = box
  let sum = 0
  let n = 0
  let peak = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const ia = (y * a.width + x) * a.bpp
      const ib = (y * b.width + x) * b.bpp
      const la = (a.data[ia] * 299 + a.data[ia + 1] * 587 + a.data[ia + 2] * 114) / 1000
      const lb = (b.data[ib] * 299 + b.data[ib + 1] * 587 + b.data[ib + 2] * 114) / 1000
      const d = Math.abs(la - lb)
      sum += d
      if (d > peak) peak = d
      n += 1
    }
  }
  return { mean: sum / n, peak }
}

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const round = (v, k = 2) => (v === null || v === undefined ? null : Number(v.toFixed(k)))

/* ══ 事后那一遍算 ══════════════════════════════════════════════════════════ */

function analyzeDom(frames, muts) {
  if (frames.length < 3) return { empty: true, frames: frames.length }
  const hits = []
  const base = frames.find((f) => f.panelThere && f.cs) ?? frames[0]
  const styleKeys = ['display', 'visibility', 'opacity', 'cv', 'transform', 'bf', 'bg']
  let composerHChanges = 0
  let lastH = frames[0].composerH
  let remounts = 0
  let lastLife = frames[0].panelLife
  let fileRemounts = 0
  let lastFile = frames[0].fileLife
  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i]
    if (f.fileLife !== lastFile) { fileRemounts += 1; lastFile = f.fileLife }
    if (f.composerH !== lastH) { composerHChanges += 1; lastH = f.composerH }
    if (f.panelLife !== lastLife) {
      remounts += 1
      hits.push({ t: f.t, why: `面板换了节点(life ${lastLife} → ${f.panelLife})`, st: f.st, rows: f.rows })
      lastLife = f.panelLife
    }
    if (!f.dockThere) { hits.push({ t: f.t, why: 'dock 不在树上', st: f.st, rows: f.rows }); continue }
    if (f.dockConn === false || f.panelConn === false) {
      hits.push({ t: f.t, why: 'dock/面板 isConnected=false', st: f.st, rows: f.rows })
      continue
    }
    if (!f.panelThere) { hits.push({ t: f.t, why: '面板不在树上', st: f.st, rows: f.rows }); continue }
    if (f.cs && base.cs) {
      for (const k of styleKeys) {
        if (f.cs[k] !== base.cs[k]) {
          hits.push({ t: f.t, why: `computed ${k}:${base.cs[k]} → ${f.cs[k]}`, st: f.st, rows: f.rows })
        }
      }
    }
    if (f.panelRect && (f.panelRect.h < 8 || f.panelRect.w < 8)) {
      hits.push({ t: f.t, why: `面板矩形塌了 ${f.panelRect.w}×${f.panelRect.h}`, st: f.st, rows: f.rows })
    }
  }
  /* 面板在视口里的落点漂了多少(dock 贴底,正常情况下不该动)。 */
  const tops = frames.filter((f) => f.panelRect).map((f) => f.panelRect.y)
  const drift = tops.length > 1
    ? Number((Math.max(...tops) - Math.min(...tops)).toFixed(2)) : 0
  const gaps = []
  for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i].t - frames[i - 1].t)
  const mutKinds = {}
  for (const m of muts) {
    const key = `${m.type}${m.attr ? `:${m.attr}` : ''}@${m.testid ?? m.tag}`
    mutKinds[key] = (mutKinds[key] ?? 0) + 1
  }
  return {
    frames: frames.length,
    fps: Math.round(1000 / (median(gaps) || 16)),
    spanMs: Math.round(frames[frames.length - 1].t - frames[0].t),
    hits,
    remounts,
    fileRemounts,
    composerHChanges,
    panelTopDriftPx: drift,
    scrolled: Math.round(Math.max(...frames.map((f) => f.st ?? 0)) - Math.min(...frames.map((f) => f.st ?? 0))),
    muts: muts.length,
    mutKinds: Object.fromEntries(Object.entries(mutKinds).sort((a, b) => b[1] - a[1]).slice(0, 8)),
    longFrames: gaps.filter((g) => g >= 50).length,
    longestFrameMs: gaps.length ? Math.round(Math.max(...gaps)) : 0,
  }
}

/**
 * 像素层。`boxes` 是 CSS px 的三块地(送、面板、上方控制带),`k` 是缩放。
 *
 * 判据:
 *  · **发送键芯**的帧间差 / 与本段中位帧的差 —— 它不透明,底下滚什么都不该变。
 *    `SEND_HIT` 是门槛(0–255 亮度口径)。
 *  · **面板梯度**比本段中位数高出 `GRAD_HIT` 倍 = 玻璃那一层糊没了。
 */
/**
 * 发送键芯那一格的门槛(0–255 亮度口径)。真机余量:快滚整段帧间差最大 0.72、
 * 人为藏两帧是 77.11 —— 两者差一百倍,6 落在中间哪儿都行。
 * `ONETHING_PROBE_SEND_HIT` 只为**反证**存在(把它调到噪声以下,这道断言当场
 * 该红 —— 「每条守卫断言至少真跑一次『拆掉即红』」)。
 */
const SEND_HIT = Number(process.env.ONETHING_PROBE_SEND_HIT ?? 6)
const GRAD_HIT = Number(process.env.ONETHING_PROBE_GRAD_HIT ?? 1.8)
/**
 * **比的是「邻居」不是「整段」**(第一趟真机打回来的:`big-stream-long` 报了 89 个
 * 假命中,全是**发送键变成停止键**那一下 —— 一段里那枚钮本来就有两个稳定值,拿
 * 整段的中位数当基准,占少数的那个值整段都在「偏离」)。
 *
 * 闪烁的定义本来就是**短暂**:它偏离的是**此刻前后那一小段**,不是整段。所以基准
 * 取**滑动中位数**(前后各这么多帧,把自己剔掉)—— 状态换挡时邻居跟着换,不报;
 * 一两帧的跳邻居不动,报。窗口半径取 12 帧(≈80fps 下 150ms):比任何一次闪烁都长,
 * 比任何一次换挡都短。
 */
const LOCAL_R = 12
function localMedians(values, r) {
  const out = new Array(values.length).fill(null)
  for (let i = 0; i < values.length; i += 1) {
    const win = []
    for (let j = Math.max(0, i - r); j <= Math.min(values.length - 1, i + r); j += 1) {
      if (j !== i && values[j] !== null && values[j] !== undefined) win.push(values[j])
    }
    if (win.length >= 4) out[i] = median(win)
  }
  return out
}

function analyzePix(images, boxes, k, outDir, tag) {
  if (images.length < 3) return { empty: true, frames: images.length }
  const sendBox = regionStats(images[0], boxes.send, k)
  const panelBox = regionStats(images[0], boxes.panel, k)
  const aboveBox = regionStats(images[0], boxes.above, k)
  if (!sendBox || !panelBox) return { empty: true, why: '地太小,量不了', frames: images.length }
  /* 发送键芯:往里缩 2 个图像素,躲开抗锯齿边。 */
  const core = {
    x0: sendBox.x0 + 2, y0: sendBox.y0 + 2,
    x1: Math.max(sendBox.x0 + 3, sendBox.x1 - 2), y1: Math.max(sendBox.y0 + 3, sendBox.y1 - 2),
  }
  const rows = []
  for (let i = 0; i < images.length; i += 1) {
    const img = images[i]
    const s = regionStats(img, boxes.send, k)
    const p = regionStats(img, boxes.panel, k)
    const a = aboveBox ? regionStats(img, boxes.above, k) : null
    rows.push({
      i,
      sendMean: s ? s.mean : null,
      panelMean: p ? p.mean : null,
      panelGrad: p ? p.grad : null,
      aboveMean: a ? a.mean : null,
      sendStep: i > 0 ? regionDiff(images[i - 1], img, core) : null,
      panelStep: i > 0 ? regionDiff(images[i - 1], img, panelBox) : null,
      aboveStep: i > 0 && aboveBox ? regionDiff(images[i - 1], img, aboveBox) : null,
    })
  }
  const sendMedian = median(rows.map((r) => r.sendMean).filter((v) => v !== null))
  const gradMedian = median(rows.map((r) => r.panelGrad).filter((v) => v !== null))
  const sendLocal = localMedians(rows.map((r) => r.sendMean), LOCAL_R)
  const gradLocal = localMedians(rows.map((r) => r.panelGrad), LOCAL_R)
  /**
   * **换挡还是闪一下** —— 一个读数偏离了邻居,有两种可能,而只有后一种是报障说的事:
   *  · `step`(**换挡**):它偏到的那个值**留下来了**(发送键变成停止键、抽屉开了、
   *    输入框里多了字)。往后数 10 帧,有 ≥7 帧还在新值上 = 换挡。
   *  · `spike`(**闪**):一两帧之后又弹回去了 —— 这才是「消失又出现」。
   * 报告里两类分开打,**只有 spike 计进「闪烁」那一格**。
   */
  const classify = (series, i, value) => {
    /*
     * **两头都要问**(第一趟只问了后面,于是每一次换挡都白送两个假「闪」):
     * 换挡那一刻**前后各有一个稳定的台面**,偏离邻居中位的那一帧可能站在**新台面**
     * 的头上(往后一直是它)也可能站在**旧台面**的尾巴上(往前一直是它)——
     * 两种都是换挡。真的闪是**两头都不认它**:前 10 帧不是这个值,后 10 帧也不是。
     */
    const side = (from, to) => {
      const xs = []
      for (let j = from; j !== to; j += Math.sign(to - from)) {
        if (j < 0 || j >= series.length) break
        if (series[j] !== null && series[j] !== undefined) xs.push(series[j])
      }
      if (xs.length < 5) return null
      const near = xs.filter((v) => Math.abs(v - value) <= SEND_HIT / 2).length
      return near >= Math.ceil(xs.length * 0.7)
    }
    const after = side(i + 1, i + 11)
    const before = side(i - 1, i - 11)
    if (after === true || before === true) return 'step'
    /*
     * **一头没有样本就答不出「闪」**(第二趟改的):抽帧到 `MAX_PIX_FRAMES` 就截断,
     * 而 `big-stream-long` 收场恰好落在第 698/699 帧 —— 后面没有帧了,于是
     * 「换挡的头一帧」与「闪了一帧」在这段录像里**根本区分不开**。区分不开就
     * 别硬判:答 `edge`,报告里单列一格,不混进「闪」那个数。
     */
    if (after === null || before === null) return 'edge'
    return 'spike'
  }
  const sendSeries = rows.map((r) => r.sendMean)
  const gradSeries = rows.map((r) => r.panelGrad)
  const hits = []
  for (const r of rows) {
    const reasons = []
    let kind = 'spike'
    const sl = sendLocal[r.i]
    const gl = gradLocal[r.i]
    if (r.sendMean !== null && sl !== null && Math.abs(r.sendMean - sl) > SEND_HIT) {
      kind = classify(sendSeries, r.i, r.sendMean)
      reasons.push(`发送键芯亮度 ${round(r.sendMean)} vs 邻居中位 ${round(sl)}`)
    }
    if (r.panelGrad !== null && gl && r.panelGrad > gl * GRAD_HIT) {
      const gk = classify(gradSeries, r.i, r.panelGrad)
      if (!reasons.length) kind = gk
      reasons.push(`面板梯度 ${round(r.panelGrad)} vs 邻居中位 ${round(gl)}(玻璃糊没了?)`)
    }
    if (reasons.length) hits.push({ i: r.i, kind, reasons, row: r })
  }
  const spikes = hits.filter((h) => h.kind === 'spike')
  /*
   * **参考帧永远落一张**(不只出事时):量地对不对、发送键芯是不是真踩在那枚圆钮上,
   * 只有对着一张图才说得清。红了之后回头看这张,能当场分出「产品闪了」与「探针量错了地」。
   */
  mkdirSync(outDir, { recursive: true })
  const refAt = path.join(outDir, `${tag}-ref.png`)
  writeFileSync(refAt, images[Math.floor(images.length / 2)].raw)

  /* 出事帧连同前后各一帧落盘。 */
  const saved = []
  if (hits.length) {
    const want = new Set()
    /* spike 优先存:它才是报障说的那件事。 */
    for (const h of [...spikes, ...hits].slice(0, 12)) { want.add(h.i - 1); want.add(h.i); want.add(h.i + 1) }
    for (const i of [...want].filter((v) => v >= 0 && v < images.length).sort((a, b) => a - b)) {
      const file = path.join(outDir, `${tag}-f${String(i).padStart(4, '0')}${hits.some((h) => h.i === i) ? '-HIT' : ''}.png`)
      writeFileSync(file, images[i].raw)
      saved.push(file)
    }
  }
  const stepOf = (key) => rows.map((r) => r[key]?.mean).filter((v) => v !== undefined && v !== null)
  /** 参考帧里发送键芯那一小块的平均 RGB —— 用来对账「量的真是那枚 accent 圆钮」。 */
  const mid = images[Math.floor(images.length / 2)]
  let rr = 0; let gg = 0; let bb = 0; let cn = 0
  for (let y = core.y0; y < core.y1; y += 1) {
    for (let x = core.x0; x < core.x1; x += 1) {
      const at = (y * mid.width + x) * mid.bpp
      rr += mid.data[at]; gg += mid.data[at + 1]; bb += mid.data[at + 2]; cn += 1
    }
  }
  return {
    refAt,
    imgSize: `${images[0].width}×${images[0].height}`,
    sendCoreRgb: cn ? `${Math.round(rr / cn)},${Math.round(gg / cn)},${Math.round(bb / cn)}` : null,
    sendCorePx: `${core.x1 - core.x0}×${core.y1 - core.y0}`,
    frames: images.length,
    sendMedian: round(sendMedian),
    gradMedian: round(gradMedian, 3),
    sendStepMax: round(Math.max(0, ...stepOf('sendStep'))),
    sendStepMedian: round(median(stepOf('sendStep'))),
    panelStepMax: round(Math.max(0, ...stepOf('panelStep'))),
    panelStepMedian: round(median(stepOf('panelStep'))),
    aboveStepMedian: round(median(stepOf('aboveStep'))),
    gradMax: round(Math.max(0, ...rows.map((r) => r.panelGrad ?? 0)), 3),
    hits: hits.map((h) => ({ i: h.i, kind: h.kind, reasons: h.reasons })),
    spikes: spikes.length,
    steps: hits.filter((h) => h.kind === 'step').length,
    edges: hits.filter((h) => h.kind === 'edge').length,
    saved,
  }
}

/* ══ 主 ════════════════════════════════════════════════════════════════════ */

async function main() {
  if (!existsSync(serverEntry)) { console.error('[flicker] 先在仓根跑 `bun run server:build`'); process.exit(1) }
  if (!existsSync(mainEntry)) { console.error('[flicker] 先跑 `npm run electron:build`'); process.exit(1) }
  if (PROD && !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[flicker] --prod 档先跑 `npm run app:build`'); process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'flick-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'flick-udd-'))
  const providerState = {}
  let provider; let server; let app; let vite
  const readings = { lane: LANE, viewport: VIEWPORT, pixW: PIX_W, outDir: OUT_DIR, scenarios: {} }

  const startCore = async () => {
    const child = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ...FAKE_PROVIDER_ENV, ONETHING_STORE_PATH: store },
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const err = []
    child.stderr.on('data', (c) => err.push(c.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === child.pid ? found : undefined
    }).catch((e) => { throw new Error(`${e.message}\nserver stderr:\n${err.join('').slice(-2000)}`) })
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
    console.log(`\n[flicker] 渲染层档位:${LANE} · 抽帧图宽 ${PIX_W} · 出事帧存到 ${OUT_DIR}`)
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
        enableToolCalls: true, permissionMode: 'dangerously-allow-all',
        bash: { enableSandbox: false, confirmDangerousCommands: false },
      },
      diagnostics: { enabled: false },
    }, null, 2))

    let core = await startCore()
    server = core.child
    const shortId = (await rpc(core.record, 'sessions', 'create', { name: '闪烁探针 · 短会话' }))?.session?.id
    const bigId = (await rpc(core.record, 'sessions', 'create', { name: '闪烁探针 · 超量' }))?.session?.id
    if (!shortId || !bigId) throw new Error('会话没建出来')

    console.log('[2/5] 停 core,给超量那一条直写账本,再起回来')
    await stopCore(server)
    const seeded = seedLargeLedger(store, bigId, {})
    console.log(`      超量夹具 ${(seeded.bytes / 1024 / 1024).toFixed(1)}MB / ${seeded.messages} 条`)
    core = await startCore()
    server = core.child

    let rendererUrl
    if (PROD) console.log('[3/5] prod 档:吃 dist/ 产物,不起 vite')
    else {
      console.log(`[3/5] 起 vite dev(端口 ${DEV_PORT},不是 5175)`)
      const { createServer } = await import('vite')
      vite = await createServer({
        configFile: path.join(appRoot, 'vite.config.ts'),
        server: { port: DEV_PORT, strictPort: true }, logLevel: 'warn',
      })
      await vite.listen()
      rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`
    }

    console.log('[4/5] 拉起应用(屏外档 · 独立 user-data-dir)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env, ONETHING_STORE_PATH: store,
        ...(rendererUrl ? { ONETHING_REACT_DEV_SERVER_URL: rendererUrl } : {}),
        ONETHING_GATE_OFFSCREEN: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    /*
     * ── **窗口本身要改成这个尺寸,不能只 `setDeviceMetricsOverride`**(第一趟真机
     *    踩出来的)─────────────────────────────────────────────────────────────
     * `gate-stream-geometry` 只量 DOM 矩形,所以它只 override 就够;这一支还要**看
     * 像素**,而 `Page.startScreencast` 抽的是**这扇窗真实的合成面**,不是那份被
     * override 出来的视口。实测:窗口 1191×800、视口 override 成 1280×800,抽出来
     * 的图是 1191×800 —— 横轴 0.93、纵轴 1.0,**两轴不等**,于是按 CSS 矩形换算出
     * 的「发送键芯」落在旁边的正文上,量到的全是正文在滚(第一趟 105 个假命中)。
     * 治法是让**窗口 = 视口**:主进程 `setContentSize`,两轴缩放自然相等,
     * 下面那句自检还会把它们打出来对账。
     */
    const winSize = async (w, h) => {
      const handle = await app.browserWindow(page)
      await handle.evaluate((win, size) => { win.setContentSize(size.w, size.h) }, { w, h })
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 0, mobile: false,
      })
      await delay(400)
    }
    await winSize(VIEWPORT.width, VIEWPORT.height)
    await page.addInitScript(LEAF_PROBE)
    await page.evaluate(LEAF_PROBE)
    await installComposerDockProbe(page)
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const v = await page.evaluate(() => window.__d0 ?? null)
      return v && v.rpcOk ? v : undefined
    })
    const dpr = await page.evaluate(() => ({
      dpr: window.devicePixelRatio, w: window.innerWidth, h: window.innerHeight,
    }))
    readings.dpr = dpr
    console.log(`      真实 dpr=${dpr.dpr} · 视口 ${dpr.w}×${dpr.h}`)

    const clickTestId = async (id) => {
      const ok = await page.evaluate((x) => {
        const el = document.querySelector(`[data-testid="${x}"]`)
        if (!el) return false
        el.click()
        return true
      }, id)
      if (!ok) throw new Error(`点不到 [data-testid="${id}"]`)
    }
    const openSession = async (sessionId, expect) => {
      const rowShown = () => page.evaluate((id) =>
        Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId)
      for (let n = 0; n < 3 && !(await rowShown()); n += 1) {
        await clickTestId('dock-tile-sessions').catch(() => undefined)
        await delay(600)
      }
      await waitFor('总览画出那一行', rowShown)
      await clickTestId(`session-row-${sessionId}`)
      await waitFor('聊天区就位', () => page.evaluate(() =>
        Boolean(window.__fLeaf().querySelector('[data-testid="chat-stream"]'))))
      if (expect > 0) {
        await waitFor('账本起完底', async () => {
          const n = await page.evaluate(() => window.__fLeaf()
            .querySelectorAll('[data-testid="chat-stream"] [data-message-id]').length)
          return n >= Math.min(expect, 8) ? n : undefined
        }, 180_000)
        console.log(`      起底 ${waitFor.lastMs}ms`)
      }
      /*
       * **把总览那架子收掉** —— 它开着时聊天列被挤窄,量的就不是人平时那个宽度。
       * 判据不拿「点了几下」,拿**结果**:哪一下之后聊天容器更宽就留哪一下
       * (壳 CLAUDE.md「收起 ≠ 关闭」那条判例的同一条纪律:形态要按事实读,不按动作数)。
       */
      const chatW = () => page.evaluate(() => {
        const s = window.__fLeaf().querySelector('[data-testid="chat-stream"]')
        return s ? Math.round(s.getBoundingClientRect().width) : 0
      })
      const before = await chatW()
      await clickTestId('dock-tile-sessions').catch(() => undefined)
      await delay(700)
      const after = await chatW()
      if (after < before) {
        await clickTestId('dock-tile-sessions').catch(() => undefined)
        await delay(700)
      }
      console.log(`      聊天列宽:${before} → ${Math.max(before, after)}px`)
      /* 等这条列把历史补完(判词同 gate-stream-geometry 的 settleBackfill)。 */
      const rowsNow = () => page.evaluate(() => {
        const s = window.__fLeaf().querySelector('[data-testid="chat-stream"]')
        return s?.firstElementChild?.children.length ?? 0
      })
      const t0 = Date.now()
      let last = await rowsNow()
      let stable = 0
      while (Date.now() - t0 < 120_000 && stable < 5) {
        await delay(300)
        const now = await rowsNow()
        stable = now === last ? stable + 1 : 0
        last = now
      }
      console.log(`      补历史补完:${last} 格(等了 ${Date.now() - t0}ms)`)
    }
    const scrollToBottom = async () => {
      await page.evaluate(() => {
        const s = window.__fLeaf().querySelector('[data-testid="chat-stream"]')
        if (s) s.scrollTop = s.scrollHeight
      })
      await delay(400)
    }
    /** 量地:三块 CSS px 矩形(送 / 面板 / 面板上方一条控制带)。 */
    const measureBoxes = () => page.evaluate(() => {
      const dock = window.__composerDock()
      const panel = dock?.querySelector('[data-testid="composer-panel"]')
      const send = dock?.querySelector('[data-testid="composer-send"]')
      const r = (el) => {
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { x: b.left, y: b.top, w: b.width, h: b.height }
      }
      const p = r(panel)
      return {
        panel: p, send: r(send),
        above: p ? { x: p.x, y: Math.max(0, p.y - 140), w: p.w, h: 120 } : null,
      }
    })
    /** CDP 滚轮:只进这扇窗,不动真光标。`at` 是 CSS px 坐标。 */
    const wheel = async (x, y, dy) => {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 0,
        pointerType: 'mouse', button: 'none', clickCount: 0,
      })
    }
    const sendViaComposer = async (text) => {
      const ok = await page.evaluate((value) => {
        const box = window.__fLeaf().querySelector('[data-testid="composer-input"]')
        if (!box) return false
        box.textContent = value
        box.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }, text)
      if (!ok) throw new Error('打不进去:没有 composer-input')
      await delay(200)
      const sent = await page.evaluate(() => {
        const s = window.__fLeaf().querySelector('[data-testid="composer-send"]')
        if (!(s instanceof HTMLElement) || s.hasAttribute('disabled')) return false
        s.click()
        return true
      })
      if (!sent) throw new Error('发送键点不动')
    }
    const stopShown = () => page.evaluate(() =>
      Boolean(window.__fLeaf().querySelector('[data-testid="chat-stop"]')))

    /**
     * 跑一段:开两层 → `body()` 做事 → 收两层 → 算。
     * `body` 收到 `{ page, wheel, cx, cy }`。
     */
    const burst = async (tag, body, { noPix = false } = {}) => {
      const boxes = await measureBoxes()
      if (!boxes.panel) throw new Error(`${tag}:量不到面板`)
      const bag = { frames: [] }
      await startDomSampler(page)
      if (!noPix) await startScreencast(cdp, bag)
      const geom = await page.evaluate(() => {
        const s = window.__fLeaf().querySelector('[data-testid="chat-stream"]')
        const b = s.getBoundingClientRect()
        return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 }
      })
      await body({ ...geom })
      if (!noPix) await cdp.send('Page.stopScreencast').catch(() => undefined)
      await delay(120)
      const { frames, muts } = await stopDomSampler(page)
      const dom = analyzeDom(frames, muts)
      const images = []
      for (const f of bag.frames) {
        const raw = Buffer.from(f.b64, 'base64')
        try {
          const img = decodePng(raw)
          img.raw = raw
          images.push(img)
        } catch { /* 解不开的那一张跳过,数目会在 frames 里体现 */ }
      }
      const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
      const k = images.length
        ? { x: images[0].width / vp.w, y: images[0].height / vp.h }
        : { x: 1, y: 1 }
      /* **两轴缩放不等 = 窗口与视口没对齐**,量的地会整片偏掉 —— 喊出来,别闷着量。 */
      if (Math.abs(k.x - k.y) > 0.01) {
        console.log(`        ⚠︎ ${tag}:两轴缩放不等(${round(k.x, 3)} vs ${round(k.y, 3)})`
          + ` —— 窗口 ${images[0]?.width}×${images[0]?.height} 视口 ${vp.w}×${vp.h},像素层这一段不可信`)
      }
      const pix = analyzePix(images, boxes, k, OUT_DIR, tag)
      pix.scale = `${round(k.x, 3)}×${round(k.y, 3)}`
      pix.axisMismatch = Math.abs(k.x - k.y) > 0.01
      pix.captured = bag.frames.length
      pix.decoded = images.length
      const out = { boxes, dom, pix }
      report(tag, out)
      return out
    }

    console.log('\n[5/5] 场景')

    /* ── 超量那一档:先起底、热身一轮,再开量 ───────────────────────────── */
    const SCEN = []
    const want = (id) => !ONLY || ONLY.includes(id)
    /** 名单里一个 `big-` 都没有时,整条超量泳道(起底 + 热身,分钟级)一起跳过。 */
    const bigLane = !ONLY || ONLY.some((id) => id.startsWith('big-'))

    if (bigLane) {
      await openSession(bigId, seeded.messages)
      await scrollToBottom()
      console.log('  · 超量 / 热身一轮(不量)')
      await sendViaComposer(`闪烁探针 热身 ${markFor(MARKS.warm, 'big')}`)
      await waitFor('热身开张', stopShown, 180_000)
      await waitFor('热身收场', async () => !(await stopShown()), 300_000)
      await delay(1200)
    }

    /*
     * ── **灵敏度自证**(反证纪律:「每条守卫断言至少真跑一次『拆掉即红』」)────────
     * 一条恒绿的探针不是探针。这一档在滚动中途**人为**把面板藏掉一两帧
     * (`visibility: hidden` 一帧、`opacity: 0` 一帧、整块摘下来一帧),两层都必须
     * 当场报出来 —— 报不出来的话,后面那些「零命中」说明的是探针瞎了,不是产品好了。
     * 它只在 `--selftest` 下跑,不进常规矩阵。
     */
    if (process.argv.includes('--selftest')) {
      console.log('  · 自证 / 人为藏一两帧(两层都该红)')
      await scrollToBottom()
      const st = await burst('selftest', async ({ cx, cy }) => {
        for (let i = 0; i < 60; i += 1) {
          await wheel(cx, cy, i % 2 ? 700 : -700)
          if (i === 12 || i === 30 || i === 45) {
            await page.evaluate((mode) => {
              const p = window.__composerDock()?.querySelector('[data-testid="composer-panel"]')
              if (!(p instanceof HTMLElement)) return
              const prop = mode === 0 ? 'visibility' : 'opacity'
              p.style.setProperty(prop, mode === 0 ? 'hidden' : '0')
              /* 藏**两帧**再放回来:一帧在 120Hz 上会被 ~87fps 的抽帧漏掉,
               * 而这一档要证的是探针认不认得出,不是抽帧够不够快。 */
              requestAnimationFrame(() => requestAnimationFrame(() => {
                p.style.removeProperty(prop)
              }))
            }, i === 12 ? 0 : 1)
          }
          await delay(24)
        }
      })
      const domOk = (st.dom.hits?.length ?? 0) > 0
      const pixOk = (st.pix.hits?.length ?? 0) > 0
      console.log(`      自证结果:DOM 层 ${domOk ? '红了 ✓' : '**没红 ✗(探针瞎了)**'}`
        + ` · 像素层 ${pixOk ? '红了 ✓' : '**没红 ✗(探针瞎了)**'}`)
      readings.selftest = { domHits: st.dom.hits?.length ?? 0, pixHits: st.pix.hits?.length ?? 0 }
      SCEN.push(['selftest', st])
    }

    if (want('big-wheel-slow')) {
      console.log('  · 超量 / 手动慢滚')
      await scrollToBottom()
      SCEN.push(['big-wheel-slow', await burst('big-wheel-slow', async ({ cx, cy }) => {
        for (let i = 0; i < 45; i += 1) { await wheel(cx, cy, -120); await delay(45) }
        for (let i = 0; i < 45; i += 1) { await wheel(cx, cy, 120); await delay(45) }
      })])
    }
    if (want('big-wheel-fast')) {
      console.log('  · 超量 / 手动快滚')
      await scrollToBottom()
      SCEN.push(['big-wheel-fast', await burst('big-wheel-fast', async ({ cx, cy }) => {
        for (let i = 0; i < 70; i += 1) { await wheel(cx, cy, -900); await delay(16) }
        for (let i = 0; i < 70; i += 1) { await wheel(cx, cy, 900); await delay(16) }
      })])
    }
    if (want('big-wheel-pingpong')) {
      console.log('  · 超量 / 来回滚')
      await scrollToBottom()
      SCEN.push(['big-wheel-pingpong', await burst('big-wheel-pingpong', async ({ cx, cy }) => {
        for (let i = 0; i < 100; i += 1) { await wheel(cx, cy, i % 2 ? 700 : -700); await delay(24) }
      })])
    }
    if (want('big-wheel-overglass')) {
      /* **滚轮落在玻璃上**:指针压在输入框那块地上往下滚(事件穿不穿得过去是另一件事,
       * 这一档要看的是「合成层就在指针底下」时有没有别的表现)。 */
      console.log('  · 超量 / 指针压在玻璃上滚')
      await scrollToBottom()
      const bx = await measureBoxes()
      SCEN.push(['big-wheel-overglass', await burst('big-wheel-overglass', async () => {
        const x = bx.panel.x + bx.panel.w / 2
        const y = bx.panel.y + Math.min(8, bx.panel.h / 2)
        for (let i = 0; i < 80; i += 1) { await wheel(x, y, i % 2 ? 600 : -600); await delay(24) }
      })])
    }
    if (want('big-wheel-top')) {
      console.log('  · 超量 / 一路滚到顶(逼「取更早的」)')
      SCEN.push(['big-wheel-top', await burst('big-wheel-top', async ({ cx, cy }) => {
        for (let i = 0; i < 180; i += 1) { await wheel(cx, cy, -1600); await delay(14) }
      })])
    }
    if (want('big-stream-long')) {
      console.log('  · 超量 / 流式跟随(长回复)')
      await scrollToBottom()
      SCEN.push(['big-stream-long', await burst('big-stream-long', async () => {
        await sendViaComposer(`闪烁探针 长回复 ${markFor(MARKS.long, 'big')}`)
        await waitFor('开张', stopShown, 180_000)
        const t0 = Date.now()
        while (Date.now() - t0 < 9000 && (await stopShown())) await delay(200)
      })])
      await waitFor('收场', async () => !(await stopShown()), 300_000)
      await delay(800)
    }
    if (want('big-stream-scrollup')) {
      console.log('  · 超量 / 流式中手动上翻再回底')
      await scrollToBottom()
      SCEN.push(['big-stream-scrollup', await burst('big-stream-scrollup', async ({ cx, cy }) => {
        await sendViaComposer(`闪烁探针 长回复 ${markFor(MARKS.long, 'big')}`)
        await waitFor('开张', stopShown, 180_000)
        await delay(1200)
        for (let i = 0; i < 40; i += 1) { await wheel(cx, cy, -700); await delay(20) }
        await delay(400)
        for (let i = 0; i < 60; i += 1) { await wheel(cx, cy, 900); await delay(20) }
        const t0 = Date.now()
        while (Date.now() - t0 < 3000 && (await stopShown())) await delay(200)
      })])
      await waitFor('收场', async () => !(await stopShown()), 300_000)
      await delay(800)
    }
    if (want('big-stream-think')) {
      console.log('  · 超量 / 流式跟随(6 万字思考)')
      await scrollToBottom()
      SCEN.push(['big-stream-think', await burst('big-stream-think', async () => {
        await sendViaComposer(`闪烁探针 长思考 ${markFor(MARKS.think60k, 'big')}`)
        await waitFor('开张', stopShown, 180_000)
        const t0 = Date.now()
        while (Date.now() - t0 < 9000 && (await stopShown())) await delay(200)
      })])
      await waitFor('收场', async () => !(await stopShown()), 300_000)
      await delay(800)
    }
    if (want('big-stream-tools')) {
      console.log('  · 超量 / 流式跟随(工具卡)')
      await scrollToBottom()
      SCEN.push(['big-stream-tools', await burst('big-stream-tools', async () => {
        await sendViaComposer(`闪烁探针 工具 ${markFor(MARKS.tools, 'big')}`)
        await waitFor('开张', stopShown, 180_000)
        const t0 = Date.now()
        while (Date.now() - t0 < 10_000 && (await stopShown())) await delay(200)
      })])
      await waitFor('收场', async () => !(await stopShown()), 300_000)
      await delay(800)
    }
    if (want('big-narrow')) {
      /* `@container composerDrawer (max-width: 448px)` 那条阈值附近。 */
      console.log('  · 超量 / 窄窗(容器阈值 448 附近)+ 快滚')
      await winSize(520, 800)
      await delay(800)
      await scrollToBottom()
      SCEN.push(['big-narrow', await burst('big-narrow', async () => {
        const b = await measureBoxes()
        const x = b.panel.x + b.panel.w / 2
        for (let i = 0; i < 80; i += 1) { await wheel(x, 300, i % 2 ? 800 : -800); await delay(20) }
      })])
      await winSize(VIEWPORT.width, VIEWPORT.height)
      await delay(600)
    }
    if (want('big-type-scroll')) {
      /*
       * **一边打字一边滚** —— 这一档是冲着最像病根的那条链去的:输入框长高
       * → `useComposerGeometry` 的 RO 在**下一帧**把 `--composer-h` 写到 `.chatArea`
       * 上 → 滚动容器的 `padding-block-end` 跟着变 → **玻璃底下那块地当场重排**。
       * 前面那几档 `--composer-h` 一次都没变过,所以它们**压根没考到这条链**。
       */
      console.log('  · 超量 / 一边打字长高一边滚')
      await scrollToBottom()
      SCEN.push(['big-type-scroll', await burst('big-type-scroll', async ({ cx, cy }) => {
        for (let i = 0; i < 60; i += 1) {
          await page.evaluate((n) => {
            const box = window.__fLeaf().querySelector('[data-testid="composer-input"]')
            if (!box) return
            /* 行数在 1–6 之间来回,输入框跟着长高缩矮,`--composer-h` 每几帧变一次。 */
            const lines = 1 + (n % 6)
            box.textContent = Array.from({ length: lines },
              (_, k) => `第 ${k + 1} 行:一边打字一边滚,看玻璃会不会闪`).join('\n')
            box.dispatchEvent(new Event('input', { bubbles: true }))
          }, i)
          await wheel(cx, cy, i % 2 ? 700 : -700)
          await delay(28)
        }
        await page.evaluate(() => {
          const box = window.__fLeaf().querySelector('[data-testid="composer-input"]')
          if (box) { box.textContent = ''; box.dispatchEvent(new Event('input', { bubbles: true })) }
        })
      })])
      await delay(500)
    }
    if (want('big-drawer-scroll')) {
      /*
       * **抽屉开合是「整块换材质」**(`.panel:has(.drawerOpen)` 把 `backdrop-filter`
       * 撤成 `none`、底换实色)。开合落在滚动中途时,玻璃那一层是**真的被拆了又装**
       * —— 这一档要看的就是那一下在屏上是不是一次干净的换挡。
       */
      console.log('  · 超量 / 滚动中开合抽屉(玻璃↔实底)')
      await scrollToBottom()
      SCEN.push(['big-drawer-scroll', await burst('big-drawer-scroll', async ({ cx, cy }) => {
        for (let i = 0; i < 60; i += 1) {
          if (i % 12 === 0) {
            await page.evaluate((on) => {
              const box = window.__fLeaf().querySelector('[data-testid="composer-input"]')
              if (!box) return
              box.textContent = on ? '@' : ''
              box.dispatchEvent(new Event('input', { bubbles: true }))
            }, (i / 12) % 2 === 0)
          }
          await wheel(cx, cy, i % 2 ? 700 : -700)
          await delay(28)
        }
        await page.evaluate(() => {
          const box = window.__fLeaf().querySelector('[data-testid="composer-input"]')
          if (box) { box.textContent = ''; box.dispatchEvent(new Event('input', { bubbles: true })) }
        })
      })])
      await delay(500)
    }
    if (want('big-resize-scroll')) {
      console.log('  · 超量 / 滚动中改窗宽')
      await scrollToBottom()
      SCEN.push(['big-resize-scroll', await burst('big-resize-scroll', async ({ cx, cy }) => {
        for (let i = 0; i < 40; i += 1) {
          if (i % 8 === 0) {
            const handle = await app.browserWindow(page)
            await handle.evaluate((win, w) => { win.setContentSize(w, 800) },
              i % 16 === 0 ? 1000 : 1280)
          }
          await wheel(cx, cy, i % 2 ? 700 : -700)
          await delay(30)
        }
      })])
      await winSize(VIEWPORT.width, VIEWPORT.height)
      await delay(500)
    }

    if (want('big-endurance')) {
      /*
       * ── **耐力档:只开 DOM 层,跑满一分钟**(用户原话里那两个字是「**偶尔**」)──
       *
       * 稀有事件要靠**量**。像素层一帧要存一张 png(1280×800 约 400KB),存不下
       * 一分钟;DOM 层一帧只是一次 `getComputedStyle` + 几个矩形,120Hz 跑满一分钟
       * ≈7000 帧,而**「面板消失了」这件事 DOM 层是确定性地看得见的**——卸载、
       * 被藏、高度塌、换节点,四种形都在那张表里。所以这一档关掉像素层换时长。
       * 滚法故意杂:慢、快、来回、到顶、停一拍,不给它挑一种节奏适应。
       */
      console.log('  · 超量 / 耐力(一分钟杂滚,只开 DOM 层)')
      await scrollToBottom()
      SCEN.push(['big-endurance', await burst('big-endurance', async ({ cx, cy }) => {
        const until = Date.now() + 60_000
        let n = 0
        while (Date.now() < until) {
          const phase = Math.floor(n / 25) % 5
          if (phase === 0) { await wheel(cx, cy, -120); await delay(40) }
          else if (phase === 1) { await wheel(cx, cy, -1400); await delay(14) }
          else if (phase === 2) { await wheel(cx, cy, n % 2 ? 900 : -900); await delay(20) }
          else if (phase === 3) { await wheel(cx, cy, 1400); await delay(14) }
          else { await delay(60) }
          n += 1
        }
      }, { noPix: true })])
      await delay(500)
    }

    /* ── 短会话那一档 ───────────────────────────────────────────────────── */
    if (want('short-stream-long') || want('short-wheel-fast')) {
      await openSession(shortId, 0)
      console.log('  · 短会话 / 热身一轮(不量)')
      await sendViaComposer(`闪烁探针 热身 ${markFor(MARKS.warm, 'short')}`)
      await waitFor('热身开张', stopShown, 180_000)
      await waitFor('热身收场', async () => !(await stopShown()), 300_000)
      await delay(800)
      if (want('short-stream-long')) {
        console.log('  · 短会话 / 流式跟随(长回复)')
        SCEN.push(['short-stream-long', await burst('short-stream-long', async () => {
          await sendViaComposer(`闪烁探针 长回复 ${markFor(MARKS.long, 'short')}`)
          await waitFor('开张', stopShown, 180_000)
          const t0 = Date.now()
          while (Date.now() - t0 < 9000 && (await stopShown())) await delay(200)
        })])
        await waitFor('收场', async () => !(await stopShown()), 300_000)
        await delay(800)
      }
      if (want('short-wheel-fast')) {
        console.log('  · 短会话 / 快滚')
        await scrollToBottom()
        SCEN.push(['short-wheel-fast', await burst('short-wheel-fast', async ({ cx, cy }) => {
          for (let i = 0; i < 70; i += 1) { await wheel(cx, cy, i % 2 ? 900 : -900); await delay(18) }
        })])
      }
    }

    /* ── markdown 块混排那一档(09-23 追加)──────────────────────────────── */
    const mdIds = ['md-stream', 'md-wheel-slow', 'md-wheel-fast', 'md-pingpong', 'md-wheel-overglass']
    if (mdIds.some(want)) {
      const mdId = (await rpc(core.record, 'sessions', 'create', { name: '闪烁探针 · markdown' }))?.session?.id
      if (!mdId) throw new Error('markdown 会话没建出来')
      await openSession(mdId, 0)
      console.log('  · markdown / 流式跟随(块混排)')
      const streamMd = async () => {
        await sendViaComposer(`闪烁探针 块混排 ${markFor(MARKS.md, 'short')}`)
        await waitFor('开张', stopShown, 180_000)
        const t0 = Date.now()
        while (Date.now() - t0 < 14000 && (await stopShown())) await delay(200)
      }
      if (want('md-stream')) SCEN.push(['md-stream', await burst('md-stream', streamMd)])
      else await streamMd()
      await waitFor('收场', async () => !(await stopShown()), 300_000)
      await delay(1000)
      if (want('md-wheel-slow')) {
        console.log('  · markdown / 慢滚')
        await scrollToBottom()
        SCEN.push(['md-wheel-slow', await burst('md-wheel-slow', async ({ cx, cy }) => {
          for (let i = 0; i < 60; i += 1) { await wheel(cx, cy, -100); await delay(40) }
          for (let i = 0; i < 60; i += 1) { await wheel(cx, cy, 100); await delay(40) }
        })])
      }
      if (want('md-wheel-fast')) {
        console.log('  · markdown / 快滚')
        await scrollToBottom()
        SCEN.push(['md-wheel-fast', await burst('md-wheel-fast', async ({ cx, cy }) => {
          for (let i = 0; i < 60; i += 1) { await wheel(cx, cy, -700); await delay(16) }
          for (let i = 0; i < 60; i += 1) { await wheel(cx, cy, 700); await delay(16) }
        })])
      }
      if (want('md-pingpong')) {
        console.log('  · markdown / 来回滚')
        await scrollToBottom()
        SCEN.push(['md-pingpong', await burst('md-pingpong', async ({ cx, cy }) => {
          for (let i = 0; i < 100; i += 1) { await wheel(cx, cy, i % 2 ? 500 : -500); await delay(24) }
        })])
      }
      if (want('md-wheel-overglass')) {
        console.log('  · markdown / 指针压在玻璃上滚')
        await scrollToBottom()
        const bx = await measureBoxes()
        SCEN.push(['md-wheel-overglass', await burst('md-wheel-overglass', async () => {
          const x = bx.panel.x + bx.panel.w / 2
          const y = bx.panel.y + Math.min(8, bx.panel.h / 2)
          for (let i = 0; i < 80; i += 1) { await wheel(x, y, i % 2 ? 500 : -500); await delay(24) }
        })])
      }
    }

    for (const [id, m] of SCEN) readings.scenarios[id] = m

    /* ── 总账 ───────────────────────────────────────────────────────────── */
    console.log('\n[总账]')
    let domHits = 0
    let pixHits = 0
    let spikes = 0
    let pixFrames = 0
    let domFrames = 0
    let commits = 0
    for (const [id, m] of SCEN) {
      domHits += m.dom.hits?.length ?? 0
      pixHits += m.pix.hits?.length ?? 0
      spikes += m.pix.spikes ?? 0
      pixFrames += m.pix.decoded ?? 0
      domFrames += m.dom.frames ?? 0
      /* 「输入框这一段提交了几次」= React 给那只 file input 写 `type` 的次数。 */
      commits += m.dom.mutKinds?.['attributes:type@INPUT'] ?? 0
      console.log(`  ${id}: DOM 层 ${m.dom.hits?.length ?? 0} 命中 / ${m.dom.frames} 帧`
        + ` · 像素层 ${m.pix.hits?.length ?? 0} 命中(闪 ${m.pix.spikes ?? 0})/ ${m.pix.decoded} 帧`
        + ` · 输入框提交 ${m.dom.mutKinds?.['attributes:type@INPUT'] ?? 0} 次`)
    }
    console.log(`\n  合计:DOM 层 ${domHits} 命中 / ${domFrames} 帧`
      + ` · 像素层 ${pixHits} 命中(**闪 ${spikes}**)/ ${pixFrames} 帧`
      + ` · 输入框提交 ${commits} 次(${SCEN.length} 个场景)`)
    readings.total = { domHits, domFrames, pixHits, spikes, pixFrames, commits, scenarios: SCEN.length }

    /*
     * ══ 断言 ════════════════════════════════════════════════════════════
     * 探针也要判红,否则它只是一段会打印数字的脚本。两条:
     *  ① **自证那一档必须红**(开了 `--selftest` 时)—— 人为藏两帧两层都看不见,
     *    后面那些「零命中」说明的是探针瞎了,不是产品好了。一条恒绿的守卫不是守卫。
     *  ② **自证以外的场景,`spike` 与 DOM 层命中都必须是 0**。
     *    `step`(换挡:发送键变停止键、抽屉开合、输入框里多了字)与 `edge`
     *    (录像头尾,两头缺一头,分不出换挡还是闪)**不计** —— 判词在 `classify` 上。
     */
    const problems = []
    if (process.argv.includes('--selftest')) {
      const st = SCEN.find(([id]) => id === 'selftest')?.[1]
      if (!st || (st.dom.hits?.length ?? 0) === 0) problems.push('自证:DOM 层没红 —— 探针瞎了')
      /*
       * 自证这一格判的是 **`hits`,不是 `spikes`** —— 它问的是「像素层看见了吗」,
       * 而 spike / step / edge 那一层分类要**两头各有十帧邻居**才答得出。静止的短会话上
       * screencast 只在画面变了才给帧(实测整段 24 帧),窗口两头都够不着,人为藏的那
       * 两帧于是被诚实地记成 `edge` —— 那是分类器说「我分不出」,不是探针没看见。
       * 两件事别混判:看没看见 = `hits`,是闪还是换挡 = `spikes`(判词在 `classify`)。
       */
      if (!st || (st.pix.hits?.length ?? 0) === 0) problems.push('自证:像素层没红 —— 探针瞎了')
    }
    for (const [id, m] of SCEN) {
      if (id === 'selftest') continue
      if ((m.pix.spikes ?? 0) > 0) problems.push(`${id}:像素层 ${m.pix.spikes} 个 spike(闪)`)
      if ((m.dom.hits?.length ?? 0) > 0) problems.push(`${id}:DOM 层 ${m.dom.hits.length} 个命中`)
    }
    readings.problems = problems
    if (problems.length) {
      console.error(`\n[flicker] FAILED —— ${problems.length} 条:\n  ${problems.join('\n  ')}`)
      failed = true
    } else {
      console.log('\n[flicker] ok —— 自证两层都红,其余场景零闪、零 DOM 命中')
    }
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

  /* 收尸自查(壳 CLAUDE.md「真机 harness 退出必须收尸」)。 */
  try {
    const ps = execFileSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf-8' })
    const mine = ps.split('\n').filter((l) =>
      l.includes('flick-store-') || l.includes('flick-udd-') || (!PROD && l.includes(`:${DEV_PORT}`)))
    if (mine.length) console.log(`\n[flicker] **残留自查:还有 ${mine.length} 条**\n  ${mine.join('\n  ')}`)
    else console.log('\n[flicker] 残留自查:干净(vite / electron / server 都收了)')
  } catch { console.log('\n[flicker] 残留自查:ps 跑不起来,跳过') }

  const jsonAt = argOf('--json')
  if (jsonAt) {
    mkdirSync(path.dirname(jsonAt), { recursive: true })
    writeFileSync(jsonAt, JSON.stringify(readings, null, 2))
    console.log(`[flicker] 读数写到 ${jsonAt}`)
  }
  console.log(`\n[flicker] 读数(${LANE}):${JSON.stringify(readings.total ?? {})}`)
  if (failed) process.exit(1)
}

function report(tag, m) {
  const d = m.dom
  const p = m.pix
  console.log(`      ${tag} · DOM:${d.frames} 帧 @${d.fps}fps / ${d.spanMs}ms`
    + ` · 滚了 ${d.scrolled}px · 面板重挂 ${d.remounts} · 文件 input 换节点 ${d.fileRemounts}`
    + ` · --composer-h 变 ${d.composerHChanges} 次`
    + ` · 面板顶漂 ${d.panelTopDriftPx}px · 命中 ${d.hits?.length ?? 0}`
    + ` · 长帧 ${d.longFrames}(最长 ${d.longestFrameMs}ms) · 改动 ${d.muts} 条`)
  if (d.mutKinds && Object.keys(d.mutKinds).length) {
    console.log(`        改动前几名:${JSON.stringify(d.mutKinds)}`)
  }
  for (const h of (d.hits ?? []).slice(0, 8)) {
    console.log(`        [DOM 命中 ${Math.round(h.t)}ms] ${h.why}(scrollTop=${h.st} 行数=${h.rows})`)
  }
  if (p.empty) { console.log(`      ${tag} · 像素:${p.frames ?? 0} 帧,量不了(${p.why ?? '帧太少'})`); return }
  console.log(`      ${tag} · 像素:收 ${p.captured} / 解 ${p.decoded} 帧 · 图 ${p.imgSize} 缩放 ${p.scale}`
    + ` · 键芯 ${p.sendCorePx} rgb(${p.sendCoreRgb}) 参考帧 ${p.refAt}`)
  console.log(`      ${' '.repeat(tag.length)}   `
    + ` · 发送键芯 中位亮度 ${p.sendMedian}、帧间差 中位 ${p.sendStepMedian} / 最大 ${p.sendStepMax}`
    + ` · 面板帧间差 中位 ${p.panelStepMedian} / 最大 ${p.panelStepMax}`
    + ` · 上方带帧间差 中位 ${p.aboveStepMedian}`
    + ` · 面板梯度 中位 ${p.gradMedian} / 最大 ${p.gradMax}`
    + ` · 命中 ${p.hits.length}(**闪 ${p.spikes}** / 换挡 ${p.steps} / 段首尾 ${p.edges}）`)
  for (const h of p.hits.slice(0, 10)) {
    console.log(`        [像素命中 第 ${h.i} 帧 · ${h.kind}] ${h.reasons.join(' / ')}`)
  }
  if (p.saved?.length) console.log(`        出事帧存了 ${p.saved.length} 张,第一张:${p.saved[0]}`)
}

main().catch((error) => {
  console.error(`\n[flicker] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
