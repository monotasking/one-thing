#!/usr/bin/env node
/**
 * **响应链的真机门**(09-02 R0 立,设计 `docs/design/react-shell-focus-2026-09.md` §8)。
 *
 * ── 它为什么在 R0 就先立、而且**先钉红** ───────────────────────────────────
 * R0 立的是树,零消费者;八套旧机制一格没动。所以那时这道门量到的是**病本身**——
 * 场景 1 就是用户报的那条(树行 Enter 开文件 → ⌘F 开检索条 → Esc 关掉 → ⌘F 再也
 * 开不出来)。先把红钉下来,R1 / R2 才有一个「改前 vs 改后」的机器读数。
 *
 * **R2 起它不再带 `--expect-red` 跑**:内容面全部接树之后,十二个场景应当全绿。
 * 那个档留着只为一件事 —— 下一次要先钉红再修的时候还用得上(有红也退 0,
 * 红绿逐条打表)。
 *
 * **R3 起它进 `npm run verify`**(排在 gate:a11y 之后、整条链最后)。理由与
 * gate:a11y 逐字相同:它断言的是焦点落点与 Esc 归属,同一份代码同一个视口跑
 * 一百遍是同一个答案,没有余量、不看机器状况 —— 与 gate:perf 那种毫秒读数
 * 正相反。判词写在 `scripts/verify.mjs` 那一行上头。
 *
 * ── 十二个场景(1-6 设计 §8 逐条;7-12 是 R2 那几条规则与拍点的读数)────────
 *  1. 树行 ↵ 开文件 → ⌘F → Esc → ⌘F 再开。**用户报的那条**。
 *  2. ⌘P 开检索 → Esc → 焦点回到开它之前那块面里。
 *  3. 架子两 tab 切换 → 焦点落在新层内;旧层 `inert`(§11 拍点 2)。
 *  4. 对话框里开菜单 → Esc 只关菜单 → 再 Esc 关对话框 → 焦点回触发钮。
 *  5. 焦点在输入面板 + 旁边**真开着一扇浮窗**时按 Esc(§11 拍点 3:按树 =
 *     输入面板先答)。R3 补真:R2 版没真开浮窗(在场 0 扇),拍点 3 没被量到。
 *     两条读数缺一不可 —— 焦点仍在输入框 ∧ 那扇浮窗收掉了。生成中那半边这道门
 *     造不出来(要一台在流的 provider),**记跳过不假造**,由 jsdom 用例守着。
 *  6. 整机扫 I4(每个 Placement 宿主层根元素带 `data-focus-scope`)。
 *  7. 壳一起来,第一响应者就是输入面板(§3.5 规则 1)。
 *  8. 总览里进一条会话 → 焦点落进那条会话的输入框(§3.5 规则 2)。
 *  9. 拼舞台 → 钉右边 → 撕浮窗,每步之后焦点都在那块面所在的那一层里(规则 3)。
 * 10. 文件树单击开文件**焦点留树**,↵ 开文件**焦点进查看器**(§11 拍点 1 的 (a) 档)。
 * 11. ⌘F 在浮窗里的查看器与架子 tab 里的查看器**各开一次**(多实例:路由看实例)。
 * 12. ⌘P → Esc → 焦点回到开它之前**那个输入框**(§4.5 的 returnTo,兄弟之间的归还)。
 *
 *  每个场景**每一步**之后断言 I1(`activeElement` 不是 body)。
 *
 * ── 纪律(照 gate-a11y / gate-dock 的配方)────────────────────────────────
 *  · 真 Electron + 隔离 `--user-data-dir` + 一次性临时 store,跑完删干净;
 *  · 键盘走 playwright 的 `keyboard.press`(底下是 CDP `Input.dispatchKeyEvent`)——
 *    **只进目标窗口,不动真光标、不抢用户的机器**(09-01 判例);
 *  · `finally` 里逐个收尸,结尾自查残留。
 *
 * 跑法:`npm run gate:focus`(判红)/ `npm run gate:focus -- --expect-red`(只打表)。
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

const EXPECT_RED = process.argv.includes('--expect-red')

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
    last = await Promise.resolve()
      .then(predicate)
      .catch((error) => ({ pending: String(error?.message ?? error) }))
    if (last && !last.pending) return last
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
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
  if (!res.ok) throw new Error(`rpc ${domain}.${method} HTTP ${res.status}`)
  const body = await res.json()
  if (!body || body.ok !== true) {
    throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  }
  return body.data
}

/** 与 gate-files 同一条理由:用 element.click() 绕开可操作性判定,派发的仍是真事件。 */
async function clickSelector(page, selector) {
  const clicked = await page.evaluate((css) => {
    const el = document.querySelector(css)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`点不到:${selector} 不在 DOM 里`)
}

/**
 * 右键一块瓦,按菜单项的文案选一种打开方式。回 false = 菜单里没有那一项。
 *
 * 走的是**用户真走的那条路**(Dock 瓦的右键菜单 = 打开方式),不去改 store ——
 * 形态落定之后焦点跟不跟得过去,正是这条路上的事(设计 §3.5 规则 3)。
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
    // 没命中就把菜单收掉,别让它挡住下一步。
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return false
  }, labelRe.source)
  await delay(500)
  return picked
}

/**
 * 把那条夹具会话的卡**摆到屏幕上**(不点它)。
 *
 * 点瓦是**开关**语义:总览已经摆出来了就别再点一下(那一下会把它收回去)。
 * 而「摆出来了没有」在两种时刻都读不准 —— ①重载之后有一格窗口期(落点是记忆,
 * 面画出来要一帧,卡还要等列表拉回来);②上一个场景可能刚好把它留在开着的状态
 * (R3 判例:场景 5 改成真开浮窗之后,那一下 Esc 收的是浮窗而不是从前那一层,
 * 于是走到场景 8 时总览是开着的,一点就关,waitFor 白等 20 秒)。
 * 所以这里点完先等,等不到就**再点一次**:上一下十有八九是把它收回去了。
 * 两下都等不到才是真的没有(那时超时,是夹具的问题)。
 *
 * 单独抽出来是因为它有**两个**调用点:进会话那条路,和场景 8(它要自己断言
 * 「点卡之后焦点去哪」,不能整段复用进会话)。同一段判据抄两份迟早分叉。
 */
async function ensureOverviewCard(page, sessionId) {
  // 重载之后先等那一次 RPC 往返:会话表是拉回来的,拉回来之前总览上没有卡。
  await waitFor('渲染层完成一次 RPC 往返', async () => {
    const value = await page.evaluate(() => window.__d0 ?? null)
    return value && value.rpcOk ? value : undefined
  })
  const cardShown = () =>
    page.evaluate((id) => Boolean(document.querySelector(`[data-session-id="${id}"]`)), sessionId)
  for (let attempt = 0; attempt < 2 && !(await cardShown()); attempt += 1) {
    await clickSelector(page, '[data-testid="dock-tile-sessions"]')
    await delay(700)
  }
  await waitFor('总览画出那张卡', cardShown)
}

/**
 * 进那条夹具会话(总览里点那张卡)。**重载之后必须再走一遍**:文件树的根跟着
 * 「当前会话的工作目录」走,而当前会话是内存态 —— 重载之后它是空的,树会退回
 * 主目录,那时候树上有什么就不由这道门说了算了。
 */
async function enterGateSession(page, sessionId) {
  await ensureOverviewCard(page, sessionId)
  await clickSelector(page, `[data-testid="card-${sessionId}"]`)
  await delay(400)
}

/** 树上此刻有没有一行**文件**(目录行不算:目录的 ↵ 是展开,不是打开)。 */
function hasFileRow(page) {
  return page.evaluate(() =>
    Boolean(
      document.querySelector('[data-testid="files-tree"] [data-file-path][data-file-type="file"]'),
    ),
  )
}

/* ── 记分板:每个场景一格,逐条打表 ────────────────────────────────────── */

const scenarios = []
let current = null

function scenario(name) {
  current = { name, checks: [] }
  scenarios.push(current)
  console.log(`\n[场景 ${scenarios.length}] ${name}`)
}

function assert(ok, message, detail) {
  current.checks.push({ ok: Boolean(ok), message, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${message}${detail ? `  ${detail}` : ''}`)
  return Boolean(ok)
}

/**
 * 夹具没搭起来 = **跳过**,不是红。
 * 红要留给产品的读数;把「这台默认布局没摆出两块面」记成红,下一个人只会去
 * 改判据(判例:命名近似规则那条注释里写过同一件事)。
 */
function skip(message, why) {
  current.checks.push({ skipped: true, ok: true, message, detail: why })
  console.log(`  ⊘ ${message}(跳过:${why})`)
}

/** I1:焦点永远不落在「没有东西」上。每一步之后问一次。 */
async function assertNoOrphan(page, step) {
  const at = await page.evaluate(() => {
    const el = document.activeElement
    return {
      isBody: el === document.body || el === null,
      tag: el?.tagName?.toLowerCase() ?? '(null)',
      testid: el?.getAttribute?.('data-testid') ?? null,
      scope: el?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
    }
  })
  return assert(
    !at.isBody,
    `I1 · ${step}:焦点没掉到 body`,
    `(此刻在 <${at.tag}>${at.testid ? `[${at.testid}]` : ''},作用域 ${at.scope ?? '—'})`,
  )
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[focus-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[focus-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'focus-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'focus-gate-userdata-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'focus-gate-ws-'))
  let server
  let app
  try {
    // 一棵最小的树,场景 1 要在它上面开一个文件。
    await mkdir(path.join(workspaceRoot, 'notes'), { recursive: true })
    await writeFile(path.join(workspaceRoot, 'notes', 'alpha.md'), '# alpha\n\nzorbulax\n')
    await writeFile(path.join(workspaceRoot, 'readme.md'), '# readme\n')
    /*
     * **一份按行寻址的内容**(场景 1 / 11 的 ⌘F 要它):跳转条只在
     * `handler.lineCount` 答得出数时才开(图 / 渲染态 markdown / 诚实态都答不出,
     * 那时 ⌘F 原样落给全局命令表 —— 那是产品行为,不是响应链的事)。
     * 树上文件按名排序,`a.ts` 因此是第一个 `data-file-type="file"` 的行。
     */
    await writeFile(
      path.join(workspaceRoot, 'a.ts'),
      "export const gate = 'focus'\nconst second = 2\nconst third = 3\n",
    )

    console.log('[1/3] 起一台 core')
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

    const created = await rpc(record, 'sessions', 'create', { name: 'focus-gate' })
    const sessionId = created?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(created)}`)
    await rpc(record, 'sessions', 'updateWorkingDirectory', {
      sessionId,
      workingDirectory: workspaceRoot,
    })

    console.log('[2/3] 拉起应用(独立 --user-data-dir)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    const page = await app.firstWindow()
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('Dock 就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="dock-tile"]'))),
    )
    // 进那条会话(门要走用户真正走的那条路)。
    await enterGateSession(page, sessionId)

    console.log('[3/3] 十二个场景')

    /* ── 场景 1:⌘F → Esc → ⌘F(用户报的那条)──────────────────────────── */
    scenario('树行 ↵ 开文件 → ⌘F → Esc → ⌘F 再开(用户报的那条;R1 之前第二次开不出来)')
    await clickSelector(page, '[data-testid="dock-tile-files"]')
    await waitFor('文件树画出来', () =>
      page.evaluate(() =>
        Boolean(document.querySelector('[data-testid="files-tree"] [data-file-path]')),
      ),
    )
    await assertNoOrphan(page, '开文件面板之后')
    // 焦点落到第一行再按 ↵ —— 「单击留树、↵ 进查看器」是 §11 拍点 1 的 (a) 档。
    // 挑一行**文件**(目录行的 ↵ 是展开,不是打开 —— 那是另一件事)。
    const rowFocused = await page.evaluate(() => {
      const row = document.querySelector(
        '[data-testid="files-tree"] [data-file-path][data-file-type="file"]',
      )
      if (!(row instanceof HTMLElement)) return false
      row.focus()
      return document.activeElement === row
    })
    assert(rowFocused, '树行(文件那一行)接得住焦点 —— ↵ 开文件的前提')
    await page.keyboard.press('Enter')
    await delay(500)
    let opened = await page.evaluate(() =>
      Boolean(document.querySelector('[data-testid="file-viewer"]')),
    )
    assert(opened, '↵ 之后查看器开出来了(§11 拍点 1 的 (a) 档)')
    if (!opened) {
      // ↵ 今天开不出来的话退回单击开 —— 这个场景真正要量的是后面那三下
      // (⌘F → Esc → ⌘F),不该被前置动作卡死在半路。
      await clickSelector(page, '[data-testid="files-tree"] [data-file-type="file"]')
      await delay(500)
      opened = await page.evaluate(() =>
        Boolean(document.querySelector('[data-testid="file-viewer"]')),
      )
      console.log(`  · ↵ 没开出来,退回单击开:${opened ? '开出来了' : '仍然没有'}`)
    }
    await assertNoOrphan(page, '开查看器之后')

    const findBar = () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="viewer-jump-bar"]')))
    await page.keyboard.press('Meta+f')
    await delay(300)
    const first = await findBar()
    assert(first, '第一次 ⌘F:检索条开出来')
    await page.keyboard.press('Escape')
    await delay(300)
    assert(!(await findBar()), 'Esc 关掉检索条')
    await assertNoOrphan(page, 'Esc 关掉检索条之后(**这一步是病根**:焦点该回查看器)')
    await page.keyboard.press('Meta+f')
    await delay(300)
    assert(await findBar(), '**第二次 ⌘F:检索条还开得出来**(用户报的那条)')

    /* ── 场景 2:⌘P → Esc → 焦点回原处 ───────────────────────────────── */
    scenario('⌘P 开检索 → Esc → 焦点回到开它之前那块面里')
    const before = await page.evaluate(
      () => document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
    )
    await page.keyboard.press('Meta+p')
    await delay(400)
    const searchOpen = await page.evaluate(() =>
      Boolean(document.querySelector('[data-testid="search-panel"], [data-panel-layer="search"]')),
    )
    assert(searchOpen, '⌘P 把检索面开出来了')
    await assertNoOrphan(page, '⌘P 开面之后')
    await page.keyboard.press('Escape')
    await delay(400)
    await assertNoOrphan(page, 'Esc 收面之后')
    const after = await page.evaluate(
      () => document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
    )
    assert(
      before !== null && after === before,
      '焦点回到了开它之前那个作用域',
      `(开之前 ${before ?? '—'} → 收之后 ${after ?? '—'})`,
    )

    /* ── 场景 3:架子切 tab ──────────────────────────────────────────── */
    scenario('架子两 tab 切换 → 焦点在新层内;旧层 inert')
    // 夹具:右键两块瓦,各自选「右侧栏」——「钉到边」是菜单里那一组的语义,
    // 走的是用户真走的那条路(不去改 store)。
    for (const tile of ['files', 'sessions']) {
      const pinned = await page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="dock-tile-${id}"]`)
        if (!(el instanceof HTMLElement)) return false
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
        return true
      }, tile)
      if (!pinned) continue
      await delay(400)
      const picked = await page.evaluate(() => {
        const items = Array.from(
          document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'),
        )
        const texts = items.map((el) => (el.textContent ?? '').trim())
        // 语言两种都认:这道门跑在一个全新 store 上,界面语言跟系统走。
        const right = items.find((el) => /右侧栏|Right/.test(el.textContent ?? ''))
        if (right instanceof HTMLElement) right.click()
        return { count: items.length, texts, hit: Boolean(right) }
      })
      console.log(
        `  · 右键 ${tile}:菜单 ${picked.count} 项${picked.count ? `(${picked.texts.join(' / ')})` : ''},`
          + `「右侧栏 / Right」${picked.hit ? '点到了' : '没找到'}`,
      )
      await delay(500)
    }
    const shelf = await page.evaluate(() => ({
      count: document.querySelectorAll('[data-shelf] [role="tab"]').length,
    }))
    if (shelf.count < 2) {
      skip('架子两 tab 切换', `夹具没搭起来 —— 此刻架子上只有 ${shelf.count} 个 tab`)
    } else {
      await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('[data-shelf] [role="tab"]'))
        const off = tabs.find((t) => t.getAttribute('aria-selected') !== 'true')
        if (off instanceof HTMLElement) off.click()
      })
      await delay(400)
      const state = await page.evaluate(() => {
        const layers = Array.from(document.querySelectorAll('[data-panel-layer]'))
        const active = document.activeElement
        return {
          inertOld: layers.filter((l) => l.hasAttribute('inert')).length,
          focusInLive: layers.some(
            (l) => !l.hasAttribute('inert') && active instanceof Node && l.contains(active),
          ),
          scopes: layers.map((l) => l.getAttribute('data-focus-scope')),
        }
      })
      assert(state.inertOld > 0, '旧层打上了 inert')
      /*
       * I4 的架子那一格在**这里**验,不在场景 6 —— 那时架子上多半已经空了
       * (场景 5 的整页重载 + 场景 6 把瓦挪去别的形态)。层是按需挂载的东西,
       * 只能在它确实在场的那一刻问。
       */
      assert(
        state.scopes.length > 0 && state.scopes.every((v) => v === 'shelf-layer'),
        'I4 · shelf-layer:架子上**每一层**的根都带 data-focus-scope',
        `(${state.scopes.length} 层:${[...new Set(state.scopes)].join(' / ') || '—'})`,
      )
      assert(state.focusInLive, '焦点落在新层内(§11 拍点 2:切 tab 进内容)')
      await assertNoOrphan(page, '切 tab 之后')
    }

    /* ── 场景 4:对话框里开菜单 ──────────────────────────────────────── */
    scenario('对话框里开菜单 → Esc 只关菜单 → 再 Esc 关对话框 → 焦点回触发钮')
    await page.goto(`${page.url().split('?')[0]}?gallery`)
    await waitFor('规格页就位', () =>
      page.evaluate(() =>
        Boolean(
          [...document.querySelectorAll('button')].some(
            (el) => (el.textContent ?? '').trim() === 'open dialog',
          ),
        ),
      ),
    )
    const dialogOpened = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (el) => (el.textContent ?? '').trim() === 'open dialog',
      )
      if (!btn) return false
      btn.focus()
      window.__focusAnchor = btn
      btn.click()
      return true
    })
    assert(dialogOpened, '规格页上找得到「open dialog」触发器')
    await waitFor('对话框在场', () =>
      page.evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))),
    )
    await assertNoOrphan(page, '开对话框之后')
    // 对话框里今天没有菜单触发器,所以这一格量的是它退化后的那一半:
    // 一下 Esc 只关一层、并且焦点回到开它的那个钮。
    await page.keyboard.press('Escape')
    await delay(300)
    const back = await page.evaluate(() => ({
      closed: !document.querySelector('[role="dialog"][aria-modal="true"]'),
      returned: document.activeElement === window.__focusAnchor,
    }))
    assert(back.closed, 'Esc 关掉对话框')
    assert(back.returned, 'Esc 之后焦点回到开它的那个元素')
    await assertNoOrphan(page, 'Esc 关对话框之后')

    /* ── 场景 5:输入面板 vs 浮窗的 Esc 归属 ─────────────────────────── */
    scenario('焦点在输入面板、旁边**真开着一扇浮窗**时 Esc(§11 拍点 3:按树,输入面板先答)')
    /*
     * ── R3 补的那一格(R2 留账)─────────────────────────────────────────────
     * R2 版这一步只 `clickSelector` 点了一下 files 那块瓦,而那时它的落点是
     * 「面板内」——**按 Esc 前在场的浮层是 0 扇**,于是这个场景量到的其实只有
     * 「Esc 没把焦点从输入框里抢走」,拍点 3 那句「输入面板先答,才轮到 root
     * 收浮窗」一个字都没被验到(留账原话:「门场景 5 未真开浮窗,拍点 3 靠
     * jsdom 用例」)。R3 走菜单把它**真开成一扇浮窗**再问同一下 Esc,于是
     * 这一格量的是两件事,缺一不可:
     *   ① 焦点仍在输入框里(输入面板答了「不是我的」,但没被人把焦点搬走);
     *   ② 那扇浮窗**收掉了**(没人认领 → 一路传到 root 的退层链 → escapeTopmost)。
     * 只有 ① 的话,「树根本没把这一下往外传」也能过;只有 ② 的话,「浮窗那一路
     * 抢先并顺手改了焦点」也能过。
     */
    await page.goto(page.url().split('?')[0])
    await waitFor('壳回来了', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
    )
    const floatPrepared = await openAsFromDockMenu(page, 'files', /浮窗|Float/)
    const floatOpen = await page.evaluate(
      () => document.querySelectorAll('section[role="dialog"]').length,
    )
    if (!floatPrepared || floatOpen === 0) {
      skip(
        '旁边真开着一扇浮窗时按 Esc',
        floatPrepared
          ? '选了「浮窗 / Float」但一扇都没画出来'
          : 'Dock 菜单里没有「浮窗 / Float」那一项',
      )
    } else {
      assert(floatOpen > 0, '前提:真开出了浮窗', `(在场 ${floatOpen} 扇)`)
      /*
       * 焦点摆回输入框。用 `.focus()` 而不是真鼠标点:这一步只是**摆好前提**,
       * 而真机上点输入框会先走一趟 pointerdown 抢根(§4.6),那是另一条路的事。
       * 场景 10 那种「点完之后焦点在哪儿」才必须用真鼠标点。
       */
      await page.evaluate(() => {
        const box = document.querySelector('[data-testid="composer-input"]')
        if (box instanceof HTMLElement) box.focus()
      })
      const ready = await page.evaluate(() => ({
        inComposer: document.activeElement?.getAttribute?.('data-testid') === 'composer-input',
        scope:
          document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
          ?? null,
      }))
      assert(ready.inComposer, '前提:焦点在输入框里', `(作用域 ${ready.scope ?? '—'})`)
      await assertNoOrphan(page, '焦点摆进输入面板之后')

      await page.keyboard.press('Escape')
      await delay(400)
      const afterEsc = await page.evaluate(() => ({
        inComposer: document.activeElement?.getAttribute?.('data-testid') === 'composer-input',
        floatStill: document.querySelectorAll('section[role="dialog"]').length,
      }))
      assert(
        afterEsc.inComposer,
        '① 一下 Esc 之后焦点**仍在输入面板里**(不是被浮窗那一路抢走)',
        `(按 Esc 前在场的浮层 ${floatOpen} 扇,按完还剩 ${afterEsc.floatStill} 扇)`,
      )
      assert(
        afterEsc.floatStill < floatOpen,
        '② 那扇浮窗**收掉了**(输入面板没认领 → 传到 root 的退层链)',
        `(${floatOpen} → ${afterEsc.floatStill} 扇)`,
      )
      await assertNoOrphan(page, '输入面板里按 Esc 之后')
    }
    /*
     * 拍点 3 的**另一半**(「输入面板正在生成时,Esc 归两段停止,浮窗不收」)
     * 这道门量不到,如实记跳过而不是假造一个生成态:要造出「生成中」得有一台
     * 真在流的 provider(gate:chat 那一套假慢流),而那是另一道门的夹具。
     * 在这里塞一个假的 `streaming` 标志 = 门断言的是自己写进去的那格状态,
     * 不是产品的行为 —— 那种绿比红更坏。
     * 今天守着这一半的是 jsdom 用例:`composer/components/Composer.test.tsx`
     * 的 Esc 三分支(拒答 / 关抽屉 / 两段停止)与 `useEscStop`。
     */
    skip(
      '生成中按 Esc:两段停止、浮窗不收(拍点 3 的另一半)',
      '造不出真的生成态 —— 要一台在流的 provider(gate:chat 的夹具);今天由 Composer.test.tsx 的 Esc 三分支守着',
    )

    /* ── 场景 6:I4 整机扫 ───────────────────────────────────────────── */
    scenario('I4:每个 Placement 宿主层的根元素都带 data-focus-scope')
    /*
     * ── 为什么这一格要**把四种形态各摆出来一次**(R1 改)────────────────────
     * R0 版只在跑完最后一步的那一刻扫一次 DOM,于是读到的是「此刻恰好开着什么」——
     * 那时四种形态多半一个都不在场,扫出来永远只有 root,「未接树」与「没开出来」
     * 两件事分不开。宿主层是**按需挂载**的(舞台没开就不渲染),所以 I4 只能这么验:
     * 走用户真走的那条路(Dock 瓦的右键菜单 = 打开方式)把每一种形态开出来,
     * 开出来了再问它的根带不带 `data-focus-scope`。
     * 开不出来(菜单里没有那一项)记**跳过**,不记红 —— 那是夹具没搭起来。
     */
    const scopesNow = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-focus-scope]')).map((el) =>
          el.getAttribute('data-focus-scope'),
        ),
      )
    assert(
      (await scopesNow()).includes('root'),
      '壳根带 data-focus-scope="root"',
      `(此刻整机 ${[...new Set(await scopesNow())].join(' / ') || '—'})`,
    )

    for (const [key, labelRe] of [
      ['float-layer', /浮窗|Float/],
      ['stage-layer', /弹出|Popup/],
      ['cover-layer', /盖|Cover/],
    ]) {
      const picked = await openAsFromDockMenu(page, 'files', labelRe)
      if (!picked) {
        skip(`${key} 的根带 data-focus-scope`, `Dock 菜单里没有 ${labelRe} 那一项`)
        continue
      }
      const scopes = await scopesNow()
      assert(scopes.includes(key), `${key} 的根带 data-focus-scope`, `(在场:${[...new Set(scopes)].join(' / ')})`)
      await assertNoOrphan(page, `以 ${key} 打开之后`)
    }

    // shelf-layer 那一格在场景 3 里验(层是按需挂载的,只能在它在场的那一刻问)。
    console.log('  · shelf-layer:见场景 3 最后一条')


    /* ── 场景 7:启动第一响应者 ──────────────────────────────────────── */
    scenario('壳一起来,第一响应者就是输入面板(§3.5 规则 1)')
    /*
     * 整页重载一次:这一条问的是**刚起来那一刻**的事实,而前面六个场景已经把
     * 焦点摆到别处去了。重载之后照样要等那一次 RPC 往返(与开场同一条等待)。
     */
    await page.goto(page.url().split('?')[0])
    await waitFor('壳回来了', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
    )
    await delay(400)
    const boot = await page.evaluate(() => ({
      testid: document.activeElement?.getAttribute?.('data-testid') ?? null,
      scope:
        document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
        ?? null,
      first: window.__focus?.dump?.().path.at(-1) ?? null,
    }))
    assert(
      boot.scope === 'composer',
      '第一响应者 = 输入面板',
      `(焦点此刻在 [${boot.testid ?? '—'}],作用域 ${boot.scope ?? '—'};树说 ${boot.first ?? '—'})`,
    )
    await assertNoOrphan(page, '壳刚起来')

    /* ── 场景 8:Expose 进会话 → 焦点在输入框 ────────────────────────── */
    scenario('总览里进一条会话 → 焦点落在那条会话的输入框里(§3.5 规则 2)')
    /*
     * 「把卡摆上屏」与「点那张卡」是两件事,这里只能借前者:这一格要自己断言
     * 点完之后焦点去哪,整段借 `enterGateSession` 就把被测的那一下也吞进去了。
     * 摆上屏那一半为什么要重试,写在 `ensureOverviewCard` 的注释里(点瓦是开关)。
     */
    await ensureOverviewCard(page, sessionId)
    await assertNoOrphan(page, '开总览之后')
    await clickSelector(page, `[data-testid="card-${sessionId}"]`)
    await delay(500)
    const entered = await page.evaluate(() => ({
      testid: document.activeElement?.getAttribute?.('data-testid') ?? null,
      scope:
        document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
        ?? null,
    }))
    assert(
      entered.scope === 'composer',
      '进会话之后焦点在输入面板里',
      `(焦点此刻在 [${entered.testid ?? '—'}],作用域 ${entered.scope ?? '—'})`,
    )
    await assertNoOrphan(page, '进会话之后')

    /* ── 场景 9:拼舞台 → 钉右边 → 撕浮窗,每步焦点跟着那块面 ────────── */
    scenario('形态变化三步:拼舞台 → 钉右边 → 撕成浮窗,每步之后焦点都在那块面里(§3.5 规则 3)')
    /**
     * 焦点此刻落在哪一层里 —— 按**宿主层的根**问(`data-focus-scope` 的四种 layer),
     * 而不是问最内层那一格:规则 3 说的是「跟着那块面走」,那块面装在哪一层里
     * 才是这一条要量的东西。
     */
    const layerNow = () =>
      page.evaluate(() => {
        const el = document.activeElement
        const layer = el?.closest?.(
          '[data-focus-scope="stage-layer"],[data-focus-scope="float-layer"],'
            + '[data-focus-scope="shelf-layer"],[data-focus-scope="cover-layer"]',
        )
        return {
          layer: layer?.getAttribute('data-focus-scope') ?? null,
          panel: layer?.closest?.('[data-panel-layer]')?.getAttribute('data-panel-layer') ?? null,
          scope: el?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
        }
      })
    /*
     * ── 先把它**开出来**,再量挪动 ──────────────────────────────────────────
     * 「从 Dock 开一块面」与「把一块开着的面挪个地方」是两件事,规则也不同:
     * 前者(dock → 任何形态)焦点**不跟**(指针点瓦之后焦点留在瓦上,是今天的
     * 行为),后者才是规则 3 说的「焦点跟着那块面走」。所以这一步只做准备,
     * 不断言 —— 三条读数量的是它开出来**之后**的三次挪动。
     */
    const prepared = await openAsFromDockMenu(page, 'files', /浮窗|Float/)
    if (!prepared) skip('准备:先把文件树开成浮窗', 'Dock 菜单里没有「浮窗 / Float」那一项')
    // 拼上舞台(菜单那条路 = 用户真走的路)。
    const staged = await openAsFromDockMenu(page, 'files', /弹出|Popup/)
    if (!staged) {
      skip('拼舞台之后焦点在舞台那一层里', 'Dock 菜单里没有「弹出 / Popup」那一项')
    } else {
      const at = await layerNow()
      assert(at.layer === 'stage-layer', '拼舞台之后焦点在舞台那一层里', `(读数 ${JSON.stringify(at)})`)
      await assertNoOrphan(page, '拼舞台之后')
    }
    const pinned = await openAsFromDockMenu(page, 'files', /右侧栏|Right/)
    if (!pinned) {
      skip('钉右边之后焦点在那条架子的层里', 'Dock 菜单里没有「右侧栏 / Right」那一项')
    } else {
      const at = await layerNow()
      assert(
        at.layer === 'shelf-layer' && at.panel === 'files',
        '钉右边之后焦点在**装着这块面**的那一层里',
        `(读数 ${JSON.stringify(at)})`,
      )
      await assertNoOrphan(page, '钉右边之后')
    }
    const floated = await openAsFromDockMenu(page, 'files', /浮窗|Float/)
    if (!floated) {
      skip('撕成浮窗之后焦点在那扇窗里', 'Dock 菜单里没有「浮窗 / Float」那一项')
    } else {
      const at = await layerNow()
      assert(at.layer === 'float-layer', '撕成浮窗之后焦点在那扇窗里', `(读数 ${JSON.stringify(at)})`)
      await assertNoOrphan(page, '撕成浮窗之后')
    }

    /* ── 场景 10:树行单击不抢焦点,↵ 抢 ─────────────────────────────── */
    scenario('文件树:单击开文件但焦点留树,↵ 开文件并把焦点送进查看器(§11 拍点 1)')
    await page.goto(page.url().split('?')[0])
    await waitFor('壳回来了', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
    )
    await enterGateSession(page, sessionId)
    /*
     * 前面几个场景把 files 那块瓦挪去了别的形态,而落点是**记忆**(存 localStorage,
     * 重载之后还在)—— 所以这里不能想当然地点一下瓦就以为树会出来:那一下多半是
     * 「收回去」。走菜单点名回「面板内 / Dock」那一档,状态从此确定。
     */
    if (!(await hasFileRow(page))) {
      await clickSelector(page, '[data-testid="dock-tile-files"]')
      await delay(500)
    }
    await waitFor('文件树画出一行**文件**', () => hasFileRow(page))
    const rowSelector = '[data-testid="files-tree"] [data-file-path][data-file-type="file"]'
    /*
     * 这一条**必须用真的鼠标点**(playwright 的 click → CDP `Input.dispatchMouseEvent`,
     * 只进目标窗口、不动真光标)。别处那只 `clickSelector` 走的是页面里的
     * `el.click()` —— 它派的是一个合成事件,**不落焦**;而这一条量的正是
     * 「点完之后焦点在哪儿」,拿合成点击去量等于量了个寂寞(第一版就栽在这儿:
     * 读数说焦点还在输入面板里,而那是探针自己没落焦)。
     */
    await page.click(rowSelector)
    await delay(600)
    const afterClick = await page.evaluate((css) => {
      const row = document.querySelector(css)
      return {
        opened: Boolean(document.querySelector('[data-testid="file-viewer"]')),
        onRow: document.activeElement === row,
        scope:
          document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
          ?? null,
      }
    }, rowSelector)
    assert(afterClick.opened, '单击开出了查看器')
    assert(
      afterClick.scope === 'files',
      '单击之后焦点**留在树这块面里**(拍点 1 的 (a) 档)',
      `(在行上:${afterClick.onRow};作用域 ${afterClick.scope ?? '—'})`,
    )
    await assertNoOrphan(page, '单击开文件之后')

    // ↵:先把焦点摆回那一行(真机上单击本来就落在它身上),再按。
    await page.evaluate((css) => {
      const row = document.querySelector(css)
      if (row instanceof HTMLElement) row.focus()
    }, rowSelector)
    await page.keyboard.press('Enter')
    await delay(600)
    const afterEnter = await page.evaluate(() => ({
      scope:
        document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
        ?? null,
      inViewer: Boolean(document.activeElement?.closest?.('[data-testid="file-viewer"]')),
    }))
    assert(
      afterEnter.inViewer,
      '↵ 之后焦点**进了查看器**',
      `(作用域 ${afterEnter.scope ?? '—'})`,
    )
    await assertNoOrphan(page, '↵ 开文件之后')

    /* ── 场景 11:多实例 —— 浮窗里的查看器与架子里的查看器各开一次 ⌘F ── */
    scenario('⌘F 在**浮窗里的查看器**与**架子 tab 里的查看器**各开一次(多实例)')
    for (const [labelRe, where] of [
      [/浮窗|Float/, '浮窗'],
      [/右侧栏|Right/, '架子'],
    ]) {
      const moved = await openAsFromDockMenu(page, 'viewer', labelRe)
      if (!moved) {
        skip(`⌘F 在${where}里的查看器上开得出检索条`, `Dock 菜单里没有 ${labelRe} 那一项`)
        continue
      }
      await delay(400)
      const there = await page.evaluate(() =>
        Boolean(document.querySelector('[data-testid="file-viewer"]')),
      )
      if (!there) {
        skip(`⌘F 在${where}里的查看器上开得出检索条`, '那一档里查看器没画出来')
        continue
      }
      // 焦点摆进那一份查看器(真机上把它摆过去时宿主已经送过一次,这里补稳)。
      await page.evaluate(() => {
        const viewer = document.querySelector('[data-focus-scope="viewer"]')
        if (viewer instanceof HTMLElement) viewer.focus()
      })
      await page.keyboard.press('Meta+f')
      await delay(300)
      const opened = await page.evaluate(() =>
        Boolean(document.querySelector('[data-testid="viewer-jump-bar"]')),
      )
      assert(opened, `⌘F 在${where}里的那一份查看器上开得出检索条`)
      if (opened) {
        await page.keyboard.press('Escape')
        await delay(250)
        await assertNoOrphan(page, `${where}:Esc 关掉检索条之后`)
      }
    }

    /* ── 场景 12:⌘P → Esc → 回到开它之前那个输入框(returnTo)────────── */
    scenario('⌘P → Esc → 焦点回到**开它之前那个元素**(§4.5 的 returnTo)')
    await page.goto(page.url().split('?')[0])
    await waitFor('壳回来了', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
    )
    await enterGateSession(page, sessionId)
    await page.evaluate(() => {
      const box = document.querySelector('[data-testid="composer-input"]')
      if (box instanceof HTMLElement) box.focus()
    })
    const beforePalette = await page.evaluate(
      () => document.activeElement?.getAttribute?.('data-testid') ?? null,
    )
    assert(beforePalette === 'composer-input', '开检索面之前焦点在输入框里(前提)')
    await page.keyboard.press('Meta+p')
    await delay(400)
    assert(
      await page.evaluate(() =>
        Boolean(document.querySelector('[data-testid="search-panel"], [data-panel-layer="search"]')),
      ),
      '⌘P 把检索面开出来了',
    )
    await assertNoOrphan(page, '⌘P 开面之后')
    await page.keyboard.press('Escape')
    await delay(500)
    const backTo = await page.evaluate(() => ({
      testid: document.activeElement?.getAttribute?.('data-testid') ?? null,
      scope:
        document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
        ?? null,
    }))
    assert(
      backTo.testid === 'composer-input',
      '**焦点回到了开它之前那个输入框**(兄弟之间的归还)',
      `(此刻在 [${backTo.testid ?? '—'}],作用域 ${backTo.scope ?? '—'})`,
    )
    await assertNoOrphan(page, 'Esc 收检索面之后')

    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
  }

  /* ── 打表 ─────────────────────────────────────────────────────────── */
  console.log('\n────────── 逐场景读数 ──────────')
  let red = 0
  let skipped = 0
  scenarios.forEach((s, i) => {
    const bad = s.checks.filter((c) => !c.ok)
    const skips = s.checks.filter((c) => c.skipped)
    red += bad.length
    skipped += skips.length
    /*
     * 「整个场景没搭起来」与「场景绿了、其中一格如实记跳过」是两件事,标签要分得开
     * (R3:场景 5 的五条读数全绿,只有拍点 3 的生成中那半边跳过 —— 标成「跳过」
     * 会让人以为这一整格没量)。
     */
    const tag =
      bad.length > 0
        ? `红 ${bad.length}/${s.checks.length}`
        : skips.length === s.checks.length
          ? '跳过'
          : skips.length
            ? `绿(${skips.length} 条跳过)`
            : '绿'
    console.log(`场景 ${i + 1} ${tag}  ${s.name}`)
    for (const c of bad) console.log(`   ✗ ${c.message}${c.detail ? `  ${c.detail}` : ''}`)
    for (const c of skips) console.log(`   ⊘ ${c.message}(${c.detail})`)
  })
  console.log(
    `合计 ${red} 条红 / ${scenarios.reduce((n, s) => n + s.checks.length, 0)} 条断言`
      + `${skipped ? `(其中 ${skipped} 条跳过)` : ''}`,
  )

  if (red && !EXPECT_RED) {
    console.error('\n[focus-gate] FAILED')
    process.exit(1)
  }
  console.log(
    red
      ? '\n[focus-gate] 带 --expect-red:上面的红是**本批预期的读数**,不判失败'
      : `\n[focus-gate] ok —— ${scenarios.length} 个场景全绿`,
  )
}

main().catch((error) => {
  console.error('\n[focus-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
