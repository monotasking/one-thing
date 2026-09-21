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
  /** ④ 收尾那一帧起 300ms 内,视口内第一块在读的东西的位移(px)。 */
  endAnchorShiftPx: 1,
  /** ④ 收尾之后 DOM 还在翻腾的元素数(重挂 = 一批同时走一批同时来)。 */
  churnAfterEnd: 0,
  /** ⑥ 重试那一帧起 300ms 内,自己那条气泡的位移(px)。 */
  retryShiftPx: 1,
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
/**
 * **按下重试到折痕在扫**,最多这么久(单 B ⑥「按下即开槽」)。
 *
 * 它是一个**上限判据**不是一段时长:壳这一侧那一格 `retryPending` 与那道折痕是
 * **同一次 React 提交**,所以真值该是一两帧;100ms 给的是采样与调度的余量
 * (与 `QUIET_MS` 同一个量级、同一条理由 —— 帧不是时间)。治前这里是**几百毫秒到
 * 一秒**:壳要等 core 删完旧回复、开完新 run,账本回来才画。
 */
const RETRY_SEAM_MS = 100
/**
 * **收摊之后盯多久**(单 B ④)。6s:比一趟自动起名的往返、比账本落盘的节流
 * (300ms)、比任何一次收尾重排都长一个量级 —— 这段时间里那条助手行还在增删节点,
 * 说的就是有人在事后重挂它(§0 三处病之二的病根之一)。
 */
const CHURN_WATCH_MS = 6000
/**
 * **等「这一轮开张」(停止钮上屏)最多这么久**。
 *
 * 它**不是**一格预算,是一条「别把机器忙判成产品红」的闸:开张这一段里产品做的事
 * 是 core 折账本 + 跑一轮上下文压缩 + 开 run,与屏幕上的任何一条判据无关(这道门
 * 判的全是像素位置与结构,见 `verify.mjs` 里那段判词)。
 *
 * 实测(闲机,两档各一趟):常态 / 长回 **124–126ms**(= 一个 120ms 轮询间隔,
 * 也就是「一问就在」),超量 **dev 4758 / prod 4001ms** —— 那 4 秒是 50.9MB 账本
 * 折出来 + 压缩那一发的往返。定 30_000 的那一版在机器重载时崩过一次(2026-09-15,
 * 同机连跑十几趟门之后,swap 吃满):**最慢那一档的 6 倍都不够**,所以这里按
 * 「最慢那一档 × 25」取整到 120s —— 三倍(≈14s)挡不住已经发生过的那一次。
 * 它仍然比这一档自己的收场闸(300s)小一个身位,所以真卡死了照样在这一格上报,
 * 不会拖到收场那一格才显形。
 *
 * **一个常数服务三档**:定的是最慢那一档,快的两档白拿一点余量 —— 分档写就是
 * 三个数、三处判词,而它们要答的是同一个问题(机器忙不忙)。
 */
const OPEN_TIMEOUT_MS = 120_000

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
 * **长回那一支自己的思考段**(2026-09-15 单 B ④ 补的夹具)。
 *
 * 病历:④「收尾锚定折叠」第一版把断言挂在常态与长回上,可这两支的假 provider
 * **只吐正文、一个 reasoning 字节都不吐** —— 屏幕上根本没有思考段,收尾那一帧没有
 * 任何东西在折,锚点位移恒为 0.0px。**一条恒绿的断言不是守卫**:反证(把补偿那一句
 * 拆掉重跑)照样全绿,当场证伪了它。而真有思考的那一支(超量 20 万字)那一帧长达
 * 一秒多、窗口里只采到一两帧,只报不判。所以长回这一支要自己长出一段**看得见、
 * 采得到**的思考:
 *  · 6,000 字 ≈ 展开两三千像素,收尾折回一行是一次真正的大收缩(正是 §0 那条病的
 *    小号版本);
 *  · 16ms 一帧满速吐完约 1.5s,整支仍然是小会话、帧率满格,收尾那一帧采得到几十帧;
 *  · 排在正文**之前**,所以「座位被吃到 0」那一刻照旧发生(⑥ 一个字不动)。
 */
const LONG_THOUGHT = Array.from(
  { length: 40 },
  (_, i) => `第 ${i + 1} 段思考:这一段存在的理由是让收尾那一帧真的有东西可折 —— `
    + '思考段流式期间展开、收尾自动折回一行,而那一下如果没人钉住视口,人正在读的'
    + '那一行会当场往上抽走一大截(正本 §0 三处病之二)。',
).join('\n')

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
      /*
       * **重试那一轮带的还是同一个记号**(它重跑的就是那条消息),所以正文那两支
       * 各服务**两次**:第一次是那一轮本身,第二次是重试。第三次起(自动起名把整份
       * 历史拼进请求)照旧空手收尾。思考那一支只服务一次 —— 没人重试它,而多吐一遍
       * 20 万字要多花 35 秒。
       */
      const first = (normal && state.normalServed < 2)
        || (long && state.longServed < 2)
        || (thought && !state.thoughtServed)
      if (normal) state.normalServed += 1
      if (long) state.longServed += 1
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
        /*
         * 长回那一支先吐一段思考(判词在 `LONG_THOUGHT`):④ 要量的那一下折叠,
         * 只有屏幕上真有一段展开着的思考时才发生。满速 16ms,与合批同拍。
         */
        if (long) {
          /*
           * **开头那几段走慢档**,理由与超量那一支逐字相同:满速吐,座位(518px)
           * 会在换手那 250ms 的窗口里就被吃光,② 量到的就不再是「换手那一下」而是
           * 「座位满了之后照旧跟底」(真机实测 149px)。慢档只铺开头约 1.4s。
           */
          let parts = 0
          for (let at = 0; at < LONG_THOUGHT.length; at += 90) {
            if (res.destroyed) return
            send(frame({ reasoning_content: LONG_THOUGHT.slice(at, at + 90) }))
            parts += 1
            await delay(parts <= THOUGHT_RAMP_PARTS ? THOUGHT_RAMP_GAP_MS : 16)
          }
        }
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

/**
 * 等一件事发生。**等了多久记在 `waitFor.lastMs` 上** —— 超时值该定多少,判据是
 * 「这件事实测要多久」,而那个数只有它自己说得出(判词在 `OPEN_TIMEOUT_MS`)。
 */
async function waitFor(label, predicate, timeoutMs = 30_000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) {
      waitFor.lastMs = Date.now() - started
      return last
    }
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
  await page.evaluate((captureSettled) => {
    /*
     * ── 折痕在不在,**不靠采样**(2026-09-15 改)────────────────────────────
     * 超量那一趟的等待段有 900ms,可主线程在那 900ms 里被压缩 + 扩窗 + 400 条物化
     * 占满,`requestAnimationFrame` 一共只回调**两次** —— 十三趟实测每一趟都恰好
     * 2 帧,而这一趟 0 帧:同一份产品,读数在 2 与 0 之间抛硬币,于是「折痕真的
     * 上过屏」那条断言、以及靠它切落位窗的 ① 一起变成掷骰子。
     * `MutationObserver` 的回调不在 rAF 这条线上:它在长任务结束时的微任务检查点
     * 一次性交出**期间的全部记录**,所以「折痕来过又走了」照样记得住。
     * 它只latch两件事:**来过没有**、**最后一次走是什么时候**(后者供落位窗兜底)。
     */
    window.__seatSawWaiting = false
    window.__seatWaitingGoneAt = undefined
    /*
     * ── 「这一轮在等第一个字」**2026-09-21 换了判据**(P1b 裁定 B)──────────────
     *
     * 09-15 立它时屏上真有一道在扫的线(`WaitingSeam`),09-20 G 线 P1 把那道线搬进
     * 列尾的尾槽、成了那一格的「等待」脸,而 P1b 把**那张脸整件删了** —— 用户原话
     * 「保留的尾部的 generate 不需要是一个横线,和之前的样式一致即可,且在流式过程
     * 中,生成中的这块样式布局应保持不变」。于是屏上再没有任何一个「只在等第一个字
     * 时存在」的东西可认。
     *
     * 判据因此换成产品自己那句话的同义词、也与 `gate-stream-geometry` 的 ① 逐字同源:
     * **这一轮开张了(尾槽在跑),而这一轮那条助手行还画不出东西**。
     * 量的窗口、量的东西、判的线一个字没变 —— 换的只有「怎么认出这一段」。
     */
    const leaf = window.__seatLeaf()
    const tailFace = () => leaf.querySelector('[data-tail-slot]')?.getAttribute('data-face') ?? null
    const sweeping = () => tailFace() === 'run' && !liveRowContent()
    let wasSweeping = false
    /*
     * **落位窗的右边界还要一个不靠折痕的答案**(2026-09-15,prod 真机逼出来的)。
     * 超量那一档的等待段有 900ms,可主线程在那段时间里被压缩 / 扩窗 / 400 条物化
     * 占满 —— 机器一忙,壳给这一轮提交的第一帧会**晚于第一个字**落地,于是折痕
     * 一帧都没画过(latch 与采样两边都说没有,它们是一致的,不是漏看)。
     * 折痕没画过,①「发送到首字只滚一段」的窗口就没了右边界,整轮都算进去 ——
     * 那量的不是产品,是机器忙不忙。
     * 所以再latch一格**这一轮的第一块内容什么时候上屏**:它与「首字」是同一件事,
     * 而且不管折痕有没有来得及画都成立。latch 一次就不再算(早退)。
     */
    window.__seatFirstContentAt = undefined
    /*
     * **上一轮那条助手行的身份**,开录时记一次:这只 latch 要答的是「**这一轮**的第一块
     * 内容什么时候上屏」,而回调第一次跑往往在用户气泡挂上来**之前**(输入框清空也是
     * 一次 `leaf` 里的 DOM 变动,而输入框就住在这片叶里),那一刻列尾还是上一轮那条
     * 满屏正文的助手行 —— 不认身份就会当场 latch,落位窗被切成 1 帧、① 报「0 段」
     * (dev 真机量到两次)。
     */
    const tailAssistant = () => {
      const stream = leaf.querySelector('[data-testid="chat-stream"]')
      const column = stream?.firstElementChild
      const kids = column?.children ?? []
      for (let i = kids.length - 1; i >= 0 && i >= kids.length - 7; i -= 1) {
        const el = kids[i]
        if (!el.hasAttribute('data-message-id')) continue
        if (el.getAttribute('data-role') === 'user') return null
        return el
      }
      return null
    }
    const baseLiveId = tailAssistant()?.getAttribute('data-message-id') ?? null
    function liveRowContent() {
      const row = tailAssistant()
      // 还是上一轮那一条(或者列尾还停在用户气泡上)= 这一轮的内容还没上屏。
      if (!row || row.getAttribute('data-message-id') === baseLiveId) return false
      return Boolean(row.querySelector('[data-prose], [data-testid="chat-thought"]'))
    }
    wasSweeping = sweeping()
    window.__seatSawWaiting = wasSweeping
    window.__seatSeamWatch?.disconnect()
    window.__seatSeamWatch = new MutationObserver(() => {
      const now = sweeping()
      if (now) window.__seatSawWaiting = true
      else if (wasSweeping) window.__seatWaitingGoneAt = performance.now()
      wasSweeping = now
      if (window.__seatFirstContentAt === undefined && liveRowContent()) {
        window.__seatFirstContentAt = performance.now()
      }
    })
    window.__seatSeamWatch.observe(leaf, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    })
    window.__seatFrames = []
    window.__seatStop = false
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, right: r.right }
    }
    const overlap = (a, b) => (a && b ? Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) : 0)
    /*
     * **横向相交**(G 线 P1 加的第二把尺)。③ 那句「它们不是叠起来的两层」一个字
     * 没变,变的是**它们排在哪个方向上**:等待那道线与读数行今天在**同一行**里
     * 左右并排(尾槽那一格,判词在 `content/message/TailSlot.tsx`),所以纵向相交
     * 对它们是**设计**不是病;真要守的是「别叠在一起」——那是横向的事。
     * 折痕与思考段仍然在消息行里、与读数行上下排,那一对照旧量纵向。
     */
    const overlapX = (a, b) => (a && b ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) : 0)
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
    /*
     * **视口内第一块在读的东西**(单 B ④ 的锚)—— 与产品那一侧的 `pickFoldAnchor`
     * 逐字同一条规则:列里第一件下缘还在视口内的东西,座位垫块跳过。
     * 门与产品各写一遍是有意的:产品说「我按这条规则钉」,门说「按这条规则量,
     * 它真的没动」—— 两边引用同一句话,不共享同一行代码。
     */
    const firstVisibleChild = (node, top) => {
      const kids = node.children
      let lo = 0
      let hi = kids.length - 1
      let found = null
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const el = kids[mid]
        if (el.getBoundingClientRect().bottom > top + 1) {
          found = el
          hi = mid - 1
        } else lo = mid + 1
      }
      /* 座位垫块与**尾槽**(G 线 P1 起列尾常驻的那一格)都是让出去的地,不是
         「在读的东西」—— 扫到它们就说明这一层里视口上缘之下已经没有内容了。 */
      if (!found || found.hasAttribute('data-seat') || found.hasAttribute('data-tail-slot')) return null
      return found
    }
    /*
     * **往里钻到「块」,不停在「行」上**(09-15 真机纠正的第二处量法,与产品那一侧
     * 的 `pickFoldAnchor` 同一条改判)。行不是人读的东西:一轮长回答的那条助手行
     * 从视口上面几千像素处起头,思考段折回一行时**行里的正文一动不动**,而
     * `scrollHeight` 塌了一截、浏览器把 `scrollTop` 钳回来 —— 于是**行**相对视口
     * 往下走了 1517px,正文却在原地。量行就是把这一下读成「屏幕跳了」,真机上
     * 这门第一版红的 1517px 正是它。所以一层层钻到第一件**整个**落在视口上缘之下
     * 的东西为止(段 / 正文块 / 工具卡),那才是「他正在读的那一行」所在的那一块。
     */
    const anchorOf = (scroll, kids) => {
      void kids
      const top = scroll.getBoundingClientRect().top
      let anchor = null
      let cursor = scroll.firstElementChild
      for (let depth = 0; cursor && depth < 4; depth += 1) {
        const next = firstVisibleChild(cursor, top)
        if (!next) break
        anchor = next
        if (next.getBoundingClientRect().top >= top - 1) break
        cursor = next
      }
      return anchor
    }
    /** 这一轮那条助手行里**新建 / 移除**了几个元素(重挂 = 一批同时走又一批同时来)。 */
    const tracked = new Set()
    const tick = (t) => {
      if (window.__seatStop) return
      const scroll = liveStream()
      const column = scroll?.firstElementChild
      if (scroll && column) {
        const kids = column.children
        let live = null // 这一轮的助手那一行(列尾,座位垫块之后往回数)
        let user = null // 这一轮自己那条气泡
        let ctxRow = null // 这一轮那道上下文更新折痕所在的行
        let retiringRow = null // 正在上折的那条旧回答(`.rowRetiring`)
        for (let i = kids.length - 1; i >= 0 && i >= kids.length - 7; i -= 1) {
          const el = kids[i]
          if (el.hasAttribute('data-seat')) continue
          /*
           * **这一格只有壳给得出**:`.rowRetiring` 挂上去的唯一判据是那格
           * `retryPending`(账本此刻一个字都没变)。账本那条路改不出它 —— 所以它是
           * 「按下即开槽」唯一量得出差别的读数(判词在 ⑥ 那两条断言上)。
           * CSS Module 在两档下都把类名留在哈希里(prod 实测 `_rowRetiring_ttaw1_325`)。
           */
          if (!retiringRow && typeof el.className === 'string' && el.className.includes('Retiring')) {
            retiringRow = el
          }
          if (!ctxRow && el.hasAttribute('data-context-of')) ctxRow = el
          if (!user && el.getAttribute('data-role') === 'user') user = el
          if (!live && el.hasAttribute('data-message-id') && el.getAttribute('data-role') !== 'user') live = el
        }
        /*
         * **读数行住在列尾那一格尾槽里**(G 线 P1,2026-09-20)。它从前长在活消息行
         * 的末尾、跟着正文下缘走 —— 正本 `docs/stream-geometry-2026-09.md` §0 的病 ④:
         * 首字那一帧被推下 52–158px,长思考那一轮全程动 303 次、单帧最大 335px。
         * 今天它与那枚呼吸光标同格同高、只换 opacity,所以这一句从「在那条助手行里找」
         * 改成「在列尾那一格里找」。③ 那条「读数行与折痕 / 思考段从不相交」因此变成
         * 一条**结构上**恒真的话(它们连父节点都不同了)—— 留着它当回归闸。
         */
        const tailSlot = column.querySelector(':scope > [data-tail-slot]')
        const readout = rect(tailSlot?.querySelector('[data-testid="chat-readout"]') ?? null)
        /*
         * ── 「这一轮在等第一个字」**2026-09-21 起没有对应的图形了**(P1b 裁定 B)──
         *
         * 那道折痕(`WaitingSeam`)连同尾槽的「等待」脸一起退役:从开张到收场,
         * 列尾那一格逐字不变。判据因此换成「尾槽在跑 ∧ 这一轮那条助手行还画不出
         * 东西」,与 MutationObserver 那一侧、以及 `gate-stream-geometry` 的 ① 同源。
         *
         * 推论:③ 那两把尺里的「等待线 vs 读数行横向不许相交」**没有被量的对象了**,
         * 所以 `waitingRect` 恒为 null、那一格恒 0 —— 它留在式子里只是不必特判,
         * 真正还在守的是「折痕 / 思考段与读数行纵向不相交」那一句。
         */
        /*
         * **「这一轮还在跑」问尾槽那一格自己**(2026-09-21,判词全文在
         * `gate-stream-geometry.mjs` 同一句上):P1b 裁定 C 之后收场是「原地淡出
         * `--dur-exit` 再卸载」,停止钮因此比 run 多活 120ms —— 拿它当判据会把
         * 落定那一帧的重排算进流式期(超量那一档它是 80–250ms)。
         * 取不到那一格才退回问停止钮。
         */
        const running = tailSlot
          ? tailSlot.getAttribute('data-face') === 'run'
          : Boolean(tailSlot?.querySelector('[data-testid="chat-stop"]'))
        const liveHasContent = Boolean(live?.querySelector('[data-prose], [data-testid="chat-thought"], [data-tool-card]'))
        const waiting = null
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
        /*
         * 座位垫块。**G 线 P1 起它不再是列的最后一格** —— 尾槽(`data-tail-slot`,
         * 整列末尾常驻的那一格读数 / 光标 / 等待线)排在它后面,判词在正本
         * `docs/stream-geometry-2026-09.md` §3.1。所以这里从列尾**往回找**它,
         * 而不是认死「最后一格」(认死那一句今天会把尾槽当成座位,量出来恒是 null)。
         */
        let seat = null
        for (let i = kids.length - 1; i >= 0 && i >= kids.length - 3; i -= 1) {
          if (kids[i].hasAttribute('data-seat')) { seat = kids[i]; break }
        }
        const anchor = rect(anchorOf(scroll, kids))
        let created = 0
        let removed = 0
        if (live) {
          for (const el of live.querySelectorAll('*')) {
            if (!tracked.has(el)) {
              tracked.add(el)
              created += 1
            }
          }
          for (const el of tracked) {
            if (!el.isConnected) {
              tracked.delete(el)
              removed += 1
            }
          }
        }
        const frame = {
          retiring: Boolean(retiringRow),
          anchor,
          created,
          removed,
          thoughtOpen: live?.querySelector('[data-testid="chat-thought"]')?.getAttribute('aria-expanded') ?? null,
          t,
          st: scroll.scrollTop,
          sh: scroll.scrollHeight,
          ch: scroll.clientHeight,
          user: rect(user),
          readout,
          /*
           * 「这一轮在等第一个字」= **尾槽在跑,而这一轮那条助手行还画不出东西**
           * (判词整段在上面那个 `running` / `liveHasContent` 上)。
           * 上下文更新折痕那一格 `seamRunning` 留着只报不判:它自 G 线 P1 起恒
           * `settled`(「等待指示只留一处」),所以它今天永远是 false。
           */
          waiting: (running && !liveHasContent) || Boolean(seamRunning),
          // ③ 读数行与折痕 / 思考段相交了多少(它们是前后排的两行,该恒为 0)
          /*
           * ③ 两把尺(判词在 `overlapX` 上):
           *  · 等待那道线与读数行同一行左右并排 → **横向**不许相交;
           *  · 折痕 / 思考段与读数行上下排(前者在消息行里,后者在列尾那一格)
           *    → **纵向**不许相交,这一句与 09-15 立它时逐字相同。
           */
          overlap: Math.max(
            overlapX(readout, rect(waiting)),
            overlap(readout, rect(seam)),
            overlap(readout, thought),
          ),
          seat: seat ? seat.getBoundingClientRect().height : null,
          /*
           * **「这一轮在跑」问的是尾槽那一格,不是那条助手行**(G 线 P1)。
           * 停止钮随读数行一起搬进了列尾那一格;还在那条助手行里问的话,
           * 这一格恒为 false —— 整门的收尾窗当场变成 0 帧,而那一族断言里
           * 「收尾那一帧采到了」正是为这种情形立的(§9.2 最后一条)。
           */
          streaming: running,
        }
        window.__seatFrames.push(frame)
        if (captureSettled) {
          frame.translate = live?.style.translate
          setTimeout(() => {
            frame.afterTask = {
              t: performance.now(), st: scroll.scrollTop, sh: scroll.scrollHeight,
              readout: rect(column.querySelector(':scope > [data-tail-slot] [data-testid="chat-readout"]') ?? null),
              translate: live?.style.translate,
            }
          }, 0)
        }
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, process.argv.includes('--follow-trace'))
}

async function stopSampler(page) {
  return page.evaluate(() => {
    window.__seatStop = true
    window.__seatSeamWatch?.disconnect()
    return {
      frames: window.__seatFrames ?? [],
      sawWaiting: Boolean(window.__seatSawWaiting),
      waitingGoneAt: window.__seatWaitingGoneAt,
      firstContentAt: window.__seatFirstContentAt,
    }
  })
}

/**
 * **收摊之后那条助手行还翻不翻腾**(单 B ④ 的第二格判据)。
 *
 * 逐帧采样那一只答不了这个问题:它每帧只看得见「此刻树上有谁」,一件东西**在两次
 * 采样之间**摘掉再挂回来,它一个字都看不见 —— 而重挂正是这个形(病历在
 * `scripts/probe-stream-end.mjs`:一批同时走、一批同时来)。所以这一格换一只
 * `MutationObserver`:它记的是**事件**,漏不掉。
 *
 * 窗口从**采样停掉之后**开始数,不含收尾那一帧自己 —— 那一帧本来就该有增删
 * (收场通知挂上来、读数行摘掉),要判的是「那之后还动不动」。
 */
async function startChurnWatch(page) {
  return page.evaluate(() => {
    const leaf = window.__seatLeaf()
    const rows = leaf.querySelectorAll('[data-testid="chat-stream"] [data-message-id]')
    const row = rows[rows.length - 1]
    if (!row) return false
    window.__seatChurn = { added: 0, removed: 0 }
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        window.__seatChurn.added += r.addedNodes.length
        window.__seatChurn.removed += r.removedNodes.length
      }
    })
    mo.observe(row, { childList: true, subtree: true })
    window.__seatChurnStop = () => {
      mo.disconnect()
      return window.__seatChurn
    }
    return true
  })
}

async function stopChurnWatch(page) {
  return page.evaluate(() =>
    (window.__seatChurnStop ? window.__seatChurnStop() : { added: 0, removed: 0 }))
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
 * 一段 = 一串**连续在变**的帧,中间静过 `QUIET_MS` 就算断开,而且**至少走够 1px**。
 * 落到置顶线那一下是逐帧插值(缓出的末几帧可能连着几帧一动不动),所以静默门槛取
 * 得比它宽;座位缩一截与内容长一截差**一帧**(量在观察器里、写在下一帧),那一帧
 * 里浏览器按新的 `scrollHeight` 把 `scrollTop` 亚像素地钳一下 —— 实测 0.6px,
 * 肉眼与产品语义上都不是一次滚动,另记一格报出来。同一条判词在检索面那条分页
 * 不变量上写过:**反证要数滚动指令的次数,不是量 `scrollTop`**。
 */
/**
 * 一段滚动与下一段之间**静多久算断开** —— 单位是**毫秒,不是帧**(2026-09-15 改)。
 *
 * 病历:原先写的是「静过 4 **帧**」。400 条 / 50MB 那条会话上,一轮开张前后主线程
 * 被压缩 + 扩窗 + 物化占满,采样间隔从 8ms 掉到**一秒多** —— 4 帧于是等于 5 秒,
 * 相隔 1.3 秒的两件事(t=3233 的扩窗补位与 t=4575 的内容落地)被并成**同一段**,
 * 而合并之后那一段的两端气泡差 189px,于是「屏幕真的动了」那道筛子放它过去,
 * ① 判红。判据不许跟着采样率变:**帧不是时间**。
 *
 * 100ms:比一帧(8–16ms)大一个量级,所以落到置顶线那一段(每帧都在动)仍是一段;
 * 比「座位漏了」那种每段 delta 贴一次底的间隔(`REPLY_GAP_MS` 120ms)小,所以那一族
 * 照旧一段一段分得开 —— 反证因此仍然红。
 */
const QUIET_MS = 100
const RUN_MIN_PX = 1

/** 一段窗口里的读数。窗口由调用方切,这只函数只负责算。 */
function measure(frames) {
  const all = []
  let lastMovedAt
  let lastMovedIdx = -1
  for (let i = 1; i < frames.length; i += 1) {
    const moved = Math.abs(frames[i].st - frames[i - 1].st) > 0.5
    if (!moved) continue
    /*
     * **断开要看得见地停过**(2026-09-15 单 B 补的第二半):既要静够 `QUIET_MS`,
     * 又要**至少有一帧采到它没动**(`i - 1 > lastMovedIdx`)。
     *
     * 病历:超量那一趟落位那一段里有一帧长达 1125ms(400 条的首屏重排),那段时间
     * `requestAnimationFrame` 一次都没回调 —— 采样器什么都没看见。只按时间判,这一下
     * 「没采到样」被读成「停了一秒」,一段连续的落位插值于是被劈成两段
     * (`11619→11887` / `11887→12214`,两端首尾相接),① 判红 —— 红的不是产品,是
     * 那一帧太长。**没采到 ≠ 停住**:真的停过,以这里 100fps 的采样率必然留下至少
     * 一帧「没动」的样本(反证那一族「每段 delta 贴一次底」间隔 `REPLY_GAP_MS` 120ms,
     * 中间有十几帧不动),所以这一条收紧不掉反证、只挡住「没看见」。
     */
    const quiet = lastMovedAt === undefined
      || (frames[i].t - lastMovedAt > QUIET_MS && i - 1 > lastMovedIdx)
    if (quiet) all.push({ from: frames[i - 1].st, to: frames[i].st, at: i - 1, until: i })
    else {
      all[all.length - 1].to = frames[i].st
      all[all.length - 1].until = i
    }
    lastMovedAt = frames[i].t
    lastMovedIdx = i
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
  if (process.argv.includes('--trace')) {
    for (const r of all) {
      const a = frames[r.at]
      const b = frames[r.until]
      console.log(`        run ${r.from.toFixed(0)}→${r.to.toFixed(0)}`
        + ` t ${Math.round(a.t - frames[0].t)}→${Math.round(b.t - frames[0].t)}`
        + ` user ${a.user ? a.user.top.toFixed(1) : 'null'}→${b.user ? b.user.top.toFixed(1) : 'null'}`
        + ` seat ${a.seat}→${b.seat}`)
    }
  }
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

/**
 * 重试那一段自己的三个读数(单 B ⑥)。
 *
 * 与 `analyze` 分开是因为它们都以**按下那一刻**为原点,而 `analyze` 说的是
 * 「这一轮」——两个原点,两只函数,不把一个塞进另一个的参数里。
 */
function retryMetrics(frames, pressedAt) {
  const retryAt = frames.findIndex((f) => f.t >= pressedAt)
  if (retryAt < 0) return { retryAt: -1, retryFrames: 0, retryShift: 0, seamAtMs: undefined }
  const base = frames[retryAt].user?.top
  const until = frames[retryAt].t + 300
  let retryShift = 0
  let retryFrames = 0
  for (let i = retryAt; i < frames.length && frames[i].t <= until; i += 1) {
    retryFrames += 1
    const top = frames[i].user?.top
    if (base === undefined || base === null || top === undefined || top === null) continue
    retryShift = Math.max(retryShift, Math.abs(top - base))
  }
  /* 「按下即开槽」:按下之后多久屏幕上真的有一道在扫的折痕。 */
  const seam = frames.findIndex((f, i) => i >= retryAt && f.waiting)
  /*
   * 同一句话的**另一半,也是量得出差别的那一半**:旧回答多久开始上折。
   * 折痕那一格在这台机器上分不出治没治 —— 假 provider + 同进程 core,账本删旧回复、
   * 开新 run 只要一帧(反证:把 `retryPending` 那条路整个拆掉重跑,折痕照旧 17ms
   * 就在扫,因为那已经是新一轮自己的折痕了)。而 `.rowRetiring` 只有壳给得出。
   */
  const retire = frames.findIndex((f, i) => i >= retryAt && f.retiring)
  /*
   * 按下那一刻气泡在不在视口里 —— 规矩 ⑥ 两档的判据(`landOnRetry` 那一句)。
   * 在:一像素不动;不在:**有控制地**滑到置顶线(一段,不是浏览器随手钳一下)。
   */
  const at = frames[retryAt]
  const bubbleVisible = at.user !== null && at.user !== undefined
    && at.user.top >= -1 && at.user.top < 2000
  /*
   * 落位那一段的窗口**比 300ms 宽**:按下那一拍只开槽(折痕在扫、旧回答开始上折),
   * 真正落到置顶线是在 core 把旧回复删掉、新一轮开张之后(判词在 `landOnRetry` 的
   * 那只 effect 上)。1.5s 盖得住「上折 180ms + 一趟命令往返 + 滑动 ≤320ms」。
   */
  const LAND_WINDOW_MS = 1500
  /*
   * ── 窗口的右边界还要一句「座位长满了没有」(2026-09-21,P1b 裁定 A)──────────
   * 起手那一格从「视口剩下的全部」改成六行之后,重试那一轮的座位在落位之后**几百
   * 毫秒**就被吃光(真机:20 → 0px),之后 pinned 跟底当场接手 —— 那是设计,
   * 不是「又滑了一段」。这一条判的是「落位只滑一段」,所以窗口到座位长满为止;
   * 按下那一刻座位已经是 0(没有座位可护)时照旧用整个 1.5s。
   */
  let landUntil = frames.length
  let sawRetrySeat = false
  for (let i = retryAt; i < frames.length; i += 1) {
    if (typeof frames[i].seat !== 'number') continue
    if (frames[i].seat > 0) { sawRetrySeat = true; continue }
    if (sawRetrySeat) { landUntil = i; break }
  }
  const window = frames.filter((f, i) =>
    i < landUntil && f.t >= frames[retryAt].t && f.t <= frames[retryAt].t + LAND_WINDOW_MS)
  const retryRuns = measure(window).scrollRuns
  /* 落定之后气泡停在哪(置顶线 24 附近)。窗口末帧就够 —— 滑动 ≤320ms。 */
  const landed = window[window.length - 1]?.user?.top
  return {
    retryAt,
    retryFrames,
    retryShift,
    retryRuns,
    retryBubbleVisible: bubbleVisible,
    retryLandedTop: landed === null || landed === undefined ? undefined : landed,
    retryViewport: window[window.length - 1]?.ch,
    seamAtMs: seam >= 0 ? Math.round(frames[seam].t - frames[retryAt].t) : undefined,
    retireAtMs: retire >= 0 ? Math.round(frames[retire].t - frames[retryAt].t) : undefined,
  }
}

function analyze(frames, marks = {}) {
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
  /*
   * 落位窗的右边界:先问采样,采样没看见就问那只 `MutationObserver` 记下的
   * 「折痕最后一次走是什么时候」(判词在 `startSampler` 的 latch 上)。两者都没有
   * 才退回整轮 —— 那时候 ① 量的就不是落位窗了,所以上面那条「折痕真的上过屏」
   * 必须与它同生共死。
   */
  const sampledWaiting = frames.map((f) => f.waiting).lastIndexOf(true)
  let lastWaiting = sampledWaiting
  const cutAt = marks.waitingGoneAt ?? marks.firstContentAt
  if (lastWaiting < 0 && cutAt !== undefined) {
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      if (frames[i].t <= cutAt) { lastWaiting = i; break }
    }
  }
  const landing = measure(frames.slice(0, lastWaiting >= 0 ? lastWaiting + 1 : frames.length))
  const whole = measure(frames)
  /*
   * ── **座位窗**:座位长满之前那一段(2026-09-21 P1b 裁定 A 之后分出来的第三个窗)──
   *
   * 规矩 ① 的后半句是「之后视口不动,**直到座位长满**」。09-15 立这道门时起手那一格
   * 是「气泡让开之后视口剩下的全部」(518px),常态那一档一轮回答根本吃不满它,
   * 于是「整轮」与「座位窗」恰好是同一段 —— 那条断言因此写成了「整轮一像素不动」。
   *
   * P1b 把起手改成**六行封顶**(≈134px,用户:「留出合适的空间就可以,不需要一个
   * 很大的空间」),同一段回答几段就把它吃光,之后照旧 pinned 跟底 —— **那是设计**
   * (§5 表 1 最后一格),不是回归。所以这一段的判据回到规矩 ① 自己那句话:
   * **座位长满之前只滚一段**;长满之后的滚动只报不判(与超量那一档从来就是的口径
   * 逐字相同)。`BUDGET.scrollRuns` 一个字没动 —— 改的是「量哪一段」,不是放宽。
   */
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
  /*
   * ── ④ 读数行 400ms 内先上后下(抖)───────────────────────────────────────
   *
   * **2026-09-15 改了两处**,起因是用户报「尾部的正在生成在有内容时还是有抖动」
   * 而这道门一片绿:①阈值原本是 `2px`,而真机上那一抖是 **0.1–0.4px**(整轮 400 次
   * 方向反转,单次最大 0.6px)—— 一条看不见亚像素的判据,判的是另一回事;
   * ②它原本只在常态与重试两档判,而常态那一档座位从头到尾没长满(518→324),
   * 抖得最凶的那一段(座位被吃光、回到普通跟底)在**长回**那一档,没人判。
   *
   * **窗口:量的是「它本该站着不动」的那一段**。读数行有两处**该动**:
   *   · 落位段(等待 → 首字换手):那一段整块内容在换手,它跟着走;
   *   · 座位归零前后(§9.2 已有判词):内容往下长、页面跟底,它一去一回本来就是
   *     设计 —— 那一刻由 `seatZeroFlips` 拿**视口**(`st` / 气泡)去判,不拿这条线。
   * 两段都剔掉,剩下的就是「内容在长,而它该站着不动」的那一段 —— 也正是人眼盯着
   * 的那一段。剔法与 §9.2 那条「一条恒绿的断言不是守卫」配套:窗口里有几帧一并
   * 报出来,断言先判「量到没量到」。
   */
  /**
   * **多小算没动**。`getBoundingClientRect` 报的是 `LayoutUnit`,量子是 **1/64 px
   * = 0.015625** —— 位置真没变时两帧读出来的是**同一个数**,噪声一格都没有。所以这个
   * 阈值只要①比那个量子大(约三倍,采样自己的舍入进不来)、②比任何一档 dpr 的**半个
   * 设备像素**小(抖的幅度就是它:dpr 2 上 0.25、dpr 4 上 0.125)即可。0.05 同时满足,
   * 也是种子探针用的那个数。实测复核:治后 1843 帧读数行 `top` 恒为 `605.000`
   * (逐字相同),离这条线还有整整一位数 —— 它不会被噪声刷红。
   */
  const READOUT_FLIP_EPS = 0.05
  const flipFrom = lastWaiting >= 0 ? lastWaiting + 1 : 1
  const seatZeroT = seatZeroAt >= 0 ? frames[seatZeroAt].t : undefined
  let lastDir = 0
  let lastT = 0
  let flips = 0
  let flipFrames = 0
  const flipSamples = []
  for (let i = Math.max(1, flipFrom); i < frames.length; i += 1) {
    if (seatZeroT !== undefined && Math.abs(frames[i].t - seatZeroT) <= ZERO_WINDOW_MS) continue
    const a = frames[i - 1].readout?.top
    const b = frames[i].readout?.top
    if (a === undefined || b === undefined || a === null || b === null) continue
    flipFrames += 1
    const d = b - a
    if (Math.abs(d) < READOUT_FLIP_EPS) continue
    const dir = Math.sign(d)
    if (lastDir && dir !== lastDir && frames[i].t - lastT < 400) {
      flips += 1
      if (flipSamples.length < 5) {
        flipSamples.push(`${(frames[i].t / 1000).toFixed(2)}s ${a.toFixed(2)}→${b.toFixed(2)}`)
        if (process.argv.includes('--follow-trace')) console.log('[follow-trace]', JSON.stringify(frames.slice(Math.max(0, i - 3), i + 2)))
      }
    }
    lastDir = dir
    lastT = frames[i].t
  }
  /*
   * ── ④ 收尾锚定折叠(单 B ④)──────────────────────────────────────────────
   * 收尾那一帧起 `END_WINDOW_MS` 内,**视口内第一块在读的东西**不许动。
   * 治前的样子(§0 三处病之二):思考段一帧从 6 万像素缩成一行,上一条用户消息的
   * top 从 −60,879 跳到 −286 —— 那一跳落在这一格上。
   *
   * 「收尾那一帧」= `streaming` 从真翻假那一帧(停止钮下屏)。折叠是从那儿起算的:
   * `live` 翻 false → 思考段那只 effect 折 → FLIP + fold-hold。
   */
  const END_WINDOW_MS = 300
  let endAt = -1
  for (let i = 1; i < frames.length; i += 1) {
    if (frames[i - 1].streaming && !frames[i].streaming) {
      endAt = i
      break
    }
  }
  let endAnchorShift = 0
  let endScrollMin = Number.POSITIVE_INFINITY
  let endFrames = 0
  if (endAt >= 0) {
    const base = frames[endAt].anchor?.top
    const until = frames[endAt].t + END_WINDOW_MS
    for (let i = endAt; i < frames.length && frames[i].t <= until; i += 1) {
      endFrames += 1
      endScrollMin = Math.min(endScrollMin, frames[i].st)
      const top = frames[i].anchor?.top
      if (base === undefined || base === null || top === undefined || top === null) continue
      endAnchorShift = Math.max(endAnchorShift, Math.abs(top - base))
    }
  }
  /*
   * **收尾之后 DOM 不许再翻腾**(判据抄 `scripts/probe-stream-end.mjs`:重挂 =
   * 一批同时移除又一批同时新建)。收尾那一帧起到采样结束,这一轮那条助手行里
   * 新建 / 移除的元素数应当归零 —— 折叠换的是**高度**,不是一棵新树。
   * 那一帧自己不算(换脸、折叠都在那一帧提交,本来就该有增删)。
   */
  let churnAfterEnd = 0
  if (endAt >= 0) {
    for (let i = endAt + 1; i < frames.length; i += 1) {
      churnAfterEnd += (frames[i].created ?? 0) + (frames[i].removed ?? 0)
    }
  }
  const seats = frames.map((f) => f.seat).filter((v) => typeof v === 'number')
  /**
   * 座位窗 = 开录 → 座位归零**之前**那一帧(从来没归零就是整轮)。
   *
   * **不含归零那一帧自己**:座位吃光的那一下 pinned 跟底当场接手,那一帧的滚动是
   * 「长满之后照旧跟底」的第一下(§5 表 1 最后一格),它属于长满之后那一段。
   * 含进来就是拿「这一段结束的那一刻」去判「这一段里不许发生的事」。
   */
  const seatHeld = measure(frames.slice(0, seatZeroAt >= 0 ? seatZeroAt : frames.length))
  return {
    seatHeld,
    /** 折痕**来过没有** —— 由 DOM 记录答,不由采到几帧答。 */
    sawWaiting: marks.sawWaiting ?? sampledWaiting >= 0,
    endAt,
    endFrames,
    endAnchorShift,
    endScrollMin: Number.isFinite(endScrollMin) ? endScrollMin : -1,
    churnAfterEnd,
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
    /* ②/②b 的座位窗读数(判词与 ① 同一段:座位长满之后气泡本来就该跟着走)。 */
    seatHeldFirstTokenShift: seatHeld.firstTokenShift,
    seatHeldDrift: seatHeld.drift,
    seatHeldDriftFrames: seatHeld.driftFrames,
    seatHeldFrames: seatHeld.frames,
    // ③ 读数行与折痕 / 思考段相交的帧(整轮)。
    overlapFrames: frames.filter((f) => f.overlap > 0.5).length,
    overlapMax: Math.max(0, ...frames.map((f) => f.overlap)),
    readoutFlips: flips,
    /** ④ 的窗口里有几帧 —— 「量到没量到」那一支的读数(§9.2 最后一条)。 */
    readoutFlipFrames: flipFrames,
    readoutFlipEps: READOUT_FLIP_EPS,
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
    `      ${' '.repeat(name.length)}  座位窗 ${m.seatHeld.frames} 帧:滚动 ${m.seatHeld.scrollRuns} 段`
    + ` · 整轮流式 ${m.streamFrames} 帧:滚动 ${m.whole.scrollRuns} 段`
    + ` · >50ms 长帧 ${m.whole.longFrames}(最长 ${m.whole.longestFrameMs}ms)`
    + ` · 座位归零`
    + (m.seatZeroAt >= 0 ? `前后 ${m.seatZeroFrames} 帧反转 ${m.seatZeroFlips}` : '没发生'),
  )
  console.log(
    `      ${' '.repeat(name.length)}  收尾窗 ${m.endFrames} 帧:锚点位移 ${m.endAnchorShift.toFixed(1)}px`
    + ` · 折叠中 scrollTop 最低 ${m.endScrollMin.toFixed(0)} · 收尾之后 DOM 增删 ${m.churnAfterEnd}`
    + (m.churnWatch === undefined ? '' : ` · 收摊后 ${CHURN_WATCH_MS / 1000}s 内增删 ${m.churnWatch}`)
    + (m.laneMs === undefined ? '' : ` · 这一档 ${(m.laneMs / 1000).toFixed(1)}s`),
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
  const providerState = { normalServed: 0, longServed: 0, thoughtServed: false }
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
    // Diagnostic control: restore the original row containment in this isolated renderer only.
    if (process.argv.includes('--containment-baseline')) {
      await page.addStyleTag({ content: '[data-message-id] { content-visibility: auto !important; }' })
    }
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
     * **按下重试,逐帧录到这一轮收场**(单 B ⑥)。
     *
     * 走的是真钮(`chat-action-retry`),不是直接发命令 —— 「按下即开槽」量的正是
     * 按下与屏幕有回音之间那一段,而那一段的产地是壳自己那格 `retryPending`
     * (`command:retry-message` 发出去之后账本还什么都没有)。
     */
    const runRetry = async (page) => {
      const runStartedAt = Date.now()
      await startSampler(page)
      const pressed = await page.evaluate(() => {
        const leaf = window.__seatLeaf()
        const rows = leaf.querySelectorAll('[data-testid="chat-stream"] [data-message-id]')
        /*
         * **按下之前给自己那条气泡盖个戳**(单 B ⑥ 那句「账本换手时用户行不重挂」)。
         * core 的 retry 是**删掉旧回复 + 截断其后 + 开新 run**,账本在那一瞬换手;
         * 用户行的 key 没变,React 就该原地复用同一个 DOM 节点 —— 重挂的话它上面
         * 这个戳(一个 expando,不进 DOM 属性、不影响样式与选择器)就没了。
         */
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i].getAttribute('data-role') === 'user') {
            rows[i].__seatUserMark = 1
            break
          }
        }
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const button = rows[i].querySelector('[data-testid="chat-action-retry"]')
          if (button instanceof HTMLButtonElement && !button.disabled) {
            window.__seatRetryAt = performance.now()
            button.click()
            return true
          }
        }
        return false
      })
      if (!pressed) throw new Error('重试钮点不动(不在场或者两道闸禁着)')
      const stopShown = () =>
        page.evaluate(() =>
          Boolean(window.__seatLeaf()
            .querySelector('[data-testid="chat-stream"] [data-testid="chat-stop"]')))
      await waitFor('重试这一轮开张(停止钮上屏)', stopShown, OPEN_TIMEOUT_MS)
      await waitFor('重试这一轮收场(停止钮下屏)', async () => !(await stopShown()), 120_000)
      await delay(600)
      const { frames, ...marks } = await stopSampler(page)
      /* 戳还在不在 = 账本换手那一下用户行有没有被重挂(判词在盖戳那一处)。 */
      const userKept = await page.evaluate(() => {
        const leaf = window.__seatLeaf()
        const rows = leaf.querySelectorAll('[data-testid="chat-stream"] [data-message-id]')
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i].getAttribute('data-role') === 'user') return rows[i].__seatUserMark === 1
        }
        return false
      })
      const watching = await startChurnWatch(page)
      await delay(CHURN_WATCH_MS)
      const churn = watching ? await stopChurnWatch(page) : { added: 0, removed: 0 }
      const pressedAt = await page.evaluate(() => window.__seatRetryAt ?? 0)
      return {
        ...analyze(frames, marks),
        ...retryMetrics(frames, pressedAt),
        churnWatch: churn.added + churn.removed,
        userKept,
        laneMs: Date.now() - runStartedAt,
      }
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
      const runStartedAt = Date.now()
      await startSampler(page)
      await sendViaComposer(page, text)
      // 同一条判据:问的是**屏上那一片**在不在跑(停靠池里那几片不算)。
      const stopShown = () =>
        page.evaluate(() =>
          Boolean(window.__seatLeaf()
            .querySelector('[data-testid="chat-stream"] [data-testid="chat-stop"]')))
      await waitFor('这一轮开张(停止钮上屏)', stopShown, OPEN_TIMEOUT_MS)
      const openMs = waitFor.lastMs
      await waitFor('这一轮收场(停止钮下屏)', async () => !(await stopShown()), timeoutMs)
      console.log(`      开张 ${openMs}ms(闸 ${OPEN_TIMEOUT_MS}ms)`)
      // 收场那一下的重排也录进来(思考折回一行就发生在这几帧里)。
      await delay(600)
      const { frames, ...marks } = await stopSampler(page)
      /*
       * 收摊之后再盯 `CHURN_WATCH_MS`:这一轮那条助手行上一个节点都不许增删
       * (判词在 `startChurnWatch`)。折叠换的是高度,不是一棵新树。
       */
      const watching = await startChurnWatch(page)
      await delay(CHURN_WATCH_MS)
      const churn = watching ? await stopChurnWatch(page) : { added: 0, removed: 0 }
      const out = {
        ...analyze(frames, marks),
        churnWatch: churn.added + churn.removed,
        // 这一档在墙上钟里占多久 —— verify 里它是最贵的一条,谁贵得说得出来。
        laneMs: Date.now() - runStartedAt,
      }
      if (process.argv.includes('--trace')) {
        const t0 = frames[0]?.t ?? 0
        const row = (f) => [
          Math.round(f.t - t0),
          Number(f.st.toFixed(1)),
          f.user ? Number(f.user.top.toFixed(1)) : null,
          f.seat === null ? -1 : Number(f.seat.toFixed(1)),
          f.readout ? Number(f.readout.top.toFixed(1)) : null,
        ]
        {
          /* 落位窗那一段的原始帧 —— ① 判红时要看得见是哪一段在动。 */
          const lw = frames.map((f) => f.waiting).lastIndexOf(true)
          const end = lw >= 0 ? lw + 1 : frames.length
          const step = Math.max(1, Math.floor(end / 26))
          console.log('      trace(落位窗采样) [t,st,user,seat,readout]:',
            JSON.stringify(frames.slice(0, end).filter((_, i) => i % step === 0).map(row)))
        }
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
      `「在等第一个字」那一段真的采到了(录到 ${main.waitingFrames} 帧;provider 静默`
      + ` ${FIRST_BYTE_DELAY_MS}ms)。**2026-09-21 起它没有对应的图形了**(P1b 裁定 B:`
      + `等待那张脸退役,尾槽从开张到收场逐字不变),判据换成「尾槽在跑 ∧ 这一轮那条`
      + `助手行还画不出东西」`,
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
    /*
     * 2026-09-21(P1b 裁定 A):这一条从「整轮」改量**座位窗**,判词整段写在
     * `analyze` 里那个 `seatHeld` 上。一句话:起手那一格从「视口剩下的全部」改成
     * 六行之后,常态这一档的回答会**把座位吃满**,长满之后照旧跟底 —— 那是设计。
     * 规矩 ① 自己那句话就是「之后视口不动,**直到座位长满**」,所以窗口回到它。
     */
    assert(
      main.seatHeld.scrollRuns <= BUDGET.scrollRuns,
      `① 座位长满之前视口一像素不动:座位窗里只有 ${main.seatHeld.scrollRuns} 段滚动`
      + ` ≤ ${BUDGET.scrollRuns}(座位 ${main.seatMax.toFixed(0)} → ${main.seatMin.toFixed(0)}px`
      + `;整轮 ${main.whole.scrollRuns} 段 —— 长满之后照旧 pinned 跟底,只报不判)`,
    )
    /*
     * 2026-09-21(P1b 裁定 A):与 ①/②b 同一处改动 —— 窗口收到**座位窗**。
     * 换手窗本来是首字之后 250ms,而六行的座位在常态这一档**首字之后 ~300ms**
     * 就被吃光,两段有重叠;重叠的那几帧里气泡该跟着底走,不该算进「换手不动」。
     */
    assert(
      main.seatHeldFirstTokenShift <= BUDGET.firstTokenShiftPx,
      `② 等待 → 首字(座位窗内)自己那条气泡位移 ${main.seatHeldFirstTokenShift.toFixed(1)}px`
      + ` ≤ ${BUDGET.firstTokenShiftPx}(座位窗 ${main.seatHeldFrames} 帧;整轮 ${main.firstTokenShift.toFixed(1)}px`
      + ` —— 座位吃光之后跟底,只报不判)`,
    )
    assert(
      main.overlapFrames <= BUDGET.overlapFrames,
      `③ 读数行与折痕 / 思考段相交 ${main.overlapFrames} 帧 ≤ ${BUDGET.overlapFrames}(整轮)`,
    )
    assert(
      main.readoutFlipFrames > 30,
      `④ 读数行那一段真的量到了(窗口里 ${main.readoutFlipFrames} 帧,`
      + `阈值 ${main.readoutFlipEps}px)`,
    )
    assert(
      main.readoutFlips <= BUDGET.readoutFlips,
      `④ 读数行 400ms 内方向反转 ${main.readoutFlips} 次 ≤ ${BUDGET.readoutFlips}`
      + `(亚像素,阈值 ${main.readoutFlipEps}px)`
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
    /*
     * ── ②b 09-15 单 B ⑤ 落地之后**转判最远**,不只判终值 ────────────────────
     * 单 A 收工时它是「终值 0.0px / 中途最远 12.0px 一帧」,那 12px 是收尾那一帧
     * 换脸(读数行 → 动作行)与流式光标让位带来的内容收缩。单 B ⑤ 把那一行做成
     * 「三张脸同格同高」、并在收尾那一拍把座位同步补到位,两处一起把它治到 0。
     * 所以退场判据兑现:这一行从「只报不判」转正,判的是**最远**。
     */
    /*
     * 2026-09-21(P1b 裁定 A):与 ① 同一处改动 —— 窗口从「整轮」收到**座位窗**。
     * 起手那一格改成六行之后,常态这一档的回答会把座位吃满,之后 pinned 跟底把气泡
     * 顶出视口 **那是设计**(规矩 ① 那句「直到座位长满」)。预算一个字没动。
     */
    assert(
      main.seatHeldDrift <= BUDGET.firstTokenShiftPx,
      `②b 换手之后、座位长满之前,气泡一像素不动:最远 ${main.seatHeldDrift.toFixed(1)}px`
      + ` / ${main.seatHeldDriftFrames} 帧 ≤ ${BUDGET.firstTokenShiftPx}`
      + `(整轮最远 ${main.handoffDrift.toFixed(1)}px —— 座位吃光之后跟底,只报不判)`,
    )
    /*
     * ── 「收尾锚定」这一族先判**量到没量到**(2026-09-15 审查补的)────────────
     *
     * 位移那条判据有一个恒绿的逃生口:收尾那一帧没采到时 `endAt < 0`、`endFrames`
     * 为 0,`endAnchorShift` 于是**与自己比**恒为 0 —— 整条直接放行。这正是
     * `docs/thinking-stream-2026-09.md` §7.1「量法四条」第一条那句 `p95 of []` = 0:
     * **一句绿的谎话**。而收尾窗口恰恰是最脆的一格:它挂在 `streaming` 翻假那一帧上,
     * 而那一帧的钩子(停止钮在不在)会随实现漂。所以每一档都先判「窗口里有几帧」,
     * 判的是**没量到**这一支,不是位移本身;长回那一档从一开始就这么防的,
     * 常态与超量两档今天补齐。
     *
     * 标号:这一族说的是**正本 §2 规矩 ④**(收尾锚定折叠),与上面那条「④ 读数行
     * 方向反转」(单 A 的 ④)不是一件事 —— 两边都写 ④ 看报告的人会串,所以这一族
     * 一律写名字 `[收尾锚定]`,不再挂号。
     */
    assert(
      main.endAt >= 0 && main.endFrames > 1,
      `[收尾锚定] 常态:收尾那一帧采到了(窗口里 ${main.endFrames} 帧)`,
    )
    assert(
      main.endAnchorShift <= BUDGET.endAnchorShiftPx,
      `[收尾锚定] 常态收尾那一帧起 300ms,视口内第一块在读的东西位移`
      + ` ${main.endAnchorShift.toFixed(1)}px ≤ ${BUDGET.endAnchorShiftPx}`,
    )
    assert(
      main.churnWatch <= BUDGET.churnAfterEnd,
      `[收尾锚定] 常态收摊之后 ${CHURN_WATCH_MS / 1000}s,那条助手行增删`
      + ` ${main.churnWatch} 个节点 ≤ ${BUDGET.churnAfterEnd} —— 收尾折的是高度,`
      + `没人在事后重挂它`,
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
    /* 同上(P1b 裁定 A):窗口收到座位窗。 */
    assert(
      long.seatHeldFirstTokenShift <= BUDGET.firstTokenShiftPx,
      `长回 ② 等待 → 首字(座位窗内)气泡位移 ${long.seatHeldFirstTokenShift.toFixed(1)}px`
      + ` ≤ ${BUDGET.firstTokenShiftPx}(座位窗 ${long.seatHeldFrames} 帧;整轮`
      + ` ${long.firstTokenShift.toFixed(1)}px —— 只报不判)`,
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
    /*
     * ── ④ 长回这一档也要判(2026-09-15,用户报「尾部的正在生成在有内容时还是有
     * 抖动」)──────────────────────────────────────────────────────────────────
     * **这一档才是人看见的那一段**:常态那一档座位从头到尾没长满(518→324),视口
     * 一像素不动,根本抖不起来;长回这一档座位被吃光、回到普通跟底,内容每长一截
     * 就贴一次底 —— 抖就出在这里。从前它只在常态与重试两档判,于是这道门对着病灶
     * 一片绿了两天。窗口与阈值同常态那一条(落位段与座位归零那一段剔掉,
     * 判据 `READOUT_FLIP_EPS`)。
     */
    assert(
      long.readoutFlipFrames > 30,
      `长回 ④ 读数行那一段真的量到了(窗口里 ${long.readoutFlipFrames} 帧,`
      + `阈值 ${long.readoutFlipEps}px)`,
    )
    assert(
      long.readoutFlips <= BUDGET.readoutFlips,
      `长回 ④ 读数行 400ms 内方向反转 ${long.readoutFlips} 次 ≤ ${BUDGET.readoutFlips}`
      + `(亚像素,阈值 ${long.readoutFlipEps}px;座位吃光之后那一段就是人看见的那一段)`
      + (long.flipSamples.length ? `(${long.flipSamples.join(' | ')})` : ''),
    )
    assert(
      long.endAt >= 0 && long.endFrames > 1,
      `[收尾锚定] 长回:收尾那一帧采到了(窗口里 ${long.endFrames} 帧)`,
    )
    assert(
      long.endAnchorShift <= BUDGET.endAnchorShiftPx,
      `[收尾锚定] 长回收尾那一帧起 300ms,视口内第一块在读的东西位移`
      + ` ${long.endAnchorShift.toFixed(1)}px ≤ ${BUDGET.endAnchorShiftPx}`
      + ` —— 思考段折回一行,锚定把视口钉住`,
    )
    assert(
      long.churnAfterEnd <= BUDGET.churnAfterEnd,
      `[收尾锚定] 长回收尾之后 DOM 不再翻腾(那一帧之后新建 / 移除`
      + ` ${long.churnAfterEnd} 个元素 ≤ ${BUDGET.churnAfterEnd})—— 折叠换的是高度,`
      + `不是一棵新树`,
    )
    assert(
      long.churnWatch <= BUDGET.churnAfterEnd,
      `[收尾锚定] 长回收摊之后 ${CHURN_WATCH_MS / 1000}s,那条助手行增删`
      + ` ${long.churnWatch} 个节点 ≤ ${BUDGET.churnAfterEnd}`,
    )
    assert(
      long.whole.longFrames <= BUDGET.longFrames,
      `长回 ⑤ 整轮流式 >${BUDGET.longFrameMs}ms 长帧 ${long.whole.longFrames} 个 ≤ ${BUDGET.longFrames}`
      + `(最长 ${long.whole.longestFrameMs}ms)`,
    )

    /* ── ⑥ 重试:按下即开槽(单 B ⑥,正本 §2 规矩 ⑥)──────────────────────── */
    console.log('\n[常态 · 重试] 对刚收摊的那一条按重试')
    const retry = await runRetry(page)
    readings.retry = retry
    report('重试', retry)
    assert(
      retry.retryAt >= 0,
      `重试:按下那一帧采到了(窗口里 ${retry.retryFrames} 帧)`,
    )
    assert(
      retry.seamAtMs !== undefined && retry.seamAtMs <= RETRY_SEAM_MS,
      `⑥ 按下即开槽:折痕在按下后 ${retry.seamAtMs ?? '没出现'}ms 就在扫`
      + ` ≤ ${RETRY_SEAM_MS}ms —— 不等账本删完旧回复`,
    )
    assert(
      retry.retireAtMs !== undefined && retry.retireAtMs <= RETRY_SEAM_MS,
      `⑥ 按下即开槽:旧回答在按下后 ${retry.retireAtMs ?? '没开始'}ms 就在上折`
      + ` ≤ ${RETRY_SEAM_MS}ms —— 这一格只有壳那一路(retryPending)给得出`,
    )
    assert(
      retry.userKept,
      `⑥ 账本换手(删旧回复 + 截断其后 + 开新 run)那一下,自己那条用户行没被重挂`
      + `(按下之前盖的戳还在)`,
    )
    assert(
      retry.churnWatch <= BUDGET.churnAfterEnd,
      `⑥ 重试这一轮收摊之后 ${CHURN_WATCH_MS / 1000}s,那条助手行增删 ${retry.churnWatch} 个节点`
      + ` ≤ ${BUDGET.churnAfterEnd}`,
    )
    /*
     * ── ⑥ 气泡两档,判据是**按下那一刻它在不在视口里**(正本 §2 规矩 ⑥)────────
     * 在 —— 一像素不动(人正看着这条回答按的钮,屏幕不该自己跑)。
     * 不在 —— 旧回答常有一两千像素高,人是滚到底部按的钮;它一折 `scrollHeight`
     * 塌一大截,**总得有人管**。治前是浏览器随手钳(真机量到 1,419px 的跳变),
     * 治后是按发送那一条路**有控制地**滑一段到置顶线 —— 所以这一档判的是
     * 「只滑一段」与「停在置顶线上」,不是「不许动」。
     */
    if (retry.retryBubbleVisible) {
      assert(
        retry.retryShift <= BUDGET.retryShiftPx,
        `⑥ 气泡本来就在视口里:重试那一帧起 300ms 位移 ${retry.retryShift.toFixed(1)}px`
        + ` ≤ ${BUDGET.retryShiftPx}`,
      )
    } else {
      assert(
        retry.retryRuns <= BUDGET.scrollRuns,
        `⑥ 气泡本来在视口外:只滑过 ${retry.retryRuns} 段 ≤ ${BUDGET.scrollRuns}`
        + `(治前是浏览器随手钳一下,量到 1419px 的跳变)`,
      )
      /*
       * **落点判「回到视口里」,不判「正好压在置顶线上」**(09-15 真机纠正的一处量法)。
       * 正本 §2 规矩 ⑥ 那句话是有条件的:「气泡已在视口内就不动;不在视口内时滑到
       * 置顶线」—— 而那个条件是**落位那一刻**问的,不是按下那一刻。旧回答上折 180ms
       * 之后气泡自己就回到了视口里(实测停在 471),于是产品按字面**不再滑** ——
       * 判它「≈24」等于把两档合成一档,那是门读错了规矩,不是产品跑偏。
       * 判得住的是这一句:**按下之前它在视口外,落位之后它在视口里**,而且中间
       * 只滑过一段(上面那一条)。
       */
      assert(
        retry.retryLandedTop !== undefined
          && retry.retryLandedTop >= -1
          && retry.retryLandedTop <= (retry.retryViewport ?? 0),
        `⑥ 落位之后气泡回到视口里(top ${retry.retryLandedTop?.toFixed(1) ?? '?'}`
        + ` ∈ [0, ${retry.retryViewport ?? '?'}];按下之前它在视口外)`,
      )
    }
    /*
     * **重试档读数行允许一次反转**(正本 §8 留账第一条写着的那一格):读数行跟着
     * 正文下缘走,而重试那一下「旧回答上折」与「新一轮首字到」会撞在 400ms 内 ——
     * 一次先上后下是设计上说得通的,两次就不是。
     */
    assert(
      retry.readoutFlips <= 1,
      `⑥ 重试档读数行 400ms 内方向反转 ${retry.readoutFlips} 次 ≤ 1`
      + `(上折与首字撞在一起,§8 留账允许一次)`,
    )

    console.log('\n[超量] 400 条账本之上,一条 20 万字思考')
    await openSession(idBig, seeded.big.messages)
    const big = await runOnce(idBig, `座位门 · 超量 ${MARK_THOUGHT}`, 300_000)
    readings.big = big
    report('超量', big)
    /*
     * ── 超量这一档的折痕**只报不判**(2026-09-15,prod 真机改判)────────────────
     * 它是**夹具的前提**不是产品的判据(单 A 立它是为了证明「等待段真的量到了」)。
     * 这一档的等待段 900ms 全在主线程被占满的那段里:机器闲时壳能挤出一两帧把折痕
     * 画上(dev 实测恒 2 帧),机器忙时壳给这一轮提交的第一帧**晚于第一个字**落地,
     * 折痕于是一帧都没画过 —— latch 与采样两边同时说没有,它们一致,不是漏看。
     * 判它等于判机器忙不忙。而它原本还牵着 ① 的窗口:折痕没来过,落位窗就没了右
     * 边界、整轮都算进去(prod 实测 ① 因此报 4 段)。窗口现在另有一个不靠折痕的
     * 答案(`firstContentAt`,判词在 `startSampler` 的 latch 上),所以这一条摘掉
     * 断言、留下读数。常态与长回那两档的同名断言照旧判红 —— 那两档量得稳。
     */
    console.log(
      `  · (只报不判)超量:等待折痕上没上过屏 = ${big.sawWaiting}`
      + `(采样录到 ${big.waitingFrames} 帧)—— 这一档的 900ms 静默全落在主线程被`
      + `压缩 / 扩窗 / 400 条物化占满的那一段里,画不画得出看机器,不看产品`,
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
      `  · (只报不判)超量 ④(读数行)400ms 内方向反转 ${big.readoutFlips} 次`
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
    /* 与常态那一处同一条:先判「量到没量到」,判词写在那儿。 */
    assert(
      big.endAt >= 0 && big.endFrames > 1,
      `[收尾锚定] 超量:收尾那一帧采到了(窗口里 ${big.endFrames} 帧)`,
    )
    assert(
      big.endScrollMin > 0,
      `[收尾锚定] 超量收尾折叠中 \`scrollTop\` 有余量(最低 ${big.endScrollMin.toFixed(0)} > 0)`
      + ` —— 上面压着 400 条,锚定补得动;补到 0 才轮到内容动`,
    )
    assert(
      big.churnAfterEnd <= BUDGET.churnAfterEnd,
      `[收尾锚定] 超量收尾之后 DOM 不再翻腾(新建 / 移除 ${big.churnAfterEnd} 个`
      + ` ≤ ${BUDGET.churnAfterEnd})`,
    )
    assert(
      big.churnWatch <= BUDGET.churnAfterEnd,
      `[收尾锚定] 超量收摊之后 ${CHURN_WATCH_MS / 1000}s,那条助手行增删`
      + ` ${big.churnWatch} 个节点 ≤ ${BUDGET.churnAfterEnd} —— 400 条之上,收尾折叠照样不重挂`,
    )
    /*
     * ── ④ 在超量这一档**转判**(2026-09-15 反证逼出来的)────────────────────────
     * 它一度是「只报不判」,理由写的是「那一帧长达一秒多,窗口里常常只采到一两帧」。
     * 09-15 把长回那一支补上真思考段之后,四趟实测这一档的收尾窗恒为 31–36 帧 ——
     * 采得到。而它是**唯一**量得出这条治法的一档:把 `ThinkingSegment` 那段高度过渡
     * 与 `fold-intent` 整个拆掉重跑(反证 ④'),常态 / 长回 / 重试三档仍是 0.0px
     * (那三档的折叠幅度两三千像素,浏览器自己的滚动锚定接得住),**超量当场
     * 1459.8px** —— 正本 §0 三处病之二的原样。判据落在量得出差别的那一档上,
     * 不落在恒绿的那三档上:一条恒绿的断言不是守卫。
     * 采样太薄时 `base` 与自己比恒为 0,所以这一条只会因为**真的动了**而红。
     */
    assert(
      big.endAnchorShift <= BUDGET.endAnchorShiftPx,
      `[收尾锚定] 超量收尾锚点位移 ${big.endAnchorShift.toFixed(1)}px`
      + ` ≤ ${BUDGET.endAnchorShiftPx}(窗口 ${big.endFrames} 帧;拆掉高度过渡 +`
      + ` fold-intent 重跑同一趟是 1459.8px)`,
    )
    console.log(
      `  · (只报不判)超量整轮 >${BUDGET.longFrameMs}ms 长帧 ${big.whole.longFrames} 个,`
      + `最长 ${big.whole.longestFrameMs}ms —— 20 万字思考首屏与收尾折叠那两帧`,
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
