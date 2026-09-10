#!/usr/bin/env node
/**
 * C1 的真机门 —— **会话连续性 · 不重载**(正本 `docs/session-continuity-2026-09.md`
 * §1 真因 / §5 / §6 C1 行)。
 *
 * ── 它证的是用户报的那一句 ────────────────────────────────────────────────
 * 用户原话:「tab 切换 session 我还需要 load session」。真因不在网络也不在 core:
 * 一片叶换掉会话 ref → 旧会话的 `ChatSource` 引用归零 → 下一拍把整台机器
 * `dispose()`;切回来 `acquire` 重新 `runLoad`,从 core 再拉一遍账本。
 * **不是网络慢,是壳把它扔了。**
 *
 * 治法两件(§5.1 停靠池 + §5.2 视图状态按会话记),这道门量的是它们合起来
 * 在**真的排版**之下成不成立:
 *
 *  ① **零重载** —— 从「切走」那一刻起,`sessionEvents.listRaw` 对这条会话
 *     **一发都不许打**。判据是**数请求次数,不是量时间**:量时间会把一台慢机器
 *     判成回归、把一次真重载判成通过(与检索面分页那条「反证要数指令次数、
 *     不量位移」是同一条纪律)。
 *  ② **停在离开时那一行** —— 切回来之后滚动位置与切走前一致(容差一行)。
 *     jsdom 那一半只证得了「读到的锚点被交给了滚动逻辑」
 *     (`src/content/ChatStream.test.tsx` 的「进场落点」一组),
 *     「眼睛看到的还是那一行」只有真的排版说得出来 —— 那正是这一条。
 *  ③ **焦点在输入框** —— 切回一格会话 = 「开会话 → 它的输入面板」
 *     (响应链规则 2,`ContentKind.focusInto: 'composer'`)。不重载不该
 *     顺手把这一条改掉。
 *
 * ── 这道门**说不出**什么 ──────────────────────────────────────────────────
 * 停靠池的上限(第 9 条挤掉第 1 条)。那要在屏幕上摆过九条会话,而每一条都得
 * 种一段够长的账本 —— 代价与它证的东西不成比例,那一条留给单测
 * (`src/data/chat-source.test.ts` 的「停靠池 LRU」)。这里量的是**一次真的
 * 来回**,那是单测量不到的那一半。
 *
 * 折叠态(工具卡展开着的那几格)也不在这道门里 —— 本批根本没记它,理由与留账
 * 写在 `src/data/session-view-state.ts` 的文件头与末尾。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * **窗子一律离屏起**(`ONETHING_GATE_HEADLESS=1`,与 gate-chat-follow / gate-focus
 * 同一手):不 show()、不进 Dock、不抢用户的前台;所有输入都经 `page.evaluate`,
 * 一根手指都不碰真光标。store 与 `--user-data-dir` 都是临时目录,跑完删干净,
 * **绝不连 `~/.onething`**。自己起的进程在 `finally` 里逐个收尸。
 *
 * 跑法:`npm run gate:continuity`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
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
import {
  startFakeProvider,
  fakeProviderAiSettings,
  FAKE_PROVIDER_ENV,
} from '../../../scripts/lib/gate-fake-provider.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/** A 要够长才有「中间」可停 —— 一次种子 = 一问一答两条。 */
const SEED_A = 12
/** B 短一点就行,它只是「切走去哪儿」。 */
const SEED_B = 3
const REPLY_TEXT = 'C1 连续性门 · 假 provider 的流式回答。'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(120)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

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

async function waitForLedger(record, sessionId, count) {
  return waitFor(`账本落到 ${count} 条`, async () => {
    const got = await rpc(record, 'sessions', 'getMessages', { sessionId })
    const n = got?.messages?.length ?? 0
    return n >= count ? n : undefined
  })
}

/** 点一个 testid(理由见 gate-data.mjs 顶部:不用 page.click,不动真光标)。 */
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
 * **数请求**:在页面里把 `window.fetch` 包一层,记下每一发 `/api/rpc` 的
 * `domain.method` 与它问的会话。
 *
 * 为什么数 `sessionEvents.listRaw` 而不是别的:那**就是**重载那一发 ——
 * `data/chat-port.ts` 的 `listRaw` 是聊天区起底唯一的请求,`runLoad()` 里
 * 「先订上再拉」拉的就是它。别的域(sessions.getMessages / getUserMarkers …)
 * 是列表与目录的事,它们照打不误也不是这条病。
 *
 * 包一层而不是读 devtools 的网络面板:判据要的是**次数**,而一个计数器比一份
 * 事后 harvest 的列表少一层「有没有漏录」的怀疑。
 */
async function installRpcCounter(page) {
  await page.evaluate(() => {
    if (window.__rpcCalls) return
    window.__rpcCalls = []
    const original = window.fetch
    window.fetch = function counted(input, init) {
      try {
        const url = typeof input === 'string' ? input : (input?.url ?? '')
        if (url.includes('/api/rpc') && init?.body) {
          const body = JSON.parse(String(init.body))
          window.__rpcCalls.push({
            domain: body?.domain,
            method: body?.method,
            sessionId: body?.payload?.sessionId,
          })
        }
      } catch {
        /* 记不下来不许影响真请求 —— 这一层只是个旁听者。 */
      }
      return original.call(this, input, init)
    }
  })
}

/** 从某个记号之后,这条会话被起底过几次。 */
async function loadsSince(page, mark, sessionId) {
  return page.evaluate(
    ([from, id]) =>
      (window.__rpcCalls ?? [])
        .slice(from)
        .filter(
          (call) =>
            call.domain === 'sessionEvents' && call.method === 'listRaw' && call.sessionId === id,
        ).length,
    [mark, sessionId],
  )
}

const rpcMark = (page) => page.evaluate(() => (window.__rpcCalls ?? []).length)

/**
 * 一次把这一屏要的读数取回来。一次 evaluate 而不是四次:四次之间会插进别的帧,
 * 读到的就不是同一个瞬间的同一份布局。
 */
function readView(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="chat-stream"]')
    const rows = Array.from(document.querySelectorAll('[data-message-id]'))
    const active = document.activeElement
    return {
      scrollTop: scroll ? scroll.scrollTop : null,
      gap: scroll ? scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop : null,
      rowCount: rows.length,
      firstRowId: rows[0]?.getAttribute('data-message-id') ?? null,
      // 「一行」有多高 —— 容差按真行高算,不写一个魔法数。
      rowHeight: rows[0] ? rows[0].getBoundingClientRect().height : null,
      activeTestId: active?.getAttribute?.('data-testid') ?? null,
      activeTag: active?.tagName ?? null,
    }
  })
}

async function seedSession(record, name, turns) {
  const made = await rpc(record, 'sessions', 'create', { name })
  const sessionId = made?.session?.id
  if (!sessionId) throw new Error(`sessions.create 没给出会话 id(${name})`)
  for (let i = 0; i < turns; i += 1) {
    await rpc(record, 'session-command', 'emit', {
      sessionId,
      command: { type: 'command:send-message', content: `${name} 第 ${i + 1} 句 —— 起底要够长` },
    })
    // 一问一答落完账再发下一条:趁上一轮还在跑就发下一条走的是插话那条路。
    await waitForLedger(record, sessionId, (i + 1) * 2)
  }
  return sessionId
}

/** 进一条会话 = 在总览里点它那一行(与用户的手势同一条路:`enterSessionInWorkbench`)。 */
async function enterSession(page, sessionId, expectRows) {
  await clickTestId(page, `session-row-${sessionId}`)
  return waitFor(`会话 ${sessionId} 上屏(${expectRows} 行)`, async () => {
    const view = await readView(page)
    return view.rowCount >= expectRows ? view : undefined
  })
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[continuity-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[continuity-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'c1-continuity-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'c1-continuity-udd-'))
  let mockProvider
  let server
  let app
  try {
    console.log('\n[1/4] 起假 provider + 一台 core,种两条会话')
    mockProvider = await startFakeProvider(0, REPLY_TEXT)
    const mockPort = mockProvider.address().port
    writeFileSync(
      path.join(store, 'settings.json'),
      JSON.stringify(
        {
          ai: fakeProviderAiSettings(mockPort),
          // 工具关掉:这道门量的是连续性,不是工具循环;顺带免掉权限卡挡在中间。
          tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
          diagnostics: { enabled: false },
        },
        null,
        2,
      ),
    )
    server = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ...FAKE_PROVIDER_ENV, ONETHING_STORE_PATH: store },
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', (chunk) => serverErr.push(chunk.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch((error) => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    if (!(await portConnects(record.host, record.port))) throw new Error('core 端口连不上')

    const idA = await seedSession(record, 'C1 门 · 会话甲', SEED_A)
    const idB = await seedSession(record, 'C1 门 · 会话乙', SEED_B)

    console.log('[2/4] 拉起应用(离屏 · 独立 --user-data-dir),进会话甲')
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
    // 离屏窗自己把「我有焦点」补上 —— 只进这个窗口,不碰真光标(同 gate-focus)。
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await installRpcCounter(page)
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    await clickTestId(page, 'dock-tile-sessions')
    await waitFor('总览画出两行', () =>
      page.evaluate(
        ([a, b]) =>
          Boolean(document.querySelector(`[data-testid="session-row-${a}"]`)) &&
          Boolean(document.querySelector(`[data-testid="session-row-${b}"]`)),
        [idA, idB],
      ),
    )
    await enterSession(page, idA, SEED_A * 2)
    await delay(400)

    console.log('\n[3/4] 在甲里滚到中间,记下此刻的位置')
    /*
     * 滚到**中间**而不是顶:顶那一格与「贴底」一样是个特殊值,而这道门要证的
     * 恰恰是「任意一个位置都留得住」。赋 scrollTop 并发一次 scroll —— 与人拖
     * 滚动条走的是同一条路径(跟随状态机据此翻成 browsing)。
     */
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-stream"]')
      if (!el) return
      el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2)
      el.dispatchEvent(new Event('scroll', { bubbles: false }))
    })
    await delay(200)
    const before = await readView(page)
    assert(
      before.scrollTop !== null && before.scrollTop > 0 && before.gap > 2,
      `甲停在中间(scrollTop=${before.scrollTop}, 离底 ${before.gap?.toFixed?.(1)}px)`,
    )

    console.log('\n[4/4] 切到乙,再切回甲 —— ①零重载 ②位置一致 ③焦点在输入框')
    const mark = await rpcMark(page)
    await enterSession(page, idB, SEED_B * 2)
    await delay(300)
    await enterSession(page, idA, SEED_A * 2)
    // 起底真要发生的话,它排在进场那几帧里;多等一会儿,免得「还没来得及打」
    // 被当成「一发都没打」。
    await delay(800)
    const after = await readView(page)

    const reloadsA = await loadsSince(page, mark, idA)
    assert(
      reloadsA === 0,
      `① 切回甲**零重载**:从切走那一刻起 sessionEvents.listRaw(甲)打了 ${reloadsA} 发`,
    )

    const tolerance = Math.max(before.rowHeight ?? 0, 1)
    const drift = Math.abs((after.scrollTop ?? -1) - (before.scrollTop ?? 0))
    assert(
      drift <= tolerance,
      `② 停在离开时那一行:scrollTop ${before.scrollTop} → ${after.scrollTop}(差 ${drift.toFixed(1)}px ≤ 一行 ${tolerance.toFixed(1)}px)`,
    )
    assert(
      after.rowCount === before.rowCount && after.firstRowId === before.firstRowId,
      `   同一棵树回来(${before.rowCount} → ${after.rowCount} 行,首行 ${after.firstRowId})`,
    )
    assert(
      after.activeTestId === 'composer-input',
      `③ 焦点在输入框(此刻在 ${after.activeTestId ?? after.activeTag ?? '没有东西'} 上)`,
    )
  } finally {
    if (app) await app.close().catch(() => undefined)
    if (server) server.kill('SIGTERM')
    await delay(400)
    if (server && !server.killed) server.kill('SIGKILL')
    if (mockProvider) {
      // keep-alive 的套接字会让 close() 一直等 —— 先掐断,收尸才收得干净。
      mockProvider.closeAllConnections?.()
      await new Promise((resolve) => mockProvider.close(resolve))
    }
    await rm(store, { recursive: true, force: true }).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  }

  if (failures.length) {
    console.error(`\n[continuity-gate] FAILED —— ${failures.length} 条:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[continuity-gate] ok —— 切走再切回:不重载、停在原处、焦点在输入框')
}

main().catch((error) => {
  console.error(`\n[continuity-gate] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
