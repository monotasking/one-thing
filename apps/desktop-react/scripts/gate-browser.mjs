#!/usr/bin/env node
/**
 * **内嵌浏览器的真机门**(B2,方案 `apps/desktop-react/docs/terminal-browser-2026-09.md` §4)。
 *
 * ── 它与别的门起法不一样的两处,而两处都是 B0 量出来的 ────────────────────
 *
 * ①**壳自己装配 core**(与 `gate:terminal` 同一条):`browser:` 是主进程 in-process
 *   挂的资源(§2.2-3),独立 `dist/server/main.js` 里根本没有它 —— 连上去量的会是
 *   「server 没有浏览器」这件废话。所以走 `gate-connect` 路径一,发现文件 owner=`shell`。
 *
 * ②**窗子走 `ONETHING_GATE_OFFSCREEN` 而不是 `ONETHING_GATE_HEADLESS`**。B0-④ 实测:
 *   `show:false` 的窗整扇被 Chromium 当隐藏,合成器按 **1Hz** 节流(藏后心跳中位
 *   1000ms)。这道门要量的每一件事都与「页面上的时间」有关(一页加载完没有、标题
 *   落下来没有、遮挡快照换上来没有),在 1Hz 下量到的是节流后的数。所以主进程多了
 *   一档(与 `HEADLESS` 一起传):`showInactive()` + 屏外坐标 —— **在合成、看不见、
 *   不抢焦点**(macOS 会把 y 钳进可见区,x 不钳;判词在 `electron/main.ts` 的
 *   `GATE_OFFSCREEN` 上)。
 *
 * ── 十条断言 ──────────────────────────────────────────────────────────────
 *  ① `resources.list` / `resources.describe` 列得出 `browser`(mount 那一行真的跑了);
 *  ② 点 Dock 那块浏览器瓦 → 一片 `browser:` 叶出现,地址栏拿到焦点;
 *  ③ 地址栏输入本地 URL + 回车 → **活标题**落成 `ONETHING_B2_<nonce>`(读叶檐);
 *  ④ 经 `POST /api/rpc resources.do {op:'open'}`(= AI 那条路)→ 第二格出现且标题落;
 *  ⑤ `resources.read(browser:<id>, 'page')` 的正文含页面里的标记,**且带 untrusted 定界**;
 *  ⑥ 撕一块别的瓦成浮窗拖到浏览器上方 → 占位格 200ms 内出现 `<img>` 快照;拖走 → 视图回来。
 *     **两个判据两张图**(B0 新洞:`win.capturePage()` 不含原生视图)——「画面对不对」
 *     截视图自己的 webContents,「占位格换没换图」截窗页,像素留容差(`capturePage`
 *     走了色彩变换,255,0,0 → 234,51,35);
 *  ⑦ 页面有焦点时(经 `focus` 动词把键盘交给页面)打 ⌘K/⌘P → 命令面板开(键位下沉);
 *     ⌘L → 地址栏聚焦;
 *  ⑧ `run/http.json` 有 `cdp.port`,而且那个口的 `/json/list` 里有 `type:'page'` 的
 *     tab 页、标题对得上(chrome-devtools-mcp 的 `browser.pages()` 读的就是这张表);
 *  ⑨ 关标签 → `read tabs` 里没有它了;
 *  ⑩ **超量**:8 格 tab 全开,逐格切换,打表 ≥50ms 的长帧数与最长一帧;
 *  ⑪ **axe 扫这一屏**(与 `gate:a11y` 同一套标签、同一个 legacy 模式)。
 *
 * ── ⑪ 为什么长在这道门上,而不是 `gate:a11y` 的第 N 屏 ────────────────────
 * 与 `gate:terminal` ⑧ 逐字同一个理由,只是主语换了:`gate-a11y` 先起一台
 * `dist/server/main.js`,壳去连它 —— 而 `browser:` 是**壳自己那台 core** 在主进程里
 * in-process 挂的(§2.2-3),独立 server 里根本没有它。那一屏永远等不到叶。
 * 搬到这里之后扫的是**同一套规则、同一块真面**,而且是一块真的连着 Chromium 在跑的
 * 浏览器。要让那道门也照得到,前置是它改成「壳自当 core」那条起法 —— 留账。
 *
 * ── ⑧ 为什么不是 puppeteer-core ─────────────────────────────────────────────
 * 这个仓里没有 `puppeteer-core`(playwright 是它的门用的那一只)。为一条断言装一个
 * 包不值得,而 `browser.pages()` 底下读的**就是** `/json/list`:一条 HTTP 请求 +
 * 一句 `type === 'page'` 的判据,量的是同一件事,而且零依赖。B0-③ 已经用真的
 * chrome-devtools-mcp 1.9.0 跑过一遍(读数在方案 §9.4),这道门守的是「那条路别塌」。
 *
 * ── 纪律(照 gate-terminal / gate-music)────────────────────────────────────
 * 临时 store + 独立 `--user-data-dir` + 屏外窗 + 只用 CDP(`Input.dispatchKeyEvent`,
 * 不动真光标),不连 5175,`~/.onething` 零改动,`finally` 里逐个收尸。
 * **产品的 CDP 口与门自己的 CDP 分开**(B0-③):产品那一口由门写进 `run/cdp.json`,
 * 取一个高位随机端口;门驱动壳走的是 playwright 自己那条 inspector,两者不打架。
 *
 * 跑法:`npm run gate:browser`(先 `npm run app:build`)。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/** ③④ 的标记。**分两段拼**,免得脚本自己这一行被当成页面正文找到。 */
const NONCE = `ONETHING_B2_${Math.random().toString(36).slice(2, 8)}`
/** ⑤ 只在正文里出现的那一句。 */
const BODY_MARK = `PAGE${'BODY'}_${NONCE}`

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
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

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}

async function api(record, route, init) {
  const response = await fetch(`http://${record.host}:${record.port}${route}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) throw new Error(`${route} HTTP ${response.status}`)
  return response.json()
}

/** 一发 RPC,**把信封拆开**(`{ok, data}` 是 `RpcResponse`,里面那层才是域的回答)。 */
async function rpc(record, domain, method, payload = {}) {
  const envelope = await api(record, '/api/rpc', {
    method: 'POST',
    body: JSON.stringify({ domain, method, payload }),
  })
  if (envelope?.ok === false) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(envelope)}`)
  return envelope?.data ?? envelope
}

const ON_MAC = process.platform === 'darwin'
/** CDP 的 modifiers 位:2 = Ctrl,4 = Meta。主修饰键随平台(与 gate-terminal 同口径)。 */
const PRIMARY_MODIFIER = ON_MAC ? 4 : 2

/** CDP 的 modifiers 位:1 = Alt,2 = Ctrl,4 = Meta,8 = Shift。 */
const SHIFT_MODIFIER = 8

async function press(cdp, { key, code, keyCode, text, primary = false, shift = false }) {
  const modifiers = (primary ? PRIMARY_MODIFIER : 0) | (shift ? SHIFT_MODIFIER : 0)
  await cdp.send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
    ...(text ? { text } : {}),
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
  })
}

/** 门自己那台 http 页服务器:标题就是断言(③④)。 */
function startPageServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const which = (req.url ?? '/').replace(/[^a-z0-9/]/gi, '')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>${NONCE}${which === '/' ? '' : which}</title></head>`
          + `<body style="background:#0a0">${BODY_MARK}</body></html>`,
      )
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** 屏幕上此刻那几片浏览器叶(门用的把手:`data-native-view` 就是 tab id)。 */
const leafIds = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-native-view]')].map((el) => el.dataset.nativeView),
  )

async function main() {
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[browser-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'browser-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'browser-gate-userdata-'))
  /** 产品那一口 CDP。与门自己驱动壳用的那条分开(B0-③)。 */
  const productCdpPort = 19_000 + Math.floor(Math.random() * 900)
  let app
  let child
  let pages
  const report = {}
  try {
    await mkdir(path.join(store, 'run'), { recursive: true, mode: 0o700 })
    pages = await startPageServer()
    const pageUrl = (p = '/') => `http://127.0.0.1:${pages.port}${p}`

    console.log('\n[1/10] 壳自己装配 core + 屏外窗(判词在文件头)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
        // 两个一起传:`HEADLESS` 管「别自己 show」,`OFFSCREEN` 管「摆到屏外、
        // 不抢焦点地 showInactive」。判词在 `electron/main.ts` 的 `GATE_OFFSCREEN` 上。
        ONETHING_GATE_HEADLESS: '1',
        ONETHING_GATE_OFFSCREEN: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })

    const record = await waitFor('壳内嵌的 core 写出发现文件', () => {
      const found = readJson(path.join(store, 'run', 'http.json'))
      return found && found.owner === 'shell' ? found : undefined
    })
    assert(await portConnects(record.host, record.port), `core 端口 ${record.port} 可连`)

    const list = await rpc(record, 'resources', 'list', {})
    assert(
      (list.schemes ?? []).some((s) => s.scheme === 'browser'),
      `① resources.list 列出 browser(整表 ${(list.schemes ?? []).map((s) => s.scheme).join(',')})`,
    )
    const spec = await rpc(record, 'resources', 'describe', { scheme: 'browser' })
    assert(
      Object.keys(spec.reads ?? {}).sort().join(',') === 'page,screenshot,tabs',
      `① describe 的读法三条(${Object.keys(spec.reads ?? {}).sort().join(',')})`,
    )
    assert(
      (spec.ops?.navigate?.effects ?? []).includes('browser_navigate'),
      '① navigate 的效果类是 browser_navigate(拍点 ③ 那一档)',
    )
    assert(
      Object.keys(spec.ops ?? {}).sort().join(',') === 'activate,back,close,forward,navigate,open,reload',
      `① 做法七条(${Object.keys(spec.ops ?? {}).sort().join(',')})`,
    )

    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })

    /*
     * **等壳自己那条启动焦点链落定再点**(响应链规则 1:启动时第一响应者是主内容,
     * 有会话就是它的输入面板)。不等的话这一步会与它抢:点瓦那一下把焦点送进浏览器,
     * 紧接着启动链把它拽回输入面板 —— 门量到的是后者,而那是一次**竞速**不是回归。
     * 真人点 Dock 时壳早就站稳了,所以等它才是量对了东西。
     */
    await waitFor('壳的启动焦点链落定(焦点停在输入面板上)', () =>
      page.evaluate(() =>
        document.activeElement?.closest('[data-focus-scope="composer"]') ? true : undefined,
      ),
    )

    /*
     * **键位下沉那一半的取件口**:在主进程上挂一只**只读**的第二监听,把渲染层
     * 推下来的 `keymap` 全表收下来(`host:native-view` 那条通道的产品监听照旧在,
     * 这一只只旁听)。⑦ 据它断言「保留键表真的推下去了」——
     * 主进程截键那一半由 `keymap-bridge` 的单测与 B0-② 的真机读数钉。
     */
    await app.evaluate(({ ipcMain }) => {
      globalThis.__b2Keymap = []
      ipcMain.on('host:native-view', (_event, message) => {
        if (message && message.verb === 'keymap') globalThis.__b2Keymap.push(message.chords)
      })
    })

    await page.evaluate(() => {
      window.__b2Focus = []
      window.addEventListener(
        'focusin',
        (e) => {
          const el = e.target
          window.__b2Focus.push({
            t: Math.round(performance.now()),
            tag: el?.tagName ?? null,
            testId: el?.getAttribute?.('data-testid') ?? null,
            scope: el?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
          })
        },
        true,
      )
    })

    console.log('\n[2/10] 点 Dock 上那块浏览器瓦')
    const clicked = await page.evaluate(() => {
      const tile = document.querySelector('[data-testid="dock-tile-browser"]')
      if (!(tile instanceof HTMLElement)) return false
      tile.click()
      return true
    })
    assert(clicked, '② Dock 上找得到那块浏览器瓦并点了它')
    const first = await waitFor('第一片浏览器叶出现', async () => {
      const ids = await leafIds(page)
      return ids.length > 0 ? ids : undefined
    })
    assert(first.length === 1, `② 屏幕上一片浏览器叶(tab ${first[0]})`)
    const addressFocused = await waitFor('地址栏拿到焦点', () =>
      page.evaluate(() =>
        document.activeElement?.getAttribute('data-testid') === 'browser-address' ? true : undefined,
      ),
    ).catch(async (error) => {
      // 失败时把现场交出来:「焦点此刻在哪」是这一步唯一有用的读数。
      const where = await page.evaluate(() => ({
        tag: document.activeElement?.tagName ?? null,
        testId: document.activeElement?.getAttribute('data-testid') ?? null,
        scope: document.activeElement?.closest('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
        hasAddress: Boolean(document.querySelector('[data-testid="browser-address"]')),
        leafState: document.querySelector('[data-testid="browser-leaf"]')?.dataset.browserState ?? null,
        scopes: [...document.querySelectorAll('[data-focus-scope]')].map((el) => el.getAttribute('data-focus-scope')),
        paneOn: document.querySelector('[data-testid="browser-leaf"]')?.closest('[data-pane-on]') ? 'on' : 'off',
        trail: window.__b2Focus ?? null,
        focusDump: window.__focus?.dump?.() ?? null,
      }))
      throw new Error(`${error.message}\n焦点现场:${JSON.stringify(where)}`)
    })
    assert(addressFocused === true, '② 地址栏拿到焦点(响应链规则 2「打开什么焦点进什么」)')

    console.log('\n[3/10] 地址栏输入本地 URL + 回车')
    await cdp.send('Input.insertText', { text: pageUrl('/') })
    await press(cdp, { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' })
    const titled = await waitFor(
      '活标题落成页标题',
      async () => {
        const tabs = await rpc(record, 'resources', 'read', {
          ref: 'browser:@all',
          name: 'tabs',
        })
        const row = (tabs.value?.tabs ?? []).find((t) => t.id === first[0])
        return row && row.title.startsWith(NONCE) ? row : undefined
      },
      25_000,
    )
    assert(titled.title.startsWith(NONCE), `③ 活标题落成 ${titled.title}`)
    const leafTitle = await waitFor('叶檐上的标题跟着换', () =>
      page.evaluate(
        (mark) => (document.body.innerText.includes(mark) ? true : undefined),
        NONCE,
      ),
    )
    assert(leafTitle === true, '③ 那一句也画到了叶檐上(活标题盖静标题)')

    console.log('\n[4/10] 经 RPC 开第二格(= AI 那条路)')
    const opened = await rpc(record, 'resources', 'do', {
      ref: 'browser:@all',
      op: 'open',
      params: { url: pageUrl('/second') },
    })
    assert(opened.kind === 'ok', `④ resources.do open 成功(${JSON.stringify(opened).slice(0, 160)})`)
    const two = await waitFor(
      '第二格的标题也落下来',
      async () => {
        const tabs = await rpc(record, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' })
        const rows = tabs.value?.tabs ?? []
        return rows.length === 2 && rows.every((r) => r.title.startsWith(NONCE)) ? rows : undefined
      },
      25_000,
    )
    assert(two.length === 2, `④ 两格 tab,标题都落了(${two.map((r) => r.title).join(' / ')})`)

    console.log('\n[5/10] 读正文 —— 而且必须带 untrusted 定界')
    const pageRead = await rpc(record, 'resources', 'read', {
      ref: `browser:${two[1].id}`,
      name: 'page',
    })
    assert(pageRead.kind === 'ok', `⑤ read page 成功(${pageRead.kind})`)
    assert(pageRead.value.text.includes(BODY_MARK), '⑤ 正文里有页面上那句标记')
    assert(
      /untrusted/i.test(pageRead.value.text),
      `⑤ 正文被 untrusted 定界包过(§9-3;头 120 字:${pageRead.value.text.slice(0, 120)})`,
    )

    console.log('\n[6/10] 遮挡:开一块别的面并撕成浮窗压上去')
    /*
     * 遮挡这一步**不动真鼠标**:三条判据里最便宜的一条是「树上挂着一格 float/modal
     * 作用域」—— 开一张菜单就命中。这里用的是**命令面板**(⌘⇧W,`palette` 作用域,
     * kind=modal),它既是真实用户每天会做的事,也是 CDP 打得出来的。
     * 「浮窗矩形相交」那一条由单测钉(拖窗要动真鼠标,而那条纪律禁);
     * 这一步量的是**回路**:遮 → 快照到 → 占位格换图 → 撤 → 视图回来。
     */
    const snapshotAt = Date.now()
    // **⌘⇧W**(工作区命令面板)。shift 那一格是硬的:少了它就是 ⌘W = 关当前 tab
    // (`leaf` 作用域的局部键),门会把自己刚开的那一格关掉。
    await press(cdp, { key: 'W', code: 'KeyW', keyCode: 87, primary: true, shift: true })
    const shown = await waitFor(
      '占位格换成快照',
      () =>
        page.evaluate(() =>
          document.querySelector('[data-native-view-snapshot] [data-testid="native-view-snapshot"]')
            ? true
            : undefined,
        ),
      5_000,
    )
    report.occludeMs = Date.now() - snapshotAt
    assert(shown === true, `⑥ 被遮时占位格铺上了快照(回路 ${report.occludeMs}ms)`)
    await press(cdp, { key: 'Escape', code: 'Escape', keyCode: 27 })
    const back = await waitFor('盖的东西走了,图撤掉、视图回来', () =>
      page.evaluate(() =>
        document.querySelector('[data-testid="native-view-snapshot"]') ? undefined : true,
      ),
    )
    assert(back === true, '⑥ 盖的东西走了之后快照撤掉(视图自己回到屏幕上)')

    console.log('\n[7/10] 键位下沉:页面有焦点时 ⌘⇧W 仍开命令面板、⌘L 回地址栏')
    /*
     * **先把键盘交给页面**(经 `focus` 动词 → 主进程 `webContents.focus()`)。
     * 这一句是这一步的前提:不交的话键盘还在壳里,量到的是「壳自己的派发器работает」,
     * 与键位下沉无关。交完之后壳的 window 上**收不到任何键** —— ⌘⇧W 还能开面板,
     * 只可能是主进程截下来推回去的那条路。
     */
    await page.evaluate((viewId) => {
      const host = window.onethingHost
      host?.nativeView?.send({ verb: 'focus', viewId })
    }, two[0].id)
    await delay(300)
    await press(cdp, { key: 'L', code: 'KeyL', keyCode: 76, primary: true })
    // 注:CDP 的 `Input.dispatchKeyEvent` 打进的是**壳那个 webContents**,页面那片
    // 视图不吃它 —— 所以这一发量的是「⌘L 在 browser 作用域里真的落在地址栏上」
    // (局部键那一半);主进程截键那一半由 `keymap-bridge` 的单测与 B0-② 读数钉。
    const addressBack = await waitFor('⌘L 把焦点送回地址栏', () =>
      page.evaluate(() =>
        document.activeElement?.getAttribute('data-testid') === 'browser-address' ? true : undefined,
      ),
    )
    assert(addressBack === true, '⑦ ⌘L 回地址栏(`browser` 作用域的局部键)')
    const chords = await app.evaluate(() => globalThis.__b2Keymap ?? [])
    const lastTable = chords.at(-1) ?? []
    report.chords = lastTable.length
    assert(
      lastTable.some((c) => c === 'cmd+l' || c === 'ctrl+l'),
      `⑦ 键位下沉:推给主进程那张保留键表里有 ⌘L(整表 ${lastTable.length} 条)`,
    )
    assert(
      lastTable.some((c) => c === 'cmd+p' || c === 'ctrl+p'),
      '⑦ 同一张表里也有全局命令(⌘P 检索面)—— 页面拿到焦点时它们照样先于页面',
    )

    /*
     * ⑧ **不在这一趟里** —— 它要一台**不是 playwright 起的**壳,判词在下面
     * `[8/10]` 那一段的开头。这里先把 ⑨⑩ 跑完,再关掉这一趟。
     */
    /*
     * ⑧ 的前置:**经设置那条真路**把 CDP 那一格打开(B2′)。
     *
     * 门**不自己写旗文件** —— 写了也会被这一趟的设置监听当场按「设置里是关着的」
     * 抹掉(`installCdpSettingsWatcher` 在装配完读一次设置并落旗,`cdp.enabled`
     * 为假就把文件删掉)。那不是 bug,是那条链在生效:旗文件的产地只有设置一处。
     * 所以门走人走的那条路:保存设置 → 旗文件落地 → **下次启动**才生效
     * (「重启生效」那句话也因此被量到了)。
     */
    console.log('\n[7b] axe 扫这一屏(与 gate:a11y 同一套标签)')
    /*
     * `setLegacyMode(true)` 是**必须的**(与 `gate-a11y.scanAxe` / `gate-terminal` ⑧
     * 逐字同一个理由):默认模式下 AxeBuilder 会 `newPage()` 去处理跨 frame,而
     * Electron 的 CDP 不支持 `Target.createTarget`,当场协议报错。
     */
    const axe = await new AxeBuilder({ page })
      .setLegacyMode(true)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
      .include('[data-testid="browser-leaf"]')
      .analyze()
    for (const v of axe.violations) {
      console.log(`      [${v.impact}] ${v.id} —— ${v.help}`)
      for (const node of v.nodes.slice(0, 4)) console.log(`        ${node.target.join(' ')}`)
    }
    assert(
      axe.violations.length === 0,
      `⑪ 浏览器这一屏 axe 零违例(过了 ${axe.passes.length} 条规则)`,
    )

    console.log('\n[8/10 前置] 经设置打开 CDP 那一格(重启才生效)')
    const settingsNow = await rpc(record, 'settings', 'getSettings', {})
    const saved = await rpc(record, 'settings', 'saveSettings', {
      ...settingsNow.settings,
      browser: {
        ...(settingsNow.settings?.browser ?? {}),
        cdp: { enabled: true, port: productCdpPort },
      },
    })
    assert(saved.success === true, '⑧ 设置存上了(CDP 开,端口是门自己那一个)')
    const flagged = await waitFor('旗文件落到 run/cdp.json', () => {
      const flag = readJson(path.join(store, 'run', 'cdp.json'))
      return flag && flag.port === productCdpPort ? flag : undefined
    })
    assert(flagged.port === productCdpPort, `⑧ run/cdp.json 写着 ${flagged.port}`)
    const stillNoCdp = readJson(path.join(store, 'run', 'http.json'))
    assert(
      stillNoCdp?.cdp === undefined,
      '⑧ **这一趟**的发现文件里仍然没有 cdp —— 它说的是「这个进程真的开着的口」,'
        + '而这个进程是 ready 之前就定死的(「重启生效」不是一句免责声明,是形状)',
    )

    console.log('\n[9/10] 关标签 —— 账上不留残渣')
    const closed = await rpc(record, 'resources', 'do', { ref: `browser:${two[1].id}`, op: 'close' })
    assert(closed.kind === 'ok', '⑨ resources.do close 成功')
    const after = await waitFor('表里没有它了', async () => {
      const tabs = await rpc(record, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' })
      const rows = tabs.value?.tabs ?? []
      return rows.every((r) => r.id !== two[1].id) ? rows : undefined
    })
    assert(after.length === 1, `⑨ read tabs 里没有它了(还剩 ${after.length} 格)`)

    console.log('\n[10/10] 超量:8 格 tab 全开,逐格切换')
    await page.evaluate(() => {
      if (window.__b2Loaf) return
      const P = (window.__b2Loaf = { frames: [] })
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) P.frames.push(Math.round(entry.duration))
        }).observe({ type: 'long-animation-frame', buffered: true })
      } catch (error) {
        P.err = String(error)
      }
    })
    const ids = [after[0].id]
    for (let i = 1; i < 8; i += 1) {
      const out = await rpc(record, 'resources', 'do', {
        ref: 'browser:@all',
        op: 'open',
        params: { url: pageUrl(`/t${i}`), background: true },
      })
      if (out.kind !== 'ok') throw new Error(`开第 ${i + 1} 格失败:${JSON.stringify(out)}`)
    }
    const all = await waitFor(
      '八格都在表里',
      async () => {
        const tabs = await rpc(record, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' })
        const rows = tabs.value?.tabs ?? []
        return rows.length === 8 ? rows : undefined
      },
      30_000,
    )
    ids.length = 0
    ids.push(...all.map((r) => r.id))
    const switchStart = Date.now()
    for (const id of ids) {
      await rpc(record, 'resources', 'do', { ref: `browser:${id}`, op: 'activate' })
      await delay(80)
    }
    report.switchMs = Date.now() - switchStart
    await delay(600)
    const loaf = await page.evaluate(() => {
      const P = window.__b2Loaf
      const frames = P?.frames ?? []
      return { frames: frames.length, long: frames.filter((d) => d >= 50), longest: Math.max(0, ...frames) }
    })
    report.tabs = ids.length
    report.loaf = loaf
    console.log(
      `      ⑩ 8 格全开 + 逐格切换共 ${report.switchMs}ms;≥50ms 的长帧 ${loaf.long.length} 个`
        + `${loaf.long.length ? `(${loaf.long.join(', ')}ms)` : ''},最长一帧 ${loaf.longest}ms`,
    )
    assert(true, '⑩ 超量读数已打表(本版不判红 —— 第一次有读数,阈值下一单按实测定)')

    await app.close()
    app = undefined
    // tab 表是 300ms 节流写的(`BrowserService.schedulePersist`);`dispose()` 会
    // 立刻补一发,这里只等文件落盘那一下。
    await delay(400)

    /*
     * ── ⑧ 第二趟:**不经 playwright 起壳** ────────────────────────────────
     *
     * 这一条必须单起一趟,而理由是这道门自己量出来的:playwright 的
     * `_electron.launch` 在 argv 上带 `--inspect=0 --remote-debugging-port=0`
     * (实测打印过)。产品那条判据(§9-4:**argv 里已经带着口就不再 append**)
     * 于是正确地让开 —— 结果是「产品自己那一口」在 playwright 起的壳里根本不存在,
     * 发现文件里也就没有 `cdp`。那不是回归,那正是判据在生效。
     *
     * 所以第二趟直接 `spawn` Electron:argv 干净 → 旗文件那一口真的开出来 →
     * 发现文件里有它 → `/json/list` 列得出。顺带把**重启**那条路也量了
     * (§9-5:tab 表由主进程落盘,起来按表惰性重建;`activate` 那一下才建视图,
     * 于是它才在 CDP 的目标表里冒出来 —— 这正是「惰性」两个字的可观测形)。
     */
    console.log('\n[8/10] CDP 口:另起一趟(argv 干净)—— 发现文件带口,/json/list 列得出 tab 页')
    child = spawn(electronBinary, [mainEntry, `--user-data-dir=${userDataDir}`], {
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
        ONETHING_GATE_HEADLESS: '1',
        ONETHING_GATE_OFFSCREEN: '1',
      },
      stdio: 'ignore',
    })
    const second = await waitFor(
      '第二趟的 core 写出发现文件,而且带着 cdp 口',
      () => {
        const found = readJson(path.join(store, 'run', 'http.json'))
        return found && found.owner === 'shell' && found.pid !== record.pid ? found : undefined
      },
      40_000,
    )
    assert(
      second.cdp?.port === productCdpPort,
      `⑧ run/http.json 带 cdp.port=${second.cdp?.port}(判据是命令行不是设置)`,
    )
    const restored = await waitFor('重启之后 tab 表按账本重建', async () => {
      const tabs = await rpc(second, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' })
      const rows = tabs.value?.tabs ?? []
      return rows.length > 0 ? rows : undefined
    }, 30_000)
    assert(restored.length === 8, `⑧ 重启后账上那 8 格都在(${restored.length})`)
    // **惰性**:这一下才建视图,于是它才会在 CDP 的目标表里冒出来。
    await rpc(second, 'resources', 'do', { ref: `browser:${restored[0].id}`, op: 'activate' })
    const tabTargets = await waitFor(
      '/json/list 里出现那一格 tab 页',
      async () => {
        const targets = await fetch(`http://127.0.0.1:${productCdpPort}/json/list`)
          .then((r) => r.json())
          .catch(() => [])
        const hit = targets.filter((t) => t.type === 'page' && String(t.title).startsWith(NONCE))
        return hit.length > 0 ? { hit, targets } : undefined
      },
      30_000,
    )
    assert(
      tabTargets.hit.length >= 1,
      `⑧ /json/list 里有 ${tabTargets.hit.length} 个 type:'page' 的 tab 页,标题对得上`
        + `(整表 ${tabTargets.targets.map((t) => `${t.type}:${String(t.title).slice(0, 28)}`).join(' | ')})`,
    )
    child.kill('SIGTERM')
    await delay(1200)
    child = undefined

    console.log('\n[browser-gate] ok —— 十一条全过')
    console.log(`[browser-gate] 读数:${JSON.stringify(report)}`)
  } finally {
    if (app) await app.close().catch(() => {})
    if (child) { try { child.kill('SIGKILL') } catch { /* 已经走了 */ } }
    if (pages) await new Promise((resolve) => pages.server.close(resolve))
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('\n[browser-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
