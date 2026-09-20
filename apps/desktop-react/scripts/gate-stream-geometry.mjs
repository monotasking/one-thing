#!/usr/bin/env node
/**
 * **流式几何**的真机门(G 线 P1,正本
 * `apps/desktop-react/docs/stream-geometry-2026-09.md` §5.3)。
 *
 * 由探针 `scripts/probe-layout-shift.mjs` 改 —— 那一支只量不判,这一支判红。
 * 支架、假 provider、离屏档、收尸纪律全部照抄它与 `gate-send-flow.mjs`。
 *
 * ── 它判的那七格(`BUDGET`)─────────────────────────────────────────────────
 * 全部是**像素位置与结构**,外加一格毫秒读数(长帧),与 `gate:send-flow` 同族:
 *  ① **首字帧尾槽位移** ≤1px —— 等待那张脸换成流式那张时,列尾那一格不许动。
 *     它是 G4「落定那一帧几何上什么都不发生」的第一个落点。
 *  ② **整轮贴底期间尾槽位移** ≤1px、**方向反转 0** —— §0 的病 ④:读数行从前排在
 *     正文之后,长思考那一轮全程动 303 次、单帧最大 335px、反转 3 次。
 *  ③ **收尾帧改动点以上位移** ≤1px —— §0 的病 ③(整屏下移 23.8px)与 ①(思考段
 *     自动折,一帧内视口被拉走最多 15,054px)。
 *  ④ **思考段 live 期间高度变化 0、落定帧高度变化 0** —— 收起态那一行的高由
 *     `block-size` 钉死,两态逐像素相同(§5.1)。
 *  ⑤ **全程非用户动作造成的 `scrollHeight` 回缩 0 次** —— G1「一轮之内页面总高
 *     在任何一次排版里都不许变小」。
 *  ⑥ **上拨场景**:用户锚点全程(含落定)位移 ≤1px,而且**锚点始终在 DOM 里**。
 *     §0 的病 ②(折叠那一帧他正读的那段字被从 DOM 上摘掉)。
 *     **注意**:P1 之后收起态思考段里没有可读的长文,所以上拨去读的是**上一轮的
 *     正文**,断言新一轮全程它不动。
 *  ⑦ **流式期间零 ≥50ms 长帧**(壳 CLAUDE.md 第 5 轴那一格换个主语)。
 *
 * ── 场景与两档 ────────────────────────────────────────────────────────────
 * **短会话**(空 store 新建的会话,第 1、2 轮起)与**超量夹具**
 * (`scripts/lib/seed-large-ledger.mjs`,≥50MB / 400 条 / 900 张工具卡)**各跑一遍**
 * 同样八个场景:纯文本 / 首块=代码块 / 3 千字思考→正文 / 6 万字思考→正文(贴底)/
 * 6 万字思考且中途上拨半屏 / 思考→工具→思考→正文 / 长回复(吃光座位)收尾 /
 * 中途停止。
 *
 * **短会话那一档不是摆设**:正本 §0 末尾那句「`gate:send-flow` 为什么一直绿」
 * 写的就是它 —— 那道门的超量夹具上面压着 400 条消息,`scrollTop` 钳不到,①
 * 量不出来;短会话里才全额暴露。
 *
 * 缺省跑 **dev**(现起一台 vite,端口另挑,绝不碰用户的 5175),`--prod` 跑
 * `dist/` 产物。用户跑的是 `electron:dev`,prod 上量出的数对它不成立(09-10 判例)。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * **窗子走屏外档**(`ONETHING_GATE_OFFSCREEN=1`):这道门每一条判据都与**页面的
 * 时间**有关(长帧、逐帧位移),而老那一档 `ONETHING_GATE_HEADLESS` 下 Chromium
 * 把整扇窗节流到 1Hz —— 量的会是节流器不是产品。屏外档同样不上前台、不动真光标。
 * 所有输入都经 `page.evaluate`;store 与 `--user-data-dir` 都是临时目录,跑完删干净,
 * **绝不连 `~/.onething`**。
 *
 * ── 探针文件头那三个坑,这里一个都没再掉 ──────────────────────────────────
 *  ① **元素号按趟分家**:`__gId` 写在 DOM 节点上,上一趟的号活过这一趟的重置;
 *     不按趟分家的话两件东西一个号,位移恒为 0(探针第一版 D/E/G/H 四档全报 0)。
 *  ② **`hasContent` 要排除等待那件**:它自己也报 `data-prose="object"`,算进去的话
 *     落位窗在折痕挂上来那一帧就关掉,落位那一段整段被读成跳动。
 *     G 线 P1 之后它住在尾槽里(不在消息行里),所以这里改成「只在**活消息行**里找」
 *     —— 同一条判词的新形。
 *  ③ **每轮开录前回到底**:人发下一条消息时是在底部,夹具要摆回那个姿势。
 *
 * 跑法:`npm run gate:stream-geometry` / `... -- --prod`
 * (仓根先 `bun run server:build`;两档都要先 `npm run electron:build`,
 *  `--prod` 还要 `npm run app:build`。)
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

const PROD = process.argv.includes('--prod') || process.env.ONETHING_GATE_DIST === '1'
const LANE = PROD ? 'prod' : 'dev'
/**
 * dev 档的 vite 端口。**不是 5175**(用户自己的 `app:dev` 占着),也避开
 * 5196(`gate:send-flow`)与 5203(`probe-layout-shift`)—— 这三只可能同机并跑。
 */
const DEV_PORT = Number(process.env.ONETHING_GATE_VITE_PORT ?? 5207)
const VIEWPORT = { width: 1280, height: 800 }

/* ── 预算(正本 §5.3)──────────────────────────────────────────────────────
 * 它们是**上限**不是目标。体例与 `gate-send-flow` / `gate-terminal` 逐字同源:
 * **抬 `BUDGET` 是改法,让它恒红只会被人加 `|| true`**。 */
const BUDGET = {
  /** ① 首字那一下(等待脸 → 流式脸),列尾那一格的 viewport 位移(px)。 */
  firstTokenSlotShiftPx: 1,
  /** ② 整轮贴底期间列尾那一格的位移(px)与方向反转次数。 */
  tailSlotShiftPx: 1,
  tailSlotFlips: 0,
  /** ③ 收尾那一帧起 300ms 内,视口内第一块在读的东西的位移(px)。 */
  endAboveShiftPx: 1,
  /** ④ 思考段:流式期间高度变化 / 落定那一帧高度变化(px)。 */
  thoughtHeightPx: 0.5,
  /** ④b 收起态那一行的字,右缘与那一格右缘之差(px)—— 右端对齐成不成立。 */
  liveLineRightGapPx: 1,
  /** ⑤ 非用户动作造成的、**把屏上的东西带走了**的 `scrollHeight` 回缩次数。 */
  shrinks: 0,
  /** ⑥ 上拨那一档:用户锚点全程位移(px)。 */
  anchorShiftPx: 1,
  /** ⑦ 流式期间 ≥ 这么长的帧,一个都不许有。 */
  longFrameMs: 50,
  longFrames: 0,
}

/**
 * **过渡值**:今天达不到、但有明确退场判据的格子。
 *
 * 体例与 `gate-terminal` / `gate-browser` 的那一格逐字同源:**填了就要在这一行上
 * 写清楚「什么时候删掉它」**;`BUDGET` 里那个数一格不改(**抬 `BUDGET` 是改法**)。
 * 键可以带场景前缀(`<场景 id>:<格>`),只覆盖那一档。
 *
 * 它**不是 P1 造出来的**,而且这句话是**量出来的**,不是判给别人的(2026-09-20
 * 审查打回第 4 条要的证据):同一道门、同一份夹具,把产品源码反装回 `main` 的版本
 * 重建重跑,读数逐格对得上 —— 三列并排在正本 `docs/stream-geometry-2026-09.md` §7.6。
 */
const TRANSITIONAL = {
  /**
   * ② 整轮尾槽位移:**1.5px**,不是 1。
   *
   * 真机四档各恰好一下、方向一律朝上、全在贴底期间:code −0.89 / long −0.97 /
   * abort −1.11px(text 0)。它是**尾巴亚像素对齐**那一件自己的地板:
   * `content/tail-snap.ts` 的 `TAIL_SNAP_REACQUIRE_DEVICE_PX = 3`(dpr 2 上 1.5px)
   * —— 尾巴真挪了窝时要重认一个设备像素格上的落点,而认下的格子与自然位置之间
   * 最多差这么多。`send-flow` 正本 §11.6 留账写着「1.5px 的静态偏移人看不见」。
   * G 线 P1 把读数与光标搬进尾槽之后,**被推的那一件与被 snap 的那一件成了同一件**,
   * 于是这一下第一次被量到。
   *
   * **退场判据**:tail-snap 的重认门槛收窄(§11.6 留账那一条),或者 P2 的锚定器
   * 把亚像素落点一并接管 —— 两者任一落地,这一行删掉,`BUDGET` 的 1 自己就够。
   */
  tailSlotShiftPx: 1.5,
  /**
   * ⑦ **只在「首块=代码块」那一档**:2 个长帧,最长 260ms。
   *
   * 真机两下:首块上屏后 175ms 一下 92ms,围栏闭合那一下 233ms —— 就是**代码高亮**
   * (shiki)在主线程上把一整块重算一遍。其余七档(纯文本 / 三种思考 / 工具 /
   * 长回 / 中途停止)四档最长 17–26ms,离 50ms 那条线还有一倍余量。
   *
   * 它是 **R 线的账**(`docs/stream-render-2026-09.md`:画什么、怎么增量),
   * 不是 G 线的(画在哪)。**退场判据**:代码块的高亮不再在主线程上做一次性的
   * 整块重算(搬进 worker,或者按行增量)—— 那一天这两行一起删。
   */
  'code:longFrames': 2,
  'code:longFrameMs': 260,
  /*
   * ── 超量那一档**没有过渡值**(2026-09-20 审查打回第 4 条量完之后删掉的)───────
   * 中途确实挂过一格 `'big:longFrames': 1 / 150ms`,判给「R 线的账」。三列并排一量
   * (§7.6)才发现它**多余**:剔掉「列在忙」那一族之后,超量八档**三种配置下都是
   * 0 个**判定长帧。既然达得到,就不该有过渡值 —— 这条门的体例是「能空就空」。
   */
}

/**
 * 这一格的上限。**由窄到宽**:这一档这一场景专属 ▷ 这一档专属 ▷ 这一场景专属 ▷
 * 全局过渡值 ▷ `BUDGET`。窄的先答,所以「超量那一档的代码块」要是哪天要单独开一格,
 * 加一行 `'big:code:longFrames'` 就够,这只函数一个字不改。
 */
function limitOf(key, full, budgetKey = key) {
  const [lane, scenario] = full.split(':')
  for (const scope of [`${lane}:${scenario}`, lane, scenario]) {
    if (TRANSITIONAL[`${scope}:${key}`] !== undefined) return TRANSITIONAL[`${scope}:${key}`]
  }
  if (TRANSITIONAL[key] !== undefined) return TRANSITIONAL[key]
  return BUDGET[budgetKey]
}

/** 「动了」的判据(px)。亚像素钳位不算 —— 与探针的 `EPS` 同一个数。 */
const MOVE_EPS = 1.0
/**
 * **方向反转**的判据(px)。`getBoundingClientRect` 报的是 `LayoutUnit`,量子
 * 1/64 = 0.015625 —— 位置真没变时两帧读出来是**同一个数**,噪声一格都没有。
 * 0.05 比那个量子大三倍、比任何一档 dpr 的半个设备像素小(dpr 4 时是 0.125),
 * 真抖一定跨得过、假抖一定跨不过(判词全文在 `gate-send-flow` 的 `READOUT_FLIP_EPS`)。
 */
const FLIP_EPS = 0.05
/** 贴底判据:`st + ch >= sh - 6`(与探针的 `BOTTOM_SLACK` 同一个数)。 */
const BOTTOM_SLACK = 6
/** 首字换手之后盯多久(ms)。 */
const HANDOFF_MS = 250
/** 收尾那一帧之后盯多久(ms)—— 与 `gate:send-flow` 的收尾窗同一个数。 */
const END_MS = 300
/** 用户自己动手之后,这么久之内的几何变化**不算产品自己动的**(ms)。 */
const USER_ACT_MS = 300
/** 第一个字之前静默多久 —— 等待那张脸要活得够久,逐帧采样才录得到。 */
const FIRST_BYTE_DELAY_MS = 900
/** 等「这一轮开张」(停止钮上屏)最多这么久。判词与 `gate-send-flow` 的那一格同源。 */
const OPEN_TIMEOUT_MS = 120_000

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`)
  else {
    console.log(`  ✗ ${message}`)
    failures.push(message)
  }
}

/* ══ 素材 ══════════════════════════════════════════════════════════════════
 * 线性同余而不是 `Math.random()`:同一份夹具每趟逐字相同,两趟读数才可比
 * (抄 `gate-perf` / `gate-send-flow` / 探针的 `buildThought`)。 */
function buildThought(totalChars, seed) {
  let x = seed >>> 0
  const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296 }
  const zh = '这一段是几何门造出来的思考正文它要和真数据同形所以每隔几十个字就断一次行'
  const en = ' alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu '
  /*
   * ── 夹具里**必须有换行**(2026-09-20 审查打回第 1 条)──────────────────────
   * 第一版这里写着「段内不带换行」,于是整份夹具里除了段与段之间那个 `\n\n`
   * 一个换行都没有 —— 而收起态那一行的 bug 恰恰**只在有换行时**显形
   * (`white-space: pre` 只管不自动折行,`\n` 照样断行:240 字在一行高的盒子里
   * 排成好几行,屏幕上露出来的是第一行,不是末尾)。**一份自己避开了病灶的夹具
   * 不是夹具**,这道门因此对着它绿了一整轮。
   * 今天:每 30–60 字断一次行,每 4–8 行空一行 —— 与真思考正文同形。
   */
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

/** 与装配层那一手同形(`assemble/text.ts` 的 `oneLine`):连续空白折成一个空格,两端修掉。 */
const oneLine = (s) => s.replace(/\s+/g, ' ').trim()

/** ≈3 屏(1280×800 下正文列约 720px 宽、一行约 26px):6 万字展开约 6000px+。 */
const THOUGHT_60K = buildThought(60_000, 20260920)
const THOUGHT_3K = buildThought(3_000, 777)
/** 折成一行的那一份 —— ④b 拿它当尺,量「屏上那一行落在整份思考的什么位置」。 */
const FLAT_60K = oneLine(THOUGHT_60K)
const FLAT_3K = oneLine(THOUGHT_3K)

const REPLY_PLAIN = '这是一段普通的正文回答,它要够长,好切成十几段真的流一遍,'
  + '让每一段都逼出一次提交、一次排版。第一块是一行正文 —— 和等待那一格的行高不一样,'
  + '所以换手那一帧的高度差全落在这一块身上。'
  + '再补几句把这一段撑到两三行,免得整条回答短到连座位都吃不满。'

const CODE_LINES = Array.from({ length: 14 }, (_, i) =>
  `const line${i + 1} = compute(${i + 1}, 'stream-geometry-gate', { retries: ${i % 3} })`)
const REPLY_CODE = '```ts\n' + CODE_LINES.join('\n') + '\n```\n\n'
  + '上面那块代码围栏在流式里会经历「未闭合 → 闭合」,而高亮是异步到位的。'

/** 长回复:把座位吃光,之后接上普通跟底(§0 的 ⑤ 就在这一段里)。 */
const REPLY_LONG = Array.from({ length: 26 }, (_, i) =>
  `第 ${i + 1} 段:${REPLY_PLAIN}`).join('\n\n')

/** 中途停止那一支:流得够久,好在中间按下停止键。 */
const REPLY_ABORT = Array.from({ length: 60 }, (_, i) =>
  `第 ${i + 1} 段:这一段存在的理由是让流跑得够久,好在中途按下停止。`).join('\n\n')

/* ── 记号:请求里最后一条 user 带哪个,决定这一发吐什么 ────────────────────── */
/** 两档的名字。`--only <档>` 只跑其中一档(迭代用;`verify` 里永远两档都跑)。 */
const LANES = ['short', 'big']
const ONLY_LANE = (() => {
  const at = process.argv.indexOf('--only')
  const v = at >= 0 ? process.argv[at + 1] : undefined
  return LANES.includes(v) ? v : undefined
})()

const MARKS = {
  /**
   * **热身**(不量)。每一档开场先跑一轮,它吃掉两笔与几何无关的一次性开销:
   *  · **起名**那一发模型调用 —— 只在一条会话的第一条用户消息上发(`core-stream-engine`
   *    的 `isFirstUserMessage` 那一闸),它与真的那一发抢同一个记号的配额;
   *  · **冷开张** —— 50.9MB 那条会话的第一轮要把整本账折一遍、跑一次上下文压缩。
   *    真机实测:热身那一轮 `开张` 4–5s、整轮四个 >50ms 长帧(最长 1133ms),
   *    而**同一条会话上紧接着的每一轮**都是 0–1 个、最长 77–141ms。
   * 那一段贵是**开张**的事(`gate:chat-layout` / `gate:perf` 的账),不是流式几何的事;
   * 把它算进这道门,量的是机器忙不忙,不是产品动不动。
   */
  warm: '@@g-warm@@',
  text: '@@g-text@@',
  code: '@@g-code@@',
  think3k: '@@g-think3k@@',
  think60k: '@@g-think60k@@',
  scrollUp: '@@g-scrollup@@',
  tools: '@@g-tools@@',
  long: '@@g-long@@',
  abort: '@@g-abort@@',
}
/**
 * **记号按档分家**(第一趟真机踩出来的):自动起名是一次**独立的模型调用**,
 * 而它的提示词里带着用户原话、因此也带着记号 —— 它只在一条会话的**第一条**用户
 * 消息上发一次(`core-stream-engine.ts` 的 `isFirstUserMessage` 那一闸)。
 * 记号不分档时,短会话那一档的第一个场景把配额用掉两份(真的那一发 + 起名那一发),
 * 超量那一档的同一个记号当场没配额 → 假 provider 两帧收尾 → 停止钮永远不上屏 →
 * 「开张」那一闸超时。分家之后每一档自己那 2 份:一份真的,一份留给起名。
 *
 * `tools` 不计数:它一轮要跑三发 HTTP,按 `toolTurns` 分轮。
 */
const MARK_BUDGET = 2
/** 这一档的记号 —— 与上面那段判词配套:两档各一套,互不抢配额。 */
const markFor = (mark, lane) => `${mark.slice(0, -2)}-${lane}@@`

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
        id: 'chatcmpl-geo',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const bye = (finish = 'stop') => {
        if (!res.destroyed) { send(frame({}, finish)); res.write('data: [DONE]\n\n') }
        res.end()
      }
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

      /*
       * 静默这一段**热身那一轮也要走**(第一趟踩的):不走的话假 provider 当场回完,
       * 整轮从开张到收场只有一百多毫秒,而「开张」那一闸是 120ms 轮询一次的 ——
       * 它**采不到**那一下,于是等到超时。判词一句话:**要被看见的事,得活得比
       * 观察它的节拍长**(与 `FIRST_BYTE_DELAY_MS` 本身同一条理由)。
       */
      await delay(FIRST_BYTE_DELAY_MS)
      if (res.destroyed) return

      if (kind === 'tools') {
        if (toolTurns === 0) {
          await streamThought(THOUGHT_3K, 80, 16, 10, 50)
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
        await streamThought(THOUGHT_3K, 80, 16, 10, 50)
        await delay(80)
        await stream('两条都跑完了,下面是结论正文。' + REPLY_PLAIN, 10, 100)
        bye()
        return
      }

      if (kind === 'think3k') {
        await streamThought(THOUGHT_3K, 70, 16)
        await delay(80)
        await stream(REPLY_PLAIN, 10, 100)
        bye()
        return
      }
      if (kind === 'think60k' || kind === 'scrollUp') {
        await streamThought(THOUGHT_60K, 90, 16, 24, 60)
        await delay(80)
        await stream('思考结束,下面是结论。\n\n' + REPLY_PLAIN, 10, 100)
        bye()
        return
      }
      const table = {
        /* 热身:短、快,只为把起名那一发与冷开张那一段花掉。 */
        warm: ['热身一轮,这一段不量 —— 它把起名那一发与冷开张那一段花掉。', 6, 90],
        text: [REPLY_PLAIN, 10, 110],
        code: [REPLY_CODE, 16, 100],
        long: [REPLY_LONG, 40, 90],
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
/** 等一件事发生。**等了多久记在 `waitFor.lastMs` 上**(超时值该定多少,判据是实测)。 */
async function waitFor(label, predicate, timeoutMs = 60_000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) {
      waitFor.lastMs = Date.now() - started
      return last
    }
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

/**
 * **屏上那一片会话叶** —— 这道门每一句查询的根(判词与 `gate-send-flow` 的
 * `__seatLeaf` 逐字同源:既有消息流又有输入框的那一格才是会话叶)。
 */
const LEAF_PROBE = `
window.__gLeaf = function () {
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

/* ══ 逐帧采样器 ════════════════════════════════════════════════════════════ */

async function startSampler(page) {
  await page.evaluate(() => {
    window.__gFrames = []
    window.__gStop = false
    /*
     * **号按趟分家**(探针文件头坑 ①):`__gId` 写在 DOM 节点上,上一趟留下的号
     * 活过这一趟的重置;不分家的话这一趟新长出来的节点与屏上某个老节点撞号,
     * 事后那张表后写的盖掉先写的,位移恒为 0。
     */
    const run = (window.__gRun = (window.__gRun ?? 0) + 1)
    let seq = 0
    const idOf = (el) => {
      if (el.__gRun !== run) {
        el.__gRun = run
        el.__gId = `r${run}n${(seq += 1)}`
      }
      return el.__gId
    }
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { id: idOf(el), top: r.top, h: r.height }
    }
    /** 同层第一件下缘还在视口内的东西(二分,`bottom` 单调)。 */
    const firstVisible = (node, top) => {
      const kids = node.children
      let lo = 0
      let hi = kids.length - 1
      let found = null
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const el = kids[mid]
        if (!el) return null
        if (el.getBoundingClientRect().bottom > top + 1) { found = el; hi = mid - 1 } else lo = mid + 1
      }
      if (!found) return null
      // 座位垫块与尾槽都是「让出去的地」,不是「在读的东西」(与产品那一句同判)。
      if (found.hasAttribute('data-seat') || found.hasAttribute('data-tail-slot')) return null
      return found
    }
    /**
     * **「这条回复里视口内第一块在读的东西」** —— 一层层往里钻,直到某一件**整个**
     * 落在视口上缘之下。判词与产品的 `pickFoldAnchor` / `gate-send-flow` 的 `anchorOf`
     * 逐字同源:量**行**会把「`scrollHeight` 塌了、浏览器把 `scrollTop` 钳回来」
     * 读成「屏幕跳了一千多像素」,而那一刻行里的正文其实在原地。
     */
    const readAnchorOf = (scroll) => {
      const top = scroll.getBoundingClientRect().top
      let anchor = null
      let cursor = scroll.firstElementChild
      for (let depth = 0; cursor && depth < 4; depth += 1) {
        const next = firstVisible(cursor, top)
        if (!next) break
        anchor = next
        if (next.getBoundingClientRect().top >= top - 1) break
        cursor = next
      }
      return anchor
    }
    const tick = (t) => {
      if (window.__gStop) return
      const pane = window.__gLeaf()
      const scroll = pane.querySelector('[data-testid="chat-stream"]')
      const column = scroll?.firstElementChild
      if (scroll && column) {
        const kids = column.children
        let live = null
        for (let i = kids.length - 1; i >= 0 && i >= kids.length - 7; i -= 1) {
          const el = kids[i]
          if (!el.hasAttribute('data-message-id')) continue
          if (el.getAttribute('data-role') === 'user') continue
          live = el
          break
        }
        const slot = column.querySelector(':scope > [data-tail-slot]')
        /*
         * 「这一轮画得出内容了」(探针坑 ② 的新形):**只在活消息行里找**。
         * 等待那道折痕与那枚光标 G 线 P1 起住在尾槽里、不在消息行里,所以这一句
         * 不必再把它们排除 —— 它们本来就不在这棵子树上。
         */
        const hasContent = Boolean(live?.querySelector('[data-prose], [data-testid="chat-thought"], [data-tool-card]'))
        /** 活消息行里每一段思考,各记一格高(自动折叠没有了,它该恒定)。 */
        const thoughts = []
        /**
         * **收起且还在流的那一行字自己**(2026-09-20 审查打回第 1 条补的)。
         *
         * ④ 只量那一段的**外高**,而外高是 `block-size` 钉死的 —— 里面那个 `<span>`
         * 排成几行它一个数都不变,`overflow: hidden` 把多出来的裁掉。所以那个 bug
         * (240 字排成好几行、屏上露出第一行)**从外高上看不出来**,要量的是里面
         * 那一行:①它自己有多高(一行 = 与外高同量级)②它的右缘贴没贴着容器右缘
         * (右端对齐那一手成不成立)③它此刻挂的是哪一截字。
         */
        let liveLine = null
        if (live) {
          for (const el of live.querySelectorAll('[data-testid="chat-thought"]')) {
            thoughts.push({ ...rect(el), open: el.getAttribute('aria-expanded') })
            if (liveLine) continue
            const box = el.querySelector('p[data-live]')
            const span = box?.firstElementChild
            if (!box || !span) continue
            const br = box.getBoundingClientRect()
            const sr = span.getBoundingClientRect()
            liveLine = {
              boxH: br.height,
              lineH: sr.height,
              /* 右端对齐:字的右缘与那一格内容盒的右缘之差。 */
              rightGap: Math.abs(sr.right - br.right),
              text: span.textContent ?? '',
            }
          }
        }
        window.__gFrames.push({
          t,
          st: scroll.scrollTop,
          sh: scroll.scrollHeight,
          ch: scroll.clientHeight,
          vTop: scroll.getBoundingClientRect().top,
          /* 这一轮那条助手行的身份 —— 换了就是换了一轮(尾窗滑动带来的「消失」不是回缩)。 */
          /* 列上此刻摆着几格 —— 空闲补历史那一路一次补一批,长帧红的时候要认得出它。 */
          rows: kids.length,
          liveId: live ? idOf(live) : null,
          /* 滚动容器换过人 = 重挂,那一帧的 `scrollTop` 归零不是钳位。 */
          scrollId: idOf(scroll),
          streaming: Boolean(pane.querySelector('[data-testid="chat-stop"]')),
          face: slot?.getAttribute('data-face') ?? null,
          slot: rect(slot),
          readAnchor: rect(readAnchorOf(scroll)),
          hasContent,
          thoughts,
          liveLine,
          /* 上拨那一档钉下来的那一块字(人正在读的那一段)。 */
          anchor: window.__gAnchor && window.__gAnchor.isConnected ? rect(window.__gAnchor) : null,
          anchorAlive: window.__gAnchor ? window.__gAnchor.isConnected : null,
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopSampler(page) {
  return page.evaluate(() => {
    window.__gStop = true
    const frames = window.__gFrames ?? []
    window.__gFrames = []
    return frames
  })
}

/* ══ 事后那一遍算 ══════════════════════════════════════════════════════════ */

const atBottom = (f) => f.st + f.ch >= f.sh - BOTTOM_SLACK

/**
 * 一串位置的三格读数:**最远漂**(相对第一帧)、**单帧最大步**、**方向反转次数**。
 *
 * 「单帧最大步」这一格是第一趟真机之后补的:位移可以只发生一帧然后被补回来
 * (座位晚一帧那一形),这种一帧的跳只有逐帧差看得见 —— 只看「相对基准的最远漂」
 * 也看得见,但只看「停下来在哪」就看不见了。两格一起报,红的时候一眼分得出
 * 「它漂走了」还是「它抖了一下」。
 */
function drift(values) {
  let max = 0
  let step = 0
  let moves = 0
  let flips = 0
  let dir = 0
  const base = values[0]
  for (let i = 0; i < values.length; i += 1) {
    max = Math.max(max, Math.abs(values[i] - base))
    if (i === 0) continue
    const d = values[i] - values[i - 1]
    step = Math.max(step, Math.abs(d))
    if (Math.abs(d) >= MOVE_EPS) moves += 1
    if (Math.abs(d) < FLIP_EPS) continue
    const nd = Math.sign(d)
    if (dir !== 0 && nd !== dir) flips += 1
    dir = nd
  }
  return {
    maxPx: Number(max.toFixed(2)),
    stepPx: Number(step.toFixed(2)),
    moves,
    flips,
  }
}

/**
 * 一趟的全部读数。**每一格都先答「量到没量到」** —— 位移那一族有一个恒绿的
 * 逃生口:窗口里一帧都没采到时「与自己比」恒为 0,整条直接放行
 * (判词与 `gate-send-flow` §9.2 最后一条逐字同源:**一条恒绿的断言不是守卫**)。
 */
function analyze(frames, userActs, thoughtFlat) {
  if (frames.length < 2) return { frames: frames.length, empty: true }
  const t0 = frames[0].t

  /*
   * ── **列上多一格 / 少一格那一小段,是「列」的账,不是这一轮流式的几何** ──────────
   *
   * 这道门量的是正本 §1 那五条:一轮回复在长的过程里,屏上其余的东西动没动。
   * 而同一条列上还有三件与这一轮无关、却也会改排版的事:
   *  · **按屏进**(09-10 `useTailWindow` ①):空闲时往前补一批历史行。真机读数
   *    (这道门自己打出来的):热身那一轮一帧补 378 格 / 192ms,之后每轮补 1 格 /
   *    50–125ms —— 那一格里可能装着几十张工具卡;
   *  · 补进来的行**第一次渲出真高**比估高(`--msg-intrinsic-h` 240px)矮,内容列
   *    跟着矮一截,而 `useTailWindow` 的补偿只对得上 prepend 那一下(判词写在
   *    `ChatStream.tsx` 那只补偿 layout effect 上)—— 真机量到 `sh` −19、屏上 18.6px;
   *  · **事后出现的那一行**(上下文更新折痕 / 压缩折痕)落账时插进列里。
   * 三件都是既有的账(09-10 那一批与 U5),**P1 一个字都没碰它们**。
   *
   * 所以 ⑤ 与 ⑦ 都把「列上格数变了之后那 `USER_ACT_MS`」剔出去 —— 与剔掉「用户
   * 自己动手之后那一小段」同一条判词、同一个窗口长度。**剔掉的不是证据**:被剔掉的
   * 那几下照样逐条打在报告里(带着「同一帧列上多出 N 格」那句话),谁都看得见。
   */
  const rowActs = []
  for (let i = 1; i < frames.length; i += 1) {
    if (frames[i].rows !== frames[i - 1].rows) rowActs.push(frames[i].t)
  }
  const listBusy = (t) => rowActs.some((at) => t >= at && t <= at + USER_ACT_MS)

  /* 这一轮那条助手行 —— 开录那一刻列尾还是**上一轮**那条,所以要认身份。 */
  const baseLive = frames[0].liveId
  const firstContent = frames.findIndex((f) => f.liveId !== baseLive && f.hasContent)

  /* ① 首字换手:等待那张脸的最后一帧起,盯 HANDOFF_MS。 */
  const lastWait = frames.map((f) => f.face === 'wait').lastIndexOf(true)
  let handoff = { frames: 0, maxPx: 0 }
  if (lastWait >= 0 && frames[lastWait].slot) {
    const until = frames[lastWait].t + HANDOFF_MS
    const tops = []
    for (let i = lastWait; i < frames.length && frames[i].t <= until; i += 1) {
      if (frames[i].slot) tops.push(frames[i].slot.top)
    }
    handoff = { frames: tops.length, ...drift(tops) }
  }

  /*
   * ② 整轮尾槽。从首字换手那一帧起 —— 在那之前是发送落位那一段滑动。
   *
   * ── **不许按帧筛「此刻贴不贴底」**(第一趟真机的教训)──────────────────────
   * 第一版写的是 `if (!atBottom(f)) continue`,读出来四档全是 0px / 0 反转 ——
   * 而同一趟的 ⑤ 却报了 3–12 次 `scrollHeight` 回缩。两者不可能同时为真:
   * 内容长了 Δ 而座位还没缩的**那一帧**,`st + ch` 比 `sh` 小 Δ,于是
   * `atBottom` 为假、那一帧被筛掉 —— **筛掉的正好是出问题的那一帧**。
   * 一条把病帧筛干净的断言不是守卫(与 §9.2 那句「一条恒绿的断言不是守卫」同族)。
   *
   * 所以今天它**一帧不筛**(除了用户自己动手之后那一小段),而「人往上翻着」
   * 那一档(上拨)本来就不判 ② —— 它有自己的 ⑥。
   */
  const from = lastWait >= 0 ? lastWait : Math.max(0, firstContent)
  const tops = []
  let bottomFrames = 0
  /** 单帧动得最大的那几下,带上时刻与那一帧的滚动几何 —— 红的时候要说得出是哪一下。 */
  const steps = []
  let prevTop
  for (let i = from; i < frames.length; i += 1) {
    const f = frames[i]
    if (!f.slot) continue
    if (userActs.some((at) => f.t >= at && f.t <= at + USER_ACT_MS)) continue
    if (atBottom(f)) bottomFrames += 1
    if (prevTop !== undefined && Math.abs(f.slot.top - prevTop) >= FLIP_EPS) {
      steps.push({
        ms: Math.round(f.t - t0),
        d: Number((f.slot.top - prevTop).toFixed(2)),
        st: Number(f.st.toFixed(2)),
        sh: f.sh,
        ch: f.ch,
        bottom: atBottom(f),
      })
    }
    prevTop = f.slot.top
    tops.push(f.slot.top)
  }
  steps.sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
  const pinned = { frames: tops.length, bottomFrames, steps: steps.slice(0, 4), ...drift(tops) }

  /* ③ 收尾那一帧起 END_MS 内,视口内第一块在读的东西。 */
  const endAt = frames.findIndex((f, i) => i > 0 && frames[i - 1].streaming && !f.streaming)
  let end = { at: endAt, frames: 0, maxPx: 0 }
  if (endAt > 0 && frames[endAt].readAnchor) {
    const anchorId = frames[endAt].readAnchor.id
    const base = frames[endAt].readAnchor.top
    const until = frames[endAt].t + END_MS
    let max = 0
    let n = 0
    for (let i = endAt; i < frames.length && frames[i].t <= until; i += 1) {
      const r = frames[i].readAnchor
      if (!r || r.id !== anchorId) continue
      n += 1
      max = Math.max(max, Math.abs(r.top - base))
    }
    end = { at: Math.round(frames[endAt].t - t0), frames: n, maxPx: Number(max.toFixed(2)) }
  }

  /* ④ 思考段:按元素号分家,各自的高在**流式期间**不许变;落定那一帧也不许变。 */
  const heights = new Map()
  let liveDelta = 0
  let settleDelta = 0
  let thoughtFrames = 0
  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i]
    for (const th of f.thoughts) {
      if (!th || th.id === null) continue
      // 人点开过的那一段不在这一条的管辖里(P1 只保证「没人点它时它不动」)。
      if (th.open === 'true') { heights.delete(th.id); continue }
      thoughtFrames += 1
      const seen = heights.get(th.id)
      if (seen === undefined) { heights.set(th.id, th.h); continue }
      const d = Math.abs(th.h - seen)
      if (f.streaming) liveDelta = Math.max(liveDelta, d)
      else settleDelta = Math.max(settleDelta, d)
    }
  }

  /*
   * ④b **收起且还在流的那一行字**(2026-09-20 审查打回第 1 条)。
   *
   * ④ 只量那一段的**外高**,而外高是 `block-size` 钉死的 —— 里面那个 `<span>` 排成
   * 几行它一个数都不变,`overflow: hidden` 把多出来的裁掉。所以那个 bug(240 字排成
   * 好几行、屏上露出**第一行**)**从外高上一个数都看不出来**,这道门因此对着病灶
   * 绿了一整轮。要量的是里面那一行:
   *  · `maxLineH` —— 它自己有多高。一行就该与那一格外高同量级;排成两行就是两倍;
   *  · `maxRightGap` —— 字的右缘贴没贴着那一格的右缘(右端对齐那一手成不成立);
   *  · `headHits` / `advances` —— 它挂的是哪一截字:拿**整份思考折成一行**当尺,
   *    看这一行落在什么位置上。落在 0 就是「显示的是开头」,位置往前走就是
   *    「它跟着流在走」。
   */
  let liveLineFrames = 0
  let maxLineH = 0
  let maxBoxH = 0
  let maxRightGap = 0
  let headHits = 0
  let advances = 0
  let lastIdx = -1
  let sampleText = ''
  for (const f of frames) {
    const l = f.liveLine
    if (!l || !l.text) continue
    liveLineFrames += 1
    maxLineH = Math.max(maxLineH, l.lineH)
    maxBoxH = Math.max(maxBoxH, l.boxH)
    maxRightGap = Math.max(maxRightGap, l.rightGap)
    if (!sampleText) sampleText = l.text
    if (thoughtFlat) {
      const idx = thoughtFlat.indexOf(l.text)
      /*
       * **开头那几帧落在 0 是对的**(第一趟真机纠正的):一轮刚开张、到手的字还不到
       * 240 个时,「末尾那一截」与「开头那一截」**本来就是同一段字**。所以只有在
       * 窗口已经喂满(≥200 字)、它**却还**落在第 0 字上时,才是「显示的是开头」
       * 那个病。240 是那一刀的额度,留 40 字余量给折空白吃掉的那几个。
       */
      if (idx === 0 && l.text.length >= 200) headHits += 1
      if (idx > 0) {
        if (lastIdx >= 0 && idx > lastIdx) advances += 1
        lastIdx = idx
      }
    }
  }

  /*
   * ⑤ **屏幕没跟着的那种 `scrollHeight` 回缩**(G1)。
   *
   * 排除:换轮 / 换容器 / 首块内容之前(发送落位那一段)/ 用户自己动手之后那一小段。
   *
   * ── 为什么判据是「屏幕跟没跟」,不是「总高有没有变小」(第一趟真机之后收紧的)──
   * 光判「变小了几次」在这台上是一条**永远达不到**的线,而且它判的不是那件事:
   * 消息行是**跳渲**的(`content-visibility: auto`,`--msg-intrinsic-h` 给的 240px
   * 只是估高),一行第一次渲出真高比估高矮,内容列就**必然**矮一截 —— 那是 09-10
   * 那一批有意选的架构,不是这一轮的排版变矮了。真机读数:超量那一档一轮里
   * 这样的回缩 9 次,每次 1–18px,而同一轮里尾槽总共只动了 0.28px。
   *
   * G1 要防的是它的**后果**,那句判词自己就写着:「让前面跳的是贴底时页面总高变小、
   * 浏览器钳 `scrollTop`」——**跳**才是病,变小只是它的一种成因。所以这一格判的是
   * **那一帧屏上的东西有没有跟着动**:尾槽(列尾那一格)或者视口里第一块在读的
   * 东西,任一在那一帧挪了 ≥1px,就是 G1 说的那件事;两样都一像素没动,那一次
   * 回缩在屏幕上**不存在**。
   *
   * 真机两组对照说明这条线划在哪:
   *  · 热身那一轮(冷开张、整帧冻 468ms):`sh` −32,`st` 一动不动,**尾槽当场 −32px**
   *    —— 算,而且它正是这道门要抓的那一形;
   *  · 超量那一档的常态轮:`sh` −19 / −3,`st` 不动,而**尾槽整轮 0px、锚点 0px**
   *    —— 不算。那是跳渲的行渲出真高(估高 `--msg-intrinsic-h` 240px 比真高大)
   *    在视口之外发生的事,09-10 那一批有意选的架构,屏上一个像素都没动。
   */
  const shrinks = []
  /** 列在忙那一小段里的回缩 —— **只报不判**(判词在上面 `listBusy` 那一段)。 */
  const listShrinks = []
  for (let i = 1; i < frames.length; i += 1) {
    const a = frames[i - 1]
    const b = frames[i]
    if (a.liveId !== b.liveId || a.scrollId !== b.scrollId) continue
    if (firstContent >= 0 && i <= firstContent) continue
    if (userActs.some((at) => b.t >= at && b.t <= at + USER_ACT_MS)) continue
    const dSh = b.sh - a.sh
    if (dSh >= -0.5) continue
    const duringList = listBusy(b.t)
    /** 那一帧屏上动了多少 —— 同一件东西才比得了(按元素号认)。 */
    const moved = (pick) => {
      const ra = pick(a)
      const rb = pick(b)
      if (!ra || !rb || ra.id !== rb.id) return 0
      return Math.abs(rb.top - ra.top)
    }
    const screen = Math.max(moved((f) => f.slot), moved((f) => f.readAnchor))
    if (screen < MOVE_EPS) continue
    const row = {
      ms: Math.round(b.t - t0),
      from: a.sh,
      to: b.sh,
      dSt: Number((b.st - a.st).toFixed(2)),
      screenPx: Number(screen.toFixed(2)),
      list: duringList,
    }
    if (duringList) listShrinks.push(row)
    else shrinks.push(row)
  }

  /* ⑥ 上拨那一档钉下来的那一块字。 */
  const anchorTops = []
  let anchorDead = 0
  for (const f of frames) {
    if (f.anchorAlive === null) continue
    if (!f.anchorAlive) { anchorDead += 1; continue }
    if (f.anchor) anchorTops.push(f.anchor.top)
  }
  const anchor = anchorTops.length
    ? { frames: anchorTops.length, dead: anchorDead, ...drift(anchorTops) }
    : { frames: 0, dead: anchorDead, maxPx: 0, flips: 0 }

  /* ⑦ 长帧:只数流式期间的。红的时候要说得出是**哪一刻**的那一帧。 */
  let longFrames = 0
  /** 列在忙那一小段里的长帧 —— **只报不判**(同一条判词)。 */
  let listLongFrames = 0
  let longest = 0
  const longAt = []
  for (let i = 1; i < frames.length; i += 1) {
    if (!frames[i].streaming) continue
    const gap = frames[i].t - frames[i - 1].t
    longest = Math.max(longest, gap)
    if (gap > BUDGET.longFrameMs) {
      if (listBusy(frames[i].t)) listLongFrames += 1
      else longFrames += 1
      longAt.push({
        ms: Math.round(frames[i].t - t0),
        gap: Math.round(gap),
        /* 这一帧列上多出来几格:> 0 = 空闲补历史那一批(09-10 的 `useTailWindow` ①)。 */
        rows: frames[i].rows - frames[i - 1].rows,
      })
    }
  }

  return {
    frames: frames.length,
    spanMs: Math.round(frames[frames.length - 1].t - t0),
    fps: Math.round((frames.length / Math.max(1, frames[frames.length - 1].t - t0)) * 1000),
    streamFrames: frames.filter((f) => f.streaming).length,
    waitFrames: frames.filter((f) => f.face === 'wait').length,
    firstContentAt: firstContent >= 0 ? Math.round(frames[firstContent].t - t0) : -1,
    handoff,
    pinned,
    end,
    thought: {
      frames: thoughtFrames,
      elements: heights.size,
      liveDeltaPx: Number(liveDelta.toFixed(2)),
      settleDeltaPx: Number(settleDelta.toFixed(2)),
    },
    shrinks,
    anchor,
    liveLine: {
      frames: liveLineFrames,
      maxLineHPx: Number(maxLineH.toFixed(2)),
      maxBoxHPx: Number(maxBoxH.toFixed(2)),
      maxRightGapPx: Number(maxRightGap.toFixed(2)),
      headHits,
      advances,
      tracked: Boolean(thoughtFlat),
    sample: sampleText.slice(-40),
    },
    listShrinks,
    longFrames,
    listLongFrames,
    longAt: longAt.slice(0, 6),
    longestFrameMs: Math.round(longest),
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
    const box = window.__gLeaf().querySelector('[data-testid="composer-input"]')
    if (!box) return false
    box.textContent = value
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, text)
  if (!ok) throw new Error('打不进去:没有 composer-input')
  await delay(200)
  const sent = await page.evaluate(() => {
    const send = window.__gLeaf().querySelector('[data-testid="composer-send"]')
    if (!(send instanceof HTMLElement) || send.hasAttribute('disabled')) return false
    send.click()
    return true
  })
  if (!sent) throw new Error('发送键点不动')
}

const stopShown = (page) => page.evaluate(() =>
  Boolean(window.__gLeaf().querySelector('[data-testid="chat-stream"]')
    && window.__gLeaf().querySelector('[data-testid="chat-stop"]')))

function report(name, m) {
  if (m.empty) {
    console.log(`      ${name}:一帧都没采到`)
    return
  }
  console.log(
    `      ${name}:${m.frames} 帧 @${m.fps}fps(等待 ${m.waitFrames} 帧,首块 ${m.firstContentAt}ms)`
    + ` · 首字帧尾槽 最远 ${m.handoff.maxPx} / 单帧 ${m.handoff.stepPx}px / ${m.handoff.frames} 帧`
    + ` · 整轮尾槽 最远 ${m.pinned.maxPx} / 单帧 ${m.pinned.stepPx}px / 动 ${m.pinned.moves} 次`
    + ` / 反转 ${m.pinned.flips} / ${m.pinned.frames} 帧(其中贴底 ${m.pinned.bottomFrames})`,
  )
  console.log(
    `      ${' '.repeat(name.length)} 收尾窗 ${m.end.frames} 帧:上方位移 ${m.end.maxPx}px`
    + ` · 思考段 ${m.thought.elements} 段 / ${m.thought.frames} 帧:live ${m.thought.liveDeltaPx}px`
    + ` 落定 ${m.thought.settleDeltaPx}px · 回缩 ${m.shrinks.length}(列在忙时另有 ${m.listShrinks.length})`
    + ` · 锚点 ${m.anchor.frames} 帧 ${m.anchor.maxPx}px(摘掉 ${m.anchor.dead})`
    + ` · >50ms 长帧 ${m.longFrames}(列在忙时另有 ${m.listLongFrames};最长 ${m.longestFrameMs}ms)`,
  )
  if (m.liveLine.frames > 0) {
    console.log(
      `      ${' '.repeat(name.length)} 收起态那一行 ${m.liveLine.frames} 帧:行高 ${m.liveLine.maxLineHPx}`
      + ` / 格高 ${m.liveLine.maxBoxHPx}px · 右缘差 ${m.liveLine.maxRightGapPx}px`
      + ` · 显示开头 ${m.liveLine.headHits} 帧 / 往前走 ${m.liveLine.advances} 次`
      + ` · 末 40 字「${m.liveLine.sample}」`,
    )
  }
  for (const s of [...m.shrinks, ...(m.listShrinks ?? [])].slice(0, 5)) {
    console.log(`        [回缩${s.list ? '(列在忙,只报不判)' : ''} ${s.ms}ms] scrollHeight ${s.from} → ${s.to}`
      + `(scrollTop 只动了 ${s.dSt},屏上跟着动了 ${s.screenPx}px)`)
  }
  for (const s of m.pinned.steps ?? []) {
    console.log(`        [尾槽动 ${s.ms}ms] ${s.d > 0 ? '+' : ''}${s.d}px`
      + ` st=${s.st} sh=${s.sh} ch=${s.ch} 贴底=${s.bottom}`)
  }
  for (const s of m.longAt ?? []) {
    console.log(`        [长帧 ${s.ms}ms] ${s.gap}ms`
      + (s.rows ? `(同一帧列上多出 ${s.rows} 格 —— 空闲补历史)` : '(列上格数没变)'))
  }
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[stream-geometry] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry)) {
    console.error('[stream-geometry] 找不到主进程产物 —— 先跑 `npm run electron:build`')
    process.exit(1)
  }
  if (PROD && !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[stream-geometry] --prod 档找不到 `dist/index.html` —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'geo-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'geo-udd-'))
  const providerState = {}
  let provider; let server; let app; let vite
  const readings = { lane: LANE, viewport: VIEWPORT, scenarios: {} }

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
    console.log(`\n[stream-geometry] 渲染层档位:${LANE}`)
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
    const shortId = (await rpc(core.record, 'sessions', 'create', { name: '几何门 · 短会话' }))?.session?.id
    const bigId = (await rpc(core.record, 'sessions', 'create', { name: '几何门 · 超量(400 条)' }))?.session?.id
    if (!shortId || !bigId) throw new Error('会话没建出来')

    console.log('[2/5] 停 core,给超量那一条直写账本,再起回来')
    await stopCore(server)
    /* 真店规模夹具的缺省档(≥50MB / 400 条 / 900 张工具卡)—— 与 gate:send-flow 同一份。 */
    const seeded = seedLargeLedger(store, bigId, {})
    console.log(`      超量夹具 ${(seeded.bytes / 1024 / 1024).toFixed(1)}MB / ${seeded.messages} 条`)
    core = await startCore()
    server = core.child

    let rendererUrl
    if (PROD) {
      console.log('[3/5] prod 档:吃 dist/ 产物,不起 vite')
    } else {
      console.log(`[3/5] 起 vite dev(端口 ${DEV_PORT},不是 5175)`)
      const { createServer } = await import('vite')
      vite = await createServer({
        configFile: path.join(appRoot, 'vite.config.ts'),
        server: { port: DEV_PORT, strictPort: true },
        logLevel: 'warn',
      })
      await vite.listen()
      rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`
    }

    console.log('[4/5] 拉起应用(屏外档 · 独立 user-data-dir)')
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
      width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 0, mobile: false,
    })
    await page.addInitScript(LEAF_PROBE)
    await page.evaluate(LEAF_PROBE)
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const v = await page.evaluate(() => window.__d0 ?? null)
      return v && v.rpcOk ? v : undefined
    })

    /**
     * 打开一条会话,**并且等它真的起完底**。
     *
     * 后半句是第一趟真机踩出来的:只等 `chat-stream` 在不在,50.9MB 那条会话
     * 此刻还在 `status === 'loading'`,这时候往输入框里打字、点发送,发出去的那一发
     * 落在一台还没起底的机器上 —— 屏幕上什么都没有,「开张」那一闸只好等到超时。
     * 判据照抄探针:列上摆出了 `expect` 条(或者至少 8 条)`[data-message-id]`。
     * 空会话那一档 `expect` 是 0,那时这一句退化成一次恒真的检查,不必特判。
     */
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
        Boolean(window.__gLeaf().querySelector('[data-testid="chat-stream"]'))))
      if (expect > 0) {
        await waitFor('账本起完底', async () => {
          const n = await page.evaluate(() => window.__gLeaf()
            .querySelectorAll('[data-testid="chat-stream"] [data-message-id]').length)
          return n >= Math.min(expect, 8) ? n : undefined
        }, OPEN_TIMEOUT_MS)
        console.log(`      起底 ${waitFor.lastMs}ms`)
      }
      await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
      await delay(800)
      await settleBackfill()
    }

    /**
     * **等这条列把历史补完**(第一趟真机之后加的;09-10 的 `useTailWindow` ①)。
     *
     * 消息是**按屏进**的:进场只摆列尾那一窗,之后每一次 `requestIdleCallback` 往前
     * 补一批,直到全量到齐。那条路在 50.9MB / 400 条那份夹具上是真的贵,而且它与
     * 这道门要量的事**正交**:
     *  · 真机读数(这道门自己打出来的):超量那一档凡是 >50ms 的长帧,**每一个**都
     *    带着「同一帧列上多出 N 格」这句话 —— 热身那一轮一帧补了 378 格 / 183ms,
     *    其余每一轮补 1 格 / 50–117ms(那一格里可能装着几十张工具卡);
     *  · 补进来的行第一次渲出**真高**比估高(`--msg-intrinsic-h` 240px)矮,内容列
     *    跟着矮一截,而 `useTailWindow` 的补偿只对得上 prepend 那一下、对不上这之后
     *    的再渲(判词写在 `ChatStream.tsx` 那只补偿 layout effect 上)—— 真机量到
     *    `sh` −19,屏上跟着动 18.6px。
     *
     * 那是**列自己在补历史**的账(`gate:chat-layout` / 09-10 那一批的地盘),不是
     * 「这一轮流式的几何」。所以这道门在开量之前先把它等完,并把等了多久打出来 ——
     * **等不完也不假装**:超时就照说,后面那些读数自己会带上「多出 N 格」。
     */
    const settleBackfill = async () => {
      const rows = () => page.evaluate(() => {
        const scroll = window.__gLeaf().querySelector('[data-testid="chat-stream"]')
        return scroll?.firstElementChild?.children.length ?? 0
      })
      const started = Date.now()
      let last = await rows()
      let stable = 0
      /* 连着五次(1.5s)不再长就算补完;120s 封顶 —— 它是一条闸,不是一格预算。 */
      while (Date.now() - started < 120_000 && stable < 5) {
        await delay(300)
        const now = await rows()
        stable = now === last ? stable + 1 : 0
        last = now
      }
      console.log(`      补历史补完:${last} 格(等了 ${Date.now() - started}ms)`)
    }

    /**
     * **每轮开录之前先回到底**(探针文件头坑 ③):人发下一条消息时是在底部,
     * 上一轮若把视口留在半空,这一轮量的就不是同一件事。
     */
    const scrollToBottom = async () => {
      await page.evaluate(() => {
        const scroll = window.__gLeaf().querySelector('[data-testid="chat-stream"]')
        if (scroll) scroll.scrollTop = scroll.scrollHeight
      })
      await delay(500)
    }

    /**
     * 跑一轮:回底 → 开录 → 发 → 等开张 →(可选的中途动作)→ 等收场 → 收录 → 算。
     * `during` 收到 `{ page, mark }`,由它自己决定什么时候动手,并把**用户动手的
     * 时刻**回给这里 —— 那几段时间里的几何变化不算产品自己动的(`USER_ACT_MS`)。
     */
    const runOnce = async (label, text, { during, tailMs = 1800, keepScroll = false, thoughtFlat } = {}) => {
      if (!keepScroll) await scrollToBottom()
      await page.evaluate(() => { window.__gAnchor = undefined })
      await startSampler(page)
      const wall = Date.now()
      const userActs = []
      await sendViaComposer(page, text)
      await waitFor(`${label} 开张`, () => stopShown(page), OPEN_TIMEOUT_MS)
      const openMs = waitFor.lastMs
      if (during) {
        const at = await during({ page })
        if (typeof at === 'number') userActs.push(at)
      }
      await waitFor(`${label} 收场`, async () => !(await stopShown(page)), 300_000)
      await delay(tailMs)
      const frames = await stopSampler(page)
      const m = analyze(frames, userActs, thoughtFlat)
      m.openMs = openMs
      m.laneMs = Date.now() - wall
      report(label, m)
      return m
    }

    /**
     * **上拨那一档的锚**(正本 §5.3 那句「注意」):P1 之后收起态思考段里没有可读的
     * 长文,所以上拨去读的是**上一轮的正文** —— 往上翻半屏,把此刻视口正中那一段
     * `<p>` 钉下来,断言新一轮全程它不动、而且始终在 DOM 里。
     */
    const scrollUpAndPin = async ({ page: p }) => {
      await waitFor('这一轮真的开始长了', async () => p.evaluate(() => {
        const scroll = window.__gLeaf().querySelector('[data-testid="chat-stream"]')
        return scroll ? scroll.scrollHeight > scroll.clientHeight * 2 : false
      }), 90_000)
      await delay(800)
      const picked = await p.evaluate(() => {
        const scroll = window.__gLeaf().querySelector('[data-testid="chat-stream"]')
        scroll.scrollTop = Math.max(0, scroll.scrollTop - Math.round(scroll.clientHeight / 2))
        const r = scroll.getBoundingClientRect()
        /*
         * **钉住「他此刻正在读的那一块」**。第一版只认 `<p>`,于是视口正中落在代码块 /
         * 表格 / 折痕 / 两行之间的空白上时一个锚都钉不到(真机实测:0 帧),
         * ⑥ 那三条全靠「量到没量到」那一句才没有恒绿放行。
         * 今天的判据宽一格:**一块内容**(`<p>` ∪ `data-prose` ∪ `data-block-kind`),
         * 再兜一次底 —— 正中什么都没有时退到「视口里第一块整个看得见的东西」,
         * 与产品的 `pickFoldAnchor` 同一条判据。
         */
        const isBlock = (el) => el.tagName === 'P'
          || el.hasAttribute?.('data-prose') || el.hasAttribute?.('data-block-kind')
        let el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        while (el && el !== scroll && !isBlock(el)) el = el.parentElement
        if (!el || el === scroll) {
          const top = r.top
          const rows = scroll.firstElementChild?.children ?? []
          for (const row of rows) {
            if (row.hasAttribute('data-seat') || row.hasAttribute('data-tail-slot')) continue
            const rr = row.getBoundingClientRect()
            if (rr.top >= top - 1 && rr.height > 0) { el = row; break }
          }
        }
        if (el && el !== scroll) window.__gAnchor = el
        return {
          at: performance.now(),
          tag: el && el !== scroll ? el.tagName : null,
          top: el && el !== scroll ? Number(el.getBoundingClientRect().top.toFixed(1)) : null,
        }
      })
      console.log(`        上拨之后钉下 ${picked.tag ?? '(没钉到)'} @top=${picked.top}`)
      await delay(400)
      return picked.at
    }

    const pressStop = async ({ page: p }) => {
      await delay(3500)
      return p.evaluate(() => {
        const btn = window.__gLeaf().querySelector('[data-testid="chat-stop"]')
        if (btn instanceof HTMLElement) btn.click()
        return performance.now()
      })
    }

    /** 八个场景,两档各跑一遍(顺序即依赖:上拨那一档要上面已经有一轮正文可读)。 */
    const SCENARIOS = [
      { id: 'text', name: '纯文本', mark: MARKS.text },
      { id: 'code', name: '首块=代码块', mark: MARKS.code },
      { id: 'think3k', name: '3 千字思考→正文', mark: MARKS.think3k, thoughtFlat: FLAT_3K },
      { id: 'think60k', name: '6 万字思考→正文(贴底)', mark: MARKS.think60k, thoughtFlat: FLAT_60K },
      { id: 'scrollUp', name: '6 万字思考 + 中途上拨半屏', mark: MARKS.scrollUp, during: scrollUpAndPin, thoughtFlat: FLAT_60K },
      { id: 'tools', name: '思考→工具→思考→正文', mark: MARKS.tools, thoughtFlat: FLAT_3K },
      { id: 'long', name: '长回复(吃光座位)收尾', mark: MARKS.long },
      { id: 'abort', name: '中途停止', mark: MARKS.abort, during: pressStop },
    ]

    console.log('\n[5/5] 场景')
    const lanes = [
      { id: 'short', name: '短会话', sessionId: shortId, expect: 0 },
      { id: 'big', name: '超量', sessionId: bigId, expect: seeded.messages },
    ].filter((l) => !ONLY_LANE || l.id === ONLY_LANE)
    for (const lane of lanes) {
      console.log(`\n—— ${lane.name} ——`)
      await openSession(lane.sessionId, lane.expect)
      /* 热身一轮,**不量**(判词整段在 `MARKS.warm` 上)。 */
      console.log(`  · ${lane.name} / 热身(不量)`)
      const warm = await runOnce(
        `${lane.id}/warm`,
        `几何门 热身 ${markFor(MARKS.warm, lane.id)}`,
        { tailMs: 1200 },
      )
      console.log(`      热身:开张 ${warm.openMs}ms · 长帧 ${warm.longFrames}`
        + `(最长 ${warm.longestFrameMs}ms)—— 这一格是开张的账,不进判据`)
      readings.warm = { ...(readings.warm ?? {}), [lane.id]: { openMs: warm.openMs, longFrames: warm.longFrames, longestFrameMs: warm.longestFrameMs } }
      for (const sc of SCENARIOS) {
        console.log(`  · ${lane.name} / ${sc.name}`)
        readings.scenarios[`${lane.id}:${sc.id}`] = await runOnce(
          `${lane.id}/${sc.id}`,
          `几何门 ${sc.name} ${markFor(sc.mark, lane.id)}`,
          { during: sc.during, thoughtFlat: sc.thoughtFlat },
        )
      }
    }

    /* ══ 判 ══════════════════════════════════════════════════════════════ */
    console.log('\n[判据]')
    for (const [key, m] of Object.entries(readings.scenarios)) {
      /** 过渡值按「这一档 + 这一场景」找,由窄到宽(判词在 `limitOf` 上)。 */
      const cap = (k, budgetKey) => limitOf(k, key, budgetKey)
      assert(!m.empty && m.frames > 20, `${key} 采到了 ${m.frames} 帧(> 20)`)
      if (m.empty) continue

      /* ① 首字帧。先判「量到没量到」—— 窗口空着时位移与自己比恒为 0。 */
      assert(
        m.handoff.frames > 1,
        `${key} ① 首字换手那一段采到 ${m.handoff.frames} 帧(> 1)`,
      )
      assert(
        m.handoff.maxPx <= BUDGET.firstTokenSlotShiftPx,
        `${key} ① 首字帧尾槽位移 ${m.handoff.maxPx}px ≤ ${BUDGET.firstTokenSlotShiftPx}`,
      )

      /*
       * ② 整轮尾槽。**上拨那一档不判** —— 人自己把视口挪走了,尾槽当然跟着内容
       * 一起走;那一档要守的是「他正在读的那一块别动」,归 ⑥。
       */
      if (!key.endsWith(':scrollUp')) {
        assert(m.pinned.frames > 10, `${key} ② 整轮采到 ${m.pinned.frames} 帧(> 10)`)
        assert(
          m.pinned.maxPx <= cap('tailSlotShiftPx') && m.pinned.stepPx <= cap('tailSlotShiftPx'),
          `${key} ② 整轮尾槽位移 最远 ${m.pinned.maxPx} / 单帧 ${m.pinned.stepPx}px`
          + ` ≤ ${cap('tailSlotShiftPx')}`
          + (cap('tailSlotShiftPx') === BUDGET.tailSlotShiftPx ? '' : '(过渡值)'),
        )
        assert(
          m.pinned.flips <= BUDGET.tailSlotFlips,
          `${key} ② 整轮尾槽方向反转 ${m.pinned.flips} 次 ≤ ${BUDGET.tailSlotFlips}`,
        )
      }

      /* ③ 收尾帧改动点以上。 */
      assert(m.end.frames > 1, `${key} ③ 收尾那一帧采到了(窗口 ${m.end.frames} 帧 > 1)`)
      assert(
        m.end.maxPx <= BUDGET.endAboveShiftPx,
        `${key} ③ 收尾帧改动点以上位移 ${m.end.maxPx}px ≤ ${BUDGET.endAboveShiftPx}`,
      )

      /* ④ 思考段的高。没有思考段的那几档跳过(不判恒绿的断言)。 */
      if (m.thought.elements > 0) {
        assert(
          m.thought.liveDeltaPx <= BUDGET.thoughtHeightPx,
          `${key} ④ 思考段 live 期间高度变化 ${m.thought.liveDeltaPx}px ≤ ${BUDGET.thoughtHeightPx}`
          + `(${m.thought.elements} 段 / ${m.thought.frames} 帧)`,
        )
        assert(
          m.thought.settleDeltaPx <= BUDGET.thoughtHeightPx,
          `${key} ④ 思考段落定帧高度变化 ${m.thought.settleDeltaPx}px ≤ ${BUDGET.thoughtHeightPx}`,
        )
      }

      /*
       * ④b 收起态那一行**真的是一行、真的贴着右边、真的显示的是末尾**
       * (2026-09-20 审查打回第 1 条;判词在 `analyze` 的 ④b 那一段)。
       * 只在喂了思考的那几档判 —— 其余档没有这一行,判它是恒绿。
       */
      if (m.liveLine.frames > 0) {
        assert(
          m.liveLine.frames > 50,
          `${key} ④b 收起态那一行采到 ${m.liveLine.frames} 帧(> 50)`,
        )
        assert(
          m.liveLine.maxLineHPx <= m.liveLine.maxBoxHPx + 1,
          `${key} ④b 它**是一行**:行高 ${m.liveLine.maxLineHPx}px ≤ 格高`
          + ` ${m.liveLine.maxBoxHPx}px + 1(排成两行就是两倍,而格高钉死、外面看不出来)`,
        )
        assert(
          m.liveLine.maxRightGapPx <= BUDGET.liveLineRightGapPx,
          `${key} ④b 右端对齐:字的右缘与格右缘差 ${m.liveLine.maxRightGapPx}px`
          + ` ≤ ${BUDGET.liveLineRightGapPx}`,
        )
        /* 「它显示的是哪一截」只有**喂了尺**的那几档答得出;没有尺就不判(不判恒绿的断言)。 */
        assert(
          !m.liveLine.tracked || m.liveLine.headHits === 0,
          `${key} ④b 它显示的**不是开头**(落在整份思考第 0 字的帧 ${m.liveLine.headHits} 个 = 0)`,
        )
        assert(
          !m.liveLine.tracked || m.liveLine.advances > 0,
          `${key} ④b 它**跟着流在走**(位置往前推进 ${m.liveLine.advances} 次 > 0)`,
        )
      }

      /* ⑤ 回缩。 */
      assert(
        m.shrinks.length <= BUDGET.shrinks,
        `${key} ⑤ 非用户动作的 scrollHeight 回缩 ${m.shrinks.length} 次 ≤ ${BUDGET.shrinks}`,
      )

      /* ⑦ 长帧。数与最长两格都判 —— 只判个数的话一帧变成一秒也看不出来。 */
      assert(
        m.longFrames <= cap('longFrames')
        && (m.longFrames === 0 || m.longestFrameMs <= cap('longFrameMs', 'longFrameMs')),
        `${key} ⑦ 流式期间 >${BUDGET.longFrameMs}ms 长帧 ${m.longFrames} 个 ≤ ${cap('longFrames')}`
        + `(最长 ${m.longestFrameMs}ms`
        + (cap('longFrames') === BUDGET.longFrames ? '' : ` ≤ ${cap('longFrameMs', 'longFrameMs')},过渡值`)
        + ')',
      )

      /* ⑥ 只在上拨那一档判。 */
      if (key.endsWith(':scrollUp')) {
        assert(m.anchor.frames > 20, `${key} ⑥ 锚点采到 ${m.anchor.frames} 帧(> 20)`)
        assert(m.anchor.dead === 0, `${key} ⑥ 锚点始终在 DOM 里(摘掉 ${m.anchor.dead} 帧)`)
        assert(
          m.anchor.maxPx <= BUDGET.anchorShiftPx,
          `${key} ⑥ 用户锚点全程位移 ${m.anchor.maxPx}px ≤ ${BUDGET.anchorShiftPx}`,
        )
      }
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

  /*
   * **收尸自查**(壳 CLAUDE.md「真机 harness 退出必须收尸」):自己起的那几只
   * (vite / electron / dist/server)有没有留下。判据用**这一趟自己的临时目录名**
   * 与 dev 端口 —— 不认别人的进程(同机可能并跑着 gate:send-flow)。
   */
  try {
    const ps = execFileSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf-8' })
    const mine = ps.split('\n').filter((line) =>
      line.includes('geo-store-') || line.includes('geo-udd-')
      || (!PROD && line.includes(`:${DEV_PORT}`)))
    if (mine.length) {
      console.log(`\n[stream-geometry] **残留自查:还有 ${mine.length} 条**\n  ${mine.join('\n  ')}`)
    } else {
      console.log('\n[stream-geometry] 残留自查:干净(vite / electron / server 都收了)')
    }
  } catch {
    console.log('\n[stream-geometry] 残留自查:ps 跑不起来,跳过')
  }

  console.log(`\n[stream-geometry] 读数(${LANE}):${JSON.stringify(readings)}`)
  if (Object.keys(TRANSITIONAL).length) {
    console.log(`[stream-geometry] 过渡值(每一格都带退场判据):${JSON.stringify(TRANSITIONAL)}`)
  }
  if (failures.length) {
    console.error(`\n[stream-geometry] FAILED(${LANE})—— ${failures.length} 条:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`\n[stream-geometry] ok(${LANE})—— 流式几何七条在真机上成立`)
}

main().catch((error) => {
  console.error(`\n[stream-geometry] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
