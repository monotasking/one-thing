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
 *  ① **零重载** —— 从「切走」那一刻起,**起底那一发**(第 5 单之后是
 *     `resources.read(session:<id>, 'page')`,读不成才退回 `sessionEvents.listRaw`)
 *     对这条会话**一发都不许打**。判据是**数请求次数,不是量时间**:量时间会把一台慢机器
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
import { seedLargeLedger } from './lib/seed-large-ledger.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/*
 * ── 夹具(09-10 换掉了「真的发消息种」那一版)────────────────────────────
 *
 * 甲要够长才有「中间」可停,而且**要够大**:这道门证的是「切走再切回不重载、
 * 停在原处」,而只有在真店那个量级上,「重载」与「不重载」才是用户分得出来的
 * 两件事(24 行的树上重载一次也不过几毫秒)。两条会话都由
 * `lib/seed-large-ledger.mjs` 直接写账本 —— 见下面「种子为什么不再走 provider」。
 */
const FIXTURE_A = { messages: 400 }
/** B 小一档就行,它只是「切走去哪儿」。 */
const FIXTURE_B = { messages: 120, targetBytes: 0, targetToolCalls: 0, largeResults: 2, images: 2 }
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
 * 为什么数**起底那一发**:它就是重载。第 5 单(72e4f76c)之后起底换了路 ——
 * 冷载走的是 `resources.read(ref='session:<id>', name='page')` 那条尾页读,
 * `sessionEvents.listRaw` 只在页读不成时兜底。**两条都要数**:只数 listRaw 的话
 * 这道门今天恒等于 0,红不起来 —— 那不是「治好了」,是尺子量的东西已经不在了。
 * 别的域(sessions.getMessages / getUserMarkers …)是列表与目录的事,它们照打
 * 不误也不是这条病。
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
            // 资源面那条路上「问的是哪条会话」写在 ref 里,不在 sessionId 上。
            ref: body?.payload?.ref,
            name: body?.payload?.name,
          })
        }
      } catch {
        /* 记不下来不许影响真请求 —— 这一层只是个旁听者。 */
      }
      return original.call(this, input, init)
    }
  })
}

/**
 * 一发 RPC 算不算「把这条会话起底了一次」。
 * 两条产地:尾页读(今天的那条)与整份账本(兜底那条)。判据写在页面里跑,
 * 所以它得是一段自足的源码 —— 见 `loadsSince` 里那句 `new Function`。
 */
const IS_SESSION_LOAD = `(call, id) => (
  (call.domain === 'sessionEvents' && call.method === 'listRaw' && call.sessionId === id)
  || (call.domain === 'resources' && call.method === 'read'
      && call.ref === 'session:' + id && call.name === 'page')
)`

/** 从某个记号之后,这条会话被起底过几次。 */
async function loadsSince(page, mark, sessionId) {
  return page.evaluate(
    ([from, id, judgeSource]) => {
      const isSessionLoad = new Function('return ' + judgeSource)()
      return (window.__rpcCalls ?? [])
        .slice(from)
        .filter(
          (call) =>
            isSessionLoad(call, id),
        ).length
    },
    [mark, sessionId, IS_SESSION_LOAD],
  )
}

const rpcMark = (page) => page.evaluate(() => (window.__rpcCalls ?? []).length)

/**
 * 一次把这一屏要的读数取回来。一次 evaluate 而不是四次:四次之间会插进别的帧,
 * 读到的就不是同一个瞬间的同一份布局。
 */
function readView(page) {
  return page.evaluate(() => {
    /*
     * **显示中的那一片**优先(`[data-pane-on]`)。停靠着的那几棵树(视图池 3)
     * 也在 DOM 上,裸选择器会随手拿到隔壁那一片 —— 读的就不是屏幕上这一条了。
     * 判词与 `gate:chat-layout` 的取件逐字同源。
     */
    const scroll =
      document.querySelector('[data-pane-on] [data-testid="chat-stream"]')
      ?? document.querySelector('[data-testid="chat-stream"]')
    const rows = Array.from(scroll?.querySelectorAll('[data-message-id]') ?? [])
    const active = document.activeElement
    /*
     * **视口里最上面那条还露着的消息**(与 `measureScrollAnchor` / gate-chat-layout
     * 的 ⑨ 同一条判据)。它与 `scrollTop` 回答的不是同一个问题:前者是「眼睛看到
     * 的还是那一行吗」,后者是「滚动条停在同一个数吗」——在一棵屏外行走
     * `content-visibility: auto`(报**估高**)的大树上,后者会随 `scrollHeight`
     * 重新估算而漂,前者不会。两个都读出来,红的时候才分得清是哪一种。
     */
    let anchor = null
    if (scroll) {
      const base = scroll.getBoundingClientRect().top
      for (const row of rows) {
        const rect = row.getBoundingClientRect()
        if (rect.bottom <= base) continue
        anchor = { id: row.getAttribute('data-message-id'), offset: Math.round(rect.top - base) }
        break
      }
    }
    return {
      anchor,
      scrollHeight: scroll ? Math.round(scroll.scrollHeight) : null,
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

/**
 * 建一条空会话(`meta.json` 因此是产品自己写的那一份)。账本**不在这里种** ——
 * 要趁 core 停着写,见下面 `seedLedgers`。
 */
async function createSession(record, name) {
  const made = await rpc(record, 'sessions', 'create', { name })
  const sessionId = made?.session?.id
  if (!sessionId) throw new Error(`sessions.create 没给出会话 id(${name})`)
  return sessionId
}

/*
 * ── 种子为什么不再走 provider(09-10,一条真 bug 的收尸)──────────────────
 *
 * 从前这道门是**真的发消息**种会话:`command:send-message` 一条,然后等
 * `sessions.getMessages` 的条数涨到 `(i+1)*2`,再发下一条。它三次里红两次,
 * 崩在同一句:`超时(20000ms)等待:账本落到 4 条`。
 *
 * **真因不是慢,是等的信号不对。** 崩住那一份账本的事件序列是:
 *
 *   user/message → run/start → … → request/end → **user/message** →
 *   auxiliary-model/result → **run/end**
 *
 * 两件事叠在一起:
 *  ① `getMessages` 的条数在 **`run/start`** 那一刻就到位 —— 助手消息是**先建
 *     空壳、再往里流**的,所以「条数够了」证明的是「这一轮开始了」,**不是**
 *     「这一轮跑完了」;
 *  ② 这一轮的 `run/end` 还被**辅助模型**(会话自动起名)那一发拖在后面,它也
 *     打同一台假 provider。
 * 于是下一条 `send-message` 落在**还开着**的那条 run 上,走的是**插话**那条路
 * —— 不再产生新的一对消息,条数永远停在 3,等到 20 秒超时为止。是不是踩中,
 * 取决于起名那一发比轮询快还是慢,所以它「时红时绿」。
 *
 * 修法不是把 20 秒改成 60 秒(那只是把骰子多摇几次),也不是去等 `run/end`
 * (那要再引一套 SSE 订阅进这道门,而它要证的根本不是引擎)。修法是**根本不发
 * 消息**:趁 core 停着直接写真编码的账本,再把 core 起回来冷读一遍 —— 与
 * `gate:chat-layout` 同一手。种子阶段一次 provider 往返都不发,这条竞态在结构上
 * 消失,顺带把夹具从 24 行抬到真店量级。
 *
 * 假 provider 仍然起着:`settings.json` 里要有一份指向本机的 `ai` 配置,免得
 * 任何一条路径不小心真的打到网上去。它在这道门里从头到尾一次都不会被调用。
 */
function seedLedgers(store, entries) {
  const out = {}
  for (const [key, sessionId, fixture] of entries) {
    out[key] = seedLargeLedger(store, sessionId, fixture)
  }
  return out
}

/**
 * 进一条会话 = 在总览里点它那一行(与用户的手势同一条路:`enterSessionInWorkbench`)。
 *
 * ── 等的是**哪一行在不在**,不是「行数够不够」(09-10,第 6 单收的一条真红)──
 * 从前这里等 `rowCount >= 夹具的消息条数`。那句话里藏着一个前提:**壳手里有
 * 整条会话**。第 5 单(72e4f76c)之后不再成立 —— 冷载拉的是尾页(24 条),更早
 * 的由上翻按需补,于是这道门等 400 行等到超时,**而那不是回归,是新的正确行为**。
 * 判词与 `gate:chat-layout` 的 `sessionTreeUp` 逐字同源;判「在 DOM 上」而不是
 * 「在视口里」,理由也一样:这道门的 ② 恰恰要它**不**落在底(停在离开时那一行)。
 */
async function enterSession(page, sessionId, lastMessageId) {
  await clickTestId(page, `session-row-${sessionId}`)
  return waitFor(`会话 ${sessionId} 的树立起来(${lastMessageId} 在树上)`, async () => {
    const up = await page.evaluate((id) => {
      const scroll =
        document.querySelector('[data-pane-on] [data-testid="chat-stream"]')
        ?? document.querySelector('[data-testid="chat-stream"]')
      const row = scroll?.querySelector(`[data-message-id="${id}"]`)
      return Boolean(row && row.getBoundingClientRect().height > 0)
    }, lastMessageId)
    return up ? await readView(page) : undefined
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
    console.log('\n[1/4] 起假 provider + 一台 core,建两条会话并写真店规模的账本')
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
    /** 起一台 core,等它写出发现文件。种子要停一次再起,所以这一段是个函数。 */
    const startCore = async () => {
      const child = spawn(process.execPath, [serverEntry], {
        env: { ...process.env, ...FAKE_PROVIDER_ENV, ONETHING_STORE_PATH: store },
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const serverErr = []
      child.stderr.on('data', (chunk) => serverErr.push(chunk.toString()))
      const found = await waitFor('core 写出发现文件', () => {
        const got = readDiscovery(store)
        return got && got.pid === child.pid ? got : undefined
      }).catch((error) => {
        throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
      })
      if (!(await portConnects(found.host, found.port))) throw new Error('core 端口连不上')
      return { child, record: found }
    }
    const stopCore = async (child) => {
      if (!child) return
      child.kill('SIGTERM')
      await delay(1200)
      if (!child.killed) child.kill('SIGKILL')
      await delay(300)
    }

    let core = await startCore()
    server = core.child
    const idA = await createSession(core.record, 'C1 门 · 会话甲')
    const idB = await createSession(core.record, 'C1 门 · 会话乙')

    // 趁 core 停着写账本:冷启一次全读,不碰「外来写手」那道闸。
    await stopCore(server)
    const seeded = seedLedgers(store, [['A', idA, FIXTURE_A], ['B', idB, FIXTURE_B]])
    for (const [name, stat] of Object.entries(seeded)) {
      console.log(
        `      ${name}:${(stat.bytes / 1024 / 1024).toFixed(1)}MB / ${stat.messages} 条 / `
        + `${stat.toolCalls} 张卡 / ${stat.blobs} 个 blob`,
      )
    }
    core = await startCore()
    server = core.child

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
    await enterSession(page, idA, seeded.A.lastMessageId)
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
    await enterSession(page, idB, seeded.B.lastMessageId)
    await delay(300)
    await enterSession(page, idA, seeded.A.lastMessageId)
    // 起底真要发生的话,它排在进场那几帧里;多等一会儿,免得「还没来得及打」
    // 被当成「一发都没打」。
    await delay(800)
    const after = await readView(page)

    const reloadsA = await loadsSince(page, mark, idA)
    assert(
      reloadsA === 0,
      `① 切回甲**零重载**:从切走那一刻起,甲的起底(尾页读 / listRaw)打了 ${reloadsA} 发`,
    )

    /*
     * ② 的判据是**锚点行 + 行内偏移**,不是裸 `scrollTop`(09-10 换大夹具时改的):
     * 屏外行走 `content-visibility: auto` 只按估高占位,切走再切回来那一路里屏外行
     * 重新估高会让整棵树矮几千像素,`scrollTop` 跟着变而**用户眼里的那一行一像素
     * 没动**(实测同一行同一偏移、树高 121156 → 114748、scrollTop 差 2770)。
     * 用户看见的是行,门就判行 —— 与 `gate:chat-layout` ⑨ 同一把尺子。
     */
    const ANCHOR_DRIFT_PX = 8
    const anchorDrift =
      before.anchor?.id !== undefined && before.anchor?.id === after.anchor?.id
        ? Math.abs((after.anchor?.offset ?? 0) - (before.anchor?.offset ?? 0))
        : Number.POSITIVE_INFINITY
    console.log(
      `      锚点:${before.anchor?.id}@${before.anchor?.offset}px → ${after.anchor?.id}@${after.anchor?.offset}px;`
      + `树高 ${before.scrollHeight} → ${after.scrollHeight}px;scrollTop ${before.scrollTop} → ${after.scrollTop}`,
    )
    assert(
      anchorDrift <= ANCHOR_DRIFT_PX,
      `② 停在离开时那一行:锚点行 ${before.anchor?.id} → ${after.anchor?.id},行内偏移差 ${Number.isFinite(anchorDrift) ? anchorDrift.toFixed(1) : '∞'}px ≤ ${ANCHOR_DRIFT_PX}px`,
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
