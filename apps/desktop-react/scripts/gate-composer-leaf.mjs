#!/usr/bin/env node
/**
 * **输入框属于会话叶**的真机门(W5-c,正本
 * `apps/desktop-react/docs/composer-in-leaf-2026-09.md` §4.2 / §6)。
 *
 * ── 它证的是用户报的那一句 ────────────────────────────────────────────────
 * 用户原话:「composer 在其他 tab 页也存在,导致会遮挡内容」。病根是输入框不属于
 * 会话叶 —— 它是外壳挂在整个中央区底部的一块绝对定位浮层,显不显示、盖住谁,与
 * 拼贴树里当前那一格装的是什么内容**无关**。路线 A 之后它由 `session` 这一种内容
 * 自己渲染:「哪里有会话叶,哪里才有输入框」是结构上的事实。
 *
 * 一屏,五问 —— 每一问都是**像素或 DOM 上的事实**,jsdom 说不出来的那一半:
 *  ① 会话那一格:屏幕上**恰好一块**可交互的输入框,而且它长在这一格里;
 *  ② 开一格非会话内容(「目录」那一种):那一格里**一块都没有**、它的底缘中点
 *    命中的也不是输入框(「遮挡内容」那句报障的判据形),而且**全称形**也成立 ——
 *    「有输入框的那几格」与「装着会话的那几格」逐格相同;
 *  ③ 会话那一格照旧带着它自己那一块(开一格别的内容不会把它带走);
 *  ④ 两条会话**并排**(「在右侧」并出来的 `pair` 复合格,两条同时在屏):
 *    两块输入框,甲那块写着字、乙那块是空的;往乙那块打字,甲那块一个字不动
 *    (草稿与面板状态按会话分家,W5-c-2);
 *  ⑤ Dock 常显贴底时,**每一块落位带只让一份位**:它自己的 `bottom` 恒是 0
 *    (让位在「谁画到窗底」那一层写一次,落位带按构造继承),而且它的下缘在
 *    Dock 那条的上缘之上。
 *
 * 第 ⑤ 问是真机逮出来的那条 bug 的守卫:W5-c 之前落位带是 `.center` 的绝对定位
 * 子元素,`.center` 的 `padding-block-end` 推不动它,所以外壳给它单写过一条
 * `bottom: var(--dock-reserve-h)`;路线 A 之后它的包含块是叶自己的 `.chatArea`
 * ——一个住在已经缩好的内容盒里的**普通流后代**,那条规则于是变成让两遍
 * (真机读数:气口里压着一条消息,差 44px)。判词整段在 `AppShell.module.css`。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * **窗子一律离屏起**(`ONETHING_GATE_HEADLESS=1`,与 gate-companions / gate-focus
 * 同一手):不 show()、不进 Dock、不抢用户的前台;所有输入都经 `page.evaluate` 与
 * CDP 键盘,一根手指都不碰真光标。store、workspace root 与 `--user-data-dir` 都是
 * 临时目录,跑完删干净,**绝不连 `~/.onething`**。自己起的进程在 `finally` 里收尸。
 *
 * 跑法:`npm run gate:composer-leaf`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { installComposerDockProbe } from './lib/composer-dock.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/** 沙箱根的两段 —— 与 `ownerSandboxRoot(root, uid, wid)` 的拼法一致。 */
const OWNER_UID = 'local-user'
const OWNER_WID = 'default'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
function assert(condition, message, detail = '') {
  if (condition) console.log(`  ✓ ${message}${detail ? `  ${detail}` : ''}`)
  else {
    console.log(`  ✗ ${message}${detail ? `  ${detail}` : ''}`)
    failures.push(message)
  }
}

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

/** 点一个 testid(不用 page.click,不动真光标 —— 同 gate-companions 顶上那条纪律)。 */
async function clickTestId(page, testId) {
  const clicked = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testId)
  if (!clicked) throw new Error(`点不到:[data-testid="${testId}"] 不在 DOM 里`)
}

/**
 * **屏幕上此刻的输入框现场**,一次 evaluate 读完(几次之间会插进别的帧,读到的
 * 就不是同一个瞬间的同一份布局 —— 与 gate-chat-follow 的 `readGeometry` 同一条)。
 *
 * 「可交互的那几块」判据是**祖先链上没有 `inert`**:后台那一格的叶照样挂在 DOM 里
 * (keep-alive),它里面那块输入框也在,但整层 `inert` —— 与 `FocusTree` 挑实例
 * 那条 `isReachablyInteractive` 同一把尺。
 */
function readComposers(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }
    }
    const all = Array.from(document.querySelectorAll('[data-testid="composer-dock"]'))
    const liveDocks = all.filter((el) => !el.closest('[inert]'))
    const region = document.querySelector('[data-pane-region="center"]')
    const regionRect = region ? region.getBoundingClientRect() : null
    /*
     * 「中央区底缘中点上此刻是什么」—— 用户那句「遮挡内容」的判据形。取的是
     * `elementsFromPoint` 整条命中链,只问「链上有没有输入框那一格」:`elementFromPoint`
     * 只答最上面一个,而落位带自己 `pointer-events: none`,它不会出现在最上面。
     */
    const hitAtBottom = regionRect
      ? document
        .elementsFromPoint(
          Math.round(regionRect.left + regionRect.width / 2),
          Math.round(regionRect.bottom - 4),
        )
        .some((el) => el.closest('[data-testid="composer-dock"]'))
      : null
    return {
      total: all.length,
      live: liveDocks.length,
      /** 每一块可交互的落位带长在哪一格内容层里(`data-pane-tab` = refId)。 */
      hosts: liveDocks.map((el) => el.closest('[data-pane-tab]')?.getAttribute('data-pane-tab') ?? null),
      /** 每一块自己声明的 `bottom`(第 ⑤ 问:让位只让一份 → 恒是 0px)。 */
      bottoms: all.map((el) => getComputedStyle(el).bottom),
      rects: liveDocks.map((el) => rect(el)),
      activeTab:
        document
          .querySelector('[data-testid="topbar-tabs"] [aria-selected="true"]')
          ?.getAttribute('data-tab-id') ?? null,
      hitAtBottom,
      reserve: document.querySelector('[data-dock-reserve]')?.getAttribute('data-dock-reserve') ?? 'none',
      dockBar: rect(document.querySelector('[data-testid="dock"]') ?? document.querySelector('[class*="dock"]')),
      /** 此刻那块可交互输入框里写着什么(第 ④ 问)。 */
      typed: (() => {
        const box = liveDocks[0]?.querySelector('[data-testid="composer-input"]')
        return box ? (box.textContent ?? '') : null
      })(),
      /** 每一块可交互输入框里各写着什么(并排那一问按位次读,不按「第一块」读)。 */
      texts: liveDocks.map((el) => el.querySelector('[data-testid="composer-input"]')?.textContent ?? ''),
      /**
       * **此刻屏幕上那几格可交互的内容层**(`data-pane-tab` = refId),以及每一格里
       * 有没有输入框。第 ② 问的判据形:`会话那几格 === 有输入框那几格`,一格不多、
       * 一格不少 —— 它比「数一数总共几块」说得更准,因为它按**名字**对得上。
       */
      layers: Array.from(document.querySelectorAll('[data-pane-tab]'))
        .filter((el) => !el.closest('[inert]'))
        .map((el) => ({
          ref: el.getAttribute('data-pane-tab'),
          dock: Boolean(el.querySelector('[data-testid="composer-dock"]')),
          /* 这一格自己的底缘中点上,命中链里有没有输入框 —— 「遮挡内容」那句报障的形。 */
          hitAtBottom: (() => {
            const r = el.getBoundingClientRect()
            if (r.width < 4 || r.height < 4) return null
            return document
              .elementsFromPoint(Math.round(r.left + r.width / 2), Math.round(r.bottom - 4))
              .some((hit) => hit.closest('[data-testid="composer-dock"]'))
          })(),
        })),
    }
  })
}

/** 往此刻那块可交互的输入框里打一段话(contenteditable,同 gate-chat-follow)。 */
async function typeIntoLiveComposer(page, text) {
  const ok = await page.evaluate((value) => {
    const dock = Array.from(document.querySelectorAll('[data-testid="composer-dock"]'))
      .find((el) => !el.closest('[inert]'))
    const box = dock?.querySelector('[data-testid="composer-input"]')
    if (!box) return false
    box.textContent = value
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, text)
  if (!ok) throw new Error('打不进去:此刻屏幕上没有一块可交互的输入框')
  await delay(300)
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[composer-leaf] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[composer-leaf] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'w5c-leaf-store-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'w5c-leaf-ws-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'w5c-leaf-udd-'))
  let server
  let app
  try {
    console.log('\n[1/5] 起一台 core,种两条会话(甲带一个真的工作目录 —— 第 ② 问要靠它开出非会话那一格)')
    const sandbox = path.join(workspaceRoot, OWNER_UID, OWNER_WID)
    const dirA = path.join(sandbox, 'repo-a')
    await mkdir(dirA, { recursive: true })
    await writeFile(path.join(dirA, 'alpha.ts'), 'export const alpha = 1\n', 'utf-8')

    server = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_SERVER_WORKSPACE_ROOT: workspaceRoot,
      },
      cwd: repoRoot,
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

    const madeA = await rpc(record, 'sessions', 'create', { name: 'W5-c 门 · 会话甲' })
    const madeB = await rpc(record, 'sessions', 'create', { name: 'W5-c 门 · 会话乙' })
    const idA = madeA?.session?.id
    const idB = madeB?.session?.id
    if (!idA || !idB) throw new Error('sessions.create 没给出会话 id')
    await rpc(record, 'sessions', 'updateWorkingDirectory', { sessionId: idA, workingDirectory: dirA })

    console.log('[2/5] 拉起应用(离屏 · 独立 --user-data-dir),进会话甲')
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
    await installComposerDockProbe(page)
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    await clickTestId(page, 'dock-tile-sessions')
    await waitFor('总览画出两行', () =>
      page.evaluate(
        ([a, b]) =>
          Boolean(document.querySelector(`[data-testid="session-row-${a}"]`))
          && Boolean(document.querySelector(`[data-testid="session-row-${b}"]`)),
        [idA, idB],
      ),
    )
    await clickTestId(page, `session-row-${idA}`)
    await delay(700)

    console.log('\n[3/5] ①⑤ 会话那一格:恰好一块输入框,而且它只让一份位')
    const onSession = await readComposers(page)
    console.log(
      `      现场:可交互 ${onSession.live} / DOM ${onSession.total} 块 · 活动格 ${onSession.activeTab}`
      + ` · bottom=${JSON.stringify(onSession.bottoms)} · dock-reserve=${onSession.reserve}`,
    )
    assert(onSession.live === 1, `① 屏幕上恰好一块可交互的输入框(实测 ${onSession.live})`)
    assert(
      onSession.hosts[0] === `session:${idA}`,
      '① 它长在**这一格会话**里(不是外壳上那一块横跨中央区的浮层)',
      `(宿主 ${onSession.hosts[0] ?? '—'})`,
    )
    /*
     * 第 ⑤ 问。**每一块**(包括后台那几格里挂着的)都要是 0 —— 判据不挑可见性:
     * 「让位只在画到窗底的那一层写一次」是一条静态的结构事实,不是某一格的状态。
     */
    assert(
      onSession.bottoms.every((value) => value === '0px'),
      '⑤ 每一块落位带自己的 bottom 都是 0px(让位只让一份 —— 它住在已经让过的那个盒子里)',
      `(读到 ${JSON.stringify(onSession.bottoms)})`,
    )
    if (onSession.reserve !== 'bottom') {
      console.log(`  · 跳过:Dock 此刻不在底边(data-dock-reserve=${onSession.reserve}),量不到「在 Dock 之上」那一半`)
    } else {
      const dockRect = onSession.rects[0]
      const bar = onSession.dockBar
      assert(
        Boolean(dockRect && bar) && dockRect.bottom <= bar.top + 1,
        '⑤ 输入框的下缘在 Dock 那条的上缘之上(没被盖住,也没凭空浮起一截)',
        `(输入框下缘 ${dockRect?.bottom?.toFixed(1) ?? '—'} ≤ Dock 上缘 ${bar?.top?.toFixed(1) ?? '—'})`,
      )
    }

    console.log('\n[4/5] ②③ 非会话那一格:一块输入框都没有,底缘也不被盖')
    /*
     * 「目录」那块启动瓦:点它 = 开**环境会话的 workdir** 那棵树(与 gate-companions
     * 同一手)。它是**伴随面**,所以摆在哪儿由形态机记忆说了算(今天是架子)——
     * 这一问因此**不问它在不在中央区**,只问「那一格里有没有输入框、它的底缘会不会
     * 被一块输入框盖住」。那正是用户报障的判据形,而且它在任何宿主下都成立。
     */
    await clickTestId(page, 'dock-tile-files')
    await waitFor('目录树上屏', () =>
      page.evaluate((root) =>
        Boolean(document.querySelector(`[data-testid="files-root"][data-root="${root}"]`)),
      dirA))
    await delay(500)
    const onDir = await readComposers(page)
    console.log(`      现场:在场的内容层 ${JSON.stringify(onDir.layers)}`)
    const dirLayer = onDir.layers.find((layer) => layer.ref === `dir:${dirA}`)
    assert(Boolean(dirLayer), '② 目录那一格真的在屏上(这一问的夹具)', `(在场:${onDir.layers.map((l) => l.ref).join(' | ')})`)
    assert(
      dirLayer?.dock === false,
      '② 目录那一格里**一块输入框都没有**(改前它是外壳上那一块,与这一格装什么无关)',
    )
    assert(
      dirLayer?.hitAtBottom === false,
      '② 目录那一格的底缘中点上命中的不是输入框 —— 用户报的「遮挡内容」在这一格上不成立',
      `(命中=${String(dirLayer?.hitAtBottom)})`,
    )
    /*
     * 同一现场再问一句**总账**:有输入框的那几格,与装着会话的那几格,**逐格相同**。
     * 「哪里有会话叶,哪里才有输入框」是这道门要守的那句话,而这一条是它的全称形。
     */
    const withDock = onDir.layers.filter((layer) => layer.dock).map((layer) => layer.ref).sort()
    const sessions = onDir.layers
      .filter((layer) => (layer.ref ?? '').startsWith('session:'))
      .map((layer) => layer.ref)
      .sort()
    assert(
      JSON.stringify(withDock) === JSON.stringify(sessions),
      '② 有输入框的那几格 = 装着会话的那几格(一格不多、一格不少)',
      `(有框 ${JSON.stringify(withDock)} / 会话 ${JSON.stringify(sessions)})`,
    )

    const back = await readComposers(page)
    assert(
      back.live >= 1 && back.hosts.includes(`session:${idA}`),
      '③ 会话那一格照旧带着它自己那一块(开一格别的内容不会把它带走)',
      `(宿主 ${back.hosts.join(' | ')})`,
    )

    console.log('\n[5/5] ④ 两条会话各一块:草稿不跟着标签跑')
    await typeIntoLiveComposer(page, '甲的稿')
    const typedA = await readComposers(page)
    assert(typedA.typed === '甲的稿', '④ 甲那一块收下了这句话', `(读到「${typedA.typed ?? ''}」)`)

    // 把乙也摆进这条标签条(会话行右键「在右侧」—— 与 gate-chat-follow ⑧ 同一手)。
    const rowShown = () =>
      page.evaluate(
        (id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)),
        idB,
      )
    for (let attempt = 0; attempt < 3 && !(await rowShown()); attempt += 1) {
      await clickTestId(page, 'dock-tile-sessions')
      await delay(600)
    }
    await waitFor('总览画出乙那一行', rowShown)
    await page.evaluate((id) => {
      const row = document.querySelector(`[data-testid="session-row-${id}"]`)
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 80 }))
    }, idB)
    await delay(400)
    const splitRight = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
      const right = items.find((el) => /在右侧|Open to the right/.test(el.textContent ?? ''))
      if (right instanceof HTMLElement) right.click()
      return Boolean(right)
    })
    assert(splitRight, '④ 会话行右键菜单里有「在右侧」那一项(这一问的夹具)')
    await delay(700)
    await clickTestId(page, 'dock-tile-sessions').catch(() => undefined)
    await delay(400)

    /*
     * 「在右侧」并出来的是一格 **`pair` 复合格**(W6-a 的二合一):两条会话
     * **同时在屏**,各占半格。那正是正本 §4.2 那张表里「分屏 A | B」那一行 ——
     * 改前是一个输入框跟着焦点跑,改后是两个,各自草稿 / 抽屉 / 附件。
     */
    const onPair = await readComposers(page)
    console.log(
      `      现场:可交互 ${onPair.live} / DOM ${onPair.total} 块 · 活动格 ${onPair.activeTab}`
      + ` · 两框「${onPair.texts.join('」「')}」`,
    )
    assert(
      onPair.live === 2,
      `④ 两条会话并排 = **两块**输入框,各在各自那半格里(实测可交互 ${onPair.live} 块)`,
      `(宿主 ${onPair.hosts.join(' | ')})`,
    )
    assert(
      onPair.texts[0] === '甲的稿' && onPair.texts[1] === '',
      '④ 甲那块还写着「甲的稿」,乙那块是空的 —— 草稿没跟着并排跑过去',
      `(读到「${onPair.texts.join('」「')}」)`,
    )

    // 往**乙那一块**打字,再回头看甲:两块各写各的,这是 W5-c-2 在真机上的形。
    await page.evaluate(() => {
      const docks = Array.from(document.querySelectorAll('[data-testid="composer-dock"]'))
        .filter((el) => !el.closest('[inert]'))
      const box = docks[1]?.querySelector('[data-testid="composer-input"]')
      if (!(box instanceof HTMLElement)) return
      box.textContent = '乙的稿'
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await delay(400)
    const bothTyped = await readComposers(page)
    assert(
      bothTyped.texts[0] === '甲的稿' && bothTyped.texts[1] === '乙的稿',
      '④ 在乙那块打字,甲那块**一个字不动**(两块面板的状态按会话分家)',
      `(读到「${bothTyped.texts.join('」「')}」)`,
    )
  } finally {
    if (app) await app.close().catch(() => undefined)
    if (server) server.kill('SIGTERM')
    await delay(400)
    if (server && !server.killed) server.kill('SIGKILL')
    await rm(store, { recursive: true, force: true }).catch(() => undefined)
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  }

  if (failures.length) {
    console.error(`\n[composer-leaf] FAILED —— ${failures.length} 条:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log(
    '\n[composer-leaf] ok —— 输入框属于会话叶:非会话那一格一块都没有、两条会话各一块、让位只让一份',
  )
}

main().catch((error) => {
  console.error(`\n[composer-leaf] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
