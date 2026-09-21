#!/usr/bin/env node
/**
 * **「正在生成」那一格不许抖** —— 真机门(G 线 P1e,2026-09-21;由 P1c 的探针原地升成)。
 *
 * 起因(P1c)是用户报的一句话:「感觉 generating 在抖动,不知道是不是上面正在生成的
 * 内容也有抖动,因为他在滚动所以看不出来。另外就是这个滚动是上下滚动,幅度很小,
 * 鼠标放上去的时候能够看出来这个元素的位置确实有些变化」。
 *
 * ══ 取样口:**画出来的那一份**,不是 rAF ══════════════════════════════════
 *
 * 这道门存在的第一条理由就是取样口。P1c 用 `requestAnimationFrame` 量,量出尾槽有
 * 一条 2.5px 的「慢摆」,据此加了一条 sticky;P1d 才发现**那是取样相位的假象**:
 * rAF 跑在「动画推进之后、**布局与 ResizeObserver 之前**」,而产品把 `stick()`
 * (`scrollTop = scrollHeight`)放在它自己那只 RO 的回调里 —— 于是 rAF 读到的永远是
 * **这一帧的半成品**:过渡已经把列推高了,纠正滚动位的那一句还没跑。正本 §9.7。
 *
 * 所以这道门只认**一个**取样口:**在 `requestAnimationFrame` 里 `postMessage` 出去的
 * 那个宏任务里读**。那个宏任务跑在这一帧的「更新渲染」(样式 → 布局 → 绘制 → 提交)
 * 全部走完之后、下一帧的任何东西之前,所以它读到的矩形与 `scrollTop` 就是**刚画出去
 * 的那一份**。判词与实现都在 `startPaintSampler` 上。
 *
 * **它每帧采一次,不挑帧** —— 这一条是 P1e 第一版(挂第二只 `ResizeObserver`)栽在
 * 的地方:RO 只在**被观察的盒子的尺寸变了**时才响,真店档整轮 rAF 侧看得见 1262 帧,
 * RO 侧只采到 45 次、贴底跟随那一段 0 次,于是判据永远卡在「采到 N 次 < 门槛」,门
 * 一次都没绿过。病历与三条已排掉的假因留在正本 §10.2。
 * 一个例外照旧单独量:**人自己滚动**那一下(上翻再点丸回底)两侧各现读一次(③)。
 *
 * ══ 判的那几格(`BUDGET`)════════════════════════════════════════════════
 *  ① **贴底跟随**:尾槽画出来的 top 只占 **1 个设备像素行**(按设备像素取整后的取值
 *     个数 = 1)。停止钮同判 —— 人 hover 的是它,命中框跳一格就是跳一格。
 *  ② **上下文更新行(`.rowLate`)的高度过渡在跑的那十来帧** —— P1d 查出来的那条
 *     斜坡的产地(§9.7 ①)。**今天只报不判**:实测那道折痕是跟着用户消息落账一起
 *     挂上来的,座位还满着(短会话档 21 帧过渡,落在贴底跟随态的 0 帧),而落位期
 *     尾槽本来就该动 —— 那一段的几何归 `gate:stream-geometry` 的 ①⑧。判词、两个
 *     读数(`inPinned` / `seatAlive`)与「它什么时候会变成判据」全写在判据那一段旁。
 *  ③ **两处切换各 ≤ 1 设备像素**:座位期 → 跟随期的交接、人上翻再点丸回底。
 *  ④ 两档都跑:**短会话**与**真店夹具**(50.9MB / 400 条)。小会话上量不出来的东西
 *     不等于用户那儿没有 —— P1c 整条病史就是这么来的。
 *
 * **sticky 那一支不立断言**:P1d 量过,把 `TailSlot.module.css` 那两行
 * `position: sticky; bottom: 0` 拆掉,这道门的读数**一格不变**。它留在产品里是结构性
 * 免疫(尾槽的位置不再取决于 `stick()` 有没有赢下这一帧的竞速),不是这道门的守卫
 * 对象。**真正被守着的是 09-15 的 `content/tail-snap.ts`** —— 拆掉它,读数当场变成
 * 几十个取值(反证在正本 §10.1)。
 *
 * ══ 为什么不并进 `gate-stream-geometry.mjs` ══════════════════════════════
 * 那道门的 ② 量的是同一件东西,但它整只走 rAF 取样,而且 `long` 档跑得太短
 * (26 段 / 3.6 秒)—— P1c 试过拉长到 96 段,main 上仍只读到 0.3px(正本 §9.4)。
 * 两只门的取样口不一样,合并就是把这一条也拉回 rAF。
 *
 * ══ 纪律 ══════════════════════════════════════════════════════════════════
 * **dpr 钉 2**(起来第一句就核对 `window.devicePixelRatio`);**每帧 O(1)、诊断之外
 * 一次 `getComputedStyle` 都没有**(09-10「探针自伤」判例);屏外档
 * `ONETHING_GATE_OFFSCREEN=1`;临时 store + 临时 user-data-dir,**绝不连 `~/.onething`**;
 * 收尾逐个收尸并自查。
 *
 * ── `--diag`:P1d 留下的诊断档(不判,只摊开)──────────────────────────────
 * `scrollTop` setter 与 `ResizeObserver` 各包一层计数并留栈、`document.getAnimations()`
 * 点名此刻在跑的过渡、活消息行的内容坐标、rAF 那一份取样与斜坡自动查找 ——
 * P1d 查产地用的家伙,留着给下一次「读数说不通」时用。
 *
 * 跑法:`npm run gate:tail-jitter` / `... -- --prod` / `... -- --diag`
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
const DEV_PORT = Number(process.env.ONETHING_TAIL_VITE_PORT ?? 5237)
const VIEWPORT = { width: 1280, height: 800 }
/** **钉死 dpr**:`tail-snap` 的判据以设备像素计,dpr 不对整份读数不成立。 */
const DPR = Number(process.env.ONETHING_TAIL_DPR ?? 2)

/* ── 预算(判词在文件头)。它们是**上限**不是目标;抬 BUDGET 是改法。────────── */
const BUDGET = {
  /** ① / ② 画出来的 top 只许占几个设备像素行。 */
  paintedRows: 1,
  /** ③ 两处切换前后,画出来的 top 差几个设备像素。 */
  switchDevicePx: 1,
  /**
   * ① 的**细尺**:同一段贴底跟随里,画出来的 top 峰峰值最多几个设备像素。
   *
   * 与 `paintedRows` 说的是同一句话(「它只占一行」),但 `paintedRows` 按格取整,
   * 两个相差 0.9 个设备像素的读数可能落在同一格上。P1e 的反证第一趟就是这么险过的:
   * 拆掉 `snapTail` 之后尾槽的 `rows` 仍然是 1、只有停止钮翻成 2 —— 一条只靠取整的
   * 判据会把一次真的亚像素抖四舍五入掉。这一格补的就是那半句,**数还是 1**
   * (一个设备像素),不是放水,是换一把量同一件事的尺。
   */
  pinnedPeakDevicePx: 1,
  /**
   * 贴底跟随那一段至少要采到这么多样,否则「与自己比恒为 0」是一句绿的谎话。
   *
   * **每帧一样**(见 `startPaintSampler`),屏外档实测 94–120fps,所以 200 样
   * ≈ 1.7–2.1 秒的连续跟随 —— 正好盖得住 P1c 量到的那条「约两秒一个来回」的嫌疑。
   * 第一版写的是 20(那时取样口是 RO,一秒只响几次),按帧算只有六分之一秒,
   * 「恒为 0」那句话在那么短的窗口里是白送的。
   */
  minPinnedSamples: 200,
  /** `.rowLate` 那一段至少要采到这么多帧,采不到就说采不到,不假装判过。 */
  minRowLateSamples: 5,
}

/** ① 的窗口攒够这么多贴底样本就收(每帧一样,所以这是一个数得出来的量)。 */
const PINNED_WINDOW_SAMPLES = 400
/** 攒不够也不能无限等 —— 流总会收场,收场就按收场算(判据照旧会红)。 */
const PINNED_WINDOW_CAP_MS = 12_000

const failures = []
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`)
  else { console.log(`  ✗ ${message}`); failures.push(message) }
}

/** 按设备像素取整之后有几个不同的值 —— 「它占了几行」。 */
function deviceRows(values, devicePx) {
  const set = new Set(values.map((v) => Math.round(v / devicePx)))
  return set.size
}

/** 第一个字之前静默多久(ms)—— 等待那一段要活得比观察它的节拍长。 */
const FIRST_BYTE_DELAY_MS = 900
/**
 * 长正文:每行都长,行高 22.4px(`--pr-fs` 14 × `--pr-lh` 1.6,分数)。
 *
 * **260 行不是随手写的**(P1e 真店档逼出来的):这一轮要够长,长到「座位吃光 →
 * ③ 上翻 / 点丸回底 → ① 的跟随窗攒够几百样」三段**都还在流里**。96 行那一版在
 * 真店档上整轮只活 8–10 秒,而那一档光是回合开张就吃掉三四秒(折痕挂上来那前后
 * 的帧距实测 700–1100ms),轮到上翻时流已经收场 —— 没有 delta 就没有未读,
 * 「回到最新」那颗丸压根不亮,③ 报「丸没亮」、① 一个贴底样都采不到。
 * 两个读数都不是产品的错,是这道门给自己留的跑道太短。
 */
const REPLY_LINES = 260
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
const SCENARIOS = ['text', 'think', 'tools', 'burst']
const MARK_OF = {
  text: '@@tail-text@@',
  think: '@@tail-think@@',
  tools: '@@tail-tools@@',
  burst: '@@tail-burst@@',
}
/**
 * 门跑哪几个场景:`burst` 一个。
 *
 * `burst` 是**保真度**那一档(P1e):真 provider 不是每 110ms 吐一块整整齐齐的字,
 * 它是**不规则突发** —— 所以这一档按 20–250ms 的随机间隔、每次 1–6 行、中间夹一段
 * 思考与一张工具卡、偶尔停 1 秒。用户跑的是 dev + 真 provider,而 P1c/P1d 那三个
 * 匀速场景一次都没复现出他说的抖;要么这一档复现,要么就如实说「未复现」并把
 * harness 与他机器之间还剩的差别列出来(正本 §10.2)。
 * 其余三个匀速场景留给 `--diag`(诊断时对照用),门不跑。
 */
const GATE_SCENARIOS = ['burst']
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
/**
 * **缺省跑真店夹具**(50.9MB / 400 条),`--short` 换成空会话。
 *
 * 两档判的**不是同一批格子**,理由是几何本身:
 *  · **真店档判 ①②③ 全部** —— 它同时满足两个互相打架的前提:②(`.rowLate` 的高度
 *    过渡)只在**一条会话的第一轮**出现(`TurnContextLedger` 按块去重,第二轮起那一行
 *    根本不画),而 ③(座位期 → 跟随期的交接)要求**开量时列就已经填满视口**,
 *    否则量到的是「列长到填满视口」这件合法的事(空会话上第一趟真机量到 554 设备
 *    像素,就是它)。seeded 的 400 条 + 这条会话的第一轮用户消息,两个前提同时成立。
 *  · **短会话档只判 ①** —— 它得先在**同一条会话**里热身一轮才填得满视口,而那一轮
 *    正好把 turn context 那一块吃掉。所以它换来的是「小会话上也不许抖」这一条,
 *    ②③ 由真店档负责。
 */
const BIG = !process.argv.includes('--short')
/**
 * **`--diag`:查斜坡产地那一档**(P1d 任务 2)。
 *
 * 它多做三件**只在诊断时才划算**的事:把 `Element.prototype.scrollTop` 的 setter
 * 与 `ResizeObserver` 各包一层(数「谁写了滚动位」「RO 回调跑了几次」,并留下调用栈),
 * 逐帧多读一格**计算后**的 `translate`(`getComputedStyle`,平时禁),以及把活消息行
 * 在**内容坐标**里的位置记下来 —— 那一格直接答「列上方的东西有没有变高变矮」。
 *
 * 平时(门那一档)一格都不开:它们每帧都要钱,而 09-10「探针自伤」的判例说得很清楚。
 */
const DIAG = process.argv.includes('--diag')
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
      /* `tools` / `burst` 一轮要跑不止一发 HTTP,按 `toolTurns` 分轮,不计配额。 */
      if (mark !== 'tools' && mark !== 'burst') {
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
      if (mark === 'burst') {
        /*
         * **不规则突发**(P1e 保真度档):定种 LCG,所以每趟逐字相同、读数可比。
         * 20–250ms 的间隔、每次 1–6 行、开头一段思考、中间一张工具卡、偶发 1s 停顿。
         */
        let x = 20260921 >>> 0
        const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296 }
        /* 第一发:思考 + 前面那一截 + 一张工具卡;第二发:接着把剩下的吐完。 */
        if (toolTurns === 0) {
          await streamThought(THOUGHT.slice(0, 2_600), 70, 24)
          await delay(120)
        }
        const lines = REPLY.split('\n\n')
        let at = toolTurns === 0 ? 0 : 30
        let sinceTool = 0
        while (at < lines.length) {
          if (res.destroyed) return
          const take = 1 + Math.floor(rnd() * 6)
          send(frame({ content: `${lines.slice(at, at + take).join('\n\n')}\n\n` }))
          at += take
          sinceTool += take
          /* 偶发的长停顿:真 provider 在工具往返 / 服务端排队时就是这样。 */
          await delay(rnd() < 0.08 ? 1000 : 20 + Math.floor(rnd() * 230))
          if (sinceTool > 28 && toolTurns === 0) {
            await toolCall('call_burst', 'echo burst')
            return
          }
        }
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

/**
 * 诊断那一档的页面侧补丁(只在 `--diag` 下注入)。
 *
 *  · `scrollTop` 的 setter 包一层 —— 「贴底那一句到底一帧写几次、从哪儿写的」
 *    只有这一层答得出(产品那一侧 `stick()` 是模块内的闭包,外面够不着);
 *  · `ResizeObserver` 包一层 —— 数回调次数,用来分辨「RO 只在首尾报」的那一支。
 * 两层都只**计数与留栈**,不改行为(照旧调原实现)。
 */
const DIAG_PROBE = `
;(function () {
  window.__jWrites = 0
  window.__jRo = 0
  window.__jStacks = []
  var d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get: d.get,
    set: function (v) {
      window.__jWrites += 1
      if (window.__jStacks.length < 400) {
        window.__jStacks.push({ n: window.__jWrites, s: String(new Error().stack).split('\\n').slice(1, 5).join(' | ') })
      }
      d.set.call(this, v)
    },
  })
  var RO = window.ResizeObserver
  window.ResizeObserver = function (cb) {
    return new RO(function () { window.__jRo += 1; return cb.apply(this, arguments) })
  }
  window.ResizeObserver.prototype = RO.prototype
})()
`

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

/**
 * **取样口:「这一帧画出去的那一份」= rAF 里排一个宏任务,在那个宏任务里读。**
 *
 * 为什么不能读 rAF 本身(P1d,正本 §9.7 ②):rAF 跑在「动画推进之后、**布局与
 * ResizeObserver 之前**」,而产品把 `stick()`(`scrollTop = scrollHeight`)与
 * `snapTail()`(那一格 `translate`)放在它自己那只 RO 的回调里 —— 于是 rAF 读到的
 * 永远是**这一帧的半成品**:过渡已经把列推高了,纠正的那两句还没跑。
 *
 * **这一版为什么不是「再挂一只 RO」**(P1e 第一版那条路,已弃;它的病历留在
 * 正本 §10.2):RO 只在**被观察的那个盒子的尺寸变了**的时候响,于是
 *  · 它一帧也不多、一帧也不少地跟着「列长高了」走,而**位置**还会被别的事改变;
 *  · 观察的是**节点**,React 一换列就哑;
 *  · 真店档实测:整轮 rAF 侧看得见 1262 帧,RO 侧只采到 **45 次**,贴底跟随那一段
 *    **0 次** —— 判据于是永远卡在「采到 N 次 < 门槛」,门一次都没绿过。
 *
 * 今天这一只的判词只有一句:**`requestAnimationFrame` 里 `postMessage` 出去的那个
 * 宏任务,跑在这一帧的「更新渲染」步骤(样式 → 布局 → 绘制 → 提交)全部走完之后、
 * 下一帧的任何东西之前**。所以在那个宏任务里读 `getBoundingClientRect()` /
 * `scrollTop`,读到的就是**刚画出去的那一份**。它每帧采一次,不挑帧,也不认节点
 * (缓存的那几格一脱离文档就现找),两个病一起没了。
 *
 * 逼排版吗?逼,但**此刻布局是干净的** —— 「更新渲染」刚走完,自那之后没有任何
 * JS 动过 DOM,所以这一次 `getBoundingClientRect()` 命中的是缓存,不触发重排
 * (09-10「探针自伤」判例要防的是**在热路径上逼重算**,不是禁止读矩形)。
 * 同一条理由:这里一次 `getComputedStyle` 都没有。
 *
 * 校准(这只口凭什么算立住了,三条都在正本 §10.2 有读数):
 *  ① 拆掉 `content/tail-snap.ts` 的 `snapTail`(备份文件法),它必须读得出亚像素抖;
 *  ② 装回去,它必须读回一个取值;
 *  ③ `.rowLate` 过渡那十几帧,rAF 口读得出斜坡而这只口读不出。
 */
async function startPaintSampler(page) {
  await page.evaluate(() => {
    window.__jPaint = []
    let stopped = false
    /*
     * 缓存那几格,每帧只在「它掉了」的时候现找一次 —— 400 行的列上每帧三次
     * `querySelector(':scope > …)` 是白扫 1200 个孩子,而这只回调是每帧都跑的。
     */
    let scroll = null
    let column = null
    let slot = null
    let seat = null
    let ctx = null
    let stop = null
    const alive = (el) => el && el.isConnected
    const resolve = () => {
      if (!alive(scroll)) scroll = window.__jLeaf().querySelector('[data-testid="chat-stream"]')
      if (!scroll) return false
      const nextColumn = scroll.firstElementChild
      if (nextColumn !== column) { column = nextColumn; slot = null; seat = null; ctx = null }
      if (!column) return false
      if (!alive(slot) || slot.parentElement !== column) {
        slot = column.querySelector(':scope > [data-tail-slot]')
      }
      if (!alive(seat) || seat.parentElement !== column) {
        seat = column.querySelector(':scope > [data-seat]')
      }
      /*
       * **上下文更新折痕要取「最后那一道」,不是第一道**(P1e 真店档实测:②
       * 整轮采到 0 次)。`querySelector(':scope > [data-context-of]')` 给的是
       * **第一道** —— 真店夹具里那是几百条历史里某一轮的折痕,早就静止了,于是
       * 「它在变的那几帧」永远是空集,而短会话档因为只有一轮恰好蒙对。
       * 所以每帧往回扫最后十二格取最后一道(折痕永远紧挨着它说的那条消息,
       * 而这一轮的消息就在列尾);十二次 `hasAttribute` 是 O(1) 量级,不是热路径。
       */
      ctx = null
      for (let i = column.children.length - 1, n = 0; i >= 0 && n < 12; i -= 1, n += 1) {
        if (column.children[i].hasAttribute('data-context-of')) { ctx = column.children[i]; break }
      }
      if (!alive(stop) || !slot || !slot.contains(stop)) {
        stop = slot ? slot.querySelector('[data-testid="chat-stop"]') : null
      }
      return Boolean(slot)
    }
    /** 这一帧画完之后跑的那一句 —— 取样就在这儿,不在 rAF 里。 */
    const sampleAfterPaint = () => {
      if (stopped) return
      if (resolve()) {
        const anchor = window.__jAnchor && window.__jAnchor.isConnected
          ? window.__jAnchor.getBoundingClientRect().top : null
        window.__jPaint.push({
          t: performance.now(),
          top: slot.getBoundingClientRect().top,
          stopTop: stop && stop.isConnected ? stop.getBoundingClientRect().top : null,
          /* 正文那一块也取一份:用户第二问「上面正在生成的内容也有抖动吗」要的是它。 */
          anchor,
          st: scroll.scrollTop,
          sh: scroll.scrollHeight,
          seatH: seat && seat.isConnected ? seat.getBoundingClientRect().height : null,
          /*
           * 上下文更新那一行(`.rowLate`)此刻多高 —— 它**在变**的那几帧就是
           * 「回合开张那一段」(② 单独判的那一格)。用高度变没变来认,不用
           * `getAnimations()`:后者要遍历整篇文档的动画表,在每帧的路上太贵。
           */
          ctxH: ctx && ctx.isConnected ? ctx.getBoundingClientRect().height : null,
          /** 那道折痕说的是哪条消息 —— 换了一道就不是同一条曲线,别拿两道去做差。 */
          ctxOf: ctx ? ctx.getAttribute('data-context-of') : null,
          /*
           * **那三条过渡此刻在不在跑** —— ② 的窗口由它划,不由「高度差」划。
           * 高度差要两帧才说得出一句话,而这一段一共才十来帧、在真店档上还可能整段
           * 落进一个长帧里;`Element.getAnimations()` 只问这一个元素(不是
           * `document.getAnimations()` 那一趟全文档遍历),一帧一次是 O(1) 量级。
           */
          ctxAnim: ctx && ctx.isConnected ? ctx.getAnimations().length : 0,
          running: slot.getAttribute('data-face') === 'run',
          /** 驱动那一侧在切换前后打的记号(③ 靠它切窗口)。 */
          phase: window.__jPhase ?? '',
        })
      }
      requestAnimationFrame(tick)
    }
    const channel = new MessageChannel()
    channel.port1.onmessage = sampleAfterPaint
    const tick = () => { if (!stopped) channel.port2.postMessage(0) }
    requestAnimationFrame(tick)
    window.__jPaintStop = () => { stopped = true; channel.port1.onmessage = null }
  })
}

async function stopPaintSampler(page) {
  return page.evaluate(() => {
    window.__jPaintStop?.()
    const out = window.__jPaint ?? []
    window.__jPaint = []
    return out
  })
}

async function startSampler(page, diag) {
  await page.evaluate((withDiag) => {
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
        /*
         * 诊断那一档多读三格(判词在 `DIAG` 上):计算后的 translate(粘性的偏移
         * 也落在这里,内联那一格看不见)、活消息行在**内容坐标**里的位置
         * (它一变就说明**列上方**的东西变高变矮了 —— 候选 ① 的判据)、
         * 以及两只计数器的当前值。
         */
        let trComputed = null
        let liveTopContent = null
        /**
         * **谁在动** —— `document.getAnimations()` 把 CSS 过渡也算进去,所以这一句
         * 直接点名「此刻正在跑的那条高度过渡长在哪个元素上」。斜坡那十几帧里它答什么,
         * 就是产地。只在诊断档开:它遍历整篇文档的动画表,不是每帧该干的活。
         */
        let anims = null
        if (withDiag) {
          anims = []
          for (const a of document.getAnimations()) {
            if (a.playState !== 'running') continue
            const el = a.effect && a.effect.target
            if (!el) continue
            const prop = (a.transitionProperty || (a.effect.getKeyframes?.()[0]
              ? Object.keys(a.effect.getKeyframes()[0]).filter((k) => k !== 'offset' && k !== 'computedOffset' && k !== 'easing').join('+')
              : '?'))
            anims.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 28)}[${prop}]`)
          }
          anims = anims.slice(0, 4)
        }
        if (withDiag && slot) {
          trComputed = getComputedStyle(slot).translate || ''
          const kids = column.children
          for (let i = kids.length - 1; i >= 0 && i >= kids.length - 7; i -= 1) {
            const el = kids[i]
            if (!el.hasAttribute('data-message-id')) continue
            if (el.getAttribute('data-role') === 'user') break
            liveTopContent = el.getBoundingClientRect().top
              - scroll.getBoundingClientRect().top + scroll.scrollTop
            break
          }
        }
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
          trComputed,
          liveTopContent,
          anims,
          writes: window.__jWrites ?? null,
          ro: window.__jRo ?? null,
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, diag)
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

  /*
   * ── 斜坡:**连着往同一个方向走、每帧都不到一个设备像素、总共走过 ≥1 个设备像素**
   *    的那一段(P1d 任务 2 要查的就是它)。找最长的那一条,把它逐帧摊开。
   */
  let ramp = null
  {
    const rows = pinned.filter((f) => f.slotTop !== null)
    let i = 1
    while (i < rows.length) {
      let j = i
      const dir = Math.sign(rows[i].slotTop - rows[i - 1].slotTop)
      if (dir === 0) { i += 1; continue }
      while (j + 1 < rows.length) {
        const d = rows[j + 1].slotTop - rows[j].slotTop
        if (Math.sign(d) !== dir || Math.abs(d) < 1e-6 || Math.abs(d) >= devicePx) break
        j += 1
      }
      const span = Math.abs(rows[j].slotTop - rows[i - 1].slotTop)
      if (j > i && span >= devicePx && (!ramp || span > ramp.spanPx)) {
        ramp = {
          spanPx: r3(span),
          spanDevicePx: r3(span / devicePx),
          frames: j - i + 2,
          atMs: Math.round(rows[i - 1].t - t0),
          rows: rows.slice(i - 1, j + 2).map((f) => ({
            ms: Math.round(f.t - t0),
            top: r3(f.slotTop),
            st: r3(f.st),
            sh: f.sh,
            colH: r3(f.colH),
            liveTop: f.liveTopContent === null ? null : r3(f.liveTopContent),
            tr: f.trComputed ?? f.tr,
            w: f.writes,
            ro: f.ro,
            anims: f.anims ?? null,
          })),
        }
      }
      i = j + 1
    }
  }

  return {
    frames: frames.length,
    spanMs: Math.round(frames[frames.length - 1].t - t0),
    ramp,
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

/* ══ 门的那一遍算:全部基于「画出来的那一份」 ═══════════════════════════════ */

/**
 * 把一串画出来的取样折成门要的那几格读数。
 *
 * 三段各自成格,判词在文件头:
 *  · `pinned` —— 这一轮在跑、座位已经吃光、而且真的贴着底;
 *  · `rowLate` —— 上下文更新那一行的高度**在变**的那几次(回合开张那一段);
 *  · `switches` —— 驱动打了记号的那两处切换,取记号前后各自**稳定下来**的值相减。
 */
function judge(paint, devicePx, jumpRead) {
  const bottom = (r) => r.st + 2 >= r.sh - 700 // 粗筛:贴底(容器高 670 上下)
  const isPinned = (r) => r.running && (r.seatH === null || r.seatH <= 0.5)
    && r.phase === '' && bottom(r)
  const pinned = paint.filter(isPinned)
  const rowLate = []
  /* 采不到时要说得出「是没有那道折痕,还是有而没在变」—— 两种病治法完全不同。 */
  const ctxSeen = paint.filter((r) => r.ctxH !== null).length
  const ctxIds = new Set(paint.map((r) => r.ctxOf).filter(Boolean))
  const ctxFirst = paint.findIndex((r) => r.ctxH !== null)
  /** 折痕**刚挂上来**那前后各十几帧的帧距(ms)—— ② 采不到时要看的就是它。 */
  const ctxGaps = ctxFirst <= 0 ? [] : paint.slice(ctxFirst - 1, ctxFirst + 16)
    .map((r, i, all) => (i === 0 ? 0 : Math.round(r.t - all[i - 1].t)))
  for (let i = 0; i < paint.length; i += 1) {
    /* ② 的窗口 = 那三条过渡在跑的帧(判词写在取样那一头的 `ctxAnim` 上)。 */
    if (paint[i].ctxAnim > 0) rowLate.push(paint[i])
  }
  /*
   * `rows`(按设备像素格取整后有几个值)是**粗尺**:两个相差 0.9 个设备像素的读数
   * 可能落在同一格上,于是一次真的亚像素抖会被它四舍五入掉 —— P1e 的反证第一趟
   * 就撞上了(拆掉 `snapTail`,尾槽 `rows` 仍然是 1,只有停止钮翻成 2)。
   * 所以同一段再出一把**细尺**:峰峰值(px 与设备像素)与**原始取值个数**。
   * 判据两把一起用,理由写在 BUDGET 的 `pinnedPeakDevicePx` 上。
   */
  const rowsOf = (list, pick) => {
    const vals = list.map(pick).filter((v) => v !== null && v !== undefined)
    if (!vals.length) return { samples: 0, rows: 0, peakDevicePx: 0, distinct: 0 }
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    return {
      samples: vals.length,
      rows: deviceRows(vals, devicePx),
      peakDevicePx: r3((max - min) / devicePx),
      distinct: new Set(vals).size,
    }
  }
  /** 一段取样里最后那几次的中位数 —— 「稳定下来之后它在哪」。 */
  const settled = (list) => {
    const vals = list.map((r) => r.top).filter((v) => v !== null)
    if (!vals.length) return null
    const tail = vals.slice(-5).sort((a, b) => a - b)
    return tail[Math.floor(tail.length / 2)]
  }
  const switches = {}
  {
    /* 座位期 → 跟随期:两段取样各取「稳定下来之后在哪」。 */
    const a = settled(paint.filter((r) => r.phase === 'seat'))
    const b = settled(paint.filter((r) => r.phase === 'follow'))
    switches.seatHandoff = a === null || b === null
      ? { ok: false, reason: '没采到', a, b }
      : { ok: true, a: r3(a), b: r3(b), devicePx: r3(Math.abs(b - a) / devicePx) }
    /* 上翻再点丸回底:驱动那一侧现读的两个数(判词在驱动那一段)。 */
    const { before, after, why } = jumpRead ?? {}
    switches.jumpBack = before === null || before === undefined
      || after === null || after === undefined
      ? { ok: false, reason: why ?? '没读到', a: before ?? null, b: after ?? null }
      : { ok: true, a: r3(before), b: r3(after), devicePx: r3(Math.abs(after - before) / devicePx) }
  }
  return {
    samples: paint.length,
    pinned: (() => {
      const slot = rowsOf(pinned, (r) => r.top)
      const stop = rowsOf(pinned, (r) => r.stopTop)
      return {
        ...slot,
        stop: stop.rows,
        stopPeakDevicePx: stop.peakDevicePx,
        stopDistinct: stop.distinct,
      }
    })(),
    rowLate: {
      ...rowsOf(rowLate, (r) => r.top),
      stop: rowsOf(rowLate, (r) => r.stopTop).rows,
      ctxSeen,
      ctxIds: ctxIds.size,
      ctxGaps,
      /* 这一段里有几帧同时也在「贴底跟随」态 —— P1d 那条斜坡问的正是这个交集。 */
      inPinned: rowLate.filter(isPinned).length,
      /* 还有几帧座位还在(= 这一段其实落在**落位期**,尾槽本来就该动)。 */
      seatAlive: rowLate.filter((r) => r.seatH !== null && r.seatH > 0.5).length,
    },
    switches,
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
  if (m.paint) {
    console.log(`\n  ── 画出来的那一份(rAF 里排的宏任务,跑在这一帧绘制之后)· 同一段贴底跟随 ──`)
    console.log(`  ${m.paint.samples} 次取样:峰峰 ${m.paint.peakPx}px = ${m.paint.peakDevicePx} 设备像素`
      + ` · 反转 ${m.paint.flips} · 挪过整个设备像素的次数 ${m.paint.bigSteps}`)
    console.log(`  取值 ${m.paint.values.distinct} 个:`
      + m.paint.values.top.map(([v, n]) => `${v}×${n}`).join('  '))
  }
  if (m.paintAnchor) {
    console.log(`  正文那一块(同一份取样)${m.paintAnchor.samples} 次:落在设备像素格上的`
      + `**相位** ${m.paintAnchor.phases.distinct} 种:`
      + m.paintAnchor.phases.top.map(([v, n]) => `${v}×${n}`).join('  '))
  }
  if (m.lateCompare) {
    const c = m.lateCompare
    console.log(`\n  ── 两口并排:\`.rowLate\` 过渡那一段(${c.ms}ms)──────────────`)
    console.log(`  画出来的 ${c.painted.n} 帧:峰峰 ${c.painted.peakPx}px`
      + ` = ${c.painted.peakDevicePx} 设备像素 · 取值 ${c.painted.values.distinct} 个`)
    console.log(`  rAF     ${c.raf.n} 帧:`
      + (c.raf.peakPx === undefined ? '不够两帧,比不了'
        : `峰峰 ${c.raf.peakPx}px = ${c.raf.peakDevicePx} 设备像素`
          + ` · 取值 ${c.raf.values.distinct} 个`))
  }
  if (m.ramp) {
    console.log(`\n  ── 斜坡(最长的一条:${m.ramp.spanPx}px = ${m.ramp.spanDevicePx} 设备像素 /`
      + ` ${m.ramp.frames} 帧 @${m.ramp.atMs}ms)──────────`)
    console.log('    ms      slotTop    scrollTop  scrollHeight  列分数高   活行内容坐标  translate            写  RO')
    for (const r of m.ramp.rows) {
      console.log(`    ${String(r.ms).padStart(6)}  ${String(r.top).padStart(9)}`
        + `  ${String(r.st).padStart(9)}  ${String(r.sh).padStart(12)}`
        + `  ${String(r.colH).padStart(9)}  ${String(r.liveTop ?? '—').padStart(12)}`
        + `  ${String(r.tr ?? '—').padEnd(20)} ${String(r.w ?? '—').padStart(4)} ${String(r.ro ?? '—').padStart(4)}`
        + `  ${(r.anims && r.anims.length ? r.anims.join(' , ') : '(无动画)')}`)
    }
  } else {
    console.log('\n  ── 斜坡:这一趟没找到(连着同向、每帧亚像素、总计 ≥1 设备像素 的一段)')
  }
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
      ai: (() => {
        const ai = fakeProviderAiSettings(provider.address().port)
        const caps = ai.providers.deepseek.modelCapabilitiesByModel['deepseek-chat']
        caps.reasoning = true
        caps.tools = true
        return ai
      })(),
      /*
       * **工具要真的能跑**(P1e 第四趟真机):`burst` 那一档夹着一张工具卡,而
       * `enableToolCalls: false` 会让那一发 `tool_calls` 当场收场 —— 整轮在第 28 行
       * 就死了,贴底跟随一格都采不到。设置逐字照抄几何门那一份。
       */
      tools: {
        enableToolCalls: true,
        permissionMode: 'dangerously-allow-all',
        bash: { enableSandbox: false, confirmDangerousCommands: false },
      },
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

    /*
     * **两条会话,热身与被量的那一轮分家**(P1e 第一趟真机逼出来的)。
     *
     * ② 要量的是上下文更新行(`.rowLate`)的高度过渡,而那一块 turn context 由
     * `TurnContextLedger` **按块去重**:一条会话的第一轮拿到整块,之后几轮只拿增量
     * (多半是空的,于是那一行根本不出现)。热身与被量的那一轮共用一条会话时,
     * 热身把它吃掉了 —— 第一趟 ② 采到 0 次就是这么来的。
     * 所以热身跑在 `warmId` 上,被量的那一轮跑在**没人动过**的 `mainId` 上。
     */
    const warmId = (await rpc(record, 'sessions', 'create', { name: '抖动门 · 热身' }))?.session?.id
    const sessionId = (await rpc(record, 'sessions', 'create', { name: '抖动门' }))?.session?.id
    if (!warmId || !sessionId) throw new Error('会话没建出来')
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
    if (DIAG) { await page.addInitScript(DIAG_PROBE); await page.evaluate(DIAG_PROBE) }
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

    /* 打开一条会话(总览 → 那一行 → 等聊天区就位)。 */
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
        Boolean(window.__jLeaf().querySelector('[data-testid="chat-stream"]'))))
      await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
      await delay(800)
    }
    /*
     * **两档的热身都跑在另一条会话上**(P1e:短会话档原本跑在被量的那条自己身上)。
     * 理由是 ②:上下文更新那一行只在**一条会话的第一轮**出现(`TurnContextLedger`
     * 按块去重),热身跑在同一条会话上就把它吃掉了。短会话档想要的「列已经填满
     * 视口」由被量的那一轮自己长出来(96 行 × 22.4px ≈ 3 屏),不必靠热身垫。
     */
    await openSession(warmId)
    await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
    await delay(800)

    /* 热身一轮(吃掉冷开张),跑在热身那条会话上,不量 */
    console.log('[tail-jitter] 热身一轮(不量,另一条会话)')
    await sendViaComposer(page, `热身 ${MARK_WARM}`)
    await waitFor('热身开张', () => stopShown(page), OPEN_TIMEOUT_MS)
    await waitFor('热身收场', async () => !(await stopShown(page)), 300_000)
    await delay(1200)
    await openSession(sessionId)
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

    /** 驱动往取样里打记号(③ 靠它切窗口)。 */
    const mark = (phase) => page.evaluate((v) => { window.__jPhase = v }, phase)

    const readings = {}
    const lane = BIG ? 'big' : 'short'
    const lanes = [lane]
    for (const id of (ONLY ? [ONLY] : GATE_SCENARIOS)) {
      console.log(`\n[tail-jitter] 场景 ${id}`)
      await page.evaluate(() => {
        const scroll = window.__jLeaf().querySelector('[data-testid="chat-stream"]')
        if (scroll) scroll.scrollTop = scroll.scrollHeight
      })
      await delay(400)
      if (DIAG) await startSampler(page, DIAG)
      await startPaintSampler(page)
      await mark('seat')
      let jumpRead = { before: null, after: null }
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
      /*
       * ── ③ 两处切换 ──────────────────────────────────────────────────────
       * 座位期 → 跟随期:记号从 `seat` 翻成 `''`(判词:座位被吃光那一刻)。
       * 之后等这一轮长一段,人上翻半屏(`preScroll`),再点丸回底(`postJump`)。
       */
      await waitFor('座位吃光', () => page.evaluate(() => {
        const col = window.__jLeaf().querySelector('[data-testid="chat-stream"]')?.firstElementChild
        const seat = col?.querySelector(':scope > [data-seat]')
        return !seat || seat.getBoundingClientRect().height <= 0.5
      }), 90_000)
      await mark('follow')
      await delay(500)
      await mark('')
      /*
       * ── 顺序:**先做 ③ 的上翻 / 回底,再留 ① 的跟随窗** ──────────────────
       * 反过来(P1e 第一版的顺序)在真店档上必红,而且红得像产品的错:那一档
       * 「座位吃光」本身就要两三秒,再睡 5 秒 ① 的窗,轮到上翻时这一轮**已经收场**
       * —— 没有 `grew` 就没有未读,`followPillVisible` 为假,丸根本不在屏上,
       * 于是第一版那句 `if (pill instanceof HTMLElement)` 静静地什么都没点,
       * 读数变成「画出来的位移 670 设备像素」(= 上翻的那半屏原地没回来)。
       * 今天把 ③ 挪到换手之后立刻做,它全程落在流里;① 的窗接在它后面,
       * 而且**按样本数收**(见下),不睡定数。
       */
      const readSlotTop = () => page.evaluate(() => {
        const col = window.__jLeaf().querySelector('[data-testid="chat-stream"]')?.firstElementChild
        const slot = col?.querySelector(':scope > [data-tail-slot]')
        return slot ? slot.getBoundingClientRect().top : null
      })
      /*
       * **这一格不走每帧那条取样**:人滚动那一下前后的样本混在一起没法分,所以
       * 两侧各**现读一次**(此刻布局干净,读到的就是会被画出去的那份),中间夹着
       * 上翻与点丸;整段打上 `jump` 记号,好让 ① 的窗把它整段排除。
       */
      await mark('jump')
      await delay(400)
      const beforeJump = await readSlotTop()
      const left = await page.evaluate(() => {
        const el = window.__jLeaf().querySelector('[data-testid="chat-stream"]')
        if (!el) return null
        el.scrollTop = Math.max(0, el.scrollTop - Math.round(el.clientHeight / 2))
        el.dispatchEvent(new Event('scroll', { bubbles: false }))
        return el.scrollHeight - el.clientHeight - el.scrollTop
      })
      /* 真的离底了吗 —— 离不开就没有「回底」可量,说没采到,不给一个假的 0。 */
      const reallyLeft = typeof left === 'number' && left > 6
      let jumpOk = false
      if (reallyLeft) {
        /* 丸要等:它的判据是「浏览中 ∧ 下面长出了没看见的东西」,后半句要一拍 delta。 */
        const pillHit = await waitFor('「回到最新」那颗丸亮起来', () => page.evaluate(() => {
          const pill = window.__jLeaf().querySelector('[data-testid="chat-follow-pill"]')
          if (!(pill instanceof HTMLElement)) return false
          pill.click()
          return true
        }), 6_000).catch(() => false)
        if (pillHit) {
          /*
           * **等它真的回到底,再读** —— 不睡一个定数(09-12 判例「门的读数不许把门
           * 自己的时间算进产品」的另一半:定数睡短了读到的是**半路**)。判据用跟随
           * 状态机同一条贴底判词(`st + ch >= sh − 6`)。
           */
          await waitFor('点丸之后真的回到底', () => page.evaluate(() => {
            const el = window.__jLeaf().querySelector('[data-testid="chat-stream"]')
            if (!el) return false
            return el.scrollTop + el.clientHeight >= el.scrollHeight - 6
          }), 20_000)
          /* 落定之后再留两拍:回底那一下是平滑滚动,到底与停稳不是同一帧。 */
          await delay(500)
          jumpOk = true
        }
      }
      const afterJump = jumpOk ? await readSlotTop() : null
      jumpRead = jumpOk
        ? { before: beforeJump, after: afterJump }
        : { before: null, after: null, why: reallyLeft ? '丸没亮' : '上翻没离底' }
      /*
       * **不管 ③ 成没成,都先回到底再开 ① 的窗**。第一版没这一句:真店档上丸没亮
       * → 没点 → 人还停在上翻的那半屏,而 ① 的贴底判据当场全假,2196 帧里只采到
       * 1 个贴底样。① 与 ③ 是两条判据,一条没做成不该把另一条的前提也拖走。
       */
      await page.evaluate(() => {
        const el = window.__jLeaf().querySelector('[data-testid="chat-stream"]')
        if (el) el.scrollTop = el.scrollHeight
      })
      await waitFor('回到底(① 的窗要在贴底态里开)', () => page.evaluate(() => {
        const el = window.__jLeaf().querySelector('[data-testid="chat-stream"]')
        return Boolean(el) && el.scrollTop + el.clientHeight >= el.scrollHeight - 6
      }), 20_000)
      await delay(300)
      await mark('')
      /*
       * ① 的窗口:**按样本数收,不睡定数**。每帧采一次,所以「够不够」是一个
       * 数得出来的事;流先收场就按收场算(判据仍然是「采到 N 次 < 门槛就红」,
       * 不假装判过)。
       */
      {
        const until = Date.now() + PINNED_WINDOW_CAP_MS
        for (;;) {
          const enough = await page.evaluate((need) => {
            const rows = window.__jPaint ?? []
            let n = 0
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              const r = rows[i]
              if (r.phase !== '') break
              if (r.running && (r.seatH === null || r.seatH <= 0.5)
                && r.st + 2 >= r.sh - 700) n += 1
            }
            return n >= need
          }, PINNED_WINDOW_SAMPLES)
          if (enough) break
          if (Date.now() > until) break
          if (!(await stopShown(page))) break
          await delay(150)
        }
      }
      await waitFor('收场', async () => !(await stopShown(page)), 300_000)
      await delay(600)
      const frames = DIAG ? await stopSampler(page) : []
      const paint = await stopPaintSampler(page)
      const m = DIAG ? analyze(frames, devicePx) : { frames: 0, empty: true }
      const g = judge(paint, devicePx, jumpRead)
      readings[`${lanes[0]}:${id}`] = g
      console.log(`\n══ ${lanes[0]} / ${id} ══ 画出来的取样 ${g.samples} 次`)
      console.log(`  贴底跟随 ${g.pinned.samples} 次:尾槽占 ${g.pinned.rows} 个设备像素行`
        + `(峰峰 ${g.pinned.peakDevicePx} 设备像素 / ${g.pinned.distinct} 个原始取值)`
        + ` · 停止钮 ${g.pinned.stop} 个`
        + `(峰峰 ${g.pinned.stopPeakDevicePx} / ${g.pinned.stopDistinct} 个)`)
      console.log(`  回合开张(.rowLate 过渡在跑)${g.rowLate.samples} 次:尾槽占 ${g.rowLate.rows} 个`
        + ` / 停止钮 ${g.rowLate.stop} 个`
        + `(这一趟里折痕在场 ${g.rowLate.ctxSeen} 帧 / ${g.rowLate.ctxIds} 道`
        + `;它挂上来那前后的帧距 ${g.rowLate.ctxGaps.join('/')}ms)`)
      for (const [k, v] of Object.entries(g.switches)) {
        console.log(`  切换 ${k}:${v.ok ? `${v.a} → ${v.b},差 ${v.devicePx} 设备像素` : v.reason}`)
      }
      if (DIAG && paint.length > 5) {
        /*
         * **与 rAF 那一份比同一段**:rAF 侧(`analyze`)算的是「贴底跟随」那一段,
         * 所以这一侧也取贴底跟随那一段 —— 不能拿整轮(里面还夹着门自己那次上翻
         * 半屏,峰峰会报出几百 px,那是门的动作不是产品的)。判据与 `judge` 里
         * 那只 `isPinned` 逐字同源。
         */
        const seg = paint.filter((r) => r.running && (r.seatH === null || r.seatH <= 0.5)
          && r.phase === '' && r.st + 2 >= r.sh - 700)
        m.paint = {
          samples: seg.length,
          ...jitterOf(seg.map((r) => r.top), seg.map((r) => r.t), devicePx),
          values: valueHistogram(seg.map((r) => r.top), 8),
        }
        /*
         * 正文那一块的**画出来的**位置。它与尾槽不一样:尾槽有 `tail-snap`(以及
         * P1c 的 sticky)把它钉在设备像素格上,正文没有 —— 滚动位只落得到格子上,
         * 而列的分数高每长一截换一个余数,于是正文每一次都落在一个**不同的亚像素
         * 相位**上,文字跟着重新栅格化。这一格量的就是那件事。
         */
        const anchors = seg.map((r) => r.anchor).filter((v) => v !== null)
        if (anchors.length > 5) {
          const phase = anchors.map((v) => v - Math.floor(v / devicePx) * devicePx)
          m.paintAnchor = {
            samples: anchors.length,
            phases: valueHistogram(phase, 8),
          }
        }
        /*
         * **两口并排量同一段 `.rowLate` 过渡**(P1e 取样口校准第 ③ 条,也是 §10.3
         * 审计表的一行):P1d 的结论是「rAF 那一口读得出斜坡、画出来的那一口读不出」。
         * 两份取样在同一条 `performance.now()` 时钟上,所以按时间窗对齐就够。
         */
        const lateSeg = paint.filter((r) => r.ctxAnim > 0)
        if (lateSeg.length > 1 && frames.length > 1) {
          const t0 = lateSeg[0].t
          const t1 = lateSeg[lateSeg.length - 1].t
          const rafSeg = frames.filter((f) => f.t >= t0 && f.t <= t1 && f.slotTop !== null)
          m.lateCompare = {
            ms: Math.round(t1 - t0),
            painted: {
              n: lateSeg.length,
              ...jitterOf(lateSeg.map((r) => r.top), lateSeg.map((r) => r.t), devicePx),
              values: valueHistogram(lateSeg.map((r) => r.top), 6),
            },
            raf: rafSeg.length > 1
              ? {
                  n: rafSeg.length,
                  ...jitterOf(rafSeg.map((f) => f.slotTop), rafSeg.map((f) => f.t), devicePx),
                  values: valueHistogram(rafSeg.map((f) => f.slotTop), 6),
                }
              : { n: rafSeg.length },
          }
        }
      }
      if (DIAG) report(id, m)
    }

    /* ══ 判 ═══════════════════════════════════════════════════════════════ */
    console.log('\n[判据]')
    for (const [key, g] of Object.entries(readings)) {
      assert(g.pinned.samples >= BUDGET.minPinnedSamples,
        `${key} ① 贴底跟随采到 ${g.pinned.samples} 次(≥ ${BUDGET.minPinnedSamples})`)
      assert(g.pinned.rows <= BUDGET.paintedRows && g.pinned.rows > 0,
        `${key} ① 贴底跟随:尾槽画出来的 top 只占 ${g.pinned.rows} 个设备像素行`
        + ` ≤ ${BUDGET.paintedRows}`)
      assert(g.pinned.stop <= BUDGET.paintedRows && g.pinned.stop > 0,
        `${key} ① 贴底跟随:停止钮 ${g.pinned.stop} 个设备像素行 ≤ ${BUDGET.paintedRows}`)
      /* 同一句话的细尺(判词在 BUDGET 的 `pinnedPeakDevicePx` 上)。 */
      assert(g.pinned.peakDevicePx <= BUDGET.pinnedPeakDevicePx,
        `${key} ① 贴底跟随:尾槽峰峰 ${g.pinned.peakDevicePx} 设备像素`
        + `(${g.pinned.distinct} 个原始取值)≤ ${BUDGET.pinnedPeakDevicePx}`)
      assert(g.pinned.stopPeakDevicePx <= BUDGET.pinnedPeakDevicePx,
        `${key} ① 贴底跟随:停止钮峰峰 ${g.pinned.stopPeakDevicePx} 设备像素`
        + `(${g.pinned.stopDistinct} 个原始取值)≤ ${BUDGET.pinnedPeakDevicePx}`)

      /*
       * ── ② 今天**只报不判**,理由是量出来的,不是懒 ────────────────────────
       *
       * P1d(§9.7 ①)把那条斜坡的产地定在 `.rowLate` 的高度过渡上,于是这道门原本
       * 想问:「那十几帧里尾槽画出来的位置动没动」。真机一量,这个问题在**今天的
       * 产品形态下问不出来**:
       *
       *  · 那道折痕是**跟着用户那条消息落账**一起挂上来的,而那一刻**座位还满着**
       *    —— 短会话档实测 21 帧过渡,`inPinned = 0`、`seatAlive = 21`,一帧都没有
       *    落在「贴底跟随」态里。落位期尾槽**本来就该动**(座位在缩、气泡在落),
       *    这一段的位移(实测尾槽 10 个设备像素行)是落位,不是抖;那一段的几何
       *    归 `gate:stream-geometry` 的 ①⑧ 判,不该在这儿再判一遍、还判成「不许动」。
       *  · 真店档更进一步:折痕挂上来那前后的帧距实测 `1360/389/11/29/906/879` ms
       *    —— 整段 125ms 的过渡落进一个长帧里,一趟只采到 2 帧。这不是取样口的
       *    毛病,正是 P1d §9.7 ④ 那条发现的后果(高度过渡长在 400 行、118,000px 的
       *    列靠近底部,每帧改一次高度就逼整条列重排一次)。
       *
       * 所以这里把两个数都**打出来**(`inPinned` = 落在贴底跟随态里的帧数,
       * 那才是 P1d 问的那个交集),并且**只在那个交集够大时才判**。今天它恒为 0,
       * 于是这一格恒为「只报不判」——**写出来的空账,不是一句绿的谎话**。
       * 它什么时候变成判据:P2 的锚定器让这道折痕在**已经贴底跟随之后**才软着陆
       * (或者干脆只过渡 `opacity`),那时交集不再是空的,下面这个 `if` 自己就活了。
       */
      if (g.rowLate.samples > 0) {
        if (g.rowLate.inPinned >= BUDGET.minRowLateSamples) {
          assert(g.rowLate.rows <= BUDGET.paintedRows,
            `${key} ② .rowLate 过渡 ∩ 贴底跟随 的那几帧:尾槽 ${g.rowLate.rows} 个设备像素行`
            + ` ≤ ${BUDGET.paintedRows}`)
          assert(g.rowLate.stop <= BUDGET.paintedRows,
            `${key} ② 同一段:停止钮 ${g.rowLate.stop} 个设备像素行 ≤ ${BUDGET.paintedRows}`)
        } else {
          console.log(`  · ${key} ② 只报不判:过渡在跑 ${g.rowLate.samples} 帧,`
            + `其中落在贴底跟随态的 ${g.rowLate.inPinned} 帧`
            + `(座位还满着的 ${g.rowLate.seatAlive} 帧)—— 理由见判据旁的注`)
        }
      }

      for (const [name, v] of Object.entries(g.switches)) {
        assert(v.ok, `${key} ③ 切换 ${name} 两侧都采到了`)
        if (v.ok) {
          assert(v.devicePx <= BUDGET.switchDevicePx,
            `${key} ③ 切换 ${name}:画出来的位移 ${v.devicePx} 设备像素`
            + ` ≤ ${BUDGET.switchDevicePx}`)
        }
      }
    }
    console.log(`\n[tail-jitter] 读数(${LANE} · dpr${DPR}):${JSON.stringify(readings)}`)
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

  if (failures.length) {
    console.error(`\n[tail-jitter] FAILED(${LANE})—— ${failures.length} 条:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`\n[tail-jitter] ok(${LANE})—— 「正在生成」那一格画出来的位置只占一个设备像素行`)
}

main().catch((error) => {
  console.error(`\n[tail-jitter] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
