#!/usr/bin/env node
/**
 * **会话侧栏的真机门**(A1,正本 `apps/desktop-react/docs/sessions-sidebar-2026-09.md` §6)。
 *
 * ── 它守的是什么 ────────────────────────────────────────────────────────
 * 09-12 用户真机报的四条病,**没有一条在 jsdom 里存在**:
 *  ① 「所有元素从红灯中心起笔」是一条**几何**约束(容器矩形 vs 原生红绿灯的
 *    位置),jsdom 里 `getBoundingClientRect` 一律答零;
 *  ② 「标题只剩一点」是一个**比值**(标题净宽 / 行宽),要真排版才有分子;
 *  ③ 「悬停的眼睛点不到」的病根是**层叠上下文 + 命中测试**——
 *    `elementFromPoint` 在 jsdom 里不存在;
 *  ④ 搜索行开合、范围菜单选中、宽窄两形换手,全是容器查询 + 真焦点。
 * 08-30 那条判例的原话:交互时序类改动必须真机对照,jsdom 的绿不算数。
 *
 * ── A2 加的第五条(⑦ 动作面)────────────────────────────────────────────
 * 关闭 / 重命名 / 删除三步的判据**有一半在 core 侧**:屏幕上那一行换了字、
 * 没了,不等于账本换了字、没了 —— 所以这一步每一条都回头问一次
 * `sessions.listMeta`。另一半在**两个 store 的投影对齐**上(拼贴树那条 tab
 * 条 ↔ 会话行那颗开着点),真机里它们隔着一次 React 提交与一条 SSE。
 * 确认框那一屏的 axe 也长在这一步上(理由写在 `sceneActionsMenu` 的头上)。
 *
 * ── 纪律(与 `gate-layout.mjs` 逐字同一套)────────────────────────────────
 * 离屏(`ONETHING_GATE_HEADLESS=1`)、临时 store、自己的 `--user-data-dir`、
 * CDP 补焦点、finally 收尸。**不连 5175、不碰 `~/.onething`、窗口不到前台、
 * 没有一处系统级合成输入** —— 指针一律走 CDP `Input.dispatchMouseEvent`
 * (只进这个窗口自己的输入管线,不动真光标)。
 *
 * ── 判据这一头的数从**源码**里读,不抄 ────────────────────────────────────
 * `--content-lead-left` 读 tokens.css、`trafficLightPosition.x` 读
 * `electron/main.ts`、冷开预算读 `src/perf-budget.ts`。抄一份的代价不是
 * 「哪天忘了同步」这么轻:门抄的那份**永远绿**,产品改了它照样说 ok。
 *
 * 跑法:`npm run gate:sessions`。
 * 前置:仓根 `bun run server:build`,本目录 `npm run app:build`。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AxeBuilder } from '@axe-core/playwright'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── 判据这一头(从源码里读)──────────────────────────────────────────────── */

/** 读样式表源文本的门**先剥注释**(仓规):病历文本里写着这些数,不剥会读到注释里那个。 */
const TOKENS_SRC = readFileSync(path.join(appRoot, 'src/styles/tokens.css'), 'utf-8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)
const MAIN_SRC = readFileSync(path.join(appRoot, 'electron/main.ts'), 'utf-8')
const BUDGET_SRC = readFileSync(path.join(appRoot, 'src/perf-budget.ts'), 'utf-8')

function token(name) {
  const hit = new RegExp(`--${name}:\\s*([0-9.]+)px`).exec(TOKENS_SRC)
  if (!hit) throw new Error(`tokens.css 里没有 --${name} —— 判据与产品对不上了`)
  return Number(hit[1])
}

function budget(name) {
  const hit = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)`).exec(BUDGET_SRC)
  if (!hit) throw new Error(`src/perf-budget.ts 里没有 ${name} —— 判据与产品对不上了`)
  return Number(hit[1])
}

/**
 * 红灯**中心**那条线 = `trafficLightPosition.x` + 灯的半径。
 *
 * 灯直径 12 是 macOS 自己画的(`--titlebar-traffic-w` 的算式里「三颗灯 52」
 * 就是 3×12 + 2×8),所以半径 6 是那一族算式的一部分而不是一个新数;
 * 这里把它与 `--content-lead-left` 对账 —— 两处分家的话这道门当场说得出来。
 */
function trafficLightX() {
  const hit = /trafficLightPosition: \{ x: (\d+)/.exec(MAIN_SRC)
  if (!hit) throw new Error('electron/main.ts 里读不出 trafficLightPosition.x —— 判据与产品对不上了')
  return Number(hit[1])
}

const CONTENT_LEAD_LEFT = token('content-lead-left')
/** 行 / 节头 / 导航行的左内边距(`--sp-2`):盒子比对齐线往左探出的那一格。 */
const ROW_PAD = token('sp-2')
const TRAFFIC_X = trafficLightX()
const TRAFFIC_LIGHT_RADIUS = 6
const COLD_OPEN_MS = budget('coldOpenMs')
const LONG_FRAME_MS = budget('longFrameMs')
/** 标题净宽占行宽的下限(正本 §6②)。 */
const TITLE_SHARE_MIN = 0.6
/** 两档厚度(240 是架子下限 SHELF_MIN_THICKNESS,320 是用户真机那一档)。 */
const THICKNESSES = [240, 320]

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
function note(text) {
  process.stdout.write(`  · ${text}\n`)
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
  if (!body || body.ok !== true) {
    throw new Error(`rpc ${domain}.${method}: ${JSON.stringify(body?.error ?? body)}`)
  }
  return body.data
}

/* ── 种子:24 条会话,标题 8–70 字、中英混排、**随机长度** ────────────────────
 *
 * 「随机长度」是这道门的被试而不是装饰:②量的是标题净宽占行宽的比值,而
 * 一屏全是短标题时那个比值量的是「字少」不是「地方多」(09-04 那次假红就是
 * 拿第一行当被试)。种子固定随机源(一个写死的线性同余),所以每次跑是同一批
 * 名字 —— 门的读数要可复现,而「随机」说的是名字的**形状分布**,不是每次不同。
 */
const WORDS_ZH = [
  '会话', '侧栏', '导航行', '红灯', '对齐', '标题', '省略号', '架子', '厚度', '容器查询',
  '悬停', '动作', '菜单', '搜索', '范围', '项目', '分节', '折叠', '滚动', '预算',
  '真机', '读数', '反证', '判例', '重构',
]
const WORDS_EN = [
  'expose', 'sidebar', 'nav', 'traffic', 'lead', 'title', 'ellipsis', 'shelf', 'container',
  'hover', 'menu', 'search', 'scope', 'section', 'gate', 'budget', 'reflow', 'probe',
]

function seedTitles(count) {
  let seed = 20260912
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const titles = []
  for (let i = 0; i < count; i += 1) {
    // 8–70 字,均匀铺开(两头都要有:短的量「地方够不够」,长的量「截不截断」)。
    const want = 8 + Math.floor(next() * 63)
    let text = ''
    while (text.length < want) {
      const zh = next() < 0.65
      const word = zh
        ? WORDS_ZH[Math.floor(next() * WORDS_ZH.length)]
        : `${WORDS_EN[Math.floor(next() * WORDS_EN.length)]} `
      text += word
    }
    titles.push(text.slice(0, want).trim())
  }
  return titles
}

/* ── 页面这一头的读数 ────────────────────────────────────────────────────── */

/**
 * 页内 `long-animation-frame` 观察器 —— 装一次、取号、收号,写法与
 * `gate-layout.mjs` / `gate-workspace.mjs` **逐字同源**(判词也在那儿):
 * 时刻的产地必须在页内,而且必须**切窗口取样** —— `buffered: true` 会把整道门
 * 到此刻为止的历史帧一次性交过来,拿它量「开出来那一拍」会把开壳、装配、
 * 首屏那几帧算进产品头上(09-12 判例,T2 把 B2 的一个假红判掉)。
 * 装不上时 `known: false`,那一条**跳过**而不是假装绿。
 */
async function installFrameProbe(page) {
  await page.evaluate(() => {
    if (window.__sessionsFrames) return
    const probe = (window.__sessionsFrames = { loaf: [] })
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) probe.loaf.push(entry.duration)
      }).observe({ type: 'long-animation-frame', buffered: true })
    } catch (error) {
      probe.err = String(error)
    }
  })
}

const frameMark = (page) =>
  page.evaluate(() =>
    window.__sessionsFrames && !window.__sessionsFrames.err
      ? window.__sessionsFrames.loaf.length
      : -1,
  )

const frameHarvest = (page, mark) =>
  page.evaluate((m) => {
    const probe = window.__sessionsFrames
    if (!probe || probe.err || m < 0) return { known: false, longest: 0, frames: 0 }
    const slice = probe.loaf.slice(m)
    return {
      known: true,
      longest: slice.length ? Math.round(Math.max(...slice)) : 0,
      frames: slice.length,
    }
  }, mark)

/** 这块面此刻的整份读数(**一次量完** —— 分几次量会读到两个不同的时刻)。 */
const READ = () => {
  const round = (r) => ({
    x: Math.round(r.x * 10) / 10,
    y: Math.round(r.y * 10) / 10,
    w: Math.round(r.width * 10) / 10,
    h: Math.round(r.height * 10) / 10,
  })
  const rectOf = (el) => (el ? round(el.getBoundingClientRect()) : null)
  const shown = (el) => {
    if (!el) return false
    const st = getComputedStyle(el)
    if (st.display === 'none' || st.visibility === 'hidden') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const root = document.querySelector('[data-focus-scope="expose"]')
  const shelf = document.querySelector('[data-shelf="left"]')
  const rows = [...(root?.querySelectorAll('[data-session-id][data-depth="0"]') ?? [])]
  const firstTitle = rows[0]?.querySelector('span')
  return {
    hasRoot: Boolean(root),
    rootRect: rectOf(root),
    shelfRect: rectOf(shelf),
    railShown: shown(root?.querySelector('[data-testid="expose-rail"]')),
    scopeRowShown: shown(root?.querySelector('[data-testid="expose-scope-row"]')),
    scopeRowText: (root?.querySelector('[data-testid="expose-scope-row"]')?.textContent ?? '').trim(),
    searchRowShown: shown(root?.querySelector('[data-testid="expose-search-row"]')),
    hasSearchBox: Boolean(root?.querySelector('[data-expose-search]')),
    searchBoxFocused: Boolean(document.activeElement?.hasAttribute?.('data-expose-search')),
    searchRowFocused: document.activeElement?.getAttribute?.('data-testid') === 'expose-search-row',
    rowIds: rows.map((r) => r.getAttribute('data-session-id')),
    rowCount: rows.length,
    marks: root?.querySelectorAll('mark').length ?? 0,
    // 时间列 = 行里最后一个直接子 span(侧栏形该整格不在场)。
    timeShown: rows.some((r) => {
      const spans = [...r.children].filter((el) => el.tagName === 'SPAN')
      return spans.length >= 2 && shown(spans[spans.length - 1])
    }),
    firstTitle: firstTitle
      ? {
          text: (firstTitle.textContent ?? '').slice(0, 24),
          clientW: firstTitle.clientWidth,
          scrollW: firstTitle.scrollWidth,
          rowW: rows[0].clientWidth,
        }
      : null,
    menuOpen: Boolean(document.querySelector('[role="menu"]')),
    menuFirstItem: (
      document.querySelector('[role="menu"] [role="menuitem"]')?.textContent ?? ''
    ).trim(),
  }
}

const read = (page) => page.evaluate(READ)

/**
 * ①的两个分子:**结构盒的左缘**与**所有可见墨的最小左缘**。
 *
 * 拍板 2 是两句话,判据也得是两个数:
 *  · 「所有盒子的左缘从这条线起」—— **盒**指导航行 / 节头 / 会话行那三种有自己
 *    背景与命中区的行(它们的左缘就是悬停薄膜的左缘,也是人眼读到的那条边);
 *  · 「没有任何元素越过它」—— 这一句管的是**一切**,所以第二个数量的是墨
 *    (自己画内容的元素:直接文本 / svg / img / canvas / input)。
 *
 * 两个数分开量是必须的:盒子比线往左探一格 --sp-2(盒 x = 14、墨 x = 22,09-13 裁定),
 * 所以拿墨去比那条线必然差 8px 而且**该**差 —— 首跑就是这么红的一次(实际 30、
 * 想要 22),红的是尺子不是产品。
 * 铺满整条架子的那些容器 div 不进任何一个数:它们的左缘恒等于架子的左缘,
 * 算进来这一条永远等于 0,量的是容器而不是「屏幕上看得见的那条边」。
 */
const minInkLeft = (page) =>
  page.evaluate(() => {
    const shelf = document.querySelector('[data-shelf="left"]')
    if (!shelf) return { error: '左架子不在 DOM 里' }
    const clip = shelf.getBoundingClientRect()
    const PAINTS = new Set(['SVG', 'IMG', 'CANVAS', 'INPUT', 'TEXTAREA', 'MARK'])
    const hasOwnText = (el) => {
      for (const node of el.childNodes) {
        if (node.nodeType === 3 && node.nodeValue && node.nodeValue.trim()) return true
      }
      return false
    }
    const inClip = (r) =>
      r.width > 0
      && r.height > 0
      && r.right >= clip.left
      && r.left <= clip.right
      && r.bottom >= clip.top
      && r.top <= clip.bottom
    const visible = (el) => {
      const st = getComputedStyle(el)
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
    }
    const round = (n) => Math.round(n * 10) / 10

    let ink = Infinity
    let inkWho = null
    for (const el of shelf.querySelectorAll('*')) {
      if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) continue
      if (!visible(el)) continue
      if (!PAINTS.has(el.tagName) && !hasOwnText(el)) continue
      const r = el.getBoundingClientRect()
      if (!inClip(r)) continue
      if (r.left < ink) {
        ink = r.left
        inkWho = `${el.tagName.toLowerCase()}「${(el.textContent ?? '').trim().slice(0, 14)}」`
      }
    }

    /*
     * 结构盒 = 三行导航 + 节头 + 会话行。按**取件口**取而不是按类名取:
     * CSS Module 的类名带哈希,而这三种行各自本来就有稳定的取件口
     * (`data-testid="expose-*"` / `data-section-id` / `data-session-id`)。
     */
    const boxes = [
      ...shelf.querySelectorAll(
        '[data-testid="expose-new-session"],[data-testid="expose-search-row"],'
          + '[data-testid="expose-scope-row"],[data-section-id],[data-session-id]',
      ),
    ].filter((el) => el instanceof HTMLElement && visible(el) && inClip(el.getBoundingClientRect()))
    let box = Infinity
    let boxWho = null
    let boxCount0 = 0
    for (const el of boxes) {
      boxCount0 += 1
      const r = el.getBoundingClientRect()
      if (r.left < box) {
        box = r.left
        boxWho = el.getAttribute('data-testid') ?? el.getAttribute('data-section-id') ?? 'row'
      }
    }
    return {
      ink: ink === Infinity ? null : round(ink),
      inkWho,
      box: box === Infinity ? null : round(box),
      boxWho,
      boxCount: boxCount0,
      shelfLeft: round(clip.left),
    }
  })

/* ── 真手势(CDP:一根手指都不碰用户的机器)────────────────────────────────── */

const mouse = (cdp, type, at, extra = {}) =>
  cdp.send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(at.x),
    y: Math.round(at.y),
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    ...extra,
  })

async function hoverAt(cdp, at) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(at.x),
    y: Math.round(at.y),
    button: 'none',
    buttons: 0,
  })
  await delay(260)
}

async function clickAt(cdp, at) {
  await hoverAt(cdp, at)
  await mouse(cdp, 'mousePressed', at, { clickCount: 1 })
  await mouse(cdp, 'mouseReleased', at, { clickCount: 1 })
  await delay(320)
}

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

/** Dock 瓦右键 → 菜单里点那一行(落点单选走它)。 */
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
    const rows = Array.from(
      document.querySelectorAll('[role="menu"] [role="menuitemradio"], [role="menu"] [role="menuitem"]'),
    )
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

/**
 * 把左架子的厚度拖到 `want`(真手势:按那根厚度杆,逐步走到位,松手)。
 * 与 `gate-squeeze.mjs` 那只同型,只是换了一侧 —— 左架子的杆在**右**内缘,
 * 所以目标 x 是「架子左缘 + 想要的厚度」。
 */
async function dragThicknessTo(page, want) {
  const got = await page.evaluate(async (target) => {
    const bar = document.querySelector('[data-shelf="left"] [role="separator"]')
    const aside = document.querySelector('[data-shelf="left"]')
    if (!bar || !aside) return -1
    const r = bar.getBoundingClientRect()
    const y = r.top + r.height / 2
    const from = r.left + r.width / 2
    const to = aside.getBoundingClientRect().left + target
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const mk = (type, x) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        clientX: x,
        clientY: y,
      })
    bar.dispatchEvent(mk('pointerdown', from))
    for (let i = 1; i <= 12; i += 1) {
      bar.dispatchEvent(mk('pointermove', from + ((to - from) * i) / 12))
      await frame()
    }
    bar.dispatchEvent(mk('pointerup', to))
    await frame()
    await frame()
    return aside.getBoundingClientRect().width
  }, want)
  await delay(250)
  return got
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
      /*
       * **两个开关一起传**(09-12 判例,B0-④ 量出来的一条真账):`HEADLESS`
       * 管「别自己 show()」,而 `show: false` 的窗整扇被 Chromium 当成隐藏、
       * **合成器按 1Hz 节流**(藏后心跳中位 1000ms)。这道门的 ⑧ 是一个
       * **毫秒读数**,所以必须走 `OFFSCREEN` 那一档:窗子摆到屏外再
       * `showInactive()` —— 真的在合成,人看不见也抢不着焦点。
       * 「真机门不许抢用户的机器」那条纪律一点没松,换的只是「被节流」这一件。
       */
      ONETHING_GATE_HEADLESS: '1',
      ONETHING_GATE_OFFSCREEN: '1',
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
  return { app, page, cdp }
}

async function shut(ctx) {
  if (!ctx?.app) return
  try {
    await ctx.app.close()
  } catch {
    /* 收尸不阻断 */
  }
  live.apps.delete(ctx.app)
}

/* ── 场景 ─────────────────────────────────────────────────────────────── */

/** 把会话总览摆到**左架子**上并露脸(出厂就是左架子,所以「让它开着」而不是「点开它」)。 */
async function openOnLeftShelf(page) {
  const shown = () =>
    page.evaluate(() =>
      Boolean(
        document.querySelector('[data-shelf="left"] [data-focus-scope="expose"] [data-session-id]'),
      ),
    )
  if (await shown()) return
  // 显式选一次落点:出厂档是左架子,但上一步可能把它撕走过。
  await pickFromTileMenu(page, 'sessions', /^(Left shelf|左侧栏)$/).catch(() => undefined)
  if (await shown()) return
  await clickTile(page, 'sessions')
  await waitFor('总览在左架子上画出会话行', shown)
}

/**
 * ① **左缘 = 左侧红灯的中心**(拍板 2:所有盒子的左缘从这条线起,没有任何元素越过它)。
 *
 * 三句话一起才成立:
 *  · 判据那一头两处同源 —— `--content-lead-left` === `trafficLightPosition.x + 半径`;
 *  · 屏幕这一头 —— 架子里**所有可见盒子**的最小左缘 = 架子左缘 + 那条线;
 *  · **没有越过它** —— 最小左缘不许小于那条线(这才是用户那句原话的机械含义)。
 */
async function sceneLead(page) {
  scene('① 左缘 = 红灯中心(拍板 2)')
  check(
    `判据两处同源:--content-lead-left ${CONTENT_LEAD_LEFT} = trafficLightPosition.x ${TRAFFIC_X} + 灯半径 ${TRAFFIC_LIGHT_RADIUS}`,
    CONTENT_LEAD_LEFT === TRAFFIC_X + TRAFFIC_LIGHT_RADIUS,
    `(tokens ${CONTENT_LEAD_LEFT} vs main.ts ${TRAFFIC_X} + ${TRAFFIC_LIGHT_RADIUS})`,
  )
  const m = await minInkLeft(page)
  if (m.error) {
    check('架子里量得到可见盒子', false, m.error)
    return
  }
  const want = m.shelfLeft + CONTENT_LEAD_LEFT
  const wantBox = want - ROW_PAD
  note(
    `架子左缘 ${m.shelfLeft} · 想要 ${want} · 结构盒 ${m.boxCount} 个,最左 ${m.box}(${m.boxWho})`
      + ` · 最左那一笔墨 ${m.ink}(${m.inkWho})`,
  )
  /*
   * 09-13 用户拿真机截图画线追加的裁定:**对线的是图标与文字(墨),不是盒边**。
   * 第一版把盒边对上线、字再进 8,屏幕上字与红灯错着半颗灯 —— 这三条断言就是
   * 那一次的反面:墨贴线、墨不越线、盒子探出线外恰好一格行内边距(悬停薄膜挂在
   * 字的左边,与 macOS 侧栏选中条同形)。
   */
  check(
    '导航行 / 节头 / 会话行的**图标与文字**落在那条线上(最左一笔墨,容差 1px)',
    m.ink !== null && Math.abs(m.ink - want) <= 1,
    `最左那一笔墨 ${m.ink}(${m.inkWho})vs 线 ${want}`,
  )
  check(
    '**没有任何元素越过它**(连墨都不许,容差 1px)',
    m.ink !== null && m.ink >= want - 1,
    `最左那一笔墨 ${m.ink} vs 线 ${want}`,
  )
  check(
    `盒子往左探出恰好一格行内边距(--sp-2 = ${ROW_PAD}):悬停薄膜挂在字的左边`,
    m.box !== null && m.boxCount >= 3 && Math.abs(m.box - wantBox) <= 1,
    `${m.boxCount} 个盒子,最左 ${m.box}(${m.boxWho}),想要 ${wantBox}`,
  )
}

/**
 * ② **240 / 320 两档:标题净宽占行宽 ≥ 60%**(正本 §6②;报障读数是 83px / 35%)。
 *
 * 量的是**第一行**的标题 `clientWidth / 行 clientWidth`。第一行够不够代表一屏?
 * 够 —— 标题是这一行唯一的弹性件,占比只由「别人占了多少」决定,与这条标题
 * 本身多长无关(长的那条会被省略号收掉,`clientWidth` 一个字不变)。
 * 顺带把一屏所有行的占比都算一遍进读数,取最小那一格当报告里的数字。
 */
async function sceneTitleShare(page) {
  scene('② 240 / 320 两档:标题净宽占行宽 ≥ 60%')
  const shares = {}
  for (const want of THICKNESSES) {
    const got = await dragThicknessTo(page, want)
    if (Math.abs(got - want) > 2) {
      check(`厚度拖到 ${want}`, false, `实际 ${got.toFixed(1)}`)
      continue
    }
    const measured = await page.evaluate(() => {
      const root = document.querySelector('[data-focus-scope="expose"]')
      const rows = [...(root?.querySelectorAll('[data-session-id][data-depth="0"]') ?? [])]
      const out = []
      for (const row of rows) {
        const title = row.querySelector('span')
        if (!title || !row.clientWidth) continue
        out.push({
          share: title.clientWidth / row.clientWidth,
          titleW: title.clientWidth,
          rowW: row.clientWidth,
          text: (title.textContent ?? '').slice(0, 18),
        })
      }
      return out
    })
    if (measured.length === 0) {
      check(`厚度 ${want}:量得到行`, false, '一条行都没量到')
      continue
    }
    const worst = measured.reduce((a, b) => (a.share <= b.share ? a : b))
    shares[want] = Math.round(worst.share * 1000) / 1000
    note(
      `厚度 ${want}(容器 ${got.toFixed(0)}):${measured.length} 行,最低占比 `
        + `${(worst.share * 100).toFixed(1)}%(标题 ${worst.titleW}px / 行 ${worst.rowW}px,「${worst.text}」)`,
    )
    check(
      `厚度 ${want}:标题净宽占行宽 ≥ ${(TITLE_SHARE_MIN * 100).toFixed(0)}%`,
      worst.share >= TITLE_SHARE_MIN,
      `实测 ${(worst.share * 100).toFixed(1)}%`,
    )
  }
  return shares
}

/**
 * ③ **悬停一行 → ⋯ 显形而且真点得到**(09-12 报障「悬停的眼睛点不到」的机器化)。
 *
 * 判据是 `elementFromPoint(⋯ 中心) === 那颗钮`。这一条**必须**用命中测试而不是
 * 「钮在不在 DOM 里」:那次报障里钮一直在 DOM 里、opacity 也是 1,盖在它上面的是
 * 一块 `opacity: 0` 的时间 span(独立层叠上下文 + DOM 顺序在后)—— 眼睛看得见、
 * 鼠标点不到,只有 `elementFromPoint` 说得出这件事。
 */
async function sceneHoverMenu(page, cdp) {
  scene('③ 悬停 → ⋯ 显形且命中测试落在它身上 → 点它弹那张表')
  const target = await page.evaluate(() => {
    const row = document.querySelector('[data-focus-scope="expose"] [data-session-id][data-depth="0"]')
    if (!(row instanceof HTMLElement)) return null
    const r = row.getBoundingClientRect()
    return { id: row.getAttribute('data-session-id'), x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (!target) {
    check('屏幕上有会话行', false, '一条都没有')
    return
  }
  await hoverAt(cdp, { x: target.x, y: target.y })
  /*
   * **等那条淡入跑完**(--dur-hover-fade 300ms)。首跑读到 0.992894 就红了一次 ——
   * 红的是尺子:260ms 的等待切在过渡的最后一帧上。等够比放宽阈值诚实
   * (阈值 0.9 会让「淡入卡在九成」也绿),所以这里轮询到它真的等于 1。
   */
  await waitFor('动作层淡入跑完', () =>
    page.evaluate((id) => {
      const btn = document.querySelector(`[data-testid="session-row-menu-${id}"]`)
      const layer = btn?.parentElement
      return layer ? getComputedStyle(layer).opacity === '1' : false
    }, target.id),
    2500,
  ).catch(() => undefined)
  const probe = await page.evaluate((id) => {
    const btn = document.querySelector(`[data-testid="session-row-menu-${id}"]`)
    if (!(btn instanceof HTMLElement)) return { error: '行尾那颗 ⋯ 不在 DOM 里' }
    const r = btn.getBoundingClientRect()
    const at = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    const hit = document.elementFromPoint(at.x, at.y)
    const layer = btn.closest('[class]')
    return {
      at,
      opacity: getComputedStyle(btn.parentElement ?? btn).opacity,
      // 命中的是那颗钮本身,或者它内部的图标 —— 两者都算「点得到」。
      hitsButton: Boolean(hit && (hit === btn || btn.contains(hit))),
      hitTag: hit ? `${hit.tagName.toLowerCase()}「${(hit.textContent ?? '').trim().slice(0, 12)}」` : null,
      layered: Boolean(layer),
    }
  }, target.id)
  if (probe.error) {
    check('行尾那颗 ⋯ 在 DOM 里', false, probe.error)
    return
  }
  note(`⋯ 中心 (${probe.at.x}, ${probe.at.y})· 动作层 opacity ${probe.opacity}`)
  check('悬停之后动作层显形(opacity 1)', probe.opacity === '1', `实际 ${probe.opacity}`)
  check(
    '`elementFromPoint(⋯ 中心)` 就是那颗钮(09-12 那条报障的机器化)',
    probe.hitsButton,
    `命中的是 ${probe.hitTag}`,
  )
  await clickAt(cdp, probe.at)
  const after = await read(page)
  check('点它弹出一张菜单', after.menuOpen, '')
  check(
    '首行是「打开」(与右键弹的是同一张表)',
    /^(Open|打开查看)$/.test(after.menuFirstItem),
    `首行是「${after.menuFirstItem}」`,
  )
  // 收掉它,别盖着后面几步。
  await page.keyboard.press('Escape')
  await delay(300)
}

/** ④ 搜索行:点开 → 输入 → Esc 三步都要真。 */
async function sceneSearchRow(page, cdp) {
  scene('④ 搜索行:点开 = 输入框 + 焦点;输入 → 行数减少且有 <mark>;Esc → 复原')
  const before = await read(page)
  check('静息态顶上没有输入框,只有那一行字', before.searchRowShown && !before.hasSearchBox, '')
  const at = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="expose-search-row"]')
    if (!(el instanceof HTMLElement)) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  if (!at) {
    check('搜索那一行在屏上', false, '')
    return
  }
  await clickAt(cdp, at)
  const opened = await read(page)
  check('点它 → 输入框在场', opened.hasSearchBox, '')
  check('而且焦点落在输入框里(落点第二档)', opened.searchBoxFocused, '')
  check('那一行字不在场了(同一行的两种形)', !opened.searchRowShown, '')

  // 打一个必然只命中一部分行的词(种子里「导航行」只出现在一部分标题上)。
  await page.keyboard.type('导航行')
  await delay(450)
  const filtered = await read(page)
  note(`搜索前 ${before.rowCount} 行 → 搜索后 ${filtered.rowCount} 行,${filtered.marks} 处高亮`)
  check(
    '行数减少',
    filtered.rowCount < before.rowCount && filtered.rowCount > 0,
    `${before.rowCount} → ${filtered.rowCount}`,
  )
  check('命中词在行上高亮(<mark>)', filtered.marks > 0, `${filtered.marks} 处`)

  await page.keyboard.press('Escape')
  await delay(400)
  const restored = await read(page)
  check('Esc → 输入框消失、那一行字回来', !restored.hasSearchBox && restored.searchRowShown, '')
  check('Esc → 行数复原', restored.rowCount === before.rowCount, `${restored.rowCount} vs ${before.rowCount}`)
  check('Esc → 焦点回搜索那一行(结构性归还)', restored.searchRowFocused, '')
}

/** ⑤ 范围行:点开 → 菜单 → 选一个项目 → 只剩那个项目的行,行上的字换成项目名。 */
async function sceneScopeRow(page, cdp, projectName) {
  scene('⑤ 范围行:点开菜单 → 选一个项目 → 树跟着换,行上的字换成项目名')
  const before = await read(page)
  check('侧栏形里范围行在场(Rail 不在场,范围要有个入口)', before.scopeRowShown && !before.railShown, '')
  const at = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="expose-scope-row"]')
    if (!(el instanceof HTMLElement)) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  if (!at) {
    check('范围那一行在屏上', false, '')
    return
  }
  await clickAt(cdp, at)
  const menu = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="menu"] [role="menuitemradio"]')).map((el) => ({
      text: (el.textContent ?? '').trim(),
      checked: el.getAttribute('aria-checked') === 'true',
    })),
  )
  note(`菜单 ${menu.length} 行:${menu.map((m) => `${m.text}${m.checked ? '✓' : ''}`).join(' / ')}`)
  check('点它弹出范围表', menu.length > 0, '')
  check(
    '打勾的恰好一格(当前那一档)',
    menu.filter((m) => m.checked).length === 1,
    `${menu.filter((m) => m.checked).length} 格打勾`,
  )
  const picked = await page.evaluate((name) => {
    const hit = Array.from(document.querySelectorAll('[role="menu"] [role="menuitemradio"]')).find(
      (el) => (el.textContent ?? '').trim() === name,
    )
    if (!(hit instanceof HTMLElement)) return false
    hit.click()
    return true
  }, projectName)
  check(`菜单里有那个项目(${projectName})`, picked, '')
  if (!picked) {
    await page.keyboard.press('Escape')
    return
  }
  await delay(600)
  const after = await read(page)
  note(`换范围之后 ${after.rowCount} 行(之前 ${before.rowCount});范围行的字「${after.scopeRowText}」`)
  check('只剩那个项目下的行', after.rowCount > 0 && after.rowCount < before.rowCount, `${before.rowCount} → ${after.rowCount}`)
  check('范围行的字换成项目名', after.scopeRowText.includes(projectName), `实际「${after.scopeRowText}」`)
  // 还回「全部」,后面几步量的是全量那一形。
  await clickAt(cdp, at)
  await page.evaluate(() => {
    const hit = Array.from(document.querySelectorAll('[role="menu"] [role="menuitemradio"]'))[0]
    if (hit instanceof HTMLElement) hit.click()
  })
  await delay(500)
}

/* ── ⑦ 动作面(A2,正本 §6⑦)────────────────────────────────────────────────
 *
 * 三步都要**真机**才成立,而且三条各有各的理由:
 *  ⑦a 关闭 —— 判据是「中央区那条 tab 条上少了一格」+「行上那颗开着点没了」,
 *     两者都是**两个 store 的投影对齐**(拼贴树 ↔ 会话行),jsdom 里那两棵树
 *     是同一进程里的两格 setState,真机里它们隔着一次 React 提交与一条 SSE;
 *  ⑦b 重命名 —— 判据的另一半在 **core 侧**(`sessions.listMeta` 那个名字真的
 *     换了),而那一头只有起了一台 core 才问得到;
 *  ⑦c 删除 —— 同上,而且它是**这块面唯一一处模态**:确认框要真开出来才扫得到
 *     (axe 那一扫见下)。
 *
 * ── 确认框那一屏的 axe **为什么长在这道门上**(第 2 轴的「二选一」)──────────
 * 走 B3-a 立的那条顺序法与 T2/B3-a 的搬家判例:**一屏 axe 住哪,由「谁装得出
 * 这块面」决定**。这一框要三件东西同时在场 —— 一份真的会话列表、一次右键弹出
 * 的动作表、一次「删除…」—— 而 `gate:a11y` 那一屏是**裸扫会话总览**,要它走完
 * 这三步等于把「删掉一条会话」这个副作用搬进一道只读的门里。`ui/Dialog` 自己的
 * 语义契约(role / aria-modal / aria-labelledby / 焦点在框内 / Esc 关)**已经**
 * 在 `gate:a11y` 的规格页那一屏钉着(它扫的是同一件库件),这道门补的是
 * **这一框的内容**:标题、正文、两颗钮。同一套标签、同一个 legacy 模式。
 */
async function sceneActionsMenu(page, cdp, record) {
  scene('⑦ 动作面:⋯ → 关闭 / 重命名 / 删除(A2)')

  /** 右键那一行,把那张表弹出来;返回表上每一行的字。 */
  const openRowMenu = async (sessionId) => {
    const ok = await page.evaluate((id) => {
      const row = document.querySelector(`[data-session-id="${id}"]`)
      if (!(row instanceof HTMLElement)) return false
      const r = row.getBoundingClientRect()
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: Math.round(r.x + r.width / 2),
          clientY: Math.round(r.y + r.height / 2),
        }),
      )
      return true
    }, sessionId)
    if (!ok) return []
    await delay(300)
    return page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map((el) =>
        (el.textContent ?? '').trim(),
      ),
    )
  }
  /** 点表上那一行(按字面找 —— 那正是人眼读到的东西)。 */
  const pickMenuRow = async (label) => {
    const hit = await page.evaluate((want) => {
      const el = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find(
        (row) => (row.textContent ?? '').trim() === want,
      )
      if (!(el instanceof HTMLElement)) return false
      el.click()
      return true
    }, label)
    await delay(450)
    return hit
  }
  /** 中央区那条 tab 条上此刻摆着哪几格(判据与 `gate:workspace` 同一个取件口)。 */
  const centerTabs = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="topbar-tabs"] [role="tab"]')).map(
        (el) => el.getAttribute('data-tab-id') ?? '',
      ),
    )
  /** core 侧那一份名册(**门的判据的另一半**:屏幕换了字不等于账本换了)。 */
  const coreNames = async () => {
    const answer = await rpc(record, 'sessions', 'listMeta', {})
    const rows = answer?.sessions ?? []
    return new Map(rows.map((row) => [row.id, row.name]))
  }

  const ids = (await read(page)).rowIds
  if (ids.length < 2) {
    check('屏幕上至少两条会话(⑦ 要开两格才关得掉)', false, `${ids.length} 条`)
    return
  }
  const [first, second] = ids

  /* ── ⑦a 关闭 ─────────────────────────────────────────────────────────────
   * **先开两格**再关:`canDetachTab` 那条守卫(常驻那一种在它自己的家里的
   * 最后一格不许走)对中央区的会话是成立的 —— 只开一格时「关闭」会如实地被
   * 拒绝并播报一句,那是另一条路。这一步量的是它真关得掉的那一档。
   */
  await page.evaluate((id) => {
    const row = document.querySelector(`[data-session-id="${id}"]`)
    if (row instanceof HTMLElement) row.click()
  }, first)
  await delay(700)
  const menuA = await openRowMenu(second)
  check('右键弹出的那张表带「在新标签页打开」', menuA.some((row) => /新标签页|new tab/i.test(row)), menuA.join(' / '))
  await pickMenuRow(menuA.find((row) => /新标签页|new tab/i.test(row)) ?? '')
  const twoTabs = await centerTabs()
  note(`中央区 tab:${twoTabs.join(' / ')}`)
  check('两条会话都开在中央区', twoTabs.length >= 2, `${twoTabs.length} 格`)

  const menuClose = await openRowMenu(second)
  check(
    '开着的那一条,表上有「关闭」这一行',
    menuClose.some((row) => /^(关闭|Close)$/.test(row)),
    menuClose.join(' / '),
  )
  const closed = await pickMenuRow(menuClose.find((row) => /^(关闭|Close)$/.test(row)) ?? '')
  check('点得到「关闭」', closed, '')
  const afterClose = await centerTabs()
  const dotGone = await page.evaluate(
    (id) => !document.querySelector(`[data-testid="session-row-open-${id}"]`),
    second,
  )
  note(`关掉之后中央区 tab:${afterClose.join(' / ')}`)
  check(
    '中央区少了那一格',
    afterClose.length === twoTabs.length - 1 && !afterClose.includes(`session:${second}`),
    `${twoTabs.length} → ${afterClose.length}`,
  )
  check('行上那颗「开着」点没了(一套判据两处消费)', dotGone, '')
  // **关闭不删数据**:账本上那一条还在 —— 这一条正是拍板 5 的机械含义。
  const namesAfterClose = await coreNames()
  check('关闭**不删数据**:core 侧那一条还在', namesAfterClose.has(second), '')
  // 没开着的那一条,这一行整格不在场(它没有对象,不是做不了)。
  const menuGone = await openRowMenu(second)
  check(
    '关掉之后再右键,「关闭」这一行不在场了',
    !menuGone.some((row) => /^(关闭|Close)$/.test(row)),
    menuGone.join(' / '),
  )
  await page.keyboard.press('Escape')
  await delay(250)

  /* ── ⑦b 重命名 ────────────────────────────────────────────────────────── */
  const NEW_NAME = 'A2 改过的名字'
  const menuRename = await openRowMenu(first)
  const renameLabel = menuRename.find((row) => /^(重命名…|Rename…)$/.test(row))
  check('表上有「重命名…」', Boolean(renameLabel), menuRename.join(' / '))
  if (renameLabel) {
    const clickedRename = await pickMenuRow(renameLabel)
    check('点得到「重命名…」', clickedRename, '')
    const box = await page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="session-row-rename-${id}"]`)
      if (!(el instanceof HTMLElement)) return null
      const row = el.closest('[data-session-id]')
      return {
        inRow: Boolean(row && row.getAttribute('data-session-id') === id),
        focused: document.activeElement === el,
        value: el instanceof HTMLInputElement ? el.value : '',
        selected:
          el instanceof HTMLInputElement
            ? el.selectionStart === 0 && el.selectionEnd === el.value.length
            : false,
      }
    }, first)
    if (!box) {
      check('那一行原地长出一只输入框', false, '框不在 DOM 里')
    } else {
      check('那只框长在**那一行里面**(原地,不是弹一个对话框)', box.inRow, '')
      /*
       * **这一条是那个真机 bug 的机械化**(病历在 `SessionRename.tsx` 文件头):
       * 菜单卸载之后结构性归还会把焦点放回这块面的落点,落点答错的话这只框
       * 当场 blur → `cancelOnBlur` 收回 → 屏幕上什么都没发生。所以判的是
       * 「450ms 之后它**还**拿着焦点」,不是「它刚挂载时拿到过焦点」。
       */
      check('焦点落在框里、而且**留在**框里(落点第 ⓿ 档)', box.focused, '')
      check('一进来就选中全文(接着打就是覆盖)', box.selected, `value=「${box.value}」`)

      /*
       * **挤压纪律**(一行一个弯腰件):这只框顶替标题站在同一个位置上,所以它
       * 也得是那个弯腰的 —— 按内容宽度撑出去的话会把行尾那颗 ⋯ 推出架子。
       * 判据是几何:框的右缘不越过行的右缘(jsdom 里量不出来,只有真机有分子)。
       */
      const geo = await page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="session-row-rename-${id}"]`)
        const row = el?.closest('[data-session-id]')
        const shelf = document.querySelector('[data-shelf="left"]')
        if (!el || !row || !shelf) return null
        const b = el.getBoundingClientRect()
        const r = row.getBoundingClientRect()
        const sh = shelf.getBoundingClientRect()
        return {
          boxRight: Math.round(b.right),
          rowRight: Math.round(r.right),
          shelfRight: Math.round(sh.right),
          rowW: Math.round(r.width),
          boxW: Math.round(b.width),
        }
      }, first)
      if (geo) {
        note(`改名框几何:框 ${geo.boxW}px(右缘 ${geo.boxRight})· 行 ${geo.rowW}px(右缘 ${geo.rowRight})· 架子右缘 ${geo.shelfRight}`)
        check(
          '改名框不越过行的右缘(它是这一行唯一的弯腰件)',
          geo.boxRight <= geo.rowRight + 1,
          `框 ${geo.boxRight} vs 行 ${geo.rowRight}`,
        )
      }

      /*
       * axe 扫**改名态那一屏**(第 2 轴:新 surface 要有一屏 axe)。它与确认框
       * 那一扫同一条搬家判据 —— 这一屏要一次右键 + 一次点菜单才站得出来,
       * `gate:a11y` 那一屏是裸扫会话总览,等不到它。`include` 收到这块面的根上
       * (框长在那一行里,单扫一个 `<input>` 扫不出「它在谁里面」这类规则)。
       */
      const axeRename = await new AxeBuilder({ page })
        .setLegacyMode(true)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .include('[data-focus-scope="expose"]')
        .analyze()
      for (const v of axeRename.violations) {
        note(`[${v.impact}] ${v.id} —— ${v.help}`)
        for (const node of v.nodes.slice(0, 4)) note(`  ${node.target.join(' ')}`)
      }
      check(
        `改名态那一屏 axe 零违例(过了 ${axeRename.passes.length} 条规则)`,
        axeRename.violations.length === 0,
        `${axeRename.violations.length} 条违例`,
      )

      // 真键盘:全选之后打新名字,↵ 落定(CDP,不动真光标)。
      await page.keyboard.type(NEW_NAME)
      await page.keyboard.press('Enter')
      await delay(900)
      const rowText = await page.evaluate(
        (id) => document.querySelector(`[data-session-id="${id}"]`)?.textContent ?? '',
        first,
      )
      const boxGone = await page.evaluate(
        (id) => !document.querySelector(`[data-testid="session-row-rename-${id}"]`),
        first,
      )
      check('框收回了', boxGone, '')
      check('行上的字换了', rowText.includes(NEW_NAME), `实际「${rowText.slice(0, 40)}」`)
      const names = await coreNames()
      note(`core 侧那一条现在叫「${names.get(first)}」`)
      check(
        'core 侧 `sessions.listMeta` 的名字也换了(屏幕换字不等于账本换字)',
        names.get(first) === NEW_NAME,
        `实际「${names.get(first)}」`,
      )
    }
  }

  /* ── ⑦c 删除(含确认框那一屏的 axe)──────────────────────────────────── */
  /*
   * 删除那一步的正文断言按**屏幕上此刻那一行的字**比,而不是按 ⑦b 打进去的
   * 那个字面量:两者相等是 ⑦b 自己的断言,在这里再假设一遍会让一条红变两条
   * (首跑就是这么读的:⑦b 红了之后这一条跟着红,而它自己没毛病)。
   */
  const liveTitle = await page.evaluate(
    (id) => document.querySelector(`[data-session-id="${id}"] span`)?.textContent?.trim() ?? '',
    first,
  )
  const menuDelete = await openRowMenu(first)
  const deleteLabel = menuDelete.find((row) => /^(删除…|Delete…)$/.test(row))
  check('表上有「删除…」', Boolean(deleteLabel), menuDelete.join(' / '))
  if (deleteLabel) {
    await pickMenuRow(deleteLabel)
    const dialog = await page.evaluate(() => {
      const el = document.querySelector('[role="dialog"][aria-modal="true"]')
      if (!(el instanceof HTMLElement)) return null
      return {
        text: (el.textContent ?? '').trim(),
        focusInside: el.contains(document.activeElement),
        buttons: Array.from(el.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim()),
        menuGone: !document.querySelector('[role="menu"]'),
      }
    })
    if (!dialog) {
      check('确认框开出来了', false, '屏上没有 [role="dialog"]')
    } else {
      note(`确认框:「${dialog.text.slice(0, 60)}」·钮 ${dialog.buttons.join(' / ')}`)
      check('确认框在场(唯一允许的确认:数据会没)', true, '')
      check(
        '正文**点名那条会话**(400 行里「确定删除吗」说不清删的是哪一条)',
        Boolean(liveTitle) && dialog.text.includes(liveTitle),
        `行上是「${liveTitle}」`,
      )
      check('菜单先卸载,框才开(两层浮层叠着 Esc 该退哪一层说不清)', dialog.menuGone, '')
      check('焦点进了框里', dialog.focusInside, '')
      check(
        '有逃生口(禁止只有「确定」的死胡同)',
        dialog.buttons.some((b) => /^(取消|Cancel)$/.test(b)),
        dialog.buttons.join(' / '),
      )

      /*
       * axe 扫**这一框**。`setLegacyMode(true)` 是必须的(与 `gate-a11y.scanAxe` /
       * `gate-terminal` ⑧ / `gate-browser` ⑪ 逐字同一个理由):默认模式下
       * AxeBuilder 会 `newPage()` 去处理跨 frame,而 Electron 的 CDP 不支持
       * `Target.createTarget`,当场协议报错。
       */
      const axe = await new AxeBuilder({ page })
        .setLegacyMode(true)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .include('[role="dialog"]')
        .analyze()
      for (const v of axe.violations) {
        note(`[${v.impact}] ${v.id} —— ${v.help}`)
        for (const node of v.nodes.slice(0, 4)) note(`  ${node.target.join(' ')}`)
      }
      check(
        `确认框那一屏 axe 零违例(过了 ${axe.passes.length} 条规则)`,
        axe.violations.length === 0,
        `${axe.violations.length} 条违例`,
      )

      const confirmed = await page.evaluate(() => {
        const el = document.querySelector('[role="dialog"][aria-modal="true"]')
        const hit = Array.from(el?.querySelectorAll('button') ?? []).find((b) =>
          /^(删除|Delete)$/.test((b.textContent ?? '').trim()),
        )
        if (!(hit instanceof HTMLElement)) return false
        hit.click()
        return true
      })
      check('点得到「删除」那颗钮', confirmed, '')
      await delay(1200)
      const gone = await read(page)
      check('那一行没了', !gone.rowIds.includes(first), `还在:${gone.rowIds.includes(first)}`)
      const names = await coreNames()
      check('core 侧也没了(账本真的删了)', !names.has(first), '')
      note(`删完还剩 ${gone.rowCount} 行 / core 侧 ${names.size} 条`)
    }
  }
}

/** ⑥ 撕成一扇 900 宽的浮窗:Rail 在场、范围行不在、时间列在。 */
async function sceneWideForm(page) {
  scene('⑥ 总览形(容器 ≥761):Rail 在场 · 范围行不在 · 时间列在')
  const torn = await pickFromTileMenu(page, 'sessions', /^(Float|浮窗)$/)
  check('Dock 菜单里有「浮窗」那一项', torn, '')
  if (!torn) return
  await waitFor('浮窗里的总览就位', () =>
    page.evaluate(() =>
      Boolean(document.querySelector('[data-focus-scope="expose"]')?.closest('[role="dialog"]')),
    ),
  )
  await delay(500)
  const wide = await read(page)
  note(`容器宽 ${wide.rootRect?.w}`)
  check('容器真的进了宽档(> 760)', (wide.rootRect?.w ?? 0) > 760, `实际 ${wide.rootRect?.w}`)
  check('Rail 在场', wide.railShown, '')
  check('范围行不在场(侧栏已经是范围控件,顶上不出第二个)', !wide.scopeRowShown, '')
  check('时间列在场', wide.timeShown, '')
  check('搜索仍然是一行字(两种形共用这一件)', wide.searchRowShown && !wide.hasSearchBox, '')
}

/**
 * ⑧ **冷开读数**(正本 §6⑧)。
 *
 * 400 行那一档是 `gate:perf` 场景①的事(它自己种 400 条会话并录 CDP trace);
 * 这道门种 24 条,所以这一步量的是**这块面从点下去到第一行上屏**那一段,
 * 判据仍是同一格预算(`src/perf-budget.ts` 的 `coldOpenMs` / `longFrameMs`)。
 * 两道门各量自己那一档,读数都进交卷报 —— 这一步不替代 gate:perf。
 *
 * 时刻的产地在**页内**(`performance.now` 夹双 rAF),不是 node 侧轮询:
 * 轮询间隔会直接变成误差下限。长帧**切窗口取样**(判词在 installFrameProbe 上)。
 */
async function sceneColdOpen(page) {
  scene('⑧ 冷开读数:点 Dock 瓦 → 第一行上屏')
  // 先收回去,才有「冷开」可量(点瓦是开关)。
  const there = await page.evaluate(() =>
    Boolean(document.querySelector('[data-focus-scope="expose"] [data-session-id]')),
  )
  if (there) {
    await clickTile(page, 'sessions')
    await delay(600)
  }
  await installFrameProbe(page)
  const mark = await frameMark(page)
  const measured = await page.evaluate(async () => {
    const tile = document.querySelector('[data-testid="dock-tile-sessions"]')
    if (!(tile instanceof HTMLElement)) return { error: 'Dock 上没有会话瓦' }
    const t0 = performance.now()
    tile.click()
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    for (let i = 0; i < 240; i += 1) {
      await frame()
      if (document.querySelector('[data-focus-scope="expose"] [data-session-id]')) {
        // 双 rAF:第一帧只保证 DOM 在了,第二帧之后它才真的画上去了。
        await frame()
        const rows = document.querySelectorAll('[data-focus-scope="expose"] [data-session-id]').length
        return { ms: Math.round(performance.now() - t0), rows }
      }
    }
    return { error: '240 帧之内没有画出会话行' }
  })
  const frames = await frameHarvest(page, mark)
  if (measured.error) {
    check('冷开量得到', false, measured.error)
    return null
  }
  note(`画出 ${measured.rows} 行,点击 → 上屏 ${measured.ms}ms(预算 ${COLD_OPEN_MS}ms)`)
  note(
    frames.known
      ? `期间 > ${LONG_FRAME_MS}ms 的长帧 ${frames.frames} 段,最长 ${frames.longest}ms`
      : '长帧探针装不上(旧内核 / 被关掉)—— 这一条跳过,不假装绿',
  )
  check(`点击 → 上屏 ≤ 冷开预算 ${COLD_OPEN_MS}ms`, measured.ms <= COLD_OPEN_MS, `实测 ${measured.ms}ms`)
  if (frames.known) {
    check(`期间零 > ${LONG_FRAME_MS}ms 的长帧`, frames.frames === 0, `${frames.frames} 段,最长 ${frames.longest}ms`)
  }
  return { ms: measured.ms, rows: measured.rows, frames }
}

/* ── 装配 ─────────────────────────────────────────────────────────────── */

async function main() {
  if (!existsSync(serverEntry)) {
    process.stdout.write(
      `[gate:sessions] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\`\n`,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry)) {
    process.stdout.write(
      `[gate:sessions] 找不到 ${path.relative(appRoot, mainEntry)} —— 先跑 \`npm run app:build\`\n`,
    )
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'sessions-gate-store-'))
  const ws = await mkdtemp(path.join(tmpdir(), 'sessions-gate-ws-'))
  const udd = await mkdtemp(path.join(tmpdir(), 'sessions-gate-udd-'))
  let ctx
  let shares = {}
  let cold = null
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

    /*
     * 24 条会话,标题 8–70 字随机长度。**最后三条给一个工作目录** —— ⑤ 要在
     * 范围表里选一个真项目,而项目那一族是从「有工作目录的会话」现造的
     * (`projection.buildProjects`)。目录名就是屏幕上那个项目名(路径末段)。
     */
    const titles = seedTitles(24)
    const projectDir = path.join(ws, 'sessions-gate-project')
    /*
     * 目录要**真存在**:`sessions.updateWorkingDirectory` 在本机可信面上走 ipc
     * 那条路,沙箱不夹持、路径被逐字当真,不存在的目录会被后端当场拒掉
     * (`Directory does not exist` —— gate-squeeze 08-31 踩过同一条)。
     * 门跑在宿主上,所以直接 mkdir,退出时随 `ws` 整根删掉。
     */
    await mkdir(projectDir, { recursive: true })
    for (let i = 0; i < titles.length; i += 1) {
      const created = await rpc(record, 'sessions', 'create', { name: titles[i] })
      const id = created?.session?.id
      if (!id) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(created)}`)
      if (i >= titles.length - 3) {
        await rpc(record, 'sessions', 'updateWorkingDirectory', {
          sessionId: id,
          workingDirectory: projectDir,
        }).catch(() => undefined)
      }
    }
    note(`种了 ${titles.length} 条会话(标题 ${Math.min(...titles.map((t) => t.length))}–${Math.max(...titles.map((t) => t.length))} 字)`)

    ctx = await launch(store, udd)
    await openOnLeftShelf(ctx.page)
    // 先把厚度摆到最窄那一档:①③④⑤ 量的都是侧栏形。
    await dragThicknessTo(ctx.page, THICKNESSES[0])

    await sceneLead(ctx.page)
    shares = await sceneTitleShare(ctx.page)
    // ②跑完停在最后一档(320);③④⑤ 回到 240 —— 最挤那一档才是被试。
    await dragThicknessTo(ctx.page, THICKNESSES[0])
    await sceneHoverMenu(ctx.page, ctx.cdp)
    await sceneSearchRow(ctx.page, ctx.cdp)
    await sceneScopeRow(ctx.page, ctx.cdp, 'sessions-gate-project')
    /*
     * ⑦ 排在 ⑥ **之前**:它要的是侧栏形那一档的行(240 宽),而 ⑥ 会把这块面
     * 撕成一扇 900 宽的浮窗 —— 那之后左架子上就没有行可以右键了。
     * 它也排在 ⑧ 之前:⑦c 真删掉一条会话,而 ⑧ 量的是「这一屏画多久」,
     * 少一条行对那个读数是无害的(⑧ 自己报行数)。
     */
    await sceneActionsMenu(ctx.page, ctx.cdp, record)
    await sceneWideForm(ctx.page)
    cold = await sceneColdOpen(ctx.page)
  } finally {
    await shut(ctx)
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
    for (const dir of [store, ws, udd]) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const failed = results.filter((r) => !r.ok)
  process.stdout.write(`\n[gate:sessions] ${results.length - failed.length}/${results.length} 条通过\n`)
  process.stdout.write(
    `[gate:sessions] 读数:标题占比 ${Object.entries(shares).map(([k, v]) => `${k}档 ${(v * 100).toFixed(1)}%`).join(' / ') || '—'}`
      + `;冷开 ${cold ? `${cold.ms}ms / ${cold.rows} 行 / 长帧 ${cold.frames.known ? cold.frames.frames : '未知'} 段` : '—'}\n`,
  )
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  ✗ ${f.scene} · ${f.label}  ${f.detail}\n`)
    process.stdout.write('[gate:sessions] FAILED\n')
    process.exit(1)
  }
  process.stdout.write(
    '[gate:sessions] ok —— 左缘对着红灯中心 / 两档标题占比 / ⋯ 真点得到 / 搜索行三步 / 范围菜单 / 动作面三步(关闭·改名·删除,含确认框 axe)/ 两种形换手 / 冷开读数\n',
  )
}

main().catch(async (err) => {
  process.stdout.write(`\n[gate:sessions] 崩了:${err?.stack ?? err}\n`)
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
