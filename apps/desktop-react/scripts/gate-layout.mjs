#!/usr/bin/env node
/**
 * **位置机的真机门**(W7-p,规格 `scratchpad/w7p-spec.md`;审计现场
 * `docs/audit/` 那一批之外的离屏读数在 `audit-A/findings-summary.md`)。
 *
 * ── 它守的是什么 ────────────────────────────────────────────────────────
 * 这一批交付的六条裁定,**每一条的病都只在真机上存在**:
 *  ① 重启丢布局 —— 病根是**模块图的求值次序**(`import App` 排在
 *    `import './content/kinds'` 前面),jsdom 里一个文件一份模块图,单测能证
 *    「水合那一遍不问种类」,证不了「关窗再起之后屏幕上还是那三块」;
 *  ② 全屏吃掉钉边记忆 —— 要一个真的 `localStorage` 跨两次进程才看得见;
 *  ③④ 架子共同预算与 resize 重钳 —— jsdom 不排版,`getBoundingClientRect`
 *    一律答零,「中央区还剩多高」「输入框压没压在架子上」根本不存在;
 *  ⑤ 浮窗层叠 —— 同上,四扇窗的矩形要真排版才量得到;
 *  ⑥ 召唤两条路 —— 焦点、架子展开、tab 次序,三样都要真 DOM。
 * 08-30 那条判例的原话:交互时序类改动必须真机对照,jsdom 的绿不算数。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 * 离屏(`ONETHING_GATE_HEADLESS=1`)、临时 store、自己的 `--user-data-dir`、
 * CDP 补焦点、finally 收尸。**不连 5175、不碰 `~/.onething`、窗口不到前台、
 * 没有一处系统级合成输入**(09-01 判例:手势探针一律走这个窗口自己的输入管线)。
 * 手势一律是**真手势**:Dock 瓦的 click / contextmenu、菜单里那一行的 click、
 * 键盘 `page.keyboard.press`、`BrowserWindow.setSize`。
 *
 * 跑法:`npm run gate:layout`。
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

/**
 * 判据这一头的那几个数,**从源码里读**(W7-p 修一轮裁定 7;体例照 `gate-perf.mjs`
 * 读 `src/perf-budget.ts` 的做法)。
 *
 * 从前它们是抄在这里的字面量,而抄一份的代价不是「哪天忘了同步」这么轻 ——
 * 门抄的那份**永远绿**,产品改了它照样说 ok:一道拿自己的算术判自己的门。
 * 今天改 `transitions.ts` 的任何一格,这道门当场跟着走;那只文件里删了哪一格,
 * 这里当场抛(下面 `num()` 找不到就报名字)。
 */
const TRANSITIONS_SRC = readFileSync(path.join(appRoot, 'src/stage/transitions.ts'), 'utf-8')
const TOKENS_SRC = readFileSync(path.join(appRoot, 'src/styles/tokens.css'), 'utf-8')
  // 读样式表源文本的门先剥注释(仓规):病历文本里写着这些数,不剥会读到注释里那个。
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** 从 `transitions.ts` 读一格 `export const <名> = <数>`。 */
function num(name) {
  const hit = new RegExp(`export const ${name} = (-?\\d+(?:\\.\\d+)?)`).exec(TRANSITIONS_SRC)
  if (!hit) throw new Error(`transitions.ts 里没有 export const ${name} —— 判据与产品对不上了`)
  return Number(hit[1])
}

/** 从 tokens.css 读一格 `--<名>: <数>px`。 */
function token(name) {
  const hit = new RegExp(`--${name}:\\s*([0-9.]+)px`).exec(TOKENS_SRC)
  if (!hit) throw new Error(`tokens.css 里没有 --${name}`)
  return Number(hit[1])
}

const CENTER_MIN_W = num('CENTER_MIN_W')
const CENTER_MIN_H = num('CENTER_MIN_H')
const FLOAT_MARGIN = num('FLOAT_MARGIN')
const FLOAT_DEFAULT_W = num('FLOAT_DEFAULT_W')
const FLOAT_DEFAULT_H = num('FLOAT_DEFAULT_H')
const FLOAT_SPAWN_INSET = num('FLOAT_SPAWN_INSET')
const FLOAT_CASCADE_STEP = num('FLOAT_CASCADE_STEP')
/** 顶栏那条带(`--topbar-h`)。中央区从它**之下**起算 —— 标签条就长在顶栏里。 */
const TOP_CHROME = num('TOP_CHROME')
/** 收起来的架子还占着的那条细梁。两侧同源由 `transitions.test.ts` 那组对账钉着。 */
const SHELF_RAIL = num('SHELF_RAIL')
if (token('topbar-h') !== TOP_CHROME || token('shelf-rail') !== SHELF_RAIL) {
  throw new Error('tokens.css 与 transitions.ts 的顶栏 / 细梁对不上 —— 先修那两处同源')
}

/**
 * **拒绝那一句**(W7-p 修一轮裁定 3)。门不挑 locale,所以两种语言的骨架都收进来
 * ——它读的是「有没有说话」,不是「说的是哪国话」。
 */
const NO_ROOM_RE = /No room on|放不下了/

/** 三档窗口尺寸(裁定 3 的第二半:每一档都不许有元素出视口)。 */
const SIZES = [
  { w: 1280, h: 860 },
  { w: 900, h: 600 },
  { w: 700, h: 500 },
]

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── 门自己的记账 ───────────────────────────────────────────────────────── */

const results = []
let currentScene = '(未命名)'
function scene(name) {
  currentScene = name
  process.stdout.write(`\n── ${name} ──\n`)
}
function check(label, ok, detail = '') {
  results.push({ scene: currentScene, label, ok: Boolean(ok), detail })
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}\n`)
}

/* ── core ──────────────────────────────────────────────────────────────── */

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
    socket.setTimeout(800)
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.once('timeout', () => settle(false))
  })
}

async function waitFor(what, fn, ms = 30000) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > until) throw new Error(`超时:${what}`)
    await delay(150)
  }
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
  const body = await res.json()
  if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method}: ${JSON.stringify(body?.error ?? body)}`)
  return body.data
}

/* ── 页面这一头的读数(整份一次量完 —— 分几次量会读到两个不同的时刻)────── */

const READ_LAYOUT = () => {
  const round = (r) => ({
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.width),
    h: Math.round(r.height),
  })
  const rectOf = (el) => (el ? round(el.getBoundingClientRect()) : null)
  const tabsIn = (el) =>
    Array.from(el?.querySelectorAll('[role="tab"]') ?? []).map((t) => ({
      id: t.getAttribute('data-tab-id'),
      on: t.getAttribute('aria-selected') === 'true',
    }))
  const shelf = (side) => {
    const el = document.querySelector(`[data-shelf="${side}"]`)
    if (!el) return null
    return {
      rect: rectOf(el),
      collapsed: !el.querySelector(`[data-shelf-body="${side}"]`),
      tabs: tabsIn(el),
    }
  }
  const persisted = (key) => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null')
    } catch {
      return null
    }
  }
  const wb = persisted('onething.workbench')
  const stage = persisted('onething.stage')
  const space = (blob) => blob?.state?.byWorkspace?.default ?? blob?.state ?? null
  const top = document.querySelector('[data-testid="topbar-tabs"]')
  return {
    vp: { w: window.innerWidth, h: window.innerHeight },
    doc: {
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      sh: document.documentElement.scrollHeight,
      ch: document.documentElement.clientHeight,
    },
    shelves: {
      left: shelf('left'),
      right: shelf('right'),
      top: shelf('top'),
      bottom: shelf('bottom'),
    },
    floats: Array.from(document.querySelectorAll('[data-float-body]')).map((body) => ({
      id: body.getAttribute('data-float-body'),
      rect: rectOf(body.closest('[role="dialog"]')),
      tabs: tabsIn(body),
    })),
    center: rectOf(document.querySelector('[data-pane-region="center"]')),
    centerTabs: tabsIn(top),
    composer: rectOf(document.querySelector('[data-testid="composer-dock"]')),
    topBar: rectOf(document.querySelector('[data-testid="topbar-tabs"]')),
    full: Boolean(document.querySelector('[data-testid="full-layer"]')),
    /** 读屏那一口此刻在念的那句(拒绝播报量的就是它,W7-p 修一轮裁定 3)。 */
    live: (document.querySelector('[data-live="polite"]')?.textContent ?? '').trim(),
    focus: (() => {
      const dump = window.__focus?.dump?.()
      return { focused: dump?.focused ?? null, path: dump?.path ?? [] }
    })(),
    /** 落盘那一份(重启那一条要逐字比,所以整块取回来)。 */
    persist: {
      wbRegions: space(wb)?.regions ?? null,
      wbHidden: space(wb)?.hidden ?? null,
      stageMemory: space(stage)?.memory ?? null,
      stageShelves: space(stage)?.shelves ?? null,
    },
  }
}

const read = (page) => page.evaluate(READ_LAYOUT)

/* ── 真手势 ────────────────────────────────────────────────────────────── */

/** 点一块 Dock 瓦(与用户点它逐字同一条路:`Dock.tsx` 的 onClick)。 */
async function clickTile(page, id) {
  const ok = await page.evaluate((tile) => {
    const el = document.querySelector(`[data-testid="dock-tile-${tile}"]`)
    if (!(el instanceof HTMLElement)) return false
    el.click()
    return true
  }, id)
  if (!ok) throw new Error(`Dock 上没有这块瓦:${id}`)
  await delay(700)
}

/** Dock 瓦右键 → 菜单里点那一行(落点单选 / 「在 Dock 上隐藏」都走它)。 */
async function pickFromTileMenu(page, id, labelRe) {
  const opened = await page.evaluate((tile) => {
    const el = document.querySelector(`[data-testid="dock-tile-${tile}"]`)
    if (!(el instanceof HTMLElement)) return false
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }))
    return true
  }, id)
  if (!opened) throw new Error(`Dock 上没有这块瓦:${id}`)
  await delay(350)
  const picked = await page.evaluate((source) => {
    const re = new RegExp(source)
    const rows = Array.from(document.querySelectorAll('[role="menu"] [role="menuitemradio"], [role="menu"] [role="menuitem"]'))
    const hit = rows.find((el) => re.test((el.textContent ?? '').trim()))
    if (hit instanceof HTMLElement) {
      hit.click()
      return true
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return false
  }, labelRe.source)
  await delay(800)
  return picked
}

/** 标签右键 → 那张动作表里点一行(W6-c:标签右键与格头钮开同一张)。 */
async function pickFromTabMenu(page, tabId, labelRe) {
  const opened = await page.evaluate((id) => {
    const tab = document.querySelector(`[role="tab"][data-tab-id="${id}"]`)
    if (!(tab instanceof HTMLElement)) return false
    const r = tab.getBoundingClientRect()
    tab.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: Math.round(r.x + r.width / 2),
      clientY: Math.round(r.y + r.height / 2),
    }))
    return true
  }, tabId)
  if (!opened) throw new Error(`屏幕上没有这一格标签:${tabId}`)
  await delay(350)
  const picked = await page.evaluate((source) => {
    const re = new RegExp(source)
    const rows = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"]'))
    const hit = rows.find((el) => re.test((el.textContent ?? '').trim()))
    if (hit instanceof HTMLElement) {
      hit.click()
      return true
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return false
  }, labelRe.source)
  await delay(800)
  return picked
}

/** 会话行右键 → 菜单里点那一行(「在右边打开」拿它把两条会话摆成两片叶)。 */
async function pickFromSessionRowMenu(page, sessionId, labelRe) {
  const opened = await page.evaluate((id) => {
    const el = document.querySelector(`[data-session-id="${id}"]`)
    if (!(el instanceof HTMLElement)) return false
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: Math.round(r.x + r.width / 2),
      clientY: Math.round(r.y + r.height / 2),
    }))
    return true
  }, sessionId)
  if (!opened) throw new Error(`会话列表里没有这一行:${sessionId}`)
  await delay(350)
  const picked = await page.evaluate((source) => {
    const re = new RegExp(source)
    const rows = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"]'))
    const hit = rows.find((el) => re.test((el.textContent ?? '').trim()))
    if (hit instanceof HTMLElement) {
      hit.click()
      return true
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return false
  }, labelRe.source)
  await delay(900)
  return picked
}

/** 点一行会话(sidebar 单击 —— B4 那一条量的就是它)。 */
async function clickSessionRow(page, sessionId) {
  const ok = await page.evaluate((id) => {
    const el = document.querySelector(`[data-session-id="${id}"]`)
    if (!(el instanceof HTMLElement)) return false
    el.click()
    return true
  }, sessionId)
  if (!ok) throw new Error(`会话列表里没有这一行:${sessionId}`)
  await delay(900)
}

async function setSize(app, page, w, h) {
  const win = await app.browserWindow(page)
  // 主进程给窗子钉了 900×600 的下限,不放开就量不到 700×500 那一档。
  await win.evaluate((bw) => bw.setMinimumSize(320, 320))
  await win.evaluate((bw, size) => bw.setSize(size.w, size.h), { w, h })
  // 重钳走一条 resize + rAF 合并,给它两帧再加一点余量。
  await delay(700)
}

/* ── 起窗 / 收窗 ───────────────────────────────────────────────────────── */

const live = { server: null, apps: new Set() }

async function launch(store, userDataDir) {
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ONETHING_STORE_PATH: store,
      ONETHING_REACT_DEV_SERVER_URL: '',
      ONETHING_GATE_HEADLESS: '1',
    },
  })
  live.apps.add(app)
  const page = await app.firstWindow()
  const cdp = await app.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor('渲染层完成一次 RPC 往返', async () => {
    const value = await page.evaluate(() => window.__d0 ?? null)
    return value && value.rpcOk ? value : undefined
  })
  await waitFor('Dock 就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid^="dock-tile-"]'))),
  )
  await delay(900)
  return { app, page }
}

async function shut(handle) {
  if (!handle) return
  try {
    await handle.app.close()
  } catch {
    /* 关不上不阻断收尸 */
  }
  live.apps.delete(handle.app)
  await delay(400)
}

/* ── 场景 ──────────────────────────────────────────────────────────────── */

const rectEq = (a, b) => Boolean(a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
/** 这条边此刻真占了多厚(与 `transitions.shelfExtentOf` 三档逐字同义:空 0 / 细梁 / 厚度)。 */
const shelfExtent = (shelf, side) => {
  if (!shelf) return 0
  if (shelf.collapsed) return SHELF_RAIL
  return side === 'left' || side === 'right' ? shelf.rect.w : shelf.rect.h
}
const inViewport = (r, vp) =>
  r.x >= FLOAT_MARGIN - 1
  && r.y >= 0
  && r.x + r.w <= vp.w - FLOAT_MARGIN + 1
  && r.y + r.h <= vp.h - FLOAT_MARGIN + 1
const intersects = (a, b) =>
  Boolean(a && b) && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
/**
 * **全壳此刻摆着的所有标签**(中央区 + 四条架子 + 每扇浮窗),按固定次序。
 * ⑥c 那一档按它读:「不新开、不顶替」是一句关于**整台壳**的话,盯着中央区那一格
 * 会漏掉「它其实在右架子上多开了一格」这种走样。
 */
const allTabs = (layout) => [
  ...layout.centerTabs,
  ...['left', 'right', 'top', 'bottom'].flatMap((side) => layout.shelves[side]?.tabs ?? []),
  ...layout.floats.flatMap((f) => f.tabs),
]

/**
 * ① **关窗再起,家具一格不少**(裁定 1,审计 A 的 A1)。
 *
 * 病历:`main.tsx` 的 `import App` 闭包经过 `workbench/store`,而
 * `import './content/kinds'` 排在它后面 —— 水合那一刻种类表是空的,从前那一遍
 * `T.sanitize({ known: isKnownContentKind })` 于是把**每一格标签**当未知种类剔掉:
 * 四条边与每一扇浮窗整棵消失,中央区塌成一片新叶(连 leaf id 都换),随后第一次
 * `set` 触发 partialize 回写,用户摆了半年的家具当场被这份塌过的覆盖。
 *
 * 所以这一条**必须跨两次进程**:同 store、同 user-data-dir 起第二遍,逐字比。
 * 反证:把 merge 里那两句换回 `normalizeRegions` / `normalizeHidden` → 第二次起窗
 * 时三个区域全没,中央区 leaf id 也换了,这一组四条一起红。
 */
async function sceneRestart(store, udd) {
  scene('① 重启:钉右 + 钉左 + 一扇浮窗 → 关窗 → 再起,三处逐字恢复(裁定 1 / A1)')
  let handle = await launch(store, udd)
  let before
  try {
    if (!(await pickFromTileMenu(handle.page, 'diff', /^Right$|钉到右边|右栏/))) {
      throw new Error('Dock 菜单里没有「Right」那一行')
    }
    if (!(await pickFromTileMenu(handle.page, 'terminal', /^Left$|钉到左边|左栏/))) {
      throw new Error('Dock 菜单里没有「Left」那一行')
    }
    if (!(await pickFromTileMenu(handle.page, 'providers', /^Float$|浮窗/))) {
      throw new Error('Dock 菜单里没有「Float」那一行')
    }
    before = await read(handle.page)
    check('摆完:右架子在', Boolean(before.shelves.right), JSON.stringify(before.shelves.right?.tabs))
    check('摆完:左架子在', Boolean(before.shelves.left), JSON.stringify(before.shelves.left?.tabs))
    check('摆完:一扇浮窗在', before.floats.length === 1, `floats=${before.floats.length}`)
  } finally {
    await shut(handle)
    handle = null
  }

  handle = await launch(store, udd)
  try {
    const after = await read(handle.page)
    const keys = (r) => Object.keys(r ?? {}).sort()
    check(
      '再起:落盘的区域一个不少',
      JSON.stringify(keys(after.persist.wbRegions)) === JSON.stringify(keys(before.persist.wbRegions)),
      `before=${JSON.stringify(keys(before.persist.wbRegions))} after=${JSON.stringify(keys(after.persist.wbRegions))}`,
    )
    check(
      '再起:中央区那片叶连 id 都不换',
      after.persist.wbRegions?.center?.id === before.persist.wbRegions?.center?.id,
      `${before.persist.wbRegions?.center?.id} → ${after.persist.wbRegions?.center?.id}`,
    )
    check(
      '再起:右架子上那一格逐字还在',
      JSON.stringify(after.shelves.right?.tabs) === JSON.stringify(before.shelves.right?.tabs),
      JSON.stringify(after.shelves.right?.tabs),
    )
    check(
      '再起:左架子上那一格逐字还在',
      JSON.stringify(after.shelves.left?.tabs) === JSON.stringify(before.shelves.left?.tabs),
      JSON.stringify(after.shelves.left?.tabs),
    )
    check(
      '再起:那扇浮窗还在,装的还是同一格',
      after.floats.length === 1
        && JSON.stringify(after.floats[0]?.tabs) === JSON.stringify(before.floats[0]?.tabs),
      JSON.stringify(after.floats.map((f) => f.tabs)),
    )
    return handle
  } catch (err) {
    await shut(handle)
    throw err
  }
}

/**
 * ② **全屏是瞬态,不是住处**(裁定 2,审计 A 的 A2)。
 *
 * 病历:W2 那一支把全屏当成一种住处 —— 摘树 + `remember(id, {kind:'full'})`。
 * 于是一块钉在右边的瓦全屏一次,记忆被改写成 full,退出后它回了 Dock,
 * 此后**点它永远进全屏**,右架子再也回不来(用户没有任何一步能撤销它)。
 *
 * 反证:把 `placeAs` 的 full 支里那两句(`detachItem` / `remember`)加回去 →
 * 「退出后右架子还在」与「记忆仍是 edge right」当场红。
 */
async function sceneFull(handle) {
  scene('② 全屏:进 → Esc → 原住处与记忆都没被吃掉(裁定 2 / A2)')
  const { page } = handle
  const before = await read(page)
  check(
    '前提:diff 钉在右架子上、记忆记着 edge right',
    before.persist.stageMemory?.diff?.kind === 'edge' && before.persist.stageMemory?.diff?.side === 'right',
    JSON.stringify(before.persist.stageMemory?.diff),
  )
  if (!(await pickFromTileMenu(page, 'diff', /^Full screen$|全屏/))) {
    throw new Error('Dock 菜单里没有「Full screen」那一行')
  }
  const inFull = await read(page)
  check('进得去:全屏层铺上来了', inFull.full)
  check(
    '全屏期间树一个字没动:右架子仍旧带着 diff',
    Boolean(inFull.shelves.right) && inFull.shelves.right.tabs.some((t) => t.id === 'panel:diff'),
    JSON.stringify(inFull.shelves.right?.tabs),
  )
  await page.keyboard.press('Escape')
  await delay(800)
  const out = await read(page)
  check('Esc 退得出', !out.full)
  check(
    '退出之后右架子还在,diff 还钉在上面',
    Boolean(out.shelves.right) && out.shelves.right.tabs.some((t) => t.id === 'panel:diff'),
    JSON.stringify(out.shelves.right?.tabs),
  )
  check(
    '记忆一个字没被改写:仍旧是 edge right',
    out.persist.stageMemory?.diff?.kind === 'edge' && out.persist.stageMemory?.diff?.side === 'right',
    JSON.stringify(out.persist.stageMemory?.diff),
  )
  // 「再点瓦 = 展开架子,不是全屏」:先把那条架子收成细梁,再点。
  await page.keyboard.press('Meta+Alt+ArrowRight')
  await delay(600)
  const collapsed = await read(page)
  check('前提:右架子已收成细梁', collapsed.shelves.right?.collapsed === true)
  await clickTile(page, 'diff')
  const back = await read(page)
  check('再点那块瓦:架子展开了', back.shelves.right?.collapsed === false)
  check('再点那块瓦:没有进全屏', !back.full)

  /*
   * **A9:全屏铺着时召唤别的瓦 —— 先退全屏,再照四态开出来**
   * (W7-p 裁定 6 的 A9;修一轮裁定 8 补的这一档)。
   *
   * 真机现场:全屏铺着,点另一块瓦 / 按 ⌘ 数字,那块面开在全屏层**底下** ——
   * 屏幕上什么都没变、焦点也没进去,用户得到的是「没反应」。
   * 这一档同时再钉一次裁定 2 的另一半:退全屏**把原住处放回**,而「放回」不需要
   * 动作 —— 全屏期间树一个字没动,所以那条右架子始终在。
   *
   * 反证:把 `store.summonItem` 里那句无条件的 `exitFullIfOpen()` 拆掉 →
   * 「全屏层退掉了」当场红(浮窗开在全屏底下,屏幕上一动不动)。
   */
  if (!(await pickFromTileMenu(page, 'diff', /^Full screen$|全屏/))) {
    throw new Error('Dock 菜单里没有「Full screen」那一行')
  }
  check('A9 前提:全屏又铺上来了', (await read(page)).full)
  await clickTile(page, 'browser')
  const after = await read(page)
  check('A9:召唤别的瓦 → 全屏层退掉了', !after.full)
  check(
    'A9:退全屏把原住处放回 —— 右架子与 diff 原样都在',
    Boolean(after.shelves.right) && after.shelves.right.tabs.some((t) => t.id === 'panel:diff'),
    JSON.stringify(after.shelves.right?.tabs),
  )
  check(
    'A9:那块被召唤的瓦真的开出来了(四态第一格)',
    after.floats.some((f) => f.tabs.some((t) => t.id === 'panel:browser')),
    JSON.stringify(after.floats.map((f) => f.tabs.map((t) => t.id))),
  )
  // 收拾现场:把那扇窗收回去,后面的场景各起各的进程,这里只保证不留脏。
  await clickTile(page, 'browser')
  await clickTile(page, 'browser')
}

/**
 * ③ **四条边与中央区分同一块地**(裁定 3,审计 A 的 A3/A4)。
 *
 * 病历两条:①四边各钉 400,真机量到中央区 h = 0,输入框浮在上架子的内容上;
 * ②窗口变小时架子从不重钳,右架子探出屏幕 204px。
 *
 * 门的判据因此也是两条:摆完之后**中央区仍旧站得住**、输入框不与任何一条架子
 * 相交;以及三档窗口尺寸下**没有一个元素出视口**。
 * 反证:把 `placeAs` 的 edge 支里那句 `canNailShelf` 拆掉 → 中央区那两条红;
 * 把 `reclampAll` 里那句 `reclampShelves` 拆掉 → 三档那一组红。
 */
async function sceneBudget(store, udd) {
  scene('③ 四边预算 + 三档挤压:中央区站得住、没有元素出视口(裁定 3 / A3·A4)')
  const handle = await launch(store, udd)
  try {
    const { page, app } = handle
    await setSize(app, page, SIZES[0].w, SIZES[0].h)
    for (const [tile, label] of [
      ['diff', /^Right$/],
      ['terminal', /^Left$/],
      ['browser', /^Top$/],
      ['providers', /^Bottom$/],
    ]) {
      await pickFromTileMenu(page, tile, label)
    }
    const nailed = await read(page)
    const present = Object.entries(nailed.shelves).filter(([, v]) => v).map(([k]) => k)
    check(
      '四边都试着钉过之后,中央区仍旧 ≥ 480×320',
      Boolean(nailed.center) && nailed.center.w >= CENTER_MIN_W && nailed.center.h >= CENTER_MIN_H,
      `center=${nailed.center?.w}×${nailed.center?.h} 架子=${JSON.stringify(present)}`,
    )
    /*
     * **拒绝要说话**(W7-p 修一轮裁定 3)。四条边里必有摆不下的那几条,而那时读屏
     * 该听到「⋯放不下了 —— 先收一条架子」。从前拒绝在有些路上是**静默不动**:
     * 用户点了菜单里那一行,屏幕没变、读屏也没有一个字。
     * 反证:把 `store.land` 里那句 `announceRefusal` 拆掉 → 这一条当场红。
     */
    check(
      '第四边钉不上时,aria-live 里读得到那一句',
      NO_ROOM_RE.test(nailed.live),
      `live=${JSON.stringify(nailed.live)}`,
    )
    check(
      '输入框不与任何一条架子相交',
      Object.values(nailed.shelves).every((sh) => !sh || !intersects(nailed.composer, sh.rect)),
      `composer=${JSON.stringify(nailed.composer)}`,
    )
    check(
      '摆不下的那几条是**拒绝**,不是压成 0:没有一条架子薄过一条细梁',
      Object.values(nailed.shelves).every((sh) => !sh || sh.rect.w > 0 && sh.rect.h > 0),
    )
    for (const size of SIZES) {
      await setSize(app, page, size.w, size.h)
      const at = await read(page)
      check(
        `${size.w}×${size.h}:没有元素出视口(scrollWidth === clientWidth)`,
        at.doc.sw === at.doc.cw && at.doc.sh === at.doc.ch,
        `sw=${at.doc.sw} cw=${at.doc.cw} sh=${at.doc.sh} ch=${at.doc.ch}`,
      )
      const overflow = Object.entries(at.shelves)
        .filter(([, sh]) => sh)
        .filter(([, sh]) => sh.rect.x + sh.rect.w > at.vp.w + 1 || sh.rect.y + sh.rect.h > at.vp.h + 1)
        .map(([side]) => side)
      check(`${size.w}×${size.h}:没有一条架子探出屏幕`, overflow.length === 0, JSON.stringify(overflow))
      /*
       * **中央区最小身量优先**(W7-p 修一轮裁定 6 的第二半)。从前
       * `clampShelfThickness` 的下界 240 永远赢,于是 700×500 那一档量到中央区
       * 220×216 —— 裁定 3 立的 480×320 当场失效。今天预算装不下的那条架子
       * **收成细梁**(12px),中央区的最小身量压过架子的最小厚度。
       *
       * 反证:把 `reclampShelves` 里那格 `shelfFitsBudget → collapsed: true` 拆掉 →
       * 700×500 这一档的中央区两条当场红。
       */
      check(
        `${size.w}×${size.h}:中央区仍旧 ≥ ${CENTER_MIN_W}×${CENTER_MIN_H}`,
        Boolean(at.center) && at.center.w >= CENTER_MIN_W && at.center.h >= CENTER_MIN_H,
        `center=${at.center?.w}×${at.center?.h}`,
      )
      /*
       * 量的是**屏幕上那条梁真有多宽**,不是 `shelfExtent()`(它对收起态直接答
       * SHELF_RAIL —— 拿它判就是拿自己判自己)。
       */
      const railWidth = (sh, side) => (side === 'left' || side === 'right' ? sh.rect.w : sh.rect.h)
      const railed = Object.entries(at.shelves)
        .filter(([, sh]) => sh && sh.collapsed)
        .map(([side]) => side)
      if (size.w === 700) {
        check(
          '700×500:让位的那条被收成细梁 —— 而且是**最后钉的**那条(上)',
          at.shelves.top?.collapsed === true,
          `收起来的=${JSON.stringify(railed)}`,
        )
        check(
          '700×500:细梁就是一条细梁(12px),不是被删掉也不是停在 240',
          railed.length > 0
            && Object.entries(at.shelves).every(
              ([side, sh]) => !sh || !sh.collapsed || Math.abs(railWidth(sh, side) - SHELF_RAIL) <= 1,
            ),
          JSON.stringify(
            Object.fromEntries(
              Object.entries(at.shelves)
                .filter(([, sh]) => sh)
                .map(([side, sh]) => [side, railWidth(sh, side)]),
            ),
          ),
        )
      }
    }
  } finally {
    await shut(handle)
  }
}

/**
 * ④⑤ **浮窗:重钳不写记忆,新窗有锚有层叠**(裁定 4/5,审计 A 的 A5/A6)。
 *
 * A5 病历:窗口缩窄一次,那扇浮窗被钳小并**写进记忆**,窗口再拉回来时源头已经
 * 是钳过的 —— 一次临时的窄屏永久改写了用户摆好的身量,而用户什么都没做。
 * A6 病历:所有浮窗开在同一个居中矩形,后一扇整个盖住前一扇;而那个矩形正压着
 * 聊天区正中与输入框。
 *
 * 反证:把 `reclampMemoryMap` 加回 `reclampFloatGeometry` → 「拉回去逐字恢复」红;
 * 把 `defaultFloatRect` 的 `opts` 拿掉(退回恒定居中)→ 「四扇两两不同」红。
 */
async function sceneFloats(store, udd) {
  scene('④⑤ 浮窗:变窄再变宽逐字恢复;连开四扇有锚有层叠(裁定 4·5 / A5·A6)')
  const handle = await launch(store, udd)
  try {
    const { page, app } = handle
    await setSize(app, page, SIZES[0].w, SIZES[0].h)
    await pickFromTileMenu(page, 'providers', /^Float$/)
    const wide = await read(page)
    const first = wide.floats[0]
    check('开出来一扇浮窗', Boolean(first), JSON.stringify(first?.rect))
    check(
      '新窗身量 = 640×480(裁定 5)',
      first?.rect.w === FLOAT_DEFAULT_W && first?.rect.h === FLOAT_DEFAULT_H,
      `${first?.rect.w}×${first?.rect.h}`,
    )
    /*
     * 锚点的参考系是 `transitions.centerRectOf` —— **四条架子切完剩下的那块地**,
     * 顶栏那 44px 不在其中(判词写在那只纯函数上:这是一个开窗锚点,不是布局约束)。
     * 所以这里也按同一把尺现算,而不是拿 `[data-pane-region="center"]` 的矩形去比:
     * 拿后者比就是把「门自己的一套算法」和产品的对不上,红了也说不清是谁错。
     */
    const anchorOf = (layout) => ({
      x: layout.vp.w - shelfExtent(layout.shelves.right, 'right') - FLOAT_SPAWN_INSET - FLOAT_DEFAULT_W,
      y: TOP_CHROME + shelfExtent(layout.shelves.top, 'top') + FLOAT_SPAWN_INSET,
    })
    const anchor = anchorOf(wide)
    check(
      '新窗锚在中央区右上角内缩 24px',
      first?.rect.x === anchor.x && first?.rect.y === anchor.y,
      `rect=${JSON.stringify(first?.rect)} 锚=${JSON.stringify(anchor)}`,
    )
    check(
      '新窗不压着输入框',
      !intersects(first?.rect, wide.composer),
      `composer=${JSON.stringify(wide.composer)}`,
    )
    /*
     * **也不压着标签条**(W7-p 裁定 5 的修正)。第一版的中央区算式把顶栏留在里面,
     * 于是新窗锚在 y = 24 —— 真机上它盖住标签条的右半截,`gate:drag` 场景①③当场红
     * (指针按在「最右那格标签」上,落到的是这扇窗)。锚点从顶栏之下起算之后这一条
     * 才成立;它是那次真机反证的机器化。
     */
    check(
      '新窗不压着顶栏上的标签条',
      !intersects(first?.rect, wide.topBar),
      `topBar=${JSON.stringify(wide.topBar)}`,
    )

    await setSize(app, page, SIZES[1].w, SIZES[1].h)
    const narrow = await read(page)
    check(
      '缩窗:那扇窗被钳回视口内',
      Boolean(narrow.floats[0]) && inViewport(narrow.floats[0].rect, narrow.vp),
      JSON.stringify(narrow.floats[0]?.rect),
    )
    check(
      '缩窗:记忆一个字没写(裁定 4 —— 记忆只由手势与落定写)',
      rectEq(narrow.persist.stageMemory?.providers?.rect, wide.persist.stageMemory?.providers?.rect),
      `${JSON.stringify(wide.persist.stageMemory?.providers?.rect)} → ${JSON.stringify(narrow.persist.stageMemory?.providers?.rect)}`,
    )
    await setSize(app, page, SIZES[0].w, SIZES[0].h)
    const back = await read(page)
    check(
      '拉回原尺寸:矩形**逐字**回到原样',
      rectEq(back.floats[0]?.rect, first?.rect),
      `${JSON.stringify(first?.rect)} → ${JSON.stringify(back.floats[0]?.rect)}`,
    )

    for (const tile of ['terminal', 'diff', 'browser']) {
      await pickFromTileMenu(page, tile, /^Float$/)
    }
    const many = await read(page)
    check('连开四扇', many.floats.length === 4, `floats=${many.floats.length}`)
    const rects = many.floats.map((f) => f.rect)
    const distinct = new Set(rects.map((r) => `${r.x},${r.y}`))
    check('四扇的矩形两两不同(层叠,不是叠成一摞)', distinct.size === rects.length, JSON.stringify(rects))
    check(
      '四扇都在视口里',
      rects.every((r) => inViewport(r, many.vp)),
      JSON.stringify(many.vp),
    )
    const steps = rects
      .map((r) => r.x)
      .sort((a, b) => b - a)
      .map((x, i, arr) => (i === 0 ? 0 : arr[i - 1] - x))
      .slice(1)
    check(
      `层叠步长 = ${FLOAT_CASCADE_STEP}px(往左下)`,
      steps.every((d) => d === FLOAT_CASCADE_STEP),
      JSON.stringify(steps),
    )
  } finally {
    await shut(handle)
  }
}

/**
 * ⑤' **点瓦那条路也有锚和层叠**(W7-p 修一轮裁定 1 —— 本轮那条 blocking)。
 *
 * ── 为什么右键 Float 那一档量不到这个病 ────────────────────────────────────
 * 右键菜单点名落点走 `openAs` → `placeAs`,那条路一直经过唯一那只产地。而**点瓦 /
 * 快捷键**这条最常走的路走的是召唤第一态「开」:`resolveOpen` 无记忆时由
 * `completeMemory` 当场造一个**恒定**矩形塞进「记忆」里,`openFromMemory` 先把它
 * 写进 `floats[id]`,`placeAs` 于是看到「已经有矩形了」直接跳过产地 ——
 * 真机后果:点四块瓦开出四扇一模一样地叠在一起的窗,而 ④⑤ 那一档全绿。
 *
 * 所以这一档必须**用点瓦**开,一次都不许经右键菜单。
 * 反证:把 `transitions.completeMemory` 的 float 支改回 `rect: defaultFloatRect(viewport)`
 * → 「四扇两两不同」当场红(四个 rect 逐字相同)。
 */
async function sceneSpawn(store, udd) {
  scene("⑤' 点瓦连开四扇:两两不同、都不压顶栏标签条(修一轮裁定 1)")
  const handle = await launch(store, udd)
  try {
    const { page, app } = handle
    await setSize(app, page, SIZES[0].w, SIZES[0].h)
    // 这四块瓦既没有记忆也没有出厂档 → 落在全局默认档(浮窗)。`files` 不在其中:
    // 它是启动瓦,点它走的是另一支(判词在 `stage/open-item.ts`)。
    for (const tile of ['diff', 'terminal', 'browser', 'providers']) {
      await clickTile(page, tile)
    }
    const many = await read(page)
    check('点瓦开出四扇浮窗', many.floats.length === 4, `floats=${many.floats.length}`)
    const rects = many.floats.map((f) => f.rect)
    const distinct = new Set(rects.map((r) => `${r.x},${r.y}`))
    check(
      '四扇两两不同(层叠,不是叠成一摞)',
      distinct.size === rects.length,
      JSON.stringify(rects),
    )
    check(
      '四扇都不压着顶栏上的标签条',
      rects.every((r) => !intersects(r, many.topBar)),
      `topBar=${JSON.stringify(many.topBar)}`,
    )
    check(
      '四扇都在视口里',
      rects.every((r) => inViewport(r, many.vp)),
      JSON.stringify(many.vp),
    )
    // 第一扇锚在中央区右上角内缩一格 —— 与右键那条路**同一个**产地算出来的。
    const anchor = {
      x: many.vp.w - shelfExtent(many.shelves.right, 'right') - FLOAT_SPAWN_INSET - FLOAT_DEFAULT_W,
      y: TOP_CHROME + shelfExtent(many.shelves.top, 'top') + FLOAT_SPAWN_INSET,
    }
    const topmost = rects.reduce((a, b) => (b.x > a.x ? b : a))
    check(
      '第一扇就在锚点上(点瓦与右键菜单同一个产地)',
      topmost.x === anchor.x && topmost.y === anchor.y,
      `第一扇=${JSON.stringify(topmost)} 锚=${JSON.stringify(anchor)}`,
    )
  } finally {
    await shut(handle)
  }
}

/**
 * ⑥ **召唤:一台机器,四个入口**(裁定 6,审计 A 的 A7/A8/A11 + B4)。
 *
 * 两条真机现场:
 *  · **启动瓦**(「目录」)从前整条绕过召唤 —— 点它一律 `launcher.open()`,
 *    把同一格内容再摆一次是恒等变换;
 *  · **sidebar 单击一条已经开着的会话**只 `activateTab` 一句 —— 那条会话在右架子里
 *    (收着)时屏幕上一动不动。
 *
 * 反证:把 `open-item.summonStageItem` 的启动瓦支改回「一律 `launcher.open()`」→
 * 「目录那一格原地点名、tab 次序不变」红;把 `expose.enterSession` 里那句
 * `summonRef(..., 'reveal')` 拆掉 → 「右架子展开 + 中央标签数不变」红。
 */
async function sceneSummon(store, udd, sessions) {
  scene('⑥ 召唤:启动瓦与 sidebar 单击都走同一台四态机器(裁定 6 / A7·A8·A11·B4)')
  const handle = await launch(store, udd)
  try {
    const { page, app } = handle
    await setSize(app, page, 1400, 900)

    /*
     * ⑥a 启动瓦 —— 「目录」那块瓦此刻代表的那格内容已经开着,就对它走四态。
     *
     * **这一档量的是点瓦**,而点瓦与快捷键在源码层面就是**同一只函数**
     * (`open-item.ts`:`export const openStageItem = summonStageItem`,那条恒等由
     * `summon-entries.test.ts` 的第一条钉着)——所以这里不必再按一遍键盘:
     * 那不是「第二条路」,是同一条。`files` 出厂**没有快捷键**,想按也按不出来。
     *
     * **先进一条绑了工作目录的会话**:启动瓦是靠 `StageLauncher.dragRef()` 答
     * 「我代表哪格内容」的,而目录那一口答的是**当前会话的工作目录**;没有会话就
     * 答 `null` = 此刻答不出来,那时它照旧只能 `open()`(判词在 `stage/open-item.ts`)。
     * 所以这一步不是布景,它是这条路成立的**前提**。
     */
    await page.keyboard.press('Meta+e')
    await delay(900)
    await clickSessionRow(page, sessions[0])
    await clickTile(page, 'files')
    await delay(900)
    const opened = await read(page)
    const filesTab = opened.shelves.left?.tabs.find((t) => t.id?.startsWith('files-root:'))
    check(
      '点「目录」瓦:目录面板落在左架子(它的出厂档 `defaultPlacement`)',
      Boolean(filesTab),
      JSON.stringify(opened.shelves.left?.tabs.map((t) => t.id)),
    )
    // 往同一条边上再钉一块瓦,让目录那一格变成**非活动** tab。
    await pickFromTileMenu(page, 'terminal', /^Left$/)
    const stacked = await read(page)
    const orderBefore = stacked.shelves.left?.tabs.map((t) => t.id) ?? []
    check(
      '前提:目录那一格此刻不是露脸的那一格',
      stacked.shelves.left?.tabs.find((t) => t.id?.startsWith('files-root:'))?.on === false,
      JSON.stringify(orderBefore),
    )
    await clickTile(page, 'files')
    const summoned = await read(page)
    const orderAfter = summoned.shelves.left?.tabs.map((t) => t.id) ?? []
    check(
      '点「目录」瓦:原地点名那一格(不是再摆一次)',
      summoned.shelves.left?.tabs.find((t) => t.id?.startsWith('files-root:'))?.on === true,
      JSON.stringify(summoned.shelves.left?.tabs),
    )
    check(
      '点「目录」瓦:架子上的 tab 次序一个字没动',
      JSON.stringify(orderAfter) === JSON.stringify(orderBefore),
      `${JSON.stringify(orderBefore)} → ${JSON.stringify(orderAfter)}`,
    )
    check(
      '点「目录」瓦:中央区没有多开一格',
      summoned.centerTabs.length === stacked.centerTabs.length,
      `${stacked.centerTabs.length} → ${summoned.centerTabs.length}`,
    )
    // 收成细梁再召唤一次 —— 从前「把架子展开」这件事在启动瓦那条路上没人做。
    await page.keyboard.press('Meta+Alt+ArrowLeft')
    await delay(600)
    check('前提:左架子已收成细梁', (await read(page)).shelves.left?.collapsed === true)
    await clickTile(page, 'files')
    const revealed = await read(page)
    check('点「目录」瓦:收着的架子被展开了', revealed.shelves.left?.collapsed === false)
    check(
      '点「目录」瓦:露脸的正是目录那一格',
      revealed.shelves.left?.tabs.find((t) => t.id?.startsWith('files-root:'))?.on === true,
      JSON.stringify(revealed.shelves.left?.tabs),
    )

    /*
     * ⑥b **sidebar 单击一条已经开着的会话 = 切过去**,不新开不顶替(裁定 6 的 B4)。
     *
     * 布景要两条会话:一条留在中央区,一条摆到右架子上并把架子收起来。
     * 中央区那一条是**必需的布景**,不是凑数:中央区空着的话,「顶替焦点那片会话叶」
     * 那条老路会顶到右架子那一片上去 —— 两种行为就再也分不出来了。
     *
     * 用会话行的「在下方打开」而不是「在右边打开」:后者在 W6-a 之后是**二合一**
     * (开出来的是一格 `pair:` 复合标签,右架子那一步就没有单独的会话标签可挪);
     * 前者是老老实实在同一片叶上多开一格。
     */
    await clickSessionRow(page, sessions[0])
    const tabId = `session:${sessions[1]}`
    if (!(await pickFromSessionRowMenu(page, sessions[1], /^Open below$|在下方打开/))) {
      throw new Error('会话行菜单里没有「Open below」那一行')
    }
    const split = await read(page)
    check(
      '前提:两条会话都在中央区',
      split.centerTabs.length === 2 && split.centerTabs.some((t) => t.id === tabId),
      JSON.stringify(split.centerTabs.map((t) => t.id)),
    )
    if (!(await pickFromTabMenu(page, tabId, /^Move to the right$|移到右边|钉到右边/))) {
      throw new Error('标签动作表里没有「Move to the right」那一行')
    }
    const moved = await read(page)
    check(
      '把它挪到右架子上',
      Boolean(moved.shelves.right) && moved.shelves.right.tabs.some((t) => t.id === tabId),
      JSON.stringify(moved.shelves.right?.tabs.map((t) => t.id)),
    )
    check(
      '中央区留着另一条会话',
      moved.centerTabs.length === 1 && !moved.centerTabs.some((t) => t.id === tabId),
      JSON.stringify(moved.centerTabs.map((t) => t.id)),
    )
    await page.keyboard.press('Meta+Alt+ArrowRight')
    await delay(600)
    const armed = await read(page)
    check('前提:右架子已收成细梁', armed.shelves.right?.collapsed === true)
    const centerBefore = armed.centerTabs.length
    await clickSessionRow(page, sessions[1])
    const after = await read(page)
    check('sidebar 单击:右架子展开了', after.shelves.right?.collapsed === false)
    check(
      'sidebar 单击:右架子里那一格成了活动的',
      after.shelves.right?.tabs.find((t) => t.id === tabId)?.on === true,
      JSON.stringify(after.shelves.right?.tabs),
    )
    /*
     * **焦点跟着进去**(裁定 6 的第三件事:「激活那格、露出架子、焦点进去」)。
     * 判据是**响应链上那条路径**穿过架子那一层 —— 不是某个 scope id:焦点最终落在
     * 那条会话自己的 `chat` 层里,而它是不是「右架子里那一条」只有路径答得出。
     * 反证:把 `stage/store.summonRef` 的 reveal 支里那句 `focusIntoRefAfterCommit`
     * 拆掉 → 键盘留在中央区的输入框上,这一条红。
     */
    check(
      'sidebar 单击:焦点跟着进了架子里那一格',
      (after.focus.path ?? []).some((id) => String(id).startsWith('shelf-layer@')),
      JSON.stringify(after.focus),
    )
    check(
      'sidebar 单击:中央区标签数不变(不新开、不顶替)',
      after.centerTabs.length === centerBefore
        && !after.centerTabs.some((t) => t.id === tabId),
      `${centerBefore} → ${after.centerTabs.length};中央=${JSON.stringify(after.centerTabs.map((t) => t.id))}`,
    )

    /*
     * ⑥c **二合一的一格也是一个座位**(W7-p 修一轮裁定 2)。
     *
     * 病历:找座位从前只比**顶层标签**的 refId,于是「在右边打开」造出来的那格
     * `pair:` 复合标签里的会话在它眼里不存在 —— sidebar 单击它,召唤答 `null`,
     * 走「顶替焦点那片会话叶」,把中央区正看着的那条**顶掉**。
     *
     * 反证:把 `workbench/tree.seatOfRefIn` 的复合那一支拆掉 → 「不新开不顶替」
     * 那一条当场红(中央区标签数变了,或者那格 pair 被顶成了单会话)。
     */
    /*
     * 布景:先点一下中央区那条会话(焦点回到会话那片叶上),再对**第三条**会话
     * 走「在右侧打开」—— 它落在**焦点会话叶**上(判词在 `SessionActionsMenu`),
     * 而那片叶是中央区还是右架子由此刻的焦点说了算。这一档不关心它落在哪儿:
     * 要量的是「二合一之后 sidebar 单击它会不会新开 / 顶替」,所以判据一律按
     * **全壳所有标签**来读。
     */
    await clickSessionRow(page, sessions[0])
    const beforePair = await read(page)
    const thirdTab = `session:${sessions[2]}`
    if (!(await pickFromSessionRowMenu(page, sessions[2], /^Open to the right$|在右侧打开|在右边打开/))) {
      throw new Error('会话行菜单里没有「Open to the right」那一行')
    }
    const paired = await read(page)
    const pairTab = allTabs(paired).find((t) => t.id?.startsWith('pair:'))
    check(
      '「在右侧打开」造出一格二合一标签,里面装着那条会话',
      Boolean(pairTab) && String(pairTab.id).includes(thirdTab),
      JSON.stringify(allTabs(paired).map((t) => t.id)),
    )
    check(
      '布景:二合一没有多出一格标签(两格并成一格)',
      allTabs(paired).length === allTabs(beforePair).length,
      `${allTabs(beforePair).length} → ${allTabs(paired).length}`,
    )
    const pairedIds = allTabs(paired).map((t) => t.id)
    await clickSessionRow(page, sessions[2])
    const afterPair = await read(page)
    check(
      'sidebar 点 pair 里那条会话:不新开、不顶替(全壳标签逐字不变)',
      JSON.stringify(allTabs(afterPair).map((t) => t.id)) === JSON.stringify(pairedIds),
      `${JSON.stringify(pairedIds)} → ${JSON.stringify(allTabs(afterPair).map((t) => t.id))}`,
    )
    check(
      'sidebar 点 pair 里那条会话:活动的正是那格 pair',
      allTabs(afterPair).find((t) => t.id === pairTab?.id)?.on === true,
      JSON.stringify(allTabs(afterPair)),
    )
  } finally {
    await shut(handle)
  }
}

/* ── main ──────────────────────────────────────────────────────────────── */

/*
 * `node scripts/gate-layout.mjs --only <restart|full|budget|floats|summon>` —— 只跑那一
 * 组场景。立这个口子的理由与 `verify.mjs` 的 `--only` 逐字相同:**反证纪律**要求每条
 * 守卫至少真跑一次「拆掉即红」,而拆一处跑整道门是五个场景陪跑一个。
 * 它只认这五个名字,不是通用的分步执行器。`restart` 与 `full` 是同一次进程接力
 * (②要②之前那一步钉好的右架子),所以 `--only full` 连带跑 ①。
 */
const ONLY_SCENES = ['restart', 'full', 'budget', 'floats', 'spawn', 'summon']
const onlyIndex = process.argv.indexOf('--only')
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1]
if (only !== null && !ONLY_SCENES.includes(only)) {
  process.stdout.write(`[gate:layout] --only 只认:${ONLY_SCENES.join(' / ')}\n`)
  process.exit(2)
}
const wants = (name) => only === null || only === name

async function main() {
  if (!existsSync(serverEntry)) {
    process.stdout.write(`[gate:layout] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\`\n`)
    process.exit(1)
  }
  if (!existsSync(mainEntry)) {
    process.stdout.write(`[gate:layout] 找不到 ${path.relative(appRoot, mainEntry)} —— 先跑 \`npm run app:build\`\n`)
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'w7p-layout-store-'))
  const ws = await mkdtemp(path.join(tmpdir(), 'w7p-layout-ws-'))
  const udds = []
  const newUdd = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'w7p-layout-udd-'))
    udds.push(dir)
    return dir
  }
  await mkdir(path.join(ws, 'notes'), { recursive: true })
  await writeFile(path.join(ws, 'notes', 'alpha.md'), '# alpha\n')
  await writeFile(path.join(ws, 'a.ts'), 'export const a = 1\n')

  let sessions = []
  try {
    live.server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_SERVER_WORKSPACE_ROOT: ws },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stderr = []
    live.server.stderr.on('data', (chunk) => stderr.push(chunk.toString()))
    const record = await waitFor('core 的发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === live.server.pid ? found : undefined
    }).catch((err) => {
      throw new Error(`${err.message}\n${stderr.join('')}`)
    })
    if (!(await portConnects(record.host, record.port))) throw new Error('core 的端口连不上')

    const a = await rpc(record, 'sessions', 'create', { name: 'w7p-A' })
    await rpc(record, 'sessions', 'updateWorkingDirectory', {
      sessionId: a.session.id,
      workingDirectory: ws,
    })
    const b = await rpc(record, 'sessions', 'create', { name: 'w7p-B' })
    // 第三条只服务 ⑥c(二合一那一格):它要一条**没在别处摆过**的会话,
    // 好让「在右侧打开」造出来的那格 pair 干干净净。
    const c = await rpc(record, 'sessions', 'create', { name: 'w7p-C' })
    sessions = [a.session.id, b.session.id, c.session.id]

    if (wants('restart') || wants('full')) {
      const carried = await sceneRestart(store, await newUdd())
      try {
        if (wants('full')) await sceneFull(carried)
      } finally {
        await shut(carried)
      }
    }
    if (wants('budget')) await sceneBudget(store, await newUdd())
    if (wants('floats')) await sceneFloats(store, await newUdd())
    if (wants('spawn')) await sceneSpawn(store, await newUdd())
    if (wants('summon')) await sceneSummon(store, await newUdd(), sessions)
  } finally {
    for (const app of [...live.apps]) {
      try {
        await app.close()
      } catch {
        /* 收尸不阻断 */
      }
    }
    live.apps.clear()
    if (live.server?.pid) {
      try {
        process.kill(live.server.pid, 'SIGTERM')
        await delay(700)
        try {
          process.kill(live.server.pid, 0)
          process.kill(live.server.pid, 'SIGKILL')
        } catch {
          /* 已经走了 */
        }
      } catch {
        /* 已经走了 */
      }
    }
    for (const dir of [store, ws, ...udds]) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const failed = results.filter((r) => !r.ok)
  process.stdout.write(`\n[gate:layout] ${results.length - failed.length}/${results.length} 条通过\n`)
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  ✗ ${f.scene} · ${f.label}  ${f.detail}\n`)
    process.stdout.write('[gate:layout] FAILED\n')
    process.exit(1)
  }
  process.stdout.write(
    '[gate:layout] ok —— 重启 / 全屏 + A9 / 架子预算 + 拒绝播报 + 细梁 / 三档挤压 / 浮窗锚与层叠 / 点瓦开窗 / 召唤两条路 + 二合一\n',
  )
}

main().catch(async (err) => {
  process.stdout.write(`\n[gate:layout] 崩了:${err?.stack ?? err}\n`)
  for (const app of [...live.apps]) {
    try {
      await app.close()
    } catch {
      /* 收尸不阻断 */
    }
  }
  if (live.server?.pid) {
    try {
      process.kill(live.server.pid, 'SIGKILL')
    } catch {
      /* 已经走了 */
    }
  }
  process.exit(1)
})
