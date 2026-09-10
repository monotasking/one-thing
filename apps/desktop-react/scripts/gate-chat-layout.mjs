#!/usr/bin/env node
/**
 * **聊天树的排版账 + 交互预算**(2026-09-10)—— 这道门问的不是「对不对」,是
 * **一次交互要多少钱、用户什么时候看得见**。
 *
 * ── 病历(它为什么存在)────────────────────────────────────────────────────
 * 两轮真机 CPU profile 坐实:388 条消息 / 37,470 个节点 / 内容列 269,803px 的会话,
 * **排一次版就是 0.1–0.8s**,谁逼它只决定这笔钱记在哪一栏 ——
 *   · 切回一条已在停靠池里的会话:click 同步 JS **1027ms**,其中 `stick()` 自调
 *     **834ms**(链:`commitLayoutEffects → ChatStream.tsx:392 → stick`,那只
 *     **没有依赖数组**的 layout effect 每次提交都读一次 `scrollHeight`);
 *   · 开一个文件把聊天栏挤窄:76ms,其中 64ms 是同一只 `stick`;
 *   · 拖窗口每一步 110ms,而那一步里 JS 只有 0.38ms —— 全是浏览器在排版;
 *   · 流式期间每一段 delta 一次提交 = 一次 stick = 一次全树排版。
 *
 * 09-10 用户把病根说成了法(`CLAUDE.md` 验收第五轴):**「一次交互对应一个长
 * 任务」是结构性违例,不是性能债** —— 列表高亮、标题、内容在最后一帧一起换,
 * 就是全有或全无。所以这道门从「量排版」扩成「量**用户看得见的那几个时刻**」。
 *
 * ── 这道门量什么 ──────────────────────────────────────────────────────────
 * **五条交互预算**(第五轴那张表,在 ≥50MB 的真店规模夹具上量):
 *   ① 点会话行后**第一帧**有可见变化(列表高亮换行)      ≤ 16ms
 *   ② 池命中,内容上屏(那条会话的最后一条消息进视口)     ≤ 100ms
 *   ③ 冷载,首屏上屏                                      ≤ 300ms
 *   ④ 来回切 A→B→A(两边都在池里,三跳各自的上屏)        ≤ 50ms
 *   ⑤ 流式 20 段 delta 期间                               零 ≥50ms 长帧
 * ① 两档都还达不到、③ 只有 dev 达不到(第 5 单留账里就记着「dev 38 / prod 26」),
 * 于是那几格走 `TRANSITIONAL` 的过渡值(实测上限 + 余量,每一行都写了来源与退场
 * 判据),`BUDGET` 本身一个数不动。分档不是放水 —— 判词与另外两条路(改法 /
 * 让它恒红)为什么都不行,写在那张表上。
 * **五条排版账**(这道门原有的,一条不减):
 *   ⑥ 切回大会话的 click 同步 JS;⑦ 五次切换里最长的那一帧;⑧ 进场就在底;
 *   ⑨ 切走再切回停在离开时那一行(锚点漂移 ≤ 8px);⑩ 拖窗口十步的长帧;
 *   ⑪ 大会话上真流一轮之后仍然在底。
 *
 * **不量**:丸的三张脸、发送三态、玻璃几何 —— 那些在 `gate:chat-follow` 里。
 * **也不量**「标题换了没有」那半条 ①:壳今天没有一个稳定的 host 标题 testid,
 * 而 `aria-selected` 那半条正是第五轴点名的「列表高亮」——**报得出的才断言**,
 * 报不出的写进留账,不拿一个猜出来的选择器充数。
 *
 * ── 夹具:`scripts/lib/seed-large-ledger.mjs` ─────────────────────────────
 * 从前这道门自己身上带一段种子(190 轮 × 5 次工具,**1.7MB**)—— 那是真店的
 * 三十分之一,拿它量出来的「绿」什么都不证明。现在两条会话都由生成器造:
 * 真编码、参数化、同参数逐字节可复现,缺省 ≥50MB / 400 条消息 / 900 张工具卡。
 * 会话经 `sessions.create` 建(`meta.json` 因此是产品自己写的那一份),**趁 core
 * 停着**把事件追进 `events.jsonl`,再把 core 起回来 —— 冷启一次全读,不碰
 * 「外来写手」那道闸。
 *
 * ── 两条渲染层都要跑 ──────────────────────────────────────────────────────
 * **缺省跑 dev**(现起一台 vite,端口另挑,绝不碰用户的 5175),`--prod` 跑
 * `dist/` 产物。理由是第五轴那一句:用户跑的是 `electron:dev`,生产构建上量出来
 * 的数对它不成立(09-10 判例:prod 215ms 的池命中路在 dev 上是它的数倍)。
 * `ONETHING_GATE_DIST=1` 与 `--prod` 等价。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * 隔离 store + 独立 `--user-data-dir`,`ONETHING_GATE_HEADLESS=1` 离屏起窗(不 show、
 * 不进 Dock、不抢前台),一切输入走 CDP `Input.dispatch*`(不动真光标),
 * `finally` 里逐个收尸并自查残留。**绝不连 `~/.onething`、绝不连 5175**,
 * 一个字节都不写用户的机器。
 *
 * 跑法:
 *   `npm run gate:chat-layout`            —— dev 渲染层,判红绿
 *   `npm run gate:chat-layout -- --prod`  —— prod 渲染层
 *   `... -- --report`                     —— 只报读数不判红绿(出基线用)
 *   `... -- --json`                       —— 只打读数表(机器读)
 * (仓根先 `bun run server:build`;`--prod` 还要先 `npm run app:build`,
 *  dev 档只要 `npm run electron:build` —— 主进程那一份产物两档都要。)
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { seedLargeLedger } from './lib/seed-large-ledger.mjs'
import { startChunkedFakeProvider } from './lib/gate-stream-provider.mjs'
import { fakeProviderAiSettings, FAKE_PROVIDER_ENV } from '../../../scripts/lib/gate-fake-provider.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const JSON_ONLY = process.argv.includes('--json')
const REPORT_ONLY = JSON_ONLY || process.argv.includes('--report')
const PROD = process.argv.includes('--prod') || process.env.ONETHING_GATE_DIST === '1'
const LANE = PROD ? 'prod' : 'dev'

/**
 * dev 档的 vite 端口。**不是 5175** —— 那是用户自己的 `app:dev` 占着的口
 * (`vite.config.ts` 里 `strictPort: true`),抢它就是抢用户的机器。
 */
const DEV_PORT = Number(process.env.ONETHING_GATE_VITE_PORT ?? 5197)

/* ── 夹具的量级(对着真店取)──────────────────────────────────────────────
 *
 * 甲 = 真店那一条的量级(生成器的缺省档:≥50MB / 400 条 / 900 张卡)。
 * 乙小一档 —— 「切回甲」那一下的代价才是主角,乙只负责把甲挤下屏。
 */
const FIXTURE_A = {}
const FIXTURE_B = { messages: 120, targetBytes: 0, targetToolCalls: 0, largeResults: 2, images: 2 }

/**
 * ── 预算 ──────────────────────────────────────────────────────────────────
 * ①–⑤ 是 `CLAUDE.md` 验收第五轴那张表(用户 09-10 立的),⑥–⑪ 是这一批之前
 * 量到的读数加一段余量。它们是**上限**不是目标:门要抓的是「回到按整份账本
 * 计价」那种量级的回归,而不是把每一次抖动都判红。
 */
const BUDGET = {
  /** ① 点下去到列表高亮换行(第一帧 = 一次 rAF)。 */
  firstPaintMs: 16,
  /** ② 池命中:点下去到那条会话的最后一条消息真的进视口。 */
  poolHitMs: 100,
  /** ③ 冷载:同一条判据,只是这一次它不在池里。 */
  coldLoadMs: 300,
  /** ④ 两边都在池里的来回切,三跳各自的上屏。 */
  warmSwitchMs: 50,
  /** ⑤ 流式期间不许出现的长帧门槛。 */
  streamLongFrameMs: 50,
  /** ⑥ 切回一条已在池里的大会话,click 的同步 JS。改前 1027 / 923ms。 */
  switchClickSyncMs: 300,
  /** ⑦ 同一下里最长的那一帧(long-animation-frame)。改前 1101 / 988ms。 */
  switchLongestFrameMs: 400,
  /** ⑩ 拖窗口十步里最长的那一帧。改前每步 110ms(其中 JS 0.38ms)。 */
  resizeLongestFrameMs: 90,
  /** ⑧⑪「在底」的容差 —— 与 `content/follow.ts` 的 `AT_BOTTOM_EPS` 同一个数。 */
  atBottomEps: 2,
  /** ⑨ 切走再切回来,锚点那一行落在原位的容差(px)。 */
  anchorDriftPx: 8,
}

/**
 * ── **过渡阈值**(第 6 单,2026-09-10;这道门进 `npm run verify` 那一刻立的)──
 *
 * 有两格今天**达不到第五轴的原数**,而且不是只有 dev:第 5 单(72e4f76c)的留账
 * 里那一句写得很清楚 ——「① 首帧 dev 最慢 38 / prod 26 仍未达,存量是 PaneLeaf +
 * 顶栏 + 列表高亮那次紧急提交」。所以过渡表是**两档各一列**,不是「dev 特殊」。
 *
 * 摆在面前的三条路里,两条是错的:
 *  · 把预算抬高写进 `BUDGET` —— 那是**改法**:第五轴那张表当场变成一句空话,
 *    而且再也没有人知道原数是多少;
 *  · 让它红着进 verify —— 一条恒红的门只会被人加 `|| true`,那时它连红都不会
 *    再红一次(verify 自己文件头上写着这条判例,说的是 `gate:perf`)。
 * 所以第三条:**分档,把「过渡」两个字与原数一起印在那一行上**。`BUDGET` 一个数
 * 都没动 —— 它就是第五轴那张表,过渡值是另一张表,退场判据写死:那一格在这一档
 * 上真的达标之后,**删掉这里对应的行**,不是把它改小。
 *
 * 实测(72e4f76c 干净树 + 只接了悬停预取的本单树,同一台机器,`--report`):
 *  · ① 首帧:dev 五次里最慢 **37 / 41 / 42**ms;prod **14 / 15 / 21 / 26**ms
 *    —— prod 也过线,只是过得少,所以它同样要一格。病根是存量(见上);
 *  · ③ 冷载首屏:dev **256 / 267 / 305**ms;prod **140 / 159 / 176 / 218 / 274**ms。
 *    dev 那个 305 是构建完**第一发**(冷盘),而 verify 里这道门排在一整条构建链
 *    之后正是那一发的处境,所以它算进上限,不当异常值抹掉。
 *    **prod 那一列不给过渡值**:它的原数今天够用。七发里有一发量到 989ms,那**不是
 *    抖动而是一条真病** —— 首屏那页在 core 的单线程队列里排到了 `getTokenUsage` /
 *    `getSegments` / `getUserMarkers`(各约 860ms)后面。它该被这道门抓红,
 *    修法在产品侧(把首屏那一读排到前面),不是在这里抬一个抓不着任何东西的天花板。
 */
const TRANSITIONAL = {
  /** dev:① 实测上限 42 → 60(约 1.4×);③ 实测上限 305 → 360(约 1.2×)。 */
  dev: { firstPaintMs: 60, coldLoadMs: 360 },
  /** prod:① 实测上限 26 → 40(约 1.5×)。③ 不给 —— 理由在上面那段。 */
  prod: { firstPaintMs: 40 },
}

/** 这一档下某一格的**判据**(有过渡值就用过渡值,没有就是第五轴原数)。 */
function budgetOf(key) {
  return key in TRANSITIONAL[LANE] ? TRANSITIONAL[LANE][key] : BUDGET[key]
}

/** 判据后面那句「这是过渡档」的尾巴。没有过渡值的格子是空串。 */
function laneNote(key) {
  return key in TRANSITIONAL[LANE]
    ? `(${LANE} **过渡档**;第五轴原数 ${BUDGET[key]}ms —— 达标之后删掉过渡表那一行)`
    : ''
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
const readings = { lane: LANE, budget: BUDGET }
function assert(ok, message) {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`)
  if (!ok) failures.push(message)
}

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
    const settle = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

async function waitFor(label, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后读数:${String(JSON.stringify(last)).slice(0, 400)}`)
}

async function rpc(record, domain, method, payload = {}) {
  const res = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
    },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!res.ok) throw new Error(`rpc ${domain}.${method} HTTP ${res.status}`)
  const body = await res.json()
  if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body).slice(0, 200)}`)
  return body.data
}

/* ── 页内探针 ─────────────────────────────────────────────────────────────
 *
 * 两件事,一次注入:
 *  · **长帧与事件耗时**(`long-animation-frame` / `event`)—— ⑥⑦⑩⑤ 读它;
 *  · **一次交互的三个时刻**(按下 / 第一帧可见变化 / 内容上屏)—— ①②③④ 读它。
 *
 * 时刻的产地是**页内的 `performance.now()`**,不是脚本这一侧的墙钟:CDP 一发
 * `Input.dispatchMouseEvent` 的往返本身就有几毫秒,拿它当 t0 会把 16ms 的预算
 * 吃掉一小半。t0 取**捕获相位的 `mousedown`**(合成事件真的到达页面那一刻),
 * 与用户按下鼠标那一刻是同一件事。
 */
async function installProbe(page) {
  await page.evaluate(() => {
    if (window.__layoutProbe) return
    const P = (window.__layoutProbe = { events: [], loaf: [], run: null })
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          P.events.push({
            name: entry.name,
            sync: entry.processingEnd - entry.processingStart,
            dur: entry.duration,
          })
        }
      }).observe({ type: 'event', durationThreshold: 16, buffered: true })
    } catch (error) {
      P.eventsErr = String(error)
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) P.loaf.push({ dur: entry.duration, blocking: entry.blockingDuration })
      }).observe({ type: 'long-animation-frame', buffered: true })
    } catch (error) {
      P.loafErr = String(error)
    }

    /*
     * ⑧ **一次冷开发了哪些 RPC、各自多大**(2026-09-10 工单 5 ⑧)。
     *
     * 判据是「有没有人还在拉整份抄本」——那正是本单在治的病,而它在毫秒数上
     * 常常看不出来(机器快的时候 55MB 也就几百毫秒),只有把**发数与字节**
     * 摆出来才抓得住。
     *
     * 量法:包一层 `fetch`,**只包 `/api/rpc`** —— `/api/events` 是一条不会
     * 结束的 SSE 流,`clone()` 它等于把整条流缓存在内存里直到进程结束。
     * 大小取 `clone().text().length`(响应体字节);包一层的代价落在这条量测
     * 泳道上,不进产品。
     */
    P.net = []
    P.netOn = false
    const rawFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input?.url ?? ''
      if (!P.netOn || !url.includes('/api/rpc')) return rawFetch(input, init)
      let label = 'rpc'
      try {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
        label = `${body.domain}.${body.method}`
        // 资源面只有一条方法名(`resources.read`),真正说了做什么的是读法名。
        if (body?.payload?.name) label += `(${body.payload.name})`
      } catch { /* 认不出就记成 rpc —— 量的是发数与字节,不是这一行文字。 */ }
      const started = performance.now()
      const response = await rawFetch(input, init)
      let bytes = -1
      try { bytes = (await response.clone().text()).length } catch { /* 读不出就记 -1 */ }
      P.net.push({ label, bytes, ms: Math.round(performance.now() - started) })
      return response
    }
    P.armNet = () => { P.net = []; P.netOn = true }
    P.stopNet = () => { P.netOn = false; return P.net }

    /** 「列表高亮此刻在哪一行」—— ① 的判据(第五轴点名的那一半)。 */
    const highlight = () =>
      document.querySelector('[data-testid^="session-row-"][aria-selected="true"]')
        ?.getAttribute('data-testid') ?? ''

    /**
     * 「那条会话的内容真的在屏幕上了吗」—— ②③④ 的判据。
     *
     * 判的是**指名道姓的那一行**(夹具给出的 `lastMessageId`)与滚动容器的可视
     * 矩形有没有交叠。不判「行数够了」:行数够只说明 React 提交过,跳渲的行
     * (`content-visibility: auto`)还可能一格都没画;也不判「任意一行可见」:
     * 切换前屏幕上是另一条会话的行,那也叫「有行可见」。
     */
    /**
     * **在屏那一片聊天区**(2026-09-10 组件级停靠之后)。
     *
     * 停靠起来的会话叶**照旧挂在 DOM 上**(`content-visibility: hidden` + inert),
     * 所以 `document.querySelector('[data-testid="chat-stream"]')` 会命中它们里面
     * 的任意一片 —— 而画法层按**出生序**排,先开的那条排在前面,于是「第一个」
     * 恰恰常常是藏起来的那一片。判据因此收窄到活动那一层(`[data-pane-on]`);
     * 拼贴台之外的宿主(舞台 / 浮窗)不画这个属性,所以留一格退路。
     */
    const liveStream = () =>
      document.querySelector('[data-pane-on] [data-testid="chat-stream"]')
      ?? document.querySelector('[data-testid="chat-stream"]')

    const visible = (messageId) => {
      const scroll = liveStream()
      // 行也要限定在**这一片**里找:停靠的那几片装着别的会话的行,一路同名。
      const row = messageId && scroll ? scroll.querySelector(`[data-message-id="${messageId}"]`) : null
      if (!(scroll instanceof HTMLElement) || !row) return false
      const box = scroll.getBoundingClientRect()
      const rect = row.getBoundingClientRect()
      if (rect.height <= 0) return false
      return rect.bottom > box.top && rect.top < box.bottom
    }

    /**
     * 布一次「等这一下交互」的岗。**先布岗再点**,岗自己在捕获相位接住 mousedown
     * 盖时刻,所以 t0 与「合成事件到达页面」逐帧对齐。
     */
    P.arm = (wantMessageId) => {
      const run = {
        wantMessageId,
        baseline: highlight(),
        t0: null,
        firstPaintMs: null,
        contentMs: null,
        frames: 0,
        done: false,
      }
      P.run = run
      const onDown = () => {
        run.t0 = performance.now()
        const tick = () => {
          if (run.done) return
          run.frames += 1
          const now = performance.now()
          if (run.firstPaintMs === null && highlight() !== run.baseline) run.firstPaintMs = now - run.t0
          if (run.contentMs === null && visible(run.wantMessageId)) run.contentMs = now - run.t0
          if ((run.firstPaintMs !== null && run.contentMs !== null) || now - run.t0 > 20_000) {
            run.done = true
            return
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }
      window.addEventListener('mousedown', onDown, { capture: true, once: true })
    }
  })
}

const probeMark = (page) =>
  page.evaluate(() => ({ ev: window.__layoutProbe.events.length, loaf: window.__layoutProbe.loaf.length }))

async function harvest(page, mark) {
  return page.evaluate((m) => {
    const P = window.__layoutProbe
    const events = P.events.slice(m.ev)
    const loaf = P.loaf.slice(m.loaf)
    return {
      clickSync: Math.round(Math.max(0, ...events.filter((e) => e.name === 'click').map((e) => e.sync))),
      topSync: Math.round(Math.max(0, ...events.map((e) => e.sync))),
      longestFrame: Math.round(Math.max(0, ...loaf.map((l) => l.dur))),
      frames: loaf.length,
      longFrames: loaf.map((l) => Math.round(l.dur)).filter((d) => d >= 50),
    }
  }, mark)
}

function readView(page) {
  return page.evaluate(() => {
    // 在屏那一片(判词与页内探针的 `liveStream` 逐字同源 —— 组件级停靠之后
    // DOM 上同时挂着好几片聊天区,量错一片读数就全错)。
    const scroll =
      document.querySelector('[data-pane-on] [data-testid="chat-stream"]')
      ?? document.querySelector('[data-testid="chat-stream"]')
    if (!(scroll instanceof HTMLElement)) return { rowCount: 0 }
    const rows = [...scroll.querySelectorAll('[data-message-id]')]
    const base = scroll.getBoundingClientRect().top
    /** 视口里最上面那条还露着的消息 —— 与 `measureScrollAnchor` 同一条判据。 */
    let anchor
    for (const row of rows) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom <= base) continue
      anchor = { id: row.getAttribute('data-message-id'), offset: Math.round(rect.top - base) }
      break
    }
    return {
      scrollTop: Math.round(scroll.scrollTop),
      scrollHeight: Math.round(scroll.scrollHeight),
      clientHeight: Math.round(scroll.clientHeight),
      gap: Math.round(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop),
      rowCount: rows.length,
      anchor,
      w: window.innerWidth,
      h: window.innerHeight,
    }
  })
}

/**
 * **「那条会话上屏了」的判据**(2026-09-10 工单 5 ③ 之后重写)。
 *
 * 从前这三处等的是 `rowCount >= 夹具的消息条数` —— 那句话里藏着一个前提:
 * **壳手里有整条会话**。第 5 单之后不再成立:冷载拉的是尾页(24 条),更早的
 * 由上翻取页按需补。等 400 行会等到天荒地老,而那不是回归,是新的正确行为。
 *
 * 换成**指名道姓的那一行在不在这棵树上**(夹具的 `lastMessageId`)。
 *
 * 注意判的是「在 DOM 上」而不是「在视口里」—— ①②③④ 那三处量的是「内容上屏」
 * 所以要视口,而这两处等的是「这条会话的树立起来了」:⑨ 那一格恰恰要它**不**
 * 落在底(锚点回到离开时那一行,最后一条消息在视口之外几千像素),拿视口当
 * 判据会把这道门自己的题判成超时。
 */
function sessionTreeUp(page, messageId) {
  return page.evaluate((id) => {
    const scroll =
      document.querySelector('[data-pane-on] [data-testid="chat-stream"]')
      ?? document.querySelector('[data-testid="chat-stream"]')
    const row = scroll?.querySelector(`[data-message-id="${id}"]`)
    return Boolean(scroll instanceof HTMLElement && row && row.getBoundingClientRect().height > 0)
  }, messageId)
}

async function clickTestId(cdp, page, testId) {
  const box = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + Math.min(rect.height / 2, 12)) }
  }, testId)
  if (!box) throw new Error(`点不到 [data-testid="${testId}"]`)
  const common = { x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common, buttons: 0 })
}

/**
 * 一次「点会话行 → 它上屏」的完整量法:布岗 → 点 → 等两个时刻齐了 → 收。
 *
 * 同时收 `harvest` 的那一份(⑥⑦ 用),所以一次交互只走一遍。
 */
async function measureSwitch(cdp, page, { label, sessionId, lastMessageId, wantRows, net = false }) {
  const mark = await probeMark(page)
  await page.evaluate((id) => window.__layoutProbe.arm(id), lastMessageId)
  // ⑧ 只对冷开那一次记账:量的是「开一条会话要发哪些 RPC」,不是整场的流水。
  if (net) await page.evaluate(() => window.__layoutProbe.armNet())
  await clickTestId(cdp, page, `session-row-${sessionId}`)
  const run = await waitFor(`${label} 的内容上屏`, async () => {
    const value = await page.evaluate(() => {
      const r = window.__layoutProbe.run
      return r ? { ...r } : null
    })
    return value && value.t0 !== null && value.contentMs !== null ? value : undefined
  })
  // 长帧要等这一下彻底停稳才收得全(跳渲的行是一帧一帧补上来的)。
  await delay(2500)
  const cost = await harvest(page, mark)
  const view = await readView(page)
  const netRows = net ? await page.evaluate(() => window.__layoutProbe.stopNet()) : undefined
  return {
    label,
    ...(netRows ? { net: netRows } : {}),
    firstPaintMs: run.firstPaintMs === null ? null : Math.round(run.firstPaintMs),
    contentMs: Math.round(run.contentMs),
    rafFrames: run.frames,
    clickSync: cost.clickSync,
    longestFrame: cost.longestFrame,
    rowCount: view.rowCount,
    gap: view.gap,
    wantRows,
  }
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[chat-layout] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry)) {
    console.error('[chat-layout] 找不到主进程产物 —— 先跑 `npm run electron:build`')
    process.exit(1)
  }
  if (PROD && !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[chat-layout] --prod 档找不到 `dist/index.html` —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'chat-layout-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'chat-layout-udd-'))
  let mockProvider
  let server
  let app
  let vite

  /** 起一台 core,等它写出发现文件。 */
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
    console.log(`\n[chat-layout] 渲染层档位:${LANE}${REPORT_ONLY ? ' · 只报不判' : ''}`)

    console.log('\n[1/7] 起假 provider + 一台 core,建两条空会话')
    // 20 段:⑤ 那一条要的是 20 次真的到达、20 次真的提交。
    mockProvider = await startChunkedFakeProvider(
      0,
      '门跑完了,这一句是假 provider 吐的回答:它要够长,好切成二十段真的流一遍,让每一段都逼出一次提交、一次排版,长帧才藏不住。',
      { pieces: 20, gapMs: 40 },
    )
    writeFileSync(
      path.join(store, 'settings.json'),
      JSON.stringify(
        {
          ai: fakeProviderAiSettings(mockProvider.address().port),
          tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
          diagnostics: { enabled: false },
        },
        null,
        2,
      ),
    )
    let core = await startCore()
    server = core.child
    const idA = (await rpc(core.record, 'sessions', 'create', { name: '排版账 · 甲(真店规模)' }))?.session?.id
    const idB = (await rpc(core.record, 'sessions', 'create', { name: '排版账 · 乙(小)' }))?.session?.id
    if (!idA || !idB) throw new Error('会话没建出来')

    console.log('[2/7] 停 core,用生成器把两份账本写进去,再把 core 起回来')
    await stopCore(server)
    const seeded = {
      A: seedLargeLedger(store, idA, FIXTURE_A),
      B: seedLargeLedger(store, idB, FIXTURE_B),
    }
    readings.fixture = seeded
    for (const [name, s] of Object.entries(seeded)) {
      console.log(
        `      ${name} ${s.idPrefix}:${(s.bytes / 1024 / 1024).toFixed(1)}MB / ${s.messages} 条 / `
        + `${s.toolCalls} 张卡(每张 ${(s.toolResultBytes / 1024).toFixed(0)}KB)/ ${s.blobs} 个 blob / `
        + `${s.recipeRows} 条配方行`,
      )
    }
    core = await startCore()
    server = core.child
    const record = core.record

    let rendererUrl = ''
    if (!PROD) {
      console.log(`[3/7] 起 vite dev(端口 ${DEV_PORT},**不是用户的 5175**)`)
      const { createServer } = await import('vite')
      vite = await createServer({
        configFile: path.join(appRoot, 'vite.config.ts'),
        server: { port: DEV_PORT, strictPort: true },
        logLevel: 'warn',
      })
      await vite.listen()
      rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`
      console.log(`      ${rendererUrl}`)
    } else {
      console.log('[3/7] prod 档:直接吃 `dist/` 产物,不起 vite')
    }

    console.log('[4/7] 拉起应用(离屏 · 独立 --user-data-dir)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: rendererUrl,
        ONETHING_GATE_HEADLESS: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await installProbe(page)
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    await page.evaluate(() => document.querySelector('[data-testid="dock-tile-sessions"]').click())
    await waitFor('总览画出两行', () =>
      page.evaluate(
        ([a, b]) =>
          Boolean(document.querySelector(`[data-testid="session-row-${a}"]`))
          && Boolean(document.querySelector(`[data-testid="session-row-${b}"]`)),
        [idA, idB],
      ),
    )

    console.log('\n[5/7] ①②③④⑥⑦ 切会话往返:cold-A → B#1 → A#2 → B#2 → A#3')
    const plan = [
      ['cold-A', idA, seeded.A],
      ['B#1', idB, seeded.B],
      ['A#2', idA, seeded.A],
      ['B#2', idB, seeded.B],
      ['A#3', idA, seeded.A],
    ]
    const switches = []
    for (const [label, id, fixture] of plan) {
      const got = await measureSwitch(cdp, page, {
        label,
        sessionId: id,
        lastMessageId: fixture.lastMessageId,
        wantRows: fixture.messages,
        net: label === 'cold-A',
      })
      switches.push(got)
      console.log(
        `      ${label}: 首帧=${got.firstPaintMs ?? '—'}ms 上屏=${got.contentMs}ms `
        + `clickSync=${got.clickSync}ms 最长帧=${got.longestFrame}ms 行=${got.rowCount} 离底=${got.gap}px`,
      )
      if (got.net) {
        const total = got.net.reduce((sum, row) => sum + Math.max(0, row.bytes), 0)
        console.log(`      ⑧ 冷开 RPC ${got.net.length} 发 / ${total.toLocaleString()} B:`)
        for (const row of got.net) {
          console.log(`         · ${row.label} — ${Math.max(0, row.bytes).toLocaleString()} B / ${row.ms}ms`)
        }
      }
    }
    readings.switches = switches
    readings.dom = await page.evaluate(() => {
      const live =
        document.querySelector('[data-pane-on] [data-testid="chat-stream"]')
        ?? document.querySelector('[data-testid="chat-stream"]')
      return {
        domNodes: document.querySelectorAll('*').length,
        // **在屏那一片**的行数;`parkedStreams` 才是「藏着几片」。
        messages: live?.querySelectorAll('[data-message-id]').length ?? 0,
        toolCards: document.querySelectorAll('[class*="toolCard"]').length,
        contentHeight: Math.round(live?.firstElementChild?.getBoundingClientRect().height ?? 0),
        /** 组件级停靠此刻藏着几棵树(0 = 这一档没有停靠,与改前逐字相同)。 */
        parkedStreams: document.querySelectorAll('[data-pane-kept] [data-testid="chat-stream"]').length,
      }
    })
    console.log(`      现场:${JSON.stringify(readings.dom)}(真店对照:37470 节点 / 269803px)`)

    /*
     * ── ⑫ 停靠 N 棵树之后的渲染进程 JS 堆(2026-09-10 组件级停靠)──────────────
     *
     * 停靠是拿**堆**换**时间**:切回来不重挂,代价是那几棵树的 DOM 与 fiber 一直
     * 占着。所以这一格与 ①④ 同批量出来,读数摆在一起才看得出这笔交易划不划算。
     *
     * 量法用 CDP 的 `Runtime.getHeapUsage`(`performance.memory` 在渲染进程里被
     * 粒度化到 MB 级,而且它报的是「上一次 GC 之后」的数,分辨不出这几棵树)。
     * 先 `HeapProfiler.collectGarbage` 逼一次真 GC:不逼的话读到的是「还没回收的
     * 垃圾 + 活对象」,那个数与「停了几棵树」没有关系。
     */
    try {
      await cdp.send('HeapProfiler.enable').catch(() => undefined)
      await cdp.send('HeapProfiler.collectGarbage')
      await delay(500)
      const usage = await cdp.send('Runtime.getHeapUsage')
      readings.heap = {
        usedMB: Math.round((usage.usedSize / 1024 / 1024) * 10) / 10,
        totalMB: Math.round((usage.totalSize / 1024 / 1024) * 10) / 10,
        parkedStreams: readings.dom.parkedStreams,
      }
      console.log(
        `      ⑫ 停靠 ${readings.heap.parkedStreams} 棵树之后的 JS 堆:`
        + `${readings.heap.usedMB}MB / ${readings.heap.totalMB}MB(GC 之后)`,
      )
    } catch (error) {
      readings.heap = { error: String(error?.message ?? error) }
    }

    const byLabel = (name) => switches.find((s) => s.label === name)
    const cold = byLabel('cold-A')
    const poolHit = byLabel('A#2')
    const warm = [byLabel('B#2'), byLabel('A#3')]
    const worstFirstPaint = Math.max(...switches.map((s) => s.firstPaintMs ?? Number.POSITIVE_INFINITY))
    assert(
      Number.isFinite(worstFirstPaint) && worstFirstPaint <= budgetOf('firstPaintMs'),
      `① 点下去第一帧列表高亮就换了:五次里最慢 ${Number.isFinite(worstFirstPaint) ? `${worstFirstPaint}ms` : '(有一次压根没换)'} ≤ ${budgetOf('firstPaintMs')}ms${laneNote('firstPaintMs')}`,
    )
    assert(
      poolHit.contentMs <= BUDGET.poolHitMs,
      `② 池命中,内容上屏 ${poolHit.contentMs}ms ≤ ${BUDGET.poolHitMs}ms`,
    )
    assert(
      cold.contentMs <= budgetOf('coldLoadMs'),
      `③ 冷载,首屏上屏 ${cold.contentMs}ms ≤ ${budgetOf('coldLoadMs')}ms${laneNote('coldLoadMs')}`,
    )
    const worstWarm = Math.max(...warm.map((s) => s.contentMs))
    assert(
      worstWarm <= BUDGET.warmSwitchMs,
      `④ 来回切 A→B→A(两边都在池里)最慢一跳 ${worstWarm}ms ≤ ${BUDGET.warmSwitchMs}ms`,
    )

    const warmClicks = [poolHit, ...warm].filter((s) => s.label.startsWith('A'))
    const worstClickSync = Math.max(...warmClicks.map((s) => s.clickSync))
    const worstFrame = Math.max(...switches.map((s) => s.longestFrame))
    assert(
      worstClickSync <= BUDGET.switchClickSyncMs,
      `⑥ 切回大会话的 click 同步 JS ${worstClickSync}ms ≤ ${BUDGET.switchClickSyncMs}ms(改前 1027 / 923ms)`,
    )
    assert(
      worstFrame <= BUDGET.switchLongestFrameMs,
      `⑦ 五次切换里最长的那一帧 ${worstFrame}ms ≤ ${BUDGET.switchLongestFrameMs}ms(改前 1101ms)`,
    )

    console.log('\n[6/7] ⑧ 进场就在底 / ⑨ 切走再切回停在离开时那一行')
    const entered = await readView(page)
    assert(entered.gap <= BUDGET.atBottomEps, `⑧ 进场就在底(离底 ${entered.gap}px ≤ ${BUDGET.atBottomEps}px)`)

    // 滚到中间某一条,记住它;去乙,再回甲。
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-stream"]')
      el.scrollTop = Math.round(el.scrollHeight * 0.45)
      el.dispatchEvent(new Event('scroll'))
    })
    await delay(900) // 等锚点写点那一拍(SCROLL_ANCHOR_SETTLE_MS)停稳
    const before = await readView(page)
    console.log(`      离开时:锚点 ${before.anchor?.id} offset=${before.anchor?.offset}px`)
    await clickTestId(cdp, page, `session-row-${idB}`)
    await waitFor('乙上屏', async () =>
      (await sessionTreeUp(page, seeded.B.lastMessageId)) ? await readView(page) : undefined,
    )
    await delay(1200)
    await clickTestId(cdp, page, `session-row-${idA}`)
    await waitFor('甲回来', async () =>
      (await sessionTreeUp(page, seeded.A.lastMessageId)) ? await readView(page) : undefined,
    )
    await delay(1500)
    const after = await readView(page)
    readings.anchor = { before: before.anchor, after: after.anchor }
    const sameRow = Boolean(before.anchor && after.anchor && before.anchor.id === after.anchor.id)
    const drift = sameRow ? Math.abs(after.anchor.offset - before.anchor.offset) : Number.NaN
    console.log(`      回来后:锚点 ${after.anchor?.id} offset=${after.anchor?.offset}px`)
    assert(sameRow, `⑨ 切回来还是离开时那一行(${before.anchor?.id} → ${after.anchor?.id})`)
    assert(
      sameRow && drift <= BUDGET.anchorDriftPx,
      `⑨ 那一行落在原位 ±${BUDGET.anchorDriftPx}px(实测漂 ${Number.isNaN(drift) ? '—' : drift}px)`,
    )

    console.log('\n[7/7] ⑩ 拖窗口十步 / ⑤ 流式 20 段 / ⑪ 流完仍然在底')
    const base = await readView(page)
    const resizeMark = await probeMark(page)
    for (let step = 0; step < 10; step += 1) {
      const width = base.w - (step + 1) * 24
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: base.h, deviceScaleFactor: 0, mobile: false })
      await delay(220)
    }
    await delay(1200)
    const resized = await harvest(page, resizeMark)
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await delay(1200)
    readings.resize = resized
    console.log(`      resize ×10:最长帧=${resized.longestFrame}ms(共 ${resized.frames} 个长帧)`)
    assert(
      resized.longestFrame <= BUDGET.resizeLongestFrameMs,
      `⑩ 拖窗口十步里最长的那一帧 ${resized.longestFrame}ms ≤ ${BUDGET.resizeLongestFrameMs}ms(改前每步 110ms)`,
    )

    // 回到底,再让假 provider 真跑一轮 —— 流的**每一段**都在这一棵大树上提交。
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-stream"]')
      el.scrollTop = el.scrollHeight
      el.dispatchEvent(new Event('scroll'))
    })
    await delay(600)
    /*
     * 流那一轮长出来的是**两条新消息**(用户那句 + 助手那句)。判据因此是
     * 「行比刚才多两条」而不是「行数到了 402」—— 手里存几条由页决定(第 5 单),
     * 而这道门要判的是「这一轮真的在这棵大树上提交完了」。
     */
    const rowsBeforeStream = (await readView(page)).rowCount
    const wantRows = rowsBeforeStream + 2
    const streamMark = await probeMark(page)
    await rpc(record, 'session-command', 'emit', {
      sessionId: idA,
      command: { type: 'command:send-message', content: '排版账门:这一条要在四百条的树上真流二十段' },
    })
    const streamed = await waitFor('那一轮上屏', async () => {
      const view = await readView(page)
      return view.rowCount >= wantRows ? view : undefined
    })
    await delay(2500)
    const streamCost = await harvest(page, streamMark)
    const settled = await readView(page)
    readings.stream = {
      rowCount: settled.rowCount,
      gap: settled.gap,
      sawRows: streamed.rowCount,
      longFrames: streamCost.longFrames,
      longestFrame: streamCost.longestFrame,
    }
    console.log(
      `      流式期间:≥${BUDGET.streamLongFrameMs}ms 的帧 ${streamCost.longFrames.length} 个`
      + `${streamCost.longFrames.length ? `(${streamCost.longFrames.join(', ')}ms)` : ''};流完离底=${settled.gap}px`,
    )
    assert(
      streamCost.longFrames.length === 0,
      `⑤ 流式 20 段期间零 ≥${BUDGET.streamLongFrameMs}ms 长帧(实测 ${streamCost.longFrames.length} 个,最长 ${streamCost.longestFrame}ms)`,
    )
    assert(
      settled.gap <= BUDGET.atBottomEps,
      `⑪ 大会话上真跑一轮,流完仍然在底(离底 ${settled.gap}px ≤ ${BUDGET.atBottomEps}px)`,
    )
  } finally {
    if (app) await app.close().catch(() => undefined)
    if (vite) await vite.close().catch(() => undefined)
    await stopCore(server)
    if (mockProvider) {
      // keep-alive 的套接字会让 close() 一直等 —— 先掐断,收尸才收得干净。
      mockProvider.closeAllConnections?.()
      await new Promise((resolve) => mockProvider.close(resolve))
    }
    await rm(store, { recursive: true, force: true }).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    const leftovers = [
      server && !server.killed ? `core pid=${server.pid}` : null,
      existsSync(store) ? `store ${store}` : null,
      existsSync(userDataDir) ? `udd ${userDataDir}` : null,
      mockProvider?.listening ? `假 provider :${mockProvider.address()?.port}` : null,
      !PROD && (await portConnects('127.0.0.1', DEV_PORT)) ? `vite :${DEV_PORT}` : null,
    ].filter(Boolean)
    console.log(
      `\n[收尸] store / udd 已删;core killed=${server?.killed ?? '(没起)'}`
      + `${leftovers.length ? `;**残留**:${leftovers.join('、')}` : ';残留自查:干净'}`,
    )
  }

  if (JSON_ONLY) {
    console.log(JSON.stringify({ readings, failures }, null, 2))
    return
  }
  console.log('')
  if (REPORT_ONLY) {
    console.log(`[chat-layout · ${LANE}] 只报不判 —— ${failures.length} 条超出预算(基线用,不判红绿):`)
    for (const line of failures) console.log(`  · ${line}`)
    console.log(`\n${renderTable(readings)}`)
    return
  }
  if (failures.length > 0) {
    console.error(`[chat-layout · ${LANE}] 红 —— ${failures.length} 条不达标:`)
    for (const line of failures) console.error(`  · ${line}`)
    process.exit(1)
  }
  console.log(`[chat-layout · ${LANE}] 绿 —— 交互预算与排版账都在预算内`)
}

/**
 * ⑧ 冷开那一次发了几发 RPC、一共多少字节(2026-09-10 工单 5 ⑧)。
 *
 * 它是这一族读数里**唯一不按毫秒计价**的一格,而那正是它存在的理由:拉整份
 * 抄本在快机器上也就几百毫秒,只有把字节摆出来才看得见「谁还在按整份账本
 * 计价」。
 */
function coldNet(r) {
  const rows = r.switches?.find((s) => s.label === 'cold-A')?.net
  if (!rows) return '—'
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.bytes), 0)
  return `${rows.length} 发 / ${total.toLocaleString()} B(${rows.map((row) => row.label).join(', ')})`
}

/** `--report` 的基线表:一屏能抄进方案里的那种。 */
function renderTable(r) {
  const rows = [
    ['渲染层', r.lane],
    ['夹具 甲', r.fixture ? `${(r.fixture.A.bytes / 1024 / 1024).toFixed(1)}MB / ${r.fixture.A.messages} 条 / ${r.fixture.A.toolCalls} 卡 / ${r.fixture.A.blobs} blob` : '—'],
    ['折出来', r.dom ? `${r.dom.domNodes} 节点 / ${r.dom.messages} 行 / ${r.dom.contentHeight}px(真店 37470 / 269803px)` : '—'],
    ['① 首帧可见变化', r.switches ? `${r.switches.map((s) => s.firstPaintMs ?? '—').join(' / ')} ms(五次)` : '—'],
    ['② 池命中上屏', r.switches ? `${r.switches.find((s) => s.label === 'A#2')?.contentMs} ms` : '—'],
    ['③ 冷载上屏', r.switches ? `${r.switches.find((s) => s.label === 'cold-A')?.contentMs} ms` : '—'],
    ['④ 来回切', r.switches ? `${r.switches.filter((s) => ['B#2', 'A#3'].includes(s.label)).map((s) => s.contentMs).join(' / ')} ms` : '—'],
    ['⑤ 流式长帧', r.stream ? `${r.stream.longFrames.length} 个 ≥50ms(最长 ${r.stream.longestFrame}ms)` : '—'],
    ['⑥ clickSync', r.switches ? `${r.switches.map((s) => s.clickSync).join(' / ')} ms` : '—'],
    ['⑦ 切换最长帧', r.switches ? `${Math.max(...r.switches.map((s) => s.longestFrame))} ms` : '—'],
    ['⑨ 锚点漂移', r.anchor?.before && r.anchor?.after ? `${Math.abs(r.anchor.after.offset - r.anchor.before.offset)} px` : '—'],
    ['⑩ resize 最长帧', r.resize ? `${r.resize.longestFrame} ms` : '—'],
    ['⑪ 流完离底', r.stream ? `${r.stream.gap} px` : '—'],
    ['⑫ 停靠棵数', r.dom ? `${r.dom.parkedStreams ?? 0} 棵(视图停靠池)` : '—'],
    ['⑧ 冷开 RPC', coldNet(r)],
    ['⑫ JS 堆(GC 后)', r.heap?.usedMB !== undefined ? `${r.heap.usedMB} MB / 总 ${r.heap.totalMB} MB` : (r.heap?.error ?? '—')],
  ]
  const width = Math.max(...rows.map(([k]) => k.length))
  return rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n')
}

main().catch((error) => {
  console.error(`\n[chat-layout] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
