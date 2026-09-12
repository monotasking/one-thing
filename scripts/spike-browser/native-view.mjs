/**
 * B0 spike ② —— `WebContentsView` 在拼贴树里可不可行,每一条都要读数(方案 §4 B0 行 + §9.3)
 *
 * **只量不改**:一行产品代码都不碰。窗子 `show: false` 起(离屏档,与 `ONETHING_GATE_HEADLESS`
 * 同一手);`--offscreen` 会改用 `showInactive()` 并把窗子挪到屏外坐标(两档读数都要,因为
 * 「隐藏窗能不能截图」正是其中一项)。不连 5175、不碰 `~/.onething`、`--user-data-dir` 每次临时。
 *
 * 跑法(从仓根):
 *   ./node_modules/.bin/electron scripts/spike-browser/native-view.mjs \
 *      --user-data-dir=<临时> --remote-debugging-port=<随机> [--offscreen] [--throttle-seconds=30]
 *   结论一行 JSON 打在 stdout:`SPIKE2_JSON=…`;过程逐条打 `[spike2] …`。
 *
 * 八项(对应派工单):
 *   ① bounds 跟随延迟(20 次拖动模拟的 p50 / p95)
 *   ② 遮挡快照:盖上 → 图换上的毫秒;以及 `setVisible(false)` 之后还截不截得到(§9-7 的断言)
 *   ③ 隐藏视图被不被节流(16ms 心跳在藏了 N 秒里的间隔分布)
 *   ④ 焦点:`WebContentsView` 的 webContents 触不触发 focus/blur;主进程 `focus()` 搬不搬得进去
 *   ⑤ `before-input-event`:对 ⌘K `preventDefault` 挡不挡得住页面;⌘B 放行页面收不收得到
 *   ⑥ chrome-devtools-mcp 视角:puppeteer `targets()` / `pages()` / `newPage()`;MCP `list_pages`
 *   ⑦ z 序:`addChildView` 次序 + 后调 `addChildView(existing)` 能不能提到顶
 *   ⑧ DIP:`setBounds` 的数与 `getBoundingClientRect` 在 2x 屏上对不对得上
 */
import { app, BrowserWindow, WebContentsView, ipcMain, screen, nativeImage } from 'electron'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const argv = process.argv.slice(1)
const flag = (n) => argv.includes(`--${n}`)
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}

const OFFSCREEN = flag('offscreen')
const THROTTLE_SECONDS = Number(arg('throttle-seconds', '30'))
const CDP_PORT = Number(arg('remote-debugging-port', '0')) || null
const PUPPETEER = arg('puppeteer', '/Users/yitiansong/.npm/_npx/ab5cd9f6d13a2312/node_modules/puppeteer-core')
const MCP_NODE = arg('mcp-node', 'node')
/** 只跑其中几项(逗号分隔),便于单项复跑;不传 = 八项全跑 */
const ONLY = (arg('only', '') || '').split(',').filter(Boolean)

const report = {
  env: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    windowMode: OFFSCREEN ? 'offscreen-showInactive' : 'hidden-show:false',
    cdpPort: CDP_PORT,
  },
  items: {},
  errors: [],
}

const log = (...a) => console.log('[spike2]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (arr, p) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}


/** 按比例采样一张 nativeImage 的像素(fx / fy 是 0..1 的相对位置,自动处理 2x 位图) */
function samplePixel(img, fx, fy) {
  if (!img || img.isEmpty()) return { empty: true }
  const size = img.getSize()
  const bmp = img.toBitmap()
  // getSize() 在 mac 上给的就是物理像素;真实行数由 buffer 长度反推,避免猜错
  const rowPx = Math.round(bmp.length / 4 / size.height)
  const x = Math.min(rowPx - 1, Math.max(0, Math.round(fx * rowPx)))
  const y = Math.min(size.height - 1, Math.max(0, Math.round(fy * size.height)))
  const i = (y * rowPx + x) * 4
  return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2], a: bmp[i + 3], size, rowPx }
}

/** 主进程侧收到的每一帧 bounds(item ① 的账) */
const frames = []
let view = null
let view2 = null
let win = null
let snapshotHook = null

function onNvFrame(msg) {
  if (msg.kind === 'bounds') {
    if (!view) return
    const t0 = msg.tSet
    view.setBounds(msg.bounds)
    view.setVisible(msg.visible)
    frames.push({ t0, tApplied: Date.now(), bounds: msg.bounds, dpr: msg.dpr })
    return
  }
  if (msg.kind === 'occlude') {
    // §9-7:**先**截图再藏,截完把 dataURL 推回渲染进程
    void (async () => {
      const tOcclude = Date.now()
      let img = null
      try {
        img = await view.webContents.capturePage()
      } catch (err) {
        report.errors.push(`capturePage(visible): ${err?.message || err}`)
      }
      const tCaptured = Date.now()
      view.setVisible(false)
      const tHidden = Date.now()
      const dataUrl = img && !img.isEmpty() ? img.toDataURL() : ''
      win.webContents.send('nv-host', { kind: 'snapshot', viewId: msg.viewId, dataUrl })
      snapshotHook?.({ tOcclude, tCaptured, tHidden, empty: !dataUrl, size: img ? img.getSize() : null })
    })()
    return
  }
  if (msg.kind === 'reveal') {
    view.setVisible(true)
  }
}

async function evalShell(code) {
  return win.webContents.executeJavaScript(code, true)
}
async function evalView(code, target = view) {
  return target.webContents.executeJavaScript(code, true)
}

// ───────────────────────────────────────────────────────────────── ① bounds 跟随
async function itemBoundsLatency() {
  const lat = []
  const mismatch = []
  for (let i = 0; i < 20; i++) {
    const w = 420 + ((i * 37) % 380)
    const h = 260 + ((i * 23) % 240)
    const before = frames.length
    await evalShell(`window.__resizeSlot(${w}, ${h})`)
    // 等主进程这一侧收到那一帧
    const deadline = Date.now() + 1500
    while (frames.length === before && Date.now() < deadline) await sleep(2)
    const f = frames[frames.length - 1]
    if (!f || frames.length === before) { mismatch.push({ i, reason: 'no-frame' }); continue }
    lat.push(f.tApplied - f.t0)
    const got = view.getBounds()
    if (got.width !== f.bounds.width || got.height !== f.bounds.height) {
      mismatch.push({ i, want: f.bounds, got })
    }
    await sleep(30)
  }
  report.items.boundsLatency = {
    n: lat.length,
    p50: pct(lat, 0.5),
    p95: pct(lat, 0.95),
    min: Math.min(...lat),
    max: Math.max(...lat),
    all: lat,
    /** setBounds 落地后 getBounds 与目标不符的次数 —— 0 = 同步生效 */
    mismatches: mismatch,
  }
  log('① bounds latency', JSON.stringify(report.items.boundsLatency))
}

// ───────────────────────────────────────────────────────── ② 遮挡快照 + 藏后能不能截
async function itemOcclusionSnapshot() {
  const rounds = []
  for (let i = 0; i < 10; i++) {
    let hookInfo = null
    const done = new Promise((resolve) => { snapshotHook = (x) => { hookInfo = x; resolve() } })
    const tOcclude = await evalShell('window.__occlude()')
    await done
    snapshotHook = null
    // 等渲染进程报「图真的画上了」
    let shown = 0
    const deadline = Date.now() + 3000
    while (!shown && Date.now() < deadline) {
      shown = await evalShell('window.__snapshotShownAt()')
      if (!shown) await sleep(4)
    }
    rounds.push({
      captureMs: hookInfo ? hookInfo.tCaptured - hookInfo.tOcclude : null,
      hideMs: hookInfo ? hookInfo.tHidden - hookInfo.tOcclude : null,
      shownMs: shown ? shown - tOcclude : null,
      empty: hookInfo?.empty ?? null,
      size: hookInfo?.size ?? null,
    })
    await evalShell('window.__unocclude()')
    await sleep(120)
  }
  const shownMs = rounds.map((r) => r.shownMs).filter((x) => typeof x === 'number')
  const captureMs = rounds.map((r) => r.captureMs).filter((x) => typeof x === 'number')

  // §9-7 的断言:藏了以后还截不截得到
  view.setVisible(false)
  await sleep(200)
  let hiddenCapture = null
  try {
    const img = await Promise.race([
      view.webContents.capturePage(),
      sleep(4000).then(() => 'TIMEOUT'),
    ])
    hiddenCapture = img === 'TIMEOUT'
      ? { ok: false, reason: 'timeout-4s' }
      : { ok: !img.isEmpty(), empty: img.isEmpty(), size: img.getSize() }
  } catch (err) {
    hiddenCapture = { ok: false, reason: String(err?.message || err) }
  }
  // 藏着的时候把页面底色改成绿 —— 再截一次:还是红 = 截到的是藏之前的旧表面(陈的),
  // 变绿 = 隐藏视图仍在真渲染,截图是活的。这一格决定「遮挡期间要不要刷新快照」。
  let hiddenCaptureIsLive = null
  if (hiddenCapture?.ok) {
    try {
      await evalView("document.body.style.background = 'rgb(0,200,0)'")
      await sleep(500)
      const img2 = await view.webContents.capturePage()
      hiddenCaptureIsLive = samplePixel(img2, 0.5, 0.5)
      await evalView("document.body.style.background = 'rgb(255,0,0)'")
      await sleep(300)
    } catch (err) {
      hiddenCaptureIsLive = { error: String(err?.message || err) }
    }
  }

  view.setVisible(true)
  await sleep(120)

  report.items.occlusion = {
    rounds,
    /** 藏着时改了底色再截:g 高 r 低 = 活的;r 高 = 陈的旧表面 */
    hiddenCaptureCenterPixelAfterRepaint: hiddenCaptureIsLive,
    occludeToSnapshotShownMs: { p50: pct(shownMs, 0.5), p95: pct(shownMs, 0.95), max: Math.max(...shownMs) },
    capturePageMs: { p50: pct(captureMs, 0.5), p95: pct(captureMs, 0.95) },
    anyEmpty: rounds.some((r) => r.empty),
    captureAfterSetVisibleFalse: hiddenCapture,
  }
  log('② occlusion', JSON.stringify(report.items.occlusion.occludeToSnapshotShownMs), 'hiddenCapture', JSON.stringify(hiddenCapture))
}

// ──────────────────────────────────────────────────────────── ③ 隐藏视图被不被节流
async function itemThrottle() {
  const warmFrom = Date.now()
  await sleep(3000)
  const warmTo = Date.now()
  const visibleStats = await evalView(`window.__tickStats(${warmFrom}, ${warmTo})`)
  const visibleDoc = await evalView('({visibility: document.visibilityState, hidden: document.hidden})')

  view.setVisible(false)
  const hidFrom = Date.now()
  await sleep(THROTTLE_SECONDS * 1000)
  const hidTo = Date.now()
  const hiddenStats = await evalView(`window.__tickStats(${hidFrom}, ${hidTo})`)
  const hiddenDoc = await evalView('({visibility: document.visibilityState, hidden: document.hidden})')

  view.setVisible(true)
  await sleep(2500)
  const backStats = await evalView(`window.__tickStats(${Date.now() - 2000}, ${Date.now()})`)

  report.items.throttle = {
    windowIsVisible: win.isVisible(),
    visibleStats, visibleDoc, hiddenStats, hiddenDoc, afterRevealStats: backStats,
    hiddenSeconds: THROTTLE_SECONDS,
  }
  log('③ throttle win.isVisible=' + win.isVisible(), 'visible', JSON.stringify(visibleStats), JSON.stringify(visibleDoc), 'hidden', JSON.stringify(hiddenStats), JSON.stringify(hiddenDoc), 'back', JSON.stringify(backStats))
}

// ────────────────────────────────────────────────────────────────────── ④ 焦点
async function itemFocus() {
  const events = []
  view.webContents.on('focus', () => events.push({ e: 'focus', t: Date.now() }))
  view.webContents.on('blur', () => events.push({ e: 'blur', t: Date.now() }))

  const b = view.getBounds()
  const before = {
    windowIsVisible: win.isVisible(),
    shellHasFocus: await evalShell('window.__hasFocus()'),
    viewHasFocus: await evalView('document.hasFocus()'),
    winFocused: win.isFocused(),
    viewIsFocused: view.webContents.isFocused(),
  }

  // 点进视图(主进程合成的输入事件,不动真鼠标)
  const cx = Math.round(b.width / 2)
  const cy = Math.round(b.height / 2)
  for (const type of ['mouseDown', 'mouseUp']) {
    view.webContents.sendInputEvent({ type, x: cx, y: cy, button: 'left', clickCount: 1 })
  }
  await sleep(400)
  const afterSendInputEvent = {
    events: events.slice(),
    viewHasFocus: await evalView('document.hasFocus()'),
  }

  // 换一条路:CDP `Input.dispatchMouseEvent`(chrome-mcp 走的也是这条)
  events.length = 0
  let cdpClick = null
  try {
    const dbg = view.webContents.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    for (const type of ['mousePressed', 'mouseReleased']) {
      await dbg.sendCommand('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    }
    await sleep(400)
    cdpClick = { events: events.slice(), viewHasFocus: await evalView('document.hasFocus()') }
    dbg.detach()
  } catch (err) {
    cdpClick = { error: String(err?.message || err) }
  }
  const afterClickIntoView = {
    viaSendInputEvent: afterSendInputEvent,
    viaCdpDispatchMouseEvent: cdpClick,
    events: events.slice(),
    viewHasFocus: await evalView('document.hasFocus()'),
    shellHasFocus: await evalShell('window.__hasFocus()'),
    viewIsFocused: view.webContents.isFocused(),
  }

  // 主进程主动把焦点搬进视图
  events.length = 0
  win.webContents.focus()
  await sleep(250)
  view.webContents.focus()
  await sleep(400)
  const afterMainFocusCall = {
    events: events.slice(),
    viewHasFocus: await evalView('document.hasFocus()'),
    shellHasFocus: await evalShell('window.__hasFocus()'),
    viewIsFocused: view.webContents.isFocused(),
  }

  // 反向:把焦点搬回壳
  events.length = 0
  win.webContents.focus()
  await sleep(400)
  const afterShellFocusCall = {
    events: events.slice(),
    viewHasFocus: await evalView('document.hasFocus()'),
    shellHasFocus: await evalShell('window.__hasFocus()'),
    viewIsFocused: view.webContents.isFocused(),
  }

  report.items.focus = { before, afterClickIntoView, afterMainFocusCall, afterShellFocusCall }
  log('④ focus', JSON.stringify(report.items.focus))
}

// ──────────────────────────────────────────────────── ⑤ before-input-event 挡不挡得住
async function itemBeforeInput() {
  const seen = []
  const blocked = []
  const handler = (event, input) => {
    if (input.type !== 'keyDown') return
    const combo = `${input.meta ? 'meta+' : ''}${input.control ? 'ctrl+' : ''}${input.key}`
    seen.push(combo)
    // 名单里只有 ⌘K
    if (input.meta && String(input.key).toLowerCase() === 'k') {
      event.preventDefault()
      blocked.push(combo)
      win.webContents.send('nv-host', { kind: 'key', combo })
    }
  }
  view.webContents.on('before-input-event', handler)

  await evalView('window.__keys.length = 0')
  view.webContents.focus()
  await sleep(200)

  const press = (keyCode, modifiers) => {
    for (const type of ['keyDown', 'char', 'keyUp']) {
      if (type === 'char' && modifiers.includes('meta')) continue
      view.webContents.sendInputEvent({ type, keyCode, modifiers })
    }
  }
  press('k', ['meta'])
  await sleep(250)
  press('b', ['meta'])
  await sleep(250)
  press('j', [])
  await sleep(250)

  const pageKeys = await evalView('window.__keys.slice()')
  const shellKeys = await evalShell('(window.__keysFromHost || []).slice()')
  view.webContents.off('before-input-event', handler)

  report.items.beforeInput = {
    beforeInputSaw: seen,
    preventedInHandler: blocked,
    pageReceivedKeydown: pageKeys,
    pushedBackToShell: shellKeys,
    metaKBlockedFromPage: !pageKeys.some((k) => k === 'meta+k' || k === 'meta+K'),
    metaBPassedToPage: pageKeys.some((k) => k === 'meta+b' || k === 'meta+B'),
  }
  log('⑤ before-input-event', JSON.stringify(report.items.beforeInput))
}

// ──────────────────────────────────────────── ⑥ chrome-devtools-mcp / puppeteer 视角
async function itemCdpView() {
  if (!CDP_PORT) { report.items.cdp = { skipped: 'no --remote-debugging-port' }; return }
  const out = { browserURL: `http://127.0.0.1:${CDP_PORT}` }
  try {
    const { connect } = require(path.join(PUPPETEER, 'lib/cjs/puppeteer/puppeteer-core.js'))
    const browser = await connect({ browserURL: out.browserURL })
    out.puppeteerVersion = require(path.join(PUPPETEER, 'package.json')).version
    out.targets = (await browser.targets()).map((t) => ({ type: t.type(), url: String(t.url()).slice(0, 90) }))
    const pages = await browser.pages()
    out.pages = []
    for (const p of pages) {
      let title = null
      try { title = await p.title() } catch (e) { title = `ERR ${e?.message}` }
      out.pages.push({ url: String(p.url()).slice(0, 90), title })
    }

    // newPage 在 Electron 上开出什么?
    const created = []
    const onCreated = (_e, wc) => created.push({ type: wc.getType(), url: wc.getURL() })
    app.on('web-contents-created', onCreated)
    try {
      const np = await Promise.race([browser.newPage(), sleep(8000).then(() => 'TIMEOUT')])
      if (np === 'TIMEOUT') out.newPage = { ok: false, reason: 'timeout-8s' }
      else {
        await sleep(500)
        out.newPage = { ok: true, url: np.url(), targetType: np.target().type() }
        out.newPage.mainProcessSawWebContentsCreated = created.slice()
        out.newPage.windowCountAfter = BrowserWindow.getAllWindows().length
        try { await np.close() } catch (e) { out.newPage.closeError = String(e?.message || e) }
      }
    } catch (err) {
      out.newPage = { ok: false, reason: String(err?.message || err) }
      out.newPage.mainProcessSawWebContentsCreated = created.slice()
    }
    app.off('web-contents-created', onCreated)
    await browser.disconnect()
  } catch (err) {
    out.puppeteerError = String(err?.stack || err).split('\n').slice(0, 4).join(' | ')
  }

  // chrome-devtools-mcp,手写 JSON-RPC over stdio
  out.mcp = await runMcpListPages(out.browserURL)
  report.items.cdp = out
  log('⑥ cdp', JSON.stringify({ targets: out.targets, pages: out.pages, newPage: out.newPage, mcp: out.mcp }))
}

function runMcpListPages(browserURL) {
  // 用**独立的纯 node 进程**跑 chrome-devtools-mcp(它自己也是 node ESM 包),
  // 而不是在 Electron 主进程里内联 —— 免得 Electron 的 node 环境污染结论。
  return new Promise((resolve) => {
    const script = path.join(here, 'mcp-list-pages.mjs')
    const child = spawn(MCP_NODE, [script, `--browserUrl=${browserURL}`, '--tools'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; resolve({ error: 'outer-timeout-45s', stderr: err.slice(-400) }) }, 45000)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: `spawn ${MCP_NODE}: ${e.message}` }) })
    child.on('exit', () => {
      clearTimeout(timer)
      const line = out.split('\n').find((l) => l.startsWith('MCP_JSON='))
      if (!line) return resolve({ error: 'no MCP_JSON line', stdoutTail: out.slice(-400), stderrTail: err.slice(-400) })
      try { resolve(JSON.parse(line.slice('MCP_JSON='.length))) } catch (e) { resolve({ error: String(e.message), raw: line.slice(0, 400) }) }
    })
  })
}

// ───────────────────────────────────────────────────────────────────────── ⑦ z 序
async function itemZOrder() {
  view2 = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, partition: 'spike-view' } })
  await view2.webContents.loadURL('data:text/html,<body style="margin:0;background:rgb(0,0,255)">B</body>')
  const b = view.getBounds()
  // 与第一格重叠一半
  view2.setBounds({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2), width: 260, height: 180 })
  win.contentView.addChildView(view2)
  await sleep(250)

  const ids = () => win.contentView.children.map((c) => (c === view ? 'v1' : c === view2 ? 'v2' : 'other'))
  const afterAdd = ids()

  // 后调 addChildView(existing) 能不能把 v1 提到顶
  win.contentView.addChildView(view)
  await sleep(250)
  const afterReAddV1 = ids()

  // 也验一下显式 index
  win.contentView.addChildView(view2, 0)
  await sleep(200)
  const afterIndex0V2 = ids()

  report.items.zOrder = {
    afterAdd,
    afterReAddV1,
    afterIndex0V2,
    reAddRaises: afterReAddV1[afterReAddV1.length - 1] === 'v1',
    indexArgWorks: afterIndex0V2[0] === 'v2',
  }
  log('⑦ zOrder', JSON.stringify(report.items.zOrder))
}

// ───────────────────────────────────────────────────────────────────── ⑧ DIP 对齐
async function itemDip() {
  const display = screen.getPrimaryDisplay()
  await evalShell('window.__resizeSlot(520, 340)')
  await sleep(300)
  const rect = await evalShell('window.__slotRect()')
  const bounds = view.getBounds()
  const probe = await evalView('window.__probe()')

  // 截窗页(不是视图页),看原生视图有没有被合成进去
  let windowCapture = null
  try {
    const img = await win.webContents.capturePage()
    const content = win.getContentBounds()
    const fx = (bounds.x + bounds.width / 2) / content.width
    const fy = (bounds.y + bounds.height / 2) / content.height
    windowCapture = {
      size: img.getSize(),
      empty: img.isEmpty(),
      contentBounds: content,
      pixelAtSlotCenter: samplePixel(img, fx, fy),
      pixelOutsideSlot: samplePixel(img, 0.01, 0.01),
    }
    const c = windowCapture.pixelAtSlotCenter
    // 视图页是纯红底;窗页占位格是 #1d2026
    windowCapture.nativeViewCompositedIntoWindowCapture = !!c && c.r > 200 && c.g < 60 && c.b < 60
  } catch (err) {
    windowCapture = { error: String(err?.message || err) }
  }

  // 对照:直接截视图自己的 webContents —— 它一定是红的
  let viewCapture = null
  try {
    viewCapture = samplePixel(await view.webContents.capturePage(), 0.5, 0.5)
  } catch (err) {
    viewCapture = { error: String(err?.message || err) }
  }

  report.items.dip = {
    displayScaleFactor: display.scaleFactor,
    shellRectCssPx: rect,
    viewGetBoundsDip: bounds,
    viewInnerSize: { w: probe.innerWidth, h: probe.innerHeight, dpr: probe.dpr },
    matchesCssPx: probe.innerWidth === Math.round(rect.width) && probe.innerHeight === Math.round(rect.height),
    windowCapture,
    viewOwnCaptureCenterPixel: viewCapture,
  }
  log('⑧ dip', JSON.stringify(report.items.dip))
}

// ────────────────────────────────────────────────────────────────────────── 主流程
app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    backgroundColor: '#14161a',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  if (OFFSCREEN) {
    // 屏外坐标 + showInactive:不抢前台、不进焦点
    win.setPosition(-4000, -4000)
    win.showInactive()
    report.env.positionAfterShow = win.getPosition()
  }

  ipcMain.on('nv', (_e, msg) => onNvFrame(msg))

  view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, partition: 'spike-view' } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 40, y: 60, width: 600, height: 400 })
  await view.webContents.loadFile(path.join(here, 'view-page.html'))
  await win.loadFile(path.join(here, 'shell.html'))
  await sleep(800)

  const steps = [
    ['boundsLatency', itemBoundsLatency],
    ['occlusion', itemOcclusionSnapshot],
    ['focus', itemFocus],
    ['beforeInput', itemBeforeInput],
    ['zOrder', itemZOrder],
    ['dip', itemDip],
    ['cdp', itemCdpView],
    ['throttle', itemThrottle],
  ]
  for (const [name, fn] of steps) {
    if (ONLY.length && !ONLY.includes(name)) continue
    try {
      await fn()
    } catch (err) {
      report.errors.push(`${name}: ${String(err?.stack || err).split('\n').slice(0, 3).join(' | ')}`)
      log('!! step failed', name, err?.message)
    }
  }

  console.log('SPIKE2_JSON=' + JSON.stringify(report))
  // 收尸:视图先摘再退
  try { win.contentView.removeChildView(view) } catch {}
  try { if (view2) win.contentView.removeChildView(view2) } catch {}
  try { view.webContents.close() } catch {}
  try { view2?.webContents.close() } catch {}
  app.quit()
})

app.on('window-all-closed', () => app.quit())
process.on('uncaughtException', (err) => {
  console.log('SPIKE2_FATAL=' + String(err?.stack || err))
  app.quit()
})
