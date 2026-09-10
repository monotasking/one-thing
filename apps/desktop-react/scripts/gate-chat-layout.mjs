#!/usr/bin/env node
/**
 * **聊天树的排版账**(2026-09-10)—— 这道门问的不是「对不对」,是**一次排版要多少钱**。
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
 * 两笔修:**A** 拆掉「每一次提交都贴底」那只 effect(跟底改由 ResizeObserver 派);
 * **B** 消息行挂 `content-visibility: auto` + `contain-intrinsic-block-size`,
 * 让首次排版与 resize 从「按整份账本计价」变成「按视口计价」。
 *
 * ── 这道门量什么、不量什么 ────────────────────────────────────────────────
 * 量:①切会话往返五次的 click 同步 JS 与长帧;②进场就在底;③切走再切回停在
 * 离开时那一行(跳渲的行只报估高,落位会漂 —— 所以这一条正是 B 的验收);
 * ④拖窗口十步的长帧;⑤大会话上真流一轮之后仍然在底(A 没把跟底弄丢)。
 *
 * **不量**:丸的三张脸、发送三态、玻璃几何 —— 那些在 `gate:chat-follow` 里,
 * 而**那道门正是「A 没把跟底弄丢」的另一半证据**(它接真假 provider、逐条注入、
 * 每长一条都断言仍在底)。两道门一起跑,不在这里抄第二份。
 *
 * ── 种子:直接写账本,不走一百九十轮真回答 ────────────────────────────────
 * 会话经 `sessions.create` 建(meta.json 因此是产品自己写的那一份),**趁 core
 * 停着**把事件追进 `events.jsonl`,再把 core 起回来 —— 冷启一次全读,不碰
 * 「外来写手」那道闸。这样几秒钟就能种出与报障现场同量级的一棵树,而不必等
 * 一百九十轮假回答。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * 隔离 store + 独立 `--user-data-dir`,`ONETHING_GATE_HEADLESS=1` 离屏起窗(不 show、
 * 不进 Dock、不抢前台),一切输入走 CDP,`finally` 里逐个收尸。**绝不连
 * `~/.onething`**,一个字节都不写用户的机器。
 *
 * 跑法:`node scripts/gate-chat-layout.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * `--json` 只打读数表不判红绿(调参用)。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import {
  startFakeProvider,
  fakeProviderAiSettings,
  FAKE_PROVIDER_ENV,
} from '../../../scripts/lib/gate-fake-provider.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')
const JSON_ONLY = process.argv.includes('--json')

/*
 * ── 种子的量级(对着报障现场取)──────────────────────────────────────────
 * 真机那条会话:388 条消息 / 916 张工具卡。一问一答两条,所以 190 轮 ≈ 380 条;
 * 每轮 5 次工具调用 ≈ 950 张卡。乙会话小一档 —— 「切回甲」那一下的代价才是
 * 这道门的主角,乙只负责把甲挤下屏。
 */
const A_TURNS = 190
const A_TOOLS_PER_TURN = 5
const B_TURNS = 60
const B_TOOLS_PER_TURN = 2

/**
 * ── 预算 ──────────────────────────────────────────────────────────────────
 * 都是**这一批之前量到的读数**加一段余量,不是凭空拍的数(逐条来历见上面的病历)。
 * 它们是**上限**不是目标:门要抓的是「回到按整份账本计价」那种量级的回归,
 * 而不是把每一次抖动都判红。
 */
const BUDGET = {
  /** 切回一条已在池里的大会话,click 的同步 JS。改前 1027 / 923ms。 */
  switchClickSyncMs: 300,
  /** 同一下里最长的那一帧(long-animation-frame)。改前 1101 / 988ms。 */
  switchLongestFrameMs: 400,
  /** 拖窗口十步里最长的那一帧。改前每步 110ms(其中 JS 0.38ms)。 */
  resizeLongestFrameMs: 90,
  /** 「在底」的容差 —— 与 `content/follow.ts` 的 `AT_BOTTOM_EPS` 同一个数。 */
  atBottomEps: 2,
  /** 切走再切回来,锚点那一行落在原位的容差(px)。 */
  anchorDriftPx: 8,
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
const readings = {}
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

async function waitFor(label, predicate, timeoutMs = 60_000) {
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

/* ── 种子:直接往账本里追事件 ─────────────────────────────────────────────
 *
 * 事件形与真账本逐字同形(`user/message` / `run/start` / `assistant/chunks` /
 * `tool/call` / `tool/result` / `run/end`)。正文长度取「一条正常回答」的量级 ——
 * 这道门要还原的是排版的**总量**,不是某一种块的画法。
 */
const PARAGRAPH =
  '这一段是种子正文,长度取一条正常回答的量级:它要在屏幕上真的占掉几行,' +
  '这样整棵树的高度才与报障现场同量级。排版的钱花在行盒与块盒上,而不是花在字符本身,' +
  '所以这里不追求内容像不像,只追求行数与块数像。'

function seedEvents(sessionId, turns, toolsPerTurn, startSeq, t0) {
  const lines = []
  let seq = startSeq
  const push = (type, data) => {
    lines.push(JSON.stringify({ seq: (seq += 1), time: t0 + seq, type, data }))
  }
  for (let turn = 0; turn < turns; turn += 1) {
    const userId = `seed-u-${turn}`
    const runId = `seed-r-${turn}`
    const assistantId = `seed-a-${turn}`
    push('user/message', {
      message: { id: userId, role: 'user', content: `第 ${turn + 1} 问 —— ${PARAGRAPH.slice(0, 60)}`, timestamp: t0 + seq },
    })
    push('run/start', { runId, kind: 'send', assistantMessageId: assistantId, triggerMessageId: userId, timestamp: t0 + seq })
    const text = [`## 第 ${turn + 1} 答\n\n`, PARAGRAPH, '\n\n', PARAGRAPH, '\n\n', PARAGRAPH]
    push('assistant/chunks', {
      runId,
      requestIndex: 1,
      messageId: assistantId,
      partIndex: 0,
      kind: 'text',
      time0: t0 + seq,
      dt: text.map((_, i) => i),
      text,
    })
    for (let tool = 0; tool < toolsPerTurn; tool += 1) {
      const callId = `seed-c-${turn}-${tool}`
      push('tool/call', {
        callId,
        name: 'read',
        argumentsRaw: JSON.stringify({ path: `/seed/turn-${turn}/file-${tool}.md` }),
        messageId: assistantId,
        runId,
      })
      push('tool/result', {
        callId,
        isError: false,
        resultPreview: `${PARAGRAPH}\n${PARAGRAPH}`,
        result: { text: `${PARAGRAPH}\n${PARAGRAPH}` },
      })
    }
    push('run/end', { runId, outcome: 'completed' })
  }
  return { text: `${lines.join('\n')}\n`, lastSeq: seq }
}

/** 账本里最后一条的 seq —— 追加要从它往后接。 */
function lastSeqOf(ledgerPath) {
  if (!existsSync(ledgerPath)) return 0
  const lines = readFileSync(ledgerPath, 'utf-8').trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const seq = JSON.parse(lines[i]).seq
      if (typeof seq === 'number') return seq
    } catch {
      /* 半行就往前找 */
    }
  }
  return 0
}

/* ── 页内探针:交互读数 + 长帧 ───────────────────────────────────────────── */

async function installProbe(page) {
  await page.evaluate(() => {
    if (window.__layoutProbe) return
    const P = (window.__layoutProbe = { events: [], loaf: [] })
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
    }
  }, mark)
}

function readView(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="chat-stream"]')
    if (!(scroll instanceof HTMLElement)) return { rowCount: 0 }
    const rows = [...document.querySelectorAll('[data-message-id]')]
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

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[chat-layout] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[chat-layout] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'chat-layout-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'chat-layout-udd-'))
  let mockProvider
  let server
  let app

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
    console.log('\n[1/6] 起假 provider + 一台 core,建两条空会话')
    mockProvider = await startFakeProvider(0, '门跑完了,这一句是假 provider 吐的回答。')
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
    const idA = (await rpc(core.record, 'sessions', 'create', { name: '排版账 · 甲(大)' }))?.session?.id
    const idB = (await rpc(core.record, 'sessions', 'create', { name: '排版账 · 乙(小)' }))?.session?.id
    if (!idA || !idB) throw new Error('会话没建出来')

    console.log('[2/6] 停 core,把种子事件追进账本,再把 core 起回来')
    await stopCore(server)
    const t0 = Date.now() - 86_400_000
    for (const [id, turns, tools] of [
      [idA, A_TURNS, A_TOOLS_PER_TURN],
      [idB, B_TURNS, B_TOOLS_PER_TURN],
    ]) {
      const ledger = path.join(store, 'sessions', id, 'events.jsonl')
      const seeded = seedEvents(id, turns, tools, lastSeqOf(ledger), t0)
      appendFileSync(ledger, seeded.text)
      console.log(`      ${id.slice(0, 8)}:${turns} 轮 × ${tools} 次工具,账本 ${(readFileSync(ledger).length / 1024).toFixed(0)}KB`)
    }
    core = await startCore()
    server = core.child
    const record = core.record

    console.log('[3/6] 拉起应用(离屏 · 独立 --user-data-dir)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
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
          Boolean(document.querySelector(`[data-testid="session-row-${a}"]`)) &&
          Boolean(document.querySelector(`[data-testid="session-row-${b}"]`)),
        [idA, idB],
      ),
    )

    console.log('\n[4/6] ① 切会话往返:cold-A → B#1 → A#2 → B#2 → A#3')
    const switches = []
    for (const [label, id, want] of [
      ['cold-A', idA, A_TURNS * 2],
      ['B#1', idB, B_TURNS * 2],
      ['A#2', idA, A_TURNS * 2],
      ['B#2', idB, B_TURNS * 2],
      ['A#3', idA, A_TURNS * 2],
    ]) {
      const mark = await probeMark(page)
      await clickTestId(cdp, page, `session-row-${id}`)
      await waitFor(`${label} 的消息上屏`, async () => {
        const view = await readView(page)
        return view.rowCount >= want ? view : undefined
      })
      await delay(2500)
      const got = await harvest(page, mark)
      const view = await readView(page)
      switches.push({ label, ...got, gap: view.gap, rowCount: view.rowCount })
      console.log(`      ${label}: clickSync=${got.clickSync}ms 最长帧=${got.longestFrame}ms 行=${view.rowCount} 离底=${view.gap}px`)
    }
    readings.switches = switches
    readings.dom = await page.evaluate(() => ({
      domNodes: document.querySelectorAll('*').length,
      messages: document.querySelectorAll('[data-message-id]').length,
      toolCards: document.querySelectorAll('[class*="toolCard"]').length,
      contentHeight: Math.round(
        document.querySelector('[data-testid="chat-stream"]')?.firstElementChild?.getBoundingClientRect().height ?? 0,
      ),
    }))
    console.log(`      现场:${JSON.stringify(readings.dom)}`)

    const warm = switches.filter((s) => s.label === 'A#2' || s.label === 'A#3')
    const worstWarm = Math.max(...warm.map((s) => s.clickSync))
    const worstFrame = Math.max(...switches.map((s) => s.longestFrame))
    assert(
      worstWarm <= BUDGET.switchClickSyncMs,
      `切回大会话的 click 同步 JS ${worstWarm}ms ≤ ${BUDGET.switchClickSyncMs}ms(改前 1027 / 923ms)`,
    )
    assert(
      worstFrame <= BUDGET.switchLongestFrameMs,
      `五次切换里最长的那一帧 ${worstFrame}ms ≤ ${BUDGET.switchLongestFrameMs}ms(改前 1101ms)`,
    )

    console.log('\n[5/6] ② 进场就在底 / ③ 切走再切回停在离开时那一行')
    const entered = await readView(page)
    assert(
      entered.gap <= BUDGET.atBottomEps,
      `进场就在底(离底 ${entered.gap}px ≤ ${BUDGET.atBottomEps}px)`,
    )

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
    await waitFor('乙上屏', async () => {
      const view = await readView(page)
      return view.rowCount >= B_TURNS * 2 ? view : undefined
    })
    await delay(1200)
    await clickTestId(cdp, page, `session-row-${idA}`)
    await waitFor('甲回来', async () => {
      const view = await readView(page)
      return view.rowCount >= A_TURNS * 2 ? view : undefined
    })
    await delay(1500)
    const after = await readView(page)
    readings.anchor = { before: before.anchor, after: after.anchor }
    const sameRow = Boolean(before.anchor && after.anchor && before.anchor.id === after.anchor.id)
    const drift = sameRow ? Math.abs(after.anchor.offset - before.anchor.offset) : Number.NaN
    console.log(`      回来后:锚点 ${after.anchor?.id} offset=${after.anchor?.offset}px`)
    assert(sameRow, `切回来还是离开时那一行(${before.anchor?.id} → ${after.anchor?.id})`)
    assert(
      sameRow && drift <= BUDGET.anchorDriftPx,
      `那一行落在原位 ±${BUDGET.anchorDriftPx}px(实测漂 ${Number.isNaN(drift) ? '—' : drift}px)`,
    )

    console.log('\n[6/6] ④ 拖窗口十步 / ⑤ 大会话上真流一轮仍然在底')
    const base = await readView(page)
    const mark = await probeMark(page)
    for (let step = 0; step < 10; step += 1) {
      const width = base.w - (step + 1) * 24
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: base.h, deviceScaleFactor: 0, mobile: false })
      await delay(220)
    }
    await delay(1200)
    const resized = await harvest(page, mark)
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await delay(1200)
    readings.resize = resized
    console.log(`      resize ×10:最长帧=${resized.longestFrame}ms(共 ${resized.frames} 个长帧)`)
    assert(
      resized.longestFrame <= BUDGET.resizeLongestFrameMs,
      `拖窗口十步里最长的那一帧 ${resized.longestFrame}ms ≤ ${BUDGET.resizeLongestFrameMs}ms(改前每步 110ms)`,
    )

    // 回到底,再让假 provider 真跑一轮 —— 流完必须还在底(A 的跟底没丢)。
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-stream"]')
      el.scrollTop = el.scrollHeight
      el.dispatchEvent(new Event('scroll'))
    })
    await delay(600)
    const wantRows = A_TURNS * 2 + 2
    await rpc(record, 'session-command', 'emit', {
      sessionId: idA,
      command: { type: 'command:send-message', content: '排版账门:这一条要让 388 条的树上真跑一轮' },
    })
    const streamed = await waitFor('那一轮上屏', async () => {
      const view = await readView(page)
      return view.rowCount >= wantRows ? view : undefined
    })
    await delay(2500)
    const settled = await readView(page)
    readings.stream = { rowCount: settled.rowCount, gap: settled.gap, sawRows: streamed.rowCount }
    console.log(`      真流一轮之后:行=${settled.rowCount} 离底=${settled.gap}px`)
    assert(
      settled.gap <= BUDGET.atBottomEps,
      `大会话上真跑一轮,流完仍然在底(离底 ${settled.gap}px ≤ ${BUDGET.atBottomEps}px)`,
    )
  } finally {
    if (app) await app.close().catch(() => undefined)
    await stopCore(server)
    if (mockProvider) mockProvider.close()
    await rm(store, { recursive: true, force: true }).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    console.log(`\n[收尸] store / udd 已删;core pid=${server?.pid} killed=${server?.killed}`)
  }

  if (JSON_ONLY) {
    console.log(JSON.stringify({ readings, failures }, null, 2))
    return
  }
  console.log('')
  if (failures.length > 0) {
    console.error(`[chat-layout] 红 —— ${failures.length} 条不达标:`)
    for (const line of failures) console.error(`  · ${line}`)
    process.exit(1)
  }
  console.log('[chat-layout] 绿 —— 聊天树的排版账在预算内')
}

main().catch((error) => {
  console.error(`\n[chat-layout] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
