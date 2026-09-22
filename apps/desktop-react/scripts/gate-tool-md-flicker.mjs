#!/usr/bin/env node
/**
 * **`gate:tool-md-flicker` —— 工具卡换挡 + markdown 落定的真机门**(R 线 F1,2026-09-22)。
 *
 * 它是同一天那只探针(`probe-tool-md-flicker.mjs`)长成的:量法、取样口、三层分析
 * 一个字没改,**加的是判据**。起因是用户报的两条,原话:
 *   「工具调用在接收参数、执行、结束时会有闪烁的情况出现」
 *   「在流式过程中到结束时,能够看到 markdown 的没有渲染的时候,导致在未渲染和到
 *     渲染结束时会有一个 ui 的变化」
 * 探针把它们量成了三条病,每一条都有 main 上的读数(正本 `docs/stream-render-2026-09.md` §8):
 *   病 1 每一步 opacity `1 → 0 → 1`、86–100ms,每行 1–2 次;
 *   病 2 快工具多步换步时行高 `0 → 43 → 0` 一帧往返,每换一步两回;
 *   病 3 公式闭合那一拍**换了节点**(DIV life 65 → 66),高 45 → 26.98、padding 0 → 4px 0。
 *
 * ── 判据(A 档八格 + 真店一格;B 档短会话 + 真店)───────────────────────────
 *  A①**卡不重挂**:`[data-tool-card]` 的节点身份号一趟里只有一个。
 *  A②**行不换元素**:每一行的 `tagName` 一趟里只有一个(从前参数收齐那一拍
 *     `DIV → BUTTON`,而换元素就是换节点)。
 *  A③**淡入至多一次,而且只在进场帧**:把每一行切成若干**在屏段**(连续的
 *     `!hidden ∧ display ≠ none`),段内不透明度只许从段首那一格往上走 —— 段中出现
 *     「先 ≥0.95、后 <0.95」就是把一行已经画好的东西按回 0,红;整趟带淡入的段
 *     不许超过一段。
 *  A④**行高一帧内往返 0**:一行的高变了又在两帧内回到原值 = 消失又出现。
 *  A⑤**行高零往返的孪生**:卡自己的高也不许一帧内往返。
 *  B⑥**一个节点都不许换**:这份素材里合法的原位换装(段落→表)走的是承诺政策,
 *     不产生 `replace`;所以这一档的 `replace` 计数是**零基线**。
 *  B⑦**公式那一块从头到尾是同一个 DOM 节点**,而且它的 `padding` 一趟里只有一个值
 *     —— 这两条合起来正是它注册那一行自述的 `settled: 'same'`。
 *  B⑧**闭合那一帧下文一个像素都不许动**(|位移| ≤ 1px):公式排好之后比它那段 TeX
 *     源码矮是**排版的事实**(第一条 18.02px、第二条 9.38px,`TRANSITIONAL` 里记着,
 *     退场判据写在那一行上),而贴底那条路把这一下吃掉了 —— 实测下文只动 0.03 / 0.12px。
 *     两件事各判一条,不许相减合成一条(第一版就是那么写的,真机当场证伪)。
 *  B⑨**每一块的身份从生到死只有一个号**(`replace` 之外的另一半:就地改型也要记账)。
 *
 * 长帧**只报不判**:dev 档上首屏与 shiki 会留下 100–200ms 的帧,把它判红等于把一条
 * 已知的旧病钉成恒红,而恒红的门只会被人加 `|| true`(壳 CLAUDE.md 对 gate:perf 的
 * 第二条理由)。像素层同理 —— 它是**佐证**不是判据(内容在长,像素本来就一直在变)。
 *
 * ── 取样口:画出来的那一份,不是 rAF ──────────────────────────────────────
 * 正本 `docs/stream-geometry-2026-09.md` §9.7 / §10.3 的判例:`requestAnimationFrame`
 * 跑在「动画推进之后、布局与 ResizeObserver 之前」,读到的是**这一帧的半成品**。
 * 所以这一支的 DOM 层与 `gate-tail-jitter` 用同一口:**在 rAF 里 `postMessage`
 * 出去的那个宏任务里读** —— 它跑在这一帧的「更新渲染」(样式→布局→绘制→提交)
 * 全部走完之后、下一帧的任何东西之前,读到的矩形与 computed 就是刚画出去的那一份。
 * 此刻布局是干净的,所以读矩形命中缓存、不逼重排(09-10「探针自伤」判例要防的是
 * 在热路径上逼重算,不是禁止读矩形)。
 *
 * ── 三层 ──────────────────────────────────────────────────────────────────
 *  · **DOM / 样式层**(画出来的那一口,逐帧):
 *      A 档(工具卡):最后一张 `[data-tool-card]` 的矩形 / `data-multi` / `data-open`,
 *        它每一行(`[data-call-id]`)的**节点身份号**(expando,进程级递增 —— 号变了
 *        = 换了节点 = 重挂,违反 ToolCard.tsx 纪律第 1 条)、`tagName`、
 *        `data-tool-status` / `data-tool-tone` / `data-reveal` / `hidden`、矩形与 computed
 *        `display·visibility·opacity·height·transform`;外加头行图标堆栈、
 *        `PermissionSlot` / `ToolDrawer` / 底缘进度条在不在。
 *      B 档(markdown):活消息 `article[data-message-id]` 的**逐个孩子**的
 *        身份号 / `tagName` / `data-block-kind` / `data-geometry` / 矩形 ——
 *        **同一个下标上换了号或换了元素型 = 「未渲染 → 渲染」那一下的实体**。
 *        每个节点**第一次出现**那一帧读一次 computed(字号 / 字重 / 行高 / 上下外边距 /
 *        背景 / 字体族 / 等宽否),于是换装前后两份样式都在手上,而每帧的活儿仍是 O(孩子数)。
 *        **公式那一块另有一格逐帧读**(`f.math`):它是 B⑦ / B⑧ 的取样口,判据要的是
 *        「每一帧的 padding 与高」,而 styleBook 按定义只读第一帧。
 *      两档都挂一只 MutationObserver(childList/attributes/subtree)记下每一次改动。
 *  · **像素层**:CDP `Page.startScreencast`(png)整窗抽帧,事后零依赖解码
 *    (`lib/png.mjs`),裁到被量的那一块(A = 卡,B = 活消息),逐帧算
 *    平均亮度 + 变化像素占比,判据**不是「变了」**(内容在长本来就变),而是
 *    **偏离前后邻居的中位数、而且一两帧之后又弹回去**(`classify`:spike / step / edge,
 *    与 `probe-composer-flicker` 同一条判词)。出事帧连同前后各一帧落盘。**只报不判**。
 *  · **长帧层**:`PerformanceObserver(['long-animation-frame','longtask'])`,
 *    **切窗口取样**(那一段开始时开、结束时关,`buffered` 不开)—— 09-12 判例:
 *    一只 observer 从头开到尾收到的是开壳与首屏留下的历史帧。**只报不判**。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * 屏外档(`ONETHING_GATE_OFFSCREEN=1`,不是 `ONETHING_GATE_HEADLESS`:后者把整扇窗
 * 节流到 1Hz,量的会是节流器);输入一律走 `page.evaluate` / CDP(不动真光标、
 * 不抢前台);store 与 `--user-data-dir` 都是临时目录,跑完删干净,**绝不连
 * `~/.onething`**;vite 端口 5311(避开用户的 5175 与同机别的门);
 * `finally` 收尸 + `ps` 自查。
 *
 * ── 反证 ──────────────────────────────────────────────────────────────────
 * `--selftest` 那一档人为藏两帧 + 人为换一个节点,三层必须都红(它证的是**灵敏度**:
 * 一道永远绿的门与没有门是同一件事)。每条产品判据的「拆掉即红」用**备份文件**回滚
 * 源码重跑,禁 `git checkout`(壳 CLAUDE.md 反证纪律)。
 *
 * 跑法:`node scripts/gate-tool-md-flicker.mjs [--only a,b] [--selftest] [--prod]`
 *      [--lane short|big|both] [--pix-w 1280] [--max-frames 900] [--out 目录] [--json 路径]
 * (仓根先 `bun run server:build`;两档都先 `npm run electron:build`,
 *  `--prod` 还要 `npm run app:build`。)
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
import { decodePng } from './lib/png.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const PROD = process.argv.includes('--prod')
const LANE = PROD ? 'prod' : 'dev'
const DEV_PORT = Number(process.env.ONETHING_GATE_VITE_PORT ?? 5311)
const VIEWPORT = { width: 1280, height: 800 }
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : fallback
}
const ONLY = (() => {
  const v = argOf('--only')
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null
})()
const WHICH_LANE = argOf('--lane', 'both')
const PIX_W = Number(argOf('--pix-w', 1280))
const OUT_DIR = argOf('--out', path.join(
  process.env.TMPDIR ?? '/tmp', `tool-md-flicker-gate-${Date.now()}`))
const MAX_PIX_FRAMES = Number(argOf('--max-frames', 900))

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false

/* ══ 判据 ═════════════════════════════════════════════════════════════════
 *
 * 全是**结构与像素位置**,零毫秒读数 —— 同一份代码同一个视口跑一百遍是同一个答案
 * (与 `gate:stream-geometry` / `gate:send-flow` 同族;长帧与像素层在这道门里
 * **只报不判**,理由写在文件头)。
 */
const BUDGET = {
  /** A① 卡的节点身份号一趟里只有一个。 */
  cardRemounts: 0,
  /** A② 每一行的 `tagName` 一趟里只有一个。 */
  rowTagSwaps: 0,
  /** A② 的孪生:行的节点身份号也只有一个。 */
  rowRemounts: 0,
  /** A③ 在屏段**中途**被按回透明 —— 这就是病 1。 */
  rowLateFades: 0,
  /** A③ 的另一半:整趟带淡入的在屏段不许超过一段(「一行只淡入一次」)。 */
  rowEntranceFades: 1,
  /** A④ 行高一帧内往返(病 2 的形)。 */
  rowHeightRoundTrips: 0,
  /** A⑤ 卡高一帧内往返。 */
  cardHeightRoundTrips: 0,
  /** B⑥ 这份素材里一个节点都不该换(合法的原位换装走承诺政策,不产生 replace)。 */
  blockReplaces: 0,
  /** B⑨ 就地改型也算换装,这份素材里同样是零。 */
  blockMutates: 0,
  /** B⑦ 一条公式一生只用一个 DOM 节点、只有一种 padding。 */
  mathNodes: 1,
  mathPads: 1,
}

/**
 * **过渡值** —— 今天达不到、但退场判据写在这一行上的那几格。
 * 体例与 `gate-browser` / `gate-chat-layout` 逐字同源:**抬 `BUDGET` 是改法,
 * 让一格恒红只会被人加 `|| true`**。
 */
const TRANSITIONAL = {
  /*
   * B⑧ 公式换装那一帧,下文往上跳多少像素。
   *
   * **判的是「除了公式自己的高度差,别的什么都没动」** —— 所以真正的断言是
   * `|下文位移 − 公式高度差| ≤ 1px`(见 `judge`),这一格管的是那个高度差本身
   * 还剩多大。今天 18.02px:排好的公式(26.98)就是比它那段 TeX 源码(45)矮,
   * 这是两种排版的事实,不是漂移。
   *
   * **退场判据**:哪一天流式期那一格不再是「一段 mono 源码」(候选 (a) 让 KaTeX
   * 排半截、或者别的什么让两态等高),这个数会自己掉到 1 以下,那时删掉这一行。
   * 在那之前它交给 G 线的垫块吸收 —— 它不是用户动作,`cause` 是 `settle`,由
   * `ViewportAnchor` 裁(正本 §8 的留账)。
   */
  mathSettleDropPx: 19,
}

/* ══ 假 provider ══════════════════════════════════════════════════════════
 *
 * 四个工具记号 = {慢 / 快} × {单步 / 多步};一个 markdown 记号。
 *
 * **参数一定要分很多片送**:用户报的第一段就是「接收参数」那一档,一次送完的话
 * `input-streaming` 只存在一帧,那一档根本量不到。
 *
 * 慢 / 快的分界照产品自己那条线:`components/motion` 的 `MIN_BUSY_MS`(250ms)——
 * 快工具用 `echo`(几十毫秒收场,压根不该露 busy 形),慢工具用 `sleep 1.8`。
 */
const MARKS = {
  toolSlowSingle: '@@tm-slow-1@@',
  toolFastSingle: '@@tm-fast-1@@',
  toolSlowMulti: '@@tm-slow-n@@',
  toolFastMulti: '@@tm-fast-n@@',
  md: '@@tm-md@@',
  warm: '@@tm-warm@@',
}

/**
 * B 档的正文。**切点故意落在语法中间** —— 用户那一句「看得到 markdown 没有渲染的
 * 时候」说的正是半截语法在屏上的样子,所以这里不按字数均分,按**语法位置**手切。
 * 每一片后面跟一个毫秒数 = 送完它之后停多久(停够一帧才看得见那个中间态)。
 */
const MD_PIECES = [
  ['#', 90],                                   // 井号后面没空格:此刻它是段落还是标题?
  [' 一级标题:块流探针\n\n', 120],
  ['这一段里有**粗', 90],                        // 粗体跨 chunk 边界被切开
  ['体**、`行内', 90],                           // 行内代码跨边界
  ['代码` 与一个链接 [示例](htt', 90],            // 链接 URL 被切开
  ['ps://example.com)。\n\n', 120],
  ['## 二级标题\n\n', 110],
  ['- 列表第一项\n', 80],
  ['- 列表第二项\n', 80],
  ['  - 嵌套第一项\n', 80],
  ['  - 嵌套第二项\n', 80],
  ['- 列表第三项\n\n', 110],
  ['```', 90],                                  // 围栏刚开,语言名还没到
  ['ts\n', 90],
  ['export function hello(name: string) {\n', 90],
  ['  return `hi ${name}`\n', 90],
  ['}\n', 90],
  ['```\n\n', 160],                              // 闭合:code 落定 + shiki 高亮到位
  ['| 列 A | 列 B | 列 C |\n', 120],             // 表头第一行(此刻还不是表)
  ['|', 90],                                     // 分隔行只来了一根竖线
  ['---|---|---|\n', 120],                       // 分隔行补齐:表在这一拍成形
  ['| a1 | b1 | c1 |\n', 90],
  ['| a2 | b2 | c2 |\n', 90],
  ['| a3 | b3 | c3 |\n\n', 120],
  ['> 这是一段引用,\n', 90],
  ['> 它有第二行。\n\n', 110],
  ['$$', 90],                                    // 公式起手,半截
  ['\n  E = mc^2\n', 90],
  ['$$\n\n', 140],
  /*
   * **第二条公式:半截的时候它不是合法 TeX**(F1 加的素材)。
   *
   * 第一条(`E = mc^2`)的每一个前缀碰巧都排得出来,于是「流式期就交给 KaTeX 排」
   * 那条候选在它身上看起来很干净 —— 素材在替候选说话。`\frac{a}{` 不是:KaTeX
   * (`renderTex` 钉着 `throwOnError: true`)对它当场抛,落进「排不出来」那一支,
   * 屏上会多出一行灰说明再消失。**判据要能分得出这两种候选,素材就必须有这一条。**
   */
  ['$$\n  \\frac{a}{', 90],
  ['b} + \\sqrt{', 90],
  ['c}\n', 90],
  ['$$\n\n', 140],
  ['---\n\n', 110],                              // 水平线
  ['最后一段收尾正文,它要够长,好让收场那一帧的对照有东西可比:'
    + '块流的落定按契约应当是「同一个渲染器,只是内容长齐了」,'
    + '所以这一段在收场前后不该换节点。\n', 140],
]

const REPLY_SHORT = '好的,下面是结论。'
const LANES = ['short', 'big']
const markFor = (mark, lane) => `${mark.slice(0, -2)}-${lane}@@`
const FIRST_BYTE_DELAY_MS = 500

/** 参数分多少片、每片间隔多久 —— `input-streaming` 那一档因此存在 ~1.2 秒。 */
const ARG_PIECES = 16
const ARG_GAP_MS = 75

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
      /*
       * **「这一回合有没有跑过工具」要从最后一条用户消息之后数起**(第一趟真机踩的):
       * 整条历史里数 `role === 'tool'` 的话,同一条会话里第二次发工具记号时,上一轮
       * 留下的 tool 消息就让它直接走「工具跑完了」那一支 —— 八格里只有第一格量到了卡。
       */
      let lastUserAt = -1
      for (let k = msgs.length - 1; k >= 0; k -= 1) if (msgs[k]?.role === 'user') { lastUserAt = k; break }
      const toolTurns = msgs.slice(lastUserAt + 1).filter((m) => m?.role === 'tool').length
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = (o) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(o)}\n\n`) }
      const frame = (delta, finish = null) => ({
        id: 'chatcmpl-toolmd', object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: 'deepseek-chat',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const bye = (finish = 'stop') => {
        if (!res.destroyed) { send(frame({}, finish)); res.write('data: [DONE]\n\n') }
        res.end()
      }
      const streamPieces = async (pieces) => {
        for (const [text, gap] of pieces) {
          if (res.destroyed) return
          send(frame({ content: text }))
          await delay(gap)
        }
      }
      /** 一次工具调用:先报名字,再把参数切成 `ARG_PIECES` 片慢慢送。 */
      const streamToolCall = async (index, command) => {
        send(frame({
          tool_calls: [{
            index, id: `call_${index}_${Date.now()}`, type: 'function',
            function: { name: 'bash', arguments: '' },
          }],
        }))
        const args = JSON.stringify({ command })
        const size = Math.max(1, Math.ceil(args.length / ARG_PIECES))
        for (let at = 0; at < args.length; at += size) {
          if (res.destroyed) return
          send(frame({ tool_calls: [{ index, function: { arguments: args.slice(at, at + size) } }] }))
          await delay(ARG_GAP_MS)
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
      /* 工具那几档每一轮要走两趟(发起 + 结论),所以预算只掐非工具档。 */
      if (kind && !kind.startsWith('tool')) {
        state[slot] = (state[slot] ?? 0) + 1
        if (state[slot] > 2) kind = null
      }
      if (!kind) { bye(); return }
      await delay(FIRST_BYTE_DELAY_MS)
      if (res.destroyed) return

      if (kind.startsWith('tool')) {
        if (toolTurns === 0) {
          const slow = kind.includes('Slow')
          const multi = kind.includes('Multi')
          // 慢 1.8s(远大于 250ms 的 busy 门槛);快 = 纯 echo,几十毫秒收场。
          const cmd = (n) => (slow ? `sleep 1.8; echo slow-${n}` : `echo fast-${n}`)
          const count = multi ? 3 : 1
          for (let i = 0; i < count; i += 1) await streamToolCall(i, cmd(i))
          bye('tool_calls')
          return
        }
        await streamPieces([['工具跑完了。' + REPLY_SHORT + '\n', 60]])
        bye()
        return
      }
      if (kind === 'md') { await streamPieces(MD_PIECES); bye(); return }
      await streamPieces([['热身一轮,不量。', 60]])
      bye()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/* ══ core / 发现文件(照抄 probe-composer-flicker)═══════════════════════════ */
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
window.__tmLeaf = function () {
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

/* ══ DOM 层:画出来的那一口逐帧取样 ════════════════════════════════════════ */

/**
 * @param mode 'tool' = 只量最后一张工具卡;'md' = 只量活消息的孩子列。
 *   分开是为了每帧的活儿便宜(09-10「探针自伤」判例):两档同时开的话,
 *   30 个块的矩形 + 一张多步卡的 computed 每帧都要读一遍。
 */
async function startSampler(page, mode) {
  await page.evaluate((sampleMode) => {
    window.__tmFrames = []
    window.__tmMuts = []
    window.__tmStop = false
    window.__tmMode = sampleMode
    /* 身份号**进程级递增、不按趟重置** —— 这一支问的是「它从头到尾是不是同一个
     * DOM 节点」,号一按趟重置,重挂就再也看不出来了(同 probe-composer-flicker)。 */
    window.__tmLife = window.__tmLife ?? 0
    const lifeOf = (el) => {
      if (!el) return null
      if (el.__tmLife === undefined) { window.__tmLife += 1; el.__tmLife = window.__tmLife }
      return el.__tmLife
    }
    /** 每个节点**第一次出现**那一帧读一次 computed,之后原样交回 —— 换装前后两份都在手上。 */
    const styleBook = (window.__tmStyleBook = new Map())
    const styleOf = (el) => {
      const life = lifeOf(el)
      if (life === null) return null
      const had = styleBook.get(life)
      if (had) return { life, cs: had, fresh: false }
      const c = getComputedStyle(el)
      const cs = {
        fontSize: c.fontSize, fontWeight: c.fontWeight, lineHeight: c.lineHeight,
        fontFamily: c.fontFamily.slice(0, 40), whiteSpace: c.whiteSpace,
        marginTop: c.marginTop, marginBottom: c.marginBottom,
        padding: c.padding, background: c.backgroundColor,
        display: c.display, borderRadius: c.borderRadius,
      }
      styleBook.set(life, cs)
      return { life, cs, fresh: true }
    }
    const rectOf = (el) => {
      if (!el || !el.isConnected) return null
      const r = el.getBoundingClientRect()
      return {
        x: Number(r.left.toFixed(2)), y: Number(r.top.toFixed(2)),
        w: Number(r.width.toFixed(2)), h: Number(r.height.toFixed(2)),
      }
    }

    let scroll = null
    let article = null
    let mo = window.__tmMo
    if (mo) { mo.disconnect(); mo = null }
    const attachMo = (root) => {
      if (window.__tmMo) window.__tmMo.disconnect()
      window.__tmMo = new MutationObserver((records) => {
        for (const r of records) {
          if (window.__tmMuts.length > 6000) break
          const target = r.target instanceof Element ? r.target : r.target?.parentElement
          window.__tmMuts.push({
            t: Math.round(performance.now()),
            type: r.type,
            attr: r.attributeName ?? null,
            tag: target?.tagName ?? null,
            kind: target?.getAttribute?.('data-block-kind')
              ?? target?.getAttribute?.('data-testid') ?? null,
            added: r.addedNodes?.length ?? 0,
            removed: r.removedNodes?.length ?? 0,
            /* 被摘下去 / 挂上来的那几件是什么型 —— 「换节点」那一下的实体。 */
            addedTags: Array.prototype.slice.call(r.addedNodes ?? [], 0, 3)
              .map((n) => (n.nodeType === 1 ? n.tagName : '#text')).join(','),
            removedTags: Array.prototype.slice.call(r.removedNodes ?? [], 0, 3)
              .map((n) => (n.nodeType === 1 ? n.tagName : '#text')).join(','),
          })
        }
      })
      window.__tmMo.observe(root, { childList: true, attributes: true, subtree: true, characterData: false })
      window.__tmMoOn = root
    }

    const resolve = () => {
      const pane = window.__tmLeaf()
      if (!scroll || !scroll.isConnected) scroll = pane.querySelector('[data-testid="chat-stream"]')
      if (!scroll) return false
      const articles = scroll.querySelectorAll('article[data-message-id]')
      const last = articles.length ? articles[articles.length - 1] : null
      if (last !== article) { article = last; if (article) attachMo(article) }
      return Boolean(article)
    }

    const sampleAfterPaint = () => {
      if (window.__tmStop) return
      if (resolve()) {
        const pane = window.__tmLeaf()
        const chrome = article.querySelector('[data-testid="chat-chrome"]')
        const tail = pane.querySelector('[data-tail-slot]')
        const stopBtn = pane.querySelector('[data-testid="chat-stop"]')
        const notice = article.querySelector('[data-testid="chat-stop-notice"]')
        const foot = article.querySelector('[data-testid="research-foot"]')
        const readout = pane.querySelector('[data-testid="chat-readout"]')
        /* 光标没有 testid,按 CSS module 类名前缀找(尾槽里那一枚)。 */
        const cursor = pane.querySelector('[data-tail-slot] [class*="cursor"]')
        const fresh = []

        const f = {
          t: performance.now(),
          live: Boolean(stopBtn),
          face: chrome ? chrome.getAttribute('data-face') : null,
          chromeRect: rectOf(chrome),
          /* 动作格「亮没亮」—— 收场那一帧它从 0 走到 1。 */
          actionsOpacity: chrome
            ? (() => {
                const on = chrome.querySelector('[data-on]')
                return on ? getComputedStyle(on).opacity : null
              })()
            : null,
          tailFace: tail ? tail.getAttribute('data-face') : null,
          tailRect: rectOf(tail),
          readoutRect: rectOf(readout),
          stopRect: rectOf(stopBtn),
          noticeRect: rectOf(notice),
          footRect: rectOf(foot),
          cursorRect: rectOf(cursor),
          msgId: article.getAttribute('data-message-id'),
          msgLife: lifeOf(article),
          msgRect: rectOf(article),
          st: scroll.scrollTop,
          sh: scroll.scrollHeight,
          ch: scroll.clientHeight,
          /** 离底多远 —— 「贴底」与「上翻半屏」两格靠它对账。 */
          fromBottom: Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight),
        }

        if (window.__tmMode === 'tool') {
          const cards = article.querySelectorAll('[data-tool-card]')
          const card = cards.length ? cards[cards.length - 1] : null
          if (card) {
            const head = card.querySelector('[data-tool-head]')
            const rows = Array.prototype.slice.call(card.querySelectorAll('[data-call-id]'))
            f.card = {
              life: lifeOf(card),
              rect: rectOf(card),
              /* **FLIP 写的那一格**:`useFlipHeight` 把「改前那个高」写成内联 height 再
               * 过渡到新高。它与画出来的 rect 高一起看,才分得出「先跳后动画」
               * (内联高还没写上去、rect 已经是新高的那一帧)。 */
              inlineH: card.style.height || null,
              multi: card.getAttribute('data-multi'),
              open: card.getAttribute('data-open'),
              headLife: head ? lifeOf(head) : null,
              headIcons: head ? head.querySelectorAll('svg').length : null,
              headText: head ? (head.textContent ?? '').slice(0, 60) : null,
              /* 审批槽与抽屉都没有 `data-*` 口,只能按 **CSS module 的类名前缀**找
               * (vite 生成的是 `_permCard_xxxx` / `_drawer_xxxx`,原名留在前面)。
               * 这一条是探针在迁就产品,不是产品欠一个属性:只量不改,不给产品加钩子。 */
              perm: card.querySelectorAll('[class*="permCard"]').length,
              drawer: card.querySelectorAll('[class*="drawer"]').length,
              tbar: Boolean(card.querySelector('[data-tool-progress]')),
              aggr: card.querySelectorAll('[data-tool-aggregate]').length,
              rows: rows.map((el) => {
                const c = getComputedStyle(el)
                return {
                  callId: el.getAttribute('data-call-id'),
                  life: lifeOf(el),
                  tag: el.tagName,
                  status: el.getAttribute('data-tool-status'),
                  tone: el.getAttribute('data-tool-tone'),
                  reveal: el.getAttribute('data-reveal'),
                  child: el.getAttribute('data-child'),
                  hidden: el.hasAttribute('hidden'),
                  rect: rectOf(el),
                  cs: {
                    display: c.display, visibility: c.visibility, opacity: c.opacity,
                    height: c.height, transform: c.transform === 'none' ? 'none' : c.transform,
                  },
                  text: (el.textContent ?? '').slice(0, 70),
                }
              }),
            }
          } else f.card = null
        } else {
          /* B 档:活消息的**孩子列**(段是 article 的直接孩子,SegmentView 不包壳)。 */
          const kids = Array.prototype.slice.call(article.children)
          /*
           * **公式那一块另有一格逐帧读**(B⑦ / B⑧ 的取样口)。
           *
           * 为什么不复用 `styleBook`:那一格按定义只在节点**第一次出现**时读一次
           * computed —— 而这两条判据要的恰恰是「每一帧的 padding 与高」(病 3 修好
           * 之后节点不再换,styleBook 于是永远只有那一份第一帧的样式,拿它对账等于
           * 拿自己比自己)。
           *
           * 认它靠**文字**而不是 `data-block-kind`:`flow` 档的块不进块壳,所以它
           * 身上没有那个属性(`math-render.test.tsx` 里有一条用例钉着这件事)。
           * 这是门在迁就产品,不是产品欠一个属性 —— 只量不改,不给产品加钩子。
           */
          const mathCells = []
          for (let mi = 0; mi < kids.length; mi += 1) {
            const el = kids[mi]
            if (!/mc\^?2|frac\{a\}|sqrt\{c\}/.test(el.textContent || '')) continue
            const mc = getComputedStyle(el)
            const mr = rectOf(el)
            mathCells.push({
              life: lifeOf(el),
              at: mi,
              tag: el.tagName,
              pad: mc.padding,
              h: mr ? mr.h : null,
              y: mr ? mr.y : null,
              /** 排好了没有 —— KaTeX 的产出里必有 `.katex`,源码那一份里没有。 */
              katex: Boolean(el.querySelector('.katex')),
              /** 「排不出来」那一档:它自己那行灰说明挂着 `role="note"`(不是类名 hash)。 */
              failed: Boolean(el.querySelector('[role="note"]')),
              /** 紧跟着它的那一块 —— 下文位移量的就是它。 */
              nextLife: kids[mi + 1] ? lifeOf(kids[mi + 1]) : null,
              nextY: kids[mi + 1] ? (rectOf(kids[mi + 1])?.y ?? null) : null,
            })
          }
          f.math = mathCells
          f.blocks = kids.map((el, i) => {
            const st = styleOf(el)
            if (st?.fresh) fresh.push({ life: st.life, tag: el.tagName, kind: el.getAttribute('data-block-kind'), cs: st.cs })
            const r = rectOf(el)
            return {
              i,
              life: st ? st.life : null,
              tag: el.tagName,
              kind: el.getAttribute('data-block-kind'),
              geom: el.getAttribute('data-geometry'),
              prose: el.getAttribute('data-prose'),
              testid: el.getAttribute('data-testid'),
              /* **高亮到没到位**:shiki 把源码切成一堆着色 `<span>`,没高亮时 `<code>`
               * 里只有一个文本节点。节点身份一个字不变而屏幕整块换色,只有这一格看得见。 */
              spans: el.querySelectorAll('span').length,
              hasTable: Boolean(el.querySelector('table')),
              /*
               * **行内那一层的「未渲染 → 渲染」**(第一趟真机之后补的:块一级
               * 一次都没换过节点,而用户看见的那一下在块**里面**)。`**粗` 逐 token
               * 到达时是**字面的星号**,闭合那一拍才变成 `<strong>` —— 同一个节点、
               * 同一个 key,块一级的判据一个字都不动,只有这两格看得见:
               *  · `inline` = 行内语义节点的个数(strong/em/code/a/…);
               *  · `raw` = 此刻的可见文字里还有没有裸的 markdown 记号。
               */
              inline: el.querySelectorAll('strong,em,code,a,del,mark,sup,sub').length,
              raw: /\*\*|`|\]\(|~~|\$\$/.test((el.textContent ?? '').slice(0, 600)),
              y: r ? r.y : null,
              h: r ? r.h : null,
              /* 前 40 个字 —— 换装前后「这一块说的是不是同一件事」靠它对上号。 */
              text: (el.textContent ?? '').replace(/\s+/g, ' ').slice(0, 40),
            }
          })
          f.fresh = fresh
        }
        window.__tmFrames.push(f)
      }
      requestAnimationFrame(tick)
    }
    /* **画出来的那一口**:rAF 里 postMessage,宏任务跑在这一帧绘制提交之后。 */
    const channel = new MessageChannel()
    channel.port1.onmessage = sampleAfterPaint
    const tick = () => { if (!window.__tmStop) channel.port2.postMessage(0) }
    requestAnimationFrame(tick)
    window.__tmSamplerStop = () => {
      window.__tmStop = true
      channel.port1.onmessage = null
      window.__tmMo?.disconnect()
    }
  }, mode)
}

async function stopSampler(page) {
  return page.evaluate(() => {
    window.__tmSamplerStop?.()
    const frames = window.__tmFrames ?? []
    const muts = window.__tmMuts ?? []
    window.__tmFrames = []
    window.__tmMuts = []
    return { frames, muts }
  })
}

/* ══ 长帧层:切窗口取样(不开 buffered)═══════════════════════════════════ */
async function startLongFrames(page) {
  await page.evaluate(() => {
    window.__tmLong = []
    try {
      window.__tmLongPo = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (window.__tmLong.length > 3000) break
          window.__tmLong.push({ t: e.startTime, ms: e.duration, type: e.entryType })
        }
      })
      /* 两种都要:`long-animation-frame` 是「一帧总共花了多久」,`longtask` 是单个任务。 */
      window.__tmLongPo.observe({ entryTypes: ['long-animation-frame', 'longtask'] })
    } catch { window.__tmLongUnsupported = true }
  })
}
async function stopLongFrames(page) {
  return page.evaluate(() => {
    window.__tmLongPo?.disconnect()
    const out = window.__tmLong ?? []
    window.__tmLong = []
    return { entries: out, unsupported: Boolean(window.__tmLongUnsupported) }
  })
}

/* ══ 像素层 ═══════════════════════════════════════════════════════════════ */
function startScreencast(cdp, bag) {
  cdp.on('Page.screencastFrame', (ev) => {
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => undefined)
    if (bag.frames.length >= MAX_PIX_FRAMES) return
    bag.frames.push({ ts: ev.metadata?.timestamp ?? null, b64: ev.data })
  })
  return cdp.send('Page.startScreencast', {
    format: 'png', everyNthFrame: 1, maxWidth: PIX_W,
    maxHeight: Math.round(PIX_W * VIEWPORT.height / VIEWPORT.width),
  })
}

/** 一块地上的平均亮度。 */
function regionMean(img, box) {
  const { data, bpp, width } = img
  let sum = 0
  let n = 0
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) {
      const at = (y * width + x) * bpp
      sum += (data[at] * 299 + data[at + 1] * 587 + data[at + 2] * 114) / 1000
      n += 1
    }
  }
  return n ? sum / n : null
}
/** 两帧之间「变了多少像素」的占比(变 = 亮度差 > 24)+ 平均差。 */
function regionChange(a, b, box) {
  let changed = 0
  let sum = 0
  let n = 0
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) {
      const ia = (y * a.width + x) * a.bpp
      const ib = (y * b.width + x) * b.bpp
      const la = (a.data[ia] * 299 + a.data[ia + 1] * 587 + a.data[ia + 2] * 114) / 1000
      const lb = (b.data[ib] * 299 + b.data[ib + 1] * 587 + b.data[ib + 2] * 114) / 1000
      const d = Math.abs(la - lb)
      if (d > 24) changed += 1
      sum += d
      n += 1
    }
  }
  return { frac: n ? changed / n : 0, mean: n ? sum / n : 0 }
}
function boxOf(img, r, k) {
  const x0 = Math.max(0, Math.round(r.x * k.x))
  const y0 = Math.max(0, Math.round(r.y * k.y))
  const x1 = Math.min(img.width, Math.round((r.x + r.w) * k.x))
  const y1 = Math.min(img.height, Math.round((r.y + r.h) * k.y))
  if (x1 - x0 < 2 || y1 - y0 < 2) return null
  return { x0, y0, x1, y1 }
}

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const round = (v, k = 2) => (v === null || v === undefined ? null : Number(v.toFixed(k)))

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

/** 门槛:偏离前后邻居中位这么多亮度就算一次命中(0–255 口径)。 */
const MEAN_HIT = Number(process.env.ONETHING_PROBE_MEAN_HIT ?? 4)
/** 「整块换了一次」的占比门槛:一帧里超过这么多像素变了。 */
const FRAC_HIT = Number(process.env.ONETHING_PROBE_FRAC_HIT ?? 0.35)

/**
 * 换挡还是闪一下 —— 与 `probe-composer-flicker` 同一条判词:偏到的那个值**留下来了**
 * 就是换挡(step),一两帧之后又弹回去才是闪(spike);一头够不着邻居就答 `edge`。
 */
function classify(series, i, value, tol) {
  const side = (from, to) => {
    const xs = []
    for (let j = from; j !== to; j += Math.sign(to - from)) {
      if (j < 0 || j >= series.length) break
      if (series[j] !== null && series[j] !== undefined) xs.push(series[j])
    }
    if (xs.length < 5) return null
    const near = xs.filter((v) => Math.abs(v - value) <= tol).length
    return near >= Math.ceil(xs.length * 0.7)
  }
  const after = side(i + 1, i + 11)
  const before = side(i - 1, i - 11)
  if (after === true || before === true) return 'step'
  if (after === null || before === null) return 'edge'
  return 'spike'
}

function analyzePix(images, region, k, outDir, tag) {
  if (images.length < 5 || !region) return { empty: true, frames: images.length }
  const box = boxOf(images[0], region, k)
  if (!box) return { empty: true, why: '地太小', frames: images.length }
  const rows = []
  for (let i = 0; i < images.length; i += 1) {
    const mean = regionMean(images[i], box)
    const ch = i > 0 ? regionChange(images[i - 1], images[i], box) : null
    rows.push({ i, mean, frac: ch ? ch.frac : null, step: ch ? ch.mean : null })
  }
  const means = rows.map((r) => r.mean)
  const local = localMedians(means, LOCAL_R)
  const hits = []
  for (const r of rows) {
    const lm = local[r.i]
    if (r.mean !== null && lm !== null && Math.abs(r.mean - lm) > MEAN_HIT) {
      hits.push({
        i: r.i,
        kind: classify(means, r.i, r.mean, MEAN_HIT / 2),
        why: `整块平均亮度 ${round(r.mean)} vs 邻居中位 ${round(lm)}`,
        frac: round(r.frac, 3),
      })
    }
  }
  /* **整块骤变又变回来**:连着两帧都有大面积改动,而两帧之间的净差很小 = A→B→A。 */
  const flips = []
  for (let i = 2; i < rows.length; i += 1) {
    if ((rows[i - 1].frac ?? 0) > FRAC_HIT && (rows[i].frac ?? 0) > FRAC_HIT) {
      const back = regionChange(images[i - 2], images[i], box)
      if (back.frac < (rows[i].frac ?? 0) * 0.25) {
        flips.push({ i, why: `整块换了又换回来(${round(rows[i - 1].frac, 3)} → ${round(rows[i].frac, 3)},隔帧只差 ${round(back.frac, 3)})` })
      }
    }
  }
  mkdirSync(outDir, { recursive: true })
  const refAt = path.join(outDir, `${tag}-ref.png`)
  writeFileSync(refAt, images[Math.floor(images.length / 2)].raw)
  const saved = []
  const spikes = hits.filter((h) => h.kind === 'spike')
  const want = new Set()
  for (const h of [...spikes, ...flips, ...hits].slice(0, 10)) { want.add(h.i - 1); want.add(h.i); want.add(h.i + 1) }
  for (const i of [...want].filter((v) => v >= 0 && v < images.length).sort((a, b) => a - b)) {
    const file = path.join(outDir, `${tag}-f${String(i).padStart(4, '0')}`
      + `${hits.some((h) => h.i === i) || flips.some((h) => h.i === i) ? '-HIT' : ''}.png`)
    writeFileSync(file, images[i].raw)
    saved.push(file)
  }
  return {
    refAt,
    imgSize: `${images[0].width}×${images[0].height}`,
    region: `${round(region.x)},${round(region.y)} ${round(region.w)}×${round(region.h)}`,
    frames: images.length,
    meanMedian: round(median(means.filter((v) => v !== null))),
    fracMax: round(Math.max(0, ...rows.map((r) => r.frac ?? 0)), 3),
    fracMedian: round(median(rows.map((r) => r.frac).filter((v) => v !== null)), 3),
    stepMax: round(Math.max(0, ...rows.map((r) => r.step ?? 0))),
    hits, flips,
    spikes: spikes.length,
    steps: hits.filter((h) => h.kind === 'step').length,
    edges: hits.filter((h) => h.kind === 'edge').length,
    saved,
  }
}

/* ══ A 档分析:工具卡三次换挡 ══════════════════════════════════════════════ */
function analyzeTool(frames, muts, longs) {
  /*
   * **只看这一条活消息**(同 analyzeMd):上一轮那张卡还在树上,不筛的话量到的是它。
   * 但**不能直接取最后一条** —— 真店档上工具跑完之后引擎会另起一条助手消息装结论,
   * 于是「最后一条」是那条没有卡的结论(第一趟真店档 1118 帧里只有 84 帧属于它,
   * 0 帧有卡)。判据改成**最后一条有卡的消息**:这一支量的就是那张卡。
   */
  const lives = [...new Set(frames.map((f) => f.msgLife))]
  let pick = frames.length ? frames[frames.length - 1].msgLife : null
  for (let i = lives.length - 1; i >= 0; i -= 1) {
    if (frames.some((f) => f.msgLife === lives[i] && f.card)) { pick = lives[i]; break }
  }
  const mine = frames.filter((f) => f.msgLife === pick)
  const withCard = mine.filter((f) => f.card)
  if (withCard.length < 3) {
    return { empty: true, frames: frames.length, ofThisMessage: mine.length, withCard: withCard.length }
  }
  const t0 = mine[0].t
  const rel = (t) => Math.round(t - t0)

  /* 每一行的状态时间线 + 重挂 / 换元素。 */
  const perRow = new Map()
  let cardRemounts = 0
  let lastCardLife = withCard[0].card.life
  const cardH = []
  for (const f of withCard) {
    if (f.card.life !== lastCardLife) { cardRemounts += 1; lastCardLife = f.card.life }
    cardH.push({ t: rel(f.t), h: f.card.rect?.h ?? null, y: f.card.rect?.y ?? null, inline: f.card.inlineH })
    for (const r of f.card.rows) {
      let e = perRow.get(r.callId)
      if (!e) {
        e = { callId: r.callId, firstT: rel(f.t), lives: [r.life], tags: [r.tag], transitions: [], remounts: 0, tagSwaps: 0, hiddenFlips: 0, revealFlips: 0, last: null }
        perRow.set(r.callId, e)
      }
      const p = e.last
      if (p) {
        if (p.life !== r.life) { e.remounts += 1; e.transitions.push({ t: rel(f.t), what: `重挂 life ${p.life}→${r.life}`, status: r.status }) }
        if (p.tag !== r.tag) { e.tagSwaps += 1; e.transitions.push({ t: rel(f.t), what: `换元素 ${p.tag}→${r.tag}`, status: r.status }) }
        if (p.status !== r.status) e.transitions.push({ t: rel(f.t), what: `状态 ${p.status}→${r.status}`, status: r.status, h: r.rect?.h ?? null })
        if (p.hidden !== r.hidden) { e.hiddenFlips += 1; e.transitions.push({ t: rel(f.t), what: `hidden ${p.hidden}→${r.hidden}`, status: r.status }) }
        if (p.reveal !== r.reveal) { e.revealFlips += 1; e.transitions.push({ t: rel(f.t), what: `data-reveal ${p.reveal}→${r.reveal}`, status: r.status }) }
        for (const key of ['display', 'visibility', 'opacity', 'transform']) {
          if (p.cs[key] !== r.cs[key]) e.transitions.push({ t: rel(f.t), what: `computed ${key} ${p.cs[key]}→${r.cs[key]}`, status: r.status })
        }
      }
      e.last = r
      if (!e.lives.includes(r.life)) e.lives.push(r.life)
      if (!e.tags.includes(r.tag)) e.tags.push(r.tag)
      ;(e.opacity ??= []).push({
        t: rel(f.t),
        v: Number(r.cs.opacity),
        h: r.rect?.h ?? null,
        /** 「在屏」= 没挂 hidden 而且 display 不是 none —— 藏着的行读出来的 opacity 恒为 1。 */
        on: !r.hidden && r.cs.display !== 'none',
      })
    }
  }
  /**
   * **一行自己闪了一下**:不透明度从「基本不透明」掉下去、300ms 之内又回来。
   * 淡入(0 → 1,单调)不算 —— 那是 §6.5 第 7 条的进场,判据是**掉下去又回来**。
   */
  for (const e of perRow.values()) {
    /*
     * ── 把一行切成若干**在屏段**,判据全在段内算(A③)────────────────────────
     *
     * 为什么非切不可:`getComputedStyle` 对一个 `display:none` 的元素照样答
     * `opacity: 1` —— 一行藏起来再放出来、进场淡入那一下,在**不分段**的序列里长得
     * 和「已经在屏上被按回 0 又回来」一模一样(基线里那 1–2 次 `1 → 0 → 1` 有一部分
     * 正是这么来的)。分段之后两件事分得干干净净:
     *   · 段**首**就 <0.95 = 进场淡入,合法,一行至多一次;
     *   · 段**中**从 ≥0.95 掉到 <0.95 = 把一行已经画好的东西按回 0,**这就是病 1**。
     */
    const runs = []
    for (const x of e.opacity ?? []) {
      if (!x.on) { if (runs.length && runs[runs.length - 1].open) runs[runs.length - 1].open = false; continue }
      if (!runs.length || !runs[runs.length - 1].open) runs.push({ open: true, xs: [] })
      runs[runs.length - 1].xs.push(x)
    }
    e.visibleRuns = runs.length
    e.entranceFades = 0
    e.lateFades = []
    for (const run of runs) {
      const xs = run.xs
      if (!xs.length) continue
      if (xs[0].v < 0.95) e.entranceFades += 1
      for (let i = 1; i < xs.length; i += 1) {
        if (xs[i - 1].v >= 0.95 && xs[i].v < 0.95) {
          e.lateFades.push({ t: xs[i].t, from: round(xs[i - 1].v, 3), to: round(xs[i].v, 3) })
        }
      }
    }
    e.opacityDips = []
    const xs = e.opacity ?? []
    for (let i = 1; i < xs.length - 1; i += 1) {
      if (!(xs[i - 1].v >= 0.95 && xs[i].v < 0.5)) continue
      for (let j = i + 1; j < xs.length && xs[j].t - xs[i].t <= 300; j += 1) {
        if (xs[j].v >= 0.95) { e.opacityDips.push({ t: xs[i].t, low: round(xs[i].v, 3), backAt: xs[j].t }); i = j; break }
      }
    }
    /** 行高往返 —— 与卡高那一条同判据。 */
    e.heightRoundTrips = []
    for (let i = 1; i < xs.length - 2; i += 1) {
      const a = xs[i - 1].h
      const b = xs[i].h
      if (a === null || b === null || Math.abs(b - a) < 1) continue
      for (let j = i + 1; j <= Math.min(i + 2, xs.length - 1); j += 1) {
        if (xs[j].h !== null && Math.abs(xs[j].h - a) < 0.5) { e.heightRoundTrips.push({ t: xs[i].t, from: a, to: b }); break }
      }
    }
    delete e.opacity
  }

  /** 高度往返:一帧变了,两帧之内又回到原值 —— 「跳一下又弹回去」。 */
  const roundTrips = []
  for (let i = 1; i < cardH.length - 2; i += 1) {
    const a = cardH[i - 1].h
    const b = cardH[i].h
    if (a === null || b === null || Math.abs(b - a) < 1) continue
    for (let j = i + 1; j <= Math.min(i + 2, cardH.length - 1); j += 1) {
      if (cardH[j].h !== null && Math.abs(cardH[j].h - a) < 0.5) {
        roundTrips.push({ t: cardH[i].t, from: a, to: b, backAt: cardH[j].t })
        break
      }
    }
  }

  /* 三次换挡的时刻:全卡口径(任一行第一次进 executing / 第一次进终态)。 */
  const shifts = { args: null, exec: null, settle: null }
  for (const f of withCard) {
    const st = f.card.rows.map((r) => r.status)
    if (shifts.args === null && st.includes('input-streaming')) shifts.args = rel(f.t)
    if (shifts.exec === null && st.some((s) => s === 'executing')) shifts.exec = rel(f.t)
    if (shifts.settle === null && st.length > 0
      && st.every((s) => s === 'completed' || s === 'failed' || s === 'cancelled')) shifts.settle = rel(f.t)
  }

  const gaps = []
  for (let i = 1; i < mine.length; i += 1) gaps.push(mine[i].t - mine[i - 1].t)
  const longNear = (at) => (at === null ? [] : longs.entries
    .filter((e) => Math.abs(rel(e.t) - at) <= 100 || (rel(e.t) <= at && rel(e.t) + e.ms >= at))
    .map((e) => ({ t: rel(e.t), ms: round(e.ms), type: e.type })))

  const mutKinds = {}
  for (const m of muts) {
    const key = `${m.type}${m.attr ? `:${m.attr}` : ''}@${m.kind ?? m.tag}`
    mutKinds[key] = (mutKinds[key] ?? 0) + 1
  }
  return {
    frames: mine.length,
    fps: Math.round(1000 / (median(gaps) || 16)),
    spanMs: Math.round(mine[mine.length - 1].t - mine[0].t),
    shifts,
    cardRemounts,
    cardHeightRoundTrips: roundTrips,
    cardHeights: [...new Set(cardH.map((c) => c.h))].filter((v) => v !== null).map((v) => round(v)),
    cardInline: cardH.map((c) => c.inline).filter((v) => v !== null),
    headIcons: [...new Set(withCard.map((f) => f.card.headIcons))],
    headLifes: [...new Set(withCard.map((f) => f.card.headLife))],
    permMax: Math.max(0, ...withCard.map((f) => f.card.perm)),
    drawerMax: Math.max(0, ...withCard.map((f) => f.card.drawer)),
    tbarFrames: withCard.filter((f) => f.card.tbar).length,
    rows: [...perRow.values()].map((e) => ({
      callId: e.callId,
      firstT: e.firstT,
      remounts: e.remounts,
      tagSwaps: e.tagSwaps,
      tags: e.tags,
      hiddenFlips: e.hiddenFlips,
      revealFlips: e.revealFlips,
      visibleRuns: e.visibleRuns,
      entranceFades: e.entranceFades,
      lateFades: e.lateFades,
      opacityDips: e.opacityDips,
      heightRoundTrips: e.heightRoundTrips,
      /* 逐帧的不透明度台阶太碎(淡入一路 0→1 会占十几条),报告里压掉 —— 真要看去 json。 */
      transitions: e.transitions.filter((x) => !/^computed opacity/.test(x.what)),
      opacitySteps: e.transitions.filter((x) => /^computed opacity/.test(x.what)).length,
    })),
    longFramesNear: {
      args: longNear(shifts.args), exec: longNear(shifts.exec), settle: longNear(shifts.settle),
    },
    longUnsupported: longs.unsupported,
    longTotal: longs.entries.length,
    longestMs: longs.entries.length ? round(Math.max(...longs.entries.map((e) => e.ms))) : 0,
    sampleLongFrames: gaps.filter((g) => g >= 50).length,
    muts: muts.length,
    mutKinds: Object.fromEntries(Object.entries(mutKinds).sort((a, b) => b[1] - a[1]).slice(0, 10)),
  }
}

/* ══ B 档分析:markdown 流式 → 落定 ═══════════════════════════════════════
 *
 * **按身份算,不按下标算**(第一版按下标,量出来全是假的):活消息的孩子列里
 * 排在最后的那一件是 `MessageChrome`(一只 `display:grid` 的 DIV),每插进一个块
 * 它的下标就加一 —— 按下标比的话,每一次插入都会被记成「这一格上 DIV 换成了 H2」,
 * 十二条「替换」里一条真的都没有。
 *
 * 所以判据改成**节点身份**:
 *  · 一个号**消失**、同一帧有一个**新号**站到它原来那个下标上 = **真的换了节点**
 *    (「未渲染 → 渲染」那一下的实体,契约里 `settled: 'swap'` 说的就是它);
 *  · 只有新号出现、老号一个没少 = **插入**(块一行一行长出来,谁都没被换掉);
 *  · 号没变而 `tagName` / `data-block-kind` 变了 = 同一个节点被就地改写(更轻的一档);
 *  · 号没变、型也没变,而**着色 span 的个数**从 0 跳到几十 = shiki 到位
 *    (整块换色,而 DOM 身份一个字没动 —— 只有这一格看得见)。
 */
function analyzeMd(frames, muts, longs) {
  let withBlocks = frames.filter((f) => f.blocks)
  if (withBlocks.length < 3) return { empty: true, frames: frames.length }
  /* **只看这一条活消息**:上一条消息的帧与这一条不是同一棵树,跨着比就是比两棵树。 */
  const lastMsgLife = withBlocks[withBlocks.length - 1].msgLife
  withBlocks = withBlocks.filter((f) => f.msgLife === lastMsgLife)
  if (withBlocks.length < 3) return { empty: true, frames: frames.length, ofThisMessage: withBlocks.length }
  const t0 = withBlocks[0].t
  const rel = (t) => Math.round(t - t0)
  const styleBook = new Map()
  for (const f of frames) for (const s of f.fresh ?? []) styleBook.set(s.life, s)

  const events = []
  const csOf = (life) => styleBook.get(life)?.cs ?? null
  const csDiff = (a, b) => {
    const x = csOf(a)
    const y = csOf(b)
    if (!x || !y) return null
    const keys = Object.keys(x).filter((k) => x[k] !== y[k])
    return keys.length ? keys.map((k) => `${k}:${x[k]}→${y[k]}`) : null
  }
  for (let i = 1; i < withBlocks.length; i += 1) {
    const prev = withBlocks[i - 1].blocks
    const now = withBlocks[i].blocks
    const t = rel(withBlocks[i].t)
    const live = withBlocks[i].live
    const prevBy = new Map(prev.map((b) => [b.life, b]))
    const nowBy = new Map(now.map((b) => [b.life, b]))
    const gone = prev.filter((b) => !nowBy.has(b.life))
    const added = now.filter((b) => !prevBy.has(b.life))
    const usedAdded = new Set()
    for (const g of gone) {
      const taker = added.find((a) => a.i === g.i && !usedAdded.has(a.life))
      if (taker) {
        usedAdded.add(taker.life)
        events.push({
          t, live, kindOfEvent: 'replace', at: g.i,
          from: { life: g.life, tag: g.tag, kind: g.kind, h: g.h, text: g.text, spans: g.spans },
          to: { life: taker.life, tag: taker.tag, kind: taker.kind, h: taker.h, text: taker.text, spans: taker.spans },
          dh: g.h !== null && taker.h !== null ? round(taker.h - g.h) : null,
          cs: csDiff(g.life, taker.life),
        })
      } else events.push({ t, live, kindOfEvent: 'remove', at: g.i, from: { life: g.life, tag: g.tag, kind: g.kind, h: g.h, text: g.text } })
    }
    for (const a of added) {
      if (usedAdded.has(a.life)) continue
      events.push({ t, live, kindOfEvent: 'insert', at: a.i, to: { life: a.life, tag: a.tag, kind: a.kind, h: a.h, text: a.text, spans: a.spans } })
    }
    /* 同一个号上就地改写 / 高亮到位 / 高度变。 */
    for (const b of now) {
      const p = prevBy.get(b.life)
      if (!p) continue
      if (p.tag !== b.tag || p.kind !== b.kind) {
        events.push({ t, live, kindOfEvent: 'mutate', at: b.i, life: b.life, what: `${p.tag}/${p.kind ?? '-'} → ${b.tag}/${b.kind ?? '-'}`, dh: p.h !== null && b.h !== null ? round(b.h - p.h) : null })
      }
      if ((p.spans ?? 0) === 0 && (b.spans ?? 0) >= 5) {
        events.push({ t, live, kindOfEvent: 'highlight', at: b.i, life: b.life, what: `着色 span 0 → ${b.spans}`, tag: b.tag, kind: b.kind, dh: p.h !== null && b.h !== null ? round(b.h - p.h) : null })
      }
      if ((p.raw ?? false) === true && b.raw === false) {
        events.push({ t, live, kindOfEvent: 'inlineSettle', at: b.i, life: b.life, tag: b.tag, kind: b.kind, what: `裸记号没了(行内 ${p.inline} → ${b.inline})`, from: p.text, to: b.text, dh: p.h !== null && b.h !== null ? round(b.h - p.h) : null })
      }
      if ((b.inline ?? 0) > (p.inline ?? 0)) {
        events.push({ t, live, kindOfEvent: 'inlineGrow', at: b.i, life: b.life, tag: b.tag, kind: b.kind, what: `行内语义节点 ${p.inline} → ${b.inline}`, from: p.text, to: b.text, dh: p.h !== null && b.h !== null ? round(b.h - p.h) : null })
      }
      if ((p.hasTable ?? false) === false && b.hasTable) {
        events.push({ t, live, kindOfEvent: 'tableborn', at: b.i, life: b.life, what: '这个节点里长出了 <table>', tag: b.tag, kind: b.kind, dh: p.h !== null && b.h !== null ? round(b.h - p.h) : null })
      }
    }
  }

  /* 收场:两条线各报各的 —— `live`(停止钮没了)与 `face`(动作格翻面)不是同一帧。 */
  const flipAt = (pred) => {
    for (let i = 1; i < withBlocks.length; i += 1) if (pred(withBlocks[i - 1], withBlocks[i])) return i
    return -1
  }
  const liveAt = flipAt((a, b) => a.live && !b.live)
  const faceAt = flipAt((a, b) => a.face !== b.face)
  const crossing = (idx, label) => {
    if (idx <= 0) return null
    const before = withBlocks[idx - 1]
    const after = withBlocks[idx]
    const rectDiff = (a, b, name) => {
      if (!a && !b) return null
      if (!a) return { what: name, note: '这一帧才出现', to: b }
      if (!b) return { what: name, note: '这一帧消失', from: a }
      const d = { dy: round(b.y - a.y), dh: round(b.h - a.h), dx: round(b.x - a.x), dw: round(b.w - a.w) }
      return (Math.abs(d.dy) > 0.5 || Math.abs(d.dh) > 0.5 || Math.abs(d.dx) > 0.5 || Math.abs(d.dw) > 0.5)
        ? { what: name, ...d } : null
    }
    const changes = [
      rectDiff(before.chromeRect, after.chromeRect, '动作格 MessageChrome'),
      rectDiff(before.tailRect, after.tailRect, '尾槽'),
      rectDiff(before.readoutRect, after.readoutRect, '读数行'),
      rectDiff(before.stopRect, after.stopRect, '停止钮'),
      rectDiff(before.noticeRect, after.noticeRect, '收场通知 StopNotice'),
      rectDiff(before.footRect, after.footRect, '尾来源条 MessageSourceFoot'),
      rectDiff(before.cursorRect, after.cursorRect, '光标'),
      rectDiff(before.msgRect, after.msgRect, '整条活消息'),
    ].filter(Boolean)
    const blockChanges = []
    const nowBy = new Map(after.blocks.map((b) => [b.life, b]))
    for (const b of before.blocks) {
      const n = nowBy.get(b.life)
      if (!n) { blockChanges.push({ life: b.life, tag: b.tag, kind: b.kind, note: '这一帧消失' }); continue }
      const dy = b.y !== null && n.y !== null ? round(n.y - b.y) : null
      const dh = b.h !== null && n.h !== null ? round(n.h - b.h) : null
      if ((dy !== null && Math.abs(dy) > 0.5) || (dh !== null && Math.abs(dh) > 0.5) || b.tag !== n.tag || b.kind !== n.kind) {
        blockChanges.push({ life: b.life, tag: `${b.tag}/${b.kind ?? '-'}`, dy, dh, text: b.text })
      }
    }
    const added = after.blocks.filter((b) => !before.blocks.some((x) => x.life === b.life))
    return {
      label, t: rel(after.t),
      faceFlip: `${before.face} → ${after.face}`,
      actionsOpacity: `${before.actionsOpacity} → ${after.actionsOpacity}`,
      tailFaceFlip: `${before.tailFace} → ${after.tailFace}`,
      liveFlip: `${before.live} → ${after.live}`,
      scrollTop: `${before.st} → ${after.st}`,
      scrollHeight: `${before.sh} → ${after.sh}`,
      fromBottom: `${before.fromBottom} → ${after.fromBottom}`,
      changes, blockChanges,
      addedBlocks: added.map((b) => ({ life: b.life, tag: b.tag, kind: b.kind, h: b.h, text: b.text })),
      blocksBefore: before.blocks.length, blocksAfter: after.blocks.length,
    }
  }
  /** 动作格从暗到亮那一程:什么时候起步、什么时候到 1。 */
  const opRamp = (() => {
    const xs = withBlocks.map((f) => ({ t: rel(f.t), v: f.actionsOpacity === null ? null : Number(f.actionsOpacity) }))
      .filter((x) => x.v !== null)
    const rise = xs.find((x) => x.v > 0.01)
    const full = xs.find((x) => x.v >= 0.999)
    return { startT: rise ? rise.t : null, fullT: full ? full.t : null }
  })()

  /* 逐块归类:终态每一块回看它这一生。 */
  const last = withBlocks[withBlocks.length - 1]
  const lineage = last.blocks.map((b) => {
    const born = withBlocks.find((f) => f.blocks.some((x) => x.life === b.life))
    const first = born ? born.blocks.find((x) => x.life === b.life) : null
    const replaced = events.filter((e) => e.kindOfEvent === 'replace' && e.to.life === b.life)
    const hl = events.filter((e) => ['highlight', 'tableborn', 'inlineSettle', 'inlineGrow'].includes(e.kindOfEvent) && e.life === b.life)
    return {
      life: b.life, tag: b.tag, kind: b.kind, geom: b.geom, text: b.text,
      bornT: born ? rel(born.t) : null,
      bornLive: born ? born.live : null,
      firstH: first ? first.h : null, finalH: b.h,
      dh: first && first.h !== null && b.h !== null ? round(b.h - first.h) : null,
      replacedFrom: replaced.map((e) => ({ t: e.t, tag: e.from.tag, kind: e.from.kind, h: e.from.h, cs: e.cs, dh: e.dh })),
      inPlace: hl.map((e) => ({ t: e.t, what: e.what, dh: e.dh })),
      cs: csOf(b.life),
    }
  })

  /*
   * ── 公式那几块的一生(B⑦ / B⑧)────────────────────────────────────────────
   *
   * 按**出场序**给每一条公式编号(`#0` / `#1`),一条一份账:它这一生用过几个 DOM
   * 节点、几种 padding、哪一帧从源码换成排好的样子、那一帧下文动了多少。
   *
   * 「下文动了多少」量的是**紧跟着它的那一块**(`nextY`),而且要求那一块在换装
   * 前后是**同一个号** —— 换了号就不是同一件东西,两个 y 不能相减。
   */
  const mathTrack = new Map()
  for (const f of withBlocks) {
    const cells = f.math ?? []
    for (let k = 0; k < cells.length; k += 1) {
      const cell = cells[k]
      let rec = mathTrack.get(k)
      if (!rec) {
        rec = {
          index: k, bornT: rel(f.t), lives: [], pads: [], heights: [],
          settleAt: null, settleDh: null, settleShift: null,
          failedFrames: 0, katexFrames: 0, frames: 0, prev: null,
        }
        mathTrack.set(k, rec)
      }
      rec.frames += 1
      if (cell.failed) rec.failedFrames += 1
      if (cell.katex) rec.katexFrames += 1
      if (!rec.lives.includes(cell.life)) rec.lives.push(cell.life)
      if (!rec.pads.includes(cell.pad)) rec.pads.push(cell.pad)
      if (cell.h !== null && (!rec.heights.length || Math.abs(rec.heights[rec.heights.length - 1] - cell.h) > 0.5)) {
        rec.heights.push(round(cell.h))
      }
      const prev = rec.prev
      /* 换装那一拍 = 源码变成 KaTeX 的产物(`.katex` 从无到有)。 */
      if (prev && !prev.katex && cell.katex) {
        rec.settleAt = rel(f.t)
        rec.settleDh = prev.h !== null && cell.h !== null ? round(cell.h - prev.h) : null
        rec.settleShift = prev.nextLife !== null && prev.nextLife === cell.nextLife
          && prev.nextY !== null && cell.nextY !== null ? round(cell.nextY - prev.nextY) : null
      }
      rec.prev = cell
    }
  }
  const mathCells = [...mathTrack.values()].map((r) => ({
    index: r.index, bornT: r.bornT, frames: r.frames,
    nodes: r.lives.length, lives: r.lives, pads: r.pads,
    heights: r.heights, settleAt: r.settleAt, settleDh: r.settleDh, settleShift: r.settleShift,
    failedFrames: r.failedFrames, katexFrames: r.katexFrames,
  }))

  const gaps = []
  for (let i = 1; i < withBlocks.length; i += 1) gaps.push(withBlocks[i].t - withBlocks[i - 1].t)
  const mutKinds = {}
  for (const m of muts) {
    const key = `${m.type}${m.attr ? `:${m.attr}` : ''}@${m.kind ?? m.tag}`
    mutKinds[key] = (mutKinds[key] ?? 0) + 1
  }
  const nodeSwapMuts = muts.filter((m) => m.type === 'childList' && m.added > 0 && m.removed > 0)
  const byKind = (k) => events.filter((e) => e.kindOfEvent === k)
  return {
    frames: withBlocks.length,
    fps: Math.round(1000 / (median(gaps) || 16)),
    spanMs: Math.round(withBlocks[withBlocks.length - 1].t - withBlocks[0].t),
    events,
    counts: {
      replace: byKind('replace').length,
      replaceDuringStream: byKind('replace').filter((e) => e.live).length,
      replaceAfterSettle: byKind('replace').filter((e) => !e.live).length,
      insert: byKind('insert').length,
      remove: byKind('remove').length,
      mutate: byKind('mutate').length,
      highlight: byKind('highlight').length,
      tableborn: byKind('tableborn').length,
      inlineSettle: byKind('inlineSettle').length,
      inlineGrow: byKind('inlineGrow').length,
    },
    lineage,
    mathCells,
    settleByLive: crossing(liveAt, '停止钮消失那一帧'),
    settleByFace: crossing(faceAt, '动作格翻面那一帧'),
    actionsOpacityRamp: opRamp,
    finalBlocks: last.blocks.length,
    muts: muts.length,
    mutKinds: Object.fromEntries(Object.entries(mutKinds).sort((a, b) => b[1] - a[1]).slice(0, 10)),
    nodeSwapMuts: nodeSwapMuts.length,
    longUnsupported: longs.unsupported,
    longTotal: longs.entries.length,
    longestMs: longs.entries.length ? round(Math.max(...longs.entries.map((e) => e.ms))) : 0,
    longAtSettle: liveAt > 0
      ? longs.entries.filter((e) => Math.abs(Math.round(e.t - t0) - rel(withBlocks[liveAt].t)) <= 150)
        .map((e) => ({ t: Math.round(e.t - t0), ms: round(e.ms), type: e.type })) : [],
    sampleLongFrames: gaps.filter((g) => g >= 50).length,
  }
}

/* ══ 主 ════════════════════════════════════════════════════════════════════ */
async function main() {
  if (!existsSync(serverEntry)) { console.error('[tmf] 先在仓根跑 `bun run server:build`'); process.exit(1) }
  if (!existsSync(mainEntry)) { console.error('[tmf] 先跑 `npm run electron:build`'); process.exit(1) }
  if (PROD && !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[tmf] --prod 档先跑 `npm run app:build`'); process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'tmflick-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'tmflick-udd-'))
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
    console.log(`\n[tmf] 档位:${LANE} · 抽帧图宽 ${PIX_W} · 出事帧存到 ${OUT_DIR}`)
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
    const shortId = (await rpc(core.record, 'sessions', 'create', { name: '工具/markdown 探针 · 短会话' }))?.session?.id
    const bigId = (await rpc(core.record, 'sessions', 'create', { name: '工具/markdown 探针 · 超量' }))?.session?.id
    if (!shortId || !bigId) throw new Error('会话没建出来')

    const bigWanted = WHICH_LANE === 'both' || WHICH_LANE === 'big'
    let seeded = { messages: 0, bytes: 0 }
    if (bigWanted) {
      console.log('[2/5] 停 core,给超量那一条直写账本,再起回来')
      await stopCore(server)
      seeded = seedLargeLedger(store, bigId, {})
      console.log(`      超量夹具 ${(seeded.bytes / 1024 / 1024).toFixed(1)}MB / ${seeded.messages} 条`)
      core = await startCore()
      server = core.child
    } else console.log('[2/5] 跳过超量夹具(--lane short)')

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
    /* **窗口 = 视口**:screencast 抽的是这扇窗真实的合成面,只 override 会两轴不等
     * (probe-composer-flicker 第一趟的 105 个假命中就是这么来的)。 */
    const winSize = async (w, h) => {
      const handle = await app.browserWindow(page)
      await handle.evaluate((win, size) => { win.setContentSize(size.w, size.h) }, { w, h })
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 0, mobile: false })
      await delay(400)
    }
    await winSize(VIEWPORT.width, VIEWPORT.height)
    await page.addInitScript(LEAF_PROBE)
    await page.evaluate(LEAF_PROBE)
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const v = await page.evaluate(() => window.__d0 ?? null)
      return v && v.rpcOk ? v : undefined
    })
    const dpr = await page.evaluate(() => ({ dpr: window.devicePixelRatio, w: window.innerWidth, h: window.innerHeight }))
    readings.dpr = dpr
    console.log(`      真实 dpr=${dpr.dpr} · 视口 ${dpr.w}×${dpr.h}`)
    if (dpr.dpr !== 2) console.log('      ⚠︎ dpr 不是 2 —— 像素层读数按这个 dpr 解释')

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
        Boolean(window.__tmLeaf().querySelector('[data-testid="chat-stream"]'))))
      if (expect > 0) {
        await waitFor('账本起完底', async () => {
          const n = await page.evaluate(() => window.__tmLeaf()
            .querySelectorAll('[data-testid="chat-stream"] [data-message-id]').length)
          return n >= Math.min(expect, 8) ? n : undefined
        }, 180_000)
        console.log(`      起底 ${waitFor.lastMs}ms`)
      }
      /* 收掉总览那架子(判据拿结果:哪一下之后聊天列更宽就留哪一下)。 */
      const chatW = () => page.evaluate(() => {
        const s = window.__tmLeaf().querySelector('[data-testid="chat-stream"]')
        return s ? Math.round(s.getBoundingClientRect().width) : 0
      })
      const before = await chatW()
      await clickTestId('dock-tile-sessions').catch(() => undefined)
      await delay(700)
      const after = await chatW()
      if (after < before) { await clickTestId('dock-tile-sessions').catch(() => undefined); await delay(700) }
      console.log(`      聊天列宽:${before} → ${Math.max(before, after)}px`)
      const rowsNow = () => page.evaluate(() => {
        const s = window.__tmLeaf().querySelector('[data-testid="chat-stream"]')
        return s?.firstElementChild?.children.length ?? 0
      })
      const t0 = Date.now()
      let lastN = await rowsNow()
      let stable = 0
      while (Date.now() - t0 < 120_000 && stable < 5) {
        await delay(300)
        const now = await rowsNow()
        stable = now === lastN ? stable + 1 : 0
        lastN = now
      }
      console.log(`      补历史补完:${lastN} 格(等了 ${Date.now() - t0}ms)`)
    }
    const scrollToBottom = async () => {
      await page.evaluate(() => {
        const s = window.__tmLeaf().querySelector('[data-testid="chat-stream"]')
        if (s) s.scrollTop = s.scrollHeight
      })
      await delay(400)
    }
    /** 上翻半屏:离底 = 半个视口高。**滚动位由这一步定死**,不靠滚轮的惯性。 */
    const scrollUpHalf = async () => {
      await page.evaluate(() => {
        const s = window.__tmLeaf().querySelector('[data-testid="chat-stream"]')
        if (s) s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight - Math.round(s.clientHeight / 2))
      })
      await delay(400)
    }
    const sendViaComposer = async (text) => {
      const ok = await page.evaluate((value) => {
        const box = window.__tmLeaf().querySelector('[data-testid="composer-input"]')
        if (!box) return false
        box.textContent = value
        box.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }, text)
      if (!ok) throw new Error('打不进去:没有 composer-input')
      await delay(200)
      const sent = await page.evaluate(() => {
        const s = window.__tmLeaf().querySelector('[data-testid="composer-send"]')
        if (!(s instanceof HTMLElement) || s.hasAttribute('disabled')) return false
        s.click()
        return true
      })
      if (!sent) throw new Error('发送键点不动')
    }
    const stopShown = () => page.evaluate(() =>
      Boolean(window.__tmLeaf().querySelector('[data-testid="chat-stop"]')))

    /** 被量的那一块(A = 最后一张卡 + 余量;B = 活消息)。抽帧的裁框按它算。 */
    const measureRegion = (mode) => page.evaluate((m) => {
      const pane = window.__tmLeaf()
      const scroll = pane.querySelector('[data-testid="chat-stream"]')
      const arts = scroll ? scroll.querySelectorAll('article[data-message-id]') : []
      const art = arts.length ? arts[arts.length - 1] : null
      if (!art) return null
      const vp = { w: window.innerWidth, h: window.innerHeight }
      const clamp = (r) => ({
        x: Math.max(0, r.x), y: Math.max(0, r.y),
        w: Math.min(vp.w, r.x + r.w) - Math.max(0, r.x),
        h: Math.min(vp.h, r.y + r.h) - Math.max(0, r.y),
      })
      if (m === 'tool') {
        const cards = art.querySelectorAll('[data-tool-card]')
        const card = cards.length ? cards[cards.length - 1] : null
        if (!card) return null
        const b = card.getBoundingClientRect()
        const row = card.querySelector('[data-call-id]')
        const rb = row ? row.getBoundingClientRect() : null
        /*
         * 两块地:**宽的那块**上下各留 60px 余量(卡会长高,裁框跟着元素走的话
         * 「它自己动了」就看不见了 —— `gate-tail-jitter` §11.1 ① 同一条判词);
         * **紧的那块**只框第一行。一行淡出淡入在 704×164 的平均亮度里被稀释到
         * 门槛以下(第一趟真机:DOM 层读到 opacity 1→0→1,宽裁框零命中),
         * 所以判「这一行自己闪没闪」要有一块只装它的地。
         */
        return {
          main: clamp({ x: b.left, y: b.top - 60, w: b.width, h: b.height + 120 }),
          tight: rb ? clamp({ x: rb.left, y: rb.top, w: rb.width, h: rb.height }) : null,
        }
      }
      /*
       * **B 档裁的是聊天列的视口,不是那条消息的矩形**(第一趟真机之后改的):
       * 消息在长,它的矩形也在长 —— 按它裁,框跟着被量的东西一起动,量到的永远是
       * 「框里那点内容」而不是「屏上那块地变了没有」(同 `gate-tail-jitter` §11.1 ①
       * 「裁框一次取定」那条判词)。聊天列的视口是**固定的一块地**,正文在里面
       * 换字形 / 换行距 / 换缩进,逐帧差就看得见。
       */
      const scrollEl = scroll ?? art
      const b = scrollEl.getBoundingClientRect()
      const ab = art.getBoundingClientRect()
      /*
       * 两块地,理由与 A 档那两块同源:**宽的那块 = 聊天列的视口**(固定的一块地,
       * 正文在里面换字形 / 换行距 / 换缩进就看得见);**紧的那块 = 这条活消息自己**
       * —— 宽裁框把一条刚开头的消息稀释到门槛以下(自证那一档人为藏两帧,
       * 880×670 上零命中、这一块上红),所以灵敏度那一半归它。
       */
      return {
        main: clamp({ x: b.left, y: b.top, w: b.width, h: b.height }),
        tight: clamp({ x: ab.left, y: ab.top, w: ab.width, h: ab.height }),
      }
    }, mode)

    /**
     * 跑一段:三层同开 → `body()` 做事 → 三层同收 → 算。
     * `regionAt` 是「什么时候量裁框」的回调(工具卡要等它出现才量得到)。
     */
    const burst = async (tag, mode, body, { regionAfter } = {}) => {
      const bag = { frames: [] }
      await startSampler(page, mode)
      await startLongFrames(page)
      await startScreencast(cdp, bag)
      let region = regionAfter ? null : await measureRegion(mode)
      const setRegion = async () => { if (!region) region = await measureRegion(mode) }
      await body({ setRegion })
      await setRegion()
      await cdp.send('Page.stopScreencast').catch(() => undefined)
      await delay(120)
      const longs = await stopLongFrames(page)
      const { frames, muts } = await stopSampler(page)
      const images = []
      for (const fr of bag.frames) {
        const raw = Buffer.from(fr.b64, 'base64')
        try { const img = decodePng(raw); img.raw = raw; images.push(img) } catch { /* 解不开的跳过 */ }
      }
      const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
      const k = images.length ? { x: images[0].width / vp.w, y: images[0].height / vp.h } : { x: 1, y: 1 }
      if (Math.abs(k.x - k.y) > 0.01) {
        console.log(`        ⚠︎ ${tag}:两轴缩放不等(${round(k.x, 3)} vs ${round(k.y, 3)})—— 像素层这一段不可信`)
      }
      const dom = mode === 'tool' ? analyzeTool(frames, muts, longs) : analyzeMd(frames, muts, longs)
      const pix = analyzePix(images, region?.main ?? null, k, OUT_DIR, tag)
      pix.scale = `${round(k.x, 3)}×${round(k.y, 3)}`
      pix.captured = bag.frames.length
      pix.decoded = images.length
      /* 紧裁框那一份单算:它回答「这一行自己闪没闪」。 */
      const pixTight = region?.tight
        ? analyzePix(images, region.tight, k, OUT_DIR, `${tag}-tight`) : { empty: true, why: '这一档没有紧裁框' }
      const out = { mode, region, dom, pix, pixTight }
      report(tag, out)
      /* 读数打完再判 —— 红的时候上面那一大段读数就是现场,不必再跑一趟。 */
      out.verdict = judgeScenario(tag, out)
      for (const v of out.verdict) console.log(`        ${v.ok ? '✓' : '✗ **红**'} ${v.line}`)
      readings.scenarios[tag] = out
      return out
    }

    console.log('\n[5/5] 场景')
    const SCEN = []
    const want = (id) => !ONLY || ONLY.includes(id)

    /** 一趟工具场景:发出去 → 等收场 → 期间三层全开。 */
    const toolRun = async (tag, mark, lane, where) => {
      if (where === 'bottom') await scrollToBottom()
      else await scrollUpHalf()
      const m = await burst(tag, 'tool', async ({ setRegion }) => {
        await sendViaComposer(`工具探针 ${markFor(mark, lane)}`)
        await waitFor('开张', stopShown, 180_000)
        /* 卡一出现就把裁框定死(它之后会长高,而裁框不许跟着长)。 */
        for (let i = 0; i < 100; i += 1) {
          const has = await page.evaluate(() => {
            const pane = window.__tmLeaf()
            const arts = pane.querySelectorAll('article[data-message-id]')
            const art = arts.length ? arts[arts.length - 1] : null
            return Boolean(art && art.querySelector('[data-tool-card]'))
          })
          if (has) break
          await delay(60)
        }
        await setRegion()
        await waitFor('收场', async () => !(await stopShown()), 180_000)
        await delay(700)
      }, { regionAfter: true })
      SCEN.push([tag, m])
      await delay(500)
    }

    /** 一趟 markdown 场景。 */
    const mdRun = async (tag, lane) => {
      await scrollToBottom()
      const m = await burst(tag, 'md', async ({ setRegion }) => {
        await sendViaComposer(`markdown 探针 ${markFor(MARKS.md, lane)}`)
        await waitFor('开张', stopShown, 180_000)
        await delay(600)
        await setRegion()
        await waitFor('收场', async () => !(await stopShown()), 180_000)
        /* 收场之后再多采一秒:收场那一帧前后各三帧要有邻居才分得出闪与换挡。 */
        await delay(1000)
      }, { regionAfter: true })
      SCEN.push([tag, m])
      await delay(500)
    }

    /* ── 短会话档 ─────────────────────────────────────────────────────── */
    if (WHICH_LANE === 'both' || WHICH_LANE === 'short') {
      await openSession(shortId, 0)
      console.log('  · 短会话 / 热身一轮(不量)')
      await sendViaComposer(`热身 ${markFor(MARKS.warm, 'short')}`)
      await waitFor('热身开张', stopShown, 180_000)
      await waitFor('热身收场', async () => !(await stopShown()), 300_000)
      await delay(800)

      /* ── 灵敏度自证(反证纪律:每条守卫至少真跑一次「拆掉即红」)────────
       * 人为①把活消息藏两帧、②把一个块节点原地换成另一个元素 —— 三层都必须报出来。 */
      if (process.argv.includes('--selftest')) {
        console.log('  · 自证 / 人为藏两帧 + 换一个节点(三层都该红)')
        const st = await burst('selftest', 'md', async ({ setRegion }) => {
          await sendViaComposer(`markdown 探针 ${markFor(MARKS.md, 'short')}`)
          await waitFor('开张', stopShown, 180_000)
          await delay(800)
          await setRegion()
          for (let i = 0; i < 40; i += 1) {
            if (i === 10 || i === 22) {
              await page.evaluate((mode) => {
                const pane = window.__tmLeaf()
                const arts = pane.querySelectorAll('article[data-message-id]')
                const art = arts.length ? arts[arts.length - 1] : null
                if (!art) return
                if (mode === 0) {
                  /* ① 藏两帧再放回来(一帧在高刷屏上会被抽帧漏掉)。 */
                  art.style.setProperty('visibility', 'hidden')
                  requestAnimationFrame(() => requestAnimationFrame(() => {
                    art.style.removeProperty('visibility')
                  }))
                } else {
                  /* ② 原地换一个节点:同下标、同文字,换元素型 —— DOM 层的
                   *    「换节点 = 重挂」判据必须认得出来。 */
                  const kid = art.children[1]
                  if (!kid) return
                  const swap = document.createElement(kid.tagName === 'P' ? 'DIV' : 'P')
                  swap.textContent = kid.textContent
                  swap.setAttribute('data-selftest-swap', '1')
                  art.replaceChild(swap, kid)
                }
              }, i === 10 ? 0 : 1)
            }
            await delay(40)
          }
          await waitFor('收场', async () => !(await stopShown()), 180_000)
          await delay(800)
        }, { regionAfter: true })
        const domOk = (st.dom.counts?.replace ?? 0) > 0
        const pixHits = (st.pix.hits?.length ?? 0) + (st.pix.flips?.length ?? 0)
          + (st.pixTight?.hits?.length ?? 0) + (st.pixTight?.flips?.length ?? 0)
        const pixOk = pixHits > 0
        const muOk = (st.dom.nodeSwapMuts ?? 0) > 0
        console.log(`      自证:DOM 换节点 ${domOk ? '红了 ✓' : '**没红 ✗**'}`
          + ` · MutationObserver ${muOk ? '红了 ✓' : '**没红 ✗**'}`
          + ` · 像素层 ${pixOk ? '红了 ✓' : '**没红 ✗**'}`)
        readings.selftest = { domReplace: st.dom.counts?.replace ?? 0, muts: st.dom.nodeSwapMuts ?? 0, pixHits }
        if (!domOk) failed = true
        if (!muOk) failed = true
        if (!pixOk) failed = true
      }

      const cells = [
        ['A-slow-single-bottom', MARKS.toolSlowSingle, 'bottom'],
        ['A-slow-single-up', MARKS.toolSlowSingle, 'up'],
        ['A-fast-single-bottom', MARKS.toolFastSingle, 'bottom'],
        ['A-fast-single-up', MARKS.toolFastSingle, 'up'],
        ['A-slow-multi-bottom', MARKS.toolSlowMulti, 'bottom'],
        ['A-slow-multi-up', MARKS.toolSlowMulti, 'up'],
        ['A-fast-multi-bottom', MARKS.toolFastMulti, 'bottom'],
        ['A-fast-multi-up', MARKS.toolFastMulti, 'up'],
      ]
      for (const [tag, mark, where] of cells) {
        if (!want(tag)) continue
        console.log(`  · 短会话 / ${tag}`)
        await toolRun(tag, mark, 'short', where)
      }
      if (want('B-md-short')) {
        console.log('  · 短会话 / B markdown 长回复')
        await mdRun('B-md-short', 'short')
      }
    }

    /* ── 真店夹具档 ───────────────────────────────────────────────────── */
    if (bigWanted && (want('A-slow-multi-big') || want('B-md-big'))) {
      await openSession(bigId, seeded.messages)
      console.log('  · 超量 / 热身一轮(不量)')
      await sendViaComposer(`热身 ${markFor(MARKS.warm, 'big')}`)
      await waitFor('热身开张', stopShown, 180_000)
      await waitFor('热身收场', async () => !(await stopShown()), 300_000)
      await delay(1200)
      if (want('A-slow-multi-big')) {
        console.log('  · 超量 / A 多步慢工具(贴底)')
        await toolRun('A-slow-multi-big', MARKS.toolSlowMulti, 'big', 'bottom')
      }
      if (want('B-md-big')) {
        console.log('  · 超量 / B markdown 长回复')
        await mdRun('B-md-big', 'big')
      }
    }

    readings.scenarioIds = SCEN.map(([id]) => id)
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
      l.includes('tmflick-store-') || l.includes('tmflick-udd-') || (!PROD && l.includes(`:${DEV_PORT}`)))
    if (mine.length) console.log(`\n[tmf] **残留自查:还有 ${mine.length} 条**\n  ${mine.join('\n  ')}`)
    else console.log('\n[tmf] 残留自查:干净(vite / electron / server 都收了)')
  } catch { console.log('\n[tmf] 残留自查:ps 跑不起来,跳过') }

  /* ── 判词汇总 ──────────────────────────────────────────────────────────── */
  const all = Object.entries(readings.scenarios)
  const reds = []
  let checks = 0
  for (const [tag, s] of all) {
    for (const v of s.verdict ?? []) { checks += 1; if (!v.ok) reds.push(`${tag} · ${v.line}`) }
  }
  if (!all.length) { console.log('\n[tmf] **一格场景都没跑到 —— 这不是绿**'); failed = true }
  console.log(`\n[tmf] 判词:${all.length} 格场景 / ${checks} 条断言`
    + (reds.length ? ` · **红 ${reds.length} 条**` : ' · 全绿'))
  for (const line of reds) console.log(`  ✗ ${line}`)

  const jsonAt = argOf('--json')
  if (jsonAt) {
    mkdirSync(path.dirname(jsonAt), { recursive: true })
    writeFileSync(jsonAt, JSON.stringify(readings, null, 2))
    console.log(`[tmf] 读数写到 ${jsonAt}`)
  }
  if (failed) process.exit(1)
  console.log('[tmf] ok —— 工具卡零重挂 / 零换元素 / 淡入只在进场帧 / 行高零往返;'
    + '公式零换节点、零换 padding,换装那一拍下文纹丝不动')
}

/* ══ 判词 ═════════════════════════════════════════════════════════════════ */

/**
 * 一格场景的判据。返回 `[{ok, line}]`,由 `main` 汇总打表。
 *
 * **每一条都指得出病历**:红的时候打的不是「断言失败」,是「这一行在第几毫秒
 * 从几掉到几」—— 一条只会说 `expected 0 to be 1` 的门,红了也没人知道该看哪儿。
 */
function judgeScenario(tag, m) {
  const out = []
  const ok = (cond, line) => { out.push({ ok: Boolean(cond), line }); if (!cond) failed = true }
  const d = m.dom
  if (d.empty) { ok(false, `${tag}:一帧都没采到(${JSON.stringify(d)})`); return out }

  if (m.mode === 'tool') {
    ok(d.cardRemounts <= BUDGET.cardRemounts,
      `A① 卡重挂 ${d.cardRemounts} ≤ ${BUDGET.cardRemounts}`)
    ok(d.cardHeightRoundTrips.length <= BUDGET.cardHeightRoundTrips,
      `A⑤ 卡高一帧内往返 ${d.cardHeightRoundTrips.length} ≤ ${BUDGET.cardHeightRoundTrips}`
      + (d.cardHeightRoundTrips.length ? ` —— ${JSON.stringify(d.cardHeightRoundTrips.slice(0, 3))}` : ''))
    for (const r of d.rows) {
      const who = String(r.callId).slice(-8)
      ok(r.tagSwaps <= BUDGET.rowTagSwaps,
        `A② 行 ${who} 换元素 ${r.tagSwaps} ≤ ${BUDGET.rowTagSwaps}`
        + (r.tagSwaps ? ` —— ${JSON.stringify(r.tags)}` : ''))
      ok(r.remounts <= BUDGET.rowRemounts, `A② 行 ${who} 重挂 ${r.remounts} ≤ ${BUDGET.rowRemounts}`)
      ok(r.lateFades.length <= BUDGET.rowLateFades,
        `A③ 行 ${who} **在屏时被按回透明** ${r.lateFades.length} ≤ ${BUDGET.rowLateFades}`
        + (r.lateFades.length ? ` —— ${JSON.stringify(r.lateFades)}` : ''))
      ok(r.entranceFades <= BUDGET.rowEntranceFades,
        `A③ 行 ${who} 淡入 ${r.entranceFades} 次(在屏段 ${r.visibleRuns})≤ ${BUDGET.rowEntranceFades}`)
      ok(r.heightRoundTrips.length <= BUDGET.rowHeightRoundTrips,
        `A④ 行 ${who} 行高一帧内往返 ${r.heightRoundTrips.length} ≤ ${BUDGET.rowHeightRoundTrips}`
        + (r.heightRoundTrips.length ? ` —— ${JSON.stringify(r.heightRoundTrips)}` : ''))
    }
    return out
  }

  const rep = d.events.filter((e) => e.kindOfEvent === 'replace')
  ok(d.counts.replace <= BUDGET.blockReplaces,
    `B⑥ 换节点 ${d.counts.replace} ≤ ${BUDGET.blockReplaces}`
    + (rep.length ? ` —— ${rep.map((e) => `${e.t}ms 下标${e.at} 高${e.from.h}→${e.to.h}(Δ${e.dh})`).join(' / ')}` : ''))
  ok(d.counts.mutate <= BUDGET.blockMutates, `B⑨ 就地改型 ${d.counts.mutate} ≤ ${BUDGET.blockMutates}`)

  const cells = d.mathCells ?? []
  ok(cells.length >= 2, `B⑦ 采到 ${cells.length} 条公式(素材里有 2 条:一条前缀恒合法、一条不是)`)
  for (const c of cells) {
    ok(c.nodes <= BUDGET.mathNodes,
      `B⑦ 公式 #${c.index} 一生用了 ${c.nodes} 个 DOM 节点 ≤ ${BUDGET.mathNodes}`
      + (c.nodes > 1 ? ` —— life ${JSON.stringify(c.lives)}(这正是 \`settled: 'same'\` 那句自述)` : ''))
    ok(c.pads.length <= BUDGET.mathPads,
      `B⑦ 公式 #${c.index} padding 取值 ${c.pads.length} 种 ≤ ${BUDGET.mathPads} —— ${JSON.stringify(c.pads)}`)
    if (c.settleAt === null) {
      ok(false, `B⑧ 公式 #${c.index} 一趟里没量到换装那一拍(高度轨迹 ${JSON.stringify(c.heights)})`)
      continue
    }
    const drop = c.settleDh === null ? null : -c.settleDh
    ok(drop !== null && drop <= TRANSITIONAL.mathSettleDropPx,
      `B⑧ 公式 #${c.index} 换装那一拍 @${c.settleAt}ms 自己矮了 ${drop}px ≤ ${TRANSITIONAL.mathSettleDropPx}(过渡值)`
      + ` · 高度轨迹 ${JSON.stringify(c.heights)}`)
    /*
     * **真正的判据在这一条:下文一个像素都不许动。**
     *
     * 第一版写的是「下文位移 = 公式自己的高度差」—— 那是**纸上推的**,真机当场证伪:
     * 公式自己矮了 18.02px,而紧跟着它的那一块画出来的 y 只动了 **0.03px**。
     * 理由是这一段贴着底在流:公式上方的内容缩掉多少,跟底那条路就把 `scrollTop`
     * 同量收回多少,屏幕上那一格因此纹丝不动(G 线的活儿)。所以掉幅那 18.02px 是
     * **块自己的事实**,而「下文动没动」是另一件事,两件都要判,不能相减合成一条。
     *
     * `settleShift` 是 `null` 时那一块换了号,两个 y 不能相减 —— 那本身就说明结构
     * 在那一帧动过,红。
     *
     * **口径**:这一格量的是**贴底**那一形(场景自己先 `scrollToBottom`)。上翻半屏
     * 时那一下由 G 线的 `ViewportAnchor` 按 `cause: 'settle'` 裁,归 `gate:stream-geometry`,
     * 不在这道门里。
     */
    ok(c.settleShift !== null && Math.abs(c.settleShift) <= 1,
      `B⑧ 公式 #${c.index} 换装那一拍下文位移 ${c.settleShift}px,|·| ≤ 1`
      + `(它自己矮了 ${c.settleDh}px,贴底那条路把这一下吃掉了)`)
    /* 这一趟里它有没有落进「排不出来」那一档 —— 候选 (a) 与 (c) 的分水岭,只报不判。 */
    if (c.failedFrames > 0) {
      console.log(`        · 公式 #${c.index} 有 ${c.failedFrames} 帧停在「排不出来」那一档`)
    }
  }
  return out
}

function report(tag, m) {
  const d = m.dom
  const p = m.pix
  if (m.mode === 'tool') {
    if (d.empty) { console.log(`      ${tag} · DOM:没采到卡(${d.frames} 帧 / ${d.withCard} 帧有卡)`) }
    else {
      console.log(`      ${tag} · DOM:${d.frames} 帧 @${d.fps}fps / ${d.spanMs}ms`
        + ` · 换挡时刻 参数${d.shifts.args}ms 执行${d.shifts.exec}ms 收场${d.shifts.settle}ms`
        + ` · **卡重挂 ${d.cardRemounts}** · 高度往返 ${d.cardHeightRoundTrips.length}`
        + ` · 头行图标 ${JSON.stringify(d.headIcons)} 头行节点 ${JSON.stringify(d.headLifes)}`
        + ` · 权限槽 ${d.permMax} · 抽屉 ${d.drawerMax} · 进度条帧 ${d.tbarFrames}`
        + ` · 长帧 ${d.longTotal}(最长 ${d.longestMs}ms) · 改动 ${d.muts} 条`)
      console.log(`        卡高取值:${JSON.stringify(d.cardHeights)}`)
      for (const rt of d.cardHeightRoundTrips.slice(0, 6)) {
        console.log(`        [高度往返 ${rt.t}ms] ${rt.from} → ${rt.to} → ${rt.from}(${rt.backAt}ms 回来)`)
      }
      console.log(`        卡高内联(FLIP 写的那一格)取值:${JSON.stringify([...new Set(d.cardInline)])}`)
      for (const r of d.rows) {
        console.log(`        行 ${String(r.callId).slice(-8)}:重挂 ${r.remounts} · 换元素 ${r.tagSwaps} ${JSON.stringify(r.tags)}`
          + ` · hidden 翻 ${r.hiddenFlips} · reveal 翻 ${r.revealFlips}`
          + ` · **透明度掉下去又回来 ${r.opacityDips.length}** · 行高往返 ${r.heightRoundTrips.length}`
          + ` · 透明度台阶 ${r.opacitySteps}`)
        for (const dip of r.opacityDips) console.log(`          [透明度往返 ${dip.t}ms] 掉到 ${dip.low},${dip.backAt}ms 回来`)
        for (const rt of r.heightRoundTrips) console.log(`          [行高往返 ${rt.t}ms] ${rt.from} → ${rt.to} → ${rt.from}`)
        for (const tr of r.transitions.slice(0, 24)) console.log(`          [${tr.t}ms] ${tr.what}`)
      }
      for (const key of ['args', 'exec', 'settle']) {
        const ls = d.longFramesNear[key]
        if (ls.length) console.log(`        ${key} 换挡 ±100ms 内长帧:${JSON.stringify(ls)}`)
      }
      if (d.mutKinds) console.log(`        改动前几名:${JSON.stringify(d.mutKinds)}`)
    }
  } else if (d.empty) console.log(`      ${tag} · DOM:采到 ${d.frames} 帧,量不了`)
  else {
    const c = d.counts
    console.log(`      ${tag} · DOM:${d.frames} 帧 @${d.fps}fps / ${d.spanMs}ms · 终态 ${d.finalBlocks} 块`
      + ` · **真换节点 ${c.replace}**(流式中 ${c.replaceDuringStream} / 收场后 ${c.replaceAfterSettle})`
      + ` · 插入 ${c.insert} · 移除 ${c.remove} · 就地改型 ${c.mutate}`
      + ` · 就地高亮 ${c.highlight} · 就地长出表 ${c.tableborn}`
      + ` · **就地裸记号→渲染 ${c.inlineSettle} · 就地长出行内语义 ${c.inlineGrow}**`
      + ` · childList 同帧增删 ${d.nodeSwapMuts} · 长帧 ${d.longTotal}(最长 ${d.longestMs}ms) · 改动 ${d.muts} 条`)
    for (const e of d.events.filter((x) => x.kindOfEvent !== 'insert').slice(0, 30)) {
      if (e.kindOfEvent === 'replace') {
        console.log(`        [换节点 ${e.t}ms · 下标 ${e.at} · ${e.live ? '流式中' : '收场后'}]`
          + ` ${e.from.tag}/${e.from.kind ?? '-'}(life ${e.from.life}) → ${e.to.tag}/${e.to.kind ?? '-'}(life ${e.to.life})`
          + ` 高 ${e.from.h} → ${e.to.h}(Δ${e.dh}) 文「${e.from.text}」→「${e.to.text}」`)
        if (e.cs) console.log(`            样式差:${e.cs.join(' · ')}`)
      } else if (e.kindOfEvent === 'remove') {
        console.log(`        [移除 ${e.t}ms · 下标 ${e.at}] ${e.from.tag}/${e.from.kind ?? '-'} 高 ${e.from.h} 文「${e.from.text}」`)
      } else if (e.kindOfEvent === 'inlineSettle' || e.kindOfEvent === 'inlineGrow') {
        console.log(`        [${e.kindOfEvent} ${e.t}ms · 下标 ${e.at} · life ${e.life} · ${e.tag}/${e.kind ?? '-'}]`
          + ` ${e.what}(Δ高 ${e.dh})「${e.from}」→「${e.to}」`)
      } else {
        console.log(`        [${e.kindOfEvent} ${e.t}ms · 下标 ${e.at} · life ${e.life}] ${e.what}(Δ高 ${e.dh})`)
      }
    }
    const ins = d.events.filter((x) => x.kindOfEvent === 'insert')
    console.log(`        插入的块(按出场序):${ins.map((e) => `${e.t}ms@${e.at} ${e.to.tag}/${e.to.kind ?? '-'}`).join(' | ') || '(无)'}`)
    console.log('        逐块归类(终态每一块回看它这一生):')
    for (const l of d.lineage) {
      console.log(`          · ${l.tag}/${l.kind ?? '-'}${l.geom ? `[geom=${l.geom}]` : ''}`
        + ` life ${l.life} 生于 ${l.bornT}ms(${l.bornLive ? '流式中' : '收场后'})`
        + ` 高 ${l.firstH} → ${l.finalH}(Δ${l.dh})`
        + ` · 换过节点 ${l.replacedFrom.length}${l.replacedFrom.length ? ` ${JSON.stringify(l.replacedFrom)}` : ''}`
        + ` · 就地变 ${l.inPlace.length}${l.inPlace.length ? ` ${JSON.stringify(l.inPlace)}` : ''}`
        + ` 文「${l.text}」`)
    }
    console.log(`        动作格淡入:${d.actionsOpacityRamp.startT}ms 起 → ${d.actionsOpacityRamp.fullT}ms 满`)
    for (const s of [d.settleByLive, d.settleByFace]) {
      if (!s) continue
      console.log(`        ${s.label}(${s.t}ms):face ${s.faceFlip} · live ${s.liveFlip}`
        + ` · 动作格透明度 ${s.actionsOpacity} · 尾槽相位 ${s.tailFaceFlip}`
        + ` · scrollTop ${s.scrollTop} · scrollHeight ${s.scrollHeight} · 离底 ${s.fromBottom}`
        + ` · 块数 ${s.blocksBefore} → ${s.blocksAfter}`)
      for (const x of s.changes) console.log(`          · ${x.what}:${JSON.stringify(x)}`)
      for (const x of s.blockChanges.slice(0, 20)) console.log(`          · 块动了:${JSON.stringify(x)}`)
      for (const x of s.addedBlocks) console.log(`          · 这一帧才出现的块:${JSON.stringify(x)}`)
    }
    if (d.longAtSettle.length) console.log(`        收场 ±150ms 长帧:${JSON.stringify(d.longAtSettle)}`)
    if (d.mutKinds) console.log(`        改动前几名:${JSON.stringify(d.mutKinds)}`)
  }
  if (p.empty) { console.log(`      ${tag} · 像素:${p.frames ?? 0} 帧,量不了(${p.why ?? '帧太少'})`); return }
  console.log(`      ${tag} · 像素:收 ${p.captured} / 解 ${p.decoded} 帧 · 图 ${p.imgSize} 缩放 ${p.scale} · 裁框 ${p.region}`
    + ` · 平均亮度中位 ${p.meanMedian} · 变化占比 中位 ${p.fracMedian} / 最大 ${p.fracMax}`
    + ` · 帧间差最大 ${p.stepMax}`
    + ` · 命中 ${p.hits.length}(**闪 ${p.spikes}** / 换挡 ${p.steps} / 段首尾 ${p.edges})`
    + ` · 整块换了又换回来 ${p.flips.length}`)
  for (const h of p.hits.slice(0, 10)) console.log(`        [像素 第 ${h.i} 帧 · ${h.kind}] ${h.why}(变化占比 ${h.frac})`)
  for (const h of p.flips.slice(0, 6)) console.log(`        [像素 第 ${h.i} 帧 · 整块往返] ${h.why}`)
  if (p.saved?.length) console.log(`        出事帧存了 ${p.saved.length} 张,第一张:${p.saved[0]}`)
  const q = m.pixTight
  if (q && !q.empty) {
    console.log(`      ${tag} · 像素(紧裁${m.mode === 'tool' ? '=第一行' : '=这条活消息'} ${q.region}):平均亮度中位 ${q.meanMedian}`
      + ` · 变化占比 中位 ${q.fracMedian} / 最大 ${q.fracMax} · 帧间差最大 ${q.stepMax}`
      + ` · 命中 ${q.hits.length}(**闪 ${q.spikes}** / 换挡 ${q.steps} / 段首尾 ${q.edges}) · 整块往返 ${q.flips.length}`)
    for (const h of q.hits.slice(0, 12)) console.log(`        [紧裁 第 ${h.i} 帧 · ${h.kind}] ${h.why}(变化占比 ${h.frac})`)
    for (const h of q.flips.slice(0, 6)) console.log(`        [紧裁 第 ${h.i} 帧 · 整块往返] ${h.why}`)
    if (q.saved?.length) console.log(`        紧裁出事帧第一张:${q.saved[0]}`)
  } else if (q && q.why) console.log(`      ${tag} · 像素(紧裁):${q.why}`)
}

main().catch((error) => {
  console.error(`\n[tmf] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
