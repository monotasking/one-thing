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
 *  ⑧ **axe 扫这一屏**(与 `gate:a11y` 同一套标签、同一个 legacy 模式)。
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
 * ⑤ 为什么不给阈值:`gate-chat-layout` 的 `BUDGET` 是**在真店规模夹具上量过**
 * 之后定的(壳 CLAUDE.md 第 5 轴)。终端这一路今天第一次有读数,拿一个凭空的
 * 数当门只会得到一条「抓不着的天花板」(那正是第 5 单留账里点名的说谎方式)。
 * 所以这一版把数打出来写进报告;下一单按实测定档。
 *
 * ── 纪律(照 gate-music / gate-focus)────────────────────────────────────
 * 临时 store + 独立 `--user-data-dir` + `ONETHING_GATE_HEADLESS=1` + 只用 CDP
 * (`Input.dispatchKeyEvent` / `Input.insertText`,不动真光标、不抢前台),
 * 不连 5175,`~/.onething` 零改动,`finally` 里逐个收尸。
 *
 * 跑法:`npm run gate:terminal`(先 `npm run app:build`)。
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
 * 所以 `toggle:terminal` 那条出厂键位(`{ctrl:true, key:'`'}`)在 mac 上要按
 * **⌘\`**、在 Win / Linux 上按 **Ctrl+\`**。门跟着平台走,不写死一枚。
 *
 * CDP 的 modifiers 位:2 = Ctrl,4 = Meta。
 */
const ON_MAC = process.platform === 'darwin'
const PRIMARY_MODIFIER = ON_MAC ? 4 : 2
/** 屏幕上写给人看的那个键面(与 `formatCombo` 同一口径)。 */
const SUMMON_CAP = ON_MAC ? '⌘`' : 'Ctrl+`'

/**
 * 一下按键。**只进这个窗口**(CDP `Input.dispatchKeyEvent`),不动真光标
 * (09-01 那条「真机输入探针禁抢用户的机器」)。
 *
 * `primary = true` = 按住这台机器的主修饰键(见 `PRIMARY_MODIFIER`)。
 */
async function press(cdp, { key, code, keyCode, text, primary = false, windowsVirtualKeyCode }) {
  const modifiers = primary ? PRIMARY_MODIFIER : 0
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
  const report = {}
  try {
    console.log('\n[1/8] 壳自己装配 core(不起 server —— 判词在文件头)')
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
      `\n[2/8] ${SUMMON_CAP} 召唤一格终端(主修饰键随平台,见 PRIMARY_MODIFIER)`,
    )
    await press(cdp, { key: '`', code: 'Backquote', keyCode: 192, primary: true })
    const leaf = await waitFor('那格终端叶出现', () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="terminal-leaf"]')
        return el ? { state: el.dataset.terminalState } : undefined
      }),
    )
    assert(Boolean(leaf), `② Ctrl+\` 开出一格终端叶(state=${leaf.state})`)
    const focused = await waitFor('xterm 的 textarea 拿到焦点', () =>
      page.evaluate(() => {
        const active = document.activeElement
        if (!active) return undefined
        const inScreen = active.closest('[data-terminal-screen]')
        return inScreen ? { tag: active.tagName, cls: active.className } : undefined
      }),
    )
    assert(Boolean(focused), `② 焦点落在终端里(${focused.tag}.${focused.cls})`)

    console.log('\n[3/8] 打一行命令 —— 后端真的 spawn 了一台 shell 吗')
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

    console.log('\n[4/8] 刷新页面 —— attach 回放把它找回来')
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
     * 出来」才抢焦点,布局恢复不抢)。所以这里再按一下 Ctrl+\` —— 它走的是召唤
     * 四态里的「看得见、没聚焦 → 只把键盘送进去」那一档,顺带把那一档也量了。
     */
    await press(cdp, { key: '`', code: 'Backquote', keyCode: 192, primary: true })
    const refocused = await waitFor('召唤键把焦点送回终端', () =>
      page.evaluate(() =>
        document.activeElement?.closest('[data-terminal-screen]') ? true : undefined,
      ),
    )
    assert(refocused === true, '④b 再按一下召唤键:看得见没聚焦 → 只把键盘送进去')

    console.log('\n[5/8] 喷两万行 —— 流式期间的长帧读数')
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
    assert(true, `⑤ 超量读数已打表(本版不判红 —— 判词在文件头)`)

    console.log('\n[6/8] 经 RPC kill 杀掉 —— 死讯要走到屏幕上')
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

    console.log('\n[7/8] 关标签 = 杀 —— 账上不留残渣')
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

    console.log('\n[8/8] axe 扫这一屏(与 gate:a11y 同一套标签)')
    /*
     * 这一屏扫的是**终端刚被关掉之后**那台壳?不 —— 上面 ⑦ 把它关了,所以这里
     * 先开一格新的:axe 要扫的是**有终端在场**的那棵树(xterm 自己会往里长一堆
     * `aria-live` 的行、一个 helper textarea、一层 `aria-hidden` 的画布,而壳这
     * 半边要说清的是状态条那一行字与那颗钮)。
     */
    await press(cdp, { key: '`', code: 'Backquote', keyCode: 192, primary: true })
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

    await app.close()
    app = undefined
    console.log('\n[terminal-gate] ok —— 八条全过')
    console.log(`[terminal-gate] 读数:${JSON.stringify(report)}`)
  } finally {
    if (app) await app.close().catch(() => {})
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('\n[terminal-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
