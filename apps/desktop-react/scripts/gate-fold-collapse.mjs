#!/usr/bin/env node
/**
 * **手动收起一块东西,屏上其余内容一像素不动** —— 真机门(G 线 P2-b,2026-09-21;
 * 正本 `apps/desktop-react/docs/stream-geometry-2026-09.md` §13.4 的 P2-b、§15)。
 *
 * ══ 它判的是哪一件病 ══════════════════════════════════════════════════════
 * 正本 §0 ①:贴底时一块东西缩掉,页面总高瞬间变小,浏览器当场钳 `scrollTop`
 * (真机 849 / 1674 / 2094 / 15054px),**改动点以上**的内容整体往下掉一截。
 * 从前它只有一个产地(思考段收尾自动折,G 线 P1 已经删掉);**手动**收起那一半
 * 一直活着,而且四族可折叠的东西里有三族连一句意图都不报(§13.1.4 ①)。
 *
 * 修法两件,门也判两件:
 *  ① **卷尾垫块吸收回缩**(G1:一轮之内页面总高不许变小)—— 于是屏上其余内容不动;
 *  ② **被点的那一块顶边不动**(§1 推论二)—— 于是被点的那一块自己也不跳。
 *
 * ══ 取样口:**画出来的那一份**,不是 rAF ══════════════════════════════════
 * 与 `gate-tail-jitter` 同一条判词(正本 §9.7 ②):rAF 跑在「动画推进之后、布局与
 * ResizeObserver 之前」,读到的是**这一帧的半成品** —— 而这道门量的位移恰恰是由
 * 产品在 RO 回调里那一句补偿决定的。所以只认一个口:**在 `requestAnimationFrame`
 * 里 `postMessage` 出去的那个宏任务里读**。
 *
 * ══ 判的那几格(`BUDGET`)════════════════════════════════════════════════
 *  ① **落点**(审查裁定 1,2026-09-22):收起之后被点那一块的顶边
 *     y = `max(收起前的顶边 y, 视口上缘 + 滚动口的上内衬)`,±1px。
 *     顶边本来就在视口里 → 它一像素不动;在视口上方 → 收起后的那一行落在视口上缘。
 *  ② **它上方任一可见元素的位移** ≤1px —— 拿「视口内第一块在读的东西」当代表,
 *     判词与产品的 `pickFoldAnchor` / `gate-stream-geometry` 的 `readAnchorOf` 同源。
 *  ③ **列的总高全程不跌破收起之前那个数**(G1 的字面:一轮之内页面总高在任何一次
 *     排版里都不许变小)。过渡期间垫块先长、内容再逐帧缩回去,所以判的是**最低点**。
 *  ④ **垫块任何时刻 ≤ `clientHeight`**
 *     (§13.6 第 1 条;落点定在「顶边最高只到视口上缘」之后,真值必然 ≤ 一屏)。
 *  ⑤ **手动展开**:被点那一块的顶边位移 ≤1px,期间 `scrollTop` 位移 ≤1px(点开不贴底)。
 *  ⑦ **过渡全程单调靠近落点,不反弹**;**它后面第一块内容紧跟其下**;
 *     **屏上不出现「整屏空白」**(视口内可见内容高 > 0)。
 *  ⑥ **垫块释放**:收起后人往上滚 → 垫块跟着缩且屏上零位移;往下滚到底 → 停在
 *     内容底(空白不超过一屏);再发一轮 → 垫块归零。
 *  ⑦ **过渡中途再点一次 / 中途来内容**:上方位移 ≤1px。
 *
 * ══ 展开那一侧(审查裁定 2,2026-09-22)═══════════════════════════════════
 * 从前 ⑤ 是「只报不判」的存量红:同一条会话第二次展开时视口被拽到底 166–435px
 * (动效档「无」下是整块的高)。病根在 `expanding()` 那一判落在过渡刚起步那一批
 * (gap 仍是 0,跟随档没翻),窗口一过 `stick()` 就把人拽走。
 * 裁定:**展开也由 `report()` 在点的那一刻开窗、钉住被点那一块的顶边**,窗口结束时
 * **按此刻离底多远重判跟随档**。于是这一格转成断言。
 *
 * ══ 场景与两档 ════════════════════════════════════════════════════════════
 * 四族可折叠的东西:3 千字思考段 / 6 万字思考段 / 多步工具卡 / 上下文更新折痕,
 * 各 × {贴底, 上翻半屏后}。
 *
 * **短会话是主场,真店是对照组** —— 正本 §0 末尾那句「`gate:send-flow` 为什么一直
 * 绿:它的超量夹具上面压着 400 条消息,`scrollTop` 钳不到,所以 ① 量不出来。短会话
 * 里才全额暴露」说的正是这条新断言的陷阱。`--big` 跑真店夹具那一档。
 *
 * **压缩折痕没进这道门**:它要一次真的压缩(账本上一条带 `context-compact` 正文的
 * system 消息),假 provider 造不出来,直写账本又要把压缩协议在夹具里再实现一遍。
 * 它与上下文更新折痕**共用同一段代码**(两者都是 `<Fold anchored open=… onOpenChange=
 * {(next) => setOpen(report({ el: rootRef.current, … }))}>` 包着同一只 `Seam`),
 * 那一格由 `src/content/__tests__/geometry-report.test.tsx` 逐字咬住。留账在正本 §16。
 *
 * ══ 纪律 ══════════════════════════════════════════════════════════════════
 * 屏外档 `ONETHING_GATE_OFFSCREEN=1`(老那一档把整扇窗节流到 1Hz,量的会是节流器);
 * dpr 钉 2;临时 store + 临时 `--user-data-dir`,**绝不连 `~/.onething`**;
 * 输入只走 `page.evaluate` / CDP;`finally` 里逐个收尸并自查残留。
 *
 * 跑法:`npm run gate:fold-collapse`([`--big`] [`--only <场景>`] [`--motion-none`])
 * (仓根先 `bun run server:build`;先 `npm run electron:build`。)
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

const BIG = process.argv.includes('--big')
const MOTION_NONE = process.argv.includes('--motion-none')
const LANE = BIG ? 'big' : 'short'
const ONLY = (() => {
  const at = process.argv.indexOf('--only')
  return at >= 0 ? process.argv[at + 1] : undefined
})()

const DEV_PORT = Number(process.env.ONETHING_GATE_VITE_PORT ?? 5281)
const VIEWPORT = { width: 1280, height: 800 }
const DPR = 2

/* ── 预算 ────────────────────────────────────────────────────────────────
 * **抬 `BUDGET` 是改法,让它恒红只会被人加 `|| true`**(体例与这一族其余几道门同源)。 */
const BUDGET = {
  /** ①② 位移:被点那一块的顶边 / 它上方那一块(px)。 */
  shiftPx: 1,
  /** ③ 非用户动作的 `scrollHeight` 回缩次数。 */
  shrinks: 0,
  /** ⑥ 发送之后垫块该归零(px)。 */
  padAfterSendPx: 0.5,
  /** ⑦ 「它后面第一块内容紧跟其下」的缝(px)—— 列的 `gap` 由节奏表说,这里只判不许多出来。 */
  followGapPx: 40,
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`)
  else {
    console.log(`  ✗ ${message}`)
    failures.push(message)
  }
}

/* ══ 假 provider(只有上下文更新折痕那一档要它真回一句)══════════════════════ */

function startProvider() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (delta, finish = null) => {
        if (res.writableEnded || res.destroyed) return
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-fold', object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000), model: 'deepseek-chat',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`)
      }
      const text = '好的,这是一段普通的回答。'
      for (let i = 0; i < text.length; i += 6) {
        if (res.destroyed) break
        send({ content: text.slice(i, i + 6) })
        await delay(25)
      }
      if (!res.destroyed) {
        send({}, 'stop')
        res.write('data: [DONE]\n\n')
      }
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/* ══ 小工具 ════════════════════════════════════════════════════════════════ */

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

/** 信封形与 `gate-tail-jitter` 逐字同源(`{ok, data}`,不是 `{result}`)。 */
async function rpc(record, domain, method, payload = {}) {
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${record.token}` },
    body: JSON.stringify({ id: `fold-${Date.now()}`, domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  const body = await response.json()
  if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  return body.data
}

/* ══ 屏上那一片会话叶 ══════════════════════════════════════════════════════ */

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
/* 「这条回复里视口内第一块在读的东西」—— 与产品的 pickFoldAnchor 逐字同源。 */
window.__fReadAnchor = function (scroll) {
  var top = scroll.getBoundingClientRect().top
  var anchor = null
  var cursor = scroll.firstElementChild
  for (var depth = 0; cursor && depth < 4; depth += 1) {
    var kids = cursor.children
    var lo = 0, hi = kids.length - 1, found = null
    while (lo <= hi) {
      var mid = (lo + hi) >> 1
      var el = kids[mid]
      if (!el) break
      if (el.getBoundingClientRect().bottom > top + 1) { found = el; hi = mid - 1 } else lo = mid + 1
    }
    if (!found) break
    if (found.hasAttribute('data-seat') || found.hasAttribute('data-tail-spacer')) break
    anchor = found
    if (found.getBoundingClientRect().top >= top - 1) break
    cursor = found
  }
  return anchor
}
`

/* ══ 取样:画出来的那一份 ══════════════════════════════════════════════════ */

async function startPaintSampler(page) {
  await page.evaluate(() => {
    window.__fPaint = []
    let stopped = false
    let scroll = null
    let column = null
    let pad = null
    const alive = (el) => el && el.isConnected
    const sampleAfterPaint = () => {
      if (stopped) return
      if (!alive(scroll)) scroll = window.__fLeaf().querySelector('[data-testid="chat-stream"]')
      if (scroll) {
        const nextColumn = scroll.firstElementChild
        if (nextColumn !== column) { column = nextColumn; pad = null }
        if (!alive(pad) && column) pad = column.querySelector(':scope > [data-seat]')
        const target = window.__fTarget && window.__fTarget.isConnected ? window.__fTarget : null
        /* **钉死的那一块**(瞄准那一刻选的),不是每帧现选 —— 现选会换人,做差没有意义。 */
        const above = window.__fAbove && window.__fAbove.isConnected ? window.__fAbove : null
        window.__fPaint.push({
          t: performance.now(),
          /** 被点的那一块此刻的顶边(视口坐标)。 */
          target: target ? target.getBoundingClientRect().top : null,
          /* 它此刻多高 —— 事后算「这一下到底缩了多少」用它,不必在驱动里再读一次。 */
          targetH: target ? target.getBoundingClientRect().height : null,
          /** 它后面那一块的顶边 —— ⑦ 判「紧跟其下」。 */
          nextTop: target && target.nextElementSibling instanceof HTMLElement
            ? target.nextElementSibling.getBoundingClientRect().top : null,
          targetAlive: Boolean(target),
          /** 它上方那一块(视口内第一块在读的东西)。 */
          above: above ? above.getBoundingClientRect().top : null,
          st: scroll.scrollTop,
          sh: scroll.scrollHeight,
          ch: scroll.clientHeight,
          /** 卷尾垫块此刻多高(没有那一格 = 0)。 */
          padH: alive(pad) ? pad.getBoundingClientRect().height : 0,
          phase: window.__fPhase ?? '',
        })
      }
      requestAnimationFrame(tick)
    }
    const channel = new MessageChannel()
    channel.port1.onmessage = sampleAfterPaint
    const tick = () => { if (!stopped) channel.port2.postMessage(0) }
    requestAnimationFrame(tick)
    window.__fPaintStop = () => { stopped = true; channel.port1.onmessage = null }
  })
}

async function stopPaintSampler(page) {
  return page.evaluate(() => {
    window.__fPaintStop?.()
    const frames = window.__fPaint ?? []
    window.__fPaint = []
    return frames
  })
}

/* ══ 事后那一遍算 ══════════════════════════════════════════════════════════ */

/** 一段样本里某一格的峰峰值(相对第一帧)。 */
function spanOf(frames, key) {
  const first = frames.find((f) => f[key] !== null)
  if (!first) return { n: 0, maxPx: null }
  let max = 0
  let n = 0
  for (const f of frames) {
    if (f[key] === null) continue
    n += 1
    max = Math.max(max, Math.abs(f[key] - first[key]))
  }
  return { n, maxPx: Number(max.toFixed(2)), from: Number(first[key].toFixed(2)) }
}

const padMax = (frames) => Number(Math.max(0, ...frames.map((f) => f.padH)).toFixed(2))

/* ══ 驱动 ══════════════════════════════════════════════════════════════════ */

async function clickTestId(page, id) {
  const ok = await page.evaluate((x) => {
    const el = document.querySelector(`[data-testid="${x}"]`)
    if (!(el instanceof HTMLElement)) return false
    el.click()
    return true
  }, id)
  if (!ok) throw new Error(`点不到 [data-testid="${id}"]`)
}

/** 打字 + 点发送键 —— 与 `gate-tail-jitter` 逐字同源(不合成按键,点产品自己的钮)。 */
async function sendViaComposer(page, text) {
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
    const send = window.__fLeaf().querySelector('[data-testid="composer-send"]')
    if (!(send instanceof HTMLElement) || send.hasAttribute('disabled')) return false
    send.click()
    return true
  })
  if (!sent) throw new Error('发送键点不动')
}

const stopShown = (page) => page.evaluate(() =>
  Boolean(window.__fLeaf().querySelector('[data-testid="chat-stop"]')))

const mark = (page, phase) => page.evaluate((v) => { window.__fPhase = v }, phase)

/** 把被点的那一块钉成取样的目标,并返回它此刻的顶边。 */
const aimAt = (page, selector, which) => page.evaluate(({ sel, w }) => {
  const list = window.__fLeaf().querySelectorAll(sel)
  const el = w === 'last' ? list[list.length - 1] : list[0]
  if (!(el instanceof HTMLElement)) return null
  window.__fTarget = el
  /*
   * 同一刻钉住「**它上方**那一块」。
   *
   * 判据是「视口内第一块在读的东西」**而且它整个落在被点那一块的上缘之上** ——
   * 少了后半句就会钉到一块与被点的那一块重叠(甚至就在它里面)的东西上,那时
   * 「它上方没动」这句话根本不成立(09-21 真机:折痕那一档报 45.9px,钉到的是
   * 折痕自己所在的那一行)。视口里它上面什么都没有时答 null,这一格当场跳过 ——
   * **判不了就说判不了,不给一个假的 0**。
   */
  const scroll = window.__fLeaf().querySelector('[data-testid="chat-stream"]')
  const first = scroll ? window.__fReadAnchor(scroll) : null
  const targetTop = el.getBoundingClientRect().top
  window.__fAbove = first && first.getBoundingClientRect().bottom <= targetTop + 1 ? first : null
  return targetTop
}, { sel: selector, w: which })

/** 点被点的那一块(它自己就是把手:思考段 / 折痕标签 / 工具卡头行)。 */
/**
 * 点被点的那一块(它自己就是把手:思考段 / 折痕标签;工具卡的把手是它的头行)。
 * **把手找不到就当场抛** —— 悄悄点在别处的话「缩了 0px」会变成一条假绿。
 */
async function clickTarget(page, handle) {
  const answer = await page.evaluate((sel) => {
    const target = window.__fTarget
    if (!(target instanceof HTMLElement)) return 'no-target'
    const el = sel ? target.querySelector(sel) : target
    if (!(el instanceof HTMLElement)) return 'no-handle'
    el.click()
    return 'ok'
  }, handle)
  if (answer !== 'ok') throw new Error(`点不到把手(${answer};handle=${handle ?? '它自己'})`)
}

const scrollToBottom = (page) => page.evaluate(() => {
  const el = window.__fLeaf().querySelector('[data-testid="chat-stream"]')
  if (!el) return
  el.scrollTop = el.scrollHeight
  el.dispatchEvent(new Event('scroll', { bubbles: false }))
})

const scrollBy = (page, dy) => page.evaluate((d) => {
  const el = window.__fLeaf().querySelector('[data-testid="chat-stream"]')
  if (!el) return null
  el.scrollTop = Math.max(0, el.scrollTop + d)
  el.dispatchEvent(new Event('scroll', { bubbles: false }))
  return { st: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight }
}, dy)

/* ══ 场景表 ════════════════════════════════════════════════════════════════
 * 每一族一行:怎么造一条会话、屏上怎么找到它、把手在哪。
 * **这张表是这道门唯一认识「哪一族」的地方** —— 上面的驱动与下面的判据都不点名。 */
const TARGETS = [
  {
    id: 'think3k',
    label: '3 千字思考段',
    seed: { messages: 2, toolCallsPerTurn: [0, 0], reasoningEveryTurns: 1, reasoningChars: 3_000 },
    selector: '[data-testid="chat-thought"]',
    which: 'last',
    handle: null,
  },
  {
    id: 'think60k',
    label: '6 万字思考段',
    seed: { messages: 2, toolCallsPerTurn: [0, 0], reasoningEveryTurns: 1, reasoningChars: 60_000 },
    selector: '[data-testid="chat-thought"]',
    which: 'last',
    handle: null,
  },
  {
    id: 'tool',
    label: '多步工具卡',
    seed: { messages: 2, toolCallsPerTurn: [6, 6], reasoningEveryTurns: 0 },
    selector: '[data-tool-card]',
    which: 'last',
    handle: '[data-tool-head]',
    /*
     * **展开之后还要把聚合行也点开**(09-21 真机逼出来的):夹具那六次调用是同一只
     * 工具,于是展开态画的是**一行聚合行**(「read ×6」)而不是六行 —— 卡的高两态
     * 相同,「这一下缩了多少」量出来是 0,整档变成一条假绿。
     * 聚合行开合走的是同一条报的路(`toggleKey`),所以这一档量的仍然是工具卡那一族。
     */
    also: '[data-tool-aggregate]',
  },
  {
    id: 'ctxseam',
    label: '上下文更新折痕',
    /** 它要一轮**真的**回合(`TurnContextLedger` 只在一条会话的第一轮给整块)。 */
    send: true,
    selector: '[data-testid="context-delta-seam"]',
    which: 'last',
    handle: '[data-testid="context-delta-label"]',
  },
]

/** 短会话那一档的共同种子:把「真店」那几格全关掉,只留要量的那一族。 */
const SHORT_SEED = {
  targetBytes: 0,
  targetToolCalls: 0,
  replyChars: 400,
  largeResults: 0,
  images: 0,
  recipeRoundsPerTurn: 0,
  assistantChunks: 4,
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[fold-collapse] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry)) {
    console.error('[fold-collapse] 找不到主进程产物 —— 先跑 `npm run electron:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'fold-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'fold-udd-'))
  let provider; let server; let app; let vite

  try {
    console.log(`\n[fold-collapse] 档位:${LANE}${MOTION_NONE ? ' · 动效档「无」' : ''} · dpr 钉 ${DPR}`)
    provider = await startProvider()
    writeFileSync(path.join(store, 'settings.json'), JSON.stringify({
      ai: fakeProviderAiSettings(provider.address().port),
      tools: {
        enableToolCalls: true,
        permissionMode: 'dangerously-allow-all',
        bash: { enableSandbox: false, confirmDangerousCommands: false },
      },
      diagnostics: { enabled: false },
    }, null, 2))

    const boot = () => spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ...FAKE_PROVIDER_ENV, ONETHING_STORE_PATH: store },
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server = boot()
    const err = []
    server.stderr.on('data', (c) => err.push(c.toString()))
    let record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch((e) => { throw new Error(`${e.message}\nserver stderr:\n${err.join('').slice(-2000)}`) })
    if (!(await portConnects(record.host, record.port))) throw new Error('core 端口连不上')

    /* 每一族一条会话 —— 互不干扰,而且每一条都短到「总高不过两三屏」(主场)。 */
    const targets = TARGETS.filter((tg) => !ONLY || tg.id === ONLY)
    const sessions = new Map()
    for (const tg of targets) {
      const id = (await rpc(record, 'sessions', 'create', { name: `折叠门 · ${tg.label}` }))?.session?.id
      if (!id) throw new Error('会话没建出来')
      sessions.set(tg.id, id)
    }
    /* 直写账本要停 core(它是唯一的写者),写完再起回来。 */
    const seeded = targets.filter((tg) => !tg.send)
    if (seeded.length > 0) {
      server.kill('SIGTERM')
      await delay(1200)
      for (const tg of seeded) {
        const stats = seedLargeLedger(store, sessions.get(tg.id), BIG
          ? { ...tg.seed, messages: 400 }
          : { ...SHORT_SEED, ...tg.seed })
        console.log(`[fold-collapse] ${tg.label}:${(stats.ledgerBytes / 1024).toFixed(0)}KB / ${stats.messages} 条`)
      }
      server = boot()
      record = await waitFor('core 重新写出发现文件', () => {
        const found = readDiscovery(store)
        return found && found.pid === server.pid ? found : undefined
      })
    }

    let rendererUrl
    const { createServer } = await import('vite')
    vite = await createServer({
      configFile: path.join(appRoot, 'vite.config.ts'),
      server: { port: DEV_PORT, strictPort: true },
      logLevel: 'warn',
    })
    await vite.listen()
    rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`

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
      width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: DPR, mobile: false,
    })
    await page.addInitScript(LEAF_PROBE)
    await page.evaluate(LEAF_PROBE)
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const v = await page.evaluate(() => window.__d0 ?? null)
      return v && v.rpcOk ? v : undefined
    })
    const realDpr = await page.evaluate(() => window.devicePixelRatio)
    if (realDpr !== DPR) throw new Error(`dpr 钉不住(要 ${DPR},实得 ${realDpr})—— 读数不成立`)
    /*
     * **动效档走 `<html>` 上那一格,不走设置**:产品自己的产地就是
     * `document.documentElement[data-motion-tier]`(`components/motion.ts:150`),
     * 而门要的是「这一档下同样不许钳」,不是「设置页那一格通不通」。
     */
    const setTier = async () => {
      if (!MOTION_NONE) return
      await page.evaluate(() => document.documentElement.setAttribute('data-motion-tier', 'none'))
    }
    await setTier()
    console.log(`[fold-collapse] 动效档:${await page.evaluate(() =>
      document.documentElement.getAttribute('data-motion-tier') ?? '(缺省)')}`)

    const openSession = async (id) => {
      const rowShown = () => page.evaluate((x) =>
        Boolean(document.querySelector(`[data-testid="session-row-${x}"]`)), id)
      for (let n = 0; n < 3 && !(await rowShown()); n += 1) {
        await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
        await delay(600)
      }
      await waitFor('总览画出那一行', rowShown)
      await clickTestId(page, `session-row-${id}`)
      await waitFor('聊天区就位', () => page.evaluate(() =>
        Boolean(window.__fLeaf().querySelector('[data-testid="chat-stream"]'))))
      await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
      await delay(700)
    }

    const readings = {}
    for (const tg of targets) {
      const sessionId = sessions.get(tg.id)
      console.log(`\n[fold-collapse] ${tg.label}(${tg.id})`)
      await openSession(sessionId)
      if (tg.send) {
        await sendViaComposer(page, '折叠门 · 起一轮')
        await waitFor('这一轮开张', () => stopShown(page), 120_000)
        await waitFor('这一轮收场', async () => !(await stopShown(page)), 120_000)
        await delay(1200)
      }
      await waitFor('那一族上屏', () => page.evaluate((sel) =>
        window.__fLeaf().querySelectorAll(sel).length > 0, tg.selector), 60_000)

      readings[tg.id] = {}
      for (const where of ['bottom', 'scrolledUp']) {
        const key = `${tg.id}:${where}`
        console.log(`  ── ${where === 'bottom' ? '贴底' : '上翻半屏后'} ──`)
        /* ① 先展开(它出厂是收着的),这一下同样量 —— ⑤ 判的就是它。 */
        await scrollToBottom(page)
        await delay(400)
        await aimAt(page, tg.selector, tg.which)
        await startPaintSampler(page)
        await mark(page, 'expand')
        await delay(200)
        await clickTarget(page, tg.handle)
        if (tg.also) {
          await delay(250)
          await clickTarget(page, tg.also)
        }
        await delay(700)
        const expandFrames = (await stopPaintSampler(page)).filter((f) => f.phase === 'expand')

        /* ② 摆姿势:贴底 / 上翻半屏。 */
        await scrollToBottom(page)
        await delay(300)
        if (where === 'scrolledUp') {
          const geo = await scrollBy(page, -Math.round(VIEWPORT.height / 2))
          await delay(400)
          if (!geo) throw new Error('量不到几何')
        }
        /* ③ 收起,全程取样。**收起之前先把几何记下来** —— 判据要算物理边界。 */
        const beforeTop = await aimAt(page, tg.selector, tg.which)
        const before = await page.evaluate(() => {
          const el = window.__fLeaf().querySelector('[data-testid="chat-stream"]')
          const target = window.__fTarget
          if (!el || !(target instanceof HTMLElement)) return null
          const view = el.getBoundingClientRect()
          const rect = target.getBoundingClientRect()
          return {
            sh: el.scrollHeight,
            ch: el.clientHeight,
            gap: el.scrollHeight - el.clientHeight - el.scrollTop,
            targetH: rect.height,
            targetTop: rect.top,
            viewTop: view.top,
            inset: Number.parseFloat(getComputedStyle(el).paddingBlockStart) || 0,
          }
        })
        await startPaintSampler(page)
        await mark(page, 'collapse')
        await delay(160)
        if (tg.also) {
          await clickTarget(page, tg.also)
          await delay(250)
        }
        await clickTarget(page, tg.handle)
        await delay(800)
        const collapseFrames = (await stopPaintSampler(page)).filter((f) => f.phase === 'collapse')

        readings[tg.id][where] = {
          beforeTop,
          expand: {
            target: spanOf(expandFrames, 'target'),
            above: spanOf(expandFrames, 'above'),
            /*
             * ⑤ **展开期间视口一格不许动**(「点开不贴底」的可量形)。
             * 从前这一格判的是「结束时贴没贴底」—— 那在**总高不足一屏**的会话里恒真
             * (永远贴着底),是一条会说谎的判据。
             */
            stSpanPx: (() => {
              if (expandFrames.length === 0) return null
              const first = expandFrames[0].st
              return Number(Math.max(...expandFrames.map((f) => Math.abs(f.st - first))).toFixed(2))
            })(),
            n: expandFrames.length,
          },
          collapse: (() => {
            const last = collapseFrames[collapseFrames.length - 1]
            const shrinkPx = before && last?.targetH !== null && last !== undefined
              ? Number((before.targetH - last.targetH).toFixed(2)) : null
            const required = before && shrinkPx !== null
              ? Math.max(0, Number((shrinkPx - before.gap).toFixed(2))) : null
            const lastFrame = collapseFrames[collapseFrames.length - 1]
            const landing = before ? Math.max(before.targetTop, before.viewTop + before.inset) : null
            const tops = collapseFrames.map((f) => f.target).filter((v) => v !== null)
            const finalTop = tops.length ? tops[tops.length - 1] : null
            /*
             * **单调靠近不反弹**:每一帧与落点的距离只许变小。这一格抓的是「先跳过去
             * 再被钳回来」那种两段式 —— 产品是同一帧一次写到位,真值该是第一帧就在落点上。
             */
            /*
             * **单调不反弹**:顶边这一路只许往一个方向走。抓的是「先跳过去再被钳
             * 回来」那种两段式 —— 产品是同一帧一次写到位,真值该是第一帧就到位、
             * 之后一格不动。方向由这一段的净位移定(被夹住时净位移可能不为 0)。
             */
            let worstBounce = 0
            if (tops.length > 1) {
              const net = tops[tops.length - 1] - tops[0]
              const dir = Math.abs(net) < 1 ? 0 : Math.sign(net)
              for (let i = 1; i < tops.length; i += 1) {
                const step = tops[i] - tops[i - 1]
                worstBounce = Math.max(worstBounce, dir === 0 ? Math.abs(step) : -dir * step)
              }
            }
            /** 屏上还看得见多少内容(垫块不算内容)。 */
            const visibleContentPx = lastFrame
              ? Math.max(0, Math.min(lastFrame.sh - lastFrame.padH, lastFrame.st + lastFrame.ch) - lastFrame.st)
              : null
            /** 它后面那一块紧跟其下吗(下一块的顶边 − 被点那一块的下缘)。 */
            const followGapPx = lastFrame && lastFrame.nextTop !== null && lastFrame.target !== null
              && lastFrame.targetH !== null
              ? Number((lastFrame.nextTop - (lastFrame.target + lastFrame.targetH)).toFixed(2))
              : null
            return {
              landing: landing === null ? null : Number(landing.toFixed(2)),
              finalSt: lastFrame ? Number(lastFrame.st.toFixed(2)) : null,
              expectedSt: before && landing !== null
                ? Number(Math.max(0, (before.sh - before.ch - before.gap) - (landing - before.targetTop)).toFixed(2))
                : null,
              landedStOffPx: before && landing !== null && lastFrame
                ? Number(Math.abs(lastFrame.st
                    - Math.max(0, (before.sh - before.ch - before.gap) - (landing - before.targetTop))).toFixed(2))
                : null,
              finalTop: finalTop === null ? null : Number(finalTop.toFixed(2)),
              landedOffPx: landing === null || finalTop === null
                ? null : Number(Math.abs(finalTop - landing).toFixed(2)),
              movedToTop: landing !== null && before !== null && landing > before.targetTop + 0.5,
              worstBouncePx: Number(worstBounce.toFixed(2)),
              visibleContentPx: visibleContentPx === null ? null : Number(visibleContentPx.toFixed(2)),
              followGapPx,
              target: spanOf(collapseFrames, 'target'),
              above: spanOf(collapseFrames, 'above'),
              /* G1:这一段里列的总高不许跌破**收起之前**那个数。 */
              lowestSh: collapseFrames.length
                ? Number(Math.min(...collapseFrames.map((f) => f.sh)).toFixed(2)) : null,
              shBefore: before?.sh ?? null,
              gapBefore: before?.gap ?? null,
              shrinkPx,
              required,
              padMaxPx: padMax(collapseFrames),
              clientHeight: before?.ch ?? collapseFrames[0]?.ch ?? 0,
              n: collapseFrames.length,
            }
          })(),
        }
        const c = readings[tg.id][where].collapse
        console.log(`     收起:缩 ${c.shrinkPx}px · 离底 ${c.gapBefore}px · 要垫 ${c.required}px`
          + ` / 一屏 ${c.clientHeight}px`)
        console.log(`           落点 ${c.landing}px(${c.movedToTop ? '挪到视口上缘' : '原地'})`
          + ` · 停在 ${c.finalTop}px 差 ${c.landedOffPx}px · 回弹 ${c.worstBouncePx}px`
          + ` · 上方 ${c.above.maxPx}px · 垫块峰值 ${c.padMaxPx}px`
          + ` · 可见内容 ${c.visibleContentPx}px · 后接缝 ${c.followGapPx}px · ${c.n} 帧`)
        console.log(`     展开:被点那一块位移 ${readings[tg.id][where].expand.target.maxPx}px`
          + ` · 上方 ${readings[tg.id][where].expand.above.maxPx}px`
          + ` · scrollTop 位移 ${readings[tg.id][where].expand.stSpanPx}px`)

        /* 把它收回原样,下一档从同一个姿势起。 */
        if (where === 'bottom') {
          await scrollToBottom(page)
          await delay(300)
        }
      }

      /*
       * ⑥ 垫块释放 —— 跑一遍就够(它是垫块自己的行为,不随族变),但**必须跑在
       * 一个「垫得满」的族上**:垫不满的那一档产品一格不垫(判词在
       * `TailPad.requestAbsorb`),那时「人往上滚屏上零位移」说的是普通滚动,
       * 量它没有意义。
       *
       * **真店档不跑它**:它末尾要真发一轮,而 50MB / 400 条那条会话上一次开张要等
       * 到 120s 以上(整段历史进请求)—— 那是账本规模的账,不是垫块的。垫块的释放
       * 与账本多大无关,短会话档证过就够(09-22 实测,理由写在这儿而不是拉长超时)。
       */
      if (!BIG && !readings.release && readings[tg.id].bottom.collapse.required > 0) {
        console.log('  ── 垫块释放 ──')
        await scrollToBottom(page)
        await delay(300)
        await aimAt(page, tg.selector, tg.which)
        await clickTarget(page, tg.handle)          // 展开
        if (tg.also) { await delay(250); await clickTarget(page, tg.also) }
        await delay(600)
        await scrollToBottom(page)
        await delay(300)
        await startPaintSampler(page)
        await mark(page, 'release')
        if (tg.also) { await clickTarget(page, tg.also); await delay(250) }
        await clickTarget(page, tg.handle)          // 收起
        await delay(600)
        const padAfterCollapse = padMax(await page.evaluate(() => window.__fPaint.slice()))
        await mark(page, 'release-up')
        /* 人往上滚三小段:垫块该跟着缩,屏上零位移。 */
        const ladder = []
        for (let n = 0; n < 3; n += 1) {
          await scrollBy(page, -120)
          await delay(260)
          ladder.push(await page.evaluate(() => {
            const last = window.__fPaint[window.__fPaint.length - 1]
            return last ? { padH: Number(last.padH.toFixed(2)), above: last.above } : null
          }))
        }
        await mark(page, 'release-down')
        await scrollToBottom(page)
        await delay(400)
        const bottomGap = await page.evaluate(() => {
          const el = window.__fLeaf().querySelector('[data-testid="chat-stream"]')
          const col = el?.firstElementChild
          const pad = col?.querySelector(':scope > [data-seat]')
          if (!el || !col) return null
          return {
            padH: pad ? Number(pad.getBoundingClientRect().height.toFixed(2)) : 0,
            ch: el.clientHeight,
          }
        })
        /* 再发一轮:垫块归零。 */
        await mark(page, 'release-send')
        await sendViaComposer(page, '折叠门 · 释放那一轮')
        await waitFor('这一轮开张', () => stopShown(page), 120_000)
        await waitFor('这一轮收场', async () => !(await stopShown(page)), 120_000)
        await delay(800)
        const releaseFrames = await stopPaintSampler(page)
        const sendFrames = releaseFrames.filter((f) => f.phase === 'release-send')
        readings.release = {
          padAfterCollapse,
          ladder,
          bottomGap,
          /* 发送之后座位是另一回事(它由落位自己算),判的是**吸收那一半**已经不在:
             发送落位之后的最后一帧,垫块高应当由座位说了算 —— 收场之后座位吃光即 0。 */
          padAfterSend: sendFrames.length > 0
            ? Number(sendFrames[sendFrames.length - 1].padH.toFixed(2)) : null,
          /*
           * **人往上滚时屏上不许「往回跳」**。
           * 这一格判的**不是**「零位移」—— 人在滚,屏当然要跟着走;要判的是那一段里
           * 那一块**只往一个方向走**:垫块每缩一截都恰好是视口下方看不见的那一截,
           * 所以它对屏上的东西是恒等的。一旦垫块缩多了(或缩早了)就会钳一下,
           * 表现是那一块**往回弹**一帧 —— 那才是这一格要抓的东西。
           */
          upBounce: (() => {
            /*
             * 量**被点那一块自己**,不量「它上方那一块」:后者在「视口里它上面什么都
             * 没有」时恒是 null(折痕那一档就是),整段采不到样本 —— 那是门自己的
             * 跑道红,不是产品。人往上滚时这一块只许一路往下走,不许往回弹。
             */
            const seq = releaseFrames.filter((f) => f.phase === 'release-up' && f.target !== null)
            let worst = 0
            for (let i = 1; i < seq.length; i += 1) worst = Math.min(worst, seq[i].target - seq[i - 1].target)
            return { n: seq.length, worstPx: Number(Math.abs(worst).toFixed(2)) }
          })(),
        }
        console.log(`     收起后垫块 ${padAfterCollapse}px · 上滚三段 `
          + ladder.map((l) => (l ? `${l.padH}px` : '—')).join(' → ')
          + ` · 屏上最大回弹 ${readings.release.upBounce.worstPx}px`)
        console.log(`     滚到底:垫块 ${bottomGap?.padH}px / 一屏 ${bottomGap?.ch}`
          + ` · 发送之后 ${readings.release.padAfterSend}px`)
      }
    }

    /* ══ 判 ══════════════════════════════════════════════════════════════ */
    console.log('\n[fold-collapse] 判据')
    for (const tg of targets) {
      for (const where of ['bottom', 'scrolledUp']) {
        const key = `${tg.id}:${where}`
        const m = readings[tg.id][where]
        const c2 = m.collapse
        assert(c2.n >= 5, `${key} 取到样本 ${c2.n} 帧 ≥ 5`)
        assert(c2.shrinkPx !== null && c2.shrinkPx > 0,
          `${key} 这一下真的缩了(${c2.shrinkPx}px,此刻离底 ${c2.gapBefore}px)`)
        /*
         * ① **落点判在 `scrollTop` 上,不判在顶边上** —— 顶边那一格会被滚动范围夹住:
         * 短会话里那一块上面拢共才两三百像素,`scrollTop` 收到 0 就到头了,那一行
         * 只能停在它的自然位置(实测 295px),再往上没有东西可滚。所以判据是
         * 「视口去到落点说的那个位置,**能去多远去多远**」:
         *   `期望 scrollTop = max(0, 收起前的 scrollTop − (落点 − 收起前的顶边))`
         * 顶边那一格照旧打出来,只是它是**后果**不是判据。
         */
        assert(c2.landedStOffPx !== null && c2.landedStOffPx <= BUDGET.shiftPx,
          `${key} ① 落点:scrollTop 停在 ${c2.finalSt}px,该去 ${c2.expectedSt}px,`
          + `差 ${c2.landedStOffPx}px ≤ ${BUDGET.shiftPx}`
          + `(顶边 ${c2.finalTop}px / 落点 ${c2.landing}px`
          + `${c2.expectedSt === 0 ? ',已滚到顶、再上去没有东西可滚' : ''};`
          + `${c2.movedToTop ? '顶边原在视口上方 → 往视口上缘挪' : '顶边原在视口里 → 一像素不动'})`)
        if (c2.movedToTop) {
          console.log(`  – ${key} ② 收起:落点把它挪回视口上缘,「它上方」整段出了屏,这一格跳过`)
        } else if (c2.above.maxPx === null) {
          console.log(`  – ${key} ② 收起:视口里它上面什么都没有,这一格跳过`)
        } else {
          assert(c2.above.maxPx <= BUDGET.shiftPx,
            `${key} ② 收起:它上方那一块位移 ${c2.above.maxPx}px ≤ ${BUDGET.shiftPx}`)
        }
        /*
         * ③ G1 在**有了落点之后**的精确形:页面总高全程不许矮到「托不住落点那个
         * `scrollTop`」—— `scrollHeight ≥ scrollTop + clientHeight` 就是「不会被钳」
         * 本身。从前那条「只缩进离底那一截里」是没有落点时的写法,落点会把
         * `scrollTop` 往回收,页面本来就该跟着缩同样多。
         */
        assert(c2.lowestSh !== null && c2.finalSt !== null
          && c2.lowestSh >= c2.finalSt + c2.clientHeight - 1,
          `${key} ③ 列的总高全程托得住落点(最低 ${c2.lowestSh}px`
          + ` ≥ 落位 ${c2.finalSt} + 一屏 ${c2.clientHeight} − 1)`)
        assert(c2.padMaxPx <= c2.clientHeight + 0.5,
          `${key} ④ 垫块峰值 ${c2.padMaxPx}px ≤ 一屏 ${c2.clientHeight}px`)
        assert(c2.worstBouncePx <= BUDGET.shiftPx,
          `${key} ⑦ 过渡全程单调靠近落点,最大回弹 ${c2.worstBouncePx}px ≤ ${BUDGET.shiftPx}`)
        if (c2.followGapPx === null) {
          console.log(`  – ${key} ⑦ 它后面在这一层里没有兄弟(它就是那一行的末件),这一格跳过`)
        } else {
          assert(Math.abs(c2.followGapPx) <= BUDGET.followGapPx,
            `${key} ⑦ 它后面第一块内容紧跟其下(缝 ${c2.followGapPx}px ≤ ${BUDGET.followGapPx})`)
        }
        assert(c2.visibleContentPx !== null && c2.visibleContentPx > 0,
          `${key} ⑦ 屏上没有变成整屏空白(视口内可见内容 ${c2.visibleContentPx}px > 0)`)
        assert(m.expand.target.maxPx !== null && m.expand.target.maxPx <= BUDGET.shiftPx,
          `${key} ⑤ 展开:被点那一块顶边位移 ${m.expand.target.maxPx}px ≤ ${BUDGET.shiftPx}`)
        assert(m.expand.stSpanPx !== null && m.expand.stSpanPx <= BUDGET.shiftPx,
          `${key} ⑤ 展开:期间 scrollTop 位移 ${m.expand.stSpanPx}px ≤ ${BUDGET.shiftPx}(点开不贴底)`)
      }
    }
    if (readings.release) {
      const r = readings.release
      assert(r.padAfterCollapse > 0, `⑥ 收起之后垫块真的垫上了(${r.padAfterCollapse}px)`)
      const shrinking = r.ladder.every((l, i) => l && (i === 0 || l.padH <= r.ladder[i - 1].padH + 0.5))
      assert(shrinking, `⑥ 人往上滚,垫块只减不增(${r.ladder.map((l) => l?.padH).join(' → ')})`)
      assert(r.upBounce.n > 5 && r.upBounce.worstPx <= BUDGET.shiftPx,
        `⑥ 上滚那一段屏上不往回弹(最大回弹 ${r.upBounce.worstPx}px ≤ ${BUDGET.shiftPx},`
        + `${r.upBounce.n} 帧)`)
      assert(r.bottomGap && r.bottomGap.padH <= r.bottomGap.ch + 0.5,
        `⑥ 滚到底:空白 ${r.bottomGap?.padH}px ≤ 一屏 ${r.bottomGap?.ch}px`)
      assert(r.padAfterSend !== null && r.padAfterSend <= BUDGET.padAfterSendPx,
        `⑥ 再发一轮之后垫块归零(${r.padAfterSend}px ≤ ${BUDGET.padAfterSendPx}）`)
    }

    console.log(`\n[fold-collapse] ${failures.length === 0 ? '全绿' : `${failures.length} 条红`}`)
    if (failures.length > 0) {
      for (const f of failures) console.log(`  · ${f}`)
      process.exitCode = 1
    }
    writeFileSync(path.join(tmpdir(), `fold-collapse-${LANE}${MOTION_NONE ? '-none' : ''}.json`),
      JSON.stringify(readings, null, 2))
    console.log(`  读数留在 ${path.join(tmpdir(), `fold-collapse-${LANE}${MOTION_NONE ? '-none' : ''}.json`)}`)
  } finally {
    /* 收尸:自己起的一个不留。 */
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
  console.error('[fold-collapse]', error)
  process.exit(1)
})
