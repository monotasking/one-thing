#!/usr/bin/env node
/**
 * Dock 自动隐藏**唤醒**的真机门(09-03,报障「dock 的出现太敏感」)。
 *
 * `gate:dock` 量的是**磁性放大**(条已经在屏上之后每块瓦怎么动);这一道量的是它前面
 * 那一跳:**藏着的条什么时候该出来**。两道门互不覆盖,所以是两个脚本、两套读数。
 *
 * ── 它问的六件事 ───────────────────────────────────────────────────────────
 *  ① **穿过不算数**。自然速度(6px/帧)从窗中央划到底边并继续出窗,重复 20 次,
 *     数唤醒次数。修前判据是「离边 ≤8px 立刻为真」,所以 HEAD 上这一条是 **20**;
 *     停留门槛落地之后应当是 **0** —— 一次穿越在带内只待 1–2 帧(≈22ms),
 *     离 DOCK_WAKE_DWELL_MS(180ms)差一个量级。
 *     这一条就是用户报的那件事的机器定义:去点系统 Dock / 去别的窗口 / 拖窗口边,
 *     每一次都要穿过那 8px。
 *  ② **停留算数**。划到带内停住 250ms → 条出来(且在 dwell + 一次入场时长之内)。
 *     它守的是「别把功能修没了」——①②必须同时绿,只绿①的修法是把唤醒删掉。
 *  ③ **停留但失焦不算数**。在带内停 100ms 之后窗口失焦,再等 3 倍门槛 → 不唤醒。
 *     出窗之后 pointermove 就停发了,计时器会以为手还停在边上 —— 这一条是本批
 *     另一半(宿主的「出窗即取消」)的真机判据。
 *  ④ **短停不算数**。停 100ms(< 门槛)就离开 → 不唤醒。
 *  ⑤ **留驻不回退**(08-31 那 12 组手势的真机哨兵)。唤醒之后往上抬 30px 停 500ms
 *     → 仍在屏上。本批只在「藏着 → 出来」那一跳前加门槛,出来之后一个字没动。
 *  ⑥ **出窗收回**。唤醒之后指针出窗 → 收回宽限(--dur-dock-hide-delay 300ms)之后收回。
 *
 * ── 量法 ───────────────────────────────────────────────────────────────────
 * 指针一律走 CDP `Input.dispatchMouseEvent`:只进目标窗口,**不动真光标、不抢焦点**
 * (09-01 判例:系统级合成输入干扰用户用电脑)。
 * 「出来了没有」读的是 Dock 那条 `<nav>` 的 class(自动隐藏档藏着时带 `.hidden`),
 * 由页面里一台 MutationObserver 数**藏→显**的翻转次数 —— 不读任何 JS 私有状态,
 * 所以同一份脚本原样跑得动改前的代码,before/after 才可比。
 *
 * 跑法:`npm run gate:dock-wake`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 读数落在 `DOCK_WAKE_GATE_OUT` 指定的目录(不给就只打在 stdout)。
 * 可重复:每次一个全新的临时 store + 全新的 --user-data-dir,跑完删干净。
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

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/* ── 判据(每条都写清「为什么是这个数」)───────────────────────────────────── */

/** ① 一次「穿过」的速度(px/帧)与节拍(ms)。6px/帧 ≈ 360px/s,一次从容的移动。 */
const CROSS_STEP_PX = 6
const FRAME_MS = 1000 / 60
/** ① 重复多少次。20 次足够把「每穿一次唤醒一次」与「一次都不唤醒」分开。 */
const CROSS_REPEATS = 20
/** ① 出窗之后再往下走这么远(px),模拟手真的离开了这扇窗。 */
const OUT_OF_WINDOW_PX = 40

/**
 * 停留门槛(与 tokens.css 的 --dur-dock-wake / components/motion.ts 的
 * DOCK_WAKE_DWELL_MS 同一事实)。**从 tokens.css 现读**,不在这里写第二份数。
 */
const DWELL_MS = readTokenMs('--dur-dock-wake')
/** 收回宽限(--dur-dock-hide-delay)。同上,现读。 */
const HIDE_DELAY_MS = readTokenMs('--dur-dock-hide-delay')
/** 入场动画(--dur-enter)—— ② 判「多久之内出来」时给它留一档余量。 */
const ENTER_MS = readTokenMs('--dur-enter') ?? 140

/** ② 停多久(必须明显 > 门槛)。 */
const DWELL_HOLD_MS = 250
/** ④ 停多久(必须明显 < 门槛)。 */
const SHORT_HOLD_MS = 100
/** ③ 进带之后隔多久递失焦。留够余量让那一发在门槛之前到(见 ③ 的注释)。 */
const BLUR_HOLD_MS = 40
/** ⑤ 唤醒后往上抬多少 px、停多久。30 < DOCK_HOLD_PAD(24)+ 条身,落在留驻区里。 */
const HOLD_LIFT_PX = 30
const HOLD_SETTLE_MS = 500
/** 每一条之间的静默:让上一条的收回宽限跑完,免得互相污染。 */
const BETWEEN_MS = 600

const failures = []
const readings = {}
const outDir = process.env.DOCK_WAKE_GATE_OUT

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 从 tokens.css 现读一个 --dur-* (ms)。产地只有一处,门不许抄第二份。 */
function readTokenMs(name) {
  const css = readFileSync(path.join(appRoot, 'src/styles/tokens.css'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )
  const hit = new RegExp(`${name}\\s*:\\s*([0-9.]+)(ms|s)\\s*;`).exec(css)
  if (!hit) return undefined
  return hit[2] === 's' ? Number(hit[1]) * 1000 : Number(hit[1])
}

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
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

function check(ok, message) {
  if (ok) console.log(`  ✓ ${message}`)
  else {
    console.log(`  ✗ ${message}`)
    failures.push(message)
  }
}

/* ── 页面里的探针 ─────────────────────────────────────────────────────────── */

/**
 * 一台 MutationObserver 数 Dock 那条 `<nav>` 的**藏→显**翻转,外加一个 blur 计数器
 * (③ 要知道真机 blur 到底有没有发出来,而不是「反正没唤醒就算过」)。
 * 只读 class,不读任何 JS 私有状态 —— 所以改前改后同一份脚本。
 */
const INSTALL_PROBE = `(() => {
  const strip = document.querySelector('[data-dock="strip"]')
  const nav = strip.closest('nav')
  const hidden = (el) => [...el.classList].some((c) => /(^|_)hidden(_|$)/.test(c))
  const state = { wakes: 0, hides: 0, blurs: 0, moves: 0, last: null, shown: !hidden(nav), stamps: [] }
  window.__dockWakeProbe = state
  const observer = new MutationObserver(() => {
    const now = !hidden(nav)
    if (now === state.shown) return
    state.shown = now
    if (now) state.wakes += 1
    else state.hides += 1
    state.stamps.push({ t: Math.round(performance.now()), shown: now })
  })
  observer.observe(nav, { attributes: true, attributeFilter: ['class'] })
  window.addEventListener('blur', () => { state.blurs += 1 })
  window.addEventListener('pointermove', (e) => { state.moves += 1; state.last = [e.clientX, e.clientY] })
  return { hiddenAtInstall: hidden(nav) }
})()`

function probe(page) {
  return page.evaluate(() => {
    const s = window.__dockWakeProbe
    return { wakes: s.wakes, hides: s.hides, blurs: s.blurs, moves: s.moves, last: s.last, shown: s.shown }
  })
}

function resetProbe(page) {
  return page.evaluate(() => {
    const s = window.__dockWakeProbe
    s.wakes = 0
    s.hides = 0
    s.blurs = 0
    s.moves = 0
    s.stamps = []
    return s.shown
  })
}

function move(cdp, x, y) {
  return cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
}

/** 把指针**瞬移**回窗中央 —— 一发事件,不在带里逗留(否则回程本身又是一次穿越)。 */
async function park(cdp, viewport) {
  await move(cdp, Math.round(viewport[0] / 2), Math.round(viewport[1] / 2))
}

/** 一次「穿过」:从窗中央按 step/帧 一路划到底边并继续出窗。 */
async function crossOnce(cdp, viewport) {
  const x = Math.round(viewport[0] / 2)
  for (let y = Math.round(viewport[1] / 2); y <= viewport[1] + OUT_OF_WINDOW_PX; y += CROSS_STEP_PX) {
    await move(cdp, x, y)
    await delay(FRAME_MS)
  }
}

/* ── 主流程 ───────────────────────────────────────────────────────────────── */

/** 形态机存盘的键与版本(与 src/stage/store.ts 的 `name` / STAGE_PERSIST_VERSION 同源)。 */
const STAGE_KEY = 'onething.stage'
const STAGE_VERSION = 7

async function main() {
  if (DWELL_MS === undefined || HIDE_DELAY_MS === undefined) {
    console.error('[dock-wake-gate] tokens.css 里读不到 --dur-dock-wake / --dur-dock-hide-delay')
    process.exit(1)
  }
  if (!existsSync(serverEntry)) {
    console.error(
      `[dock-wake-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[dock-wake-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }
  readings.dwellMs = DWELL_MS
  readings.hideDelayMs = HIDE_DELAY_MS

  const store = await mkdtemp(path.join(tmpdir(), 'dock-wake-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'dock-wake-userdata-'))
  let server
  let app
  try {
    console.log('\n[1/9] 起一台 core')
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', (chunk) => serverErr.push(chunk.toString()))
    const rec = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch((error) => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    if (!(await portConnects(rec.host, rec.port))) throw new Error('core 端口连不上')
    console.log('  ✓ core 起来了')

    console.log('\n[2/9] 拉起应用(独立 --user-data-dir),切到自动隐藏档')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    let page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitFor('Dock 就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-dock="strip"] > div button'))),
    )
    /*
     * **先等主题贴到 :root 再动 reload**。主题是异步贴上去的一组 `--ui-*`,那一段
     * 里主进程还在往这扇窗上装东西;在那之前 reload 会把 Playwright 手上的
     * target 掀掉(实测:`Target page, context or browser has been closed`)。
     * 与 gate-dock 那条「等主题落地」是同一件事,只是这里它还兼作**开量前的静默期**。
     */
    await waitFor('主题贴到 :root 上', () =>
      page.evaluate(() =>
        Boolean(
          getComputedStyle(document.documentElement).getPropertyValue('--ui-surface-panel-bg').trim(),
        ),
      ),
    )
    await delay(1000)
    /*
     * 走**存盘 + reload** 而不是直接改 DOM(与 gate-dock 的 ⑨ 同一手):门要证的是
     * 整条链(设置 → 存盘 → store → AppShell 的那只 effect)都成立。
     */
    await page.evaluate(
      ([key, version]) => {
        const raw = window.localStorage.getItem(key)
        const prev = raw ? JSON.parse(raw) : { state: {}, version }
        window.localStorage.setItem(
          key,
          JSON.stringify({ ...prev, state: { ...prev.state, dockDisplay: 'autohide' }, version }),
        )
      },
      [STAGE_KEY, STAGE_VERSION],
    )
    await page.reload()
    // reload 之后重新认一次窗:主进程也可能在这一下里换掉 target(见上面那条判例)。
    page = app.windows()[0] ?? page
    await page.waitForLoadState('domcontentloaded')
    await waitFor('Dock 就位(自动隐藏档)', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-dock="strip"] > div button'))),
    )
    await waitFor('主题贴到 :root 上(reload 后)', () =>
      page.evaluate(() =>
        Boolean(
          getComputedStyle(document.documentElement).getPropertyValue('--ui-surface-panel-bg').trim(),
        ),
      ),
    )
    /*
     * 等窗口身量稳住再开量:Electron 起窗后还会自己调一两次大小,而窄带是按视口底
     * 算的 —— 窗口一变高,「带内」那一段就换了地方(gate-dock 同一条判例)。
     */
    const viewport = await waitFor('窗口身量稳住', () =>
      page.evaluate(async () => {
        let prev = [window.innerWidth, window.innerHeight]
        for (let i = 0; i < 10; i += 1) {
          await new Promise((r) => requestAnimationFrame(r))
          const cur = [window.innerWidth, window.innerHeight]
          if (cur[0] !== prev[0] || cur[1] !== prev[1]) return null
          prev = cur
        }
        return prev
      }),
    )
    readings.viewport = viewport
    const installed = await page.evaluate(INSTALL_PROBE)
    readings.hiddenAtInstall = installed.hiddenAtInstall
    check(installed.hiddenAtInstall === true, `自动隐藏档下开局是藏着的(实测 hidden=${installed.hiddenAtInstall})`)
    const cdp = await app.context().newCDPSession(page)
    console.log(`  ✓ 外壳画出来了(窗口 ${viewport.join('×')}),探针与 CDP 会话已装`)

    console.log(`\n[3/9] ① 穿过 ${CROSS_REPEATS} 次(${CROSS_STEP_PX}px/帧,划到底边并继续出窗)`)
    await park(cdp, viewport)
    await delay(BETWEEN_MS)
    await resetProbe(page)
    for (let i = 0; i < CROSS_REPEATS; i += 1) {
      await crossOnce(cdp, viewport)
      await park(cdp, viewport)
      await delay(FRAME_MS * 2)
    }
    await delay(DWELL_MS * 2)
    const crossed = await probe(page)
    readings.crossWakes = crossed.wakes
    console.log(`  ${CROSS_REPEATS} 次穿越 → 唤醒 ${crossed.wakes} 次`)
    check(crossed.wakes === 0, `① 穿过窄带一次都不唤醒(实测 ${crossed.wakes} 次 / ${CROSS_REPEATS} 次穿越)`)

    console.log('\n[4/9] ② 划到带内停住 → 该出来')
    await park(cdp, viewport)
    await delay(BETWEEN_MS)
    await resetProbe(page)
    const bandY = viewport[1] - 2
    const bandX = Math.round(viewport[0] / 2)
    const t0 = Date.now()
    await move(cdp, bandX, bandY)
    await delay(DWELL_HOLD_MS)
    const dwelled = await probe(page)
    readings.dwellWakeMs = Date.now() - t0
    readings.dwellWakes = dwelled.wakes
    console.log(`  停 ${DWELL_HOLD_MS}ms → 唤醒 ${dwelled.wakes} 次,此刻 shown=${dwelled.shown}`)
    check(
      dwelled.shown === true && dwelled.wakes === 1,
      `② 停满门槛就出来(实测 wakes=${dwelled.wakes} shown=${dwelled.shown};门槛 ${DWELL_MS}ms + 入场 ${ENTER_MS}ms 之内)`,
    )

    console.log('\n[5/9] ⑤ 唤醒之后往上抬 30px 停住 → 留驻不回退(08-31 那 12 组的哨兵)')
    await resetProbe(page)
    await move(cdp, bandX, viewport[1] - HOLD_LIFT_PX)
    await delay(HOLD_SETTLE_MS)
    const held = await probe(page)
    readings.holdHides = held.hides
    console.log(`  抬 ${HOLD_LIFT_PX}px 停 ${HOLD_SETTLE_MS}ms → 收回 ${held.hides} 次,shown=${held.shown}`)
    check(held.shown === true && held.hides === 0, `⑤ 留驻语义不回退(实测 hides=${held.hides} shown=${held.shown})`)

    console.log('\n[6/9] ⑥ 唤醒着出窗 → 收回宽限之后收回')
    await resetProbe(page)
    await move(cdp, bandX, viewport[1] + OUT_OF_WINDOW_PX)
    await delay(HIDE_DELAY_MS + 400)
    const left = await probe(page)
    readings.outOfWindowHides = left.hides
    console.log(`  出窗后等 ${HIDE_DELAY_MS + 400}ms → 收回 ${left.hides} 次,shown=${left.shown}`)
    check(left.shown === false && left.hides === 1, `⑥ 出窗之后走 ${HIDE_DELAY_MS}ms 宽限收回(实测 hides=${left.hides} shown=${left.shown})`)

    console.log('\n[7/9] ③ 停在带内但窗口失焦 → 不唤醒')
    /*
     * **先在带外把 blur 那条路探明白**,再进带 —— 而不是进带之后现试。
     * 理由是时序:这一条要在门槛(180ms)到点**之前**把失焦递进去,而
     * `app.evaluate` 一个来回本身就要几十毫秒,先探后进就会把这一条变成一场赛跑
     * (第一版实测:进带 100ms + 探路 80ms = 180ms,blur 恰好晚一步,门当场假红)。
     *
     * 真机 `BrowserWindow.blur()` 在没有前台窗口的环境里可能一发 blur 都发不出来
     * (跑在后台的 CI / 本机没把这扇窗调到前台),那时用合成事件 —— 判的是同一件事
     * (宿主监听的就是 window 上那个 blur),走的哪条路照实记进读数。
     */
    await park(cdp, viewport)
    await resetProbe(page)
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) win.blur()
    })
    await delay(120)
    const blurPath = (await probe(page)).blurs > 0 ? 'real' : 'synthetic'
    readings.blurPath = blurPath
    const fireBlur = () =>
      blurPath === 'real'
        ? app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0]
            if (win) {
              win.focus()
              win.blur()
            }
          })
        : page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await delay(BETWEEN_MS)
    await resetProbe(page)
    const blurT0 = Date.now()
    await move(cdp, bandX, bandY)
    await delay(BLUR_HOLD_MS)
    await fireBlur()
    const blurAtMs = Date.now() - blurT0
    readings.blurAtMs = blurAtMs
    await delay(DWELL_MS * 3)
    const blurred = await probe(page)
    readings.blurWakes = blurred.wakes
    console.log(`  进带后第 ${blurAtMs}ms 失焦(${blurPath}),再等 ${DWELL_MS * 3}ms → 唤醒 ${blurred.wakes} 次`)
    check(
      blurAtMs < DWELL_MS,
      `③ 前置条件:失焦必须赶在门槛之前递到(实测第 ${blurAtMs}ms,门槛 ${DWELL_MS}ms)`,
    )
    check(
      blurred.wakes === 0 && blurred.shown === false,
      `③ 停在带内但失焦不唤醒(实测 wakes=${blurred.wakes},blur 路径 ${blurPath})`,
    )

    console.log(`\n[8/9] ④ 只停 ${SHORT_HOLD_MS}ms(< 门槛 ${DWELL_MS}ms)就离开 → 不唤醒`)
    await park(cdp, viewport)
    await delay(BETWEEN_MS)
    await resetProbe(page)
    await move(cdp, bandX, bandY)
    await delay(SHORT_HOLD_MS)
    await move(cdp, bandX, Math.round(viewport[1] / 2))
    await delay(DWELL_MS * 3)
    const shortHold = await probe(page)
    readings.shortHoldWakes = shortHold.wakes
    console.log(`  停 ${SHORT_HOLD_MS}ms 即离开 → 唤醒 ${shortHold.wakes} 次`)
    check(shortHold.wakes === 0, `④ 短停不唤醒(实测 ${shortHold.wakes} 次)`)

    console.log('\n[9/9] ⑦ 拖着一块瓦停在带内 → 不唤醒;松手之后同一点照旧出来(09-13)')
    /*
     * 报障(09-13):「拖拽 tab 的时候,拖到底部会让 dock 出来,影响拖拽」。Dock 自述
     * 一律不收落点,所以一场拖拽里指针停在带内不可能是在叫它 —— 唤醒那一跳在拖拽期间
     * 整个关掉(纯函数 shouldShowDock 的 `dragging` 入参 + 宿主 onMove 拖着就不起表)。
     *
     * 拖的是 Dock 自己的一块瓦(每块内容瓦都是拖拽来源,不必先摆一格 tab):先把 Dock
     * 叫出来 → 在瓦上按下 → 抬 80px 越过起拖阈值(根上 `data-drag-active` 为真是
     * **前提**,不是断言对象:没起拖,这一步量的就不是拖拽)→ 指针离开留驻区 Dock 收回
     * → 再拖回带内,按 stroke 的手法 1px 横向微动着停 3 个门槛 → 唤醒 0 次。
     * 松手之后指针还在带内:下一发 move 起表、停够就出来 —— 拖拽只关唤醒,不留后遗症。
     */
    await park(cdp, viewport)
    await delay(BETWEEN_MS)
    await move(cdp, bandX, bandY)
    await delay(DWELL_HOLD_MS)
    const preDrag = await probe(page)
    check(preDrag.shown === true, `⑦ 前提:Dock 先叫出来(实测 shown=${preDrag.shown})`)
    const tiles = await page.evaluate(() =>
      [...document.querySelectorAll('[data-dock="strip"] [data-dock-tile] button')].map((el) => {
        const b = el.getBoundingClientRect()
        return {
          x: Math.round(b.left + b.width / 2),
          y: Math.round(b.top + b.height / 2),
          label: el.getAttribute('aria-label'),
        }
      }),
    )
    check(tiles.length > 0, `⑦ 前提:Dock 上有瓦(实测 ${tiles.length} 块)`)
    const pressed = (type, x, y) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button: 'left',
        buttons: 1,
        clickCount: 1,
      })
    /*
     * 不是每块瓦都拖得起来:启动瓦拖出去的是它指向的东西(「目录」瓦 = 当前会话的
     * 工作目录),而这台临时 store 里没有会话,它的 `dragRef()` 答 null、`onStart`
     * 当场作废。所以逐块试,谁真的起了拖(根上 `data-drag-active`)就用谁 ——
     * 这是**前提**,不是断言对象;一块都起不来才是红。
     */
    let tile = null
    for (const candidate of tiles) {
      if (!preDrag.shown) break
      await move(cdp, candidate.x, candidate.y)
      await delay(FRAME_MS * 2)
      await pressed('mousePressed', candidate.x, candidate.y)
      // 抬 80px:越过起拖阈值,也离开留驻区(24 余量)。
      for (let i = 1; i <= 10; i += 1) {
        await pressed('mouseMoved', candidate.x, candidate.y - 8 * i)
        await delay(FRAME_MS)
      }
      const started = await page.evaluate(() => document.documentElement.hasAttribute('data-drag-active'))
      if (started) {
        tile = candidate
        break
      }
      await pressed('mouseReleased', candidate.x, candidate.y - 80)
      await delay(FRAME_MS * 4)
    }
    readings.dragTile = tile?.label ?? null
    check(Boolean(tile), `⑦ 前提:有一块瓦真的起拖了(${tile ? JSON.stringify(tile) : `试了 ${tiles.length} 块都没起`})`)
    if (preDrag.shown && tile) {
      await delay(HIDE_DELAY_MS + 400)
      const hidAfterLift = await probe(page)
      check(hidAfterLift.shown === false, `⑦ 前提:拖着抬走之后 Dock 已按留驻语义收回(shown=${hidAfterLift.shown})`)
      await resetProbe(page)
      // 拖回带内:一路划下去,然后横向 1px 微动着停 3 个门槛(与 stroke 同一手法:一直在动)。
      for (let y = tile.y - 80; y <= bandY; y += CROSS_STEP_PX) {
        await pressed('mouseMoved', bandX, Math.min(y, bandY))
        await delay(FRAME_MS)
      }
      const dragDeadline = Date.now() + DWELL_MS * 3
      let flip = 0
      while (Date.now() < dragDeadline) {
        flip = 1 - flip
        await pressed('mouseMoved', bandX + flip, bandY)
        await delay(FRAME_MS)
      }
      const dragged = await probe(page)
      readings.dragWakes = dragged.wakes
      console.log(`  拖着停在带内 ${DWELL_MS * 3}ms → 唤醒 ${dragged.wakes} 次,shown=${dragged.shown}`)
      check(
        dragged.wakes === 0 && dragged.shown === false,
        `⑦ 拖着东西停在带内不唤醒(实测 wakes=${dragged.wakes} shown=${dragged.shown})`,
      )
      await pressed('mouseReleased', bandX, bandY)
      await delay(FRAME_MS * 4)
      await resetProbe(page)
      await move(cdp, bandX + 1, bandY)
      await delay(DWELL_HOLD_MS)
      const afterDrop = await probe(page)
      readings.afterDropWakes = afterDrop.wakes
      console.log(`  松手后再动一下停 ${DWELL_HOLD_MS}ms → 唤醒 ${afterDrop.wakes} 次,shown=${afterDrop.shown}`)
      check(
        afterDrop.shown === true && afterDrop.wakes === 1,
        `⑦ 松手之后同一点照旧出来(实测 wakes=${afterDrop.wakes} shown=${afterDrop.shown})`,
      )
    }

    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }

  if (outDir) writeFileSync(path.join(outDir, 'dock-wake-readings.json'), JSON.stringify(readings, null, 2))
  console.log(`\n[dock-wake-gate] 读数:${JSON.stringify(readings)}`)
  if (failures.length) {
    console.error(`\n[dock-wake-gate] FAILED(${failures.length} 条):\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[dock-wake-gate] ok —— 穿过不算数 / 停留算数 / 失焦取消 / 短停不算 / 留驻不回退 / 出窗收回 / 拖着不唤醒')
}

main().catch((error) => {
  console.error('\n[dock-wake-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
