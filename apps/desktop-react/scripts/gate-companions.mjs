#!/usr/bin/env node
/**
 * C3 的真机门 —— **会话连续性 · 伴随面**(正本
 * `apps/desktop-react/docs/session-continuity-2026-09.md` §3 / §6 C3 行)。
 *
 * ── 它证的是用户报的那一句 ────────────────────────────────────────────────
 * 用户原话:「同一工作区里,切会话时上一条会话挂着的目录要留着;切回去还能回到
 * 我看到哪个文件、看到哪一行。」jsdom 那一半(`src/workbench/__tests__/companions.test.ts`
 * 与 `src/content/__tests__/session-companions.test.ts`)证得了收 / 放 / 继承那几条
 * **判据**;这一条证的是它们合起来在**真的排版、真的两条会话、真的两个磁盘目录**
 * 之下成不成立 —— 那正是单测量不到的那一半。
 *
 * 一屏,四问:
 *  ① **切走时收干净** —— 甲挂着目录树与文件查看器,切到乙之后屏幕上一格都不剩
 *    (乙自己那棵目录树是**继承种类**开出来的,根是**乙的** workdir,不是甲的);
 *  ② **切回来原位** —— 目录与文件都回到原来那片叶的原来那个位次;
 *  ③ **活动格对** —— 切回来露脸的那一格,就是离开时露脸的那一格;
 *  ④ **钉住的不收** —— 钉住之后再切一轮,它一动不动。
 *
 * ── 这道门**说不出**什么 ──────────────────────────────────────────────────
 * 「回到第几行」。滚动位与展开态住在各自的数据源里(`viewer-source.scrolls` /
 * `files-source.expanded`),而收放走的是「摘一格」不是「关一格」,所以它们本来就
 * 不经过伴随面这条路 —— C1 的门(`gate:continuity` 第 ② 问)量的正是同一族的事。
 * 目录树里那格**选中行**今天记不住,理由与留账写在 `workbench/companions.ts` 末尾。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * **窗子一律离屏起**(`ONETHING_GATE_HEADLESS=1`,与 gate-continuity / gate-focus
 * 同一手):不 show()、不进 Dock、不抢用户的前台;所有输入都经 `page.evaluate`,
 * 一根手指都不碰真光标。store、workspace root 与 `--user-data-dir` 都是临时目录,
 * 跑完删干净,**绝不连 `~/.onething`**。自己起的进程在 `finally` 里逐个收尸。
 *
 * ── 沙箱那一行 env(与 gate-files.mjs 同一条)────────────────────────────
 * 壳走 `POST /api/rpc`,files 域按 `context.sandboxRoot`(=
 * `<workspaceRoot>/<uid>/<wid>`)夹每一条路径。所以这道门把
 * `ONETHING_SERVER_WORKSPACE_ROOT` 指到自己造的临时目录,两条会话的工作目录都建在
 * `<root>/local-user/default` 里面 —— 沙箱根就是它们的父目录,链路因此全通。
 *
 * 跑法:`npm run gate:companions`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 *
 * **状态:只写没跑**(C3 交卷时)—— 真机门要占用户的机器,派工令明写不跑。
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

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/** 沙箱根的两段 —— 与 `ownerSandboxRoot(root, uid, wid)` 的拼法一致。 */
const OWNER_UID = 'local-user'
const OWNER_WID = 'default'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`)
  else {
    console.log(`  ✗ ${message}`)
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

/** 点一个 testid(不用 page.click,不动真光标 —— 同 gate-data.mjs 顶部那条纪律)。 */
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
 * **屏幕上此刻摆着哪几格标签,活动的是哪一格**。
 *
 * 一次 evaluate 而不是几次:几次之间会插进别的帧,读到的就不是同一个瞬间的
 * 同一份布局(与 gate-continuity 的 `readView` 同一条)。
 *
 * 取的是标签条上那几颗按钮的 `data-tab-id`(= `refId`)—— 那是「这一格代表谁」
 * 在 DOM 上的唯一说法,比读标题文字稳(标题会被截断、会带同名消歧的父目录)。
 */
function readTabs(page) {
  return page.evaluate(() => {
    const strip = document.querySelector('[data-testid="topbar-tabs"]')
      ?? document.querySelector('[role="tablist"]')
    const tabs = strip ? Array.from(strip.querySelectorAll('[data-tab-id]')) : []
    return {
      ids: tabs.map((el) => el.getAttribute('data-tab-id')),
      active: tabs.find((el) => el.getAttribute('aria-selected') === 'true')?.getAttribute('data-tab-id') ?? null,
    }
  })
}

/** 进一条会话 = 在总览里点它那一行(与用户的手势同一条路:`enterSessionInWorkbench`)。 */
async function enterSession(page, sessionId) {
  await clickTestId(page, `session-row-${sessionId}`)
  // 伴随面的收放排在**微任务**里,而它后面还有一次 React 提交 —— 多等一会儿,
  // 免得「还没来得及放回来」被当成「一格都没回来」。
  await delay(600)
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[companions-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[companions-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'c3-companions-store-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'c3-companions-ws-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'c3-companions-udd-'))
  let server
  let app
  try {
    console.log('\n[1/5] 在磁盘上真的建两棵目录树,起一台 core,种两条会话')
    const sandbox = path.join(workspaceRoot, OWNER_UID, OWNER_WID)
    const dirA = path.join(sandbox, 'repo-a')
    const dirB = path.join(sandbox, 'repo-b')
    await mkdir(dirA, { recursive: true })
    await mkdir(dirB, { recursive: true })
    // 甲那棵里放一个真文件 —— 第 ② 问要靠它证「查看器也回到原位」。
    const fileA = path.join(dirA, 'alpha.ts')
    await writeFile(fileA, 'export const alpha = 1\n', 'utf-8')
    await writeFile(path.join(dirB, 'beta.ts'), 'export const beta = 2\n', 'utf-8')

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

    const madeA = await rpc(record, 'sessions', 'create', { name: 'C3 门 · 会话甲' })
    const madeB = await rpc(record, 'sessions', 'create', { name: 'C3 门 · 会话乙' })
    const idA = madeA?.session?.id
    const idB = madeB?.session?.id
    if (!idA || !idB) throw new Error('sessions.create 没给出会话 id')
    // **两条会话两个仓** —— 「继承种类不继承内容」这一条要靠它们不同才看得出来。
    await rpc(record, 'sessions', 'updateWorkingDirectory', { sessionId: idA, workingDirectory: dirA })
    await rpc(record, 'sessions', 'updateWorkingDirectory', { sessionId: idB, workingDirectory: dirB })

    console.log('[2/5] 拉起应用(离屏 · 独立 --user-data-dir),进甲、开目录、开文件')
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
    // 离屏窗自己把「我有焦点」补上 —— 只进这个窗口,不碰真光标(同 gate-focus)。
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
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
    await enterSession(page, idA)

    // 「目录」那块启动瓦:点它 = 开**环境会话的 workdir** 那棵树。
    await clickTestId(page, 'dock-tile-files')
    await waitFor('甲的目录树上屏', () =>
      page.evaluate((root) =>
        Boolean(document.querySelector(`[data-testid="files-root"][data-root="${root}"]`)),
      dirA))
    // 树上点一个文件 → 查看器那一格。
    await page.evaluate((file) => {
      const el = document.querySelector(`[data-file-path="${file}"]`)
      if (el instanceof HTMLElement) el.click()
    }, fileA)
    await delay(500)
    // 回到目录那一格再离开 —— 第 ③ 问要的是「离开时露脸的那一格」。
    const opened = await readTabs(page)
    assert(
      opened.ids.includes(`dir:${dirA}`) && opened.ids.includes(`file:${fileA}`),
      `甲身上挂着目录与文件两格(${opened.ids.join(' | ')})`,
    )
    const activeBefore = opened.active

    console.log('\n[3/5] 切到乙 —— ①收干净,而且乙拿到的是**它自己**的目录')
    await enterSession(page, idB)
    const onB = await readTabs(page)
    assert(!onB.ids.includes(`file:${fileA}`), '① 甲那格文件查看器收走了(文件不继承)')
    assert(!onB.ids.includes(`dir:${dirA}`), '① 甲那棵目录树收走了')
    assert(onB.ids.includes(`dir:${dirB}`), `① 乙拿到的是它自己 workdir 的那一棵(${dirB})`)

    console.log('\n[4/5] 切回甲 —— ②原位 ③活动格对')
    await enterSession(page, idA)
    const back = await readTabs(page)
    assert(
      JSON.stringify(back.ids) === JSON.stringify(opened.ids),
      `② 目录与文件都回到原来那个位次(${back.ids.join(' | ')})`,
    )
    assert(back.active === activeBefore, `③ 活动格就是离开时那一格(${back.active})`)
    assert(!back.ids.includes(`dir:${dirB}`), '② 乙那棵没跟过来(收放是双向的)')

    console.log('\n[5/5] 把目录钉住,再切一轮 —— ④钉住的不收')
    await page.evaluate((id) => {
      const tab = document.querySelector(`[data-tab-id="${id}"]`)
      if (!(tab instanceof HTMLElement)) return
      const rect = tab.getBoundingClientRect()
      tab.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.bottom),
      }))
    }, `dir:${dirA}`)
    await delay(300)
    const pinned = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[role="menuitem"]'))
      const row = rows.find((el) => (el.textContent ?? '').includes('钉住'))
      if (!(row instanceof HTMLElement)) return false
      row.click()
      return true
    })
    assert(pinned, '④ 标签右键表里有「钉住」那一行(它只在伴随面上出现)')
    await delay(300)
    await enterSession(page, idB)
    const afterPin = await readTabs(page)
    assert(
      afterPin.ids.includes(`dir:${dirA}`),
      `④ 钉住的那棵目录树一动不动(${afterPin.ids.join(' | ')})`,
    )
    assert(!afterPin.ids.includes(`file:${fileA}`), '④ 没钉的那格照旧被收走')
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
    console.error(`\n[companions-gate] FAILED —— ${failures.length} 条:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[companions-gate] ok —— 伴随面按会话收放:切走收干净、切回原位、活动格对、钉住的不动')
}

main().catch((error) => {
  console.error(`\n[companions-gate] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
