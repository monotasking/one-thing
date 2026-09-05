#!/usr/bin/env node
/**
 * **拖拽手感的真机门**(W6-b,设计 `apps/desktop-react/docs/workbench-tabs-2026-09.md`
 * §4 §5 §11;W3 那七条 + W3-b 那十一条整套重写)。
 *
 * ── 它为什么必须是真机门 ────────────────────────────────────────────────
 * 这一批交付的东西**全部**是「指针走到哪儿 → 屏幕上哪一块矩形亮起来 → 松手之后
 * 树变成什么样」。前两件在 jsdom 里根本不存在(它不排版,`getBoundingClientRect`
 * 一律答零),所以判据可以脱开浏览器测(`workbench/__tests__/drop.test.ts` 31 条),
 * **而链路不行**。08-30 那条判例的原话:交互时序类改动必须真机对照,jsdom 的绿
 * 不算数。
 *
 * ── 这一版的方法论:**连续不停顿的指针序列**(§10 W6-b 的原话)────────────
 * 上一版每一条都是「走到落点 → 停下 → 量」。停下之后屏幕是静止的,于是
 * 「**一直在动就没反应**」这一整类病(跟手掉帧、槽位漂、空位每帧重建、hover 底
 * 在指针经过邻居时闪一下)一条都抓不到 —— 而那正是用户报的那句「拖拽没有浏览器
 * 的丝滑、流畅和交互感」。
 *
 * 所以这一版的量法是 `stroke()`:**一边继续派 `mouseMoved` 一边采样**。
 * 微动幅度 1px、**只动横向**(竖向一动就可能跨进「放到标签上」那条带,那是另一形),
 * 采样在两发 move 之间,于是读到的每一格都是「手还在动的那一刻屏幕上真有的东西」。
 *
 * ── 七个场景(派工令 §11 那七条)─────────────────────────────────────────
 *  ① 三种来源(会话行 / 文件行 / 标签)到标签条**每一个位置**:空位或描圈,
 *     而且浮影下那行字非空
 *  ② 按下即切换、松手不动无事、横向 6px 才浮起、竖向出带才撕下
 *  ③ 换序最左 / 最右 / 中间三处:顺序与活动位正确;松手有 150ms 的位移过渡
 *     (读 `transition` 与非零起始位移);Esc 顺序不变、无残留;
 *     **全程标签条 / 内容区 / 其它标签三处底色逐字不变**;
 *     **刚抬起那一帧邻居一个都不动**;**最宽的那一格拖得到末位**;
 *     **右邻居恰在「被拖右缘 = 它中心」那一刻让位**(中心对中心在这里当场红)
 *  ④ 「放到标签上」带:横着拖停 1s **不误并**;压到条底缘下 6–24px 才描圈;
 *     回到条内回到换序;松手并成两格;压在空白上是空动作;两格标签压下去是拒绝态
 *  ⑤ 从架子拖文件到聊天区中间 = 新标签,右带 = 二合一;浮窗不接住自己
 *  ⑥ 零重挂:换序 / 二合一 / 拆开 / 换比例四步,内容根节点同一个 DOM
 *  ⑦ 拒绝态:光标 not-allowed + 一句理由;松手弹回,树一个字不变
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

/** 判据这一头的几个数,与产品源码里的常量同源(改一边这道门当场说话)。 */
const DRAG_START_X = 6
const SETTLE_MS = 150
/**
 * 「放到标签上」那条带:条底缘 + 6(`ONTO_FROM_PX`)到 + 24(`TEAR_OFF_DISTANCE`)。
 * 门站在带的**正中**(+12)上量:贴着任一沿量的话,一次舍入就能把这一站推到
 * 邻居那一形去,而那种红是门自己的抖,不是产品的。
 */
const ONTO_FROM_PX = 6
const TEAR_OFF_DISTANCE = 24
const ONTO_Y_OFFSET = (ONTO_FROM_PX + TEAR_OFF_DISTANCE) / 2
/**
 * 「边越过中心」那一条断言两侧各让 3px。
 *
 * 舍入预算:CDP 把指针 x 取整,`topStrip` 把每一格矩形也取整,两处加起来天然有
 * ±1.5px 的松动 —— 2 恰好压在那条线上,3 让开它。而它仍旧咬得死:中心对中心那一版
 * 的门槛比这一版晚**半格标签宽**(60~80px),3px 的两侧各一站分得清清楚楚。
 */
const EDGE_EPS = 3

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

const press = (cdp, at) =>
  cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(at.x),
    y: Math.round(at.y),
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })

const moveTo = (cdp, at) =>
  cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(at.x),
    y: Math.round(at.y),
    button: 'left',
    buttons: 1,
  })

const release = (cdp, at) =>
  cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(at.x),
    y: Math.round(at.y),
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })

/** 松手 + 等一拍让落定跑完(要量收笔那 150ms 的用例**不用**这一只)。 */
async function releaseAt(cdp, at) {
  await release(cdp, at)
  await delay(240)
}

/**
 * **一段不停顿的指针路径**(这道门的核心量法,见文件头)。
 *
 * 从 `from` 走到 `to`,途中每一步都真的到达 blink;`sample` 给了的话,**在两发
 * move 之间**跑一次 —— 手还在动,读到的就是「一直在动的时候屏幕上真有的东西」。
 * 走完之后**不停**:继续以 1px 的幅度**横向**来回微动(竖向一动就可能跨带),
 * 一边微动一边再采几次,直到 `holdMs` 走完。
 *
 * 答的是采样表(按次序)。`release: false` 时手指还按着,由调用方自己收。
 */
async function stroke(cdp, from, to, opts = {}) {
  const { steps = 10, sample, holdMs = 0, release: shouldRelease = false, stepDelay = 12 } = opts
  const seen = []
  const take = async () => {
    if (!sample) return
    seen.push(await sample())
  }
  await press(cdp, from)
  for (let i = 1; i <= steps; i += 1) {
    await moveTo(cdp, {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    })
    await delay(stepDelay)
    if (i >= steps - 1) await take()
  }
  // **一直在动**:1px 的来回,采样夹在两发 move 之间。
  const deadline = Date.now() + holdMs
  let flip = 0
  while (Date.now() < deadline) {
    flip = 1 - flip
    await moveTo(cdp, { x: to.x + flip, y: to.y })
    await delay(16)
    await take()
  }
  if (shouldRelease) await releaseAt(cdp, to)
  return seen
}

/** 已经按着了,再走一段(同样不停顿)。 */
async function strokeOn(cdp, from, to, opts = {}) {
  const { steps = 8, stepDelay = 12 } = opts
  for (let i = 1; i <= steps; i += 1) {
    await moveTo(cdp, {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    })
    await delay(stepDelay)
  }
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
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      rect: {
        left: Math.round(r.left), top: Math.round(r.top),
        width: Math.round(r.width), height: Math.round(r.height),
      },
    }
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

/** refId 里有 `:` 与路径分隔符,直接塞进选择器会当场语法错。 */
const cssEscape = (value) => String(value).replace(/["\\]/g, '\\$&')

/**
 * **这一帧屏幕上的拖拽反馈是什么**(这道门的主读数)。
 *
 * 一次 `evaluate` 把七样一起取回来:提示行的字、空位的宽、描圈在哪一格、
 * 落区的形与矩形、氛围有几块、根上那格拒绝光标。分七次取的话它们来自七个不同的
 * 时刻 —— 而这道门量的正是「同一帧里这几样对不对得上」。
 */
function feedbackNow(page) {
  return page.evaluate(() => {
    const hint = document.querySelector('[data-testid="drag-hint"]')
    const ph = document.querySelector('[data-tab-placeholder]')
    const hot = document.querySelector('[data-pair-hot]')
    const band = document.querySelector('[data-testid="drop-overlay"]')
    const ghost = document.querySelector('[data-testid="drag-ghost"]')
    const bandRect = band?.getBoundingClientRect()
    return {
      hint: (hint?.textContent ?? '').trim(),
      ghost: Boolean(ghost),
      card: Boolean(document.querySelector('[data-testid="drag-ghost-card"]')),
      refused: ghost?.hasAttribute('data-refuse') ?? false,
      cursorRefuse: document.documentElement.hasAttribute('data-drag-refuse'),
      gapWidth: ph ? Math.round(ph.getBoundingClientRect().width) : null,
      pairHot: hot?.getAttribute('data-tab-id') ?? null,
      shape: band?.getAttribute('data-shape') ?? null,
      bandRect: bandRect
        ? { left: Math.round(bandRect.left), width: Math.round(bandRect.width) }
        : null,
      ambient: document.querySelectorAll('[data-testid="drop-ambient"]').length,
    }
  })
}

/** 一条条此刻的次序 + 那几格拖拽属性。 */
function stripOrder(page, leafId) {
  return page.evaluate((want) => {
    const root = document.querySelector(
      `[data-pane-chrome="${want.replace(/["\\]/g, '\\$&')}"] [role="tablist"]`,
    )
    return Array.from(root?.querySelectorAll('[role="tab"]') ?? []).map((el) => ({
      id: el.getAttribute('data-tab-id'),
      on: el.getAttribute('aria-selected') === 'true',
      lift: el.hasAttribute('data-lift'),
      torn: el.hasAttribute('data-torn'),
      settle: el.hasAttribute('data-settle'),
      shift: el.style.transform || '',
    }))
  }, leafId)
}

/**
 * **同一帧里的「反馈 + 让位」**(场景 ④ 那条「停 1s 不误并」读的就是它)。
 *
 * 分两次 `evaluate` 取的话,提示行来自一刻、让位来自另一刻 —— 而这一条断言的
 * 正是「这两样在同一帧里同时是什么」(仍在换序 ∧ 没有描圈 ∧ 没有提示行)。
 */
function stripProbe(page, leafId) {
  return page.evaluate((want) => {
    const root = document.querySelector(
      `[data-pane-chrome="${want.replace(/["\\]/g, '\\$&')}"] [role="tablist"]`,
    )
    const hint = document.querySelector('[data-testid="drag-hint"]')
    const hot = document.querySelector('[data-pair-hot]')
    return {
      hint: (hint?.textContent ?? '').trim(),
      pairHot: hot?.getAttribute('data-tab-id') ?? null,
      card: Boolean(document.querySelector('[data-testid="drag-ghost-card"]')),
      cursorRefuse: document.documentElement.hasAttribute('data-drag-refuse'),
      shifts: Object.fromEntries(
        Array.from(root?.querySelectorAll('[role="tab"]') ?? []).map((el) => [
          el.getAttribute('data-tab-id'),
          el.hasAttribute('data-lift') ? 'LIFTED' : el.style.transform || '',
        ]),
      ),
    }
  }, leafId)
}

/**
 * **三处底色**(§4.5 第 2 条那条断言读的就是它):标签条自己、每一格标签、
 * 内容区。答的是一串字符串 —— 「逐字不变」这句话只有逐字比较才算数。
 */
function palette(page, leafId) {
  return page.evaluate((want) => {
    const chrome = document.querySelector(
      `[data-pane-chrome="${want.replace(/["\\]/g, '\\$&')}"]`,
    )
    const list = chrome?.querySelector('[role="tablist"]')
    const body = document.querySelector('[data-pane-region="center"] [data-pane-body]')
    return {
      strip: list ? getComputedStyle(list).backgroundColor : null,
      body: body ? getComputedStyle(body).backgroundColor : null,
      tabs: Array.from(list?.querySelectorAll('[role="tab"]') ?? []).map((el) => ({
        id: el.getAttribute('data-tab-id'),
        bg: getComputedStyle(el).backgroundColor,
      })),
    }
  }, leafId)
}

/** 顶栏那条条(中央区那片叶)。这一串场景几乎都在它身上量。 */
function topStrip(page) {
  return page.evaluate(() => {
    const chrome = document.querySelector('[data-testid="topbar-tabs"] [data-pane-chrome]')
      ?? document.querySelector('[data-pane-chrome]')
    const list = chrome?.querySelector('[role="tablist"]')
    if (!chrome || !list) return null
    return {
      leafId: chrome.getAttribute('data-pane-chrome'),
      rect: (() => {
        const r = list.getBoundingClientRect()
        return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
      })(),
      tabs: Array.from(list.querySelectorAll('[data-tab-id]')).map((el) => {
        const r = el.getBoundingClientRect()
        return {
          id: el.getAttribute('data-tab-id'),
          left: Math.round(r.left), width: Math.round(r.width),
          cx: Math.round(r.left + r.width / 2),
          cy: Math.round(r.top + r.height / 2),
        }
      }),
    }
  })
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
    await writeFile(path.join(cwd, 'alpha.ts'), 'export const alpha = 1\n')
    await writeFile(path.join(cwd, 'beta.ts'), 'export const beta = 2\n')
    await writeFile(path.join(cwd, 'gamma.ts'), 'export const gamma = 3\n')
    /*
     * 第四份**故意不开**:场景 ① 扫条时拖的就是它。
     * 拖一格**已经开着**的内容时,它自己那一格标签的正中会落进「被拖的自己除外」
     * 那条判据(设计 §2.3 不变量 3:拖回自己身上不是一次并)—— 门第一版拖的是
     * alpha.ts 而条上恰好开着 alpha.ts,读数是那一站答 `strip` 而不是 `pairTab`,
     * **判据是对的,门的预期是错的**。换一格没开着的就没有这个交叉。
     */
    await writeFile(path.join(cwd, 'delta.ts'), 'export const delta = 4\n')

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
    // 场景 ① 的第三种来源:另一条会话(拖当前那一条等于什么都没换)。
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

    /*
     * **夹具**:总览开成一扇浮窗(场景 ⑤ 要它来验「浮窗不接住自己」),文件面板
     * 留在它的出厂摆法左架子(W6-a §8)。两块面落进同一条架子就会成为同一条标签
     * 条的两格,后面那一格 `content-visibility: hidden` —— 行拖不起来。
     */
    await openAsFromDockMenu(page, 'sessions', /^(Float|浮窗)$/)
    await waitFor('总览画出那一行', () =>
      page.evaluate((id) => Boolean(document.querySelector(`[data-session-id="${id}"]`)), sessionId),
    )
    await clickSelector(page, `[data-testid="session-row-${sessionId}"]`)
    await clickSelector(page, '[data-testid="dock-tile-files"]')
    await waitFor('文件树画出行', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-file-path]'))),
    )
    const pinnedLeft = await page.evaluate(() =>
      Boolean(document.querySelector('[data-shelf="left"] [data-testid="files-panel"]')),
    )
    await delay(400)

    /**
     * 把中央那条条补到 n 格(用户真走的路:单击文件行 = 开一格标签)。
     *
     * `singles` 数的是**普通标签**:前面的场景会并出两格的那一种,而
     * 「找两格来并」「找一格来换序」问的都是普通标签 —— 拿总数当条件的话,
     * 一条全是两格标签的条会被当成够用的(真机门第一版就是这样红的)。
     */
    const fillStrip = async (n, { singles = false } = {}) => {
      const count = (strip) =>
        singles ? strip.tabs.filter((t) => !t.id.startsWith('pair:')).length : strip.tabs.length
      for (const name of ['alpha.ts', 'beta.ts', 'gamma.ts']) {
        const strip = await topStrip(page)
        if (strip && count(strip) >= n) break
        const row = `[data-file-path="${path.join(cwd, name)}"]`
        if (!(await page.evaluate((css) => Boolean(document.querySelector(css)), row))) continue
        await clickSelector(page, row)
        await delay(320)
      }
      await delay(200)
      return topStrip(page)
    }

    console.log('[3/3] 逐个场景')

    /* ══ 场景 ①:三种来源 × 标签条上每一个位置 ══════════════════════════ */
    scenario('三种来源拖到标签条的每个位置:都有空位或描圈,提示行都非空')
    {
      assert(pinnedLeft, '文件面板在左架子上(出厂摆法,W6-a §8)')
      const strip = await fillStrip(3)
      assert(strip && strip.tabs.length >= 3, '中央那条条上有三格', JSON.stringify(strip?.tabs.map((t) => t.id)))

      /** 一种来源走一趟:落在每一格的正中、每两格之间,各采一次读数。 */
      const sweep = async (label, from) => {
        const now = await topStrip(page)
        const stops = []
        now.tabs.forEach((tab, i) => {
          stops.push({ where: `第 ${i} 格正中`, at: { x: tab.cx, y: tab.cy }, want: 'ring' })
          stops.push({ where: `第 ${i} 格左缘`, at: { x: tab.left + 3, y: tab.cy }, want: 'gap' })
        })
        stops.push({
          where: '末格之后的空白',
          at: { x: now.rect.left + now.rect.width - 8, y: now.tabs[0].cy },
          want: 'gap',
        })
        // **一趟走完,中间一次都不松手**:按下之后一路扫过去,每一站采一次。
        await press(cdp, from)
        await strokeOn(cdp, from, stops[0].at, { steps: 6 })
        const seen = []
        let stampedGap = false
        let gapIdentity = null
        for (const stop of stops) {
          await strokeOn(cdp, seen.length ? stops[seen.length - 1].at : stops[0].at, stop.at, { steps: 4 })
          // 微动一下再读 —— 手停住的那一帧不算数(见文件头的量法)。
          await moveTo(cdp, { x: stop.at.x + 1, y: stop.at.y })
          await delay(24)
          seen.push({ ...stop, read: await feedbackNow(page) })
          /*
           * **同一个节点在挪**(§4.5 第 3 条)。头一次见到空位就给它打一格戳,
           * 后面每次落点变了再问一遍「戳还在吗」—— 属性跟着重建一起没,所以
           * 戳还在 = 那格空位从头到尾就是它。这是反证三(「空位改每帧重建」)
           * 咬得住的那一条。
           */
          /*
           * 答的是 `{present, mark}` 两格,**不是**一个可空的 mark(反证 A 第一版
           * 就栽在这儿):空位被重建时那格戳跟着没,返回 null;而 null 同时也是
           * 「屏幕上压根没有空位」的答案 —— 两件事挤在一个值里,断言于是把
           * 「重建了」读成「这一站没有空位」,当场绿了。分成两格之后,
           * **有空位但戳没了 = 重建了**,那正是这一条要抓的。
           */
          const gap = await page.evaluate((first) => {
            const ph = document.querySelector('[data-tab-placeholder]')
            if (!ph) return { present: false, mark: null }
            if (first) ph.setAttribute('data-gate-gap', 'gap-node')
            return { present: true, mark: ph.getAttribute('data-gate-gap') }
          }, !stampedGap)
          /*
           * 判的是「**空位一直在,却换了个节点**」——§4.5 第 3 条的字面:
           * 「空位是同一格只在落点变化时换位置」。空位**消失**不算违例:落点从
           * 「标签之间」变成「标签正中」时该画的是那一格上的圈,空位本就该收掉
           * (第一版没分这两件事,于是在描圈那几站上自己红了一次)。
           * 所以空位一没,戳就跟着作废,下一次出现重新打。
           */
          if (!gap.present) {
            stampedGap = false
          } else if (!stampedGap) {
            stampedGap = true
          } else if (gap.mark !== 'gap-node') {
            gapIdentity = false
          } else if (gapIdentity === null) {
            gapIdentity = true
          }
        }
        /*
         * **走完一趟一律 Esc 取消**:这一条量的是「过程里屏幕上有没有东西」,
         * 落定与它无关 —— 而真落一次会把夹具改掉(总览那扇浮窗盖在中央区上,
         * 松手在那儿等于把这一格丢进总览),后面几条当场没有对象可量。
         */
        await page.keyboard.press('Escape')
        await releaseAt(cdp, stops[stops.length - 1].at)
        const missing = seen.filter((row) => {
          const ok = row.want === 'ring' ? row.read.pairHot !== null : (row.read.gapWidth ?? 0) > 0
          return !ok
        })
        const blank = seen.filter((row) => row.read.hint === '')
        assert(
          missing.length === 0,
          `${label}:每一站都有空位或描圈`,
          missing.length ? missing.map((r) => `${r.where}=${JSON.stringify(r.read)}`).join(' | ') : `${seen.length} 站`,
        )
        assert(
          blank.length === 0,
          `${label}:每一站浮影下那行字都非空`,
          blank.length ? blank.map((r) => r.where).join(' | ') : seen.map((r) => r.read.hint).join(' / '),
        )
        assert(
          gapIdentity !== false,
          `${label}:落点换来换去,那格空位**始终是同一个 DOM 节点**(不是每帧重建)`,
          String(gapIdentity),
        )
      }

      const fileRow = await centerOf(page, `[data-file-path="${path.join(cwd, 'delta.ts')}"]`)
      if (fileRow) await sweep('文件行', fileRow)
      else assert(false, '文件行量得到')

      // 总览是一扇浮窗,前面那一趟可能把它挤到了后面 —— 点一下瓦把它叫回前台。
      await clickSelector(page, '[data-testid="dock-tile-sessions"]')
      await delay(500)
      await waitFor('总览就位', () =>
        page.evaluate(() => Boolean(document.querySelector('[data-session-id]'))),
      ).catch(() => {})
      const sessionRow = await centerOf(page, '[data-session-id]:not([aria-selected="true"])')
      if (sessionRow) await sweep('会话行', sessionRow)
      else assert(false, '总览里有另一条会话可拖')

      /*
       * **标签这一种来源扫的是「别人那条条」**(设计 §4.2 / §5)。
       *
       * 回到**自己**那条条的带里是**换序** —— 那一形的预示是那几格 tab 自己在动,
       * 浮影与空位一个节点都不画(裁定 4)。门第一版把它当成「没反应」红了一次:
       * 读数 `ghost:false, gapWidth:null` 恰恰是那条裁定在正确工作。
       * 所以这里挑一条**不含被拖那一格**的条(架子上文件面板那条)去扫。
       */
      const now = await topStrip(page)
      const tabFrom = now?.tabs[0]
      const foreign = await page.evaluate((mine) => {
        for (const chrome of Array.from(document.querySelectorAll('[data-pane-chrome]'))) {
          const id = chrome.getAttribute('data-pane-chrome')
          if (id === mine) continue
          const list = chrome.querySelector('[role="tablist"]')
          const r = list?.getBoundingClientRect()
          if (!r || r.width <= 0 || r.height <= 0) continue
          return { leafId: id, x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2) }
        }
        return null
      }, now?.leafId ?? '')
      assert(Boolean(foreign), '屏幕上有第二条标签条(架子 / 浮窗那一条)', JSON.stringify(foreign))
      if (tabFrom && foreign) {
        await press(cdp, { x: tabFrom.cx, y: tabFrom.cy })
        // 先往下拉出带(撕下),再走到别人那条条上。
        await strokeOn(cdp, { x: tabFrom.cx, y: tabFrom.cy }, { x: tabFrom.cx, y: tabFrom.cy + 200 }, { steps: 8 })
        const torn = (await stripOrder(page, now.leafId)).some((t) => t.torn)
        assert(torn, '标签:出带之后源那一格折成 0 宽')
        await strokeOn(cdp, { x: tabFrom.cx, y: tabFrom.cy + 200 }, { x: foreign.x, y: foreign.y }, { steps: 10 })
        await moveTo(cdp, { x: foreign.x + 1, y: foreign.y })
        await delay(40)
        const read = await feedbackNow(page)
        assert((read.gapWidth ?? 0) > 0 || read.pairHot !== null, '标签:落到别人那条条上有空位或描圈', JSON.stringify(read))
        assert(read.hint !== '', '标签:提示行非空', read.hint)
        await page.keyboard.press('Escape')
        await releaseAt(cdp, { x: foreign.x, y: foreign.y })
      }
    }

    /* ══ 场景 ②:按下即切换 / 松手不动无事 / 6px / 出带才撕 ═══════════ */
    scenario('按下即切换、松手不动无事、横向 6px 才浮起、出带才撕下')
    {
      const strip = await fillStrip(3)
      const active = strip.tabs.find((_, i) => i === 0)
      const other = strip.tabs.find((t) => t.id !== active.id)
      const wasOn = (await stripOrder(page, strip.leafId)).find((t) => t.on)?.id
      const target = strip.tabs.find((t) => t.id !== wasOn) ?? other
      await stamp(page, `[data-tab-id="${cssEscape(target.id)}"]`, 'press-node')
      const before = await treeShape(page)

      await press(cdp, { x: target.cx, y: target.cy })
      await delay(60)
      const afterPress = await stripOrder(page, strip.leafId)
      assert(
        afterPress.find((t) => t.on)?.id === target.id,
        '按下那一刻内容就切过去了(不等松手)',
        `${wasOn} → ${afterPress.find((t) => t.on)?.id}`,
      )
      assert(
        await stampSurvives(page, `[data-tab-id="${cssEscape(target.id)}"]`, 'press-node'),
        '**按下前后是同一个 DOM 节点**(条没重建,手里那格还在)',
      )

      // 走 4px:还不是拖(横向门槛 6)。
      await moveTo(cdp, { x: target.cx + 4, y: target.cy })
      await delay(40)
      let read = await stripOrder(page, strip.leafId)
      assert(!read.some((t) => t.lift), `横向 4px 还没浮起(DRAG_START_X=${DRAG_START_X})`, JSON.stringify(read.map((t) => t.lift)))
      // 走到 8px:过了门槛。
      await moveTo(cdp, { x: target.cx + 8, y: target.cy })
      await delay(40)
      read = await stripOrder(page, strip.leafId)
      assert(read.some((t) => t.lift), '横向过 6px 之后那一格浮起来了', JSON.stringify(read.map((t) => `${t.id}:${t.lift}`)))
      assert(
        !(await feedbackNow(page)).ghost,
        '条内换序时**浮影一个节点都不画**(拖的就是标签本身)',
      )

      // 竖向:带内仍是换序,出了带才折。
      await moveTo(cdp, { x: target.cx, y: target.cy + 20 })
      await delay(40)
      read = await stripOrder(page, strip.leafId)
      assert(!read.some((t) => t.torn), '竖向 20px 还在带里,是换序不是撕下', JSON.stringify(read.map((t) => t.torn)))
      await strokeOn(cdp, { x: target.cx, y: target.cy + 20 }, { x: target.cx, y: target.cy + 120 }, { steps: 6 })
      read = await stripOrder(page, strip.leafId)
      assert(read.some((t) => t.torn), '出了带那一格折成 0 宽(元素还在)', JSON.stringify(read.map((t) => `${t.id}:${t.torn}`)))
      assert((await feedbackNow(page)).card, '撕下之后浮影卡片接手')
      await page.keyboard.press('Escape')
      await releaseAt(cdp, { x: target.cx, y: target.cy + 120 })
      assert((await treeShape(page)) === before, 'Esc 之后树逐字不变')

      // 一次纯点击:按下松开,位移 0。
      const t2 = (await topStrip(page)).tabs[0]
      const beforeClick = await treeShape(page)
      await press(cdp, { x: t2.cx, y: t2.cy })
      await delay(40)
      await releaseAt(cdp, { x: t2.cx, y: t2.cy })
      assert((await treeShape(page)) === beforeClick, '按下松开不动 = 一次点击,树一个字不变')
    }

    /* ══ 场景 ③:换序三处 + 150ms 滑入 + Esc + 底色逐字不变 ═══════════ */
    scenario('换序:最左/最右/中间三处正确;松手 150ms 滑入;Esc 无残留;全程三处底色不变')
    {
      const strip = await fillStrip(3)
      const order0 = (await stripOrder(page, strip.leafId)).map((t) => t.id)
      const first = strip.tabs[0]
      const last = strip.tabs[strip.tabs.length - 1]

      /*
       * **底色基线在「按下之后」量**:按下即激活会把活动那一格的底换成叶的脸
       * (那是 §4.2 第一行在工作,不是换序变色)。§4.5 管的是**换序全程** ——
       * 所以基线取激活之后那一帧,再拿它比整段拖拽里的每一帧。
       */
      await press(cdp, { x: first.cx, y: first.cy })
      await delay(80)
      const base = JSON.stringify(await palette(page, strip.leafId))

      /*
       * **(a) 刚抬起那一帧,邻居一个都不动**(§11 第 3 条的字面)。
       *
       * 它守的是「不把邻居按『拿走被拖那格之后』的位置算」那条裁定:那一版把右边
       * 的邻居整体左移一格宽再比中心,于是**手才走过 6px 的起拖阈值**、屏幕上就先
       * 跳了一下。判据换成「被拖那格朝运动方向的那条边越过邻居中心」之后,静止时
       * 落点恒等于原位,一格 transform 都不写。
       */
      await moveTo(cdp, { x: first.cx + DRAG_START_X + 1, y: first.cy })
      await delay(40)
      const liftFrame = await stripProbe(page, strip.leafId)
      const jumped = Object.entries(liftFrame.shifts).filter(([, v]) => v !== '' && v !== 'LIFTED')
      assert(
        jumped.length === 0,
        `抬起后横向刚走过 ${DRAG_START_X + 1}px:邻居的 transform 一个都不非空`,
        JSON.stringify(liftFrame.shifts),
      )

      const shots = []
      await strokeOn(cdp, { x: first.cx + DRAG_START_X + 1, y: first.cy }, { x: last.cx + last.width / 2 - 4, y: first.cy }, { steps: 12 })
      for (let i = 0; i < 4; i += 1) {
        await moveTo(cdp, { x: last.cx + last.width / 2 - 4 - i, y: first.cy })
        await delay(20)
        shots.push(JSON.stringify(await palette(page, strip.leafId)))
      }
      /*
       * **抬起那一格不放大、不改形**(§4.2 / §4.5 第 2 条)。与底色那一条一起,
       * 它们是反证二(「lift 加回 scale / 换底色」)咬得住的两条。
       * 量的是**合成矩阵的两个缩放分量**与那一格的身量:横向位移随手走,
       * 缩放与宽高一个像素都不许动。
       */
      const shape = await page.evaluate(() => {
        const el = document.querySelector('[data-lift]')
        if (!el) return null
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform)
        const r = el.getBoundingClientRect()
        return { a: m.a, d: m.d, w: Math.round(r.width), h: Math.round(r.height),
          radius: getComputedStyle(el).borderTopLeftRadius }
      })
      assert(Boolean(shape), '抬起那一格在场', JSON.stringify(shape))
      assert(
        shape && shape.a === 1 && shape.d === 1,
        '抬起那一格**不放大**(合成矩阵的两个缩放分量恒为 1)',
        JSON.stringify(shape && { a: shape.a, d: shape.d }),
      )
      assert(
        shape && shape.w === Math.round(first.width) && shape.h > 0,
        '抬起那一格**身量一个像素不变**',
        JSON.stringify({ now: shape?.w, was: Math.round(first.width) }),
      )

      const drift = shots.filter((shot) => shot !== base)
      assert(
        drift.length === 0,
        '换序全程标签条 / 内容区 / 其它标签三处底色**逐字不变**',
        drift.length ? `基线 ${base}\n     漂了 ${drift[0]}` : `${shots.length} 帧全同`,
      )

      // 松手,**不等** —— 收笔那 150ms 要当场量。
      await release(cdp, { x: last.cx + last.width / 2 - 4, y: first.cy })
      let settleRead = null
      const deadline = Date.now() + SETTLE_MS + 120
      while (Date.now() < deadline) {
        const row = await page.evaluate(() => {
          const el = document.querySelector('[data-settle]')
          if (!el) return null
          const style = getComputedStyle(el)
          return {
            id: el.getAttribute('data-tab-id'),
            transition: style.transitionProperty + ' ' + style.transitionDuration,
            transform: style.transform,
          }
        })
        if (row) {
          settleRead = row
          break
        }
        await delay(12)
      }
      assert(Boolean(settleRead), '松手之后那一格挂上了收笔态(data-settle)', JSON.stringify(settleRead))
      assert(
        settleRead && /transform/.test(settleRead.transition) && /0\.15s|150ms/.test(settleRead.transition),
        `收笔是一段 ${SETTLE_MS}ms 的位移过渡`,
        settleRead?.transition,
      )
      assert(
        settleRead && settleRead.transform !== 'none' && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(settleRead.transform),
        '而且起始位移非零(它真的从手上那个位置滑过来)',
        settleRead?.transform,
      )
      await delay(SETTLE_MS + 240)

      const order1 = (await stripOrder(page, strip.leafId)).map((t) => t.id)
      assert(order1[order1.length - 1] === order0[0], '拖到最右:它排到了末尾', `${order0.join(' | ')} → ${order1.join(' | ')}`)
      assert(
        (await stripOrder(page, strip.leafId)).find((t) => t.on)?.id === order0[0],
        '而且活动位跟着它走',
      )

      // 最左。
      const nowStrip = await topStrip(page)
      const src = nowStrip.tabs[nowStrip.tabs.length - 1]
      await stroke(cdp, { x: src.cx, y: src.cy }, { x: nowStrip.tabs[0].left + 3, y: src.cy }, { steps: 12, release: true })
      await delay(SETTLE_MS + 200)
      const order2 = (await stripOrder(page, strip.leafId)).map((t) => t.id)
      assert(order2[0] === order1[order1.length - 1], '拖到最左:它排到了第一位', `${order1.join(' | ')} → ${order2.join(' | ')}`)

      // 中间。
      const s3 = await topStrip(page)
      const mover = s3.tabs[0]
      await stroke(cdp, { x: mover.cx, y: mover.cy }, { x: s3.tabs[1].cx + s3.tabs[1].width / 2 - 2, y: mover.cy }, { steps: 12, release: true })
      await delay(SETTLE_MS + 200)
      const order3 = (await stripOrder(page, strip.leafId)).map((t) => t.id)
      assert(order3[1] === order2[0], '拖到中间:它排到了第二位', `${order2.join(' | ')} → ${order3.join(' | ')}`)

      // Esc:顺序不变、无残留。
      const s4 = await topStrip(page)
      const escSrc = s4.tabs[0]
      await press(cdp, { x: escSrc.cx, y: escSrc.cy })
      await strokeOn(cdp, { x: escSrc.cx, y: escSrc.cy }, { x: s4.tabs[2].cx, y: escSrc.cy }, { steps: 10 })
      await page.keyboard.press('Escape')
      await delay(120)
      await releaseAt(cdp, { x: s4.tabs[2].cx, y: escSrc.cy })
      const order4 = await stripOrder(page, strip.leafId)
      assert(order4.map((t) => t.id).join('|') === order3.join('|'), 'Esc 之后顺序一个字不变', order4.map((t) => t.id).join(' | '))
      assert(
        order4.every((t) => !t.lift && !t.torn && t.shift === ''),
        'Esc 之后抬起 / 折起 / 让位三样都清干净',
        JSON.stringify(order4),
      )
      assert(!(await feedbackNow(page)).ghost, 'Esc 之后浮影没了')

      /*
       * **(b) 最宽的那一格也拖得到末位**(§4.2:「中心对中心时宽标签要整个越过窄
       * 邻居才换位……而且永远够不到末位」)。中心对中心那一版在这里靠两句钳位特例
       * 救场;判据换成「边越过中心」之后,末位是判据自己算出来的。
       */
      const s5 = await topStrip(page)
      const widest = s5.tabs.reduce((a, b) => (b.width > a.width ? b : a), s5.tabs[0])
      const order5 = (await stripOrder(page, s5.leafId)).map((t) => t.id)
      await stroke(
        cdp,
        { x: widest.cx, y: widest.cy },
        { x: s5.rect.left + s5.rect.width - 4, y: widest.cy },
        { steps: 14, release: true },
      )
      await delay(SETTLE_MS + 240)
      const order6 = (await stripOrder(page, s5.leafId)).map((t) => t.id)
      assert(
        order6[order6.length - 1] === widest.id,
        `最宽的那一格(${widest.width}px)拖到最右 = 它排到了末尾`,
        `${order5.join(' | ')} → ${order6.join(' | ')}`,
      )

      /*
       * **(c) 让位发生在「被拖的右缘 = 邻居中心」那一刻,不是「中心 = 中心」**
       * (§4.2 的判据本体)。
       *
       * 抓的是被拖那格的中心,所以 grabDx = 半格宽,右缘 = 指针 x + 半格宽。
       * 「右缘 = 邻居中心」那一刻的指针 x 因此是 `邻居中心 - 半格宽`。两侧各让
       * `EDGE_EPS`px 各读一次:未越过时那个邻居的 transform 必须是空的,越过之后
       * 必须非空。**中心对中心那一版的门槛比这里晚半格宽**,于是「已越过」那一站
       * 读到的是空 —— 当场红。整段是一次不松手的连续路径。
       */
      const s7 = await topStrip(page)
      const src7 = s7.tabs[0]
      const half = src7.width / 2
      await press(cdp, { x: src7.cx, y: src7.cy })
      let from7 = { x: src7.cx + DRAG_START_X + 1, y: src7.cy }
      await strokeOn(cdp, { x: src7.cx, y: src7.cy }, from7, { steps: 3 })
      for (const nb of s7.tabs.slice(1)) {
        const cross = Math.round(nb.cx - half)
        for (const side of ['未越过', '已越过']) {
          const at = side === '未越过' ? cross - EDGE_EPS : cross + EDGE_EPS
          await strokeOn(cdp, from7, { x: at, y: src7.cy }, { steps: 4 })
          // 微动一格,而且**朝着背离门槛的方向** —— 手还在动才算数(见文件头的量法)。
          await moveTo(cdp, { x: at + (side === '未越过' ? -1 : 1), y: src7.cy })
          await delay(28)
          const shift = (await stripProbe(page, s7.leafId)).shifts[nb.id] ?? ''
          assert(
            side === '未越过' ? shift === '' : shift !== '',
            `右缘${side}「${nb.id}」的中心(指针 x=${at},门槛 ${cross})→ 它${side === '未越过' ? '不让位' : '让位'}`,
            JSON.stringify({ shift }),
          )
          from7 = { x: at, y: src7.cy }
        }
      }
      await page.keyboard.press('Escape')
      await releaseAt(cdp, from7)
    }

    /* ══ 场景 ④:「放到标签上」那条带 ═══════════════════════════════════ */
    scenario('放到标签上:横拖停 1s 不误并;压到条底缘下才描圈;回条内回换序;并 / 空白 / 拒绝')
    {
      const strip = await fillStrip(3, { singles: true })
      const src = strip.tabs[0]
      const host = strip.tabs[1]
      /*
       * 这一整场的坐标全部取自**按下之前**那一次 `topStrip`:拖拽期间那几格带着
       * transform,活矩形早就不是它们的槽位了(编舞读的也正是抬起那一刻的基准)。
       */
      const ontoY = Math.round(strip.rect.top + strip.rect.height + ONTO_Y_OFFSET)
      const order0 = (await stripOrder(page, strip.leafId)).map((t) => t.id)

      /*
       * **(a) 换序途中停住 1s,一个字都不许发生。**
       *
       * 这一条就是用户报的那句「换序途中稍一停顿就误并」的反证 —— 按时间判的那一版
       * (在邻居正中停够 300ms 就并)在这里必红。停的是**横向**:1px 的抖动只走 x,
       * 竖向一动就跨进带里去了,那是下一条要量的另一形。
       */
      await press(cdp, { x: src.cx, y: src.cy })
      await strokeOn(cdp, { x: src.cx, y: src.cy }, { x: host.cx, y: src.cy }, { steps: 10 })
      const held = []
      const until = Date.now() + 1000
      let flip = 0
      while (Date.now() < until) {
        flip = 1 - flip
        await moveTo(cdp, { x: host.cx + flip, y: src.cy })
        await delay(24)
        held.push(await stripProbe(page, strip.leafId))
      }
      const misfired = held.filter((r) => r.pairHot !== null || r.hint !== '')
      assert(
        misfired.length === 0,
        `横着拖到邻居正中停住 1s:全程没有描圈、没有提示行(${held.length} 帧)`,
        misfired.length ? JSON.stringify(misfired[0]) : `${held.length} 帧全空`,
      )
      const droppedShift = held.filter((r) => (r.shifts[host.id] ?? '') === '')
      assert(
        droppedShift.length === 0,
        '而且全程仍旧是换序 —— 那个邻居一直让着位',
        droppedShift.length ? JSON.stringify(droppedShift[0].shifts) : JSON.stringify(held[0].shifts),
      )

      /*
       * **(b) 压到条底缘下 6–24px:描圈 + 提示行,卡片不画,让位全清零。**
       */
      await strokeOn(cdp, { x: host.cx, y: src.cy }, { x: host.cx, y: ontoY }, { steps: 6 })
      await moveTo(cdp, { x: host.cx + 1, y: ontoY })
      await delay(60)
      const onto = await stripProbe(page, strip.leafId)
      assert(
        onto.pairHot === host.id,
        `压到条底缘下 ${ONTO_Y_OFFSET}px:指针底下那一格描了圈`,
        `${onto.pairHot} vs ${host.id}`,
      )
      assert(onto.hint !== '', '提示行说得出「与谁二合一」', onto.hint)
      assert(!onto.card, '**卡片仍旧不画**:屏幕上动的还是只有那一格标签', JSON.stringify(onto.card))
      const stillShifted = Object.entries(onto.shifts).filter(([, v]) => v !== '' && v !== 'LIFTED')
      assert(
        stillShifted.length === 0,
        'onto 态里邻居的让位**全部清零**(§4.2:邻居不再让位)',
        JSON.stringify(onto.shifts),
      )

      /* **(c) 回到条内:圈灭,让位恢复。** */
      await strokeOn(cdp, { x: host.cx + 1, y: ontoY }, { x: host.cx, y: src.cy }, { steps: 6 })
      await moveTo(cdp, { x: host.cx + 1, y: src.cy })
      await delay(60)
      const back = await stripProbe(page, strip.leafId)
      assert(back.pairHot === null, '回到条内(y ≤ 底缘 + 6):圈没了', JSON.stringify(back.pairHot))
      assert(
        (back.shifts[host.id] ?? '') !== '',
        '而且让位恢复了 —— 又是换序',
        JSON.stringify(back.shifts),
      )

      /* **(d) 再压下去松手 = 二合一。** */
      await strokeOn(cdp, { x: host.cx + 1, y: src.cy }, { x: host.cx, y: ontoY }, { steps: 6 })
      await releaseAt(cdp, { x: host.cx, y: ontoY })
      const after = await stripOrder(page, strip.leafId)
      assert(
        after.length === order0.length - 1,
        '松手之后条上少了一格(两格并成了一格)',
        `${order0.length} → ${after.length}`,
      )
      const slotsNow = await page.evaluate((want) => {
        const root = document.querySelector(
          `[data-pane-chrome="${want.replace(/["\\]/g, '\\$&')}"] [role="tablist"]`,
        )
        return Array.from(root?.querySelectorAll('[role="tab"]') ?? []).map((el) =>
          el.getAttribute('data-tab-slots'),
        )
      }, strip.leafId)
      assert(
        slotsNow.includes('2'),
        '并出来的那一格自述装着两份(data-tab-slots = 2)',
        JSON.stringify(slotsNow),
      )

      /*
       * **(e) 压下去,但 x 落在所有标签右侧的空白上 = 空动作。**
       * 那一行字仍旧不空(§5 贯穿规则 2:没有落点就写「松手放回」)。
       */
      const s2 = await topStrip(page)
      const lastTab = s2.tabs[s2.tabs.length - 1]
      const blankX = lastTab.left + lastTab.width + 8
      const ontoY2 = Math.round(s2.rect.top + s2.rect.height + ONTO_Y_OFFSET)
      const hasBlank = blankX < s2.rect.left + s2.rect.width - 2
      assert(hasBlank, '条上末格之后还有空白可压', JSON.stringify({ blankX, right: s2.rect.left + s2.rect.width }))
      const mover = s2.tabs.find((t) => !String(t.id).startsWith('pair:')) ?? s2.tabs[0]
      const before2 = (await stripOrder(page, s2.leafId)).map((t) => t.id)
      if (hasBlank) {
        await press(cdp, { x: mover.cx, y: mover.cy })
        await strokeOn(cdp, { x: mover.cx, y: mover.cy }, { x: blankX, y: ontoY2 }, { steps: 10 })
        await moveTo(cdp, { x: blankX + 1, y: ontoY2 })
        await delay(60)
        const blank = await stripProbe(page, s2.leafId)
        assert(blank.pairHot === null, '压在末格之后的空白上:谁都不描圈', JSON.stringify(blank.pairHot))
        assert(blank.hint !== '', '但浮影下那行字仍旧不空(「松手放回」)', blank.hint)
        await releaseAt(cdp, { x: blankX, y: ontoY2 })
        assert(
          (await stripOrder(page, s2.leafId)).map((t) => t.id).join('|') === before2.join('|'),
          '松手之后次序一个字不变(空动作)',
          before2.join(' | '),
        )
      }

      /*
       * **(f) 拖一格已经是两格的标签压下去 = 拒绝态**(§6 末行:两格的标签不能再并)。
       * 结构化拒绝,不静默(裁定 7):光标 not-allowed + 一句理由,谁都不描圈。
       */
      const s3 = await topStrip(page)
      const pairTab = s3.tabs.find((t) => String(t.id).startsWith('pair:'))
      const other = s3.tabs.find((t) => t.id !== pairTab?.id)
      const ontoY3 = Math.round(s3.rect.top + s3.rect.height + ONTO_Y_OFFSET)
      assert(Boolean(pairTab && other), '条上有一格两格标签、还有另一格可以压上去', JSON.stringify(s3.tabs.map((t) => t.id)))
      if (pairTab && other) {
        const treeBefore = await treeShape(page)
        await press(cdp, { x: pairTab.cx, y: pairTab.cy })
        await strokeOn(cdp, { x: pairTab.cx, y: pairTab.cy }, { x: other.cx, y: ontoY3 }, { steps: 10 })
        await moveTo(cdp, { x: other.cx + 1, y: ontoY3 })
        await delay(60)
        const refused = await stripProbe(page, s3.leafId)
        assert(refused.cursorRefuse, '两格标签压下去:光标 not-allowed', JSON.stringify(refused.cursorRefuse))
        assert(refused.hint !== '', '而且给得出一句理由', refused.hint)
        assert(refused.pairHot === null, '谁都不描圈(它并不进去)', JSON.stringify(refused.pairHot))
        await releaseAt(cdp, { x: other.cx, y: ontoY3 })
        assert((await treeShape(page)) === treeBefore, '松手之后树一个字不变')
      }
    }

    /* ══ 场景 ⑤:架子 → 聊天区中间 / 右带;浮窗不接住自己 ═════════════ */
    scenario('从架子拖文件到聊天区:中间 = 新标签,右带 = 二合一;浮窗不接住自己')
    {
      /*
       * **绕开那扇浮窗,而不是把它收起来**(门第三版的修法)。
       *
       * 总览是一扇 880×520 的居中浮窗,正盖住聊天区的中段;点 Dock 那块瓦是**开关**,
       * 但它此刻是焦点面,连点两下只会「收起 → 再开」,读数是浮窗还在。
       * 而这一条要量的是「落到**聊天区**的中间 / 右带会怎样」,不是「浮窗能不能收」
       * —— 后者是 gate:focus 的地。所以这里改成:在中央叶里挑一个**不被任何浮窗
       * 盖住**的点。判据本身一个字都不用绕:「叶重叠时取最上」照旧成立,只是探针
       * 站到了没有第二片叶的地方。
       */
      const pointIn = (fx) =>
        page.evaluate((wantFx) => {
          const slot = document.querySelector('[data-pane-region="center"] [data-pane-slot]')
          if (!slot) return null
          const r = slot.getBoundingClientRect()
          const floats = Array.from(document.querySelectorAll('[data-float-body]')).map((el) => {
            const win = el.closest('[role="dialog"]') ?? el
            return win.getBoundingClientRect()
          })
          const x = r.left + r.width * wantFx
          // 从叶的竖向中线往下找,直到落在所有浮窗之外(叶比浮窗高,总找得到)。
          for (const t of [0.5, 0.72, 0.86, 0.94, 0.2, 0.08]) {
            const y = r.top + r.height * t
            if (!floats.some((f) => x >= f.left && x <= f.right && y >= f.top && y <= f.bottom)) {
              return { x: Math.round(x), y: Math.round(y), leaf: {
                left: Math.round(r.left), top: Math.round(r.top),
                width: Math.round(r.width), height: Math.round(r.height),
              } }
            }
          }
          return null
        }, fx)
      const midPoint = await pointIn(0.5)
      const rightPoint = await pointIn(1 - 0.28 / 2)
      const leaf = midPoint ? { rect: midPoint.leaf, y: midPoint.y } : null
      const row = await centerOf(page, `[data-file-path="${path.join(cwd, 'gamma.ts')}"]`)
      assert(
        Boolean(leaf && row && rightPoint),
        '中央叶里找得到不被浮窗盖住的中点与右带点',
        JSON.stringify({ mid: midPoint, right: rightPoint }),
      )
      if (leaf && row && midPoint && rightPoint) {
        const gammaId = `file:${path.join(cwd, 'gamma.ts')}`
        const before = (await stripOrder(page, (await topStrip(page)).leafId)).length
        // 中间:一路走过去、不停顿,途中量氛围与提示。
        const mid = { x: midPoint.x, y: midPoint.y }
        const seen = await stroke(cdp, row, mid, { steps: 12, holdMs: 200, sample: () => feedbackNow(page) })
        const last = seen[seen.length - 1]
        assert(last.shape === 'ring', '中间那一档画的是一圈环', JSON.stringify(last))
        assert(last.ambient > 0, '**从外面拖进来时能放的地方先淡亮一层**(氛围)', String(last.ambient))
        assert(last.hint !== '', '提示行说的是「开成新标签」这一档', last.hint)
        await releaseAt(cdp, mid)
        const strip2 = await topStrip(page)
        assert(
          strip2.tabs.some((t) => t.id === gammaId),
          '松手之后它成了中央那条条上的一格新标签',
          strip2.tabs.map((t) => t.id).join(' | '),
        )
        assert(strip2.tabs.length === before + 1, '条上多了一格,不是替换', `${before} → ${strip2.tabs.length}`)

        // 右带 28%:二合一。
        const row2 = await centerOf(page, `[data-file-path="${path.join(cwd, 'alpha.ts')}"]`)
        const rightBand = { x: rightPoint.x, y: rightPoint.y }
        if (row2) {
          const seen2 = await stroke(cdp, row2, rightBand, { steps: 12, holdMs: 160, sample: () => feedbackNow(page) })
          const r2 = seen2[seen2.length - 1]
          assert(r2.shape === 'half', '右带那一档画的是「落下后占的那一半」', JSON.stringify(r2))
          assert(
            r2.bandRect && Math.abs(r2.bandRect.width - Math.round(leaf.rect.width / 2)) <= 2,
            '而且那一半就是叶的一半宽',
            JSON.stringify({ band: r2.bandRect?.width, half: Math.round(leaf.rect.width / 2) }),
          )
          assert(r2.hint !== '', '提示行说的是「与 X 二合一」', r2.hint)
          const tabsBefore = (await topStrip(page)).tabs.length
          await releaseAt(cdp, rightBand)
          const strip3 = await topStrip(page)
          const paired = await page.evaluate(() =>
            Array.from(document.querySelectorAll('[data-tab-slots]')).map((el) => el.getAttribute('data-tab-id')),
          )
          assert(paired.length > 0, '松手之后条上有一格装着两份', JSON.stringify(paired))
          assert(strip3.tabs.length <= tabsBefore + 1, '而且没有多长出一片叶(单叶政策)', `${tabsBefore} → ${strip3.tabs.length}`)
        }
      }

      /*
       * **浮窗不接住自己**(§8):从总览那扇浮窗里拖一条会话行出来,指针停在
       * **那扇窗自己身上** —— 落点该是窗底下那片叶,不是它自己。
       */
      const float = await centerOf(page, '[data-float-body]')
      const sessionRow = await centerOf(page, '[data-session-id]:not([aria-selected="true"])')
      if (float && sessionRow) {
        await press(cdp, sessionRow)
        await strokeOn(cdp, sessionRow, { x: float.x, y: float.y }, { steps: 10 })
        await moveTo(cdp, { x: float.x + 1, y: float.y })
        await delay(40)
        const read = await page.evaluate(() => {
          const band = document.querySelector('[data-testid="drop-overlay"]')
          if (!band) return null
          const r = band.getBoundingClientRect()
          return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
        })
        assert(Boolean(read), '停在那扇浮窗身上时有落区', JSON.stringify(read))
        assert(
          read && (read.width > float.rect.width + 8 || read.height > float.rect.height + 8),
          '**落区不是那扇窗自己** —— 它比窗大得多(判的是窗底下那片叶)',
          JSON.stringify({ band: read, float: float.rect }),
        )
        await page.keyboard.press('Escape')
        await releaseAt(cdp, { x: float.x, y: float.y })
      } else {
        assert(false, '总览浮窗与一条会话行都在场', JSON.stringify({ float: Boolean(float), row: Boolean(sessionRow) }))
      }
    }

    /* ══ 场景 ⑥:零重挂(换序 / 二合一 / 拆开 / 换比例)══════════════ */
    scenario('零重挂:换序、二合一、拆开、换比例四步,内容根节点同一个 DOM')
    {
      const bodySel = '[data-pane-region="center"] [data-pane-body]'
      await stamp(page, bodySel, 'body-node')
      const strip = await fillStrip(2, { singles: true })

      // ① 换序。
      const a = strip.tabs[0]
      const b = strip.tabs[1]
      await stroke(cdp, { x: a.cx, y: a.cy }, { x: b.cx + b.width / 2 - 2, y: a.cy }, { steps: 10, release: true })
      await delay(SETTLE_MS + 200)
      assert(await stampSurvives(page, bodySel, 'body-node'), '换序之后内容根还是同一个节点')

      // ② 二合一(走「放到标签上」那条路:压到条底缘下 6–24px 再松手)。
      const s2 = await fillStrip(2, { singles: true })
      const single = s2.tabs.filter((t) => !t.id.startsWith('pair:'))
      if (single.length >= 2) {
        const ontoY = Math.round(s2.rect.top + s2.rect.height + ONTO_Y_OFFSET)
        await press(cdp, { x: single[0].cx, y: single[0].cy })
        await strokeOn(cdp, { x: single[0].cx, y: single[0].cy }, { x: single[1].cx, y: ontoY }, { steps: 10 })
        await moveTo(cdp, { x: single[1].cx + 1, y: ontoY })
        await delay(60)
        await releaseAt(cdp, { x: single[1].cx, y: ontoY })
        assert(await stampSurvives(page, bodySel, 'body-node'), '二合一之后内容根还是同一个节点')
      } else {
        assert(false, '条上有两格普通标签可以并', JSON.stringify(s2.tabs.map((t) => t.id)))
      }

      // ③ 换比例(拖那根分隔杆)+ ④ 拆开(格头上那颗)。
      const seam = await centerOf(page, '[data-testid^="pair-splitter"]')
      if (seam) {
        await stroke(cdp, seam, { x: seam.x - 60, y: seam.y }, { steps: 8, release: true })
        assert(await stampSurvives(page, bodySel, 'body-node'), '换比例之后内容根还是同一个节点')
      } else {
        assert(false, '两格标签里有一根分隔杆', 'pair-splitter 不在 DOM 里')
      }
      const unpaired = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid^="pair-unpair"]')
        if (!(btn instanceof HTMLElement)) return false
        btn.click()
        return true
      })
      await delay(320)
      assert(unpaired, '格头上那颗「拆开」按得到')
      if (unpaired) {
        assert(await stampSurvives(page, bodySel, 'body-node'), '拆开之后内容根还是同一个节点')
      }
    }

    /* ══ 场景 ⑦:拒绝态 —— 光标、理由、弹回 ═══════════════════════════ */
    scenario('拒绝区:not-allowed 光标 + 一句理由;松手弹回,树一个字不变')
    {
      const dock = await centerOf(page, '[data-dock="strip"]')
      const row = await centerOf(page, `[data-file-path="${path.join(cwd, 'beta.ts')}"]`)
      assert(Boolean(dock && row), 'Dock 与文件行都量得到', JSON.stringify(dock?.rect))
      if (dock && row) {
        const before = await treeShape(page)
        const seen = await stroke(cdp, row, dock, { steps: 12, holdMs: 160, sample: () => feedbackNow(page) })
        const read = seen[seen.length - 1]
        assert(read.refused, 'Dock 上是拒绝态(浮影变灰虚线)', JSON.stringify(read))
        assert(read.cursorRefuse, '而且整扇窗的光标换成了 not-allowed(根属性驱动)')
        assert(read.hint !== '', '拒绝也说得出理由,不静默', read.hint)
        assert(read.shape === null, '拒绝时不画一块接受色的高亮')
        await releaseAt(cdp, dock)
        assert((await treeShape(page)) === before, '松手之后树逐字不变(弹回,空动作)')
        assert(
          !(await page.evaluate(() => document.documentElement.hasAttribute('data-drag-refuse'))),
          '拒绝光标在结束路径上摘掉了(留着的话整扇窗从此都是禁止光标)',
        )
      }

      // 顶栏尾格同理。
      const trailing = await centerOf(page, '[data-testid="topbar-trailing"]')
      const row2 = await centerOf(page, `[data-file-path="${path.join(cwd, 'beta.ts')}"]`)
      if (trailing && row2 && trailing.rect.width > 0) {
        const seen = await stroke(cdp, row2, trailing, { steps: 10, holdMs: 120, sample: () => feedbackNow(page) })
        assert(seen[seen.length - 1].refused, '顶栏尾格也是拒绝区', JSON.stringify(seen[seen.length - 1]))
        await releaseAt(cdp, trailing)
      } else {
        assert(false, '顶栏尾格量得到', JSON.stringify(trailing?.rect))
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
