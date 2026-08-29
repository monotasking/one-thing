#!/usr/bin/env node
/**
 * 性能门(工程卫生批 ⑤)—— **脚本级,拒人肉 QA**。
 *
 * 别的门问「对不对」,这条门问「卡不卡」。三个场景,同一套量法:
 *
 *  ① **冷开会话总览**(种子 100+ 会话)—— 一次点击要画出上百张卡,是这块壳最重的
 *     一次首屏。判据:那一次交互的端到端时长 ≤ 交互预算,期间不出长帧。
 *  ② **架子 tab 连续切换 ×10** —— **本批只记录数字,不断言**。已知它有卡顿,
 *     修在下一批;门先立在这里把基线量出来,那一批再把它翻成断言(钉红 → 修绿)。
 *     一条现在就会红的断言只会被人 skip 掉,那比没有断言更糟。
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
    longFrameMs: pick('longFrameMs'),
    streamFrameMs: pick('streamFrameMs'),
    streamOverBudgetFrames: pick('streamOverBudgetFrames'),
    animationLongFrames: pick('animationLongFrames'),
  }
}

const BUDGET = readBudget()

/** 场景①的种子会话数。「100+」按 120 来,留出余量。 */
const SEED_SESSIONS = 120
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

function saveTrace(label, events) {
  const file = path.join(tmpdir(), `onething-perf-${label}-${Date.now()}.json`)
  // DevTools 的 Performance 面板吃「事件数组」或 {traceEvents:[…]},这里给后者。
  writeFileSync(file, JSON.stringify({ traceEvents: events }), 'utf-8')
  return file
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
  const file = saveTrace(scenario, events)
  console.log(`  ✗ ${message}`)
  console.log(`    trace 已存:${file}(拖进 DevTools 的 Performance 面板)`)
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
    console.log(`\n[1/5] 起一台 core,种 ${SEED_SESSIONS} 条会话`)
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

    console.log('\n[2/5] 拉起应用(独立 --user-data-dir),等它连上同一台 core')
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
    console.log(`\n[3/5] 场景① 冷开会话总览(${SEED_SESSIONS} 条会话)`)
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
      cold.result.ms <= BUDGET.interactionP95Ms,
      `点击→上屏 ${cold.result.ms}ms ≤ 交互预算 ${BUDGET.interactionP95Ms}ms`,
      cold.events,
    )
    assertScenario(
      'cold-sessions',
      coldStats.overLong <= BUDGET.animationLongFrames,
      `期间 >${BUDGET.longFrameMs}ms 的长帧 ${coldStats.overLong} 段 ≤ ${BUDGET.animationLongFrames}`,
      cold.events,
    )

    /* ── 场景 ②:架子 tab 连续切换 ×10(只记录,不断言)────────────────── */
    console.log('\n[4/5] 场景② 架子 tab 连续切换 ×10 —— **记录模式,本批不断言**')
    const tabs = await setUpShelfTabs(page)
    let switchStats = null
    if (tabs < 2) {
      console.log(`  ! 架子上只有 ${tabs} 个 tab,切不起来 —— 这一格记为「没量到」`)
    } else {
      const sw = await recordTrace(cdp, 'shelf-tabs', async () => {
        const started = Date.now()
        for (let i = 0; i < 10; i += 1) {
          await page.evaluate(index => {
            const list = document.querySelectorAll('[role="tab"]')
            const target = list[index % list.length]
            if (target) target.click()
          }, i)
          // 每次切换之间留一帧,免得十次点击被合并成一个任务(那就量不出单次代价了)。
          await delay(60)
        }
        await delay(300)
        return { ms: Date.now() - started }
      })
      switchStats = frameStats(sw.events, BUDGET.streamFrameMs)
      console.log(
        `  · 10 次切换共 ${sw.result.ms}ms(含每次 60ms 间隔);`
          + ` 主线程任务 ${switchStats.tasks} 段,最长 ${switchStats.longest}ms,p95 ${switchStats.p95}ms,`
          + ` >${BUDGET.longFrameMs}ms 的 ${switchStats.overLong} 段`,
      )
      console.log('    (基线已记录。下一批修完卡顿再把这一格翻成断言 —— 先钉红,再修绿。)')
      record_('②架子 tab 切换 ×10(记录)', switchStats, { ms: sw.result.ms, tabs })
    }

    /* ── 场景 ③:5k 字消息流式回放 ────────────────────────────────────── */
    console.log('\n[5/5] 场景③ 5k 字长消息注入 → 上屏')
    // 进一条会话,聊天区才有落点。总览里 Enter 进会话;这里直接点第一张卡的预览再进。
    const targetId = created[0]
    await enterSession(page, targetId)

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
  console.log('\n[perf-gate] ok —— 场景①③ 在预算内,场景② 已记录基线')
}

/**
 * 把两块面板放到右边架子上,造出可切换的 tab。
 *
 * 做法是**改设置再重载**,不是伪造整份持久化状态:`defaultOpen` 是个标量,
 * 形状稳定;而 placements / shelves 的形状会随形态机演进,手写一份迟早对不上。
 * 版本号从应用自己刚写下的那份里读回来 —— 不硬编码,持久化版本升了也不用改门。
 */
async function setUpShelfTabs(page) {
  const ok = await page.evaluate(() => {
    const KEY = 'onething.stage'
    const raw = localStorage.getItem(KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw)
    parsed.state = { ...(parsed.state ?? {}), defaultOpen: 'pinned' }
    localStorage.setItem(KEY, JSON.stringify(parsed))
    return true
  })
  if (!ok) return 0
  await page.reload()
  await waitFor('重载后 Dock 就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-files"]'))),
  )
  for (const id of ['files', 'terminal']) {
    await clickTestId(page, `dock-tile-${id}`)
    await delay(200)
  }
  return page.evaluate(() => document.querySelectorAll('[role="tab"]').length)
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
