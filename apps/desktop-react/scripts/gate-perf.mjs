#!/usr/bin/env node
/**
 * 性能门(工程卫生批 ⑤)—— **脚本级,拒人肉 QA**。
 *
 * 别的门问「对不对」,这条门问「卡不卡」。五个场景,同一套量法:
 *
 *  ① **冷开会话总览**(种子 400 会话)—— 一次点击要画出几百张卡,是这块壳最重的
 *     一次首屏。判据:那一次交互的端到端时长 ≤ 冷开预算(coldOpenMs,一次性重交互
 *     与高频切换分档,来历见 src/perf-budget.ts),期间不出长帧。
 *  ② **架子 tab 连续切换 ×10** —— 08-30 这一批从记录模式**转断言**。现场是用户报障
 *     的那个:sessions(400 张卡的重面板)/ files / terminal 钉进同一条右架子,
 *     背景还有一条 5k 字消息的会话活着。判据两条:每次切换「按下 → 上屏」的 p95
 *     ≤ 交互预算,期间零长帧。读数是**页内 performance.now 夹双 rAF**,
 *     不是 node 侧轮询(轮询间隔会直接变成误差下限)。
 *  ③ **5k 字消息流式回放** —— 从 HTTP 注入一条长消息,量它上屏那一段的帧。
 *     判据:稳态里不出超过 33ms(30fps 一帧)的帧。
 *  ⑤ **常规档 ↔ 常规档 切会话 ×8**(09-03 渲染批补)—— 用户报「切会话卡 300ms」。
 *     门自己种 3 条**常规档**会话(各 12 回合、每回合 ~4k 字回答 + 2 次工具调用,
 *     账本 ≈ 0.5MB —— 与用户报障那条会话的可见正文量级相当;重档不进门,它是另一档)
 *     再在它们之间来回切 8 次。①量的是「几百张卡的首屏」、②量的是「面板换人」,
 *     **都不含「整棵消息树换一份」**—— 那正是这一格补的现场(病根三条见
 *     clamp-measurer.ts / useChatToc.ts / assemble/index.ts)。
 *     **真判据是强制排版次数,不是时间**(09-03 二修):改前改后的「按下→上屏」
 *     p95 落在同一段抖动带里(154–238ms vs 154–204ms),拿它当红绿会闪红闪绿;
 *     `forcedLayouts()` 数的是 trace 里 `Layout` 事件带着非空 `args.beginData.stackTrace`
 *     的那种(DevTools 标「Forced reflow」的判据,见该函数注释),每次切换各圈自己的
 *     窗口(`performance.mark('perf5:switch:<n>:start'/'end')`),取 8 次里的最大值,
 *     判据 ≤ `sessionSwitchForcedLayouts`——这是一个整数计数,没有抖动。
 *     时间 p95 ≤ `sessionSwitchMs` 仍然断言,但只当参考,不再是唯一红绿线。
 *  ⑤b **二合一 / 拆开 ×10**(W6-p 重写;从前是 W5-b 的「切焦点叶」,而中央区收成
 *     一条标签条之后那个现场在结构上不存在了)。量的是**改标签的身份**这一下:
 *     设计 §11 拍点 8 说「一格内容都不许重挂」,这一格就是那句话的秤。
 *  ⑤c **条内换序 ×20**(W6-b)—— 三格里唯一「什么都没改」的那一格:换序期间树
 *     冻着,动的只有一格 `transform`,所以读数一长起来,长的必定是每帧那条链或
 *     松手之后那一段。窗口里再打一枚 `:up`,好把「12 发 move 各让一帧」与
 *     「松手→稳定」分开读。
 *  ④ **大会话 + 真流**(09-03 批 A 补,`docs/design/event-subscription-audience-2026-09.md` §6)
 *     —— 门自己**种**一条与用户报障同量级的会话(≥3000 账本行、≥20 次工具调用),
 *     再让一只假 provider 吐 50KB 带 ```html 围栏的回答 + 2 次工具调用。判据两条:
 *     屏幕滞后于 provider 收尾 ≤ 1s、core 进程 CPU 中位 < 40%。
 *     ③ 与 ④ 的差别正是设计 §1.4 说的那句:③ 只注入一条**用户**消息,没有 assistant
 *     流、也不是大会话 —— 报障的现场它一条都没量到。
 *
 * ── 量法:CDP Tracing,不是页面里的秒表 ───────────────────────────────
 * `Tracing.start` 录的是渲染进程自己的任务流水。我们从中取**主线程(CrRendererMain)
 * 上的 toplevel 任务时长** —— 一帧之所以长,就是因为主线程上有一段长任务占着,
 * 所以「任务 > 50ms」与「长帧」是同一件事的两种说法,而任务是 trace 里定义清晰、
 * 跨版本稳定的那一个。页面里的 `window.__perf.dump()`(LoAF 观察者)当**第二路读数**
 * 一并打印:两路对不上本身就是值得看的信号。
 *
 * ── 一条上批的教训 ────────────────────────────────────────────────────
 * 调试实例**必须** `--user-data-dir` 指临时目录。共享默认 userData 会让上一次跑
 * 剩下的 localStorage / 缓存漏进这一次,量出来的数字既不可复现,也可能把用户
 * 真实的桌面状态改掉。这里每跑一次一个新临时目录,跑完删干净 —— store 同理。
 *
 * 跑法:`node scripts/gate-perf.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 门红时 trace 会留在 /tmp/onething-perf-*.json,直接拖进 DevTools 的 Performance 面板看。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
// Electron 本体不在这个应用里重装一份 —— 理由见 gate-connect.mjs 顶部那段。
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/**
 * 预算表在 `src/perf-budget.ts`(TS 源码,node 直接 import 不了)。
 * 这里**不重抄一份数字** —— 那样两边一定会漂。用一条正则把它读出来,
 * 读不到就明确报错,而不是悄悄用一个默认值(那正是「两份真相」的开端)。
 */
function readBudget() {
  const source = readFileSync(path.join(appRoot, 'src/perf-budget.ts'), 'utf-8')
  const pick = key => {
    const hit = source.match(new RegExp(`${key}:\\s*(\\d+)`))
    if (!hit) throw new Error(`src/perf-budget.ts 里读不到 ${key} —— 表改过了,门也要跟着改`)
    return Number(hit[1])
  }
  return {
    interactionP95Ms: pick('interactionP95Ms'),
    coldOpenMs: pick('coldOpenMs'),
    sessionSwitchMs: pick('sessionSwitchMs'),
    sessionSwitchForcedLayouts: pick('sessionSwitchForcedLayouts'),
    tabPairSplitMs: pick('tabPairSplitMs'),
    tabPairSplitForcedLayouts: pick('tabPairSplitForcedLayouts'),
    tabReorderMs: pick('tabReorderMs'),
    tabReorderTailMs: pick('tabReorderTailMs'),
    tabReorderForcedLayouts: pick('tabReorderForcedLayouts'),
    longFrameMs: pick('longFrameMs'),
    streamFrameMs: pick('streamFrameMs'),
    streamOverBudgetFrames: pick('streamOverBudgetFrames'),
    animationLongFrames: pick('animationLongFrames'),
  }
}

const BUDGET = readBudget()

/**
 * 种子会话数。08-30 这一批从 120 抬到 400:场景②要量的是「重面板重挂」,
 * 120 张卡的架子不够重(工程卫生批那次 mock 轻面板量到最长任务 3ms、零长帧,
 * 于是「没卡顿」的结论与用户的报障对不上 —— 场景没对上,不是没问题)。
 * 400 是一台真机上「会话攒了小半年」的量级。
 */
const SEED_SESSIONS = 400
/**
 * 场景②钉进同一条右架子的三块面板。次序 = tab 次序,也是切换的循环次序。
 *
 * **它们的出厂摆法各不相同**(W6-a 起 sessions 出厂在左架子),所以夹具显式点名
 * 右边 —— 判词在 `pinPanels` 上。
 *
 * **`files` 09-05 换成了 `diff`**(W6-p):W6-a 之后「文件」不再是一块面板,它是一块
 * **启动瓦**(点它 = 开当前会话那个目录),右键给的是启动瓦那几行、**根本没有落点
 * 单选**(真机原样读数:菜单上只有「Open a directory… | Dock settings…」)。场景②要的
 * 是「一条架子上重面板与轻面板混在一组、来回切」,`diff` 与它同样是一块普通面板,
 * 现场的形状一个字没变 —— 换的是一个已经不存在的取件口,不是放宽这道门。
 * 'sessions' 排头是刻意的:它是这块壳最重的一块面板(整份会话网格),
 * 「重面板 + 轻面板混在一组」才是用户报障时的现场。
 */
const SHELF_PANELS = ['sessions', 'diff', 'terminal']

/** 场景③注入的那条长消息:5k 字。 */
const LONG_MESSAGE = `性能门·长消息 ${'流式回放的稳态帧率是这一段要量的东西。'.repeat(200)}`.slice(0, 5000)

/* ── 场景④:大会话 + 真流(批 A,docs/design/event-subscription-audience-2026-09.md §6) ──
 *
 * 场景③注入的是一条**用户**消息,没有 assistant 流、也不是大会话 —— 用户 09-03 报的
 * 「发消息之后流式渲染整个应用卡死」它一条都没量到(设计 §1.4:场景没对上,不是门坏了)。
 * 场景④把现场补齐:**门自己种**一条与报障同量级的会话(不许依赖某台机器上的私有会话),
 * 再让一只假 provider 吐一条 50KB 带 ```html 围栏的回答 + 2 次工具调用。
 *
 * 判据两条,都是**从记录转断言**:
 *  1. 屏幕上出现哨兵的时刻,滞后于 provider 吐完的时刻 ≤ 1s;
 *  2. 这一段里 core 进程(跑过滤与合批的那一个)的 CPU 中位 < 40%。
 */
const PERF4_MARKER = '@@perf4@@'
const PERF4_SEED_MARKER = '@@perf4seed@@'
/**
 * 场景⑤的种子记号。**与大会话那一支分开**:两档的答案长度差 30 倍,混用一个记号
 * 就只剩一档了。数值(3 条 × 12 回合 × 4k 字 + 每回合 2 次工具调用)照抄
 * `probe-hotspots` 的「常规档」——归因读数就是在那一档上取的,门要量的是同一个现场。
 */
const PERF5_SEED_MARKER = '@@perf5seed@@'
const PERF5_SESSIONS = 3
const PERF5_TURNS = 12
/** 场景⑤来回切几次。8 次 = 与 probe 的对照组逐字相同。 */
const PERF5_SWITCHES = 8
/** ⑤c 跑多少趟换序(派工令:「换序 20 次」不劣化)。 */
const PERF5C_REORDERS = 20
/** ⑤b 点多少下(奇数并、偶数拆 —— 所以是偶数,跑完条上还是两格)。 */
const PERF5B_ACTIONS = 10
const PERF4_SENTINEL = 'PERF4ENDMARK'
/**
 * core 侧滞后预算(ms)—— **判据是 node 侧那条 SSE 上哨兵到达的时刻**,不是屏幕上的。
 *
 * 09-03 实测:同一条现场里,屏幕那一头量到的是**渲染层**的代价(单段主线程任务
 * 能到 3–4s,shiki 把整段回答一遍遍重新高亮),它对批 A 改没改**毫无反应** ——
 * 轻档会话上「改前 861ms / 改后 750ms」,重档会话上「改前 3050ms / 改后 4316ms」,
 * 两边的差全是渲染噪声。而同一趟里 core 侧的读数是干净的两档(见反证)。
 * 屏幕滞后照旧打印,只是不做判据 —— 它该由渲染侧的批来治。
 */
const PERF4_CORE_LAG_MS = 1000
/** core 进程 CPU 中位预算(%)。 */
const PERF4_CORE_CPU_PCT = 40
/**
 * 种一条大会话,「够大了」的判据。
 *
 * **为什么判账本字节而不是账本行数**:用户报障那条会话是 5135 行 / 6.3MB,而
 * `assistant/chunks` 是**按时间**打包的 —— 一条流不管吐 77KB 还是 230KB,落进账本
 * 都是那么几行(实测两档都是每回合约 35 行)。也就是说账本**行数只能拿墙钟买**
 * (3000 行 ≈ 86 个回合 ≈ 十分钟),而它并不是代价的来源:一次物化的代价是
 * **字节 × 消息条数 × 工具调用的 JSON**。所以这里按后三样判,并把行数一并打印出来。
 * 种出来的现场在每一条代价轴上都不比报障那条轻(实测 5.8MB / 55 次工具调用 /
 * 80 条消息,对报障的 6.3MB / 29 / 26)。
 */
const PERF4_SEED_MAX_TURNS = 40
/** 种子工具调用的参数字数(见 mock 里那段注释:物化代价的大头在这里)。 */
const PERF4_SEED_TOOL_ARG_CHARS = 30_000
const PERF4_MIN_LEDGER_BYTES = 5 * 1024 * 1024
const PERF4_MIN_TOOL_CALLS = 20

/**
 * 一条 ~50KB 的回答:正文 + ```html 围栏 + 收尾正文。
 * 围栏是刻意的 —— 高亮与分块是渲染侧最重的一段,报障现场正是这个形状。
 *
 * **围栏 60 行、正文占大头**是量出来的:首版围栏 300 行时,渲染主线程单段任务最长
 * 4.7s(shiki 每来一批分片就重新高亮整张表),屏幕滞后在 976ms / 1679ms 之间来回 ——
 * 那把尺子量的已经不是这一批治的东西(core 侧滞后同一趟只有几十毫秒、core CPU 中位 3%),
 * 而是渲染侧高亮一张大表的代价。围栏留着(形状要对),体量交给正文。
 */
function buildPerf4Answer(withSentinel, tableRows = 60, proseChars = 14_000) {
  const prose1 = ('这一段是性能门产出的中文正文,用来还原真实回答里正文与代码块混排的形态。'
    + '流式渲染期间每一帧都要把这条活消息重新组屏、重新分块、重新解析 markdown。').repeat(400)
  const rows = []
  for (let i = 0; i < tableRows; i += 1) {
    rows.push(`    <tr class="row-${i}"><td data-idx="${i}">单元格 ${i}</td>`
      + `<td><a href="#anchor-${i}" title="链接 ${i}">链接文本 ${i}</a></td>`
      + `<td><span class="badge badge-${i % 7}">状态 ${i % 7}</span></td></tr>`)
  }
  const code = '<!doctype html>\n<html lang="zh">\n<head>\n  <meta charset="utf-8">\n'
    + '  <title>性能门用的大代码块</title>\n</head>\n<body>\n  <table id="grid">\n'
    + rows.join('\n') + '\n  </table>\n</body>\n</html>\n'
  const prose2 = ('这一段是代码块之后的收尾正文。').repeat(200)
  const body = `${prose1.slice(0, proseChars)}\n\n\`\`\`html\n${code}\n\`\`\`\n\n${prose2.slice(0, 2000)}`
  return withSentinel ? `${body}\n\n${PERF4_SENTINEL}` : body
}

const PERF4_ANSWER = buildPerf4Answer(true)
/**
 * 种子那一支答得更长(900 行表格 ≈ 230KB):要在有限的回合里把账本堆到与用户报障
 * 那条会话同量级(实测 5135 行 / 6.3MB),靠的是**每回合的字数**,不是回合数 ——
 * 回合数直接变成门的墙钟。
 */
const PERF4_SEED_ANSWER = buildPerf4Answer(false, 1200, 120_000)
/** 场景⑤的种子答案:**常规档** —— 4k 字正文 + 20 行表格的 ```html 围栏。 */
const PERF5_SEED_ANSWER = buildPerf4Answer(false, 20, 4000)

/**
 * 场景④要的那份设置。`withProvider` 决定假 provider **在不在场**。
 *
 * 为什么要能关掉:场景①②③ 是在「这台 core 上没有可用 provider」下定的基线 ——
 * 那时 `session-command.emit` 发出去的用户消息引不出任何 assistant 流。假 provider
 * 一路开着,场景③注入的那条消息就会真的跑一轮(哪怕回空),会话列表因此多刷一次
 * 401 张卡,实测稳定多出一段 >33ms 的帧,把③从 0 段拖成 1 段。
 *
 * 于是这道门把 provider 的在场时间**掐到最小**:
 *   起 core 时开着(种大会话要用)→ 种完、拉起应用**之前**关掉(经 settings RPC)
 *   → ①②③ 在无 provider 的世界里跑 → ③ 跑完再开回来 → ④。
 * API key 照旧走 `DEEPSEEK_API_KEY`(core 起动时就在 env 里),不进设置。
 */
function perf4Settings(mockPort, withProvider) {
  return {
    ai: {
      provider: 'deepseek',
      providers: withProvider
        ? {
            deepseek: {
              baseUrl: `http://127.0.0.1:${mockPort}/v1`,
              model: 'deepseek-chat',
              selectedModels: ['deepseek-chat'],
              enabled: true,
              modelCapabilitiesByModel: {
                'deepseek-chat': { tools: true, reasoning: false, vision: false },
              },
            },
          }
        : {},
      customProviders: [],
      modelCatalog: {},
    },
    tools: { enableToolCalls: true, permissionMode: 'dangerously-allow-all', tools: {} },
    chat: { contextCompactEnabled: false },
    diagnostics: { enabled: false },
  }
}

/**
 * 假 provider(OpenAI 兼容 SSE)。**不带记号的请求一律两帧收尾** —— 场景①②③
 * 与自动标题走的就是那一支,行为与「没有可用 provider」时最接近。
 *
 * 工具调用用内建的 `time`(零副作用):请求里 `role:'tool'` 的条数 < 目标数就再要一次。
 */
function startMockProvider(port, state) {
  const server = http.createServer((req, res) => {
    if (String(req.url ?? '').includes('/images/generations')) {
      req.resume()
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'perf-gate: no image api' } }))
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* 形状不对就走兜底那一支 */ }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const flat = messages
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
        .join('\n')
      const send = obj => {
        if (res.writableEnded || res.destroyed) return
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      const frame = (delta, finish = null, usage) => ({
        id: 'chatcmpl-perf4',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      })
      const measured = flat.includes(PERF4_MARKER)
      const seedingBig = flat.includes(PERF4_SEED_MARKER)
      const seedingNormal = flat.includes(PERF5_SEED_MARKER)
      const seeding = seedingBig || seedingNormal
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      if (!measured && !seeding) {
        // **不带记号的请求空手收尾**(一帧 `stop`,零正文)。场景①②③ 与自动标题都
        // 走这一支:批 A 之前这道门根本没配过 provider,那时场景③注入的用户消息
        // 引不出任何 assistant 流 —— 这一支要尽量还原那个现场。
        // 试过的两种都不行:回 'ok' 与回 401 都会给场景③凭空加一次流/一条错误块,
        // 实测各多出一段 >33ms 的帧(基线是 0 段)。
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-perf4',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'deepseek-chat',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      try {
        {
          // **本回合**已经交过几次工具结果 —— 整份历史里数会让第二回合起再也不调工具。
          const lastUser = messages.map(m => m.role).lastIndexOf('user')
          const toolTurns = messages.slice(lastUser + 1).filter(m => m.role === 'tool').length
          if (toolTurns < 2) {
            const id = `call_perf4_${toolTurns}`
            // 种子那一支的工具参数**故意很大**:一次物化的代价里,工具调用参数的
            // `JSON.parse` 是大头(用户报障那条会话 29 次工具调用 / 9MB blobs)。
            // 参数里多出来的键被 zod `strip` 掉,工具照跑 —— 但它们照样落进消息、
            // 照样在每次物化时被重新解析,那正是这一格要还原的代价。
            // 常规档的工具参数**也小**:那一档要还原的是「一条正常会话」,
            // 30k 字的参数是大会话那一支专门用来堆物化代价的。
            const args = measured || seedingNormal
              ? '{}'
              : JSON.stringify({ note: 'x'.repeat(PERF4_SEED_TOOL_ARG_CHARS) })
            send(frame({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'time', arguments: '' } }] }))
            send(frame({ tool_calls: [{ index: 0, function: { arguments: args } }] }))
            send(frame({}, 'tool_calls', { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 }))
            if (measured) state.toolCalls += 1
            // 两档种子各记各的:场景④「够大了」的判据只认它自己那一档的次数。
            else if (seedingNormal) state.seedNormalToolCalls += 1
            else state.seedToolCalls += 1
          } else {
            const answer = measured
              ? PERF4_ANSWER
              : seedingNormal
                ? PERF5_SEED_ANSWER
                : PERF4_SEED_ANSWER
            // 量的那一支节拍**故意密**(25 字 / 1ms):一条分片上的过滤代价只有比
            // 分片间隔大,才会在一条流里累出可量的滞后 —— 这正是用户报障的形状
            // (真机 2690 个分片 × 每片一次全量物化 = 49s)。
            const chunkChars = measured ? 25 : 100
            const chunkDelayMs = measured ? 1 : 2
            // 种子那一支也带真节拍:`assistant/chunks` 是**按时间**打包的,
            // 一口气吐完只会落成一两行,种不出一本厚账。
            if (measured) state.sendStartAt = Date.now()
            let n = 0
            for (let i = 0; i < answer.length; i += chunkChars) {
              if (res.destroyed) return
              send(frame({ content: answer.slice(i, i + chunkChars) }))
              n += 1
              if (chunkDelayMs) await delay(chunkDelayMs)
            }
            if (measured) {
              state.sendDoneAt = Date.now()
              state.chunks = n
            }
            send(frame({}, 'stop', { prompt_tokens: 2000, completion_tokens: 5000, total_tokens: 7000 }))
          }
        }
      } catch {
        try { send(frame({}, 'stop')) } catch { /* 连接没了就算了 */ }
      }
      if (!res.writableEnded && !res.destroyed) {
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/**
 * **node 侧的 SSE 订阅者** —— 只数字节与哨兵到达的时刻,不解析、不渲染。
 *
 * 它是场景④的判据所在:屏幕上那一头还夹着渲染层(实测同一趟里渲染主线程单段
 * 任务能到 3s),把它算进来量的就不是这一批治的东西了。这条订阅与壳那条走的是
 * **同一台 core、同一条过滤链**,所以它读到的滞后就是 core 侧的滞后。
 */
function subscribeCoreSse(record, sentinel, state) {
  const request = http.request({
    host: record.host,
    port: record.port,
    path: '/api/events',
    method: 'GET',
    headers: {
      ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
      accept: 'text/event-stream',
    },
  }, response => {
    state.status = response.statusCode
    response.setEncoding('utf-8')
    response.on('data', chunk => {
      state.bytes += chunk.length
      if (!state.sentinelAt && chunk.includes(sentinel)) state.sentinelAt = Date.now()
    })
  })
  request.on('error', error => { state.error = String(error?.message ?? error) })
  request.end()
  return () => request.destroy()
}

/**
 * 采一段进程 CPU:`ps -o time=` 给的是**累计** CPU 时间(厘秒精度),两次相减除以
 * 墙钟就是这一段的占用率。比 `ps -o %cpu`(一分钟的衰减平均)贴得住一段几秒的现场。
 */
function sampleProcessCpu(pid) {
  try {
    const raw = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf-8' }).trim()
    if (!raw) return undefined
    // 形如 `12:34.56` 或 `1-02:03:04`,统一折成秒。
    const [daysPart, clock] = raw.includes('-') ? raw.split('-') : [null, raw]
    const parts = clock.split(':').map(Number)
    let seconds = parts.pop() ?? 0
    let minutes = parts.pop() ?? 0
    let hours = parts.pop() ?? 0
    if (daysPart) hours += Number(daysPart) * 24
    return seconds + minutes * 60 + hours * 3600
  } catch {
    return undefined
  }
}

function startCpuSampler(pid, intervalMs = 300) {
  const samples = []
  let previous = { cpu: sampleProcessCpu(pid), at: Date.now() }
  const timer = setInterval(() => {
    const cpu = sampleProcessCpu(pid)
    const at = Date.now()
    if (cpu !== undefined && previous.cpu !== undefined && at > previous.at) {
      samples.push(((cpu - previous.cpu) / ((at - previous.at) / 1000)) * 100)
    }
    previous = { cpu, at }
  }, intervalMs)
  return {
    stop() {
      clearInterval(timer)
      const sorted = [...samples].sort((a, b) => a - b)
      return {
        n: sorted.length,
        median: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : -1,
        max: sorted.length ? Math.round(sorted[sorted.length - 1]) : -1,
      }
    },
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8'))
  } catch {
    return undefined
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function portConnects(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = value => {
      socket.destroy()
      resolve(value)
    }
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
    await delay(100)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

/** 用发现文件里的 token 打一条真 RPC。与其余四道门同一个助手。 */
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

/** 点一个 testid。为什么不用 page.click:理由见 gate-data.mjs 顶部那段。 */
async function clickTestId(page, testId) {
  const clicked = await page.evaluate(id => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testId)
  if (!clicked) throw new Error(`点不到:[data-testid="${testId}"] 不在 DOM 里`)
}

/* ── CDP Tracing ─────────────────────────────────────────────────────────── */

/**
 * 录一段 trace,返回 { events, save() }。
 *
 * `ReportEvents` 让 trace 事件经 `Tracing.dataCollected` 一批批推回来,
 * 不用先落到浏览器里的 stream 再读 —— 少一次搬运。
 * 分类里 `toplevel` 是关键:主线程每一段任务(RunTask)都在它里面。
 *
 * `disabled-by-default-devtools.timeline.stack`(09-03 场景⑤补)是 DevTools 面板
 * 自己录制时用的同一张分类表里的一条(见 `playwright-core` 里内置的默认分类列表),
 * 没有它,`Layout`/`Recalculate Style` 这类事件的 `args.beginData.stackTrace`
 * 永远是空的 —— 也就永远判不出「是不是脚本同步读版逼出来的」。它只多让浏览器
 * 在这几类事件上多记一段调用栈,不改变任何计时语义,所以挂在这里全局生效,
 * 不必只给场景⑤开一份专属 trace。
 */
async function recordTrace(cdp, label, body) {
  const events = []
  const onData = params => events.push(...(params.value ?? []))
  cdp.on('Tracing.dataCollected', onData)
  const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve))

  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    categories:
      'devtools.timeline,disabled-by-default-devtools.timeline,toplevel,blink.user_timing,'
      + 'disabled-by-default-devtools.timeline.stack',
    options: 'sampling-frequency=10000',
  })
  // 录制刚起来时缓冲区还没铺开,先让一拍,免得把 start 自己的抖动算进场景里。
  await delay(150)

  const result = await body()

  await cdp.send('Tracing.end')
  await complete
  cdp.off('Tracing.dataCollected', onData)

  return { label, events, result }
}

/**
 * 从 trace 里挑出**渲染主线程的 toplevel 任务时长**(毫秒)。
 *
 * 两步:先用 metadata 事件(`thread_name` = CrRendererMain)定位到那条线程,
 * 再取那条线程上 `ph: 'X'`(完整事件,带 dur)的 RunTask。
 * 定位不到主线程时**明说**并退回「全进程 toplevel」—— 不静默改口径。
 */
function mainThreadTaskDurations(events) {
  const mains = new Set()
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') {
      mains.add(`${e.pid}:${e.tid}`)
    }
  }
  const scoped = mains.size > 0
  const durations = []
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue
    if (e.name !== 'RunTask') continue
    if (scoped && !mains.has(`${e.pid}:${e.tid}`)) continue
    durations.push(e.dur / 1000)
  }
  return { durations: durations.sort((a, b) => b - a), scoped }
}

/**
 * 场景⑤的真判据(09-03 补):**强制排版次数**,不是「按下→上屏」的时间抖动。
 *
 * 时间 p95 在改前改后(154–238ms vs 154–204ms)重叠在抖动带里,拿它当红绿会闪;
 * DevTools 把这类卡顿标成「Forced reflow」的判据是确定性的:一个 `Layout`(`ph:'X'`)
 * 事件如果带着非空的 `args.beginData.stackTrace`,就说明这次排版是**脚本还压在栈上**
 * 时被同步逼出来的(布局本该等渲染管线自己排,不该被脚本插队问)——布局管线不会无中生有
 * 地产出一段调用栈,只有「脚本读了一下会导致重排的属性」才会。
 *
 * `fromTs`/`toTs` 是同一条 trace 里其它事件(比如下面的 `blink.user_timing` 标记)
 * 用的同一个时钟,直接拿来夹窗口不必换算。
 */
function forcedLayouts(events, fromTs, toTs) {
  let count = 0
  for (const e of events) {
    if (e.ph !== 'X' || e.name !== 'Layout') continue
    if (e.ts < fromTs || e.ts > toTs) continue
    const stack = e.args?.beginData?.stackTrace
    if (Array.isArray(stack) && stack.length > 0) count += 1
  }
  return count
}

/**
 * 从 `blink.user_timing` 分类里取一枚 `performance.mark(name)` 打下的 ts。
 * 找不到就是 `undefined`——调用方自己决定要不要把这当错误(场景⑤要:漏标等于
 * 窗口圈不出来,不能悄悄当 0 次强制排版放过去)。
 */
function markTs(events, name) {
  const hit = events.find(e => e.cat?.includes('user_timing') && e.name === name)
  return hit ? hit.ts : undefined
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  // sorted 是**降序**的(最长在前),所以 p95 = 从头数进去 5% 的那一条。
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - p / 100)))
  return sorted[idx]
}

function frameStats(events, overMs) {
  const { durations, scoped } = mainThreadTaskDurations(events)
  return {
    tasks: durations.length,
    scoped,
    longest: Math.round(durations[0] ?? 0),
    p95: Math.round(percentile(durations, 95)),
    over: durations.filter(d => d > overMs).length,
    overLong: durations.filter(d => d > BUDGET.longFrameMs).length,
  }
}

/** `PERF_KEEP_TRACES=1` 时每个场景都留一份 trace —— 排障时不必先把门弄红。 */
function keepTrace(label, events) {
  if (process.env.PERF_KEEP_TRACES !== '1' || !events.length) return
  console.log(`    trace 已存(PERF_KEEP_TRACES):${saveTrace(label, events)}`)
}

function saveTrace(label, events) {
  const file = path.join(tmpdir(), `onething-perf-${label}-${Date.now()}.json`)
  // DevTools 的 Performance 面板吃「事件数组」或 {traceEvents:[…]},这里给后者。
  writeFileSync(file, JSON.stringify({ traceEvents: events }), 'utf-8')
  return file
}

/**
 * 内存脚印:强制一次 GC 之后的 JS 堆 + DOM 节点数 + 监听器数。
 *
 * keep-alive 是拿内存换延迟,所以这笔账必须**印在门的输出里**,不能只写在方案里:
 * 「同组 tab 全部保持挂载」的代价就是这三个数字,改一次就能对着看一次。
 * 它只打印不断言 —— 一个绝对阈值在不同机器 / 不同种子数下没有意义。
 */
async function measureFootprint(cdp) {
  await cdp.send('HeapProfiler.enable').catch(() => {})
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {})
  await delay(400)
  const heap = await cdp.send('Runtime.getHeapUsage')
  const dom = await cdp.send('Memory.getDOMCounters')
  return {
    heapMB: heap.usedSize / 1048576,
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
  }
}

/* ── 报告 ────────────────────────────────────────────────────────────────── */

const failures = []
const report = []

function record_(scenario, stats, extra) {
  report.push({ scenario, ...stats, ...extra })
}

function assertScenario(scenario, ok, message, events) {
  if (ok) {
    console.log(`  ✓ ${message}`)
    return
  }
  console.log(`  ✗ ${message}`)
  // 有 trace 才存 —— 语义类断言(比如「滚动位置还在吗」)没有 trace 可看,
  // 存一个空文件只会让人白点开一次。
  if (events.length) {
    console.log(`    trace 已存:${saveTrace(scenario, events)}(拖进 DevTools 的 Performance 面板)`)
  }
  failures.push(`${scenario}: ${message}`)
}

/* ── 主流程 ──────────────────────────────────────────────────────────────── */

/** 一条会话账本此刻多少行。读不到 = 0(还没落第一行)。 */
function ledgerLinesOf(store, sessionId) {
  try {
    return readFileSync(path.join(store, 'sessions', sessionId, 'events.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean).length
  } catch {
    return 0
  }
}

/** 一条会话账本此刻多少字节。 */
function ledgerBytesOf(store, sessionId) {
  try {
    return readFileSync(path.join(store, 'sessions', sessionId, 'events.jsonl')).length
  } catch {
    return 0
  }
}

/**
 * 等这一回合落完账 —— 判据是**行数不再涨**,不是一个猜出来的延迟。
 * (与大会话那一段逐字同一手,场景⑤把它抽出来共用。)
 */
async function waitLedgerSettled(store, sessionId) {
  let previous = -1
  for (let i = 0; i < 200; i += 1) {
    await delay(150)
    const now = ledgerLinesOf(store, sessionId)
    if (now === previous && now > 0) return
    previous = now
  }
}

/**
 * 量一次**切会话**的「按下 → 上屏」。
 *
 * 与 `measureClickToPaint` 同一套配方(页内 `performance.now` 夹双 rAF),差别只在
 * 「上屏了没有」的判据:切会话时 `chat-stream` 本来就在,所以不能拿它当出现判据,
 * 要等**这条会话自己的记号**出现在聊天区最上面那几个节点里。
 * (只看前 3 个孩子,不读整棵树的 `textContent` —— 后者会把量具自己变成负载。)
 *
 * `index` 是这是第几次切换(09-03 补):`performance.mark` 打下
 * `perf5:switch:<index>:start`/`:end` 两枚记号,圈出这一次切换在 trace 时间轴上的
 * 窗口 —— `forcedLayouts` 拿这个窗口去数强制排版,不能只看「按下→上屏」这一个数。
 */
async function measureSessionSwitch(page, sessionId, marker, index) {
  // **点瓦是开关**(同 `enterSession` 的判词):先问事实再决定点不点,最多两下。
  await ensureOverviewRow(page, sessionId)
  return page.evaluate(
    async ({ id, mark, i }) => {
      const el = document.querySelector(`[data-testid="session-row-${id}"]`)
      if (!el) throw new Error(`点不到卡:${id}`)
      performance.mark(`perf5:switch:${i}:start`)
      const started = performance.now()
      el.click()
      const landed = () => {
        const stream = document.querySelector('[data-testid="chat-stream"]')
        if (!stream) return false
        return [...stream.children].slice(0, 3).some(k => (k.textContent ?? '').includes(mark))
      }
      await new Promise((resolve, reject) => {
        const deadline = performance.now() + 60_000
        const tick = () => {
          if (landed()) resolve()
          else if (performance.now() > deadline) reject(new Error(`切到 ${mark} 超时`))
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      performance.mark(`perf5:switch:${i}:end`)
      return Math.round(performance.now() - started)
    },
    { id: sessionId, mark: marker, i: index },
  )
}

/**
 * **量一下「二合一 / 拆开」这一下**(场景⑤b,W6-p 重写)。
 *
 * 走的是用户真走的那条路:叶的动作组 → 那张菜单里的一项(`LeafActions`),
 * 落定动作与拖拽那条路共用同一只(`drop-commit.pairIntoIndex` / `store.unpairAt`)。
 * 开菜单那一下**不在窗口里**:量的是「这一下改了树之后屏幕要花多少」,
 * 不是「一张菜单画多久」。
 *
 * 三项按**是否可用**挑,不按下标猜:二合一那两项各有各的前提
 * (`canPairRight` 要右边还有一格),而拆开只在活动那格是两格标签时可用。
 */
async function measurePairSplit(page, kind, index) {
  const opened = await page.evaluate(() => {
    /*
     * **右键那一格活动标签**(W7-c 裁定 2:「分屏」那颗钮删了,这张表只剩右键与
     * `Shift+F10` 两个开口)。点名**顶栏那条条**上的那一格,不是「屏幕上第一格」:
     * 中央区的标签坐在窗口顶栏里(W1-b),而浮窗 / 架子里的叶各有各的一条 ——
     * 拿第一格会随屏幕上还开着什么变。
     */
    const tabs = Array.from(
      document.querySelectorAll('[data-testid="topbar-tabs"] [role="tablist"] [role="tab"]'),
    )
    const active = tabs.find(el => el.getAttribute('aria-selected') === 'true') ?? tabs[0]
    if (!(active instanceof HTMLElement)) return false
    const box = active.getBoundingClientRect()
    active.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(box.left + box.width / 2),
        clientY: Math.round(box.top + box.height / 2),
      }),
    )
    return true
  })
  if (!opened) throw new Error('顶栏上没有中央那片叶的标签 —— ⑤b 的现场没搭起来')
  await delay(200)
  const ms = await page.evaluate(
    async ({ k, i }) => {
      // 角色两种都收:`ui/Menu` 传了 `checked` 的那些项是 `menuitemradio`。
      const items = Array.from(document.querySelectorAll('[role="menuitem"],[role="menuitemradio"]'))
      const pick = (re) =>
        items.find(el => re.test(el.textContent ?? '') && !el.hasAttribute('disabled'))
      const target = k === 'pair'
        ? (pick(/与右边的标签二合一|Join with the tab on the right/)
          ?? pick(/与左边的标签二合一|Join with the tab on the left/))
        : pick(/拆开|Split apart/)
      if (!(target instanceof HTMLElement)) return null
      performance.mark(`perf5b:pair:${i}:start`)
      const started = performance.now()
      target.click()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      performance.mark(`perf5b:pair:${i}:end`)
      return Math.round(performance.now() - started)
    },
    { k: kind, i: index },
  )
  if (ms === null) {
    // 菜单开着就走人会把下一趟一起毁掉 —— Esc 收干净再把这一趟报成红。
    await page.keyboard.press('Escape').catch(() => undefined)
    throw new Error(`菜单里没有可用的「${kind === 'pair' ? '二合一' : '拆开'}」—— ⑤b 的现场塌了`)
  }
  return ms
}

/**
 * **一整趟条内换序**(W6-b,场景⑤c):按下 → 12 发 `pointermove` → 松手 → 稳定。
 *
 * 整段跑在**页内**而不是从 node 侧派 CDP 鼠标:这一格量的是「跟手一趟花了多少」,
 * 而 CDP 每一发的往返(1–3ms)会直接加进读数里,把要量的东西淹掉。产品那一头
 * 收的是 `pointerdown` / `pointermove` / `pointerup` 三种真事件,页内派出来的与
 * 输入管线合成的在它眼里是同一种(它不读 `isTrusted`)。
 *
 * 每一发 move 各让出一帧(`requestAnimationFrame`)—— 不让的话 12 发会被合成一个
 * 任务,量出来的是「一次批处理」而不是「跟手 12 帧」。
 */
async function measureTabReorder(page, index) {
  return page.evaluate(async (i) => {
    const list = Array.from(document.querySelectorAll('[role="tablist"]')).find(
      (el) => el.querySelectorAll('[data-tab-id]').length >= 2,
    )
    if (!list) throw new Error('屏幕上没有一条至少两格的标签条 —— ⑤c 的现场没搭起来')
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'))
    /*
     * **拖的永远是「此刻活动的那一格」**(09-05 A/B 当场量出来的一条量法修正)。
     *
     * 第一版按奇偶轮流拖第一格 / 末格,读数是 `343 190 508 246 …` ——一半的趟数
     * 贵一倍。真因不是拖拽:W6-b 起**按下即激活**(设计 §4.2 第一行),而这个夹具里
     * 两格标签是**两条会话**,于是「按下另一格」= 一次整份内容换人 —— 那正是场景⑤a
     * 单独在量的东西(179–376ms),它把 ⑤c 要量的「跟手贵不贵」整个淹掉了。
     * (main 上没有这一项开销:那一版按下不激活,而这道门只派 pointer 三件套、
     * 不派 click。所以第一版的 A/B 是在比两件不同的事。)
     *
     * 拖活动那一格之后 `select()` 是幂等的,读数里就只剩这一批交付的那条链:
     * 12 帧 `transform` + 一次 `moveTab` + 收笔那一段 FLIP。它也正是真人最常做的
     * 那一下 —— 拖的是自己正在看的那一格。
     */
    const activeAt = Math.max(0, tabs.findIndex((el) => el.getAttribute('aria-selected') === 'true'))
    const orderBefore = tabs.map((el) => el.getAttribute('data-tab-id')).join('|')
    const from = tabs[activeAt]
    const to = activeAt === 0 ? tabs[tabs.length - 1] : tabs[0]
    const a = from.getBoundingClientRect()
    const b = to.getBoundingClientRect()
    const y = a.top + a.height / 2
    const x0 = a.left + a.width / 2
    const x1 = b.left + b.width / 2
    const fire = (target, type, x, buttons) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          pointerId: 1, pointerType: 'mouse', isPrimary: true,
          button: 0, buttons, clientX: Math.round(x), clientY: Math.round(y),
        }),
      )
    performance.mark(`perf5c:reorder:${i}:start`)
    const started = performance.now()
    fire(from, 'pointerdown', x0, 1)
    const steps = 12
    for (let s = 1; s <= steps; s += 1) {
      fire(window, 'pointermove', x0 + ((x1 - x0) * s) / steps, 1)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    /*
     * **松手那一刻单独打一枚记号**(W6-p)。一趟的时长里有两段完全不同的东西:
     * 12 发 move 各让一帧(那一段的下限是屏幕自己的刷新率,与产品无关)与
     * 松手之后那一段(落定 + 收笔)。归因时要能把它们分开读,否则「一趟 450ms」
     * 这句话说不出钱花在哪 —— W6-b 留账的那 ~230ms 正是后半段。
     */
    performance.mark(`perf5c:reorder:${i}:up`)
    const upAt = performance.now()
    fire(window, 'pointerup', x1, 0)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    performance.mark(`perf5c:reorder:${i}:end`)
    /*
     * 顺带答一句「**序真的换了吗**」——一个从不真换序的读数再快也不算数
     * (09-05 的 A/B 当场用上了这一句:main 上 20 趟只有 1 趟真换了序,
     * 它的「快」是因为什么都没做)。
     * 比的是**那串 id**,不是节点身份:React 换序时复用同一批节点,拿 `indexOf`
     * 去问「它挪了没有」在节点被复用时答得对、被重建时答得反,是个会骗人的量具。
     */
    const orderAfter = Array.from(list.querySelectorAll('[role="tab"]'))
      .map((el) => el.getAttribute('data-tab-id'))
      .join('|')
    return {
      ms: Math.round(performance.now() - started),
      /** 松手之后那一段(落定 + 收笔)—— 这一格才是产品代码说了算的那一半。 */
      tail: Math.round(performance.now() - upAt),
      moved: orderAfter !== orderBefore,
    }
  }, index)
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[perf-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[perf-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'perf-gate-store-'))
  // **上一批的教训**:调试实例绝不共享默认 userData。每跑一次一个新目录。
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'perf-gate-userdata-'))
  let server
  let app
  let mock
  let mockPort
  let bigSessionId
  /** 场景⑤的三条常规档会话与它们各自的正文记号。 */
  const normalIds = []
  const normalMarks = []
  const mockState = {
    sendStartAt: 0, sendDoneAt: 0, chunks: 0, toolCalls: 0, seedToolCalls: 0, seedNormalToolCalls: 0,
  }
  try {
    console.log(`\n[1/8] 起一台 core,种 ${SEED_SESSIONS} 条会话 + 一条大会话`)
    // 假 provider 必须先于 core 起来:设置在 core 启动时读一次。
    mockPort = 44100 + Math.floor(Math.random() * 400)
    mock = await startMockProvider(mockPort, mockState)
    writeFileSync(
      path.join(store, 'settings.json'),
      JSON.stringify(perf4Settings(mockPort, true), null, 2),
      'utf-8',
    )
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store, DEEPSEEK_API_KEY: 'sk-perf-gate' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', chunk => serverErr.push(chunk.toString()))

    const rec = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch(error => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    if (!(await portConnects(rec.host, rec.port))) throw new Error('core 端口连不上')

    const created = []
    for (let i = 0; i < SEED_SESSIONS; i += 1) {
      const result = await rpc(rec, 'sessions', 'create', { name: `perf-${String(i).padStart(3, '0')}` })
      const id = result?.session?.id
      if (!id) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(result)}`)
      created.push(id)
    }
    console.log(`  ✓ 种了 ${created.length} 条会话`)

    /*
     * ── 场景⑤的种子:3 条**常规档**会话 ────────────────────────────────
     * 排在大会话**之前**:两档共用同一台 mock,记号不同(见 PERF5_SEED_MARKER),
     * 而大会话「够不够大」的判据只数它自己那一档的工具调用,先后不互相干扰。
     */
    for (let i = 0; i < PERF5_SESSIONS; i += 1) {
      const id = (await rpc(rec, 'sessions', 'create', { name: `perf-normal-${i}` }))?.session?.id
      if (!id) throw new Error('常规档会话没建出来')
      normalIds.push(id)
      // 记号进**用户消息正文**,所以它一定落在聊天区最上面那几个节点里
      // —— 场景⑤的「上屏了没有」判的就是它(与 probe 的判据逐字相同)。
      normalMarks.push(`PERF5SESS-${id.slice(0, 6)}`)
      for (let turn = 0; turn < PERF5_TURNS; turn += 1) {
        await rpc(rec, 'session-command', 'emit', {
          sessionId: id,
          command: {
            type: 'command:send-message',
            content: `${PERF5_SEED_MARKER} PERF5SESS-${id.slice(0, 6)} 第 ${turn + 1} 回合`,
          },
        })
        await waitLedgerSettled(store, id)
      }
      const bytes = ledgerBytesOf(store, id)
      console.log(`  · 常规档 ${i}:账本 ${(bytes / 1024).toFixed(0)}KB`)
    }
    console.log(`  ✓ 种了 ${normalIds.length} 条常规档会话(工具调用 ${mockState.seedNormalToolCalls} 次)`)

    // ── 种那条大会话。**在拉起应用之前**:此刻这台 core 上没有任何 SSE 订阅者,
    // 所以种的过程不受订阅侧过滤影响 —— 反证跑的时候种子也不会跟着慢下来。
    bigSessionId = (await rpc(rec, 'sessions', 'create', { name: 'perf-big' }))?.session?.id
    if (!bigSessionId) throw new Error('大会话没建出来')
    const ledgerPath = path.join(store, 'sessions', bigSessionId, 'events.jsonl')
    const ledgerSize = () => {
      try {
        return readFileSync(ledgerPath, 'utf-8').split('\n').filter(Boolean).length
      } catch {
        return 0
      }
    }
    const ledgerBytes = () => {
      try {
        return readFileSync(ledgerPath).length
      } catch {
        return 0
      }
    }
    let turns = 0
    while (turns < PERF4_SEED_MAX_TURNS) {
      await rpc(rec, 'session-command', 'emit', {
        sessionId: bigSessionId,
        command: { type: 'command:send-message', content: `${PERF4_SEED_MARKER} 第 ${turns + 1} 回合` },
      })
      // 落账是异步的:等这一回合的账本行数不再涨,再进下一回合。
      let previous = -1
      for (let i = 0; i < 200; i += 1) {
        await delay(150)
        const now = ledgerSize()
        if (now === previous && now > 0) break
        previous = now
      }
      turns += 1
      if (ledgerBytes() >= PERF4_MIN_LEDGER_BYTES
        && mockState.seedToolCalls >= PERF4_MIN_TOOL_CALLS) break
    }
    const seededLines = ledgerSize()
    const seededBytes = ledgerBytes()
    console.log(
      `  ✓ 大会话种好:${turns} 回合,账本 ${seededLines} 行 / ${(seededBytes / 1048576).toFixed(1)}MB,`
        + `工具调用 ${mockState.seedToolCalls} 次`,
    )
    if (seededBytes < PERF4_MIN_LEDGER_BYTES || mockState.seedToolCalls < PERF4_MIN_TOOL_CALLS) {
      throw new Error(
        `场景④的现场没搭起来:账本 ${(seededBytes / 1048576).toFixed(1)}MB`
          + `(要 ≥${(PERF4_MIN_LEDGER_BYTES / 1048576).toFixed(0)}MB)、`
          + `工具调用 ${mockState.seedToolCalls} 次(要 ≥${PERF4_MIN_TOOL_CALLS})`,
      )
    }

    // 种完就把假 provider 摘掉:①②③ 的基线是「没有可用 provider」(见
    // `perf4Settings` 的注释)。走的是设置页自己那条 RPC,不是改盘 —— 设置有
    // 进程内缓存,改盘那份进不了活着的 core。
    await rpc(rec, 'settings', 'saveSettings', perf4Settings(mockPort, false))
    console.log('  ✓ 假 provider 已摘(场景①②③ 在无 provider 下跑)')

    console.log('\n[2/8] 拉起应用(独立 --user-data-dir),等它连上同一台 core')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
        /*
         * **窗子离屏起**(09-04 S4,纪律「真机门不许抢用户的机器」)。不 show()、
         * 不进 Dock;页面照样渲染、照样跑布局与 rAF。焦点由下面那一句 CDP
         * `Emulation.setFocusEmulationEnabled` 补 —— 判词与一致性证据写在
         * `electron/main.ts` 的 `ONETHING_GATE_HEADLESS` 那一段上。
         */
        ONETHING_GATE_HEADLESS: '1',
      },
    })
    const page = await app.firstWindow()
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    const cdp = await app.context().newCDPSession(page)
    // 离屏窗要自己补「我有焦点」(见上面那段 env 的判词)。
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    console.log('  ✓ 连上了,CDP 会话已开(窗子离屏,焦点由 CDP 模拟)')

    // 三个排障口在**打包后的真应用**里也得在。单元测试只能证 jsdom 里装得上,
    // 证不了它们活过了构建与 Electron 的加载 —— 那正是「dump 不出来」最常发生的地方。
    const hooks = await page.evaluate(() => ({
      log: typeof window.__log?.dump === 'function',
      crash: typeof window.__crash?.dump === 'function',
      perf: typeof window.__perf?.dump === 'function',
    }))
    for (const [name, present] of Object.entries(hooks)) {
      if (!present) throw new Error(`window.__${name}.dump() 在真应用里不在 —— 排障口断了`)
    }
    console.log('  ✓ window.__log / __crash / __perf 三个 dump 口都在')

    /* ── 场景 ①:冷开会话总览 ─────────────────────────────────────────── */
    console.log(`\n[3/8] 场景① 冷开会话总览(${SEED_SESSIONS} 条会话)`)
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    // 数据先到位再计时:这一格量的是**画**的开销,不是等网络的开销。
    await waitFor('会话数据到达渲染层', () =>
      page.evaluate(async () => {
        const probe = window.__d0
        return probe && probe.rpcOk ? true : undefined
      }),
    )

    const cold = await recordTrace(cdp, 'cold-sessions', async () => {
      const measured = await measureClickToPaint(page, 'dock-tile-sessions', '[data-session-id]')
      // 让渲染跑完最后一拍再停录,免得把收尾那几帧切在录制窗口外面。
      await delay(400)
      return measured
    })
    const coldStats = frameStats(cold.events, BUDGET.longFrameMs)
    console.log(
      `  · 画出 ${cold.result.cards} 张卡,点击→上屏 ${cold.result.ms}ms;`
        + ` 主线程任务 ${coldStats.tasks} 段,最长 ${coldStats.longest}ms,p95 ${coldStats.p95}ms,`
        + ` >${BUDGET.longFrameMs}ms 的 ${coldStats.overLong} 段`,
    )
    record_('①冷开会话总览', coldStats, { ms: cold.result.ms, cards: cold.result.cards })
    assertScenario(
      'cold-sessions',
      cold.result.ms <= BUDGET.coldOpenMs,
      `点击→上屏 ${cold.result.ms}ms ≤ 冷开预算 ${BUDGET.coldOpenMs}ms`,
      cold.events,
    )
    assertScenario(
      'cold-sessions',
      coldStats.overLong <= BUDGET.animationLongFrames,
      `期间 >${BUDGET.longFrameMs}ms 的长帧 ${coldStats.overLong} 段 ≤ ${BUDGET.animationLongFrames}`,
      cold.events,
    )
    if (cold.result.ms > BUDGET.coldOpenMs || coldStats.overLong > BUDGET.animationLongFrames) {
      console.log(
        '    ↑ 这一格 08-30 起红了很久,W6-p 归因之后修掉了,所以再红就是**回归**,不再是存量:\n'
          + '      真因不是「400 张卡画得慢」,是 `focus/registry` 的 `activate()` 在同一次提交里\n'
          + '      `focus()` 那棵刚插好的树 —— `focus()` 要一份干净的排版,当场逼出一次整棵子树的\n'
          + '      排版(trace:那一段 56.4ms 里 React 自己 26ms、`Layout n=19` 28.1ms)。\n'
          + '      修法是 `SessionRow.module.css` 那两行 `content-visibility: auto`(判词写在那里,\n'
          + '      含「行自己的 outline 不会被自己的 paint containment 剪掉」的截图反证)。',
      )
    }

    /* ── 场景 ⑤:常规档 ↔ 常规档 切会话 ×8 ────────────────────────────────
     * 排在②之前是刻意的:②要先把默认打开档改成「钉栏」并重载,而这一格量的是
     * **默认档(舞台)下从总览点一张卡进会话**——那正是用户报障时的手势。
     */
    console.log(`\n[4/8] 场景⑤ 常规档 ↔ 常规档 切会话 ×${PERF5_SWITCHES}`)
    // 先进头一条(起底那一次不计时:它带着首开的一次性开销)。
    await enterSession(page, normalIds[0])
    await delay(1500)
    const switchRun = await recordTrace(cdp, 'session-switch', async () => {
      const each = []
      for (let i = 1; i <= PERF5_SWITCHES; i += 1) {
        const k = i % normalIds.length
        each.push(await measureSessionSwitch(page, normalIds[k], normalMarks[k], i))
        // 两次之间留一拍,免得连点被合并成一个任务(那就量不出单次代价了)。
        await delay(500)
      }
      return { each }
    })
    keepTrace('session-switch', switchRun.events)
    const switchEach = switchRun.result.each
    const switchSorted = [...switchEach].sort((a, b) => a - b)
    const sessionSwitchP95 =
      switchSorted[Math.min(switchSorted.length - 1, Math.ceil(switchSorted.length * 0.95) - 1)]
    const sessionSwitchStats = frameStats(switchRun.events, BUDGET.longFrameMs)
    console.log(
      `  · 每次切会话 按下→上屏(ms):${switchEach.join(' ')}`
        + `\n  · p95 ${sessionSwitchP95}ms,最慢 ${switchSorted[switchSorted.length - 1]}ms,`
        + `最快 ${switchSorted[0]}ms;主线程任务 ${sessionSwitchStats.tasks} 段,`
        + `最长 ${sessionSwitchStats.longest}ms`,
    )
    record_('⑤常规档切会话 ×8', sessionSwitchStats, { ms: sessionSwitchP95 })
    assertScenario(
      'session-switch',
      sessionSwitchP95 <= BUDGET.sessionSwitchMs,
      `切会话 按下→上屏 p95 ${sessionSwitchP95}ms ≤ 预算 ${BUDGET.sessionSwitchMs}ms`,
      switchRun.events,
    )

    /*
     * 真判据(09-03 补):强制排版次数,每次切换各圈自己的窗口(靠上面打下的
     * `perf5:switch:<i>:start`/`:end` 两枚 `performance.mark`),取 8 次里的最大值。
     * 时间 p95 仍然断言(上面那条),但红绿判据是这一条 —— 理由见 `forcedLayouts` 注释。
     */
    const forcedPerSwitch = []
    for (let i = 1; i <= PERF5_SWITCHES; i += 1) {
      const from = markTs(switchRun.events, `perf5:switch:${i}:start`)
      const to = markTs(switchRun.events, `perf5:switch:${i}:end`)
      if (from === undefined || to === undefined) {
        throw new Error(`第 ${i} 次切会话的 performance.mark 没落进 trace —— 量具本身坏了`)
      }
      forcedPerSwitch.push(forcedLayouts(switchRun.events, from, to))
    }
    const maxForcedLayouts = Math.max(...forcedPerSwitch)
    console.log(`  · 每次切会话的强制排版次数:${forcedPerSwitch.join(' ')}(最大 ${maxForcedLayouts})`)
    record_('⑤a 同叶换 ref ×8·强制排版', sessionSwitchStats, { ms: maxForcedLayouts })
    assertScenario(
      'session-switch',
      maxForcedLayouts <= BUDGET.sessionSwitchForcedLayouts,
      `切会话强制排版 最大 ${maxForcedLayouts} 次 ≤ 预算 ${BUDGET.sessionSwitchForcedLayouts} 次`,
      switchRun.events,
    )

    /* ── 场景 ⑤b:**二合一 / 拆开 ×10**(W6-p 重写)────────────────────────
     *
     * 这一格从前量的是「两片会话叶并排,切焦点叶」(W5-b 裁定 9)。**那个现场在
     * v3 里不存在了**:中央区收成一条标签条(W6-a),「在右侧」在 W6-b 之后改判成
     * 二合一 —— 于是它的夹具在结构上再也搭不起来,门每趟都红在「中央区真成两片叶」
     * 那一句上。夹具跟不上产品是**夹具的账**,不是产品回归。
     *
     * 换成量今天真有的那一下:**二合一 / 拆开**(设计 §7)。它与 ⑤a / ⑤c 的分工
     * 仍旧是三种不同的「改了什么」:
     *  · ⑤a = **同叶换 ref**:那片叶的内容整份换人(折叠、装配、排版全要重来);
     *  · ⑤b = **改标签的身份**:两格普通标签并成一格 pair、再拆回来。按设计
     *    §11 拍点 8,这一下**一格内容都不许重挂** —— 内容层按内容分格,改的只有
     *    画法那一半。所以它理应几乎不花钱,而「理应」正是要量的东西:哪天内容层
     *    跟着标签的身份走,这一格会当场跳进百毫秒(聊天区重跑一次进场、
     *    查看器丢掉滚动位)。
     *  · ⑤c = **什么都没改**(条内换序,树到落定那一刻才动)。
     *
     * 判据两条,与 ⑤a/⑤c 同形:强制排版次数是红绿主判据(整数、不抖),
     * 时间 p95 一起断言当参考;另加一条「零长帧」——这一下屏幕上换的是同一块地方
     * 的画法,不该出现 50ms 以上的任务。
     */
    console.log(`\n[4b/8] 场景⑤b 二合一 / 拆开 ×${PERF5B_ACTIONS}`)
    /*
     * 夹具搭不起来 = **红**,不是跳过(与 `boundary:gate` 那两条反脚枪守卫同源)。
     * 两格标签才有得并,所以先确保这条条上有两格 —— `ensureSecondTab` 是幂等的,
     * ⑤c 随后再叫一次也不会叠出第三格。
     */
    const pairReady = await ensureSecondTab(page, normalIds)
    assertScenario('pair-split', pairReady, '中央那条条上有两格标签(⑤b 的夹具)', [])
    if (pairReady) {
      const pairRun = await recordTrace(cdp, 'pair-split', async () => {
        const each = []
        for (let i = 1; i <= PERF5B_ACTIONS; i += 1) {
          // 奇数并、偶数拆 —— 一趟结束时条上又是两格,与开工时逐字相同。
          each.push(await measurePairSplit(page, i % 2 === 1 ? 'pair' : 'split', i))
          await delay(400)
        }
        return { each }
      })
      keepTrace('pair-split', pairRun.events)
      const pairEach = pairRun.result.each
      const pairSorted = [...pairEach].sort((a, b) => a - b)
      const pairP95 =
        pairSorted[Math.min(pairSorted.length - 1, Math.ceil(pairSorted.length * 0.95) - 1)]
      const pairStats = frameStats(pairRun.events, BUDGET.longFrameMs)
      const forcedPerPair = []
      for (let i = 1; i <= PERF5B_ACTIONS; i += 1) {
        const from = markTs(pairRun.events, `perf5b:pair:${i}:start`)
        const to = markTs(pairRun.events, `perf5b:pair:${i}:end`)
        if (from === undefined || to === undefined) {
          throw new Error(`第 ${i} 下二合一/拆开的 performance.mark 没落进 trace —— 量具本身坏了`)
        }
        forcedPerPair.push(forcedLayouts(pairRun.events, from, to))
      }
      const maxPairForced = Math.max(...forcedPerPair)
      const pairOverLong = pairStats.overLong
      console.log(
        `  · 每下 二合一/拆开 点下→稳定(ms):${pairEach.join(' ')}`
          + `\n  · p95 ${pairP95}ms,最慢 ${pairSorted[pairSorted.length - 1]}ms,`
          + `最快 ${pairSorted[0]}ms`
          + `\n  · 强制排版:${forcedPerPair.join(' ')}(最大 ${maxPairForced});`
          + `主线程任务 ${pairStats.tasks} 段,最长 ${pairStats.longest}ms,`
          + `>${BUDGET.longFrameMs}ms 的 ${pairOverLong} 段`,
      )
      record_(`⑤b 二合一/拆开 ×${PERF5B_ACTIONS}`, pairStats, { ms: pairP95 })
      record_(`⑤b 二合一/拆开 ×${PERF5B_ACTIONS}·强制排版`, pairStats, { ms: maxPairForced })
      assertScenario(
        'pair-split',
        pairP95 <= BUDGET.tabPairSplitMs,
        `二合一/拆开 点下→稳定 p95 ${pairP95}ms ≤ 预算 ${BUDGET.tabPairSplitMs}ms`,
        pairRun.events,
      )
      assertScenario(
        'pair-split',
        maxPairForced <= BUDGET.tabPairSplitForcedLayouts,
        `二合一/拆开强制排版 最大 ${maxPairForced} 次 ≤ 预算 ${BUDGET.tabPairSplitForcedLayouts} 次`,
        pairRun.events,
      )
      /*
       * **这一格没有「零长帧」那条断言**,理由写在 `perf-budget.tabPairSplitMs` 上:
       * 一下二合一把那格地变窄了一半,一条 437KB 的会话按半幅重新折行本身就是
       * 150ms 级的排版 —— 「零长帧」在这里是一条永远红的假线。换成断言**最长任务**
       * (与 ⑤a 第三条同形):它接得住「一下变成两下」这种真回归,又不假装那次
       * 正当的重排不存在。长帧段数照旧打印。
       */
      assertScenario(
        'pair-split',
        pairStats.longest <= BUDGET.tabPairSplitMs,
        `二合一/拆开 最长主线程任务 ${pairStats.longest}ms ≤ 预算 ${BUDGET.tabPairSplitMs}ms`
          + `(期间 >${BUDGET.longFrameMs}ms 的长帧 ${pairOverLong} 段 —— 见预算表判词)`,
        pairRun.events,
      )
    }

    /* ── 场景 ⑤c:条内换序 ×20(W6-b)────────────────────────────────────
     *
     * ⑤a 量的是「那片叶的内容整份换人」、⑤b 量的是「焦点叶换人」,两者都**改了
     * 屏幕上装着什么**。⑤c 是第三种:**什么都没改** —— 换序期间树是冻住的
     * (`store.dragging` 那道闸),动的只有一格 `transform`。所以它是这三格里唯一
     * 能把「跟手贵不贵」单独量出来的那一格:读数一旦长起来,长的必定是**每帧那条
     * 链**(接回 React / 读活矩形 / 每帧重建空位),而不是内容装配。
     *
     * 判据与 ⑤a/⑤b 同形:强制排版次数是红绿主判据(整数、不抖),时间 p95 一起
     * 断言当参考。
     */
    console.log(`\n[4c/8] 场景⑤c 条内换序 ×${PERF5C_REORDERS}`)
    /*
     * **⑤c 自己确认自己的夹具,不借 ⑤b 留下的**(09-05 A/B 当场量出来的一条):
     * 从前它靠「⑤b 开出来的第二片叶恰好在同一条条上多出一格」白拿两格标签,
     * 而那是 W6-a 那句止血(中央区四带退成一格标签)的副产品 —— W6-b 把「在右侧」
     * 改判成二合一之后,两条会话并成**一格** `pair`,条上只剩一格,⑤c 当场没有对象。
     * 借来的前置状态会随任何一个前置场景的改动一起塌(gate:drag 也踩过同一条)。
     * `ensureSecondTab` 是**幂等**的:⑤b 已经开好了它就一个字都不动,没开好它自己
     * 走「在下方打开」那条路开一格 —— 两个场景于是各自成立,谁先谁后都量得对。
     */
    const reorderReady = await ensureSecondTab(page, normalIds)
    assertScenario(
      'tab-reorder',
      reorderReady,
      '屏幕上有一条至少两格的标签条(⑤c 的夹具)',
      [],
    )
    if (reorderReady) {
      const reorderRun = await recordTrace(cdp, 'tab-reorder', async () => {
        const each = []
        const tail = []
        const moved = []
        for (let i = 1; i <= PERF5C_REORDERS; i += 1) {
          const row = await measureTabReorder(page, i)
          each.push(row.ms)
          tail.push(row.tail)
          moved.push(row.moved)
          // 每趟之间留一拍,让收笔那 150ms 的 FLIP 跑完再开下一趟。
          await delay(220)
        }
        return { each, tail, moved }
      })
      keepTrace('tab-reorder', reorderRun.events)
      const reorderEach = reorderRun.result.each
      /*
       * **「序真的换了吗」在这里只打印,不当红绿**(09-05 A/B 之后的裁定)。
       *
       * 这一格的判据产地是 `gate:drag` 场景③ —— 那里在一条三格的真条上从三个方向
       * 各拖一次,逐条断言次序与活动位。这道门的夹具是「两格会话标签」,而两格那一形
       * 上「拖到另一头」会落进 `reorderTab` 的「原地不动」闸(`at === from + 1`),
       * 所以这一句在**两边都读作 1/20**:它量不出两个版本的差别,当红绿线只会把
       * 一件与本场景无关的事变成噪声。
       *
       * 留着打印是因为它仍旧是**读数的上下文**:没有它,「main 更快」这句话会被
       * 读成手感退步,而事实是那 20 趟里两边都几乎没有真的换序发生 ——
       * 时间与强制排版的对照必须带着这一行一起读。
       */
      const reorderMoved = reorderRun.result.moved.filter(Boolean).length
      const reorderSorted = [...reorderEach].sort((a, b) => a - b)
      const reorderP95 =
        reorderSorted[Math.min(reorderSorted.length - 1, Math.ceil(reorderSorted.length * 0.95) - 1)]
      const reorderStats = frameStats(reorderRun.events, BUDGET.longFrameMs)
      const forcedPerReorder = []
      for (let i = 1; i <= PERF5C_REORDERS; i += 1) {
        const from = markTs(reorderRun.events, `perf5c:reorder:${i}:start`)
        const to = markTs(reorderRun.events, `perf5c:reorder:${i}:end`)
        if (from === undefined || to === undefined) {
          throw new Error(`第 ${i} 趟换序的 performance.mark 没落进 trace —— 量具本身坏了`)
        }
        forcedPerReorder.push(forcedLayouts(reorderRun.events, from, to))
      }
      const maxReorderForced = Math.max(...forcedPerReorder)
      const reorderTail = reorderRun.result.tail
      const tailSorted = [...reorderTail].sort((a, b) => a - b)
      const tailP95 =
        tailSorted[Math.min(tailSorted.length - 1, Math.ceil(tailSorted.length * 0.95) - 1)]
      console.log(
        `  · 序真的换了的趟数:${reorderMoved}/${PERF5C_REORDERS}`
          + `(判据产地是 gate:drag 场景③,这里只作读数的上下文)`
          + `\n  · 每趟换序 按下→稳定(ms):${reorderEach.join(' ')}`
          + `\n  · p95 ${reorderP95}ms,最慢 ${reorderSorted[reorderSorted.length - 1]}ms,`
          + `最快 ${reorderSorted[0]}ms`
          + `\n  · 其中**松手→稳定**(ms):${reorderTail.join(' ')};p95 ${tailP95}ms`
          + `\n  · 强制排版:${forcedPerReorder.join(' ')}(最大 ${maxReorderForced});`
          + `主线程任务 ${reorderStats.tasks} 段,最长 ${reorderStats.longest}ms`,
      )
      record_(`⑤c 条内换序 ×${PERF5C_REORDERS}`, reorderStats, { ms: reorderP95 })
      record_(`⑤c 条内换序 ×${PERF5C_REORDERS}·强制排版`, reorderStats, { ms: maxReorderForced })
      assertScenario(
        'tab-reorder',
        reorderP95 <= BUDGET.tabReorderMs,
        `换序一趟 按下→稳定 p95 ${reorderP95}ms ≤ 预算 ${BUDGET.tabReorderMs}ms`,
        reorderRun.events,
      )
      assertScenario(
        'tab-reorder',
        tailP95 <= BUDGET.tabReorderTailMs,
        `换序 松手→稳定 p95 ${tailP95}ms ≤ 预算 ${BUDGET.tabReorderTailMs}ms`
          + `(这一段才是产品说了算的那一半 —— 判词在 perf-budget.tabReorderTailMs)`,
        reorderRun.events,
      )
      assertScenario(
        'tab-reorder',
        maxReorderForced <= BUDGET.tabReorderForcedLayouts,
        `换序强制排版 最大 ${maxReorderForced} 次 ≤ 预算 ${BUDGET.tabReorderForcedLayouts} 次`,
        reorderRun.events,
      )
    }

    /* ── 场景②③ 共用的现场:钉栏默认档 + 进一条会话 ─────────────────── */
    console.log('\n[5/8] 切成「钉栏」默认档并进一条会话(场景②③ 共用这个现场)')
    await switchDefaultOpenToPinned(page)
    const targetId = created[0]
    await enterSession(page, targetId)
    console.log('  ✓ 已进入会话,聊天区起底完成')

    /* ── 场景 ②:架子 tab 连续切换 ×10 ────────────────────────────────── */
    console.log(`\n[6/8] 场景② 右架子 tab 连续切换 ×10(真实负载:${SHELF_PANELS.join(' / ')} 同组)`)
    const pinned = await pinPanels(page, SHELF_PANELS)
    console.log(`  · 右架子 tab 次序:${pinned.join(' / ') || '(空)'}`)
    // 现场对不上就红,不降级成「没量到」:场景②的全部意义是**重面板**在这条架子上。
    for (const id of SHELF_PANELS) {
      if (!pinned.includes(id)) {
        throw new Error(`「${id}」没钉进右架子(实际:${pinned.join(' / ') || '空'})—— 场景②的现场没搭起来`)
      }
    }
    // keep-alive 的**用户可感知语义**,与延迟同等重要:切走再切回,滚回原处。
    // 这一条在修之前必红(切走 = 整棵卸载 = 滚动位置归零),修完必绿。
    const scroll = await measureScrollSurvival(page, pinned)
    assertScenario(
      'shelf-tabs',
      scroll.before > 0 && scroll.after === scroll.before,
      `切走再切回后滚动位置 ${scroll.after} = 切走前 ${scroll.before}`,
      [],
    )

    const perfBefore = await page.evaluate(() => (window.__perf ? window.__perf.dump().length : 0))
    const sw = await recordTrace(cdp, 'shelf-tabs', async () => {
      const started = Date.now()
      const each = []
      for (let i = 0; i < 10; i += 1) {
        const index = i % pinned.length
        each.push(await measureTabSwitch(page, index, pinned[index]))
        // 每次切换之间留一拍,免得十次点击被合并成一个任务(那就量不出单次代价了)。
        await delay(60)
      }
      await delay(300)
      return { ms: Date.now() - started, each }
    })
    keepTrace('shelf-tabs', sw.events)
    const switchStats = frameStats(sw.events, BUDGET.longFrameMs)
    const each = sw.result.each
    const sortedEach = [...each].sort((a, b) => a - b)
    const switchP95 = sortedEach[Math.min(sortedEach.length - 1, Math.ceil(sortedEach.length * 0.95) - 1)]
    const loaf = await page.evaluate(
      n => (window.__perf ? window.__perf.dump().slice(n) : []),
      perfBefore,
    )
    const longFrames = loaf.filter(e => e.kind === 'longFrame' && e.ms > BUDGET.longFrameMs)
    console.log(
      `  · 每次切换 输入→上屏(ms):${each.join(' ')}`
        + `\n  · p95 ${switchP95}ms,最慢 ${sortedEach[sortedEach.length - 1]}ms,最快 ${sortedEach[0]}ms;`
        + ` 主线程任务 ${switchStats.tasks} 段,最长 ${switchStats.longest}ms,`
        + ` >${BUDGET.longFrameMs}ms 的 ${switchStats.overLong} 段`
        + `\n  · 页面侧 LoAF(第二路):${loaf.length} 条,其中 >${BUDGET.longFrameMs}ms 的 ${longFrames.length} 条`,
    )
    for (const frame of longFrames.slice(0, 5)) {
      const who = (frame.scripts ?? []).map(x => `${x.invoker} ${x.ms}ms`).join(' | ') || '(无归因)'
      console.log(`    · 长帧 ${frame.ms}ms(阻塞 ${frame.blockingMs ?? 0}ms):${who}`)
    }
    // 脚印量两次:重面板在前台 / 轻面板在前台。keep-alive 的**代价**恰恰是第二个数
    // ——「前台是 terminal,可 sessions 那 400 张卡还挂着」值多少内存,这一行说了算。
    for (const front of ['sessions', 'terminal']) {
      const index = pinned.indexOf(front)
      await page.evaluate(i => {
        document.querySelectorAll('[data-shelf="right"] [role="tab"]')[i]?.click()
      }, index)
      await delay(400)
      const fp = await measureFootprint(cdp)
      console.log(
        `  · 脚印(GC 后,三块面板同组,前台 = ${front}):`
          + ` JS 堆 ${fp.heapMB.toFixed(1)}MB,DOM 节点 ${fp.nodes},监听器 ${fp.listeners}`,
      )
    }
    record_('②架子 tab 切换 ×10', switchStats, { ms: switchP95, tabs: pinned.length })
    assertScenario(
      'shelf-tabs',
      switchP95 <= BUDGET.interactionP95Ms,
      `切换 输入→上屏 p95 ${switchP95}ms ≤ 交互预算 ${BUDGET.interactionP95Ms}ms`,
      sw.events,
    )
    assertScenario(
      'shelf-tabs',
      longFrames.length <= BUDGET.animationLongFrames,
      `期间 >${BUDGET.longFrameMs}ms 的长帧 ${longFrames.length} 条 ≤ ${BUDGET.animationLongFrames}`,
      sw.events,
    )

    /* ── 场景 ③:5k 字消息流式回放 ────────────────────────────────────────
     * 排在场景②**之后**是刻意的:那时右架子上三块面板全挂着(keep-alive),
     * 其中两块在后台。于是这一格顺带钉住 keep-alive 的那笔隐性代价 ——
     * 「后台面板会不会因为数据源一动就跟着重渲,把流式那条链拖慢」。
     * 排在前面就量不到,因为那时架子还是空的。
     */
    console.log('\n[7/8] 场景③ 5k 字长消息注入 → 上屏')

    const stream = await recordTrace(cdp, 'long-message', async () => {
      const started = Date.now()
      // 走 `session-command.emit` 而不是 `sessions.addSystemMessage`:前者是
      // gate-chat 已经验证过的那条**活推送**路(命令 → 引擎 → 账本事件 → SSE →
      // 增量折 → 上屏),正是这一格要量的链路;后者只往库里塞一条,屏幕未必动。
      await rpc(rec, 'session-command', 'emit', {
        sessionId: targetId,
        command: { type: 'command:send-message', content: LONG_MESSAGE },
      })
      await waitFor('长消息出现在屏幕上', async () => {
        const hit = await page.evaluate(
          () => document.body.textContent?.includes('性能门·长消息') ?? false,
        )
        return hit || undefined
      })
      await delay(500)
      return { ms: Date.now() - started }
    })
    const streamStats = frameStats(stream.events, BUDGET.streamFrameMs)
    console.log(
      `  · 注入→上屏 ${stream.result.ms}ms;`
        + ` 主线程任务 ${streamStats.tasks} 段,最长 ${streamStats.longest}ms,p95 ${streamStats.p95}ms,`
        + ` >${BUDGET.streamFrameMs}ms 的 ${streamStats.over} 段`,
    )
    record_('③5k 字消息上屏', streamStats, { ms: stream.result.ms })
    assertScenario(
      'long-message',
      streamStats.over <= BUDGET.streamOverBudgetFrames,
      `稳态里 >${BUDGET.streamFrameMs}ms 的帧 ${streamStats.over} 段 ≤ ${BUDGET.streamOverBudgetFrames}`,
      stream.events,
    )

    /* ── 场景 ④:大会话 + 真流(批 A)────────────────────────────────────
     * 场景③量的是「注入一条用户消息」;这一格量的是用户真正报障的那条链:
     * **大会话** + assistant 流 + 工具调用,而屏幕上那一头有一条活着的 SSE 订阅。
     */
    console.log('\n[8/8] 场景④ 大会话 + 假 provider 吐 50KB 带围栏回答 + 2 次工具调用')
    // 装回假 provider。目录键变了,`saveSettings` 之后 provider 缓存自己重拉。
    await rpc(rec, 'settings', 'saveSettings', perf4Settings(mockPort, true))
    await delay(500)
    await enterSession(page, bigSessionId)
    await delay(1500)

    const sse = { bytes: 0, sentinelAt: 0, status: 0, error: undefined }
    const stopSse = subscribeCoreSse(rec, PERF4_SENTINEL, sse)
    await delay(500)
    const cpu = startCpuSampler(server.pid)
    const perf4 = await recordTrace(cdp, 'big-session-stream', async () => {
      await rpc(rec, 'session-command', 'emit', {
        sessionId: bigSessionId,
        command: { type: 'command:send-message', content: `${PERF4_MARKER} 请给出完整方案` },
      })
      let screenAt = 0
      const deadline = Date.now() + 240_000
      while (Date.now() < deadline) {
        const hit = await page
          .evaluate(sentinel => document.body.textContent?.includes(sentinel) ?? false, PERF4_SENTINEL)
          .catch(() => false)
        if (hit) {
          screenAt = Date.now()
          break
        }
        await delay(100)
      }
      await delay(400)
      return { screenAt }
    })
    const cpuStats = cpu.stop()
    stopSse()
    const coreLag = sse.sentinelAt && mockState.sendDoneAt ? sse.sentinelAt - mockState.sendDoneAt : -1
    const screenLag = perf4.result.screenAt && mockState.sendDoneAt
      ? perf4.result.screenAt - mockState.sendDoneAt
      : -1
    const perf4Stats = frameStats(perf4.events, BUDGET.streamFrameMs)
    console.log(
      `  · provider 净吐 ${mockState.sendDoneAt - mockState.sendStartAt}ms / ${mockState.chunks} 块,`
        + `工具调用 ${mockState.toolCalls} 次`
        + `\n  · core 侧滞后(node SSE 哨兵 − provider 收尾)${coreLag}ms;`
        + ` core 进程 CPU 中位 ${cpuStats.median}%(峰 ${cpuStats.max}%,${cpuStats.n} 个采样)`
        + `\n  · 屏幕滞后 ${screenLag}ms(**只记录**:它夹着渲染层,`
        + `本趟渲染主线程单段最长 ${perf4Stats.longest}ms)`,
    )
    keepTrace('big-session-stream', perf4.events)
    record_('④大会话流式回放', perf4Stats, { ms: coreLag })
    assertScenario(
      'big-session-stream',
      coreLag >= 0 && coreLag <= PERF4_CORE_LAG_MS,
      `core 侧滞后 ${coreLag}ms ≤ ${PERF4_CORE_LAG_MS}ms`,
      perf4.events,
    )
    assertScenario(
      'big-session-stream',
      cpuStats.median >= 0 && cpuStats.median < PERF4_CORE_CPU_PCT,
      `core 进程 CPU 中位 ${cpuStats.median}% < ${PERF4_CORE_CPU_PCT}%`,
      perf4.events,
    )

    /* ── 第二路读数:页面自己的 LoAF 观察者 ──────────────────────────── */
    const inPage = await page.evaluate(() => (window.__perf ? window.__perf.dump() : []))
    console.log(
      `\n[perf-gate] 页面侧 LoAF 读数(第二路):${inPage.length} 条`
        + (inPage.length
          ? `,最长 ${Math.max(...inPage.map(e => e.ms))}ms`
          : '(浏览器没报长帧 —— 与 trace 侧对照着看)'),
    )

    printTable()

    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (mock) await new Promise(resolve => mock.close(() => resolve()))
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }

  if (failures.length) {
    console.error(`\n[perf-gate] FAILED(${failures.length} 条):\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[perf-gate] ok —— 五个场景都在预算内')
}

/**
 * 把默认打开档改成「钉栏」再重载,顺带**抹掉逐项记忆**。
 *
 * 做法是**改设置再重载**,不是伪造整份持久化状态:`defaultOpen` 是个标量、
 * `memory` 是个字典,两者形状都稳定;而 placements / shelves 的形状会随形态机
 * 演进,手写一份迟早对不上。版本号从应用自己刚写下的那份里读回来 —— 不硬编码。
 *
 * `memory` 必须清:打开的解析序是「显式手势 > 记忆 > 全局默认档」,
 * 而场景①刚刚把 sessions 开到过舞台上,那一次就写下了「sessions 回舞台」的记忆。
 * 不清它,后面点 Dock 上的 sessions 会**开到舞台**而不是钉到架子上 ——
 * 08-30 首跑就是这么踩的:场景②量到 23ms「很快」,因为最重的那块面板
 * 根本没进那条架子。量到的快,是场景没对上。
 *
 * ── 09-01:两格住在两处了,而且**要清的不止记忆**(T-W1 之后)────────────
 * 从前这两格都在 `state` 顶层,一句 `{...state, defaultOpen, memory:{}}` 就够。
 * T-W1 把**家具**挪进了 `state.byWorkspace[<空间 id>]`,而 `defaultOpen` 留在顶层
 * —— 分界是「这是不是用户在这个空间里摆好的东西」(判据见
 * `src/workspace/per-space.ts` 文件头):
 *
 *     defaultOpen  → **偏好**,跨空间共享,仍在 `state.defaultOpen`;
 *     memory / placements / shelves / floats → **家具**,每空间一份,在账里。
 *
 * 旧写法把 `memory` 写进了一个**没人读**的槽,于是重载后 sessions 照旧按记忆
 * 开到舞台。而真机上把记忆清对之后**还是红**(读数:`placements:["sessions"]`)
 * —— 第二个原因浮出来:场景①刚把 sessions 开在舞台上,它**已经开着**了,
 * 那时点 Dock 上那颗瓦是「切换/聚焦」而不是「按默认档重新打开」,所以它永远
 * 挪不到架子上。两个原因叠在一起,才是报障里那行「实际:files / terminal」。
 *
 * 所以这里要的不是「清一格记忆」,而是**一张空工作台**:整格家具删掉。
 * 删格而不是写一份空的 —— `shelves` 有自己的形状(四条边),手写一份迟早与
 * 形态机对不上;而账上没有这一格时,应用自己会摊开它的出厂布局
 * (`spreadSpace` → `factory()`)。**让应用产出形状,门只负责把格拿掉。**
 */
async function switchDefaultOpenToPinned(page) {
  const ok = await page.evaluate(() => {
    const KEY = 'onething.stage'
    const raw = localStorage.getItem(KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw)
    // 偏好留在顶层;家具整本账清空 = 每个空间都回出厂布局(空工作台)。
    parsed.state = { ...(parsed.state ?? {}), defaultOpen: 'pinned', byWorkspace: {} }
    localStorage.setItem(KEY, JSON.stringify(parsed))
    return true
  })
  if (!ok) throw new Error('localStorage 里没有 onething.stage —— 应用还没落过盘')
  await page.reload()
  await waitFor('重载后 Dock 就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-files"]'))),
  )
}

/**
 * 把点名的几块面板钉到右架子上,返回**真的钉上去了**的那一批 id(= tab 次序)。
 * 次序由 store 自己说了算,不由这里的输入次序猜 —— 读 DOM 上的 tablist。
 *
 * ── 为什么不是「点一下瓦」了(W6-p)───────────────────────────────────────
 * 点瓦 = 按**它自己的出厂摆法**开。W6-a 把 `sessions` / `files` 的出厂摆法改成了
 * **左架子**(理由:一块出厂就停在聊天区正中的浮窗会把那块地整个接管掉),而
 * `terminal` 没有自述、落在「钉栏」档的缺省右架子上 —— 于是三块面板落进两条架子,
 * 门在「『sessions』没钉进右架子(实际:terminal)」上红。
 * **这是夹具跟不上出厂档,不是产品回归**:场景②量的是「一条架子上重面板与轻面板
 * 混在一组、来回切」,**哪一条边不是它的判据**。所以夹具改成显式点名落点,走的是
 * 用户自己那条路 —— Dock 瓦右键 →「钉到边 ▸ 右边」(`OPEN_PLACEMENT_CHOICES`
 * 那一行,`openAs` 既执行也写记忆)。
 */
async function pinPanels(page, ids) {
  for (const id of ids) {
    await page.evaluate(tile => {
      const el = document.querySelector(`[data-testid="dock-tile-${tile}"]`)
      el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 300 }))
    }, id)
    await delay(250)
    const picked = await page.evaluate(() => {
      /*
       * **落点那一排是 `menuitemradio`,不是 `menuitem`**(`ui/Menu` 的 `MenuItem`:
       * 传了 `checked` 就换角色)。只问 `menuitem` 的话这一排一项都取不到 ——
       * 09-05 本批第一趟真机就红在这里,而报错说的是「没有『右边』」,像是文案变了。
       */
      const items = Array.from(document.querySelectorAll('[role="menuitem"],[role="menuitemradio"]'))
      // 「右边」那一项:`dock.edgeRight` 的两份文案,整串比对(「右边」不与别的项撞)。
      const right = items.find(el => /^(右边|Right)$/.test((el.textContent ?? '').trim()))
      if (right instanceof HTMLElement) right.click()
      else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      // 挑不中时把菜单上有什么一并交回来 —— 门红的时候要说得出「看见的是什么」。
      return { ok: Boolean(right), saw: items.map(el => (el.textContent ?? '').trim()) }
    })
    if (!picked.ok) {
      throw new Error(
        `Dock 瓦「${id}」的右键菜单里没有「钉到边 ▸ 右边」—— 夹具的取件口变了。`
          + `菜单上这几项:${picked.saw.length ? picked.saw.join(' | ') : '(一项都没有,菜单没开出来)'}`,
      )
    }
    await delay(300)
  }
  const count = await page.evaluate(
    () => document.querySelectorAll('[data-shelf="right"] [role="tab"]').length,
  )
  // tab 上没有 id(它是界面文案),所以「第 i 个 tab 是哪块面板」靠点一下问 DOM:
  // 点完 data-panel 就是答案。这一步在计时之外,多花几拍无所谓。
  const order = []
  for (let i = 0; i < count; i += 1) {
    order.push(
      await page.evaluate(async index => {
        const tabs = document.querySelectorAll('[data-shelf="right"] [role="tab"]')
        tabs[index]?.click()
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
        return document.querySelector('[data-shelf-body="right"]')?.dataset.panel ?? ''
      }, i),
    )
  }
  return order
}

/**
 * 「切走再切回,滚动位置还在吗」。
 *
 * 滚的是**架子 body 里那个真的能滚的元素**(scrollHeight 明显大于 clientHeight 的
 * 头一个),不是某块面板专属的选择器 —— 那样这条断言就只对一块面板成立了。
 */
async function measureScrollSurvival(page, pinned) {
  const heavy = pinned.indexOf(SHELF_PANELS[0])
  const light = pinned.indexOf(SHELF_PANELS[1])
  const pick = i =>
    page.evaluate(async index => {
      document.querySelectorAll('[data-shelf="right"] [role="tab"]')[index]?.click()
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    }, i)
  await pick(heavy)
  const before = await page.evaluate(() => {
    const body = document.querySelector('[data-shelf-body="right"]')
    const el = body && [...body.querySelectorAll('*')].find(x => x.scrollHeight > x.clientHeight + 40)
    if (!el) return 0
    el.scrollTop = 400
    return el.scrollTop
  })
  await pick(light)
  await pick(heavy)
  const after = await page.evaluate(() => {
    const body = document.querySelector('[data-shelf-body="right"]')
    const el = body && [...body.querySelectorAll('*')].find(x => x.scrollHeight > x.clientHeight + 40)
    return el ? el.scrollTop : -1
  })
  return { before, after }
}

/**
 * 量一次 tab 切换的「按下 → 上屏」。
 *
 * 与 measureClickToPaint 同一套配方(页内 performance.now 夹双 rAF),只是
 * 「画好了」的判据换成**架子 body 上的 data-panel 翻到目标面板**:那个属性
 * 与新内容在同一次 React 提交里落地,所以它翻了 = 新内容已经在 DOM 里,
 * 再等两拍 rAF 就是「上一帧已经画完」。
 *
 * 不拿「某块面板专属的选择器」当判据,是因为三块面板各有各的标记,
 * 三套判据会让三次切换的读数没有可比性。
 */
async function measureTabSwitch(page, index, expectedPanel) {
  return page.evaluate(
    async ({ i, panel }) => {
      const tabs = document.querySelectorAll('[data-shelf="right"] [role="tab"]')
      const target = tabs[i]
      if (!target) throw new Error(`右架子上没有第 ${i} 个 tab`)
      const started = performance.now()
      target.click()
      await new Promise((resolve, reject) => {
        const deadline = performance.now() + 5000
        const tick = () => {
          const body = document.querySelector('[data-shelf-body="right"]')
          if (body && body.dataset.panel === panel) resolve()
          else if (performance.now() > deadline) reject(new Error(`切到 ${panel} 超时`))
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return Math.round(performance.now() - started)
    },
    { i: index, panel: expectedPanel },
  )
}

/**
 * **中央那条条上至少两格标签**(⑤b 与 ⑤c 共用的夹具,W6-p)。
 *
 * **幂等**是它存在的理由:⑤b 与 ⑤c 各自要先确认自己的现场在(一道会「借前一个
 * 场景留下的状态」的门,会随任何一个前置场景的改动一起塌 —— `gate:drag` 与这道门
 * 的 ⑤c 都各踩过一次),而两个场景都叫一次又不该叠出第三格。所以这里**先问事实,
 * 再决定开不开**,与 `ensureOverviewRow` 的判词同源。
 */
async function ensureSecondTab(page, candidates) {
  const census = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="tablist"]'))
        .map(el => el.querySelectorAll('[data-tab-id]').length),
    )
  const enough = counts => counts.some(n => n >= 2)
  if (enough(await census())) return true
  /*
   * **收的是一串候选,不是一条会话**(W6-p 第一趟真机当场撞上的):「在下方打开」
   * 落的是 `dropRef({kind:'open'})`,而它对**已经开着的那一格**是幂等的 ——
   * 只把它点亮,不会再添一格。⑤a 跑完停在哪一条会话是它自己的循环说了算
   * (`i % normalIds.length`),夹具不该去猜那个余数;换成挨个试,开出第二格就收手。
   */
  let opened = false
  const after = []
  for (const id of candidates) {
    opened = (await openSessionAsSecondTab(page, id)) || opened
    const counts = await census()
    after.length = 0
    after.push(...counts)
    if (enough(counts)) return true
  }
  // 夹具搭不起来时要说得出**哪一步**没成:菜单那一项在不在、条上此刻有几格。
  console.log(
    `  · 夹具没搭起来:「在下方打开」${opened ? '点到了' : '**没找到**'};`
      + `试过 ${candidates.length} 条会话;此刻屏幕上的标签条各有几格:`
      + `${after.length ? after.join(' / ') : '(一条都没有)'}`,
  )
  return false
}

/**
 * **在中央那条条的末尾再开一格标签**(⑤b / ⑤c 的夹具)。
 *
 * 走的是用户真走的那条路:会话行右键 →「在下方打开」。挑这一项而不是「在右侧」
 * 是因为它在 main 与 W6-b 上是**同一个结果**(末尾开一格新标签)——「在右侧」
 * 在 W6-b 之后是二合一,两边不同形,A/B 就不是同一个现场了。
 */
async function openSessionAsSecondTab(page, sessionId) {
  await ensureOverviewRow(page, sessionId)
  await page.evaluate((id) => {
    const row = document.querySelector(`[data-testid="session-row-${id}"]`)
    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 80 }))
  }, sessionId)
  await delay(400)
  const opened = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"],[role="menuitemradio"]'))
    const below = items.find((el) => /在下方|Open below/.test(el.textContent ?? ''))
    if (below instanceof HTMLElement) below.click()
    else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return Boolean(below)
  })
  await delay(800)
  // 总览收回去,别盖着那条条(点瓦是开关,所以先问再点)。
  for (let i = 0; i < 2; i += 1) {
    const there = await page.evaluate(() => Boolean(document.querySelector('[data-float-body], [data-testid="overview-root"]')))
    if (!there) break
    await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
    await delay(400)
  }
  return opened
}

/**
 * **把总览摆出来,直到那一行在场**(W6-b 修:这道门在 `[4/8]` 上卡死的那一格)。
 *
 * **点瓦是开关**(既有判例,`gate-focus.ensureOverviewRow` / `gate-drag` 同源):
 * 场景①「冷开会话总览」已经把它开着了,后面每一处再点一下等于**关掉** ——
 * 那一行于是永远等不到,门在 `[4/8]` 超时。这条卡死是**确定的**而不是抖动:
 * 09-05 在 main(a8e76ae2)与本批上各跑一趟,读数逐字相同(同一行 `waitFor` 超时,
 * 先在 `enterSession`、修完一处之后挪到 `measureSessionSwitch`)。所以它是这道门
 * 自己的存量伤,不是哪一批的产品回归 —— 但 ⑤/⑤b/⑤c 三个场景都被它挡在门外,
 * 而 ⑤c 正是本批要交的读数,所以在这里一并修掉。
 */
async function ensureOverviewRow(page, sessionId) {
  const there = () =>
    page.evaluate(id => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await there()) break
    await clickTestId(page, 'dock-tile-sessions')
    await delay(600)
  }
  await waitFor('总览画出那一行', there)
}

/**
 * 从总览进一条会话 —— 与 gate-chat 逐字同一条路:开总览 → 点那张卡。
 *
 * **点瓦是开关**(既有判例,`gate-focus.ensureOverviewRow` / `gate-drag` 同源):
 * 场景①「冷开会话总览」已经把它开着了,这里再点一下等于**关掉** —— 那一行于是
 * 永远等不到,门在 `[4/8]` 上超时。W6-a 之后这条卡死是**确定的**,而不是抖动:
 * 09-05 在 main(a8e76ae2)与本批上各跑一趟,读数逐字相同(同一行 `waitFor` 超时),
 * 所以它是这道门自己的存量伤,不是哪一批的产品回归。
 * 修法与别的门一样:**先问事实,再决定点不点**,最多两下。
 */
async function enterSession(page, sessionId) {
  await ensureOverviewRow(page, sessionId)
  await clickTestId(page, `session-row-${sessionId}`)
  await waitFor('聊天区起底完成', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="chat-stream"]'))),
  )
}

/**
 * 在**页面内部**量一次「点下去 → 画出来」。
 *
 * 为什么不在 node 侧掐秒表:脚本侧只能靠轮询问「画好了没」,轮询间隔(100ms)
 * 直接变成读数的误差下限 —— 量出来那 400ms 里有多少是渲染、多少是脚本自己在等,
 * 分不开。放进页面里就没有这一层:`performance.now()` 夹在 click 与「卡片出现后的
 * 下一次绘制」之间,量的是浏览器真正花掉的那段。
 *
 * 末尾连等两次 rAF 是刻意的:第一次回调时这一帧的样式与布局还没提交,
 * 第二次才落在「上一帧已经画完」之后。
 */
async function measureClickToPaint(page, testId, appearSelector) {
  return page.evaluate(
    async ({ id, selector }) => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (!el) throw new Error(`点不到:[data-testid="${id}"]`)
      const started = performance.now()
      el.click()
      await new Promise(resolve => {
        const tick = () => {
          if (document.querySelector(selector)) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return {
        ms: Math.round(performance.now() - started),
        cards: document.querySelectorAll(selector).length,
      }
    },
    { id: testId, selector: appearSelector },
  )
}

function printTable() {
  console.log('\n── 五场景实测 ──')
  const pad = (s, n) => String(s).padEnd(n)
  console.log(
    `${pad('场景', 26)}${pad('耗时', 10)}${pad('任务数', 8)}${pad('最长', 8)}${pad('p95', 8)}超标段`,
  )
  for (const row of report) {
    console.log(
      pad(row.scenario, 26)
        + pad(`${row.ms}ms`, 10)
        + pad(row.tasks, 8)
        + pad(`${row.longest}ms`, 8)
        + pad(`${row.p95}ms`, 8)
        + row.over,
    )
  }
}

main().catch(error => {
  console.error('\n[perf-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
