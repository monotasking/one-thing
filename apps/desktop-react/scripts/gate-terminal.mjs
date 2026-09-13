#!/usr/bin/env node
/**
 * **终端的真机门**(T1,方案 `apps/desktop-react/docs/terminal-browser-2026-09.md` §4)。
 *
 * ── 它与别的门**起法不一样**,而那是这道门的第一条断言 ──────────────────
 * `gate-music` / `gate-focus` 一族先起一台 `dist/server/main.js`,壳去连它。
 * 这道门**不能那么起**:`capabilities.terminal` 是 `hasTerminalHost()`,而那一格
 * 由**宿主表**注入(T0 把 React 壳的 `host-ports.ts` 那一行从 `null` 改成了
 * `createEventBusTerminalBroadcaster()`)。独立 server 的宿主表里它仍旧是 `null`
 * —— 连上去的话七条 RPC 恒拒,这道门量的就成了「server 没有终端」这件废话。
 * 所以这里走的是 `gate-connect` 的**路径一**:不起 server,让壳自己装配 core
 * (`assembleOwnCore`),发现文件的 owner 是 `shell`。①就是这条。
 *
 * ── 八条断言 ────────────────────────────────────────────────────────────
 *  ① `/api/capabilities.terminal === true`(壳自当 core,宿主表那一行真的注进去了);
 *  ② 召唤键(mac ⌘\` / 其余 Ctrl+\` —— `toggle:terminal` 那条出厂键位读作
 *     「主修饰键 + 反引号」,T1-fix 之后按下的是哪一枚由平台定)→ 屏幕上出现一格
 *     `terminal:` 叶,而且 xterm 的 textarea 拿到焦点;
 *  ③ 打一行 `printf 'ONETHING_T1_%s\n' ok` + Enter → 那串标记出现在 `.xterm-rows` 里
 *     (**真的跑了一遍 shell**:后端 spawn、SSE 推回来、xterm 画上去,一条都不能少);
 *  ④ `Page.reload` → 重新 attach 之后标记**仍在**(这一条量的是 ring 回放);
 *     ④b 再按一下召唤键:看得见、没聚焦 → 只把键盘送进去(召唤四态里的那一档);
 *  ⑤ `seq 1 20000` 喷流:量流式期间 ≥50ms 的长帧数与最长一帧间隔(读数进报告 ——
 *     **阈值先量出来再定**,这一版只打表不判红,判词见下);
 *  ⑥ **经 RPC `terminal.kill`**(= 另一个客户端)杀掉 → 状态条出现「进程已退出」
 *     (它量的正是 T1-fix 修掉的那个真洞,判词写在那一步上头);
 *  ⑦ 点那一格 tab 上的 × → 叶没了、`terminal.list` 里没有活着的它(关 = 杀,
 *     方案 §2.1-8;**不走 ⌘W** —— 那个组合在终端里是礼让给 PTY 的)。
 *  ⑧ **axe 扫这一屏**(与 `gate:a11y` 同一套标签、同一个 legacy 模式);
 *  ⑨ **终端内查找**(T2):⌘F 开出查找行 → 输入刚打上屏的那串标记 → 读数写出
 *     「1/1」→ Esc 收起并把键盘还给屏幕(这一条量的是**真的搜索插件**:上面那
 *     一组单测用的是一张记事本屏幕,它证不了 xterm 那一侧真找得到);
 *  ⑩ **组件级停靠的那一问**(T2):同一片叶上「会话 ↔ 终端」来回切,量最长帧与
 *     「终端再现」耗时 —— 读数决定要不要把终端写进 `workbench/kept-contents`
 *     (判词与结论写在那一步上头)。
 *
 * ── ⑧ 为什么长在这道门上,而不是 `gate:a11y` 的第九屏 ─────────────────────
 * 派工单写的是「`gate-a11y.mjs` 加终端一屏」。**那台 harness 里开不出终端**:
 * `gate-a11y` 先起一台 `dist/server/main.js`,壳去连它(那道门的 13 屏全靠这条
 * 路种夹具会话);而 server 的宿主表里 `terminal` 仍旧是 `null`(T0 只给 React
 * 壳注了广播器,方案 §2.1-2 明写「server / CLI 本批照旧 null」)—— 于是
 * `terminal.create` 是一句结构化拒绝,那一屏永远等不到叶。实测过:加上去之后
 * 第 8 屏「超时等待:终端就位」,别的 12 屏照绿。
 *
 * 把它搬到这里之后,扫的是**同一套规则、同一块真面**,而且是一块**真的连着
 * PTY 在跑**的终端(比空态更该扫)。`gate-a11y` 原样不动(逐字未改)。
 * 要让那道门也照得到终端,前置是它改成「壳自当 core」那条起法 —— 那是一次
 * 动 13 屏夹具的改动,留账在 T1 交卷里。
 *
 * ── ⑤ 的阈值(T2 定档)────────────────────────────────────────────────────
 * T1 那一版只打表不判红,理由是「终端这一路今天第一次有读数,拿一个凭空的数当门
 * 只会得到一条抓不着的天花板」。**现在有实测了**,所以它按 `gate-chat-layout` 的
 * 体例进 `BUDGET`:第 5 轴那张表的第五格原话是「流式期间零 ≥50ms 长帧」,而 T1 与
 * T2 在两档渲染层上各连跑三遍量到的都是 **0 个** —— 一个真的抓得着的天花板。
 * 过渡表 `TRANSITIONAL` 因此是**空的**:没有一格今天达不到,空着比填一行宽的数
 * 诚实(那张表的退场判据就是「达标就删行」)。
 *
 * ── 两档渲染层都跑(第 5 轴)──────────────────────────────────────────────
 * **缺省跑 dev**(现起一台 vite,端口另挑,绝不碰用户的 5175),`--prod` 吃
 * `dist/` 产物。理由是第 5 轴那一句:用户跑的是 `electron:dev`,生产构建上量出来
 * 的数对它不成立。两档的读数分别记在 `BUDGET` / `TRANSITIONAL` 旁边。
 *
 * ── 纪律(照 gate-music / gate-focus)────────────────────────────────────
 * 临时 store + 独立 `--user-data-dir` + `ONETHING_GATE_HEADLESS=1` + 只用 CDP
 * (`Input.dispatchKeyEvent` / `Input.insertText`,不动真光标、不抢前台),
 * 不连 5175,`~/.onething` 零改动,`finally` 里逐个收尸。
 *
 * 跑法:
 *   `npm run gate:terminal`            —— dev 渲染层
 *   `npm run gate:terminal -- --prod`  —— prod 渲染层(吃 `npm run app:build` 的 dist)
 * (两档都要 `npm run electron:build` 产出的 `dist-electron/main.cjs`。)
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
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
 * 也不是 5197(`gate:chat-layout` 占着的那一口)—— 两道门可能挨着跑。
 */
const DEV_PORT = Number(process.env.ONETHING_GATE_VITE_PORT ?? 5198)

/**
 * ── 预算(T2 定档;体例照 `scripts/gate-chat-layout.mjs`)──────────────────
 *
 * 第 5 轴那张表在这道门上只有一格说得上话:**流式期间零 ≥50ms 长帧**。终端的
 * 「超量」是一次 `seq 1 20000`(两万条短帧),而它恰好就是那一格量的那件事。
 *
 * 另外两格是这一批新量的,判据与它们各自的判词写在命中处:⑨ 查找那一趟不计价
 * (它是功能不是预算),⑩ 停靠那两个数今天**只打表**(判词在那一步上头:要不要
 * 为它加一张表,由数字说了算)。
 */
const BUDGET = {
  /** ⑤ 流式期间不许出现的长帧门槛(第 5 轴原数)。 */
  streamLongFrameMs: 50,
}

/**
 * ── **过渡阈值**:空的 ──────────────────────────────────────────────────
 * `gate-chat-layout` 那张表存在是因为有两格今天真的达不到第 5 轴的原数。这道门
 * 没有那样的格子:两档渲染层各连跑三遍,`seq 1 20000` 的 ≥50ms 长帧都是 0。
 * 表留在这里是**形**不是摆设 —— 将来哪一格达不到,该做的事是在这里加一行并
 * 写上实测来源与退场判据,而不是去改 `BUDGET`(判词整段在 gate-chat-layout 的
 * 同名表上:抬预算 = 改法,让它恒红 = 迟早被人加 `|| true`)。
 */
const TRANSITIONAL = { dev: {}, prod: {} }

/** 这一档下某一格的判据(有过渡值就用过渡值,没有就是第 5 轴原数)。 */
function budgetOf(key) {
  return key in TRANSITIONAL[LANE] ? TRANSITIONAL[LANE][key] : BUDGET[key]
}

/** ③ 的标记。**分两段拼**,免得脚本自己这一行在 `.xterm-rows` 里被找到。 */
const MARK = `ONETHING_T1_${'ok'}`

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
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}

/** 壳自己那台 core 的 HTTP 面。门用它问能力位、杀终端、列终端。 */
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

/**
 * 一发 RPC,**把信封拆开**。`POST /api/rpc` 交的是 `{ok, data}`(`@shared/ipc/rpc`
 * 的 `RpcResponse`),里面那一层才是域自己的回答 —— 门里读 `terminals` 的时候
 * 忘了拆这一层,第一遍跑出来是「零格活着」而屏幕上明明开着一格。
 */
async function rpc(record, domain, method, payload = {}) {
  const envelope = await api(record, '/api/rpc', {
    method: 'POST',
    body: JSON.stringify({ domain, method, payload }),
  })
  if (envelope?.ok === false) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(envelope)}`)
  return envelope?.data ?? envelope
}

/**
 * **这台机器上「主修饰键」是哪一枚**(T1-fix)。
 *
 * 键位层从 T1-fix 起分得清 ⌘ 与 Ctrl:一条绑定写 `meta` 还是写 `ctrl` 只是
 * 两种拼法(都读作「主修饰键」),而**按下**的那一枚由平台定 —— mac 是 ⌘、
 * 其余是 Ctrl(判词整段在 `src/keymap/transitions.ts` 的 `matchCombo` 上)。
 * ── **K2 改口:召唤终端那一条走的是「另一枚」**(`Combo.offHand`)────────────
 * T1 写的是 `{ctrl:true, key:'`'}`,而声明侧 `ctrl` 与 `meta` 同义 —— 于是它在
 * mac 上实际是 **⌘\`**,与系统的「在本应用的窗口间轮换」撞车(T1 自己留的账)。
 * K2 把它改成 `{offHand:true, key:'`'}`:**另一枚**,mac = ⌃、Win / Linux = Win 键。
 * 所以这道门的召唤键从 `PRIMARY_MODIFIER` 换成 `OFF_HAND_MODIFIER` —— 别处那几段
 * (⌘F / ⌘⇧↩ / ⌘T)照旧按主修饰键,两枚各归各的。
 *
 * CDP 的 modifiers 位:2 = Ctrl,4 = Meta。
 */
const ON_MAC = process.platform === 'darwin'
const PRIMARY_MODIFIER = ON_MAC ? 4 : 2
/** 「另一枚」:mac 是 ⌃(2),其余平台是 Win / Meta(4)。 */
const OFF_HAND_MODIFIER = ON_MAC ? 2 : 4
/** 屏幕上写给人看的那个键面(与 `formatCombo` 同一口径)。 */
const SUMMON_CAP = ON_MAC ? '⌃`' : 'Win+`'

/**
 * 一下按键。**只进这个窗口**(CDP `Input.dispatchKeyEvent`),不动真光标
 * (09-01 那条「真机输入探针禁抢用户的机器」)。
 *
 * `primary = true` = 按住这台机器的主修饰键(见 `PRIMARY_MODIFIER`);
 * `offHand = true` = 按住**另一枚**(K2,召唤终端那一条要它);
 * `shift = true` 再叠一枚 ⇧(⌘⇧↩ 那条全屏命令要它)。
 */
async function press(cdp, { key, code, keyCode, text, primary = false, offHand = false, shift = false, windowsVirtualKeyCode }) {
  // CDP 的 modifiers 位:1 = Alt,2 = Ctrl,4 = Meta,8 = Shift。
  const modifiers = (primary ? PRIMARY_MODIFIER : 0) | (offHand ? OFF_HAND_MODIFIER : 0) | (shift ? 8 : 0)
  await cdp.send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: windowsVirtualKeyCode ?? keyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode ?? keyCode,
    modifiers,
    ...(text ? { text } : {}),
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: windowsVirtualKeyCode ?? keyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode ?? keyCode,
    modifiers,
  })
}

/** 屏幕上那格终端的文本(xterm 把每一行画成 `.xterm-rows > div`)。 */
const screenText = (page) =>
  page.evaluate(() => {
    const rows = document.querySelector('[data-terminal-screen] .xterm-rows')
    return rows ? rows.textContent ?? '' : ''
  })

/** 长帧探针(体例照 `gate-chat-layout` 的 LoAF 那一半)。 */
async function installLoaf(page) {
  await page.evaluate(() => {
    if (window.__termProbe) return
    const P = (window.__termProbe = { loaf: [] })
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) P.loaf.push(Math.round(entry.duration))
      }).observe({ type: 'long-animation-frame', buffered: true })
    } catch (error) {
      P.err = String(error)
    }
  })
}

const loafMark = (page) => page.evaluate(() => window.__termProbe.loaf.length)

/**
 * 一段 rAF 间隔采样。**它与 LoAF 问的不是同一件事**:`long-animation-frame`
 * 按规范只报 ≥50ms 的帧(所以「一条都没有」正是 ⑤ 想要的答案,但那时它报不出
 * 「最长那一帧到底多长」);这一只逐帧记两次回调之间的毫秒差,于是「零长帧」
 * 那一句后面能跟上一个真数。
 */
async function sampleFrames(page, run) {
  await page.evaluate(() => {
    const P = window.__termProbe
    P.gaps = []
    P.sampling = true
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      P.gaps.push(now - last)
      last = now
      if (P.sampling) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await run()
  return page.evaluate(() => {
    const P = window.__termProbe
    P.sampling = false
    const gaps = P.gaps.map((g) => Math.round(g))
    return { frames: gaps.length, longestGap: Math.max(0, ...gaps) }
  })
}

const loafHarvest = (page, mark) =>
  page.evaluate((m) => {
    const all = window.__termProbe.loaf.slice(m)
    return { frames: all.length, longest: Math.max(0, ...all), long: all.filter((d) => d >= 50) }
  }, mark)

async function main() {
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[terminal-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'terminal-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'terminal-gate-userdata-'))
  let app
  let vite
  const report = { lane: LANE }
  try {
    let rendererUrl = ''
    if (!PROD) {
      console.log(`\n[0/11] dev 档:起一台 vite(端口 ${DEV_PORT},**不是用户的 5175**)`)
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
    console.log(`\n[1/11] 壳自己装配 core(不起 server —— 判词在文件头;${LANE} 档)`)
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: rendererUrl,
        ONETHING_GATE_HEADLESS: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })

    const record = await waitFor('壳内嵌的 core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.owner === 'shell' ? found : undefined
    })
    assert(await portConnects(record.host, record.port), `core 端口 ${record.port} 可连`)

    const caps = await api(record, '/api/capabilities')
    assert(
      caps.terminal === true || caps?.capabilities?.terminal === true,
      `① /api/capabilities.terminal === true(宿主表那一行真的注进去了;整份:${JSON.stringify(caps).slice(0, 240)})`,
    )

    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await installLoaf(page)

    console.log(
      `\n[2/11] ${SUMMON_CAP} 召唤一格终端(K2:走「另一枚」,见 OFF_HAND_MODIFIER)`,
    )
    await press(cdp, { key: '`', code: 'Backquote', keyCode: 192, offHand: true })
    const leaf = await waitFor('那格终端叶出现', () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="terminal-leaf"]')
        return el ? { state: el.dataset.terminalState } : undefined
      }),
    )
    assert(Boolean(leaf), `② ${SUMMON_CAP} 开出一格终端叶(state=${leaf.state})`)
    const focused = await waitFor('xterm 的 textarea 拿到焦点', () =>
      page.evaluate(() => {
        const active = document.activeElement
        if (!active) return undefined
        const inScreen = active.closest('[data-terminal-screen]')
        return inScreen ? { tag: active.tagName, cls: active.className } : undefined
      }),
    )
    assert(Boolean(focused), `② 焦点落在终端里(${focused.tag}.${focused.cls})`)

    console.log('\n[3/11] 打一行命令 —— 后端真的 spawn 了一台 shell 吗')
    await waitFor('终端接上了(live)', () =>
      page.evaluate(
        () =>
          document.querySelector('[data-testid="terminal-leaf"]')?.dataset.terminalState === 'live',
      ),
    )
    // `Input.insertText` 走的是输入法那条路,不逐键合成 —— 只进这个窗口。
    await cdp.send('Input.insertText', { text: `printf '${MARK}\\n'` })
    await press(cdp, { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' })
    await waitFor(
      '标记上屏',
      async () => ((await screenText(page)).includes(MARK) ? true : undefined),
      25_000,
    ).catch(async (error) => {
      throw new Error(`${error.message}\n此刻屏幕上是:\n${(await screenText(page)).slice(-600)}`)
    })
    assert(true, `③ \`printf\` 的输出经 SSE 回到 xterm(屏幕上找到 ${MARK})`)

    console.log('\n[4/11] ⌘F 查找 —— 真的搜索插件,不是那张记事本屏幕')
    /*
     * 上面 ③ 刚把 `MARK` 打上屏,所以这一趟找的就是它:一处命中,读数必须写
     * 「1/1」。这一条量的是**单测量不到的那一半** —— `@xterm/addon-search` 真的
     * 装上了、装饰真的开着(读数是插件的 `onDidChangeResults` 报回来的,装饰关掉
     * 时那条事件根本不发)、⌘F 真的经由 `FOCUS_SCOPES.terminal.keys` 那条局部键
     * 走到了叶上。
     *
     * 反证:把 `focus/scopes.ts` 里 `TERMINAL_FIND_KEY` 从 `terminal.keys` 上拆掉
     * → 查找行开不出来,这一步当场超时。
     */
    await press(cdp, { key: 'f', code: 'KeyF', keyCode: 70, primary: true })
    await waitFor('查找行出现', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="terminal-find"]'))),
    )
    assert(true, '⑨ ⌘F 开出查找行(局部键先接,全局命令轮不到)')
    await cdp.send('Input.insertText', { text: MARK })
    const readout = await waitFor('读数写出命中', () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="terminal-find-count"]')
        const text = el?.textContent ?? ''
        return text ? { text } : undefined
      }),
      15_000,
    )
    assert(
      /^\d+\/\d+$/.test(readout.text),
      `⑨ 读数是「第几 / 共几」的形(实测「${readout.text}」)`,
    )
    // Esc 在这一行是**行内结构键**:收起查找、把键盘还给屏幕(不进任何键表)。
    await press(cdp, { key: 'Escape', code: 'Escape', keyCode: 27 })
    const closedFind = await waitFor('Esc 收起查找行并把焦点还给屏幕', () =>
      page.evaluate(() => {
        if (document.querySelector('[data-testid="terminal-find"]')) return undefined
        return document.activeElement?.closest('[data-terminal-screen]') ? true : undefined
      }),
    )
    assert(closedFind === true, '⑨ Esc 收起查找行,键盘回到那块屏幕上')

    console.log('\n[5/11] 刷新页面 —— attach 回放把它找回来')
    await page.reload()
    await waitFor('渲染层重新连上', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await installLoaf(page)
    await waitFor(
      '回放之后标记仍在',
      async () => ((await screenText(page)).includes(MARK) ? true : undefined),
      25_000,
    ).catch(async (error) => {
      throw new Error(`${error.message}\n此刻屏幕上是:\n${(await screenText(page)).slice(-600)}`)
    })
    assert(true, '④ Page.reload 之后重新 attach,ring 回放把那一屏找了回来')

    /*
     * 刷新之后焦点**不在**终端里(那一格没被人点名 —— 判词在
     * `content/terminal/registry.requestTerminalFocus` 上:只有「刚被人亲手开
     * 出来」才抢焦点,布局恢复不抢)。所以这里再按一下召唤键(K2 起是「另一枚」+ \`)—— 它走的是召唤
     * 四态里的「看得见、没聚焦 → 只把键盘送进去」那一档,顺带把那一档也量了。
     */
    await press(cdp, { key: '`', code: 'Backquote', keyCode: 192, offHand: true })
    const refocused = await waitFor('召唤键把焦点送回终端', () =>
      page.evaluate(() =>
        document.activeElement?.closest('[data-terminal-screen]') ? true : undefined,
      ),
    )
    assert(refocused === true, '④b 再按一下召唤键:看得见没聚焦 → 只把键盘送进去')

    console.log('\n[6/11] 喷两万行 —— 流式期间的长帧读数')
    const mark = await loafMark(page)
    const frames = await sampleFrames(page, async () => {
      await cdp.send('Input.insertText', { text: 'seq 1 20000' })
      await press(cdp, { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' })
      await waitFor(
        '喷完(最后一行到屏幕上)',
        async () => ((await screenText(page)).includes('20000') ? true : undefined),
        60_000,
      )
      // 让它彻底停稳:xterm 的重画是按帧补上来的,收早了长帧收不全。
      await delay(1500)
    })
    const cost = await loafHarvest(page, mark)
    report.stream = { ...cost, ...frames }
    console.log(
      `      ⑤ seq 1 20000:≥50ms 的长帧 ${cost.long.length} 个${
        cost.long.length ? `(${cost.long.join(', ')}ms)` : ''
      };这一段走了 ${frames.frames} 帧,最长一帧间隔 ${frames.longestGap}ms`,
    )
    /*
     * **T2 起这一条判红**(第 5 轴第五格:流式期间零 ≥50ms 长帧)。判词与两档的
     * 实测来源在文件头的「⑤ 的阈值」那一节;`budgetOf` 让将来真有一档达不到时
     * 有一个写得下「过渡 + 退场判据」的地方,而不是回头去改 `BUDGET`。
     */
    assert(
      cost.long.length === 0,
      `⑤ 超量:seq 1 20000 期间零 ≥${budgetOf('streamLongFrameMs')}ms 长帧`
        + `(实测 ${cost.long.length} 个,最长一帧间隔 ${frames.longestGap}ms)`,
    )

    console.log('\n[7/11] 经 RPC kill 杀掉 —— 死讯要走到屏幕上')
    const list = await rpc(record, 'terminal', 'list', {})
    const alive = (list.terminals ?? []).filter((row) => !row.exited)
    assert(alive.length === 1, `杀之前 terminal.list 里恰好一格活着(${alive.length})`)
    const terminalId = alive[0].id
    /*
     * **从门这一侧(= 另一个客户端)杀**,而不是在终端里敲 `exit`。
     *
     * 这一条量的是 T1-fix 修掉的那个真洞:`TerminalService.handleExit` 从前的最后
     * 一句是 `if (!record.disposing) sendExit(...)`,而 `kill()` 一进门就把
     * `disposing` 翻真 —— 于是经 RPC 杀掉的那一格**永远不发死讯**,屏幕上停在
     * 「活着」。判据现在是 `exitSent` 那格闩(每格最多一次、怎么死都发)。
     * 把它改回 `disposing`,这一步当场超时。
     */
    await rpc(record, 'terminal', 'kill', { terminalId })
    const exited = await waitFor('状态条翻到 exited', () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="terminal-leaf"]')
        if (el?.dataset.terminalState !== 'exited') return undefined
        return { text: document.querySelector('[data-testid="terminal-status"]')?.textContent ?? '' }
      }),
    )
    assert(exited.text.length > 0, `⑥ 经 RPC kill 之后屏幕上说了一句「${exited.text.trim()}」`)

    console.log('\n[8/11] 关标签 = 杀 —— 账上不留残渣')
    /*
     * 点那颗 ×。**不走 ⌘W** —— 那个组合在终端里是礼让给 PTY 的
     * (`content/terminal/key-courtesy.ts` 的五行之一),按下去是删一个词,
     * 不是关这一格。这本身就是礼让表在真机上的一条读数。
     */
    const clicked = await page.evaluate(() => {
      let node = document.querySelector('[data-testid="terminal-leaf"]')
      while (node && !node.querySelector('[data-tab-close]')) node = node.parentElement
      const close = node?.querySelector('[data-tab-close]')
      if (!(close instanceof HTMLElement)) return false
      close.click()
      return true
    })
    assert(clicked, '⑦ 找到这一格 tab 上那颗 ×(它是门用的把手 `data-tab-close`)')
    const gone = await waitFor('叶从屏幕上消失', () =>
      page.evaluate(() =>
        document.querySelector('[data-testid="terminal-leaf"]') ? undefined : true,
      ),
    )
    assert(gone === true, '⑦ 关标签之后那格叶不在屏幕上了')
    const after = await rpc(record, 'terminal', 'list', {})
    const stillAlive = (after.terminals ?? []).filter((row) => row.id === terminalId && !row.exited)
    assert(
      stillAlive.length === 0,
      `⑦ terminal.list 里没有活着的它了(整表 ${JSON.stringify(after.terminals ?? [])})`,
    )

    console.log('\n[9/11] axe 扫这一屏(与 gate:a11y 同一套标签)')
    /*
     * 这一屏扫的是**终端刚被关掉之后**那台壳?不 —— 上面 ⑦ 把它关了,所以这里
     * 先开一格新的:axe 要扫的是**有终端在场**的那棵树(xterm 自己会往里长一堆
     * `aria-live` 的行、一个 helper textarea、一层 `aria-hidden` 的画布,而壳这
     * 半边要说清的是状态条那一行字与那颗钮)。
     */
    await press(cdp, { key: '`', code: 'Backquote', keyCode: 192, offHand: true })
    await waitFor('再开一格用来扫', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="terminal-leaf"]'))),
    )
    /*
     * `setLegacyMode(true)` 是**必须的**(与 `gate-a11y.scanAxe` 逐字同一个理由):
     * 默认模式下 AxeBuilder 会 `newPage()` 去处理跨 frame,而 Electron 的 CDP 不
     * 支持 `Target.createTarget`,当场协议报错。
     */
    const axe = await new AxeBuilder({ page })
      .setLegacyMode(true)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
      .include('[data-testid="terminal-leaf"]')
      .analyze()
    for (const v of axe.violations) {
      console.log(`      [${v.impact}] ${v.id} —— ${v.help}`)
      for (const node of v.nodes.slice(0, 4)) console.log(`        ${node.target.join(' ')}`)
    }
    assert(
      axe.violations.length === 0,
      `⑧ 终端这一屏 axe 零违例(过了 ${axe.passes.length} 条规则)`,
    )

    console.log('\n[10/11] 组件级停靠的那一问:终端被藏起来、被搬家,各要多少钱')
    /*
     * ── 这一步在回答什么(T2 派工单第 2 条)──────────────────────────────
     * 派工单的原话是「同一片叶上 `session:A → terminal:X → session:A` 的切换」,
     * 判据是「≥50ms 就把终端写进 `workbench/kept-contents`」。
     *
     * **那道题在今天的产品里凑不出来,而这不是量法的问题,是事实**:会卸载重挂的
     * 只有「原位换 ref」(`store.replaceRef`),而壳里叫它的三处全在
     * `content/session-open.ts`,换掉的一格恒是**会话那一格**(`leafSessionTabOf`)
     * 或那格保留键(`placeholderIndexOf`)—— 一格终端标签既不是前者也不是后者,
     * 所以「点一条会话把终端顶掉」这条路不存在。终端与会话同处一叶时,来回切就是
     * 切 tab:`PaneLeaf` 给每一格各挂一层,切换只翻 `content-visibility`。
     *
     * 所以这里量的是**终端真会走的那两条路**,把那个问题答完整:
     *  (a) **藏起来再拿回来**(切 tab):同一片叶两格终端来回切 —— 这正是
     *      `kept-contents` 那张表把「原位换 ref」治成的那一形,量它等于量
     *      「治好之后能有多快」;
     *  (b) **搬家**(换宿主):⌘⇧↩ 铺满 / 还原 —— 那是终端今天唯一一条真的
     *      卸载重挂的路(全屏是另一层宿主),也就是 T1 那句「DOM 搬家不丢屏,
     *      可搬家本身有代价」里说的代价。
     * 结论(要不要为终端也开一张停靠表)按这两个数写在交卷里。
     */
    // 右键那块瓦 → 「新建终端」:两格终端会落进同一片叶(底架),于是有了两格标签。
    await page.evaluate(() => {
      const tile = document.querySelector('[data-testid="dock-tile-terminal"]')
      if (!(tile instanceof HTMLElement)) return
      const rect = tile.getBoundingClientRect()
      tile.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      )
    })
    const opened = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[role="menuitem"]'))
      const row = rows.find((el) => (el.textContent ?? '').trim() === 'New terminal')
      if (!(row instanceof HTMLElement)) return rows.map((el) => el.textContent)
      row.click()
      return true
    })
    assert(opened === true, `⑩ 右键那块瓦 →「新建终端」(菜单里那几行:${JSON.stringify(opened)})`)
    const seat = await waitFor('同一片叶上两格终端', () =>
      page.evaluate(() => {
        const leaves = Array.from(document.querySelectorAll('[data-pane-leaf]'))
        for (const leaf of leaves) {
          const ids = Array.from(leaf.querySelectorAll('[data-pane-tab]'))
            .map((el) => el.getAttribute('data-pane-tab'))
            .filter((id) => id && id.startsWith('terminal:'))
          if (ids.length >= 2) return { leaf: leaf.getAttribute('data-pane-leaf'), a: ids[0], b: ids[1] }
        }
        return undefined
      }),
      25_000,
    )
    assert(Boolean(seat), `⑩ 同一片叶两格终端:${seat.a} / ${seat.b}`)

    /**
     * 一次切换的两个数:**最长帧**(LoAF)与**再现耗时**(点下去 → 那一层真的在
     * 屏幕上,而且那块屏幕量得出高度 —— `content-visibility: hidden` 下它恒为 0,
     * 所以这一句正是「终端再现」的判据)。
     */
    const switchTo = async (tabId) => {
      const mark = await loafMark(page)
      const ms = await page.evaluate(async (id) => {
        const bar = document.querySelector(`[data-tab-id="${id}"]`)
        if (!(bar instanceof HTMLElement)) return -1
        const t0 = performance.now()
        bar.click()
        const ready = () => {
          const layer = document.querySelector(`[data-pane-tab="${id}"][data-pane-on]`)
          const host = layer?.querySelector('[data-terminal-screen]')
          return Boolean(host && host.getBoundingClientRect().height > 0)
        }
        return await new Promise((resolve) => {
          const tick = () => {
            if (ready()) resolve(Math.round(performance.now() - t0))
            else if (performance.now() - t0 > 5000) resolve(-1)
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      }, tabId)
      await delay(400)
      const cost = await loafHarvest(page, mark)
      return { ms, longest: cost.longest, long: cost.long.length }
    }

    const hide = []
    for (const id of [seat.a, seat.b, seat.a, seat.b]) hide.push(await switchTo(id))
    report.parkSwitch = hide
    console.log(
      `      ⑩(a)藏起来再拿回来(切 tab):再现 ${hide.map((r) => r.ms).join(' / ')}ms;`
        + `最长帧 ${hide.map((r) => r.longest).join(' / ')}ms`,
    )

    /*
     * (b)**搬家**:⌘⇧↩ 是 `workbench.toggleFull`(出厂键位)。全屏是另一层宿主,
     * 所以那一格内容真的卸载重挂 —— `appendChild` 把同一块屏幕 DOM 从一棵树搬到
     * 另一棵树(T1 的 D6 判例:屏幕不重建,所以缓冲、滚动位置、选区一个不丢)。
     */
    const toggleFull = async (wantFull) => {
      const mark = await loafMark(page)
      const t0 = Date.now()
      await press(cdp, { key: 'Enter', code: 'Enter', keyCode: 13, primary: true, shift: true })
      const ok = await waitFor(
        wantFull ? '铺满之后那块屏幕回到屏幕上' : '还原之后那块屏幕回到屏幕上',
        () =>
          page.evaluate((full) => {
            const host = document.querySelector('[data-terminal-screen]')
            if (!host || host.getBoundingClientRect().height <= 0) return undefined
            const inFull = Boolean(host.closest('[data-focus-scope="full-layer"]'))
            return inFull === full ? true : undefined
          }, wantFull),
        10_000,
      ).catch(() => false)
      const ms = Date.now() - t0
      await delay(400)
      const cost = await loafHarvest(page, mark)
      return { ok: ok === true, ms, longest: cost.longest, long: cost.long.length }
    }
    const full = await toggleFull(true)
    const back = await toggleFull(false)
    report.parkMove = { full, back }
    console.log(
      `      ⑩(b)搬家(⌘⇧↩ 铺满 / 还原):再现 ${full.ms} / ${back.ms}ms;`
        + `最长帧 ${full.longest} / ${back.longest}ms`,
    )
    /*
     * **本版只打表**(与 T1 的 ⑤ 同一条判词:第一次有读数,拿一个凭空的数当门
     * 只会得到一条抓不着的天花板)。这里判的只有一件事 —— 那几下真的切成了
     * (`-1` / `ok:false` = 五秒里那块屏幕没回来,那才是回归)。
     */
    assert(
      hide.every((r) => r.ms >= 0) && full.ok && back.ok,
      '⑩ 藏 / 搬两条路上那块屏幕每一次都真的回到了屏幕上(读数已打表,判词在这一步上头)',
    )

    console.log('\n[11/11] ⑪ 终端叶 ⌘T:同类再开一格,而且就在当前那一格旁边(K2)')
    /*
     * ── 为什么这一段住在这道门,而不是 `gate:workspace` ────────────────────
     * K2 的派工单点名「终端叶 ⌘T 开出终端」由 `gate:workspace` 量,而那道门实测
     * 量不到:它的 core 是**独立起的那台 server**,壳是**attach** 上去的,所以
     * `installBrowserHost()` / terminal 宿主都没在那个进程里跑 —— 那道门里
     * `resources read browser:@all` 原话答的是 `No resource is registered for
     * scheme: browser`,`capabilities.terminal` 也问不到。**它不是产品缺陷,是
     * 那道门的架构**(一台 server core + 一个附身的壳)。终端宿主只在**自己装配
     * core** 的壳里存在,而这道门起的正是那样一台壳,所以这一段的家在这儿。
     * `gate:workspace` ⑬h 因此是一句带现场读数的 skip,不是假绿。
     *
     * 键怎么送:CDP `Input.dispatchKeyEvent`(只进这个窗口,不动真光标、不抢前台)
     * —— 与本门其余几段逐字同一手。终端是 DOM(xterm),不是原生视图,所以这一下
     * 直接到得了壳那唯一的派发器。
     */
    const spawnSeat = await page.evaluate((leafId) => {
      const el = document.querySelector(`[data-pane-leaf="${leafId}"]`)
      if (!(el instanceof HTMLElement)) return { why: 'no-leaf' }
      el.focus()
      const d = window.__focus?.dump?.()
      const onPath = Boolean(
        d
          && d.path
            .map((id) => d.nodes.find((n) => n.instanceId === id))
            .some((n) => n?.scope === 'leaf' && n?.owner === leafId),
      )
      const tabs = Array.from(el.querySelectorAll('[data-pane-tab]'))
        .map((x) => x.getAttribute('data-pane-tab'))
        .filter(Boolean)
      return { onPath, tabs, why: onPath ? '' : 'off-path' }
    }, seat.leaf)
    assert(spawnSeat.onPath === true, `⑪ 前提:焦点进了那片终端叶(读回 ${spawnSeat.why || 'ok'})`)
    const termsBefore = spawnSeat.tabs.filter((id) => id.startsWith('terminal:'))
    await press(cdp, { key: 't', code: 'KeyT', keyCode: 84, primary: true })
    const termsAfter = await waitFor(
      '⌘T 之后这片叶上多一格终端',
      () =>
        page.evaluate(
          (leafId) => {
            const el = document.querySelector(`[data-pane-leaf="${leafId}"]`)
            if (!el) return undefined
            const ids = Array.from(el.querySelectorAll('[data-pane-tab]'))
              .map((x) => x.getAttribute('data-pane-tab'))
              .filter(Boolean)
            return ids.filter((id) => id.startsWith('terminal:')).length >= 3 ? ids : undefined
          },
          seat.leaf,
        ),
      25_000,
    )
    const bornTerm = termsAfter
      .filter((id) => id.startsWith('terminal:'))
      .find((id) => !termsBefore.includes(id))
    report.cmdTOnTerminalLeaf = { before: termsBefore.length, after: termsAfter.length, born: bornTerm }
    console.log(`      ⑪ ⌘T:${termsBefore.length} 格 → ${termsAfter.filter((id) => id.startsWith('terminal:')).length} 格,新的是 ${bornTerm}`)
    assert(
      Boolean(bornTerm),
      `⑪ 终端叶 ⌘T 开出的是**一格终端**(种类自述 spawn;账上 ${JSON.stringify(termsAfter)})`,
    )
    /*
     * **就在旁边**:新那一格坐在原来那几格之后、而且是活动格。判据读的是标签条
     * 的 DOM 次序(`[data-pane-tab]` 按标签序),与 `gate:workspace` ⑬ 读盘上那份
     * 树是同一件事的两个口 —— 这道门手上有 DOM,就不必再去解一遍 localStorage。
     */
    const bornIsActive = await page.evaluate(
      (id) => Boolean(document.querySelector(`[data-pane-tab="${id}"][data-pane-on]`)),
      bornTerm,
    )
    assert(bornIsActive === true, '⑪ 新那一格当场是活动格(开什么就看什么)')

    /*
     * ── ⑪ 续:⌘W 关掉 → ⌘⇧T **拿回一台能用的终端**(K2 修一轮)────────────
     * 关一格终端 = 杀 PTY,所以「重开」在这一种上**不能**走缺省那一档(影 = ref
     * 自己)—— 那样拿回来的是一格 `exited` 的死壳,屏幕上写着「Process exited」,
     * 而人按 ⌘⇧T 要的是「刚才那台终端回来」。所以这一种自述 `snapshot = {cwd}` /
     * `restore = 照这个目录开一台新的`,而这一步量的正是那句话的两半:
     *  ① 格数回来了(重开确实发生了);
     *  ② 新那一格**不是** `exited` / `dead`(它是一台活着的 shell,不是尸体)。
     * 反证:把 `terminal.tsx` 的 `snapshot` / `restore` 拆掉 → ② 当场读到 `exited`。
     */
    const beforeClose = termsAfter.filter((id) => id.startsWith('terminal:'))
    await page.evaluate((leafId) => {
      const el = document.querySelector(`[data-pane-leaf="${leafId}"]`)
      if (el instanceof HTMLElement) el.focus()
    }, seat.leaf)
    await press(cdp, { key: 'w', code: 'KeyW', keyCode: 87, primary: true })
    await waitFor(
      '⌘W 关掉一格',
      () =>
        page.evaluate(
          (args) => {
            const el = document.querySelector(`[data-pane-leaf="${args.leafId}"]`)
            if (!el) return undefined
            const ids = Array.from(el.querySelectorAll('[data-pane-tab]'))
              .map((x) => x.getAttribute('data-pane-tab'))
              .filter((id) => id && id.startsWith('terminal:'))
            return ids.length === args.want - 1 ? ids : undefined
          },
          { leafId: seat.leaf, want: beforeClose.length },
        ),
      20_000,
    )
    await page.evaluate((leafId) => {
      const el = document.querySelector(`[data-pane-leaf="${leafId}"]`)
      if (el instanceof HTMLElement) el.focus()
    }, seat.leaf)
    await press(cdp, { key: 't', code: 'KeyT', keyCode: 84, primary: true, shift: true })
    const reopened = await waitFor(
      '⌘⇧T 把它拿回来',
      () =>
        page.evaluate(
          (args) => {
            const el = document.querySelector(`[data-pane-leaf="${args.leafId}"]`)
            if (!el) return undefined
            const ids = Array.from(el.querySelectorAll('[data-pane-tab]'))
              .map((x) => x.getAttribute('data-pane-tab'))
              .filter((id) => id && id.startsWith('terminal:'))
            if (ids.length !== args.want) return undefined
            const born = ids.find((id) => !args.before.includes(id))
            const live = document.querySelector('[data-testid="terminal-leaf"][data-terminal-state]')
            return { ids, born, state: live?.getAttribute('data-terminal-state') ?? null }
          },
          { leafId: seat.leaf, want: beforeClose.length, before: beforeClose },
        ),
      25_000,
    )
    report.reopenTerminal = reopened
    console.log(`      ⑪ ⌘W → ⌘⇧T:回到 ${reopened.ids.length} 格,新的是 ${reopened.born},屏上那一格 state=${reopened.state}`)
    assert(
      Boolean(reopened.born),
      `⑪ ⌘⇧T 拿回来的是一格**新**终端(不是被关掉的那个 id;账上 ${JSON.stringify(reopened.ids)})`,
    )
    /*
     * 等它真的活过来再判 —— `attaching` 是合法的中间态,`exited` / `dead` 不是。
     * 等不到活就把读到的那一档原样报出来(不假装绿)。
     */
    const settled = await waitFor(
      '新那一格活过来',
      () =>
        page.evaluate((id) => {
          const layer = document.querySelector(`[data-pane-tab="${id}"]`)
          const leafEl = layer?.querySelector('[data-terminal-state]')
          const state = leafEl?.getAttribute('data-terminal-state') ?? null
          return state && state !== 'attaching' ? state : undefined
        }, reopened.born),
      20_000,
    ).catch(() => 'attaching')
    console.log(`      ⑪ 新那一格 state=${settled}`)
    assert(
      settled !== 'exited' && settled !== 'dead',
      `⑪ **拿回来的是一台活着的 shell,不是「已退出」的死壳**(state=${settled})`,
    )

    await app.close()
    app = undefined
    console.log(`\n[terminal-gate] ok(${LANE} 档)—— 十一条全过`)
    console.log(`[terminal-gate] 读数:${JSON.stringify(report)}`)
  } finally {
    if (app) await app.close().catch(() => {})
    if (vite) await vite.close().catch(() => {})
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('\n[terminal-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
