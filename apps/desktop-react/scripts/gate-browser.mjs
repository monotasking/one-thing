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
 *  ⑩ **超量**:8 格 tab 全开,**冷 / 热两轮**逐格切换并分段计时(activate 往返 /
 *     状态落定),判热轮那一格与「这一段零长帧」——判词与两档阈值在 `BUDGET` /
 *     `TRANSITIONAL` 上;
 *  ⑪ **axe 扫这一屏**(与 `gate:a11y` 同一套标签、同一个 legacy 模式);
 *  ⑫ **页内查找**(B3-a):⌘F → 打一个词 → 读数「1/1」,而且 ⌘F 真的在推给主进程
 *     那张保留键表里(页面有焦点时它先于页面自己的查找条);
 *  ⑬ **网页权限**(B3-a):门自起的本地页 `getCurrentPosition` → 询问卡出现在叶檐下
 *     → 点「拒绝」→ **页面真的收到 `PERMISSION_DENIED`**(页面把 `err.code` 写进
 *     标题,而标题是这道门本来就读得到的东西)→ 卡随 `permissionResolved` 撤掉;
 *  ⑭ **下载**(B3-a):页面里点一颗 `<a download>`(**在主进程里让那一页自己
 *     `click()`**,不动真鼠标)→ 檐下一行「已下载 …」+ 文件真的落在**临时**下载
 *     目录里(`ONETHING_GATE_DOWNLOADS_DIR`,产品路径上读不到的那一格);
 *  ⑮ **起始页**(B3-b):一格新标签页画的是**壳自己的 DOM**(`browser-start`)、
 *     **不画占位格**(不报帧 = 那片视图保持隐藏),地址栏有焦点(② 那条);
 *  ⑯ **多 profile**(B3-b):`do open {profile:'gate-b'}` 之后 `read tabs` 里那一格
 *     的 `profile === 'gate-b'`,而且**两格身份的 cookie 互相看不见** —— 门自起的
 *     本地页各种一枚同名 cookie 再各读一次,量的是 Chromium 的分区本身;
 *  ⑰ **把这一页交给对话**(B3-b):⋯ 那张表里点一行 → 输入框落一枚
 *     `{{page:<id>}}` chip(零字节)→ 发送 → 那一发 `session-command.emit` 的
 *     信封里页面正文是一件带 `sourceUrl` 的**附件**,`content` 里一个字都没有。
 *  ⑱ **代理**(2026-09-12,真机报障:内置浏览器打不开 YouTube,主进程日志成串
 *     `ssl_client_socket_impl.cc handshake failed … net_error -100`)。病根是
 *     `applyShellNetworkProxySettings()` 只对 `session.defaultSession` 一个人
 *     `setProxy`,而每一格身份跑在自己的 `persist:browser-<id>` 分区上 → 标签
 *     **直连出网**。两半各判一条,**各自单起一趟壳**(见下):
 *       ·(a)临时 store 的 `settings.json` 里代理开着 → 开一格 tab 载入门自己那张
 *            本地页 → **门自起的记账代理的日志里出现那条请求**(证明分区真的走了
 *            代理,而不是「反正 localhost 也能直连」);
 *       ·(b)经 RPC 把代理关掉 → 再开一格 → 记账日志**不再增加**(证明改设置
 *            真的重套到了已经建出来的那格分区上 —— 宿主表 `settings` 那一格)。
 *     **bypass 必须是 `<-loopback>` 而不是空串**:Chromium 默认**隐式放过**
 *     localhost / link-local,空 bypass 下这道门量到的会是「谁都没走代理」这件
 *     废话;`<-loopback>` 正是关掉那条隐式规则的那一行(net::ProxyBypassRules)。
 *
 * ⑫⑬⑭ 跑在 ⑪ **之前**,而那是有意的:三件都留在屏上,于是 axe 那一扫顺带把
 * B3-a 这三个新 surface 也扫了(「新 surface 必须追加进扫描屏」那条纪律)。
 * ⑬ 的「拒绝」压在 axe 之后 —— 卡得先站在屏上让它扫到。
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
 * ── 两档渲染层都跑(第 5 轴)──────────────────────────────────────────────
 * **缺省跑 dev**(现起一台 vite,端口 5199 —— 绝不碰用户的 5175),`--prod` 吃
 * `dist/` 产物。理由是第 5 轴那一句:用户跑的是 `electron:dev`,生产构建上量出来
 * 的数对它不成立。dev 档里那台 vite 同时服务**两趟壳**(⑧ 另起的那一趟)。
 *
 * 跑法:
 *   `npm run gate:browser`            —— dev 渲染层
 *   `npm run gate:browser -- --prod`  —— prod 渲染层(吃 `npm run app:build` 的 dist)
 */
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

const PROD = process.argv.includes('--prod') || process.env.ONETHING_GATE_DIST === '1'
const LANE = PROD ? 'prod' : 'dev'

/**
 * dev 档的 vite 端口。**不是 5175**(用户 `app:dev` 占着的那一口,`strictPort`),
 * 也不是 5197 / 5198(`gate:chat-layout` / `gate:terminal` 各占一口)—— 三道门
 * 可能挨着跑。
 */
const DEV_PORT = Number(process.env.ONETHING_GATE_VITE_PORT ?? 5199)

/**
 * ── 预算(T2 定档;体例照 `scripts/gate-chat-layout.mjs`)──────────────────
 *
 * 第 5 轴那张表在这道门上说得上话的有两格,原数照抄不改:
 *  · **来回切 ≤ 50ms**(那张表第四行)—— 浏览器这一侧的「切」是换一格 tab:
 *    主进程把上一片视图藏起来、把这一片的矩形摆好;
 *  · **流式期间零 ≥50ms 长帧**(第五行)—— 这里没有流,但「逐格切换那一段里
 *    渲染进程不许卡一帧」是同一句话。
 * 第三格是这条线自己的:**遮挡换图 ≤ 100ms**(方案 §2.2-1 的「B0 量闪烁」——
 * 盖上来到占位格铺上快照,人眼看得出来的那一下)。
 */
const BUDGET = {
  /** ⑩ 一格 tab 切过去要多久(主进程 activate 那一趟的往返)。 */
  tabSwitchMs: 50,
  /** ⑩ 逐格切换那一段里不许出现的长帧门槛。 */
  switchLongFrameMs: 50,
  /** ⑥ 盖上来 → 占位格铺上快照的端到端回路。 */
  occludeSnapshotMs: 100,
}

/**
 * ── **过渡阈值**(T2;体例与退场判据逐字照 `gate-chat-layout` 的同名表)──────
 *
 * 两格今天达不到第 5 轴的原数,而且**两档渲染层都达不到** —— 所以两档各一列,
 * 每一行写实测来源与退场判据(那一格在这一档上真的达标之后,**删掉这里对应的
 * 行**,不是把它改小)。抬 `BUDGET` 是改法,让它恒红只会被人加 `|| true`。
 *
 * **`tabSwitchMs` 没有过渡值,而那是量出来的,不是省出来的**:B2 那一版报的
 * 「8 格逐格切换 688–712ms」里 **640ms 是门自己 `delay(80)` 睡的**,产品那一侧
 * 每格 `activate` 往返 prod 1–5ms / dev 2–8ms(冷轮与热轮几乎同价 —— 惰性建视图
 * 不在这一趟的同步路上)。所以它直接吃第 5 轴原数 50ms,余量一个数量级。
 *
 * ① **遮挡回路**(`occludeSnapshotMs`):B2 实测 160–239ms,B0 量到主进程那半程
 *    p50 18–29 / p95 54–96ms —— 差的那一百多毫秒在**壳这一侧**:收 `snapshot`
 *    推送 → `img.decode()` → 下一帧再显(B2 有意留的一帧,判词在 `NativeViewSlot`)。
 *    退场判据:那条换图链治到 100ms 以内(B3 的 `img.decode()` 预热 / 直接用
 *    `createImageBitmap`),删掉这两行。
 */
const TRANSITIONAL = {
  dev: { occludeSnapshotMs: 320 },
  prod: { occludeSnapshotMs: 300 },
}

/** 这一档下某一格的判据(有过渡值就用过渡值,没有就是第 5 轴原数)。 */
function budgetOf(key) {
  return key in TRANSITIONAL[LANE] ? TRANSITIONAL[LANE][key] : BUDGET[key]
}

/** 判据后面那句「这是过渡档」的尾巴。没有过渡值的格子是空串。 */
function laneNote(key) {
  return key in TRANSITIONAL[LANE]
    ? `(${LANE} **过渡档**;第 5 轴原数 ${BUDGET[key]}ms —— 达标之后删掉过渡表那一行)`
    : ''
}

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

/** ⑭ 那份要下的东西的名字(带 nonce —— 临时下载目录里认得出是这一趟的)。 */
const DOWNLOAD_NAME = `gate-${NONCE}.txt`

/**
 * 门自己那台 http 页服务器:标题就是断言(③④)。
 *
 * B3-a 加三条路,而**三条都只为「这件事真的会发生」而存在**:
 *  · `/file` —— 带 `content-disposition: attachment` 的一份正文。**它不是一张页**,
 *    浏览器对它唯一会做的事就是下载(⑭ 的触发源);
 *  · `/dl`   —— 一张页,上面一颗 `<a download>` 指着 `/file`。⑭ 在主进程里让那一页
 *    自己 `click()` 它(**不动真鼠标** —— CDP 的键鼠打进的是壳那个 webContents,
 *    页面那片视图不吃它;「不许抢用户的机器」那条纪律也禁系统级合成输入);
 *  · `/geo`  —— 一张页,载入就 `getCurrentPosition`,并把**结果写进标题**。
 *    标题是这道门本来就读得到的东西(`read tabs`),于是「页面收到了
 *    PERMISSION_DENIED」这件事不必往页面里伸手就量得到。
 */
function startPageServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const route = (req.url ?? '/').split('?')[0]
      if (route === '/file') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${DOWNLOAD_NAME}"`,
        })
        res.end(`${BODY_MARK}\n`)
        return
      }
      const which = route.replace(/[^a-z0-9/]/gi, '')
      const head = `<!doctype html><html><head><meta charset="utf-8"><title>${NONCE}${which === '/' ? '' : which}</title></head>`
      if (route === '/dl') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`${head}<body style="background:#0a0">${BODY_MARK}`
          + `<a id="dl" href="/file" download="${DOWNLOAD_NAME}">get</a></body></html>`)
        return
      }
      /*
       * B3-b 加两条,**只为「两格身份真的隔开了」而存在**(⑯):
       *  · `/setcookie` —— 种一枚带值的 cookie,并把种下的值写进标题;
       *  · `/readcookie` —— 把**读到的** cookie 写进标题(读不到就写 `NONE`)。
       * 标题是这道门本来就读得到的东西(`read tabs`),所以「另一格身份看不见
       * 这枚 cookie」这件事不必往页面里伸手就量得到 —— 而且量的是 Chromium 的
       * 分区本身,不是我们自己那张表。
       */
      if (route === '/setcookie' || route === '/readcookie') {
        const value = (req.url ?? '').includes('v=') ? (req.url ?? '').split('v=')[1] : ''
        const headers = { 'content-type': 'text/html; charset=utf-8' }
        if (route === '/setcookie') headers['set-cookie'] = `gate=${value}; Path=/`
        const seen = route === '/readcookie'
          ? (/gate=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? 'NONE')
          : value
        res.writeHead(200, headers)
        res.end(`<!doctype html><html><head><meta charset="utf-8">`
          + `<title>${NONCE}COOKIE${seen}</title></head>`
          + `<body style="background:#0a0">${BODY_MARK}</body></html>`)
        return
      }
      if (route === '/geo') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`${head}<body style="background:#0a0">${BODY_MARK}<script>
          navigator.geolocation.getCurrentPosition(
            () => { document.title = ${JSON.stringify(NONCE)} + 'GEOOK' },
            (err) => { document.title = ${JSON.stringify(NONCE)} + 'GEO' + err.code },
          )
        </script></body></html>`)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`${head}<body style="background:#0a0">${BODY_MARK}</body></html>`)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/**
 * ⑱ 那只**记账 HTTP 代理**。
 *
 * 它只做两件事:**记下每一条经过它的请求**,然后照转。记账才是断言的本体 ——
 * 「这一发到底走没走代理」不是壳能自证的事(直连一样能把 localhost 那张页载上来),
 * 只有代理这一侧的日志答得了。
 *
 * 两条请求形态都收着:
 *  · **绝对 URI 的普通请求**(RFC 7230 §5.3.2)—— Chromium 对 `http://` 目标就是
 *    这么发给代理的,也是这道门唯一真会走的那条;
 *  · **CONNECT**(`https://` 目标)—— 这道门的本地页是 http,用不上它,但收着:
 *    少了它的话,哪天有人把门里的页换成 https,红出来的会是一条看不懂的超时,
 *    而不是「代理不认识 CONNECT」。
 *
 * **不做任何缓存 / 改写**:它是一把尺子,不是一个中间件。
 */
function startAccountingProxy() {
  const seen = []
  const server = createServer((req, res) => {
    const target = req.url ?? ''
    if (!/^https?:\/\//i.test(target)) {
      // 不是代理请求(有人直接打了这个口)。记都不记 —— 它不是被量的那件事。
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('not a proxy request')
      return
    }
    const url = new URL(target)
    seen.push({ host: url.host, path: `${url.pathname}${url.search}` })
    const upstream = httpRequest(
      {
        host: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: { ...req.headers, host: url.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', () => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('upstream failed')
    })
    req.pipe(upstream)
  })
  server.on('connect', (req, socket) => {
    const [host, port] = String(req.url ?? '').split(':')
    seen.push({ host: String(req.url ?? ''), path: 'CONNECT' })
    const up = connect(Number(port || 443), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      up.pipe(socket)
      socket.pipe(up)
    })
    up.on('error', () => { socket.destroy() })
    socket.on('error', () => { up.destroy() })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }))
  })
}

/**
 * 屏幕上此刻那几片浏览器叶。
 *
 * **把手是叶自己的 `data-tab-id`,不是占位格的 `data-native-view`**(B3-b 改口)。
 * 起始页那一档(空标签页)整片占位格都不画 —— 视图不报帧就保持隐藏,屏幕上是
 * 壳自己的 DOM;拿占位格当把手的话,一格刚开出来的新标签页在门眼里根本不存在。
 * `data-tab-id` 在**每一档**都成立(没有宿主 / 找不到 / 起始页 / 正常),
 * 所以它才是这条把手该挂的地方。
 */
const leafIds = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="browser-leaf"]')].map((el) => el.dataset.tabId),
  )

async function main() {
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[browser-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'browser-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'browser-gate-userdata-'))
  /*
   * ⑭ 的落点。**门不许往用户真正的 `~/Downloads` 里扔东西**(「验证不改用户状态」
   * 那条纪律),所以产品那一侧留了一格只在 `ONETHING_GATE_` 前缀下生效的覆盖
   * (`electron/browser/download.ts` 的 `GATE_DOWNLOADS_DIR_ENV`);产品路径上
   * 一个字都读不到它。
   */
  const downloadsDir = await mkdtemp(path.join(tmpdir(), 'browser-gate-downloads-'))
  /** 产品那一口 CDP。与门自己驱动壳用的那条分开(B0-③)。 */
  const productCdpPort = 19_000 + Math.floor(Math.random() * 900)
  let app
  let child
  let pages
  let vite
  /** ⑱ 那只记账代理,以及它那一趟壳的临时 store(`finally` 里收尸)。 */
  let proxyServer
  let proxyStoreDir
  const report = { lane: LANE }
  try {
    await mkdir(path.join(store, 'run'), { recursive: true, mode: 0o700 })
    pages = await startPageServer()
    const pageUrl = (p = '/') => `http://127.0.0.1:${pages.port}${p}`

    let rendererUrl = ''
    if (!PROD) {
      console.log(`\n[0/10] dev 档:起一台 vite(端口 ${DEV_PORT},**不是用户的 5175**)`)
      const { createServer } = await import('vite')
      vite = await createServer({
        configFile: path.join(appRoot, 'vite.config.ts'),
        server: { port: DEV_PORT, strictPort: true },
        logLevel: 'warn',
      })
      await vite.listen()
      rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`
      console.log(`      ${rendererUrl}`)
    }
    console.log(`\n[1/10] 壳自己装配 core + 屏外窗(判词在文件头;${LANE} 档)`)
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: rendererUrl,
        // 两个一起传:`HEADLESS` 管「别自己 show」,`OFFSCREEN` 管「摆到屏外、
        // 不抢焦点地 showInactive」。判词在 `electron/main.ts` 的 `GATE_OFFSCREEN` 上。
        ONETHING_GATE_HEADLESS: '1',
        ONETHING_GATE_OFFSCREEN: '1',
        ONETHING_GATE_DOWNLOADS_DIR: downloadsDir,
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
      Object.keys(spec.ops ?? {}).sort().join(',')
        === 'activate,back,close,forward,navigate,open,reload,respondPermission',
      `① 做法八条(B3-a 加了 respondPermission;${Object.keys(spec.ops ?? {}).sort().join(',')})`,
    )
    assert(
      Object.keys(spec.events ?? {}).sort().join(',')
        === 'closed,download,loading,navigated,opened,permissionRequested,permissionResolved',
      `① 事实七条(B3-a 加了三条;${Object.keys(spec.events ?? {}).sort().join(',')})`,
    )
    assert(
      !('find' in (spec.ops ?? {})) && !('find' in (spec.reads ?? {})),
      '① **页内查找一个字都没进自述** —— 它是视图状态,走 host:native-view'
        + '(判词在 electron/browser/resource-spec.ts 的「哪些东西不进这份自述」)',
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
      globalThis.__b2Find = []
      ipcMain.on('host:native-view', (_event, message) => {
        if (message && message.verb === 'keymap') globalThis.__b2Keymap.push(message.chords)
        if (message && (message.verb === 'find' || message.verb === 'findStop')) {
          globalThis.__b2Find.push(message)
        }
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

    /*
     * ⑮ **起始页**(B3-b)。一格空标签页画的是**壳自己的 DOM**,不是一张网页:
     * 屏幕上有 `browser-start` 那一块,而占位格**整个不在**——不报帧,于是主进程
     * 那一侧那片视图保持隐藏(`layout.register` 的第一句)。
     * 焦点那一半就是上面 ② 那条断言,不重复量。
     *
     * **反证**:把 `BrowserLeaf` 里 `known && !row.url` 那一支改成恒假(永远画
     * 占位格)→ 第一条红;改成恒真 → ③ 打完地址之后页面永远出不来,③ 红。
     */
    const startPage = await page.evaluate(() => ({
      start: Boolean(document.querySelector('[data-testid="browser-start"]')),
      slot: Boolean(document.querySelector('[data-native-view]')),
      engines: document.querySelectorAll('[data-testid="browser-start-engine"]').length,
    }))
    assert(startPage.start, '⑮ 新标签页画的是起始页(壳自己的 DOM)')
    assert(!startPage.slot, '⑮ 起始页那一档**不画占位格** —— 不报帧 = 那片视图保持隐藏')
    assert(startPage.engines === 4, `⑮ 起始页上四枚搜索引擎丸(${startPage.engines})`)

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

    /*
     * ⑯ **两格身份真的隔开了**(B3-b)。
     *
     * 量的是 **Chromium 的分区本身**,不是我们自己那张 tab 表:两格 tab 各种一枚
     * 同名 cookie(值不同),再各读一次 —— 读回自己那一枚才算隔开。
     * `set-cookie` 与 `cookie` 两个请求头都由门自己那台 http 页服务器处理,
     * 页面把读到的值写进 `<title>`,而标题正是 `read tabs` 本来就交出来的东西。
     *
     * **反证**:把 `BrowserSessionPolicy.sessionFor` 里那句 `browserPartitionFor(profile)`
     * 换成常量分区名 → 第二格读到的是第一格种下的值,这一条当场红。
     */
    console.log('\n[5b] ⑯ 多 profile:两格身份的 cookie 互相看不见')
    const cookieA = `A${NONCE}`
    const cookieB = `B${NONCE}`
    const openedB = await rpc(record, 'resources', 'do', {
      ref: 'browser:@all',
      op: 'open',
      /*
       * **不给 `background`**:后台那一格是**惰性**的(`service.open` 只对前台那格
       * 调 `materialize`),而没有视图就没有导航、没有 cookie、没有标题 ——
       * 这一步量的恰恰是「那一格身份真的去发了一个请求」。
       */
      params: { url: pageUrl(`/setcookie?v=${cookieB}`), profile: 'gate-b' },
    })
    assert(openedB.kind === 'ok', `⑯ do open {profile:'gate-b'} 成功(${openedB.kind})`)

    const tabB = await waitFor('第二格身份那一格落进表里,而且它的 profile 是 gate-b', async () => {
      const tabs = await rpc(record, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' })
      const row = (tabs.value?.tabs ?? []).find((r) => r.profile === 'gate-b')
      return row && row.title.includes('COOKIE') ? row : undefined
    }, 25_000)
    assert(tabB.profile === 'gate-b', `⑯ read tabs 里那一格的 profile 是 'gate-b'`)

    // 缺省身份那一格也种一枚(值不同)。
    const navA = await rpc(record, 'resources', 'do', {
      ref: `browser:${two[0].id}`,
      op: 'navigate',
      params: { url: pageUrl(`/setcookie?v=${cookieA}`) },
    })
    assert(navA.kind === 'ok', '⑯ 缺省身份那一格也去种一枚')
    await waitFor('缺省那一格种完了', async () => {
      const tabs = await rpc(record, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' })
      const row = (tabs.value?.tabs ?? []).find((r) => r.id === two[0].id)
      return row && row.title.includes(`COOKIE${cookieA}`) ? row : undefined
    }, 25_000)

    // 各读一次:读回自己那一枚才算隔开。
    async function readCookieIn(tabId) {
      const outcome = await rpc(record, 'resources', 'do', {
        ref: `browser:${tabId}`,
        op: 'navigate',
        params: { url: pageUrl('/readcookie') },
      })
      assert(outcome.kind === 'ok', `⑯ browser:${tabId} 去读一次 cookie`)
      /*
       * 判据要**同时**看 url 与标题:上一发 `/setcookie` 留下的标题里也有 `COOKIE`,
       * 只看标题会把那一份当成这一次的读数(而它写的正是刚种下去的值 ——
       * 于是这条断言会恒绿,那比红更坏)。
       */
      const row = await waitFor(`browser:${tabId} 的读数落下来`, async () => {
        const tabs = await rpc(record, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' })
        const found = (tabs.value?.tabs ?? []).find((r) => r.id === tabId)
        return found && found.url.includes('/readcookie') && found.title.includes('COOKIE')
          ? found
          : undefined
      }, 25_000)
      return row.title.replace(`${NONCE}COOKIE`, '')
    }
    const seenInDefault = await readCookieIn(two[0].id)
    const seenInB = await readCookieIn(tabB.id)
    assert(
      seenInDefault === cookieA,
      `⑯ 缺省身份读回自己那一枚(读到 ${seenInDefault},该是 ${cookieA})`,
    )
    assert(
      seenInB === cookieB,
      `⑯ 'gate-b' 身份读回自己那一枚,看不见另一格的(读到 ${seenInB},该是 ${cookieB})`,
    )
    // 收拾掉这一格 —— 后面 ⑩ 的超量那一段按格数算。
    await rpc(record, 'resources', 'do', { ref: `browser:${tabB.id}`, op: 'close' })
    await rpc(record, 'resources', 'do', {
      ref: `browser:${two[0].id}`,
      op: 'navigate',
      params: { url: pageUrl('/') },
    })

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
    /*
     * **T2 起这一条判红**:遮挡换图是人眼看得见的那一下(方案 §2.2-1 的「B0 量
     * 闪烁」)。第 5 轴口径 100ms 今天达不到 —— 实测与病因(差的一百多毫秒在壳
     * 那一侧的 `img.decode()` + 留一帧)与退场判据全写在 `TRANSITIONAL` 上。
     */
    assert(
      report.occludeMs <= budgetOf('occludeSnapshotMs'),
      `⑥ 遮挡回路 ${report.occludeMs}ms ≤ ${budgetOf('occludeSnapshotMs')}ms${laneNote('occludeSnapshotMs')}`,
    )
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
    console.log('\n[7c] ⑫ 页内查找:⌘F → 打一个词 → 读数「1/1」')
    /*
     * **⌘F 走的是壳自己那条局部键**(`FOCUS_SCOPES.browser.keys` 那一行)。
     * 它同时是一条保留键:键位下沉那张表读的正是 `focusScopeKeysOf('browser')`,
     * 所以 ⑦ 里断言过的那张表现在也带着它 —— 页面拿到焦点时按 ⌘F,是主进程
     * 截下来推回壳的。这一步量的是壳这一侧「开出来、找到了、读数对」。
     */
    await press(cdp, { key: 'F', code: 'KeyF', keyCode: 70, primary: true })
    await waitFor('查找行开出来并拿到焦点', () =>
      page.evaluate(() =>
        document.querySelector('[data-testid="browser-find"]') ? true : undefined,
      ),
    )
    await cdp.send('Input.insertText', { text: BODY_MARK })
    /*
     * **等的是「1/1」,不是「读数格里有字」**(第一版就栽在这儿,实测出来的):
     * Chromium 对一次 `findInPage` 先报一发 `finalUpdate: false` 的中间结果再报
     * 定稿,而中间那一发的 `matches` 可以是 0。等「有字」会当场收下那个 0 ——
     * 那不是产品错了,是这道门量早了一拍。产品侧两发都推是有意的(读数一路长上去
     * 正是「它还在数」的诚实形态,判词在 `electron/browser/find.ts` 上)。
     */
    const findReadout = await waitFor(
      '查找读数落成 1/1(中间结果可能先报一发 0)',
      async () => {
        const now = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="browser-find-count"]')
          const input = document.querySelector('[data-testid="browser-find"] input')
          return { readout: el ? el.textContent : null, typed: input ? input.value : null }
        })
        return now.readout === '1/1' ? now : undefined
      },
      15_000,
    ).catch(async (error) => {
      // 失败时把现场交出来:打进去的词、那一格 tab 此刻在哪、正文里有没有那句话。
      const where = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="browser-find-count"]')
        const input = document.querySelector('[data-testid="browser-find"] input')
        return { readout: el ? el.textContent : null, typed: input ? input.value : null }
      })
      const tabsNow = await rpc(record, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' })
      const rowNow = (tabsNow.value?.tabs ?? []).find((t) => t.id === two[0].id)
      const pageNow = await rpc(record, 'resources', 'read', { ref: `browser:${two[0].id}`, name: 'page' })
      /*
       * **主进程直接查一次同一个词**。这一段是 B3-a 那次判红留下来的:壳报的读数
       * 是 0,而主进程在同一片视图上直接 `findInPage` 答 1 —— 一句话把「是我们的
       * 管子断了」与「Chromium 就是找不到」分开(那次的真因是 `findNext` 的语义
       * 与它的名字是反的,判词在 `electron/browser/find.ts` 上)。只在失败路上跑。
       */
      const probe = await app.evaluate(async ({ webContents }, mark) => {
        const rows = []
        for (const wc of webContents.getAllWebContents()) {
          let url = ''
          try { url = wc.getURL() } catch { url = '(gone)' }
          if (!url.includes('127.0.0.1') || url.includes('5199')) continue
          const direct = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve('(no found-in-page in 2s)'), 2000)
            wc.once('found-in-page', (_e, r) => { clearTimeout(timer); resolve(r) })
            try { wc.findInPage(mark) } catch (e) { clearTimeout(timer); resolve(`throw:${String(e)}`) }
          })
          rows.push({ url, type: wc.getType(), direct })
        }
        return rows
      }, BODY_MARK)
      const sentFinds = await app.evaluate(() => globalThis.__b2Find ?? [])
      throw new Error(
        `${error.message}\n现场:${JSON.stringify(where)}`
        + `\n壳发下来的 find:${JSON.stringify(sentFinds)} 期望 viewId=${two[0].id}`
        + `\ntab:${JSON.stringify(rowNow)}`
        + `\n正文含标记:${String(pageNow.value?.text ?? '').includes(BODY_MARK)}`
        + ` 正文头 200:${String(pageNow.value?.text ?? '').slice(0, 120)}`
        + `\n主进程直接 findInPage:${JSON.stringify(probe)}`,
      )
    })
    report.findReadout = findReadout.readout
    assert(
      findReadout.readout === '1/1',
      `⑫ 页内查找读数「${findReadout.readout}」(打进去的词:${findReadout.typed})`,
    )
    const findChords = await app.evaluate(() => globalThis.__b2Keymap ?? [])
    assert(
      (findChords.at(-1) ?? []).some((c) => c === 'cmd+f' || c === 'ctrl+f'),
      '⑫ ⌘F 也在推给主进程那张保留键表里(页面有焦点时它先于页面自己的查找条)',
    )

    console.log('\n[7d] ⑭ 下载:页面里点一颗 `<a download>` → 落到临时下载目录')
    /*
     * **在主进程里让那一页自己 `click()`**,不动真鼠标:CDP 的键鼠打进的是壳那个
     * webContents,页面那片视图根本不吃它;而系统级合成输入被「真机门不许抢用户
     * 的机器」那条纪律禁着。`executeJavaScript(..., true)` 的第二格是 userGesture
     * —— 没有它 Chromium 会把这一下当成脚本自己发起的下载。
     */
    await rpc(record, 'resources', 'do', {
      ref: `browser:${two[0].id}`,
      op: 'navigate',
      params: { url: pageUrl('/dl') },
    })
    await waitFor('下载那一页加载完', async () => {
      const tabs = await rpc(record, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' })
      const row = (tabs.value?.tabs ?? []).find((t) => t.id === two[0].id)
      return row && row.url.endsWith('/dl') && !row.loading ? row : undefined
    }, 20_000)
    const clicked2 = await app.evaluate(async ({ webContents }, needle) => {
      const target = webContents.getAllWebContents().find((w) => w.getURL().includes(needle))
      if (!target) return false
      await target.executeJavaScript("document.getElementById('dl').click()", true)
      return true
    }, '/dl')
    assert(clicked2 === true, '⑭ 在那一页里找到并点了那颗 `<a download>`')
    const downloadLine = await waitFor(
      '下载行落成「已下载」',
      () =>
        page.evaluate(() => {
          const el = document.querySelector('[data-testid="browser-download"]')
          return el && el.dataset.downloadState === 'done' ? el.textContent : undefined
        }),
      25_000,
    )
    assert(
      typeof downloadLine === 'string' && downloadLine.includes(DOWNLOAD_NAME),
      `⑭ 檐下那一行读数说「已下载 ${DOWNLOAD_NAME}」(实读:${downloadLine})`,
    )
    const landed = readdirSync(downloadsDir)
    report.downloads = landed
    assert(
      landed.includes(DOWNLOAD_NAME),
      `⑭ 文件真的落在临时下载目录里(${landed.join(', ') || '空'})—— 而不是用户的 ~/Downloads`,
    )

    console.log('\n[7e] ⑬ 网页权限:geolocation → 询问卡 → 点「拒绝」→ 页面收到 PERMISSION_DENIED')
    await rpc(record, 'resources', 'do', {
      ref: `browser:${two[0].id}`,
      op: 'navigate',
      params: { url: pageUrl('/geo') },
    })
    const permCard = await waitFor(
      '权限询问卡出现在叶檐下',
      () =>
        page.evaluate(() => {
          const el = document.querySelector('[data-testid="browser-permission-card"]')
          return el ? { id: el.dataset.webPermission, text: el.textContent } : undefined
        }),
      25_000,
    )
    assert(
      Boolean(permCard.id),
      `⑬ 卡上带着那一问的 requestId(${permCard.id});卡面:${String(permCard.text).slice(0, 80)}`,
    )

    console.log('\n[7b] axe 扫这一屏(B3-a 起:查找行 / 下载行 / 权限卡三件都在屏上)')
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

    console.log('\n[7e 续] 点「拒绝」—— 页面那边必须真的收到 PERMISSION_DENIED')
    const refused = await page.evaluate(() => {
      const key = document.querySelector('[data-testid="browser-permission-reject"]')
      if (!(key instanceof HTMLElement)) return false
      key.click()
      return true
    })
    assert(refused, '⑬ 卡上那颗「拒绝」点下去了')
    const denied = await waitFor(
      '页面把 PERMISSION_DENIED 写进标题',
      async () => {
        const tabs = await rpc(record, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' })
        const row = (tabs.value?.tabs ?? []).find((t) => t.id === two[0].id)
        return row && row.title.startsWith(`${NONCE}GEO`) ? row.title : undefined
      },
      25_000,
    )
    report.geo = denied
    assert(
      denied === `${NONCE}GEO1`,
      `⑬ 页面收到的是 code 1 = PERMISSION_DENIED(实读标题 ${denied})`
        + '——「拒绝」不是壳自己把卡收掉,那一下真的落回了 Chromium 的 callback',
    )
    const cardGone = await waitFor('那张卡随 permissionResolved 撤掉', () =>
      page.evaluate(() =>
        document.querySelector('[data-testid="browser-permission-card"]') ? undefined : true,
      ),
    )
    assert(cardGone === true, '⑬ 答完那张卡就没了(由 `permissionResolved` 撤,不由点下去那一下撤)')

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

    /*
     * ⑰ **把这一页交给对话**(B3-b)。两半:
     *  ① 点 ⋯ 那张表里的那一行 → 输入框里落一枚引用 chip(`data-token` 是
     *     `{{page:<tabId>}}`,**零字节** —— 点击那一刻一个字的正文都不取);
     *  ② 按发送 → 交出去的那个 RPC 信封里,页面正文是一件带 `sourceUrl` 的
     *     **附件**,而 `content` 里一个字的正文都没有。
     *
     * 第二半的取件口是渲染进程里那一发 `POST /api/rpc` 的请求体 —— 比起在核那一头
     * 架一只假 provider,这一层更靠近判据本身(「交出去的那句话长什么样」),
     * 而且不必给这道门配一个模型。
     *
     * **反证**:把 `chat-port.sendMessage` 里 `materializePageReferences` 那一句
     * 拆掉 → ② 当场红(信封里没有附件,而 `{{page:…}}` 原样漏进 `content`)。
     *
     * ── 它为什么排在这里(⑨ 之后、⑩ 之前)──────────────────────────────
     * 这一步要按一次发送,而按发送就得**把焦点借进输入面板**。⑦ 的前提恰恰是
     * 「焦点在 `browser` 那一格作用域上」(它先把键盘交给页面,再量 ⌘L 有没有
     * 落回地址栏),⑬ 也要点那张权限卡。借了还不回去 —— 试过在这一步末尾把
     * 焦点塞回地址栏,`composer` 那一格的归还规则当场把它拽回来(响应链规则 5),
     * 于是 ⑦ 量到的是一次**门自己制造的**现场。**排到它们后面比还回去干净**:
     * ⑩ 之后的每一步都只经 RPC 驱动,不问焦点。
     */
    console.log('\n[9b] ⑰ 把这一页交给对话 → 引用落进输入框,发送时正文随附件走')
    await page.evaluate(() => {
      window.__b3bSends = []
      const real = window.fetch
      window.fetch = async (input, init) => {
        try {
          const url = typeof input === 'string' ? input : input?.url ?? ''
          if (url.includes('/api/rpc') && init && typeof init.body === 'string') {
            const parsed = JSON.parse(init.body)
            if (parsed?.domain === 'session-command' && parsed?.method === 'emit') {
              window.__b3bSends.push(parsed.payload)
            }
          }
        } catch { /* 抓不到就抓不到 —— 这只旁听不许影响那一发请求 */ }
        return real(input, init)
      }
    })
    const menuOpened = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="browser-actions"]')
      if (!(button instanceof HTMLElement)) return false
      button.click()
      return true
    })
    assert(menuOpened, '⑰ 叶檐上那颗 ⋯ 在')
    const chip = await waitFor('引用 chip 落进输入框', async () => {
      const ok = await page.evaluate(() => {
        const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
          /交给对话|Give this page/.test(el.textContent ?? ''),
        )
        if (!(item instanceof HTMLElement)) return null
        item.click()
        return true
      })
      if (!ok) return undefined
      return page.evaluate(() => {
        const input = document.querySelector('[data-testid="composer-input"]')
        const token = input?.querySelector('[data-token^="{{page:"]')
        return token ? token.getAttribute('data-token') : undefined
      })
    })
    assert(
      chip === `{{page:${two[0].id}}}`,
      `⑰ 输入框里那枚 chip 代表的是这一格 tab(${chip})`,
    )

    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="composer-input"]')
      if (input) input.focus()
    })
    await cdp.send('Input.insertText', { text: ' 总结一下' })
    await press(cdp, { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' })
    const envelope = await waitFor('那一发 session-command.emit 交出去了', () =>
      page.evaluate(() => window.__b3bSends?.[0]),
    )
    const command = envelope?.command ?? {}
    assert(
      !String(command.content ?? '').includes('{{page:'),
      `⑰ 正文里没有 token 残留(${String(command.content ?? '').slice(0, 80)})`,
    )
    assert(
      !String(command.content ?? '').includes(BODY_MARK),
      '⑰ **页面正文不进 `content`** —— 它走附件(不然气泡里会出现整页文字、账本里存一份)',
    )
    assert(
      (command.attachments ?? []).length === 1,
      `⑰ 一件附件(${JSON.stringify(command.attachments ?? []).slice(0, 120)})`,
    )
    assert(
      (command.attachments?.[0]?.sourceUrl ?? '').startsWith('http://127.0.0.1:'),
      `⑰ 附件带着出处(${command.attachments?.[0]?.sourceUrl})`,
    )
    assert(
      String(command.attachments?.[0]?.excerpt ?? '').includes(BODY_MARK),
      '⑰ 附件里装的是这一页的正文',
    )
    assert(
      /untrusted/i.test(String(command.attachments?.[0]?.excerpt ?? '')),
      '⑰ 而且它仍旧带着 untrusted 定界(与 ⑤ 同一条包法,不包第二层)',
    )

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

    /**
     * **一轮逐格切换,分段计时**(T2)。
     *
     * B2 那一版量的是「八格切完一共多少毫秒」= 688–712ms,读起来像「每格 ~85ms」。
     * **那个数里 640ms 是门自己睡的**(每格之后 `delay(80)` 等事件落地),所以
     * 它从来不是产品的钱。这一版把它拆开:
     *  · `rpcMs`  —— `resources.do activate` 那一趟往返:主进程惰性建视图
     *                (`new WebContentsView` + `loadURL`,只有**第一轮**有)+
     *                `setBounds` / `setVisible`;
     *  · `settleMs` —— 从 RPC 回来到 `read tabs` 里 `active` 真的换成它
     *                (主进程状态投影落定);
     *  · 两轮 —— **冷轮**(每格都要建视图)与**热轮**(全都建好了,只换矩形)。
     *    门判的是热轮:那才是「切一格 tab」这件事本身的价钱;冷轮的实测走
     *    `TRANSITIONAL`(判词与退场判据在那张表上)。
     */
    const runRound = async (label) => {
      const laps = []
      const started = Date.now()
      for (const id of ids) {
        const t0 = Date.now()
        await rpc(record, 'resources', 'do', { ref: `browser:${id}`, op: 'activate' })
        const rpcMs = Date.now() - t0
        const t1 = Date.now()
        await waitFor(
          `tabs 里 active 换成 ${id}`,
          async () => {
            const tabs = await rpc(record, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' })
            return (tabs.value?.tabs ?? []).some((r) => r.id === id && r.active) ? true : undefined
          },
          10_000,
        )
        laps.push({ rpcMs, settleMs: Date.now() - t1 })
        // 睡一下让事件走完再进下一格。**它不计入上面那两个数** —— B2 那一版正是
        // 把它算进了总账,于是「每格 85ms」里 80ms 是门自己躺着的那一下。
        await delay(80)
      }
      const worstRpc = Math.max(...laps.map((l) => l.rpcMs))
      const worstSettle = Math.max(...laps.map((l) => l.settleMs))
      console.log(
        `      ⑩ ${label}:八格 activate 往返 ${laps.map((l) => l.rpcMs).join('/')}ms(最坏 ${worstRpc})`
          + `;落定 ${laps.map((l) => l.settleMs).join('/')}ms(最坏 ${worstSettle})`
          + `;这一轮墙上时间 ${Date.now() - started}ms(其中 ${ids.length * 80}ms 是门自己睡的)`,
      )
      return { laps, worstRpc, worstSettle, wallMs: Date.now() - started }
    }

    /*
     * **长帧只数这一段的**:上面那只 observer 是 `buffered: true` 起的(它连
     * 这道门前面九步里的长帧都收着 —— 第一版没切窗口,于是 78 / 59ms 两个来自
     * 开窗与首次导航的帧被算到了「逐格切换」头上,是一条读错了的红)。
     */
    const loafMark = await page.evaluate(() => window.__b2Loaf.frames.length)
    const cold = await runRound('冷轮(每格都要现建 WebContentsView)')
    const warm = await runRound('热轮(视图都在了,只换矩形)')
    await delay(600)
    const loaf = await page.evaluate((mark) => {
      const P = window.__b2Loaf
      const frames = (P?.frames ?? []).slice(mark)
      return { frames: frames.length, long: frames.filter((d) => d >= 50), longest: Math.max(0, ...frames) }
    }, loafMark)
    report.tabs = ids.length
    report.loaf = loaf
    report.switchCold = cold
    report.switchWarm = warm
    // 旧那一格读数留着名字,但口径换成**净额**(减掉门自己睡的那一段)。
    report.switchMs = cold.wallMs + warm.wallMs
    report.switchNetMs = cold.wallMs + warm.wallMs - ids.length * 160
    console.log(
      `      ⑩ 两轮共 ${report.switchMs}ms,减掉门自己睡的 ${ids.length * 160}ms 净 ${report.switchNetMs}ms`
        + `;≥50ms 的长帧 ${loaf.long.length} 个`
        + `${loaf.long.length ? `(${loaf.long.join(', ')}ms)` : ''},最长一帧 ${loaf.longest}ms`,
    )
    assert(
      warm.worstRpc <= budgetOf('tabSwitchMs'),
      `⑩ 热轮里最慢一格 activate ${warm.worstRpc}ms ≤ ${budgetOf('tabSwitchMs')}ms${laneNote('tabSwitchMs')}`
        + `(冷轮最慢 ${cold.worstRpc}ms —— 那一格里含一次惰性建视图;两轮几乎同价,`
        + `判词在 BUDGET 上那一段「640ms 是门自己睡的」)`,
    )
    assert(
      loaf.long.length === 0,
      `⑩ 逐格切换那一段渲染进程零 ≥${BUDGET.switchLongFrameMs}ms 长帧`
        + `(实测 ${loaf.long.length} 个,最长一帧 ${loaf.longest}ms)`,
    )

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
        // 第二趟也跟着这一档走(dev 时那台 vite 还开着 —— 它服务两趟壳)。
        ONETHING_REACT_DEV_SERVER_URL: rendererUrl,
        ONETHING_GATE_HEADLESS: '1',
        ONETHING_GATE_OFFSCREEN: '1',
        ONETHING_GATE_DOWNLOADS_DIR: downloadsDir,
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

    /*
     * ── ⑱ 代理:浏览器分区跟着设置走 ───────────────────────────────────────
     *
     * **自己一趟、自己一个 store**,两条理由:①代理要在 `hooks.afterSettings`
     * 那一拍就开着(启动那一次),所以它得写进 `settings.json` 再起壳 —— 往前面
     * 九步那个 store 里塞代理会把每一条断言都拖着走代理;②这一条量的是网络面,
     * 不要 UI,RPC 就够,于是也不必再占一趟 playwright。
     */
    console.log('\n[10/10] ⑱ 代理 —— 浏览器分区不许直连出网(真机报障 net_error -100)')
    const proxy = await startAccountingProxy()
    proxyServer = proxy
    const proxyStore = await mkdtemp(path.join(tmpdir(), 'browser-gate-proxy-store-'))
    proxyStoreDir = proxyStore
    writeFileSync(
      path.join(proxyStore, 'settings.json'),
      JSON.stringify({
        network: {
          proxy: {
            enabled: true,
            url: `http://127.0.0.1:${proxy.port}`,
            // 判词在文件头 ⑱ 上:空串 = Chromium 隐式放过 localhost = 这道门白判。
            bypassRules: '<-loopback>',
          },
        },
      }),
      'utf8',
    )
    child = spawn(electronBinary, [mainEntry, `--user-data-dir=${userDataDir}`], {
      env: {
        ...process.env,
        ONETHING_STORE_PATH: proxyStore,
        ONETHING_REACT_DEV_SERVER_URL: rendererUrl,
        ONETHING_GATE_HEADLESS: '1',
        ONETHING_GATE_OFFSCREEN: '1',
        ONETHING_GATE_DOWNLOADS_DIR: downloadsDir,
      },
      stdio: 'ignore',
    })
    const third = await waitFor(
      '⑱ 那一趟的 core 写出发现文件',
      () => {
        const found = readJson(path.join(proxyStore, 'run', 'http.json'))
        return found && found.owner === 'shell' ? found : undefined
      },
      40_000,
    )

    const viaProxy = await rpc(third, 'resources', 'do', {
      ref: 'browser:@all',
      op: 'open',
      params: { url: pageUrl('/viaproxy') },
    })
    assert(viaProxy.kind === 'ok', '⑱a resources.do open 成功(代理开着)')
    const proxiedTab = await waitFor(
      '⑱a 那一页载上来了',
      async () => {
        const tabs = await rpc(third, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' })
        const rows = tabs.value?.tabs ?? []
        return rows.some((r) => String(r.title).startsWith(NONCE)) ? rows : undefined
      },
      30_000,
    )
    /*
     * **尺子只量本地页那台服务器**。dev 档里壳自己的渲染层也跑在 loopback 上
     * (vite:5199 那几百个模块请求),`<-loopback>` 一关隐式放行它们也会经过这只
     * 代理 —— 那是这份门配置的副产品,不是被量的那件事;不筛的话断言的读数会被
     * 几百行 vite 模块淹掉,而「淹掉的读数」等于没有读数。
     */
    const pageHost = `127.0.0.1:${pages.port}`
    const onPage = (rows) => rows.filter((row) => row.host === pageHost)
    const brief = (rows) => rows.slice(0, 6).map((r) => r.host + r.path).join(' | ') || '空'
    const proxiedHits = onPage(proxy.seen).filter((row) => row.path.startsWith('/viaproxy'))
    report.proxy = { total: proxy.seen.length, onPage: onPage(proxy.seen).length, viaproxy: proxiedHits.length }
    assert(
      proxiedHits.length >= 1,
      `⑱a 记账代理上看见了那一发(本地页那台 ${onPage(proxy.seen).length} 条,`
        + `其中 /viaproxy ${proxiedHits.length} 条;头几条 ${brief(onPage(proxy.seen))})`
        + ' —— 空表 = 分区直连出网,正是这次报障的形'
        + `(载上来的标题 ${proxiedTab.map((r) => r.title).join(' / ')})`,
    )

    const settings18 = await rpc(third, 'settings', 'getSettings', {})
    const savedOff = await rpc(third, 'settings', 'saveSettings', {
      ...settings18.settings,
      network: {
        ...(settings18.settings?.network ?? {}),
        proxy: { enabled: false, url: '', bypassRules: '' },
      },
    })
    assert(savedOff.success === true, '⑱b 设置存上了(代理关掉)')
    const seenBeforeOff = proxy.seen.length
    const offTab = await rpc(third, 'resources', 'do', {
      ref: 'browser:@all',
      op: 'open',
      params: { url: pageUrl('/proxyoff') },
    })
    assert(offTab.kind === 'ok', '⑱b resources.do open 成功(代理关掉之后)')
    await waitFor(
      '⑱b 第二页也载上来了',
      async () => {
        const tabs = await rpc(third, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' })
        const rows = tabs.value?.tabs ?? []
        return rows.length >= 2 && rows.every((r) => String(r.title).startsWith(NONCE)) ? rows : undefined
      },
      30_000,
    )
    const afterOff = onPage(proxy.seen.slice(seenBeforeOff))
    report.proxyAfterOff = afterOff.length
    assert(
      afterOff.every((row) => !row.path.startsWith('/proxyoff')),
      `⑱b 关掉之后那一发**没有**走代理(关后本地页那台新增 ${afterOff.length} 条:`
        + `${brief(afterOff)})`
        + ' —— 有它 = 改设置没重套到已经建出来的那格分区(宿主表 `settings` 那一格)',
    )
    child.kill('SIGTERM')
    await delay(1200)
    child = undefined

    console.log(`\n[browser-gate] ok(${LANE} 档)—— 十八条全过`)
    console.log(`[browser-gate] 读数:${JSON.stringify(report)}`)
  } finally {
    if (app) await app.close().catch(() => {})
    if (child) { try { child.kill('SIGKILL') } catch { /* 已经走了 */ } }
    if (vite) await vite.close().catch(() => {})
    if (pages) await new Promise((resolve) => pages.server.close(resolve))
    if (proxyServer) await new Promise((resolve) => proxyServer.server.close(resolve))
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
    await rm(downloadsDir, { recursive: true, force: true })
    if (proxyStoreDir) await rm(proxyStoreDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('\n[browser-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
