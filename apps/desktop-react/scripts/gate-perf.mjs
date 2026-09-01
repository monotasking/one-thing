#!/usr/bin/env node
/**
 * 性能门(工程卫生批 ⑤)—— **脚本级,拒人肉 QA**。
 *
 * 别的门问「对不对」,这条门问「卡不卡」。三个场景,同一套量法:
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
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
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
 * 'sessions' 排头是刻意的:它是这块壳最重的一块面板(整份会话网格),
 * 「重面板 + 轻面板混在一组」才是用户报障时的现场。
 */
const SHELF_PANELS = ['sessions', 'files', 'terminal']

/** 场景③注入的那条长消息:5k 字。 */
const LONG_MESSAGE = `性能门·长消息 ${'流式回放的稳态帧率是这一段要量的东西。'.repeat(200)}`.slice(0, 5000)

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
 */
async function recordTrace(cdp, label, body) {
  const events = []
  const onData = params => events.push(...(params.value ?? []))
  cdp.on('Tracing.dataCollected', onData)
  const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve))

  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline,toplevel,blink.user_timing',
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
  try {
    console.log(`\n[1/6] 起一台 core,种 ${SEED_SESSIONS} 条会话`)
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store },
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

    console.log('\n[2/6] 拉起应用(独立 --user-data-dir),等它连上同一台 core')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    const page = await app.firstWindow()
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    const cdp = await app.context().newCDPSession(page)
    console.log('  ✓ 连上了,CDP 会话已开')

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
    console.log(`\n[3/6] 场景① 冷开会话总览(${SEED_SESSIONS} 条会话)`)
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
        '    ↑ 08-30 起的已知红,**不是**架子 tab 那条路的回归:种子从 120 抬到 400 之后,'
          + '冷开一次要画 400 张卡,那一段主线程任务 53–65ms 越过 50ms 的长帧线。\n'
          + '      病根与场景②同源(400 张卡一次全画),但修法要给卡片加 containment,'
          + '而 content-visibility 蕴含的 contain: paint 会剪掉卡片外沿的焦点柔光环\n'
          + '      —— 08-30 刚为这条报障做过治理(见 Overview.module.css 的 .bodyInner)。'
          + '所以它是一次要拍板的改动,故意留红,不在这里盲修。',
      )
    }

    /* ── 场景②③ 共用的现场:钉栏默认档 + 进一条会话 ─────────────────── */
    console.log('\n[4/6] 切成「钉栏」默认档并进一条会话(场景②③ 共用这个现场)')
    await switchDefaultOpenToPinned(page)
    const targetId = created[0]
    await enterSession(page, targetId)
    console.log('  ✓ 已进入会话,聊天区起底完成')

    /* ── 场景 ②:架子 tab 连续切换 ×10 ────────────────────────────────── */
    console.log(`\n[5/6] 场景② 右架子 tab 连续切换 ×10(真实负载:${SHELF_PANELS.join(' / ')} 同组)`)
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
    console.log('\n[6/6] 场景③ 5k 字长消息注入 → 上屏')

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
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }

  if (failures.length) {
    console.error(`\n[perf-gate] FAILED(${failures.length} 条):\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[perf-gate] ok —— 三个场景都在预算内')
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
 */
async function pinPanels(page, ids) {
  for (const id of ids) {
    await clickTestId(page, `dock-tile-${id}`)
    await delay(250)
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

/** 从总览进一条会话 —— 与 gate-chat 逐字同一条路:开总览 → 点那张卡。 */
async function enterSession(page, sessionId) {
  await clickTestId(page, 'dock-tile-sessions')
  await waitFor('总览画出那张卡', () =>
    page.evaluate(id => Boolean(document.querySelector(`[data-testid="card-${id}"]`)), sessionId),
  )
  await clickTestId(page, `card-${sessionId}`)
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
  console.log('\n── 三场景实测 ──')
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
