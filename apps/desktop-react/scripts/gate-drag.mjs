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
 * ── 场景(W3 七条 + W3-b 改甲之后重写)────────────────────────────────────
 *  1. 文件行 → 叶身:并入、成活动 tab、**行仍在树里**;并入**画一圈环不铺色块、
 *     不写字**(W3-b 裁定 7)
 *  2. 文件行 → 叶的分屏边带(**贴边 `DROP_EDGE_PX` 16 之内**):分屏、比例 50、
 *     原叶 tab 一格不少;预示是**一根 4px 的杠**
 *  3. tab → 窗口右边带:进右架子,架子是展开的
 *  4. tab → 空处:撕成浮窗,矩形 = `floatRectForGrab`(指针 = 标题栏中心)
 *  5. 会话行 → 右架子:**真落**(W5-b 裁定 8 解禁 —— 会话那一种不再自述
 *     `regions`,于是它开到哪个区域都行)。W3 时这一条是「结构化拒绝」,
 *     判词写在那一版的 §3.1 第二行「T4 之前:落到中央 = 切换当前会话;
 *     落到别处 = 结构化拒绝」;会话多开落地即撤。
 *     **编号一格没重排**:W5-b 顶掉的是第 5 条的**内容**,不是往表里加一条 ——
 *     11 条还是 11 条,`场景 N` 与真机日志里的序号从此不必对照两份表读
 *  6. 拖到一半 Esc:树前后相同、浮影消失、行仍在、**折起来那一格展回来**
 *  7. 零重挂:同区域内并 tab / 分屏,来源行节点与目标叶 `[data-pane-body]` 的
 *     内容根节点**前后是同一个 DOM 对象**
 *     (跨区域搬家必然换 React 宿主,那一条只写「内容逐字相同」——
 *      W4 留账 3,与 gate:files 五档断言同口径)
 *  8. **条内换序**(W3-b 裁定 4):在顶栏那条条里把第一格拖到末尾 —— 次序真的变了、
 *     拖的**就是那一格**(同一个 DOM 节点,而且拖拽中它带着 `data-lift`)、
 *     让位的 `transform` 落定后**清零**、**浮影一个节点都不画**
 *  9. **6px 的移动 = 点击,不起拖**(阈值 4 → 8):浮影不出现,树不变
 * 10. **撕下 → 另一条条腾出空位 → 落到那个下标**:折起、空位、落点三件事逐个量
 * 11. **拖到自己那条 = 换序,不是并入**:落点不是 `leaf`,树里那片叶的 tab 数不变
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
 * 一次完整的拖拽。**中间那几发 move 不是装饰**:起拖阈值(`DRAG_START_PX`,W3-b
 * 起是 **8**)要至少一发真的走过 8px 才开始,而落点判据每一帧都在算 —— 一步跳到
 * 终点与真人拖过去在链路上不是一件事(那样只会证明「一发 move 也能落」)。
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

/**
 * 找一条**至少两格**的标签条,答它的叶 id 与那几格的 id。
 *
 * 换序那几个场景问的是「同一条条里的两格」,而顶栏上可能有好几组(分屏之后每片叶
 * 一组)。把 `[data-testid="topbar-tabs"] [role="tab"]` 一把抓下来按次序取前两个,
 * 拿到的很可能是**两条不同条上的两格** —— 那一下走的是跨条落点而不是条内换序,
 * 门会在一个它根本没打算量的形上红。
 */
function stripWithTwoTabs(page) {
  return page.evaluate(() => {
    for (const chrome of Array.from(document.querySelectorAll('[data-pane-chrome]'))) {
      const list = chrome.querySelector('[role="tablist"]')
      if (!list) continue
      const ids = Array.from(list.querySelectorAll('[data-tab-id]')).map((el) =>
        el.getAttribute('data-tab-id'),
      )
      if (ids.length >= 2) return { leafId: chrome.getAttribute('data-pane-chrome'), ids }
    }
    return null
  })
}

/** 顶栏那条条此刻的 tab 次序(**看得见的那几格**,不含折起来的)。 */
function topbarOrder(page, leafId) {
  return page.evaluate(
    (want) => {
      const root = want
        ? document.querySelector(`[data-pane-chrome="${want.replace(/["\\]/g, '\\$&')}"] [role="tablist"]`)
        : document.querySelector('[data-testid="topbar-tabs"]')
      return Array.from(root?.querySelectorAll('[role="tab"]') ?? []).map((el) => ({
        id: el.getAttribute('data-tab-id'),
        lift: el.hasAttribute('data-lift'),
        torn: el.hasAttribute('data-torn'),
        shift: el.style.transform || '',
      }))
    },
    leafId ?? null,
  )
}

/** 落区高亮此刻是什么形、里面写没写字。 */
function overlayShape(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="drop-overlay"]')
    if (!el) return null
    const style = getComputedStyle(el)
    return {
      shape: el.getAttribute('data-shape'),
      tone: el.getAttribute('data-tone'),
      text: (el.textContent ?? '').trim(),
      background: style.backgroundColor,
      width: Math.round(el.getBoundingClientRect().width),
      boxShadow: style.boxShadow,
    }
  })
}

const isTransparent = (color) =>
  color === 'transparent' || color === 'rgba(0, 0, 0, 0)' || /,\s*0\)$/.test(color)

/** refId 里有 `:` 与路径分隔符,直接塞进选择器会当场语法错。 */
const cssEscape = (value) => String(value).replace(/["\\]/g, '\\$&')

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
      /*
       * 先停在叶身上量**预示**(W3-b 裁定 7),再松手量结果。
       * 用户报的是「色块 + 边框 + 一句文字盖在内容上」—— 三样这里逐条断言掉。
       */
      await drag(cdp, row, { x: leaf.x, y: leaf.y }, { release: false })
      const ring = await overlayShape(page)
      assert(ring?.shape === 'ring', '并入的预示是一圈环', JSON.stringify(ring))
      assert(ring && isTransparent(ring.background), '环里不铺色块', ring?.background)
      assert(ring?.text === '', '环里不写字', JSON.stringify(ring?.text))
      assert(
        ring && /inset/.test(ring.boxShadow),
        '环画在内侧(不往外撑破那片叶)',
        ring?.boxShadow,
      )
      await releaseAt(cdp, { x: leaf.x, y: leaf.y })
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
    scenario('文件行拖到叶的分屏边带(16px 之内)= 分屏、比例 50、原叶 tab 一格不少')
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
      /*
       * 戳打在**那一片叶**身上,不是「中央区第一块 body」。
       * W3 那一版量的是东带 —— 新叶排在原叶右边,所以「第一块」恰好还是原叶;
       * 本批改量西带之后新叶排在**前面**,再按 DOM 序取就取到了刚长出来的那一片
       * (读数:戳没了)。那不是重挂,是选择器指错了人。
       */
      const originBody = `[data-pane-slot="${cssEscape(originId)}"] [data-pane-body]`
      await stamp(page, originBody, 'leaf-body-2')
      /*
       * 量的是**西带**,不是东带(W3 那一版量的是东)。
       *
       * 理由是两条带子会打架:窗口边带(`SNAP_BAND` 24)**优先于**叶的四带
       * (`drop.ts` 文件头那条「次序即语义」),而中央叶贴着窗口右缘 —— 甲把叶的
       * 边带收窄到 `DROP_EDGE_PX` **16** 之后,东带整条被窗口边带盖住了,站在那儿
       * 量到的是「钉进右架子」(判据在按设计工作,不是 bug)。西边不一样:文件面板
       * 钉在左边,中央叶的左缘离窗口左缘隔着一整条架子,两条带子不重叠。
       *
       * 站位:离叶左缘 8px —— 16 之内(在带里)、离窗口左缘远得多(边带够不着)。
       */
      const west = { x: leaf.rect.left + 8, y: leaf.y }
      await drag(cdp, row, west, { release: false })
      const bar = await overlayShape(page)
      assert(bar?.shape === 'bar', '分屏的预示是一根杠', JSON.stringify(bar))
      assert(bar && bar.width <= 8, '杠很细(4px 一根,不是画出那一半)', String(bar?.width))
      assert(bar?.text === '', '杠上不写字', JSON.stringify(bar?.text))
      await releaseAt(cdp, west)
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
        await stampSurvives(page, originBody, 'leaf-body-2'),
        '零重挂:分屏之后留下来那片叶的内容根还是同一个节点',
      )
    }

    /* ── 场景 3:tab → 窗口右边带 ────────────────────────────────────────── */
    scenario('把一格 tab 拖到窗口右边带 = 进右架子,架子展开')
    {
      /*
       * **点名 alpha.ts**,不用 `:last-of-type`。后者指的是「文档序里第一条 tablist
       * 的最后一格」,而这一形有两条(两片叶各一组)—— 分屏方向一改它就换了人,
       * 后面几个场景(7 要 beta 还在中央区)会跟着一起塌。点名是唯一稳的取法。
       */
      const alphaId = `file:${path.join(cwd, 'alpha.ts')}`
      const tab = await centerOf(page, `[data-testid="topbar-tabs"] [data-tab-id="${cssEscape(alphaId)}"]`)
      assert(Boolean(tab), '顶栏上有可拖的标签(alpha.ts)', JSON.stringify(tab?.rect))
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

    /* ── 场景 5:会话行 → 右架子 = **真落成一片会话叶**(W5-b 裁定 8)────── */
    scenario('会话行拖到右架子 = 真落(W3 那条「拒绝」随会话多开撤掉)')
    {
      await clickSelector(page, '[data-testid="dock-tile-sessions"]')
      await waitFor('总览就位', () =>
        page.evaluate(() => Boolean(document.querySelector('[data-session-id]'))),
      )
      const rowSel = '[data-session-id]:not([aria-selected="true"])'
      const row = await centerOf(page, rowSel)
      assert(Boolean(row), '总览里有一条别的会话可拖', JSON.stringify(row?.rect))
      const dragged = await page.evaluate(
        (css) => document.querySelector(css)?.getAttribute('data-session-id') ?? '',
        rowSel,
      )
      // 走到右边带上停住(不松手)—— 先量「收」,再松手量真的落进去了。
      const at = { x: viewport.w - 6, y: Math.round(viewport.h / 2) }
      await drag(cdp, row, at, { release: false })
      const hover = await page.evaluate(() => {
        const ghost = document.querySelector('[data-testid="drag-ghost"]')
        return {
          ghost: Boolean(ghost),
          refused: ghost?.hasAttribute('data-refuse') ?? false,
          overlayTone:
            document.querySelector('[data-testid="drop-overlay"]')?.getAttribute('data-tone') ?? null,
        }
      })
      assert(hover.ghost, '浮影在屏幕上')
      assert(!hover.refused, '浮影**不是**拒绝态(会话那一种不再限定区域)')
      assert(hover.overlayTone === 'accept', '边带画的是接受色的高亮', String(hover.overlayTone))
      await releaseAt(cdp, at)
      await delay(240)
      const landed = await page.evaluate(
        (id) => Boolean(document.querySelector(`[data-pane-tab="session:${id}"]`)),
        dragged,
      )
      assert(landed, '松手之后右架子上真有这一格会话叶', `session:${dragged}`)
      const inShelf = await page.evaluate(
        (id) =>
          Boolean(
            document.querySelector(
              `[data-pane-region="edge:right"] [data-pane-tab="session:${id}"]`,
            ),
          ),
        dragged,
      )
      assert(inShelf, '而且它落在**右架子**那棵树里,不是中央区')
    }

    /* ── 场景 6:拖到一半 Esc ────────────────────────────────────────────── */
    scenario('拖到一半按 Esc = 取消:树不变、浮影消失、行仍在')
    {
      const gamma = `[data-file-path="${path.join(cwd, 'gamma.ts')}"]`
      /*
       * **先把环境会话拨回带工作目录的那一条**(W5-b 裁定 3 的可感知后果)。
       *
       * 场景 5 之前那一下是**被拒绝**的拖拽,什么都没发生;W5-b 之后它真把
       * 另一条会话(`drag-gate-2`,没有工作目录)落成了右架子上的一片会话叶,
       * 而落定会把焦点送进去 —— 于是环境会话换了人,文件树的根跟着变成 null,
       * 整棵树一行都不画。这不是回归,是「文件树跟着环境会话走」那条既有规则
       * 在会话多开之后的第一次显形。
       *
       * 所以这里点一下带目录的那条会话把根拨回来;顺带**点瓦是开关**那条判例
       * (与 `gate-focus` 的 `ensureOverviewRow` 同源):最多两下,每一下之后各问一次。
       */
      await clickSelector(page, `[data-testid="session-row-${sessionId}"]`)
      await delay(500)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const there = await page.evaluate((css) => Boolean(document.querySelector(css)), gamma)
        if (there) break
        await clickSelector(page, '[data-testid="dock-tile-files"]')
        await delay(600)
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
        /*
         * **拖到叶中央 = 已经出了条的带**,所以此刻源那一格应该是折起来的
         * (W3-b 裁定 4:撕下 = 原位折成 0 宽,元素不卸载)。Esc 之后它得原样展回。
         */
        const folded = await topbarOrder(page)
        assert(
          folded.some((t) => t.torn),
          '拖出条之后源那一格折成了 0 宽(元素还在)',
          JSON.stringify(folded),
        )
        await page.keyboard.press('Escape')
        await delay(240)
        await releaseAt(cdp, { x: Math.round(viewport.w * 0.5), y: Math.round(viewport.h * 0.5) })
        const tabAfter = await treeShape(page)
        assert(
          tabAfter === tabBefore,
          'Esc 之后那一格 tab **仍在原位**(摘原位提前到起拖的话这里会红)',
          tabAfter === tabBefore ? '' : `\n     前:${tabBefore}\n     后:${tabAfter}`,
        )
        const restored = await topbarOrder(page)
        assert(
          restored.every((t) => !t.torn && !t.lift && t.shift === ''),
          'Esc 之后折的展回来了、让位与抬起也都清干净',
          JSON.stringify(restored),
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


    /*
     * ── 备料:把条上补到两格 ────────────────────────────────────────────
     * 场景 8 / 10 / 11 量的都是「条上至少有两格」那一形,而前面七个场景把 tab
     * 搬得到处都是(那正是它们在量的东西)。所以这里**不假设**前面留下了什么:
     * 缺几格就从文件树里补几格 —— 走的还是用户真走的那条路(拖一行进来)。
     */
    {
      await clickSelector(page, '[data-testid="dock-tile-files"]')
      await delay(500)
      for (const name of ['alpha.ts', 'beta.ts', 'gamma.ts']) {
        const count = await page.evaluate(
          () => document.querySelectorAll('[data-testid="topbar-tabs"] [role="tab"]').length,
        )
        if (count >= 2) break
        const rowSel = `[data-file-path="${path.join(cwd, name)}"]`
        const row = await centerOf(page, rowSel)
        const leafAt = await centerOf(page, '[data-pane-region="center"] [data-pane-slot]')
        if (!row || !leafAt) continue
        await drag(cdp, row, { x: leafAt.x, y: leafAt.y })
      }
    }

    /* ── 场景 8:条内换序(W3-b 裁定 4)──────────────────────────────────── */
    scenario('顶栏条内换序:序真的变了、拖的就是那一格、让位落定后清零、浮影不画')
    {
      /*
       * 这一段量的是用户报的第一条病(「换序做不到」)与第二条病(「手和东西是
       * 分开的」)。所以三件事要一起量:**结果**(序变了)、**过程**(拖的那一格
       * 自己带着 `data-lift` 在动,而浮影一个节点都没有)、**收尾**(让位的
       * transform 清零 —— 留着的话下一次渲染那几格会长在错位上)。
       */
      const strip = await stripWithTwoTabs(page)
      assert(Boolean(strip), '找得到一条至少两格的标签条', JSON.stringify(strip?.ids))
      if (strip) {
        const before = await topbarOrder(page, strip.leafId)
        const first = before[0].id
        const last = before[before.length - 1].id
        const firstAt = await centerOf(page, `[data-tab-id="${cssEscape(first)}"]`)
        const lastAt = await centerOf(page, `[data-tab-id="${cssEscape(last)}"]`)
        await stamp(page, `[data-tab-id="${cssEscape(first)}"]`, 'reorder-node')
        // 在**条内**横着走(y 不动 = 一直在带里 = 换序模式)。
        const to = { x: lastAt.rect.left + lastAt.rect.width - 4, y: firstAt.y }
        await drag(cdp, firstAt, to, { release: false })
        const mid = await topbarOrder(page, strip.leafId)
        assert(
          !(await page.evaluate(() => Boolean(document.querySelector('[data-testid="drag-ghost"]')))),
          '条内换序时**浮影一个节点都不画**(拖的就是 tab 本身)',
        )
        assert(mid.some((t) => t.lift), '被拖那一格带着 data-lift(它自己被抬起来了)', JSON.stringify(mid))
        assert(
          mid.some((t) => !t.lift && t.shift.includes('translateX')),
          '邻居在用 transform 让位',
          JSON.stringify(mid.map((t) => t.shift)),
        )
        await releaseAt(cdp, to)
        const after = await topbarOrder(page, strip.leafId)
        assert(
          after[after.length - 1].id === first,
          '松手之后它排到了末尾(次序真的变了)',
          `${before.map((t) => t.id).join(' | ')}  →  ${after.map((t) => t.id).join(' | ')}`,
        )
        assert(
          after.every((t) => t.shift === '' && !t.lift && !t.torn),
          '落定之后让位 transform 清零、抬起 / 折起两格属性都摘掉',
          JSON.stringify(after),
        )
        assert(
          await stampSurvives(page, `[data-tab-id="${cssEscape(first)}"]`, 'reorder-node'),
          '零重挂:换序前后是同一个 DOM 节点',
        )
      }
    }

    /* ── 场景 9:6px 的移动 = 点击,不起拖(阈值 4 → 8)────────────────────── */
    scenario('走 6px 松手 = 一次点击,不起拖(DRAG_START_PX 从 4 调到 8)')
    {
      const order = await topbarOrder(page)
      const id = order[0]?.id
      const at = id ? await centerOf(page, `[data-testid="topbar-tabs"] [data-tab-id="${cssEscape(id)}"]`) : null
      assert(Boolean(at), '顶栏上有一格可按', JSON.stringify(at?.rect))
      if (at) {
        const before = await treeShape(page)
        /*
         * 六步各走 1px —— 每一发都真的到达 blink,总位移 6 < 8。W3 那时(阈值 4)
         * 这一串会在第 5 发起拖并画出浮影,也就是用户报的「轻轻一碰浮影就出来」。
         */
        await drag(cdp, at, { x: at.x + 6, y: at.y }, { steps: 6, release: false })
        assert(
          !(await page.evaluate(() => Boolean(document.querySelector('[data-testid="drag-ghost"]')))),
          '走 6px 时浮影不出现',
        )
        assert(
          (await topbarOrder(page)).every((t) => !t.lift),
          '也没有哪一格被抬起来',
        )
        await releaseAt(cdp, { x: at.x + 6, y: at.y })
        assert((await treeShape(page)) === before, '松手之后树逐字相同(这一下就是一次点击)')
      }
    }

    /* ── 场景 10:撕下 → 另一条条腾出空位 → 落到那个下标 ─────────────────── */
    scenario('撕下一格 → 拖到另一条标签条的带里 → 那条条腾出空位 → 落到那个下标')
    {
      /*
       * 「另一条条」这里**自己造**:找一条至少两格的条,把它的一格拖到**它自己那片
       * 叶**的西带切一刀,于是屏幕上有了两条条。不去借前面场景留下的右架子 ——
       * 那条架子在场景 4 里已经被撕成浮窗、连架子一起没了(门第一版就是这样红的:
       * 借来的前置状态会随任何一个前置场景的改动一起塌)。
       *
       * 也不假设那条条在**顶栏**:这一串场景跑到这里时,最热闹的那片叶很可能在一扇
       * 浮窗里(总览是浮窗形态,而它盖住中央区 —— 「叶重叠时取最上」是判据在按设计
       * 工作)。所以一律走 `stripWithTwoTabs` 问「此刻哪条条有两格」。
       */
      const strip = await stripWithTwoTabs(page)
      assert(Boolean(strip), '找得到一条至少两格的条,可以切一刀', JSON.stringify(strip?.ids))
      if (strip) {
        const movable = strip.ids.find((id) => id !== 'chat:main') ?? strip.ids[0]
        const leafRect = await centerOf(page, `[data-pane-slot="${cssEscape(strip.leafId)}"]`)
        const from0 = await centerOf(page, `[data-tab-id="${cssEscape(movable)}"]`)
        assert(Boolean(leafRect && from0), '那片叶与那一格都量得到', JSON.stringify(leafRect?.rect))
        await drag(cdp, from0, { x: leafRect.rect.left + 8, y: leafRect.y })
        const strips = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-pane-chrome]')).map((el) =>
            el.getAttribute('data-pane-chrome'),
          ),
        )
        assert(strips.length >= 2, '现在屏幕上有两条以上标签条', JSON.stringify(strips))

        // 抓一格,拖到**不含它**的那条条的带里。
        const source = await stripWithTwoTabs(page)
        const grab = source?.ids.find((id) => id !== 'chat:main') ?? source?.ids[0]
        assert(Boolean(grab), '找得到一格可以撕下来的 tab', String(grab))
        if (grab) {
          const grabAt = await centerOf(page, `[data-tab-id="${cssEscape(grab)}"]`)
          const targetStrip = await page.evaluate((want) => {
            for (const chrome of Array.from(document.querySelectorAll('[data-pane-chrome]'))) {
              const list = chrome.querySelector('[role="tablist"]')
              if (!list) continue
              const ids = Array.from(list.querySelectorAll('[data-tab-id]')).map((el) =>
                el.getAttribute('data-tab-id'),
              )
              if (ids.length > 0 && !ids.includes(want)) return chrome.getAttribute('data-pane-chrome')
            }
            return null
          }, grab)
          assert(Boolean(targetStrip), '找得到另一条条(不含被拖那一格)', String(targetStrip))
          if (targetStrip) {
            const listSel = `[data-pane-chrome="${cssEscape(targetStrip)}"] [role="tablist"]`
            const target = await centerOf(page, listSel)
            // 落在那条条**最左边**一点点 = 第 0 格之前。
            const drop = { x: target.rect.left + 4, y: target.y }
            await drag(cdp, grabAt, drop, { release: false })
            const torn = await page.evaluate(
              (want) => document.querySelector(`[data-tab-id="${want.replace(/["\\]/g, '\\$&')}"]`)?.hasAttribute('data-torn') ?? false,
              grab,
            )
            assert(torn, '源那一格折成了 0 宽(元素还在,没卸载)')
            assert(
              await page.evaluate(() => Boolean(document.querySelector('[data-testid="drag-ghost"]'))),
              '浮影(tab 形卡片)在屏幕上',
            )
            assert(
              (await overlayShape(page)) === null,
              '落在条上时**不画高亮** —— 预示是那条条腾出来的空位',
            )
            assert(
              await page.evaluate(
                (css) => Boolean(document.querySelector(css)?.querySelector('[data-tab-placeholder]')),
                listSel,
              ),
              '目标那条条腾出了一个空位',
            )
            await releaseAt(cdp, drop)
            const landed = await page.evaluate(
              ([css, want]) =>
                Array.from(document.querySelector(css)?.querySelectorAll('[data-tab-id]') ?? []).findIndex(
                  (el) => el.getAttribute('data-tab-id') === want,
                ),
              [listSel, grab],
            )
            assert(landed === 0, '它落在了第 0 格(空位在哪儿它就落在哪儿)', `at=${landed}`)
            assert(
              !(await page.evaluate(() => Boolean(document.querySelector('[data-tab-placeholder]')))),
              '空位收干净了',
            )
          }
        }
      }
    }

    /* ── 场景 11:拖到自己那条 = 换序,不是并入 ──────────────────────────── */
    scenario('把一格 tab 拖到它自己那条标签条上 = 换序,而不是并入那片叶')
    {
      /*
       * 这一条守的是「次序即语义」的第一问:条**优先于**叶。条压在叶的北带与叶身
       * 里,先问叶的话这一下会变成「并入自己那片叶」(空动作)或者更糟的「在自己
       * 的北带上切一刀」。判据这一头没有第二种写法,所以门量的是**结果**:
       * 那片叶的 tab 数一格不变,而且屏幕上没有一块并入的环。
       */
      const strip = await stripWithTwoTabs(page)
      assert(Boolean(strip), '找得到一条至少两格的标签条', JSON.stringify(strip?.ids))
      if (strip) {
        const order = await topbarOrder(page, strip.leafId)
        const before = order.length
        const at = await centerOf(page, `[data-tab-id="${cssEscape(order[1].id)}"]`)
        const target = await centerOf(page, `[data-tab-id="${cssEscape(order[0].id)}"]`)
        const to = { x: target.rect.left + 4, y: target.y }
        await drag(cdp, at, to, { release: false })
        assert((await overlayShape(page)) === null, '拖到自己那条时不画并入的环')
        assert(
          !(await page.evaluate(() => Boolean(document.querySelector('[data-testid="drag-ghost"]')))),
          '也不画浮影(它是换序模式)',
        )
        await releaseAt(cdp, to)
        const after = await topbarOrder(page, strip.leafId)
        assert(after.length === before, '那片叶的 tab 数一格不变(不是并入)', `${before} → ${after.length}`)
        assert(after[0].id === order[1].id, '它换到了第一位', after.map((t) => t.id).join(' | '))
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
