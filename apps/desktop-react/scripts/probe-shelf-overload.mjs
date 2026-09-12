/**
 * **「收起 ≠ 关闭」那一拍的超量读数**(2026-09-12,验收第 5 轴)。
 *
 * 门(`gate:layout` ⑧ 那一段)量的是一条**空架子**收起 / 展开;这只探针量的是
 * 同一拍在**真店规模**上的价:`scripts/lib/seed-large-ledger.mjs` 的缺省夹具
 * (≥50MB `events.jsonl` / 400 条消息 / 900 张工具卡,与 2026-09-10 用户真会话同量),
 * 那条会话钉在右架子上,然后**收起 → 展开**,量展开那一拍:
 *
 *   · 最长帧 ms(页内 `long-animation-frame`,**切窗口取样** —— `buffered: true`
 *     会把整趟的历史帧一次交过来,09-12 判例);
 *   · ≥50ms 的长帧个数(条目门槛本身就是 50ms,所以「一条都没有」= 都在预算内)。
 *
 * 改之前收起是把整棵 `PaneTree` 连同内容子树**卸载**,展开时从零重建 —— 在这个
 * 量级上那是一次整棵消息树的重挂;改之后树身只是隐藏 + `inert`,展开那一拍
 * 只有一格 class 与 `inert` 属性在动。两侧读数的差就是这条改动的价值。
 *
 * 用法:`node scripts/probe-shelf-overload.mjs [--prod]`(两档都要跑 —— 用户跑的是
 * `electron:dev`,prod 上的数对它不成立,第 5 轴的原话)。
 * 它**不是门**:只打表,不判红。
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { seedLargeLedger } from './lib/seed-large-ledger.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')
const PROD = process.argv.includes('--prod')
const DEV_PORT = Number(process.env.ONETHING_PROBE_VITE_PORT ?? 5193)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(what, fn, ms = 120_000) {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) throw new Error(`超时:${what}`)
    await delay(150)
  }
}

const portConnects = (host, port) =>
  new Promise((resolve) => {
    const s = connect({ host, port })
    const settle = (v) => {
      s.destroy()
      resolve(v)
    }
    s.setTimeout(800)
    s.once('connect', () => settle(true))
    s.once('error', () => settle(false))
    s.once('timeout', () => settle(false))
  })

async function rpc(record, domain, method, payload = {}) {
  const res = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
    },
    body: JSON.stringify({ domain, method, payload }),
  })
  const body = await res.json()
  if (!body?.ok) throw new Error(`rpc ${domain}.${method}: ${JSON.stringify(body?.error ?? body)}`)
  return body.data
}

async function startCore(store) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: { ...process.env, ONETHING_STORE_PATH: store },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const record = await waitFor('core 的发现文件', async () => {
    try {
      const found = JSON.parse(await readFile(path.join(store, 'run', 'http.json'), 'utf-8'))
      return found?.pid === child.pid ? found : undefined
    } catch {
      return undefined
    }
  })
  if (!(await portConnects(record.host, record.port))) throw new Error('core 端口连不上')
  return { child, record }
}

async function stopCore(child) {
  if (!child?.pid) return
  try {
    process.kill(child.pid, 'SIGTERM')
  } catch {
    /* 已经走了 */
  }
  await delay(900)
  try {
    process.kill(child.pid, 'SIGKILL')
  } catch {
    /* 已经走了 */
  }
}

/** 页内 LoAF 探针。取号 / 收号之间就是取样窗口(判词见文件头)。 */
const installProbe = (page) =>
  page.evaluate(() => {
    if (window.__shelfLoaf) return
    const P = (window.__shelfLoaf = { frames: [] })
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) P.frames.push(Math.round(e.duration))
      }).observe({ type: 'long-animation-frame', buffered: true })
    } catch (error) {
      P.err = String(error)
    }
  })
const mark = (page) => page.evaluate(() => window.__shelfLoaf?.frames.length ?? -1)
const harvest = (page, m) =>
  page.evaluate((at) => {
    const P = window.__shelfLoaf
    if (!P || P.err || at < 0) return { known: false, longest: 0, frames: 0 }
    const slice = P.frames.slice(at)
    return {
      known: true,
      longest: slice.length ? Math.max(...slice) : 0,
      frames: slice.length,
    }
  }, m)

async function main() {
  if (!existsSync(serverEntry)) throw new Error('先在仓根跑 `bun run server:build`')
  if (!existsSync(mainEntry)) throw new Error('先跑 `npm run app:build`')

  const store = await mkdtemp(path.join(tmpdir(), 'shelf-probe-store-'))
  const udd = await mkdtemp(path.join(tmpdir(), 'shelf-probe-udd-'))
  let core
  let app
  let vite
  const out = { lane: PROD ? 'prod' : 'dev' }
  try {
    mkdirSync(path.join(store, 'settings'), { recursive: true })
    writeFileSync(
      path.join(store, 'settings.json'),
      JSON.stringify({ search: { semantic: { enabled: false } } }, null, 2),
    )
    core = await startCore(store)
    const sid = (await rpc(core.record, 'sessions', 'create', { name: '收起探针 · 真店规模' }))
      ?.session?.id
    /*
     * **中央区不许空**:一片叶上只剩最后一格时,叶菜单里「移到架子 / 撕出去 /
     * 关闭」整排禁灰(实测:六行里五行 `disabled`)。所以陪一条空会话进中央区,
     * 大账本那一格才挪得走。
     */
    const filler = (await rpc(core.record, 'sessions', 'create', { name: '收起探针 · 陪跑' }))
      ?.session?.id
    if (!sid || !filler) throw new Error('会话没建出来')

    await stopCore(core.child)
    const seeded = seedLargeLedger(store, sid, {})
    out.fixture = `${(seeded.bytes / 1024 / 1024).toFixed(1)}MB / ${seeded.messages} 条 / ${seeded.toolCalls} 张卡`
    console.log(`[夹具] ${out.fixture}`)
    core = await startCore(store)

    let rendererUrl = ''
    if (!PROD) {
      const { createServer } = await import('vite')
      vite = await createServer({
        configFile: path.join(appRoot, 'vite.config.ts'),
        server: { port: DEV_PORT, strictPort: true },
        logLevel: 'warn',
      })
      await vite.listen()
      rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`
    }

    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${udd}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: rendererUrl,
        ONETHING_GATE_HEADLESS: '1',
      },
    })
    const page = await app.firstWindow()
    /*
     * 窗子撑到 1600×1100:共同预算(视口 − 中央最小 − 对边厚度)在 1280 的窗里
     * 装不下「左架子 400(总览的出厂落点)+ 右架子 400」,那一行菜单会**禁灰**。
     */
    const win = await app.browserWindow(page)
    await win.evaluate((w) => {
      w.setMinimumSize(200, 200)
      w.setContentSize(1600, 1100)
    })
    await delay(600)
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const v = await page.evaluate(() => window.__d0 ?? null)
      return v?.rpcOk ? v : undefined
    })

    // 开总览 → 点那一行 → 那条会话进中央区(冷载 50MB,这一段不计价)。
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    await page.evaluate(() => document.querySelector('[data-testid="dock-tile-sessions"]').click())
    await waitFor('总览画出那一行', () =>
      page.evaluate((id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sid),
    )
    // 先把陪跑那条开进中央区(判词见上),再开大账本那条。
    await waitFor('陪跑那一行也在', () =>
      page.evaluate((id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), filler),
    )
    await page.evaluate((id) => document.querySelector(`[data-testid="session-row-${id}"]`).click(), filler)
    await delay(800)
    // 大账本那条走**右键 → 在新标签页打开**:缺省 `replace` 会把陪跑那条顶掉,
    // 中央区又剩一格,叶菜单整排照旧禁灰(判词见上)。
    await page.evaluate((id) => {
      const row = document.querySelector(`[data-testid="session-row-${id}"]`)
      const r = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: Math.round(r.x + 20),
        clientY: Math.round(r.y + r.height / 2),
      }))
    }, sid)
    await delay(450)
    const rowMenu = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => ({
        t: (el.textContent ?? '').trim(),
        off: el.disabled === true,
      })),
    )
    console.log(`      会话行菜单:${JSON.stringify(rowMenu)}`)
    await page.getByRole('menuitem', { name: /new tab|新标签/i }).click()
    await waitFor('那条会话的消息树上屏', () =>
      page.evaluate(() => document.querySelectorAll('[data-message-id]').length > 20),
    )
    console.log('      中央区消息树上屏了')
    await delay(2500)
    out.rows = await page.evaluate(() => document.querySelectorAll('[data-message-id]').length)

    // 把它挪到右架子:右键那一格标签 →「移到架子 ▸ 右侧栏」。
    await page.keyboard.press('Escape')
    await delay(300)
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')].map((el) => el.getAttribute('data-tab-id')),
    )
    console.log(`      屏幕上的标签:${JSON.stringify(tabs)}`)
    await page.evaluate((id) => {
      const tab = document.querySelector(`[role="tab"][data-tab-id="session:${id}"]`)
      if (!tab) throw new Error('找不到那一格标签')
      const r = tab.getBoundingClientRect()
      window.__probeTabBox = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), inShelf: Boolean(tab.closest('[data-shelf-body]')), inTop: Boolean(tab.closest('[data-testid="topbar"]')) }
      tab.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: Math.round(r.x + r.width / 2),
          clientY: Math.round(r.y + r.height / 2),
        }),
      )
    }, sid)
    await delay(500)
    /*
     * 「移到架子 ▸」是一格子菜单:用 playwright 的真点击(它派的是真 pointer 事件),
     * 页内 `.click()` 在这一格上打不开它。
     */
    const topRows = await page.evaluate(() => ({
      vp: { w: window.innerWidth, h: window.innerHeight },
      shelves: [...document.querySelectorAll('[data-shelf]')].map((el) => el.getAttribute('data-shelf')),
      tab: window.__probeTabBox,
      menus: [...document.querySelectorAll('[role="menu"]')].map((m) => m.getAttribute('aria-label')),
      rows: [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => ({
        t: (el.textContent ?? '').trim(),
        off: el.disabled === true,
      })),
    }))
    console.log(`      叶菜单(带禁灰):${JSON.stringify(topRows)}`)
    await page.getByRole('menuitem', { name: /^Move to shelf$|^移到架子$/ }).click()
    await delay(400)
    const subRows = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => ({
        t: (el.textContent ?? '').trim(),
        off: el.disabled === true,
      })),
    )
    console.log(`      子表:${JSON.stringify(subRows)}`)
    await page.getByRole('menuitem', { name: /^Right shelf$|^右侧栏$/ }).click()
    console.log('      点完「移到架子 ▸ 右侧栏」')
    await delay(600)
    await waitFor('那条会话落到右架子上了', () =>
      page.evaluate(() =>
        document.querySelector('[data-shelf-body="right"] [data-message-id]') ? true : undefined,
      ),
    )
    await delay(2500)
    out.rowsOnShelf = await page.evaluate(
      () => document.querySelectorAll('[data-shelf-body="right"] [data-message-id]').length,
    )

    await installProbe(page)
    const laps = []
    for (let i = 0; i < 3; i += 1) {
      // 收起(这一拍不计价 —— 要量的是展开)
      await page.keyboard.press('Meta+Alt+ArrowRight')
      await delay(1200)
      const collapsed = await page.evaluate(() => ({
        collapsed: Boolean(document.querySelector('[data-shelf="right"][data-shelf-collapsed]')),
        body: Boolean(document.querySelector('[data-shelf-body="right"]')),
        rows: document.querySelectorAll('[data-shelf-body="right"] [data-message-id]').length,
      }))
      const at = await mark(page)
      await page.keyboard.press('Meta+Alt+ArrowRight')
      await delay(1500)
      const got = await harvest(page, at)
      const back = await page.evaluate(() => ({
        rows: document.querySelectorAll('[data-shelf-body="right"] [data-message-id]').length,
      }))
      laps.push({ ...got, collapsedBodyInDom: collapsed.body, collapsedRows: collapsed.rows, backRows: back.rows })
      await delay(600)
    }
    out.laps = laps
    out.longest = Math.max(...laps.map((l) => l.longest))
    out.longFrames = Math.max(...laps.map((l) => l.frames))
    console.log(`[${out.lane}] ${JSON.stringify(out)}`)
  } finally {
    if (app) await app.close().catch(() => {})
    if (vite) await vite.close().catch(() => {})
    await stopCore(core?.child)
    await delay(400)
    await rm(store, { recursive: true, force: true }).catch(() => {})
    await rm(udd, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((e) => {
  console.error('[shelf-probe] FAILED:', e?.stack ?? e)
  process.exit(1)
})
