#!/usr/bin/env node
/**
 * C1 的真机门 —— **聊天跟随 + 悬浮玻璃输入框**(设计 `docs/workbench-2026-09.md` §5)。
 *
 * jsdom 那一半量的是「判据写了什么」(`content/__tests__/follow.test.ts` 八条转移、
 * `floating-composer-css.test.ts` 那条几何链)。这道门量的是**真的排版之后**那几件
 * 只有浏览器说得出来的事:
 *
 *  ① `--composer-h` 真的等于输入框的实高(它是一个量出来的数,不是一个魔法数);
 *  ② **贴底时最后一条消息的下缘 ≤ 玻璃上缘 − 气口**(§5.6 那条断言的原话);
 *  ③ **正文真的从玻璃底下流过**(上翻之后有消息的矩形与玻璃相交)——
 *     这正是用户 09-04 那句「输入框短的时候能透过它看到下面的文字」;
 *  ④ **贴底就跟**:内容一条条从外面长出来(HTTP 注入 → SSE → 折 → 上屏),
 *     每长一条都仍然在底;
 *  ⑤ **上翻就不动**:同样的注入,滚动位置一像素不动,而丸亮起来说「回到最新」;
 *  ⑥ **发送三态**:上翻时在输入框真发一条 → 不滚,丸依次画过
 *     「已发送」→ 生成中 → 「回到最新」(**流完之后不许还写「已发送」**);
 *  ⑦ **点丸** → 回到底,丸当场卸载;
 *  ⑧ TOC 键列的下缘在玻璃上缘之上(键不许钻进玻璃里);
 *  ⑨ **人自己点开的东西不许把他推到底**(2026-09-12 报障二):贴底时点开视口里
 *     一件收起着的可展开物(工具行 / 思考段 / 折痕),`scrollTop` 与那件东西的
 *     上缘都一像素不动 —— 展开与流式 delta 在几何上逐字相同,分不出来的那一半
 *     由动手的那一方自述(`content/expand-intent.ts`)。
 *
 * ── 真流从哪来(09-05 改)──────────────────────────────────────────────────
 * 这道门原先跑在一台**没有 provider** 的 core 上,于是「回复到达」这件事在真机上
 * 根本发生不了 —— 录到的丸只有 `[null, "↓ Sent"]` 一路。而**打回 1 的病灶正好藏在
 * 那之后**:回复流完了,丸还写着「已发送」,那时明明有一条没看过的回复。
 * 所以这一版接上了两个门已经在用的那台最小假 provider
 * (`scripts/lib/gate-fake-provider.mjs`,OpenAI 兼容 SSE,把一句话切三片吐出来),
 * 隔离 store 里写一份指向它的 `settings.json`。于是每一条 `command:send-message`
 * 都真的跑出一轮回复:种子是一问一答,④⑤ 长出来的也是一问一答,而 ⑥ 量的是
 * **丸那三张脸的先后**(`content/follow.ts` 的 `reply` 事件那条链,真机这一头)。
 *
 * ── 种子为什么不再走 provider(09-10;流式那几屏一个字没动)──────────────
 * **起底那一段**从前也是真的发消息:`command:send-message` 一条,等
 * `sessions.getMessages` 的条数涨到 `(i+1)*2`,再发下一条。它时红时绿,崩在
 * 「超时(20000ms)等待:账本落到 4 条」。真因由 `gate-continuity.mjs` 那一单
 * (bd016d42)查明并整段写在那只文件的「种子为什么不再走 provider」上,一句话:
 * **等的信号不对** —— `getMessages` 的条数在 `run/start` 那一刻就到位(助手消息
 * 先建空壳再往里流),而这一轮的 `run/end` 还被辅助模型(会话自动起名 / TOC)
 * 那一发拖在后面;下一条 `send-message` 落在**还开着**的那条 run 上走的是**插话**,
 * 不再产生新的一对,条数停在 3 等到超时。踩不踩中取决于起名那一发比轮询快还是慢。
 *
 * 修法与那一单同一手:**起底不发消息** —— 趁 core 停着直接写真编码的账本
 * (`scripts/lib/seed-large-ledger.mjs`),再把 core 起回来冷读一遍,竞态在结构上
 * 消失。**流式那几屏仍旧是真流**:④⑤⑥⑧ 每一条都还在走
 * `command:send-message` → 假 provider → SSE → 上屏那条整链,一个环节都没换成
 * 假的 —— 换掉的只是「起底」这段布景,而布景本来就不该由引擎跑出来。
 *
 * 那几屏为什么不受同一条竞态影响:它们**每次只发一条**,而且在下一条之前先等
 * 「那一对都上屏」;起名那一发只在这条会话的第一轮开销上,而第一轮此刻是账本里
 * 写好的,不经过引擎。
 *
 * ── 这道门**说不出**什么 ──────────────────────────────────────────────────
 * 「流式 200 段、每一帧都在底」。假 provider 一句话只切三片,量的是链路通不通,
 * 不是吞吐;要造长流得搬主仓 `sessions:shadow-battery` 那套场景矩阵,那是另一件事。
 * 丸的第三张脸**长什么样**(三颗点、一个字都不写)也不在这道门里 —— 这里只认它的
 * 无障碍名,画成什么样由单测钉(`content/__tests__/follow-pill.test.tsx`)。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * **窗子一律离屏起**(`ONETHING_GATE_HEADLESS=1`,与 gate-focus / gate-perf 同一手):
 * 不 show()、不进 Dock、不抢用户的前台;所有输入都经 CDP / `page.evaluate`,
 * 一根手指都不碰真光标。store 与 `--user-data-dir` 都是临时目录,跑完删干净,
 * **绝不连 `~/.onething`**。
 *
 * 跑法:`node scripts/gate-chat-follow.mjs`
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
import { installComposerDockProbe } from './lib/composer-dock.mjs'
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

const SESSION_NAME = 'C1 门 · 聊天跟随'
/**
 * 起底那一段的**轮**数(一问一答两条)。够长 —— 不长过一屏就没有「底」可言,
 * 整道门都不成立。09-10 起它是**直写账本**的轮数,不再是「发几条消息」
 * (为什么见下面 `SEED_FIXTURE`)。
 */
const SEED_COUNT = 12
/**
 * 起底那一段的账本长相。小一档就够 —— 这道门量的是**几何与跟随**,不是排版账
 * (那是 `gate:chat-layout` 的活),所以尺寸解算、大结果与图片一律关掉,
 * 每轮留一次工具调用让行高像真的。与 `gate-continuity.mjs` 的 `FIXTURE_B` 同型。
 */
const SEED_FIXTURE = {
  messages: SEED_COUNT * 2,
  toolCallsPerTurn: [1, 1],
  targetBytes: 0,
  targetToolCalls: 0,
  largeResults: 0,
  images: 0,
}
/** 跟底那一段一条条注进去的条数(同样各带一条回答)。 */
const FOLLOW_COUNT = 6
/** 假 provider 每次吐的那句话 —— 够短,三片就走完;够特别,肉眼一看就知道是它。 */
const REPLY_TEXT = 'C1 门 · 假 provider 的流式回答。'
/**
 * 气口的**拍板值**(09-04:40px)。
 *
 * 门里另外那条断言(「最后一条的下缘到玻璃上缘 ≥ 气口」)读的是**活的**
 * `--composer-gap` —— 它证的是「留白与那个 token 一致」,可它自己证不了那个 token
 * 没被人改小:把 token 改成 0,那条断言会以 `≥ 0` 的姿势照样绿(反证时实测如此,
 * 当时是隔壁那条「气口是空的」把它抓住的 —— 一条守卫靠邻居兜底不算守住)。
 * 所以这里再钉一条**独立的地板**。两条一起才完整:一条守「留白 = 声明的那个数」,
 * 一条守「声明的那个数就是拍板的那个数」。改这个值是一次拍板,不是一次调参。
 */
const REQUIRED_GAP = 40

/**
 * 丸那三张脸的名字,**两门语言各一份**。
 *
 * 门跑在一台全新的 store 上,locale 是缺省的 `'system'` —— 也就是这台机器的
 * `navigator.language` 说了算。断言写死中文的话,它量的就成了「跑门的人把系统
 * 语言设成了什么」;写死英文同理。所以判据是「名字属于这一张脸的那一族」,
 * 与字典一一对应(`src/i18n/{zh,en}.ts` 的 `chat.follow.*`)。
 */
const PILL_FACE = {
  sent: ['↓ 已发送', '↓ Sent'],
  reply: ['↓ 回到最新', '↓ Jump to latest'],
  streaming: ['正在生成,回到最新', 'Generating — jump to latest'],
}

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

/**
 * 等账本上落到 `count` 条消息。
 *
 * 读的是 core 自己的读面(`sessions.getMessages`),不是屏幕 —— 种子阶段应用还没起,
 * 屏幕上什么都没有;而「这一轮跑完了吗」本来就是 core 那一头的事实。
 */
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
 * 一次性把这道门要的所有几何读数取回来。
 *
 * 一次 evaluate 而不是七次:七次之间会插进别的帧,读到的就不是同一个瞬间的
 * 同一份布局 —— 而这道门比的正是「同一瞬间这几个矩形的相对位置」。
 */
function readGeometry(page) {
  return page.evaluate(() => {
    const q = (sel) => document.querySelector(sel)
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }
    }
    const scroll = q('[data-testid="chat-stream"]')
    const dock = window.__composerDock()
    const panel = q('[data-testid="composer-panel"]')
    const center = dock?.parentElement ?? null
    const rows = Array.from(document.querySelectorAll('[data-message-id]'))
    const pill = q('[data-testid="chat-follow-pill"]')
    const style = center ? getComputedStyle(center) : null
    const px = (name) => (style ? Number.parseFloat(style.getPropertyValue(name)) : Number.NaN)
    return {
      scrollTop: scroll ? scroll.scrollTop : null,
      gap: scroll ? scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop : null,
      scrollRect: rect(scroll),
      dockRect: rect(dock),
      panelRect: rect(panel),
      tocRect: rect(q('[data-testid="toc-rail"]')),
      lastRowRect: rect(rows[rows.length - 1] ?? null),
      rowCount: rows.length,
      // 「正文从玻璃底下流过」= 有消息的矩形跨过了玻璃上缘。
      rowsUnderGlass: (() => {
        const glass = panel?.getBoundingClientRect()
        if (!glass) return 0
        return rows.filter((el) => {
          const r = el.getBoundingClientRect()
          return r.bottom > glass.top && r.top < glass.bottom
        }).length
      })(),
      composerH: px('--composer-h'),
      centerH: px('--center-h'),
      composerGap: px('--composer-gap'),
      pillLabel: pill ? pill.getAttribute('aria-label') : null,
      panelBackdrop: panel ? getComputedStyle(panel).backdropFilter : null,
    }
  })
}

/** 滚到底 / 滚到顶 —— 直接赋 scrollTop 并发一次 scroll(与人拖滚动条同一条路径)。 */
async function scrollTo(page, where) {
  await page.evaluate((target) => {
    const el = document.querySelector('[data-testid="chat-stream"]')
    if (!el) return
    el.scrollTop = target === 'top' ? 0 : el.scrollHeight
    el.dispatchEvent(new Event('scroll', { bubbles: false }))
  }, where)
  await delay(120)
}

/**
 * 在输入框里「打」一段话(contenteditable,理由见 gate-chat.mjs 里的同名函数)。
 */
async function typeIntoComposer(page, text) {
  const ok = await page.evaluate((value) => {
    const box = document.querySelector('[data-testid="composer-input"]')
    if (!box) return false
    box.textContent = value
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, text)
  if (!ok) throw new Error('打不进去:[data-testid="composer-input"] 不在 DOM 里')
}

/**
 * 逐帧录丸上的名字。
 *
 * 「已发送」那张脸的寿命是**从按下发送到 run 开张**那一段 —— 这台 core 没有
 * provider,所以那一段短到轮询会漏。所以在按之前先支一台 rAF 录像机,
 * 事后读它录到过哪几句;这与「量会移出屏的元素要取在位时的矩形」是同一条纪律:
 * 短命的读数必须在它活着的时候取。
 */
async function startPillRecorder(page) {
  await page.evaluate(() => {
    window.__followLabels = []
    window.__followStop = false
    const tick = () => {
      if (window.__followStop) return
      const pill = document.querySelector('[data-testid="chat-follow-pill"]')
      const label = pill ? pill.getAttribute('aria-label') : null
      const seen = window.__followLabels
      if (seen[seen.length - 1] !== label) seen.push(label)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopPillRecorder(page) {
  return page.evaluate(() => {
    window.__followStop = true
    return window.__followLabels ?? []
  })
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[c1-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[c1-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'c1-follow-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'c1-follow-udd-'))
  let mockProvider
  let server
  let app
  try {
    console.log('\n[1/5] 起假 provider + 一台 core,种一条够长的会话')
    /*
     * 端口交给系统挑(`listen(0)`)—— 门与门之间不必再维护一张不许撞的端口表,
     * 而这台假 provider 的地址本来就只写进这一份临时 settings.json 里。
     */
    mockProvider = await startFakeProvider(0, REPLY_TEXT)
    const mockPort = mockProvider.address().port
    writeFileSync(
      path.join(store, 'settings.json'),
      JSON.stringify(
        {
          ai: fakeProviderAiSettings(mockPort),
          // 工具关掉:这道门量的是跟随,不是工具循环;顺带免掉权限卡挡在中间。
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
        // 钥匙走环境变量,不落进 settings.json(与 gate-web-shell 同一手)。
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
    const made = await rpc(core.record, 'sessions', 'create', { name: SESSION_NAME })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id`)

    /*
     * **趁 core 停着写账本**:活着的 core 会按字节大小认出「外来写手」并抛
     * `SessionEventWriteError`;停一次再起 = 冷读一遍,那道闸压根不碰。
     * 会话本身仍旧由 `sessions.create` 建(`meta.json` 是产品自己写的那一份)。
     */
    await stopCore(server)
    const seeded = seedLargeLedger(store, sessionId, SEED_FIXTURE)
    core = await startCore()
    server = core.child
    const record = core.record
    /**
     * 起底那一段落了多少条 —— 后面每一条断言都从**这个读数**往上数,不从
     * `SEED_COUNT` 推:生成器按轮取整,写下来的条数由它说了算,门只负责数。
     */
    const seededMessages = seeded.messages
    console.log(
      `      起底:${(seeded.bytes / 1024).toFixed(0)}KB / ${seededMessages} 条 / `
      + `${seeded.toolCalls} 张卡(直写账本,零 provider 往返)`,
    )
    // 冷读一遍,证明这份账本 core 认得(顺带把它读进内存,后面才有得跟)。
    await waitForLedger(record, sessionId, seededMessages)

    console.log('[2/5] 拉起应用(离屏 · 独立 --user-data-dir),进那条会话')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
        // 离屏起窗(纪律「真机门不许抢用户的机器」)。
        ONETHING_GATE_HEADLESS: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    // 离屏窗自己把「我有焦点」补上 —— 只进这个窗口,不碰真光标(同 gate-focus)。
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    /* **焦点叶里的那一块输入框**(W5-c-3):路线 A 之后屏幕上可以有好几块,
     * 门要量的是人此刻在用的那一块。判词整段在 `scripts/lib/composer-dock.mjs` 上。 */
    await installComposerDockProbe(page)
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    await clickTestId(page, 'dock-tile-sessions')
    await waitFor('总览画出那一行', () =>
      page.evaluate(
        (id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)),
        sessionId,
      ),
    )
    await clickTestId(page, `session-row-${sessionId}`)
    // 一问一答 —— 屏上该有的行数是种子条数的两倍。
    await waitFor('聊天区起底出足够多的消息', async () => {
      const geo = await readGeometry(page)
      return geo.rowCount >= seededMessages ? geo : undefined
    })
    await delay(400)

    console.log('\n[3/5] ①②③ 几何:实高 / 气口 / 正文从玻璃底下流过')
    const atBottom = await readGeometry(page)
    assert(
      Number.isFinite(atBottom.composerH) &&
        Math.abs(atBottom.composerH - atBottom.dockRect.height) <= 1,
      `--composer-h(${atBottom.composerH}px)= 输入框实高(${atBottom.dockRect.height.toFixed(1)}px)`,
    )
    assert(
      Number.isFinite(atBottom.centerH) && atBottom.centerH > 0,
      `--center-h 也量出来了(${atBottom.centerH}px)`,
    )
    assert(atBottom.gap <= 2, `进场就在底(离底 ${atBottom.gap?.toFixed(1)}px ≤ 2)`)
    assert(
      atBottom.composerGap >= REQUIRED_GAP,
      `气口是拍板的那个数(--composer-gap = ${atBottom.composerGap}px ≥ ${REQUIRED_GAP}px)`,
    )
    const clearance = atBottom.panelRect.top - atBottom.lastRowRect.bottom
    assert(
      clearance >= atBottom.composerGap - 1,
      `贴底时最后一条的下缘到玻璃上缘 ${clearance.toFixed(1)}px ≥ 气口 ${atBottom.composerGap}px`,
    )
    assert(
      atBottom.rowsUnderGlass === 0,
      `贴底时气口是空的:没有任何一条消息压在玻璃上(实测 ${atBottom.rowsUnderGlass} 条)`,
    )

    /* ── ⑨ 人自己点开的东西不许把他推到底(2026-09-12 报障二)────────────────
     *
     * 前提此刻正好成立:上面刚断言过「进场就在底」,所以跟随是 pinned,而视口里
     * 有起底那一轮留下的可展开物(工具行 / 思考段 / 折痕标签,`aria-expanded="false"`)。
     * 点开它之后两句话都要成立 ——
     *   · 容器的 `scrollTop` 一像素不动(跟底那一半没把他冲走);
     *   · 他要读的那一件自己的上缘也不动。
     * 不报意图的旧代码在这里必然红:pinned 下任何长高都贴底,展开的那一段当场被
     * 推出视野 —— 那正是报障二。判据与窗长在 `content/expand-intent.ts` /
     * `components/motion.ts` 的 `EXPAND_HOLD_MS`。
     *
     * **这一段要把后台节流关掉**:`ONETHING_GATE_HEADLESS` 下整扇窗被 Chromium 节流
     * 到 1Hz(判例写在壳 CLAUDE.md 的「离屏两档」),而这条链量的是「意图窗口内那
     * 一拍尺寸变化」—— 一秒一帧的话那一拍必然落在窗口外,量的就成了节流器不是产品。
     * 关掉、量完、开回去;整道门别的断言一格不动。
     */
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.setBackgroundThrottling(false)
    })
    const expandTarget = await page.evaluate(() => {
      const scroll = document.querySelector('[data-testid="chat-stream"]')
      const glass = document.querySelector('[data-testid="composer-panel"]')
      if (!scroll) return null
      const view = scroll.getBoundingClientRect()
      const floor = glass ? glass.getBoundingClientRect().top : view.bottom
      const all = Array.from(scroll.querySelectorAll('[aria-expanded="false"]'))
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const el = all[i]
        const r = el.getBoundingClientRect()
        if (r.height <= 0 || r.top < view.top || r.bottom > floor) continue
        el.setAttribute('data-gate-expand', '')
        return {
          top: r.top,
          kind: el.getAttribute('data-tool-status')
            ? 'tool-row'
            : (el.getAttribute('data-testid') ?? el.tagName.toLowerCase()),
        }
      }
      return null
    })
    assert(
      expandTarget !== null,
      `贴底时视口里有一件收起着的可展开物(实测:${expandTarget ? expandTarget.kind : '一件都没有'})`,
    )
    if (expandTarget) {
      const beforeExpand = await readGeometry(page)
      await page.evaluate(() => {
        const el = document.querySelector('[data-gate-expand]')
        if (el instanceof HTMLElement) el.click()
      })
      // 等得比意图窗口(`EXPAND_HOLD_MS`)长得多 —— 量的是「窗口内位置没动」的结局,
      // 不是那个数本身,所以这里不镜像它。
      await delay(900)
      const afterExpand = await page.evaluate(() => {
        const scroll = document.querySelector('[data-testid="chat-stream"]')
        const el = document.querySelector('[data-gate-expand]')
        return {
          scrollTop: scroll ? scroll.scrollTop : null,
          top: el ? el.getBoundingClientRect().top : null,
          open: el ? el.getAttribute('aria-expanded') : null,
        }
      })
      assert(afterExpand.open === 'true', `点下去那件东西真的展开了(${expandTarget.kind})`)
      assert(
        Math.abs(afterExpand.scrollTop - beforeExpand.scrollTop) <= 2,
        `点开之后 scrollTop 一像素不动(${beforeExpand.scrollTop} → ${afterExpand.scrollTop})`,
      )
      assert(
        afterExpand.top !== null && Math.abs(afterExpand.top - expandTarget.top) <= 2,
        `他要读的那一件还在原位(上缘 ${expandTarget.top.toFixed(1)} → ${afterExpand.top === null ? '不在了' : afterExpand.top.toFixed(1)})`,
      )
      // 收回去、摘掉记号:后面几段量的是**没有一件东西展开着**的那张排版。
      await page.evaluate(() => {
        const el = document.querySelector('[data-gate-expand]')
        if (el instanceof HTMLElement) el.click()
        el?.removeAttribute('data-gate-expand')
      })
      await delay(400)
    }
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.setBackgroundThrottling(true)
    })

    await scrollTo(page, 'top')
    const scrolled = await readGeometry(page)
    assert(
      scrolled.rowsUnderGlass > 0,
      `往上翻之后正文从玻璃底下流过(${scrolled.rowsUnderGlass} 条与玻璃相交)—— 输入框是浮着的,不是把聊天区截断`,
    )
    assert(
      scrolled.scrollRect.bottom >= scrolled.panelRect.bottom - 1,
      '滚动容器铺满中央区(它的下缘不高于玻璃下缘)',
    )
    assert(
      scrolled.tocRect === null ||
        scrolled.tocRect.bottom <= scrolled.panelRect.top + 1,
      scrolled.tocRect
        ? `TOC 键列的下缘 ${scrolled.tocRect.bottom.toFixed(1)} 在玻璃上缘 ${scrolled.panelRect.top.toFixed(1)} 之上`
        : 'TOC 键列此刻不在场(这条会话没有锚点)',
    )

    console.log('\n[4/5] ④⑤ 贴底就跟 / 上翻就不动')
    await scrollTo(page, 'bottom')
    let followed = 0
    for (let i = 0; i < FOLLOW_COUNT; i += 1) {
      await rpc(record, 'session-command', 'emit', {
        sessionId,
        command: { type: 'command:send-message', content: `C1 跟底第 ${i + 1} 条` },
      })
      // 一问一答两条都上屏(而且回答已经流完)才量 —— 流到一半的高度不是终值。
      await waitForLedger(record, sessionId, seededMessages + (i + 1) * 2)
      const seen = await waitFor(`第 ${i + 1} 条上屏`, async () => {
        const geo = await readGeometry(page)
        return geo.rowCount >= seededMessages + (i + 1) * 2 ? geo : undefined
      })
      await delay(200)
      const after = await readGeometry(page)
      if (after.gap <= 2 && after.pillLabel === null) followed += 1
      else
        console.log(
          `    · 第 ${i + 1} 条之后离底 ${after.gap?.toFixed(1)}px(丸=${after.pillLabel ?? '不在场'},上屏时 ${seen.rowCount} 条)`,
        )
    }
    assert(followed === FOLLOW_COUNT, `贴底时每长出一条都仍然在底(${followed}/${FOLLOW_COUNT})`)

    await scrollTo(page, 'top')
    const beforeInject = await readGeometry(page)
    await rpc(record, 'session-command', 'emit', {
      sessionId,
      command: { type: 'command:send-message', content: 'C1 上翻期间从外面长出来的一条' },
    })
    const browsing = await waitFor('丸亮起来', async () => {
      const geo = await readGeometry(page)
      return geo.pillLabel ? geo : undefined
    })
    assert(
      Math.abs(browsing.scrollTop - beforeInject.scrollTop) < 1,
      `上翻期间下面长东西**一像素不动**(${beforeInject.scrollTop} → ${browsing.scrollTop})`,
    )
    assert(
      PILL_FACE.reply.includes(browsing.pillLabel) ||
        PILL_FACE.streaming.includes(browsing.pillLabel),
      `丸亮了,说的是「${browsing.pillLabel}」(「回到最新」或「正在生成」那一族)`,
    )
    // 这一轮跑完再往下走 —— 下一段要从「没有轮次在跑」这个干净的起点开始。
    await waitForLedger(record, sessionId, seededMessages + (FOLLOW_COUNT + 1) * 2)

    console.log('\n[5/5] ⑥⑦ 发送三态 / 点丸回底')
    await scrollTo(page, 'top')
    await clickTestId(page, 'chat-follow-pill').catch(() => undefined)
    await scrollTo(page, 'top')
    await startPillRecorder(page)
    await typeIntoComposer(page, 'C1 门:上翻时发的这一条')
    const beforeSend = await readGeometry(page)
    await clickTestId(page, 'composer-send')
    // 自己那条 + 它的回答都落账 = 这一轮收场了。丸此刻该换第三张脸。
    await waitForLedger(record, sessionId, seededMessages + (FOLLOW_COUNT + 2) * 2)
    await delay(600)
    const labels = await stopPillRecorder(page)
    const afterSend = await readGeometry(page)
    const faceAt = (family) => labels.findIndex((label) => PILL_FACE[family].includes(label))
    const sentAt = faceAt('sent')
    const replyAt = faceAt('reply')
    const streamingAt = faceAt('streaming')
    assert(
      sentAt >= 0,
      `发送之后丸画过「已发送」那张脸(录到:${JSON.stringify(labels)})`,
    )
    /*
     * **打回 1 那条链的真机这一头**。「已发送」只在「自己发了、回复还没开始」
     * 那一段成立;回复一开口它就过期了。所以量的是**先后**:先「已发送」,
     * 后「回到最新」。
     *
     * 判据里**不许拿生成中那张脸顶数** —— 它骑的是 `activeMessageId`(有没有一轮
     * 在跑),压根不经过跟随状态机。反证时实测:把 `reduce` 的 `reply` 分支改成
     * 不翻转,录到的仍是 `[null,"↓ Sent","Generating…","↓ Sent"]`,拿它当判据这条
     * 断言会绿着放病过去 —— 所以这里只认 `reply` 那张脸的下标。
     */
    assert(
      sentAt >= 0 && replyAt > sentAt,
      `丸在「已发送」之后换成了「回到最新」(下标 ${sentAt} → ${replyAt};录到:${JSON.stringify(labels)})`,
    )
    assert(
      streamingAt > sentAt,
      `中间那张脸(生成中)也在,且排在「已发送」之后(下标 ${streamingAt})`,
    )
    /*
     * 收场那一刻的**定格**。丸此刻还在场(人没回底),它说的必须是「回到最新」——
     * 打回前这里会读到「已发送」:回复流完了,那张脸还在说一句过期的话。
     */
    assert(
      PILL_FACE.reply.includes(afterSend.pillLabel),
      `流完之后丸定格在「回到最新」(实测「${afterSend.pillLabel}」)`,
    )
    assert(
      Math.abs(afterSend.scrollTop - beforeSend.scrollTop) < 1,
      `上翻时发送**不滚**(${beforeSend.scrollTop} → ${afterSend.scrollTop})`,
    )

    await clickTestId(page, 'chat-follow-pill')
    await delay(400)
    const jumped = await readGeometry(page)
    assert(jumped.gap <= 2, `点丸回到底(离底 ${jumped.gap?.toFixed(1)}px)`)
    assert(jumped.pillLabel === null, '丸当场卸载(不等滚动动画)')

    /* ── ⑧ 会话多开(W5-b):**非焦点叶在流式,不抢滚动、不抢焦点** ────────
     *
     * 会话多开之后「屏幕上正在流的那一条」不一定是人正在看的那一条。跟随状态机
     * 是**每条会话一台**(W5-a 把 chat-source 拆成了实例),所以隔壁那片叶收流
     * 不该动这一片的 scrollTop,更不该把键盘抢过去。
     *
     * 判据取「什么都没发生」那一头:另一条会话真的流完了(它那片叶画出了正文),
     * 而这一片的 scrollTop 与 `document.activeElement` 一个字没变。
     */
    console.log('\n[6/6] ⑧ 两片会话叶并排:隔壁在流,这一片不动')
    const otherId = (await rpc(record, 'sessions', 'create', { name: `${SESSION_NAME}-2` }))?.session?.id
    if (!otherId) throw new Error('第二条会话没建出来')
    /*
     * **先看它在不在,再决定点不点**(W6-a):会话总览的出厂摆法改成了左架子
     * (设计 §8),而架子是常驻家具 —— 它多半已经开着,再点一下那块瓦是把整条
     * 架子收起来。判据因此从「点开它」改成「让它开着」。
     */
    const rowShown = () =>
      page.evaluate(
        (id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)),
        otherId,
      )
    /*
     * **点瓦是开关,所以最多点两下、每下之后各问一次**(与 `gate-focus` 的
     * `ensureOverviewRow` 同源)。W6-a 之后总览钉在架子上,而架子上那一块的
     * 「点一下」在**看得见**时是「收起整条架子」——一下点过去可能恰好把它关掉。
     */
    for (let attempt = 0; attempt < 3 && !(await rowShown()); attempt += 1) {
      await clickTestId(page, 'dock-tile-sessions')
      await delay(600)
    }
    await waitFor('总览画出第二行', rowShown)
    await page.evaluate((id) => {
      const row = document.querySelector(`[data-testid="session-row-${id}"]`)
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 80 }))
    }, otherId)
    await delay(400)
    const splitRight = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
      const right = items.find((el) => /在右侧|Open to the right/.test(el.textContent ?? ''))
      if (right instanceof HTMLElement) right.click()
      return Boolean(right)
    })
    assert(splitRight, '会话行右键菜单里有「在右侧」那一项')
    await delay(700)
    // 总览收回去,别盖着中央区。
    await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
    await delay(400)
    /*
     * **W6-a:两条会话落在同一条标签条上**(单叶政策,设计 §2.1)。被测的那件事
     * 一个字没改 —— 「隔壁那条在流,这一条不动」问的是**两台跟随状态机各管各的**,
     * 而它们从 W5-a 起就是按会话分实例的,与那两条住在几片叶里无关。
     * 判据因此从数叶(`data-pane-slot`)改成数**内容层**(`data-pane-tab`)。
     */
    const twoSessions = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('[data-pane-region="center"] [data-pane-tab]')).filter(
          (el) => (el.getAttribute('data-pane-tab') ?? '').startsWith('session:'),
        ).length,
    )
    assert(twoSessions === 2, `中央区那条标签条上两条会话(tabs=${twoSessions})`)

    // 把这一片(第一片 = 原来那条会话)滚到顶,并把键盘放在输入面板上。
    await scrollTo(page, 'top')
    await page.evaluate(() => {
      const box = document.querySelector('[data-testid="composer-input"]')
      if (box instanceof HTMLElement) box.focus()
    })
    await delay(200)
    const quiet = await page.evaluate(() => {
      const streams = Array.from(document.querySelectorAll('[data-testid="chat-stream"]'))
      return {
        scrollTop: streams[0]?.scrollTop ?? null,
        active: document.activeElement?.getAttribute?.('data-testid') ?? null,
        rows: streams[1]?.querySelectorAll('[data-message-id]').length ?? 0,
      }
    })

    await rpc(record, 'session-command', 'emit', {
      sessionId: otherId,
      command: { type: 'command:send-message', content: 'C1 门:隔壁那条会话说的话' },
    })
    await waitForLedger(record, otherId, 2)
    await delay(800)
    const after = await page.evaluate(() => {
      const streams = Array.from(document.querySelectorAll('[data-testid="chat-stream"]'))
      return {
        scrollTop: streams[0]?.scrollTop ?? null,
        active: document.activeElement?.getAttribute?.('data-testid') ?? null,
        rows: streams[1]?.querySelectorAll('[data-message-id]').length ?? 0,
      }
    })
    const streamsDump = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="chat-stream"]')).map((el) => ({
        tab: el.closest('[data-pane-tab]')?.getAttribute('data-pane-tab')
          ?? el.closest('[data-pane-kept]')?.getAttribute('data-pane-kept') ?? '?',
        on: Boolean(el.closest('[data-pane-on]')),
        rows: el.querySelectorAll('[data-message-id]').length,
        status: el.getAttribute('data-status') ?? '',
      })),
    )
    console.log(`      现场:${JSON.stringify(streamsDump)}`)
    assert(after.rows > quiet.rows, `隔壁那片叶真的收到了流(${quiet.rows} → ${after.rows} 行)`)
    assert(
      Math.abs((after.scrollTop ?? 0) - (quiet.scrollTop ?? 0)) < 1,
      `隔壁在流时这一片**一像素不动**(${quiet.scrollTop} → ${after.scrollTop})`,
    )
    assert(
      after.active === quiet.active,
      `隔壁在流时键盘不被抢走(${quiet.active} → ${after.active})`,
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
    console.error(`\n[c1-gate] FAILED —— ${failures.length} 条:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[c1-gate] ok —— 跟随状态机 + 悬浮玻璃输入框的几何链在真机上成立')
}

main().catch((error) => {
  console.error(`\n[c1-gate] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
