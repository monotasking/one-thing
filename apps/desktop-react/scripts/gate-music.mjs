#!/usr/bin/env node
/**
 * **音乐面的真机门**(音乐收尾 · 壳半边,2026-09-10)。体例照 `gate-resources.mjs`
 * (同一套起法、同一套收尸、同一条「窗子离屏起、不抢用户的机器」纪律)。
 *
 * ── 它证的是一句话 ──────────────────────────────────────────────────────
 * **这块面上的按钮走的是资源路,不是 `music` RPC 域。** 三步:
 *
 *  ① 起一台隔离 store 的 core + 离屏拉起桌面壳,等它连通;
 *  ② 点开 Dock 上那块音乐瓦 —— 面板真的开出来(CDP 看得见
 *     `[data-testid="music-panel"]`),而且**五条读真的发出去了**:
 *     `music:radio#brief` / `music:radio#programme` / `music:player#nowPlaying` /
 *     `music:player#lyrics` / `music:provider#state`;
 *  ③ 点「暂停」那颗钮 —— 网线上多一发 `resources.do(music:player, pause)`,
 *     而且**整场没有一发 `music` 域的调用**。
 *
 * ── 判据是**网线上那些信封**,不是 core 的账本 ──────────────────────────
 * 试过账本那条路,不成立:`<store>/audit/resource.jsonl` 落的是 `{callId, toolId,
 * principal, effects, outcome}`(`backend/wiring/toolkit/audit-sink.ts`),`toolId`
 * 只到 scheme 那一层(`kernel.ts:411`),而**读根本不落审计**(§2 不变量 1:读是
 * 纯查询,不改任何东西也不该留痕)。拿它判「哪五条读发出去了」是在读一份不存在
 * 的记录。
 *
 * 网线判得了,而且判得更准:这道门要抓的病是「面板绕开资源路直调 `music` 域」,
 * 而两条路在网线上是**两个不同的信封**(`{domain:'resources'}` vs
 * `{domain:'music'}`)。所以这里挂一只 `page.on('request')` 把每一发
 * `POST /api/rpc` 的 body 记下来,末尾断言:五条 `resources.read` 在、
 * 一条 `resources.do(pause)` 在、`domain === 'music'` 的**一发都没有**。
 * 最后那一句是这道门真正的钉子 —— 前两句只说明它工作,它说明它没有第二条路。
 *
 * ── 为什么它**只写不跑**(派工单原话)────────────────────────────────────
 * 这台机器上没有装 ncm-cli、没有登录,所以 `music:provider#state` 会答
 * 「还没配好」,而 `pause` 会以 `failed` 收场 —— **那不影响这道门**:它判的是
 * 「那一次调用有没有沿着资源路走到 core」,不是「音乐有没有响」。真要判后者,
 * 得先在门里装一只 CLI,那是另一回事(而且会动这台机器)。
 * 跑之前先 `bun run server:build`(仓根)+ `npm run app:build`(本目录)。
 *
 *   node scripts/gate-music.mjs
 *
 * 每次全新的临时 store / workspace / user-data-dir,跑完删干净(验证不改用户状态)。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
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

async function clickSelector(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!(el instanceof HTMLElement)) throw new Error(`找不到 ${sel}`)
    el.click()
  }, selector)
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[music-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[music-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'music-gate-store-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'music-gate-ws-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'music-gate-userdata-'))
  let server
  let app
  try {
    console.log('\n[1/3] 起一台 core(隔离 store)')
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
    assert(await portConnects(record.host, record.port), `core 端口 ${record.port} 可连`)

    console.log('\n[2/3] 离屏拉起桌面壳,点开音乐瓦,看五条读有没有真的发出去')
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

    /*
     * 每一发 `POST /api/rpc` 的信封。**挂在拉起之后、点任何东西之前** ——
     * 首载那五条读发生在点开面板的那一刻,漏了这只监听就什么都判不了。
     */
    const envelopes = []
    page.on('request', (request) => {
      if (request.method() !== 'POST' || !request.url().includes('/api/rpc')) return
      try {
        envelopes.push(JSON.parse(request.postData() ?? '{}'))
      } catch {
        /* 不是 JSON 的那一发与这道门无关 */
      }
    })
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })

    await clickSelector(page, '[data-testid="dock-tile-music"]')
    const opened = await waitFor('音乐面开出来', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="music-panel"]'))),
    )
    assert(opened, 'CDP 在屏幕上看到音乐面')

    /** 五条读,逐条 `<ref>#<name>`。它们与自述里那五格一一对得上。 */
    const WANT_READS = [
      'music:radio#brief',
      'music:radio#programme',
      'music:player#nowPlaying',
      'music:player#lyrics',
      'music:provider#state',
    ]
    const seenReads = () =>
      envelopes
        .filter((row) => row.domain === 'resources' && row.method === 'read')
        .map((row) => `${row.payload?.ref}#${row.payload?.name}`)

    await waitFor('五条读都上了网线', () => {
      const seen = seenReads()
      return WANT_READS.every((want) => seen.includes(want)) ? seen : undefined
    }).catch((error) => {
      throw new Error(`${error.message}\n此刻发过的读:\n${JSON.stringify(seenReads(), null, 2)}`)
    })
    assert(true, `五条读全在(${WANT_READS.join(' ')})`)

    console.log('\n[3/3] 点「暂停」—— 网线上多一发 resources.do(music:player, pause)')
    await clickSelector(page, '[data-testid="music-play"]')
    await waitFor('网线上出现那一发 do', () =>
      envelopes.find(
        (row) =>
          row.domain === 'resources' &&
          row.method === 'do' &&
          row.payload?.ref === 'music:player' &&
          row.payload?.op === 'pause',
      ),
    ).catch((error) => {
      throw new Error(
        `${error.message}\n此刻发过的信封:\n${JSON.stringify(envelopes.map((r) => `${r.domain}.${r.method}`), null, 2)}`,
      )
    })
    assert(true, '那一次点击发的是 resources.do(music:player, pause)')

    /*
     * **这道门真正的钉子**:整场一发 `music` 域都没有。前两句只说明它工作,
     * 这一句说明它没有第二条路 —— 把面板里任何一颗钮改回 `client.api(musicRouter)`,
     * 这一句当场红,而前两句里的读那一半照样绿。
     */
    const strays = envelopes.filter((row) => row.domain === 'music')
    assert(
      strays.length === 0,
      `整场零发 music 域调用(有的话就是有人绕开了资源路:${JSON.stringify(strays)})`,
    )

    await app.close()
    app = undefined
    console.log('\n[music-gate] ok —— 音乐面上的按钮走的是资源路,与模型调的同一条')
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('\n[music-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
