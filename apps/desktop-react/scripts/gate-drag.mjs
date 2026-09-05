#!/usr/bin/env node
/**
 * **拖拽的真机门**(W3,设计 `apps/desktop-react/docs/workbench-2026-09.md` §3;
 * 派工令交付 5 的七条 + 零重挂)。
 *
 * ── 它为什么必须是真机门 ────────────────────────────────────────────────
 * 这一批交付的东西**全部**是「指针走到哪儿 → 屏幕上哪一块矩形亮起来 → 松手之后
 * 树变成什么样」。前两件在 jsdom 里根本不存在(它不排版,`getBoundingClientRect`
 * 一律答零),所以判据可以脱开浏览器测(`workbench/__tests__/drop.test.ts` 15 条),
 * **而链路不行**。08-30 那条判例的原话:交互时序类改动必须真机对照,jsdom 的绿
 * 不算数。
 *
 * ── 七个场景(派工令逐条)────────────────────────────────────────────────
 *  1. 文件行 → 叶中心:并入、成活动 tab、**行仍在树里**
 *  2. 文件行 → 叶东带:分屏、比例 50、原叶 tab 一格不少
 *  3. tab → 窗口右边带:进右架子,架子是展开的
 *  4. tab → 空处:撕成浮窗,矩形 = `floatRectForGrab`(指针 = 标题栏中心)
 *  5. 会话行 → 架子:**拒绝**,浮影变灰带理由,树前后逐字相同
 *  6. 拖到一半 Esc:树前后相同、浮影消失、行仍在
 *  7. 零重挂:同区域内并 tab / 分屏,来源行节点与目标叶 `[data-pane-body]` 的
 *     内容根节点**前后是同一个 DOM 对象**
 *     (跨区域搬家必然换 React 宿主,那一条只写「内容逐字相同」——
 *      W4 留账 3,与 gate:files 五档断言同口径)
 *
 * ── 手势怎么派:CDP `Input.dispatchMouseEvent`,一根手指都不碰用户的机器 ───
 * 09-01 判例(系统级合成输入干扰用户用电脑,用户被迫杀掉全部任务)立的法:
 * 手势探针一律优先 CDP。这道门**没有一处** CGEvent,全部走
 * `Input.dispatchMouseEvent`(mousePressed / mouseMoved / mouseReleased,
 * `button: 'left'` + `buttons: 1`)—— 它只进这一个窗口的输入管线,真光标一动不动。
 *
 * 窗子**离屏起**(`ONETHING_GATE_HEADLESS=1`,S4 立的纪律),焦点由
 * `Emulation.setFocusEmulationEnabled` 补。
 *
 * ── 为什么 mousePressed 而不是 pointerdown ──────────────────────────────
 * Chromium 的输入管线**从鼠标事件合成 pointer 事件**:一发 `mousePressed` 到达
 * blink 之后,页面上先收到 `pointerdown` 再收到 `mousedown`。CDP 没有
 * `Input.dispatchPointerEvent` 这一口 —— 鼠标那一口就是它。所以这里派的是
 * 真实链路上真实存在的那一发,不是「模拟一个 pointerdown」。
 *
 * 跑法:`npm run gate:drag`。
 * 前置:仓根 `bun run server:build`,本目录 `npm run app:build`。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const OWNER_UID = 'local-user'
const OWNER_WID = 'default'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

/* ── 打表(照 gate-focus 的体例)────────────────────────────────────────── */

const scenarios = []
let current = null
function scenario(name) {
  current = { name, checks: [] }
  scenarios.push(current)
}
function assert(ok, message, detail) {
  current.checks.push({ ok: Boolean(ok), message, detail: detail === undefined ? '' : String(detail) })
  console.log(`   ${ok ? '✓' : '✗'} ${message}${detail === undefined ? '' : `  ${detail}`}`)
}

/* ── 手势:CDP 鼠标(见文件头)──────────────────────────────────────────── */

/**
 * 一次完整的拖拽。**中间那几发 move 不是装饰**:起拖阈值(`DRAG_START_PX` 4)要
 * 至少一发真的走过 4px 才开始,而落点判据每一帧都在算 —— 一步跳到终点与真人拖
 * 过去在链路上不是一件事(那样只会证明「一发 move 也能落」)。
 */
async function drag(cdp, from, to, { steps = 8, release = true } = {}) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from.x + ((to.x - from.x) * i) / steps),
      y: Math.round(from.y + ((to.y - from.y) * i) / steps),
      button: 'left',
      buttons: 1,
    })
    await delay(12)
  }
  if (!release) return
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: to.x,
    y: to.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  await delay(220)
}

async function releaseAt(cdp, at) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: at.x,
    y: at.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  await delay(220)
}

/**
 * 右键一块 Dock 瓦,按菜单文案选一种打开方式(照 `gate-focus.openAsFromDockMenu`)。
 * 走的是**用户真走的那条路**,不去改 store。
 */
async function openAsFromDockMenu(page, tile, labelRe) {
  const opened = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="dock-tile-${id}"]`)
    if (!(el instanceof HTMLElement)) return false
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
    return true
  }, tile)
  if (!opened) return false
  await delay(350)
  const picked = await page.evaluate((source) => {
    const re = new RegExp(source)
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'))
    const hit = items.find((el) => re.test(el.textContent ?? ''))
    if (hit instanceof HTMLElement) {
      hit.click()
      return true
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return false
  }, labelRe.source)
  await delay(600)
  return picked
}

async function clickSelector(page, selector) {
  const clicked = await page.evaluate((css) => {
    const el = document.querySelector(css)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`点不到:${selector} 不在 DOM 里`)
}

/** 一个选择器此刻的矩形中心(视口坐标 —— CDP 要的就是这个坐标系)。 */
function centerOf(page, selector) {
  return page.evaluate((css) => {
    const el = document.querySelector(css)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), rect: {
      left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height),
    } }
  }, selector)
}

/** 拼贴台此刻的形状 —— 断言「树前后逐字相同」读的就是它。 */
function treeShape(page) {
  return page.evaluate(() =>
    JSON.stringify(
      Object.fromEntries(
        Array.from(document.querySelectorAll('[data-pane-region]')).map((host) => [
          host.getAttribute('data-pane-region'),
          Array.from(host.querySelectorAll('[data-pane-slot]')).map((slot) => ({
            leaf: slot.getAttribute('data-pane-slot'),
            tabs: Array.from(slot.querySelectorAll('[data-pane-tab]')).map((t) =>
              t.getAttribute('data-pane-tab'),
            ),
          })),
        ]),
      ),
    ),
  )
}

/**
 * 给一批节点打上一格**身份戳**,搬完之后再问「还是不是同一个」。
 *
 * 零重挂断言的唯一诚实判法(CLAUDE.md:「前后是同一个 DOM 节点」)—— 属性会跟着
 * 重挂一起没,所以戳还在 = 那个节点从头到尾就是它。
 */
async function stamp(page, selector, mark) {
  return page.evaluate(
    ([css, m]) => {
      const el = document.querySelector(css)
      if (!el) return false
      el.setAttribute('data-gate-stamp', m)
      return true
    },
    [selector, mark],
  )
}

function stampSurvives(page, selector, mark) {
  return page.evaluate(
    ([css, m]) => document.querySelector(css)?.getAttribute('data-gate-stamp') === m,
    [selector, mark],
  )
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[drag-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[drag-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'drag-gate-store-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'drag-gate-ws-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'drag-gate-userdata-'))
  const cwd = path.join(workspaceRoot, OWNER_UID, OWNER_WID)
  let server
  let app
  try {
    console.log('[1/3] 造一棵真目录树 + 一台 core')
    await mkdir(cwd, { recursive: true })
    await writeFile(path.join(cwd, 'alpha.ts'), "export const alpha = 1\n")
    await writeFile(path.join(cwd, 'beta.ts'), "export const beta = 2\n")
    await writeFile(path.join(cwd, 'gamma.ts'), "export const gamma = 3\n")

    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_SERVER_WORKSPACE_ROOT: workspaceRoot,
      },
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

    const created = await rpc(record, 'sessions', 'create', { name: 'drag-gate' })
    const sessionId = created?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(created)}`)
    await rpc(record, 'sessions', 'updateWorkingDirectory', { sessionId, workingDirectory: cwd })
    // 第二条会话:场景 5 拖的就是它(拖当前那一条落中央等于什么都没换)。
    await rpc(record, 'sessions', 'create', { name: 'drag-gate-2' })

    console.log('[2/3] 拉起应用(离屏 · 独立 --user-data-dir)')
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
    await waitFor('Dock 就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="dock-tile"]'))),
    )
    await clickSelector(page, '[data-testid="dock-tile-sessions"]')
    await waitFor('总览画出那一行', () =>
      page.evaluate((id) => Boolean(document.querySelector(`[data-session-id="${id}"]`)), sessionId),
    )
    await clickSelector(page, `[data-testid="session-row-${sessionId}"]`)
    await clickSelector(page, '[data-testid="dock-tile-files"]')
    await waitFor('文件树画出行', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-file-path]'))),
    )
    /*
     * **文件面板先钉到左边**(走 Dock 瓦的右键菜单 = 用户真走的那条路)。
     *
     * 理由是这道门第一版当场量出来的一件事:文件面板的出厂落点是**浮窗**,
     * 而浮窗默认 880×520 居中 —— 它把中央叶的整个中心区盖住了。于是「拖到中央叶
     * 的中心」那一下落进的是那扇浮窗自己的叶(**判据没错**:那扇窗盖在最上面,
     * 拖到它身上本来就该落进它 —— 这正是「叶重叠时取最上」)。钉到左边之后
     * 中央区腾出来,场景 1 / 2 量的才是它们要量的那件事。
     */
    const pinnedLeft = await openAsFromDockMenu(page, 'files', /左侧栏|左边|Left/)
    await delay(400)
    const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))

    console.log('[3/3] 逐个场景')

    /* ── 场景 1:文件行 → 中央叶中心 ─────────────────────────────────────── */
    scenario('文件行拖到中央叶的中心区 = 并入、成活动 tab、行仍在树里,零重挂')
    {
      assert(pinnedLeft, '文件面板钉到了左边(中央区腾出来)')
      const alpha = `[data-file-path="${path.join(cwd, 'alpha.ts')}"]`
      const row = await centerOf(page, alpha)
      const leaf = await centerOf(page, '[data-pane-region="center"] [data-pane-slot]')
      assert(Boolean(row && leaf), '起点与落点都量得到', JSON.stringify({ row: row?.rect, leaf: leaf?.rect }))
      // 零重挂:给来源行与目标叶的身体各打一格戳。
      await stamp(page, alpha, 'src-row')
      await stamp(page, '[data-pane-region="center"] [data-pane-body]', 'leaf-body')
      await drag(cdp, row, { x: leaf.x, y: leaf.y })
      const tabs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-pane-region="center"] [data-pane-tab]')).map((el) =>
          el.getAttribute('data-pane-tab'),
        ),
      )
      assert(
        tabs.includes(`file:${path.join(cwd, 'alpha.ts')}`),
        '这一格并进了中央叶',
        tabs.join(' | '),
      )
      const on = await page.evaluate(() =>
        document
          .querySelector('[data-pane-region="center"] [data-pane-tab][data-pane-on]')
          ?.getAttribute('data-pane-tab'),
      )
      assert(on === `file:${path.join(cwd, 'alpha.ts')}`, '而且成了活动 tab', on)
      assert(await page.evaluate((css) => Boolean(document.querySelector(css)), alpha), '来源那一行仍在树里')
      assert(await stampSurvives(page, alpha, 'src-row'), '零重挂:来源行是同一个 DOM 节点')
      assert(
        await stampSurvives(page, '[data-pane-region="center"] [data-pane-body]', 'leaf-body'),
        '零重挂:目标叶的内容根是同一个 DOM 节点',
      )
    }

    /* ── 场景 2:文件行 → 叶东带 ─────────────────────────────────────────── */
    scenario('文件行拖到叶东带 = 分屏、比例 50、原叶 tab 一格不少')
    {
      const beta = `[data-file-path="${path.join(cwd, 'beta.ts')}"]`
      const row = await centerOf(page, beta)
      const leaf = await centerOf(page, '[data-pane-region="center"] [data-pane-slot]')
      /*
       * 「原叶 tab 一格不少」问的是**那一片叶**,所以先记下它的 id ——
       * `:first-of-type` 在分屏之后指的可能是新长出来的那一片。
       */
      const originId = await page.evaluate(
        () =>
          document
            .querySelector('[data-pane-region="center"] [data-pane-slot]')
            ?.getAttribute('data-pane-slot') ?? '',
      )
      const countIn = (id) =>
        page.evaluate(
          (leafId) =>
            document.querySelectorAll(`[data-pane-slot="${CSS.escape(leafId)}"] [data-pane-tab]`).length,
          id,
        )
      const before = await countIn(originId)
      await stamp(page, '[data-pane-region="center"] [data-pane-body]', 'leaf-body-2')
      /*
       * 东带 = 叶右缘往里 **60px**。
       *
       * 不是 6px:中央叶在这台布局里**贴着窗口右缘**,而窗口边带(`SNAP_BAND` 24)
       * **优先于**叶的四带(`drop.ts` 文件头那条「次序即语义」)—— 第一版写 6px
       * 时这一格当场把文件钉进了右架子,读数是 `slots=1` + 右架子里多了一格。
       * 那是判据在按设计工作,不是 bug;门要量东带就得站在两条带子不重叠的地方
       * (内缩 25% 之外、边带 24 之内)。
       */
      const east = { x: leaf.rect.left + leaf.rect.width - 60, y: leaf.y }
      await drag(cdp, row, east)
      const slots = await page.evaluate(() =>
        document.querySelectorAll('[data-pane-region="center"] [data-pane-slot]').length,
      )
      assert(slots === 2, '中央区变成两片叶', `slots=${slots}`)
      const ratio = await page.evaluate(
        () =>
          document
            .querySelector('[data-pane-region="center"] [data-pane-seam] [role="separator"]')
            ?.getAttribute('aria-valuenow') ?? null,
      )
      assert(ratio === '50', '比例 50', `aria-valuenow=${ratio}`)
      const after = await countIn(originId)
      assert(after >= before, '原叶 tab 一格不少', `${before} → ${after}`)
      assert(
        await stampSurvives(page, '[data-pane-region="center"] [data-pane-body]', 'leaf-body-2'),
        '零重挂:分屏之后留下来那片叶的内容根还是同一个节点',
      )
    }

    /* ── 场景 3:tab → 窗口右边带 ────────────────────────────────────────── */
    scenario('把一格 tab 拖到窗口右边带 = 进右架子,架子展开')
    {
      const tab = await centerOf(page, '[data-testid="topbar-tabs"] [role="tab"]:last-of-type')
      assert(Boolean(tab), '顶栏上有可拖的标签', JSON.stringify(tab?.rect))
      await drag(cdp, tab, { x: viewport.w - 6, y: Math.round(viewport.h / 2) })
      const shelf = await page.evaluate(() => {
        const el = document.querySelector('[data-shelf="right"]')
        if (!el) return null
        return {
          collapsed: /collapsed/i.test(el.className),
          tabs: Array.from(el.querySelectorAll('[data-pane-tab]')).map((t) => t.getAttribute('data-pane-tab')),
        }
      })
      assert(Boolean(shelf), '右架子出现了', JSON.stringify(shelf))
      assert(shelf && shelf.tabs.length > 0, '那一格落进了右架子', JSON.stringify(shelf?.tabs))
      assert(shelf && !shelf.collapsed, '而且架子是展开的')
    }

    /* ── 场景 4:tab → 空处 = 撕成浮窗 ───────────────────────────────────── */
    scenario('把一格 tab 拖出这扇窗 = 撕成浮窗,矩形按 floatRectForGrab')
    {
      const countFloats = () =>
        page.evaluate(() => document.querySelectorAll('[data-float-body]').length)
      const before = await countFloats()
      const tab = await centerOf(page, '[data-shelf="right"] [role="tab"]')
      assert(Boolean(tab), '架子上有可拖的标签', JSON.stringify(tab?.rect))
      /*
       * **「什么都没碰到」今天等于「拖出这扇窗」**(本批真机量出来的一条事实,
       * 记在交卷报告的留账里):中央区那棵树是**满铺**的 —— 窗子里任何一点都落在
       * 某一片叶上,所以窗内根本不存在设计 §3.1 说的那个「空处」。拖到窗外
       * (这里是下缘之外 30px)才是真的什么都没碰到,而那也正是每个编辑器里
       * 「拖出去 = 开一扇新窗」的手势。
       */
      const drop = { x: Math.round(viewport.w * 0.4), y: viewport.h + 30 }
      await drag(cdp, tab, drop)
      const floats = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-float-body]')).map((el) => {
          const win = el.closest('[role="dialog"]') ?? el
          const r = win.getBoundingClientRect()
          return {
            left: Math.round(r.left), top: Math.round(r.top),
            width: Math.round(r.width), height: Math.round(r.height),
          }
        }),
      )
      assert(floats.length === before + 1, '多出一扇浮窗', `${before} → ${floats.length}`)
      const win = floats[floats.length - 1]
      /*
       * `floatRectForGrab` 的约定:**指针 = 标题栏中心**(横向居中、纵向落在标题栏
       * 一半高处),再过一次 `clampFloatRect`。
       *
       * 横向中线该落在松手那一点上(这一点离左右边都够远,钳不动它)。
       * 纵向那一头**不断言「整扇窗在视口里」**(第一版写错过一次,读数
       * `top=820 h=520`):`clampFloatRect` 是**手势那把尺**,它的原话是
       * 「允许出界,只保证至少 `FLOAT_KEEP`=40 那么一截留在视口里,纵向下界 0」
       * —— 标题栏被推出屏顶就再也拖不回来了,而底下探出去一截是拖窗时天天发生
       * 的正常事。所以这里断言的正是那把尺:**窗顶在视口内,而且不在指针下方**
       * (= 用户抓着的是标题栏)。
       */
      const cx = win.left + win.width / 2
      assert(Math.abs(cx - drop.x) <= 4, '窗的横向中线落在松手那一点上', `cx=${cx} drop.x=${drop.x}`)
      assert(
        win.top >= 0 && win.top <= viewport.h - 40,
        '窗顶落在视口里(clampFloatRect 的 FLOAT_KEEP=40 那条)',
        `top=${win.top} viewport.h=${viewport.h}`,
      )
      assert(win.top <= drop.y, '窗顶不在指针下方(抓着的是标题栏)', `top=${win.top} drop.y=${drop.y}`)
    }

    /* ── 场景 5:会话行 → 架子 = 拒绝 ────────────────────────────────────── */
    scenario('会话行拖到架子 = 结构化拒绝,树前后逐字相同')
    {
      await clickSelector(page, '[data-testid="dock-tile-sessions"]')
      await waitFor('总览就位', () =>
        page.evaluate(() => Boolean(document.querySelector('[data-session-id]'))),
      )
      const rowSel = '[data-session-id]:not([aria-selected="true"])'
      const row = await centerOf(page, rowSel)
      assert(Boolean(row), '总览里有一条别的会话可拖', JSON.stringify(row?.rect))
      const before = await treeShape(page)
      // 走到右边带上停住(不松手)—— 先量拒绝态,再松手量「什么都没发生」。
      const at = { x: viewport.w - 6, y: Math.round(viewport.h / 2) }
      await drag(cdp, row, at, { release: false })
      const refuse = await page.evaluate(() => {
        const ghost = document.querySelector('[data-testid="drag-ghost"]')
        return {
          ghost: Boolean(ghost),
          refused: ghost?.hasAttribute('data-refuse') ?? false,
          reason: document.querySelector('[data-testid="drag-refuse"]')?.textContent ?? '',
          overlayTone: document.querySelector('[data-testid="drop-overlay"]')?.getAttribute('data-tone') ?? null,
        }
      })
      assert(refuse.ghost, '浮影在屏幕上')
      assert(refuse.refused, '浮影是拒绝态(变灰)')
      assert(refuse.reason.length > 0, '而且说得出理由(不静默)', refuse.reason)
      assert(refuse.overlayTone === null, '拒绝时不画一块接受色的高亮', String(refuse.overlayTone))
      await releaseAt(cdp, at)
      const afterShape = await treeShape(page)
      assert(afterShape === before, '松手之后树前后逐字相同', afterShape === before ? '' : `\n     前:${before}\n     后:${afterShape}`)
    }

    /* ── 场景 6:拖到一半 Esc ────────────────────────────────────────────── */
    scenario('拖到一半按 Esc = 取消:树不变、浮影消失、行仍在')
    {
      const gamma = `[data-file-path="${path.join(cwd, 'gamma.ts')}"]`
      const treeThere = await page.evaluate((css) => Boolean(document.querySelector(css)), gamma)
      if (!treeThere) {
        // 总览此刻盖着文件面板 —— 把文件面板点回前台(点瓦 = 露出来)。
        await clickSelector(page, '[data-testid="dock-tile-files"]')
        await delay(500)
      }
      await waitFor('文件树在场', () =>
        page.evaluate((css) => Boolean(document.querySelector(css)), gamma),
      )
      const row = await centerOf(page, gamma)
      const leaf = await centerOf(page, '[data-pane-region="center"] [data-pane-slot]')
      const before = await treeShape(page)
      await drag(cdp, row, { x: leaf.x, y: leaf.y }, { release: false })
      assert(
        await page.evaluate(() => Boolean(document.querySelector('[data-testid="drag-ghost"]'))),
        '拖起来了(浮影在场)',
      )
      await page.keyboard.press('Escape')
      await delay(160)
      assert(
        !(await page.evaluate(() => Boolean(document.querySelector('[data-testid="drag-ghost"]')))),
        'Esc 之后浮影消失',
      )
      // 松手补齐这一次手势(取消之后这一发不该再落定任何东西)。
      await releaseAt(cdp, { x: leaf.x, y: leaf.y })
      assert((await treeShape(page)) === before, '树前后逐字相同')
      assert(await page.evaluate((css) => Boolean(document.querySelector(css)), gamma), '来源那一行仍在树里')

      /*
       * ── 第二半:拖的是**一格已经开着的 tab**(这一半才咬得住那条反证)────
       * 上面拖的是文件树的一行 —— 它本来就不在树上,所以「摘原位提前到起拖」
       * 那种写法在它身上是空动作,量不出来。一格 tab 不一样:提前摘的话
       * Esc 取消之后它就再也回不来了。派工令反证第四条要的正是这一格。
       */
      const tabBefore = await treeShape(page)
      const tabAt = await centerOf(page, '[data-testid="topbar-tabs"] [role="tab"]:last-of-type')
      if (!tabAt) {
        assert(false, '顶栏上有一格开着的 tab 可拖')
      } else {
        await drag(cdp, tabAt, { x: Math.round(viewport.w * 0.5), y: Math.round(viewport.h * 0.5) }, {
          release: false,
        })
        assert(
          await page.evaluate(() => Boolean(document.querySelector('[data-testid="drag-ghost"]'))),
          '一格 tab 也拖得起来(浮影在场)',
        )
        await page.keyboard.press('Escape')
        await delay(160)
        await releaseAt(cdp, { x: Math.round(viewport.w * 0.5), y: Math.round(viewport.h * 0.5) })
        const tabAfter = await treeShape(page)
        assert(
          tabAfter === tabBefore,
          'Esc 之后那一格 tab **仍在原位**(摘原位提前到起拖的话这里会红)',
          tabAfter === tabBefore ? '' : `\n     前:${tabBefore}\n     后:${tabAfter}`,
        )
      }
    }

    /* ── 场景 7:跨区域搬家 —— 内容逐字相同(W4 留账 3 的口径)──────────── */
    scenario('跨区域搬家:必然换 React 宿主,所以只断言「内容逐字相同」')
    {
      /*
       * 搬的是 **beta.ts 那一格**,不是「中央区此刻活动的那一格」——
       * 后者是聊天,而 `chat` 这一种自述了 `regions: ['center']`(设计 §1.1:
       * 「今天只有 chat 在 T4 之前限定 center」)。第一版取的是活动那一格,
       * 读数是「region 还是 center」——那不是拖拽没生效,是**种类自述把它拦下了**,
       * 判据在按设计工作。要量跨区域,就得拿一格搬得动的内容。
       */
      const name = 'beta.ts'
      const tab = await page.evaluate((n) => {
        const el = Array.from(
          document.querySelectorAll('[data-pane-region="center"] [data-pane-tab]'),
        ).find((t) => (t.getAttribute('data-pane-tab') ?? '').endsWith(n))
        return el ? { id: el.getAttribute('data-pane-tab'), text: (el.textContent ?? '').slice(0, 200) } : null
      }, name)
      if (!tab) {
        assert(false, `中央区有一格 ${name} 可搬`)
      } else {
        const handle = await page.evaluate((n) => {
          const el = Array.from(
            document.querySelectorAll('[data-testid="topbar-tabs"] [role="tab"]'),
          ).find((t) => (t.textContent ?? '').includes(n))
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        }, name)
        assert(Boolean(handle), `顶栏上 ${name} 那一格标签量得到`, JSON.stringify(handle))
        await drag(cdp, handle, { x: 6, y: Math.round(viewport.h / 2) })
        const after = await page.evaluate((id) => {
          const el = document.querySelector(`[data-pane-tab="${CSS.escape(id)}"]`)
          if (!el) return null
          const host = el.closest('[data-pane-region]')
          return { region: host?.getAttribute('data-pane-region') ?? null, text: (el.textContent ?? '').slice(0, 200) }
        }, tab.id)
        assert(Boolean(after), '那一格还在屏幕上', JSON.stringify(after))
        assert(after && after.region !== 'center', '而且换了区域', after?.region)
        assert(after && after.text === tab.text, '内容逐字相同(跨区域不保 DOM 身份 —— W4 留账 3)')
      }
    }

    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }

  console.log('\n────────── 逐场景读数 ──────────')
  let red = 0
  scenarios.forEach((s, i) => {
    const bad = s.checks.filter((c) => !c.ok)
    red += bad.length
    console.log(`场景 ${i + 1} ${bad.length ? `红 ${bad.length}/${s.checks.length}` : '绿'}  ${s.name}`)
    for (const c of bad) console.log(`   ✗ ${c.message}${c.detail ? `  ${c.detail}` : ''}`)
  })
  const total = scenarios.reduce((n, s) => n + s.checks.length, 0)
  console.log(`合计 ${red} 条红 / ${total} 条断言`)
  if (red) {
    console.error('\n[drag-gate] FAILED')
    process.exit(1)
  }
  console.log(`\n[drag-gate] ok —— ${scenarios.length} 个场景全绿`)
}

main().catch((error) => {
  console.error('\n[drag-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
