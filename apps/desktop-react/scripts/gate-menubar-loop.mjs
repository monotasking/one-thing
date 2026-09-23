#!/usr/bin/env node
/**
 * **真机门:点目录 chip 之后菜单栏不自激**(09-23,「菜单栏一直闪」)。
 *
 * ── 病 ────────────────────────────────────────────────────────────────────
 * 用户机器上 `shell.menu` 的读数:`menu rebuilt` 4 分钟 11,030 条、间隔 ~8ms、全是
 * `reason:'spec'`,同一段应用活动态只切了 5 次 —— 菜单在**逐帧重建**,而两道去重都没
 * 挡住,说明渲染侧推下来的 spec 帧帧不同。
 *
 * 隔离真机复现出来的形(本门 ② 的场面就是它):中央那条标签条上摆着两条会话
 * 「甲 | 乙」、亮着乙、目录记忆落舞台;点乙消息里的目录 chip —— 目录作为**乙的伴随面**
 * 开进同一片叶并成为活动格。于是:
 *   `leafSessionOf` 看活动格不是会话 → 回落到叶里**第一格**会话(甲)
 *   → 环境会话 乙→甲 → 伴随面收放把乙的目录收走 → 活动格回到乙
 *   → 环境会话 甲→乙 → 目录又放回来 → …
 * 一条无尽的微任务链:渲染进程卡死(CDP 的一次点击都等不回来),主进程 3s 收到
 * ~1300 帧(strict)/ ~2700 帧(生产)菜单,帧与帧之间只差两组 enabled ——
 * `tab.select:3`(三格)与 `tab.new` / `content.new`(活动格是会话)。
 * 根因与修法的判词在 `src/content/session-ref.ts` 的 `leafShowsSession` 上。
 *
 * ── 三问 ──────────────────────────────────────────────────────────────────
 *  ① 点之前静置 2s:`setApplicationMenu` ≤ 1(场面本身不闪 —— 对照);
 *  ② 点 chip 之后 3s:`setApplicationMenu` ≤ 2,且这一下点击在 4s 内回得来
 *     (渲染进程没被一条微任务链卡死);
 *  ③ 收敛到的那一格是对的:目录那一格还在中央、是活动格(没被收走)。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * 窗子离屏起(`ONETHING_GATE_HEADLESS=1` + `ONETHING_GATE_OFFSCREEN=1`),不抢用户
 * 前台;焦点由 CDP `Emulation.setFocusEmulationEnabled` 补。store 与
 * `--user-data-dir` 都是临时目录,**绝不连 `~/.onething`**;助手那条消息由本地假
 * provider 吐出。渲染进程若被卡死,`app.close()` 等不回来,所以收尸用 SIGKILL。
 *
 * 跑法:`npm run gate:menubar`(先 `npm run app:build`)。
 * 量一份别的渲染层产物:`ONETHING_GATE_DIST=<目录> npm run gate:menubar`
 * (修之前那份生产产物在这道门上红:① 0 次照绿,② 两趟 2448 / 3118 次、点击回不来,③ 读不到)。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import {
  FAKE_PROVIDER_ENV,
  fakeProviderAiSettings,
  startFakeProvider,
} from '../../../scripts/lib/gate-fake-provider.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')
const DIST = process.env.ONETHING_GATE_DIST || 'dist'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`超时 ${ms}ms:${label}`)), ms)),
  ])

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

async function waitFor(label, predicate, timeoutMs = 25_000) {
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
    headers: { 'content-type': 'application/json', authorization: `Bearer ${record.token}` },
    body: JSON.stringify({ domain, method, payload }),
  })
  const body = await response.json()
  if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  return body.data
}

async function main() {
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, DIST, 'index.html'))) {
    console.error(`[menubar-gate] 找不到构建产物(${DIST})—— 先跑 \`npm run app:build\``)
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'menubar-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'menubar-gate-udd-'))
  const workdir = path.join(store, 'wd')
  const target = path.join(workdir, 'src')
  await mkdir(path.join(target, 'inner'), { recursive: true })
  writeFileSync(path.join(target, 'a.ts'), 'export const a = 1\n')
  const provider = await startFakeProvider(0, `好的。看一下 \`${target}/\` 这个目录,里面有 a.ts。`)
  writeFileSync(
    path.join(store, 'settings.json'),
    JSON.stringify({
      ai: fakeProviderAiSettings(provider.address().port),
      tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
      diagnostics: { enabled: false },
    }, null, 2),
  )

  let app
  try {
    console.log(`\n[1/3] 拉起应用(离屏 · 独立 --user-data-dir · 渲染层 ${DIST}),种两条会话`)
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ...FAKE_PROVIDER_ENV,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
        ONETHING_GATE_HEADLESS: '1',
        ONETHING_GATE_OFFSCREEN: '1',
        ONETHING_GATE_DIST: DIST,
      },
    })
    await app.evaluate(({ Menu }) => {
      globalThis.__gateMenuCalls = []
      const original = Menu.setApplicationMenu.bind(Menu)
      Menu.setApplicationMenu = (menu) => {
        globalThis.__gateMenuCalls.push(Date.now())
        return original(menu)
      }
    })
    const menuCallsSince = (t) =>
      // `app.evaluate` 把 electron 模块当第一个参数递进来,自己的参数在第二格。
      app.evaluate((_electron, since) => globalThis.__gateMenuCalls.filter((at) => at >= since).length, t)

    const record = await waitFor('壳写出发现文件', () => readDiscovery(store))
    // 甲**不绑工作目录**(新开的会话就是这样):乙的目录收起时甲那一侧继承不出任何
    // 东西,目录真的离场 —— 旧代码的环要靠这一格才闭得上。
    const idA = (await rpc(record, 'sessions', 'create', { name: '菜单门 · 甲' }))?.session?.id
    const idB = (await rpc(record, 'sessions', 'create', { name: '菜单门 · 乙' }))?.session?.id
    if (!idA || !idB) throw new Error('sessions.create 没给出会话 id')
    await rpc(record, 'sessions', 'updateWorkingDirectory', { sessionId: idB, workingDirectory: workdir })

    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('Dock 就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))))

    /*
     * 场面:中央那片叶 = 「甲 | 乙」、亮着乙;目录记忆落舞台(= 用户那份存档)。
     * 改的是持久化那一份再重载 —— 与用户重启之后看到的是同一条路。
     */
    await page.evaluate(([a, b]) => {
      const wb = JSON.parse(localStorage.getItem('onething.workbench'))
      const space = wb.state.byWorkspace.default
      const centerId = space.regions.center?.id ?? 'leaf-gate-center'
      space.regions = {
        ...space.regions,
        center: { kind: 'leaf', id: centerId, tabs: [{ kind: 'session', key: a }, { kind: 'session', key: b }], active: 1 },
      }
      space.sessionCompanions = {}
      localStorage.setItem('onething.workbench', JSON.stringify(wb))
      const st = JSON.parse(localStorage.getItem('onething.stage'))
      const furniture = st.state.byWorkspace.default
      furniture.memory = { ...(furniture.memory ?? {}), files: { kind: 'stage' } }
      localStorage.setItem('onething.stage', JSON.stringify(st))
    }, [idA, idB])
    await page.reload()
    await waitFor('重载后 Dock 就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))))
    await delay(1000)

    await rpc(record, 'session-command', 'emit', {
      sessionId: idB,
      command: { type: 'command:send-message', content: '看看目录' },
    })
    await waitFor('助手消息里的目录 chip 上屏', () =>
      page.evaluate(() => document.querySelectorAll('[data-ref-kind="dirRef"]').length > 0))
    await delay(1200)

    console.log('\n[2/3] 静置 2s(对照)')
    // 计数器真的接上了:壳起来那一刻至少画过一次菜单。读不到这一条,② 的「≤ 2」就是空话。
    const drawnAtBoot = await menuCallsSince(0)
    assert(drawnAtBoot >= 1, `⓪ 计数器接上了(启动以来 setApplicationMenu ${drawnAtBoot} 次)`)
    const quietFrom = Date.now()
    await delay(2000)
    const quiet = await menuCallsSince(quietFrom)
    assert(quiet <= 1, `① 点之前 2s 内 setApplicationMenu ${quiet} 次(≤ 1)`)

    console.log('\n[3/3] 点 chip,量 3s')
    const box = await page.evaluate(() => {
      const el = document.querySelector('[data-ref-kind="dirRef"]')
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    const clickAt = Date.now()
    let clickCameBack = true
    await withTimeout(
      (async () => {
        const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
      })(),
      4000,
      '一次点击',
    ).catch(() => {
      clickCameBack = false
    })
    await delay(3000)
    const storm = await menuCallsSince(clickAt)
    assert(clickCameBack, '② 这一下点击回得来(渲染进程没被卡死)')
    assert(storm <= 2, `② 点之后 3s 内 setApplicationMenu ${storm} 次(≤ 2)`)

    if (clickCameBack) {
      const tabs = await withTimeout(page.evaluate(() => {
        const strip = document.querySelector('[data-testid="topbar-tabs"]') ?? document.querySelector('[role="tablist"]')
        const all = strip ? Array.from(strip.querySelectorAll('[data-tab-id]')) : []
        return {
          ids: all.map((el) => el.getAttribute('data-tab-id')),
          active: all.find((el) => el.getAttribute('aria-selected') === 'true')?.getAttribute('data-tab-id') ?? null,
        }
      }), 3000, '读标签条')
      assert(tabs.active === `dir:${target}`, `③ 目录那一格留在中央、是活动格(${tabs.ids.join(' | ')};亮 ${tabs.active})`)
    } else {
      assert(false, '③ 渲染进程卡死,读不到标签条')
    }
  } finally {
    if (app) {
      try {
        app.process().kill('SIGKILL')
      } catch {
        /* 已经走了 */
      }
    }
    provider.close()
    await delay(300)
    await rm(store, { recursive: true, force: true }).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  }

  if (failures.length) {
    console.error(`\n[menubar-gate] FAILED —— ${failures.length} 条:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[menubar-gate] ok —— 点目录 chip 之后菜单不自激,目录那一格留在原地')
}

main().catch((error) => {
  console.error(`\n[menubar-gate] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
