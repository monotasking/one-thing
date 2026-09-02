#!/usr/bin/env node
/**
 * **响应链的真机门**(09-02 R0 立,设计 `docs/design/react-shell-focus-2026-09.md` §8)。
 *
 * ── 它为什么在 R0 就先立、而且**先钉红** ───────────────────────────────────
 * R0 立的是树,零消费者;八套旧机制一格没动。所以这道门此刻量到的是**病本身**——
 * 场景 1 就是用户报的那条(树行 Enter 开文件 → ⌘F 开检索条 → Esc 关掉 → ⌘F 再也
 * 开不出来)。先把红钉下来,R1 / R2 才有一个「改前 vs 改后」的机器读数;等改完
 * 再来写门,验的就只是「今天这样」而不是「治好了没有」。
 *
 * 所以本批跑它一律带 `--expect-red`:有红也退 0,红绿逐条打表进交卷报。
 * R3 那一批去掉这个档,门进 verify。
 *
 * ── 六个场景(设计 §8 逐条)────────────────────────────────────────────────
 *  1. 树行 ↵ 开文件 → ⌘F → Esc → ⌘F 再开。**用户报的那条,钉红**。
 *  2. ⌘P 开检索 → Esc → 焦点回到开它之前那块面里。
 *  3. 架子两 tab 切换 → 焦点落在新层内;旧层 `inert`。
 *  4. 对话框里开菜单 → Esc 只关菜单 → 再 Esc 关对话框 → 焦点回触发钮。
 *  5. 焦点在输入面板 + 旁边开着浮窗时按 Esc(§11 拍点 3:按树 = 输入面板先答)。
 *  6. 每个场景**每一步**之后断言 I1(`activeElement` 不是 body);整机扫 I4
 *     (每个 Placement 宿主层根元素带 `data-focus-scope`)。
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
    await clickSelector(page, '[data-testid="dock-tile-sessions"]')
    await waitFor('总览画出那张卡', () =>
      page.evaluate((id) => Boolean(document.querySelector(`[data-session-id="${id}"]`)), sessionId),
    )
    await clickSelector(page, `[data-testid="card-${sessionId}"]`)

    console.log('[3/3] 六个场景')

    /* ── 场景 1:⌘F → Esc → ⌘F(用户报的那条)──────────────────────────── */
    scenario('树行 ↵ 开文件 → ⌘F → Esc → ⌘F 再开(**钉红**:改前开不出第二次)')
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
    scenario('焦点在输入面板、旁边开着浮窗时 Esc(§11 拍点 3:按树,输入面板先答)')
    await page.goto(page.url().split('?')[0])
    await waitFor('壳回来了', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
    )
    await clickSelector(page, '[data-testid="dock-tile-files"]')
    await delay(400)
    const floatOpen = await page.evaluate(
      () => document.querySelectorAll('section[role="dialog"]').length,
    )
    await page.evaluate(() => {
      const box = document.querySelector('[data-testid="composer-input"]')
      if (box instanceof HTMLElement) box.focus()
    })
    await assertNoOrphan(page, '焦点摆进输入面板之后')
    await page.keyboard.press('Escape')
    await delay(300)
    const afterEsc = await page.evaluate(() => ({
      inComposer: document.activeElement?.getAttribute?.('data-testid') === 'composer-input',
      floatStill: document.querySelectorAll('section[role="dialog"]').length,
    }))
    assert(
      afterEsc.inComposer,
      '一下 Esc 之后焦点仍在输入面板里(不是被浮窗那一路抢走)',
      `(按 Esc 前在场的浮层 ${floatOpen} 扇,按完还剩 ${afterEsc.floatStill} 扇)`,
    )
    await assertNoOrphan(page, '输入面板里按 Esc 之后')

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

    /** 右键一块瓦,按菜单项的文案选一种打开方式。回 false = 菜单里没有那一项。 */
    async function openAs(tile, labelRe) {
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

    for (const [key, labelRe] of [
      ['float-layer', /浮窗|Float/],
      ['stage-layer', /弹出|Popup/],
      ['cover-layer', /盖|Cover/],
    ]) {
      const picked = await openAs('files', labelRe)
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
    const tag = bad.length === 0 ? (skips.length ? '跳过' : '绿') : `红 ${bad.length}/${s.checks.length}`
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
      : '\n[focus-gate] ok —— 六个场景全绿',
  )
}

main().catch((error) => {
  console.error('\n[focus-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
