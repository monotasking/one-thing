#!/usr/bin/env node
/**
 * **一条座位**的真机门 —— 单 A 那三格(正本 `apps/desktop-react/docs/send-flow-2026-09.md` §6)。
 *
 * jsdom 那一半量的是「判据写了什么」(`content/__tests__/seat.test.ts` 的四支、
 * `send-seat.test.tsx` 的寿命与写点、`context-delta-seam.test.tsx` 的一轮一道折痕)。
 * 这道门量的是**真的排版之后**那几件只有浏览器说得出来的事,逐帧采样:
 *
 *  ① **发送只滚一次** —— 按下发送到座位长满(或这一轮收场)为止,`scrollTop`
 *     只走过**一段**。判据数的是**滚动段**不是像素:落到置顶线那一下本身是一段
 *     逐帧插值(十几次赋值,肉眼是一次滑动),而「座位漏了」的表现是**另起一段**
 *     ——每来一段 delta 贴一次底。去掉座位垫块这一条当场红(反证见文件末)。
 *  ② **等待 → 首字,自己那条气泡一像素不动**:空折痕的卸载与第一块内容的挂载
 *     是同一次提交,所以上面那条气泡的 top 不该动。
 *  ③ **读数行与折痕 / 思考段从不相交**:它们是流里前后排的两行,不是叠起来的
 *     两层。把等待折痕改回绝对定位,这一条当场红。
 *  ④ **读数行 400ms 内不许先上后下**(抖):一次方向反转都不许有。
 *  ⑤ **流式期间零 ≥50ms 长帧**(第 5 轴那一格换个主语)。
 *
 * **超量**(第 5 轴第三条铁律):400 条消息的真店规模账本之上,发一条引出
 * **20 万字思考**的话 —— ①②③ 同样成立,读数一并报出来。
 *
 * ── 两档各出数 ────────────────────────────────────────────────────────────
 * 缺省跑 **dev**(现起一台 vite,端口另挑,绝不碰用户的 5175),`--prod` 跑
 * `dist/` 产物。用户跑的是 `electron:dev`,prod 上量出的数对它不成立
 * (09-10 判例)。两档的读数都要进报告。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * **窗子走屏外档**(`ONETHING_GATE_OFFSCREEN=1`):这道门每一条判据都与**页面的
 * 时间**有关(长帧、400ms 窗口、逐帧位移),而老那一档 `ONETHING_GATE_HEADLESS`
 * 下 Chromium 把整扇窗节流到 1Hz —— 量的会是节流器不是产品(判例写在壳 CLAUDE.md
 * 的「离屏两档」)。屏外档同样不上前台、不动真光标。所有输入都经 `page.evaluate`;
 * store 与 `--user-data-dir` 都是临时目录,跑完删干净,**绝不连 `~/.onething`**。
 *
 * 跑法:`npm run gate:send-flow` / `npm run gate:send-flow -- --prod`
 * (仓根先 `bun run server:build`;两档都要先 `npm run electron:build`,
 *  `--prod` 还要 `npm run app:build`。)
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

const PROD = process.argv.includes('--prod') || process.env.ONETHING_GATE_DIST === '1'
const LANE = PROD ? 'prod' : 'dev'
/** dev 档的 vite 端口。**不是 5175** —— 那是用户自己的 `app:dev` 占着的口。 */
const DEV_PORT = Number(process.env.ONETHING_GATE_VITE_PORT ?? 5196)

/* ── 预算(正本 §6 那张表)────────────────────────────────────────────────
 * 它们是**上限**不是目标。`TRANSITIONAL` 是**空的** —— 今天没有一格达不到,
 * 空着比填一行宽的数诚实(体例与 `gate-terminal` 的那一格逐字同源)。 */
const BUDGET = {
  /** ① 发送后到座位长满为止,`scrollTop` 走过几段。 */
  scrollRuns: 1,
  /** ② 等待 → 首字,自己那条气泡的 top 位移(px)。 */
  firstTokenShiftPx: 1,
  /** ③ 读数行与折痕 / 思考段相交的帧。 */
  overlapFrames: 0,
  /** ④ 读数行 400ms 内的方向反转。 */
  readoutFlips: 0,
  /** ⑤ 流式期间 ≥ 这么长的帧,一个都不许有。 */
  longFrameMs: 50,
  longFrames: 0,
  /** ⑥ 座位归零前后 300ms 内的方向反转(打回一那条抖)。 */
  seatZeroFlips: 0,
}

/** 会话名与两份夹具。 */
const SESSION_MAIN = '座位门 · 常态'
const SESSION_BIG = '座位门 · 超量(400 条 + 20 万字思考)'
/** 常态那一条的起底:够长,不长过一屏就没有「底」可言。 */
const SEED_FIXTURE = {
  messages: 12,
  toolCallsPerTurn: [1, 1],
  targetBytes: 0,
  targetToolCalls: 0,
  largeResults: 0,
  images: 0,
}
/** 超量那一条:真店规模夹具的缺省档(≥50MB / 400 条 / 900 张卡)。 */
const BIG_FIXTURE = {}

/* ── 假 provider 的记号(与 gate-perf 同一手:请求里带哪个记号决定答什么)──── */
const MARK_NORMAL = '@@seat-normal@@'
const MARK_LONG = '@@seat-long@@'
const MARK_THOUGHT = '@@seat-thought@@'
/** 第一个字之前静默多久 —— 等待折痕要活得够久,逐帧采样才录得到它。 */
const FIRST_BYTE_DELAY_MS = 900
/** 正文切成几段、每段之间隔多久。段间隔要明显大过一帧,滚动段才分得开。 */
const REPLY_PIECES = 12
const REPLY_GAP_MS = 120
/** 长回那一支切得更细:座位要**一截一截**被吃掉,归零那一刻才采得准。 */
const LONG_REPLY_PIECES = 30
const THOUGHT_CHARS = 200_000
/** 思考开头走慢档的段数与段间隔(判词在吐思考那一段循环里)。 */
const THOUGHT_RAMP_PARTS = 24
const THOUGHT_RAMP_GAP_MS = 60

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 造一段与真数据同形的思考(抄 `gate-perf.mjs` 的 `buildThought`:成段、段内不带
 * 换行、每段 300–900 字、`\n\n` 分段、中英混排;线性同余而不是 `Math.random()`,
 * 同一份夹具每趟逐字相同,两趟读数才可比)。
 */
function buildThought(totalChars, seed) {
  let x = seed >>> 0
  const rnd = () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 4294967296
  }
  const zh = '这一段是座位门造出来的思考正文它要和真数据同形所以成段而且段内不带换行'
  const en = ' alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu '
  const paragraphs = []
  let total = 0
  let cursor = 0
  while (total < totalChars) {
    const width = 300 + Math.floor(rnd() * 601)
    let para = ''
    while (para.length < width) {
      para += rnd() < 0.6 ? zh.slice(cursor % zh.length) : en
      cursor += 7
    }
    paragraphs.push(para)
    total += para.length + 2
  }
  return paragraphs.join('\n\n')
}

const THOUGHT = buildThought(THOUGHT_CHARS, 20260915)
const REPLY_TEXT =
  '座位门 · 假 provider 的流式回答:它要够长,好切成十几段真的流一遍,'
  + '让每一段都逼出一次提交、一次排版 —— 座位漏了的话,每一段都会自己贴一次底,'
  + '滚动段数于是从一段变成十几段,那正是这道门要抓的东西。'

/**
 * **长回那一支**:一段**足够把座位吃满**的正文(座位实测 518px,一行约 22px,
 * 所以要二十几行)。
 *
 * 它测的是短回那一支测不到的那一刻 —— **座位归零那一帧**:座位是「量在这一帧、
 * 写在下一帧」的,归零那一帧垫块上还挂着残高,照旧贴底就会多滚那一截、下一帧又被
 * 钳回来(先下后上,一帧可见的抖)。短回那一支座位一直没长满(518 → 324),
 * 这一刻根本不发生;超量那一支发生,但那一帧长达一秒多、采不到样。所以要这一支:
 * 小会话 + 慢慢流 + 真的把座位喂满,归零前后各采到几十帧。
 */
const LONG_REPLY_TEXT = Array.from(
  { length: 26 },
  (_, i) => `第 ${i + 1} 行:这一段正文存在的唯一理由,是把那 518px 的座位一行一行吃满,`
    + '好让门采到「座位归零」那一帧前后各几十帧 —— 抖没抖,只有那几帧说得出来。',
).join('\n\n')

/**
 * 一台记号驱动的假 provider(OpenAI 兼容 SSE)。
 *
 * **不带记号的请求两帧收尾** —— 自动起名那一发走这一支,它不该在任何一个采样窗口
 * 里吐东西(与 `gate-perf` 的同名判词逐字同源)。
 */
function startProvider(state) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* 形状不对就走兜底那一支 */ }
      /*
       * ── 记号只认**最后那一条**(09-15 实测挖出来的)────────────────────────
       * 超量那一条是 50MB 的真店规模账本,一发过去 core 先跑一轮**上下文压缩**
       * ——而压缩那一发把整份历史拼进请求,于是它也命中记号:20 万字思考被吐进了
       * 压缩那一轮,`thoughtServed` 当场翻 true,**真正要量的那一轮反倒拿到空回答**
       * (探针上的样子是:`streaming` 整段为 0、等待帧只有 2、`scrollTop` 却跳了
       * 10 万像素)。判据因此收窄到「**最后一条**里带记号」——真正的那一轮,最后
       * 一条就是人刚发的那句话;压缩那一发的最后一条是压缩指令,不带记号。
       */
      const msgs = Array.isArray(payload.messages) ? payload.messages : []
      const textOf = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''))
      const flat = textOf(msgs[msgs.length - 1])
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
        id: 'chatcmpl-seat',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const normal = flat.includes(MARK_NORMAL)
      const long = flat.includes(MARK_LONG)
      const thought = flat.includes(MARK_THOUGHT)
      /*
       * **量的那一条只服务一次**:自动起名那一发会把整份历史拼进请求,同一个记号
       * 于是会再命中一次;不拦的话 20 万字会被再吐一遍,而那一遍落在窗口之外。
       */
      const first = (normal && !state.normalServed)
        || (long && !state.longServed)
        || (thought && !state.thoughtServed)
      if (normal) state.normalServed = true
      if (long) state.longServed = true
      if (thought) state.thoughtServed = true
      if ((!normal && !long && !thought) || !first) {
        send(frame({}, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      // 第一个字之前的静默 —— 等待折痕就活在这一段里。
      await delay(FIRST_BYTE_DELAY_MS)
      if (res.destroyed) return
      if (thought) {
        /*
         * 节拍是判据的一部分:16ms 一帧、每帧 60–120 字 —— 与 `SessionStreamCoalescer`
         * 的 16ms 合批同拍,渲染层每一帧真的收到一批新字(抄 gate-perf 场景⑥)。
         */
        let cursor = 0
        let parts = 0
        while (cursor < THOUGHT.length) {
          if (res.destroyed) return
          const size = 60 + Math.floor(Math.random() * 61)
          send(frame({ reasoning_content: THOUGHT.slice(cursor, cursor + size) }))
          cursor += size
          parts += 1
          /*
           * **开头那几段走慢档**(`THOUGHT_RAMP_PARTS` × `THOUGHT_RAMP_GAP_MS`)。
           *
           * 这不是给门放水,是让门**看得见它要量的那一段**:16ms 满速下,400 条的
           * 会话上主线程被压缩 + 扩窗 + 首屏排版占满好几秒,探针在「首字到达」前后
           * 一帧都采不到 —— 实测最后一帧还在等、下一帧已经是 1187px 之后,②「换手那
           * 一下气泡不动」于是无从量起(量到的是座位早被吃光之后的跟底)。
           * 慢档只铺开头 ~1.4s / 约 2000 字,**远小于座位那 461px**,所以量的仍是
           * 「内容长进座位、视口不动」那一段本身;之后整段满速,20 万字一个字不少。
           * 同一条理由与 `FIRST_BYTE_DELAY_MS` 一样:短命的读数必须在它活着的时候取。
           */
          await delay(parts <= THOUGHT_RAMP_PARTS ? THOUGHT_RAMP_GAP_MS : 16)
        }
        send(frame({ content: '思考结束,下面是结论。' }))
      } else {
        const text = long ? LONG_REPLY_TEXT : REPLY_TEXT
        const pieces = long ? LONG_REPLY_PIECES : REPLY_PIECES
        const size = Math.max(1, Math.ceil(text.length / pieces))
        for (let at = 0; at < text.length; at += size) {
          if (res.destroyed) return
          send(frame({ content: text.slice(at, at + size) }))
          await delay(REPLY_GAP_MS)
        }
      }
      if (!res.destroyed) {
        send(frame({}, 'stop'))
        res.write('data: [DONE]\n\n')
      }
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/* ── 起 core / 读发现文件(与 gate-chat-follow 同一手)────────────────────── */

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8'))
  } catch {
    return undefined
  }
}

function portConnects(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const settle = (value) => { socket.destroy(); resolve(value) }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(120)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

/**
 * **「屏上那一片会话叶」** —— 这道门每一句查询的根。
 *
 * 装成页面里的一个全局而不是各处抄一遍:`page.evaluate(fn)` 把函数**序列化**送进
 * 浏览器,node 这一侧的闭包一个都带不过去,所以「共用一份」只能是「装一次、
 * 大家都调那一个」(与 `scripts/lib/composer-dock.mjs` 同一条判词)。
 *
 * 判据是**这一格里既有消息流又有输入框**:会话叶就是这么一格(输入框属于会话叶,
 * W5-c)。光问 `[data-pane-on]` 不够 —— 架子上的会话总览也是一格 `on` 的层,而且
 * 在文档序里排在前面(第一版在这儿栽了第二次:话打不进去,因为拿到的是总览那一格)。
 * 停靠池里那几片答的是 `data-pane-kept`、没有 `data-pane-on`,所以自然被排除在外
 * ——那正是第一版栽的第一次(超量那一趟量了上一条会话)。
 */
const LIVE_LEAF_PROBE = `
window.__seatLeaf = function () {
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

const failures = []
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`)
  else {
    console.log(`  ✗ ${message}`)
    failures.push(message)
  }
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
  if (!body || body.ok !== true) {
    throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  }
  return body.data
}

async function clickTestId(page, testId) {
  const clicked = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testId)
  if (!clicked) throw new Error(`点不到:[data-testid="${testId}"] 不在 DOM 里`)
}

/**
 * **逐帧采样**(做法照 `scratchpad/verify-send-flow.mjs` 那只种子探针:每帧
 * `getBoundingClientRect`,判据全在事后的那一遍算里)。
 *
 * 一次 rAF 取完这一帧要的全部矩形 —— 分几次取就不是同一个瞬间的同一份布局了,
 * 而这道门比的正是「同一瞬间这几个矩形的相对位置」。
 */
async function startSampler(page) {
  await page.evaluate(() => {
    window.__seatFrames = []
    window.__seatStop = false
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, height: r.height }
    }
    const overlap = (a, b) => (a && b ? Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) : 0)
    /*
     * **每帧的活儿必须是 O(1)**(09-10 判例「探针自伤」:量长帧的探针自己制造长帧)。
     * 400 条消息的树上,一次 `scroll.querySelector('[data-testid="chat-readout"]')`
     * 是一次整树前序遍历 —— 一帧几次就够把这道门自己量的那格数字毁掉。
     * 所以每帧只从**列尾那两三格**往回找:这一轮就住在那儿。
     */
    /*
     * **屏上那一片,不是第一片**(第一版在这儿栽了一次):会话连续性把切走的会话
     * **留在停靠池里挂着**(LRU 8,`docs/session-continuity-2026-09.md`),所以
     * `document.querySelector('[data-testid="chat-stream"]')` 拿到的多半是上一条
     * 会话那一片 —— 超量那一趟于是量了个空,`waitingFrames` 是 0、滚动段落在
     * 上一条会话的坐标上(7523,与常态那一趟的终点逐字相同,那正是露馅的地方)。
     * 判据取宿主自述的「此刻在屏上的那一格」。
     */
    const liveStream = () => window.__seatLeaf().querySelector('[data-testid="chat-stream"]')
    const tick = (t) => {
      if (window.__seatStop) return
      const scroll = liveStream()
      const column = scroll?.firstElementChild
      if (scroll && column) {
        const kids = column.children
        let live = null // 这一轮的助手那一行(列尾,座位垫块之后往回数)
        let user = null // 这一轮自己那条气泡
        let ctxRow = null // 这一轮那道上下文更新折痕所在的行
        for (let i = kids.length - 1; i >= 0 && i >= kids.length - 6; i -= 1) {
          const el = kids[i]
          if (el.hasAttribute('data-seat')) continue
          if (!ctxRow && el.hasAttribute('data-context-of')) ctxRow = el
          if (!user && el.getAttribute('data-role') === 'user') user = el
          if (!live && el.hasAttribute('data-message-id') && el.getAttribute('data-role') !== 'user') live = el
        }
        const readout = rect(live?.querySelector('[data-testid="chat-readout"]') ?? null)
        const waiting = live?.querySelector('[data-testid="waiting-seam"]') ?? null
        /*
         * 上下文更新折痕住在**用户那一行与助手那一行之间**的独立一行上 —— 要的是
         * **这一轮那一道**,所以同样从列尾往回找(上面那个循环顺手收下 `ctxRow`)。
         * 第一版在这儿栽了第四次:写的是 `column.querySelector(…)`,在 400 条的会话上
         * 拿到的是**最老**那一道(早已 settled),于是超量那一趟的等待帧恒为 0 ——
         * 折痕明明在扫,探针看的是另一道。
         */
        const seam = ctxRow?.querySelector('[data-testid="context-delta-seam"]') ?? null
        const seamRunning = seam?.getAttribute('data-state') === 'running'
        const thought = rect(live?.querySelector('[data-testid="chat-thought"]') ?? null)
        const seat = kids[kids.length - 1]?.hasAttribute('data-seat') ? kids[kids.length - 1] : null
        window.__seatFrames.push({
          t,
          st: scroll.scrollTop,
          sh: scroll.scrollHeight,
          user: rect(user),
          readout,
          /*
           * 「这一轮在等第一个字」—— **两种形都算**:没有上下文更新行时是那道空折痕
           * (`waiting-seam`),有的时候是上下文更新折痕自己在扫(`data-state="running"`)。
           * 一轮只扫一道,这正是规矩 ③「合成一行」在探针这一侧的样子。
           */
          waiting: Boolean(waiting) || Boolean(seamRunning),
          // ③ 读数行与折痕 / 思考段相交了多少(它们是前后排的两行,该恒为 0)
          overlap: Math.max(
            overlap(readout, rect(waiting)),
            overlap(readout, rect(seam)),
            overlap(readout, thought),
          ),
          seat: seat ? seat.getBoundingClientRect().height : null,
          streaming: Boolean(live?.querySelector('[data-testid="chat-stop"]')),
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopSampler(page) {
  return page.evaluate(() => {
    window.__seatStop = true
    return window.__seatFrames ?? []
  })
}

/**
 * 事后算那一遍。
 *
 * ── 两个窗口,各答各的 ────────────────────────────────────────────────────
 * **座位窗**:按下发送 → 座位缩到 0(或这一轮收场)。①②⑤ 说的都是这一段 ——
 * 正本 §6 那张表第一行写的就是「发送后**到座位长满**为止」。第一版拿整轮去数,
 * 于是超量那一趟报了 120 段滚动 —— 那 119 段是**座位归 0 之后照旧 pinned 跟底**
 * (§5 表 1 的最后一格):20 万字思考是座位的 100 倍,它必然长满,长满之后跟底
 * 正是设计要的行为。拿它当红是把设计当回归。
 *
 * **整轮**:③④ 说的是排版关系(读数行与折痕从不相交、读数行不抖),一整轮都成立;
 * 长帧整轮也报一份 —— 超量那一趟**收尾那一帧思考自动折叠**今天仍是跳变
 * (正本 §0 三处病之二,实测一帧 1358ms、`scrollTop` 从 165292 掉回 114487),
 * 那是**单 B ④**(收尾锚定折叠)要治的东西,单 A 一个字不碰,所以那一格只报数
 * 不判红,理由写在断言那一行上。
 *
 * ── 一段滚动的定义 ────────────────────────────────────────────────────────
 * 一段 = 一串**连续在变**的帧,中间静过 `QUIET` 帧就算断开,而且**至少走够 1px**。
 * 落到置顶线那一下是逐帧插值(缓出的末几帧可能连着几帧一动不动),所以静默门槛取
 * 得比它宽;座位缩一截与内容长一截差**一帧**(量在观察器里、写在下一帧),那一帧
 * 里浏览器按新的 `scrollHeight` 把 `scrollTop` 亚像素地钳一下 —— 实测 0.6px,
 * 肉眼与产品语义上都不是一次滚动,另记一格报出来。同一条判词在检索面那条分页
 * 不变量上写过:**反证要数滚动指令的次数,不是量 `scrollTop`**。
 */
const QUIET = 4
const RUN_MIN_PX = 1

/** 一段窗口里的读数。窗口由调用方切,这只函数只负责算。 */
function measure(frames) {
  const all = []
  let still = QUIET
  for (let i = 1; i < frames.length; i += 1) {
    const moved = Math.abs(frames[i].st - frames[i - 1].st) > 0.5
    if (moved) {
      if (still >= QUIET) {
        all.push({ from: frames[i - 1].st, to: frames[i].st, at: i - 1, until: i })
      } else {
        all[all.length - 1].to = frames[i].st
        all[all.length - 1].until = i
      }
      still = 0
    } else still += 1
  }
  /**
   * **一段滚动 = 屏幕真的动了**。
   *
   * 两道筛子,各挡一种「`scrollTop` 变了但人看不出来」:
   *  ① **走够 1px** —— 座位缩一截与内容长一截差**一帧**,那一帧里浏览器按新的
   *     `scrollHeight` 把 `scrollTop` 亚像素地钳一下(实测 0.6px);
   *  ② **屏上那条气泡也得跟着动** —— 往前**扩窗**是一次 prepend:上面凭空长出一截,
   *     `ChatStream` 那第三处写点当场把 `scrollTop` 绝对补回去(`captured.top + delta`),
   *     于是坐标系整个平移、而**画面一像素没动**。超量那一趟实测一次 10.2 万像素的
   *     「滚动」正是它(400 条的窗口在空闲里补齐),把它算成一次滚动就是拿坐标系
   *     当画面。规矩 ① 说的是「不切屏」——判据因此落在**看得见的那个位置**上。
   *
   * 同一条判词在检索面那条分页不变量上写过:**反证要数滚动指令的次数,不是量
   * `scrollTop`** —— 这里再进一步:数的是**屏幕动过几次**。
   */
  const screenMoved = (r) => {
    const a = frames[r.at]?.user?.top
    const b = frames[r.until]?.user?.top
    if (a === undefined || a === null || b === undefined || b === null) return true
    return Math.abs(b - a) >= RUN_MIN_PX
  }
  const runs = all.filter((r) => Math.abs(r.to - r.from) >= RUN_MIN_PX && screenMoved(r))
  /*
   * ② 等待 → 首字:**换手那一下**气泡动没动。
   *
   * 窗口是「在扫的那一道最后一帧」起的 `HANDOFF_MS` —— 正本 §6 那一行说的就是
   * 这一下(空折痕的卸载与第一块内容的挂载是同一次提交,所以上面那条气泡不该动),
   * 不是「整轮都不动」。250ms ≈ 15 帧,够盖住换手那一次提交与它后面几帧的重排。
   *
   * 整段窗口里气泡一共漂了多少另记一格(`drift`)。今天它不是 0(常态实测 12px,
   * 见交卷报告的留账),而那是**浏览器自己的滚动锚定**在座位缩一截、内容长一截
   * 差的那一帧里做的补偿 —— 它不属于换手这件事,所以只报不判。
   */
  const HANDOFF_MS = 250
  const lastWaiting = frames.map((f) => f.waiting).lastIndexOf(true)
  let firstTokenShift = 0
  let drift = 0
  let driftFrames = 0
  let settledDrift = 0
  if (lastWaiting >= 0) {
    const base = frames[lastWaiting].user?.top
    const until = frames[lastWaiting].t + HANDOFF_MS
    for (let i = lastWaiting; i < frames.length; i += 1) {
      const top = frames[i].user?.top
      if (base === undefined || base === null || top === undefined || top === null) continue
      const d = Math.abs(top - base)
      drift = Math.max(drift, d)
      if (d >= 1) driftFrames += 1
      /*
       * **停下来之后它在哪** —— 座位还没长满的那一段,气泡该停在置顶线上一动不动。
       * 与 `drift`(整段的最大值)分两格记,是因为它们答的是两个问题:
       * 「最后停在哪」与「中途最远飘到哪」。09-15 trace 实测 12px 那一下是
       * **收尾那一帧**的瞬态(读数行 / 光标卸载让内容缩 12px,座位下一帧补回来),
       * 一帧就回原位;判「停在哪」抓得住真回归,判「最远」会把这一帧算成破口。
       */
      settledDrift = d
      if (frames[i].t <= until) firstTokenShift = Math.max(firstTokenShift, d)
    }
  }
  let longFrames = 0
  let longest = 0
  for (let i = 1; i < frames.length; i += 1) {
    if (!frames[i].streaming) continue
    const gap = frames[i].t - frames[i - 1].t
    longest = Math.max(longest, gap)
    if (gap > BUDGET.longFrameMs) longFrames += 1
  }
  return {
    frames: frames.length,
    scrollRuns: runs.length,
    /* 只留头 6 段:超量那一趟有两百段,整串打出来会把报告淹掉(段数才是判据)。 */
    runs: runs.slice(0, 6).map((r) => `${r.from.toFixed(0)}→${r.to.toFixed(0)}`),
    microRuns: all.length - runs.length,
    firstTokenShift,
    drift,
    driftFrames,
    settledDrift,
    waitingFrames: frames.filter((f) => f.waiting).length,
    longFrames,
    longestFrameMs: Math.round(longest),
  }
}

function analyze(frames) {
  /*
   * ── 窗口由**等待那一段**切,不由座位垫块那个高度切 ────────────────────────
   *
   * 第一版按「座位缩到 0」切,在超量那一趟上切错了:座位的高是 RO **量在这一帧、
   * 写在下一帧**的(观察器只读不写),而 20 万字思考的第一屏在 400 条的会话上
   * 渲了 **2.4 秒**——那一帧里 `readSeat` 早就算出 0、跟底也已经发生,DOM 上那个
   * `height` 却还停在 461,探针于是把「长满之后的跟底」收进了座位窗。
   *
   * 所以窗口改由**屏幕自己说得出来的那件事**切:**在扫的那一道还在**就还没到首字。
   *   · 落位窗 = 按下发送 → 在扫的那一道最后一帧 —— 规矩 ① 那句「发送只滚一次,
   *     不切屏」说的正是这一段;
   *   · 整轮 = ③④ 那两条排版关系(一整轮都要成立),外加一份整轮长帧读数。
   * 座位管不管用看另一处:常态整轮只滚一段(座位一直没长满,视口全程不动),
   * 超量整轮上百段(20 万字思考是座位的 100 倍,必然长满,长满之后照旧 pinned
   * 跟底 —— §5 表 1 最后一格)。两句都是设计,所以一句判、一句报。
   */
  const lastWaiting = frames.map((f) => f.waiting).lastIndexOf(true)
  const landing = measure(frames.slice(0, lastWaiting >= 0 ? lastWaiting + 1 : frames.length))
  const whole = measure(frames)
  // ④ 读数行 400ms 内先上后下(判据抄种子探针的 `flips`)—— 整轮都要成立。
  let lastDir = 0
  let lastT = 0
  let flips = 0
  const flipSamples = []
  for (let i = 1; i < frames.length; i += 1) {
    const a = frames[i - 1].readout?.top
    const b = frames[i].readout?.top
    if (a === undefined || b === undefined || a === null || b === null) continue
    const d = b - a
    if (Math.abs(d) < 2) continue
    const dir = Math.sign(d)
    if (lastDir && dir !== lastDir && frames[i].t - lastT < 400) {
      flips += 1
      if (flipSamples.length < 5) {
        flipSamples.push(`${(frames[i].t / 1000).toFixed(2)}s ${a.toFixed(0)}→${b.toFixed(0)}`)
      }
    }
    lastDir = dir
    lastT = frames[i].t
  }
  /*
   * ── ⑥ 座位**归零那一帧**不许弹(2026-09-15 打回一)──────────────────────
   * 座位是「量在这一帧、写在下一帧」的。归零那一帧垫块上还挂着残高,照旧贴底就会
   * 多滚那一截、下一帧 `scrollHeight` 变小又被浏览器钳回来 —— **先下后上**,一帧
   * 可见的抖,量级 = 最后一次长高的 Δ。判据因此不是「位移多少」(那一下本来就有
   * 合法位移:座位满了就该跟底),是**方向反转**:真正跟底是单向的。
   * 窗口取归零那一帧前后各 `ZERO_WINDOW_MS`,两条线各判一次(气泡与读数行),取大。
   */
  const ZERO_WINDOW_MS = 300
  let seatZeroAt = -1
  let sawSeat = false
  for (let i = 0; i < frames.length; i += 1) {
    if (typeof frames[i].seat !== 'number') continue
    if (frames[i].seat > 0) sawSeat = true
    else if (sawSeat) {
      seatZeroAt = i
      break
    }
  }
  let seatZeroFlips = 0
  const seatZeroSamples = []
  if (seatZeroAt >= 0) {
    const at = frames[seatZeroAt].t
    const window = frames.filter((f) => Math.abs(f.t - at) <= ZERO_WINDOW_MS)
    /*
     * **判的是视口,不是读数行**(09-15 真机 trace 纠正的一处量法)。
     * 读数行跟着正文下缘走:座位长满那一下「内容往下长 → 页面跟底 → 它相对视口
     * 往上回」本来就是一去一回,拿它当判据会把**设计**读成抖。会说谎的是这条线,
     * 不是产品。真正不许来回的是**视口**:`scrollTop`(以及它的另一种说法 ——
     * 自己那条气泡在屏幕上的位置)。实测 trace:归零前后 `st` 7770.5 → 7848.5 →
     * 7903 单调,`user` 68 → −10 → −64.5 单调,而读数行 606.8 → 661.4 → 615.6。
     */
    for (const key of ['user', 'st']) {
      let dir = 0
      let n = 0
      for (let i = 1; i < window.length; i += 1) {
        const a = key === 'st' ? window[i - 1].st : window[i - 1].user?.top
        const b = key === 'st' ? window[i].st : window[i].user?.top
        if (a === undefined || a === null || b === undefined || b === null) continue
        const d = b - a
        if (Math.abs(d) < 2) continue
        const next = Math.sign(d)
        if (dir && next !== dir) {
          n += 1
          if (seatZeroSamples.length < 4) {
            seatZeroSamples.push(`${key} ${(window[i].t / 1000).toFixed(2)}s ${a.toFixed(0)}→${b.toFixed(0)}`)
          }
        }
        dir = next
      }
      seatZeroFlips = Math.max(seatZeroFlips, n)
    }
  }
  const seats = frames.map((f) => f.seat).filter((v) => typeof v === 'number')
  return {
    seatZeroAt,
    seatZeroFlips,
    seatZeroSamples,
    seatZeroFrames: seatZeroAt >= 0
      ? frames.filter((f) => Math.abs(f.t - frames[seatZeroAt].t) <= ZERO_WINDOW_MS).length
      : 0,
    frames: frames.length,
    fps: frames.length > 1
      ? Math.round(frames.length / ((frames[frames.length - 1].t - frames[0].t) / 1000))
      : 0,
    landing,
    whole,
    waitingFrames: frames.filter((f) => f.waiting).length,
    // ② 换手那一下气泡动了多少(窗口在 `measure` 里,判词写在那儿)。
    firstTokenShift: whole.firstTokenShift,
    handoffDrift: whole.drift,
    handoffDriftFrames: whole.driftFrames,
    settledDrift: whole.settledDrift,
    // ③ 读数行与折痕 / 思考段相交的帧(整轮)。
    overlapFrames: frames.filter((f) => f.overlap > 0.5).length,
    overlapMax: Math.max(0, ...frames.map((f) => f.overlap)),
    readoutFlips: flips,
    flipSamples,
    streamFrames: frames.filter((f) => f.streaming).length,
    seatMax: seats.length ? Math.max(...seats) : 0,
    seatMin: seats.length ? Math.min(...seats) : 0,
  }
}

/**
 * 在输入框里「打」一段话再按发送 —— 走真链路(`sentTick` 的产地是 `send()`,
 * 从 RPC 那一头注消息根本不会有座位)。
 *
 * **要点名「屏上那一片」那块输入框**:W5-c 之后输入框属于会话叶,屏幕上可以同时
 * 有好几块(停靠池里那几片也各挂着自己那一块)。`document.querySelector` 拿到的
 * 是第一块 —— 第一版在这儿栽了一次:超量那一趟的话打进了上一条会话的输入框里。
 */
async function sendViaComposer(page, text) {
  const ok = await page.evaluate((value) => {
    const pane = window.__seatLeaf()
    const box = pane.querySelector('[data-testid="composer-input"]')
    const send = pane.querySelector('[data-testid="composer-send"]')
    if (!box || !send) return false
    box.textContent = value
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, text)
  if (!ok) throw new Error('打不进去:屏上那一片里没有 [data-testid="composer-input"]')
  await delay(200)
  const sent = await page.evaluate(() => {
    const send = window.__seatLeaf().querySelector('[data-testid="composer-send"]')
    if (!(send instanceof HTMLElement) || send.hasAttribute('disabled')) return false
    send.click()
    return true
  })
  if (!sent) throw new Error('发送键点不动(不在场或者被闸门禁着)')
}

function report(name, m) {
  console.log(
    `      ${name}:整轮 ${m.frames} 帧 @${m.fps}fps · 座位 ${m.seatMax.toFixed(0)}→${m.seatMin.toFixed(0)}px`
    + ` · 等待帧 ${m.waitingFrames} · 相交帧 ${m.overlapFrames}(最大 ${m.overlapMax.toFixed(1)}px)`
    + ` · 读数行反转 ${m.readoutFlips}`,
  )
  console.log(
    `      ${' '.repeat(name.length)}  落位窗 ${m.landing.frames} 帧:滚动 ${m.landing.scrollRuns} 段`
    + ` ${JSON.stringify(m.landing.runs)}(亚像素 ${m.landing.microRuns} 次)`
    + ` · 换手位移 ${m.firstTokenShift.toFixed(1)}px`
    + `(此后最远 ${m.handoffDrift.toFixed(1)}px / ${m.handoffDriftFrames} 帧,停下来 ${m.settledDrift.toFixed(1)}px)`,
  )
  console.log(
    `      ${' '.repeat(name.length)}  整轮流式 ${m.streamFrames} 帧:滚动 ${m.whole.scrollRuns} 段`
    + ` · >50ms 长帧 ${m.whole.longFrames}(最长 ${m.whole.longestFrameMs}ms)`
    + ` · 座位归零`
    + (m.seatZeroAt >= 0 ? `前后 ${m.seatZeroFrames} 帧反转 ${m.seatZeroFlips}` : '没发生'),
  )
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[send-flow] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry)) {
    console.error('[send-flow] 找不到主进程产物 —— 先跑 `npm run electron:build`')
    process.exit(1)
  }
  if (PROD && !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[send-flow] --prod 档找不到 `dist/index.html` —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'send-flow-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'send-flow-udd-'))
  const providerState = { normalServed: false, longServed: false, thoughtServed: false }
  let provider
  let server
  let app
  let vite
  const readings = { lane: LANE }

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
    }).catch((error) => {
      throw new Error(`${error.message}\nserver stderr:\n${err.join('').slice(-2000)}`)
    })
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
    console.log(`\n[send-flow] 渲染层档位:${LANE}`)
    console.log('\n[1/5] 起假 provider + 一台 core,建两条会话')
    provider = await startProvider(providerState)
    writeFileSync(
      path.join(store, 'settings.json'),
      JSON.stringify(
        {
          ai: (() => {
            const ai = fakeProviderAiSettings(provider.address().port)
            // `reasoning: true` 只改「账本对这个型号有没有话说」那一句(与 gate-perf 同判):
            // 超量那一支的假 provider 吐的是 `delta.reasoning_content`。
            ai.providers.deepseek.modelCapabilitiesByModel['deepseek-chat'].reasoning = true
            return ai
          })(),
          // 工具关掉:这道门量的是发送 / 等待 / 生成那一条链,不是工具循环。
          tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
          diagnostics: { enabled: false },
        },
        null,
        2,
      ),
    )
    let core = await startCore()
    server = core.child
    const idMain = (await rpc(core.record, 'sessions', 'create', { name: SESSION_MAIN }))?.session?.id
    const idBig = (await rpc(core.record, 'sessions', 'create', { name: SESSION_BIG }))?.session?.id
    if (!idMain || !idBig) throw new Error('会话没建出来')

    console.log('[2/5] 停 core,直写两份账本,再把 core 起回来')
    /*
     * **趁 core 停着写账本**:活着的 core 会按字节大小认出「外来写手」并抛
     * `SessionEventWriteError`;停一次再起 = 冷读一遍,那道闸压根不碰
     * (判词与 `gate-chat-follow` 的同一段逐字同源)。
     */
    await stopCore(server)
    const seeded = {
      main: seedLargeLedger(store, idMain, SEED_FIXTURE),
      big: seedLargeLedger(store, idBig, BIG_FIXTURE),
    }
    readings.fixture = { main: seeded.main.messages, big: seeded.big.messages }
    console.log(
      `      常态 ${(seeded.main.bytes / 1024).toFixed(0)}KB / ${seeded.main.messages} 条;`
      + ` 超量 ${(seeded.big.bytes / 1024 / 1024).toFixed(1)}MB / ${seeded.big.messages} 条 /`
      + ` ${seeded.big.toolCalls} 张卡`,
    )
    core = await startCore()
    server = core.child

    let rendererUrl = ''
    if (!PROD) {
      console.log(`[3/5] 起 vite dev(端口 ${DEV_PORT},**不是用户的 5175**)`)
      const { createServer } = await import('vite')
      vite = await createServer({
        configFile: path.join(appRoot, 'vite.config.ts'),
        server: { port: DEV_PORT, strictPort: true },
        logLevel: 'warn',
      })
      await vite.listen()
      rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`
    } else {
      console.log('[3/5] prod 档:直接吃 `dist/` 产物,不起 vite')
    }

    console.log('[4/5] 拉起应用(**屏外档** · 独立 --user-data-dir)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: rendererUrl,
        // 屏外而不是 headless:这道门每一条都与页面的时间有关(判词在文件头)。
        ONETHING_GATE_OFFSCREEN: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await page.addInitScript(LIVE_LEAF_PROBE)
    await page.evaluate(LIVE_LEAF_PROBE)
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })

    /** 进一条会话:开总览 → 点那一行 → 等消息上屏。 */
    const openSession = async (sessionId, expect) => {
      const rowShown = () =>
        page.evaluate(
          (id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)),
          sessionId,
        )
      for (let attempt = 0; attempt < 3 && !(await rowShown()); attempt += 1) {
        await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
        await delay(600)
      }
      await waitFor('总览画出那一行', rowShown)
      await clickTestId(page, `session-row-${sessionId}`)
      await waitFor('聊天区起底出足够多的消息', async () => {
        const n = await page.evaluate(() =>
          window.__seatLeaf()
            .querySelectorAll('[data-testid="chat-stream"] [data-message-id]').length)
        return n >= Math.min(expect, 20) ? n : undefined
      })
      // 总览收回去,别盖着中央区。
      await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
      await delay(500)
    }

    /**
     * 发一条、逐帧录到这一轮**真的收场**,返回算好的读数。
     *
     * ── 「这一轮跑完了」问的不是账本条数 ──────────────────────────────────
     * `sessions.getMessages` 的条数在 **`run/start` 那一刻**就到位(助手消息先建
     * 空壳再往里流,判词在 `gate-chat-follow` 的「种子为什么不再走 provider」段)。
     * 拿它当收场信号,窗口会在第一个字还没到的时候就关掉 —— 第一版实测正是如此:
     * 常态那一趟只录到 104 帧 / 0.88s,而 provider 静默就有 900ms。
     * 所以判据取**屏幕自己的事实**:停止钮在场 = 这一轮在跑,它没了 = 收场了。
     */
    const runOnce = async (_sessionId, text, timeoutMs) => {
      await startSampler(page)
      await sendViaComposer(page, text)
      // 同一条判据:问的是**屏上那一片**在不在跑(停靠池里那几片不算)。
      const stopShown = () =>
        page.evaluate(() =>
          Boolean(window.__seatLeaf()
            .querySelector('[data-testid="chat-stream"] [data-testid="chat-stop"]')))
      await waitFor('这一轮开张(停止钮上屏)', stopShown, 30_000)
      await waitFor('这一轮收场(停止钮下屏)', async () => !(await stopShown()), timeoutMs)
      // 收场那一下的重排也录进来(思考折回一行就发生在这几帧里)。
      await delay(600)
      const frames = await stopSampler(page)
      const out = analyze(frames)
      if (process.argv.includes('--trace')) {
        const t0 = frames[0]?.t ?? 0
        const row = (f) => [
          Math.round(f.t - t0),
          Number(f.st.toFixed(1)),
          f.user ? Number(f.user.top.toFixed(1)) : null,
          f.seat === null ? -1 : Number(f.seat.toFixed(1)),
          f.readout ? Number(f.readout.top.toFixed(1)) : null,
        ]
        if (out.seatZeroAt >= 0) {
          const a = Math.max(0, out.seatZeroAt - 4)
          console.log('      trace(座位归零 −4…+28 帧) [t,st,user,seat,readout]:',
            JSON.stringify(frames.slice(a, out.seatZeroAt + 29).map(row)))
        }
        /*
         * 「换手之后整段漂 N px」到底是哪几帧漂的 —— 所以**从换手那一帧起**数,
         * 落位那一段的位移不算(那是规矩 ① 的那一次滑动,本来就该动)。
         */
        const lw = frames.map((f) => f.waiting).lastIndexOf(true)
        const base = lw >= 0 ? frames[lw].user?.top : undefined
        const moves = []
        for (let i = Math.max(1, lw + 1); i < frames.length && moves.length < 14; i += 1) {
          const a = frames[i - 1].user?.top
          const b = frames[i].user?.top
          if (a === undefined || a === null || b === undefined || b === null) continue
          if (Math.abs(b - a) < 0.5) continue
          moves.push(row(frames[i]))
        }
        console.log(`      trace(换手基准 user=${base ?? '?'};此后气泡动过的帧)`
          + ' [t,st,user,seat,readout]:', JSON.stringify(moves))
      }
      return out
    }

    console.log('\n[5/5] ①②③④⑤ 常态')
    await openSession(idMain, seeded.main.messages)
    const main = await runOnce(idMain, `座位门 · 常态 ${MARK_NORMAL}`, 90_000)
    readings.main = main
    report('常态', main)
    assert(
      main.waitingFrames > 0,
      `等待折痕真的上过屏(录到 ${main.waitingFrames} 帧;provider 静默 ${FIRST_BYTE_DELAY_MS}ms。`
      + `「在扫的那一道」两种形都算:空折痕,或上下文更新折痕自己在扫 —— 一轮只扫一道)`,
    )
    assert(
      main.seatMax > 0,
      `座位真的建出来了(最高 ${main.seatMax.toFixed(0)}px → 最低 ${main.seatMin.toFixed(0)}px)`,
    )
    assert(
      main.landing.scrollRuns <= BUDGET.scrollRuns,
      `① 发送到首字,滚动只走过 ${main.landing.scrollRuns} 段 ≤ ${BUDGET.scrollRuns}`
      + `(${JSON.stringify(main.landing.runs)})`,
    )
    assert(
      main.whole.scrollRuns <= BUDGET.scrollRuns,
      `① 座位没长满 = 整轮视口一像素不动:整轮也只有 ${main.whole.scrollRuns} 段滚动`
      + `(座位 ${main.seatMax.toFixed(0)} → ${main.seatMin.toFixed(0)}px,一直没长满)`,
    )
    assert(
      main.firstTokenShift <= BUDGET.firstTokenShiftPx,
      `② 等待 → 首字,自己那条气泡位移 ${main.firstTokenShift.toFixed(1)}px ≤ ${BUDGET.firstTokenShiftPx}`,
    )
    assert(
      main.overlapFrames <= BUDGET.overlapFrames,
      `③ 读数行与折痕 / 思考段相交 ${main.overlapFrames} 帧 ≤ ${BUDGET.overlapFrames}(整轮)`,
    )
    assert(
      main.readoutFlips <= BUDGET.readoutFlips,
      `④ 读数行 400ms 内方向反转 ${main.readoutFlips} 次 ≤ ${BUDGET.readoutFlips}`
      + (main.flipSamples.length ? `(${main.flipSamples.join(' | ')})` : ''),
    )
    assert(
      main.whole.longFrames <= BUDGET.longFrames,
      `⑤ 整轮流式 >${BUDGET.longFrameMs}ms 长帧 ${main.whole.longFrames} 个 ≤ ${BUDGET.longFrames}`
      + `(最长 ${main.whole.longestFrameMs}ms)`,
    )
    /*
     * ── 换手之后整段的漂移:09-15 打回二之后**转正为判据** ────────────────────
     * 它从前是 12.0px(两档都是),来源是浏览器的滚动锚定把**座位垫块**当了锚:
     * 内容长 Δ、垫块下一帧缩 Δ,那一帧里锚定给 `scrollTop` 补了一截 —— 补的是一件
     * 本来就该缩掉的东西。治法是 `.seat { overflow-anchor: none }`(只关垫块这一个
     * 元素,不关滚动容器 —— 扩窗补位那条路靠的就是浏览器锚定)。
     * 规矩 ① 那句「之后视口不动」说的就是这个数,所以它与 ② 同一个预算。
     */
    assert(
      main.settledDrift <= BUDGET.firstTokenShiftPx,
      `②b 换手之后气泡**停在原位**:${main.settledDrift.toFixed(1)}px ≤ ${BUDGET.firstTokenShiftPx}`
      + `(整段最远 ${main.handoffDrift.toFixed(1)}px / ${main.handoffDriftFrames} 帧)`,
    )
    /*
     * 「最远 12px」那一下**不是滚动锚定**(09-15 真机 trace 推翻了那个猜测:
     * `.seat { overflow-anchor: none }` 加上之后一个数都没变)。trace 逐帧说的是:
     *   [2700, st 7511, user 80, seat 336.3] → [2717, st 7523, user 68, seat 348.5]
     * 也就是**收尾那一帧内容缩了 12px**(流式光标 / 读数行让位给动作行),
     * 页面正贴着底,浏览器把 `scrollTop` 钳下 12;下一帧座位按新的几何补回 12,
     * 位置一分不差地回到置顶线 —— 一帧 8ms 的瞬态,终值 0.0px。
     *
     * **根治不在座位这一侧,在单 B ⑤**:正本 §2 规矩 ⑤ 说的正是「外缘那一行三张脸
     * **同格同高**,只换 opacity」—— 收尾那一帧内容不缩,这一下就不存在了。
     * 所以这里判终值、报瞬态,退场判据写在这儿:单 B ⑤ 落地之后「最远」该等于终值。
     */
    console.log(
      `  · (只报不判)常态换手之后最远漂 ${main.handoffDrift.toFixed(1)}px,持续 ${main.handoffDriftFrames} 帧`
      + ` —— 收尾那一帧内容缩了这么多(光标 / 读数行让位),座位下一帧补回来;归单 B ⑤`,
    )

    /* ── ⑥ 座位归零那一帧不许弹(打回一)—— 要一段**把座位吃满**的回答才量得到 ── */
    console.log('\n[常态 · 长回] 同一条会话再发一条,回答长到把座位吃满')
    const long = await runOnce(idMain, `座位门 · 长回 ${MARK_LONG}`, 120_000)
    readings.long = long
    report('长回', long)
    assert(
      long.seatZeroAt >= 0 && long.seatMin === 0,
      `长回:座位真的被吃到 0(${long.seatMax.toFixed(0)} → ${long.seatMin.toFixed(0)}px)`
      + ` —— 归零前后采到 ${long.seatZeroFrames} 帧`,
    )
    assert(
      long.landing.scrollRuns <= BUDGET.scrollRuns,
      `长回 ① 发送到首字,滚动只走过 ${long.landing.scrollRuns} 段 ≤ ${BUDGET.scrollRuns}`,
    )
    assert(
      long.firstTokenShift <= BUDGET.firstTokenShiftPx,
      `长回 ② 等待 → 首字气泡位移 ${long.firstTokenShift.toFixed(1)}px ≤ ${BUDGET.firstTokenShiftPx}`,
    )
    assert(
      long.seatZeroFlips <= BUDGET.seatZeroFlips,
      `⑥ 座位归零前后 300ms 内方向反转 ${long.seatZeroFlips} 次 ≤ ${BUDGET.seatZeroFlips}`
      + (long.seatZeroSamples.length ? `(${long.seatZeroSamples.join(' | ')})` : '')
      + ` —— 归零那一帧垫块上还挂着残高,照旧贴底就会多滚一截、下一帧又被钳回来`,
    )
    assert(
      long.overlapFrames <= BUDGET.overlapFrames,
      `长回 ③ 读数行与折痕 / 思考段相交 ${long.overlapFrames} 帧 ≤ ${BUDGET.overlapFrames}`,
    )
    assert(
      long.whole.longFrames <= BUDGET.longFrames,
      `长回 ⑤ 整轮流式 >${BUDGET.longFrameMs}ms 长帧 ${long.whole.longFrames} 个 ≤ ${BUDGET.longFrames}`
      + `(最长 ${long.whole.longestFrameMs}ms)`,
    )

    console.log('\n[超量] 400 条账本之上,一条 20 万字思考')
    await openSession(idBig, seeded.big.messages)
    const big = await runOnce(idBig, `座位门 · 超量 ${MARK_THOUGHT}`, 300_000)
    readings.big = big
    report('超量', big)
    assert(
      big.waitingFrames > 0,
      `超量:等待折痕真的上过屏(录到 ${big.waitingFrames} 帧)`,
    )
    assert(
      big.seatMax > 0,
      `超量:座位真的建出来了(最高 ${big.seatMax.toFixed(0)}px)`,
    )
    assert(
      big.landing.scrollRuns <= BUDGET.scrollRuns,
      `超量 ① 发送到首字,滚动只走过 ${big.landing.scrollRuns} 段 ≤ ${BUDGET.scrollRuns}`
      + `(${JSON.stringify(big.landing.runs)})`,
    )
    assert(
      big.overlapFrames <= BUDGET.overlapFrames,
      `超量 ③ 读数行与折痕 / 思考段相交 ${big.overlapFrames} 帧 ≤ ${BUDGET.overlapFrames}(整轮)`,
    )
    /*
     * ── ④ 在这一档上同样只报不判 ──────────────────────────────────────────
     * 读数行**跟着正文下缘走**(正本 §8 留账第一条:把它钉在座位底边是另一个拍点,
     * 本单不做)。20 万字思考那一趟座位早已长满,读数行整段在跟底,收尾那一帧思考
     * 折回一行时它跟着往上跳 —— 那一下就是一次「先下后上」,治它的是**单 B ④**。
     * 两档实测:dev 0 次 / prod 1 次(判据是 2px + 400ms,4700 帧里的一次抖);
     * 而**拆掉座位**跑同一趟是 **3 次** —— 所以这一格今天不是回归,只是量不稳。
     * 常态那一档两档都是 0,判据留在那里。
     */
    console.log(
      `  · (只报不判)超量 ④ 读数行 400ms 内方向反转 ${big.readoutFlips} 次`
      + (big.flipSamples.length ? `(${big.flipSamples.join(' | ')})` : '')
      + ` —— 读数行跟着正文下缘走(§8 留账),收尾折叠那一下归单 B ④`,
    )
    /*
     * ── 超量那一趟**只报不判**的两格 ────────────────────────────────────────
     * ①(整轮滚动段)与 ⑤(整轮长帧)在这一档上都不是单 A 的事:
     *  · 20 万字思考是座位的 **100 倍**,座位必然长满,长满之后照旧 pinned 跟底
     *    ——那正是 §5 表 1 的最后一格,拿它当红是把设计当回归;
     *  · 收尾那一帧思考自动折回一行今天仍是**跳变**(正本 §0 三处病之二,实测一帧
     *    1.2–1.4s、`scrollTop` 从 16 万掉回 11 万),治它的是**单 B ④**(收尾锚定折叠)。
     * 抬 BUDGET 是改法、让它恒红只会被人加 `|| true`,所以两格都既不抬也不红:
     * 把数报出来,退场判据写在这儿 —— 单 B ④ 落地之后 ⑤ 该掉到 0,那时它转正。
     */
    console.log(
      `  · (只报不判)超量整轮滚动 ${big.whole.scrollRuns} 段 —— 座位归 0 之后照旧 pinned 跟底`
      + `(§5 表 1 最后一格),不是回归`,
    )
    /*
     * ── ② 在这一档上**量不出来**,所以只报不判(09-15 反证实测)────────────
     * 50MB / 400 条那条会话上,这一轮开张前后主线程被**上下文压缩 + 空闲扩窗 +
     * 400 条物化**连着占满几秒:整个等待段探针只采到 **2 帧**,最后一帧还在等、
     * 下一帧已经是几百像素之后 —— 换手那一下根本没有一帧落在中间。
     *
     * **这不是座位带来的**:把座位整个拆掉再跑同一趟(反证),等待帧同样是 2、
     * 长帧同样是 4 个 / 最长 1208ms、②同样量到 407px(带座位 381px)。也就是说
     * 这一格量的是那几秒的主线程饱和,不是产品在这一下动没动。常态那一档
     * ② 是 0.0px,判的是同一件事而且量得准,所以判据留在那里。
     * 退场判据:等待段采样帧数 ≥ 10 的那一天,这一行转正。
     */
    console.log(
      `  · (只报不判)超量 ② 换手位移 ${big.firstTokenShift.toFixed(1)}px —— 等待段只采到`
      + ` ${big.waitingFrames} 帧(主线程被压缩 / 扩窗 / 400 条物化占满),换手那一下没有一帧`
      + `落在中间;拆掉座位重跑同一趟读数一样,量的不是产品`,
    )
    console.log(
      `  · (只报不判)超量整轮 >${BUDGET.longFrameMs}ms 长帧 ${big.whole.longFrames} 个,`
      + `最长 ${big.whole.longestFrameMs}ms —— 20 万字思考首屏与收尾折叠那两帧,归单 B ④`,
    )
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

  console.log(`\n[send-flow] 读数(${LANE}):${JSON.stringify(readings)}`)
  if (failures.length) {
    console.error(`\n[send-flow] FAILED(${LANE})—— ${failures.length} 条:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`\n[send-flow] ok(${LANE})—— 座位 + 置顶滑动 + 等待折痕在真机上成立`)
}

main().catch((error) => {
  console.error(`\n[send-flow] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
