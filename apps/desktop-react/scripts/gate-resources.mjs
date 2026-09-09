#!/usr/bin/env node
/**
 * **原子 K2b-2b 的真机门** —— 壳侧提供者(`docs/design/atom-2026-09.md` §5 /
 * §10.2 / §10.3)。体例照 `gate-files.mjs`(同一套起法、同一套收尸)。
 *
 * 它证的是一句话:**AI 那条路能真的开一格面板**。四步,一步都不靠人眼:
 *
 *  ① 起一台隔离 store 的 core + 离屏拉起桌面壳,等它连通;
 *  ② 经 `/api/rpc` 问 `resources.list` / `resources.describe` —— `workbench` 这个
 *     命名空间在场,而且它的每条做法 `home` 都是 `shell`(壳交上来的自述真的进了
 *     那台内核,不是壳自己心里知道);
 *  ③ 经 `/api/rpc` 打 `resources.do('workbench:center', 'open', { target:
 *     'session:<id>' })` —— **调用方是一个 curl,不是那扇壳**,命令要经 SSE 绕到壳
 *     里跑完再绕回来。CDP 看到中央区标签条上真的多了那一格;
 *  ④ 再打 `resources.read('workbench:center', 'layout')`,断言那份读数里含它。
 *
 * ③ 与 ④ 合起来是这一单的整句话:**一条 `home: 'shell'` 的做法,授权在 core 里
 * 判、apply 在壳里跑、结局回到调用方手上**。少了 ③ 只证了壳自己能改自己;少了 ④
 * 只证了屏幕变了而 core 问不出来。
 *
 * ── 跑法(仓根先 `bun run server:build`,本目录先 `npm run app:build`)────────
 *   node scripts/gate-resources.mjs
 *
 * 每次全新的临时 store / workspace / user-data-dir,跑完删干净(验证不改用户状态)。
 * 窗子**离屏**起(`ONETHING_GATE_HEADLESS=1`,09-04 判例「真机门不许抢用户的机器」),
 * 焦点由 CDP `Emulation.setFocusEmulationEnabled` 补,不动真光标。
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

const SESSION_NAME = 'K2b-2b 门 · 壳侧资源'

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

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[k2b2-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[k2b2-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'k2b2-gate-store-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'k2b2-gate-ws-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'k2b2-gate-userdata-'))
  let server
  let app
  try {
    console.log('\n[1/4] 起一台 core(隔离 store),建一条会话')
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

    const created = await rpc(record, 'sessions', 'create', { name: SESSION_NAME })
    const sessionId = created?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(created)}`)

    console.log('\n[2/4] 离屏拉起桌面壳,等它把自己交给 core')
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
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })

    // 登记是异步的(连通之后一次 `mountShell`),所以这里等注册表说话 ——
    // 等的是 **core 侧的事实**,不是壳里的一个变量。
    const listed = await waitFor('core 的注册表里出现 workbench', async () => {
      const answer = await rpc(record, 'resources', 'list', {})
      return (answer.schemes ?? []).some((row) => row.scheme === 'workbench') ? answer : undefined
    })
    assert(
      listed.schemes.some((row) => row.scheme === 'workbench'),
      `resources.list 里有 workbench(共 ${listed.schemes.length} 个命名空间)`,
    )

    const described = await rpc(record, 'resources', 'describe', { scheme: 'workbench' })
    const homes = Object.entries(described.ops ?? {}).map(([name, op]) => `${name}=${op.home}`)
    assert(
      Object.values(described.ops ?? {}).every((op) => op.home === 'shell'),
      `describe 里每条做法的 home 都是 shell(${homes.join(' ')})`,
    )

    console.log('\n[3/4] 一个 curl 打 do(workbench:center, open) —— 命令绕到壳里跑')
    const target = `session:${sessionId}`
    const outcome = await rpc(record, 'resources', 'do', {
      ref: 'workbench:center',
      op: 'open',
      params: { target },
    })
    assert(
      outcome.kind === 'ok',
      `结局是 ok(${outcome.kind}${outcome.kind === 'ok' ? `:${outcome.text}` : `:${JSON.stringify(outcome)}`})`,
    )

    /*
     * 屏幕上真的多了那一格。取件按 `ui/Tabs` 那颗**标签本身**的把手
     * `data-tab-id`(= refId,tab 条的 `TabSpec.id`)—— 那是这台壳里「一格标签」
     * 唯一的 DOM 身份,不是这道门新造的把手。
     */
    const onScreen = await waitFor('中央区标签条上出现那一格', () =>
      page.evaluate(
        (id) => Boolean(document.querySelector(`[data-tab-id="${id}"]`)),
        target,
      ),
    )
    assert(onScreen, `CDP 在屏幕上看到 ${target}`)

    console.log('\n[4/4] read(workbench:center, layout) —— core 问得出这件事')
    const read = await rpc(record, 'resources', 'read', {
      ref: 'workbench:center',
      name: 'layout',
    })
    assert(read.kind === 'ok', `读的结局是 ok(${read.kind})`)
    // K2c-2:读走的是读自己那条路,`ok` 带的是**值**不是一段要解回来的文本
    // (`ResourceReadView`,`@shared/ipc/resources.ts`)。
    const layout = read.value
    const tabs = (layout.regions ?? []).flatMap((region) => region.leaves.flatMap((leaf) => leaf.tabs))
    assert(tabs.includes(target), `layout 读数里含 ${target}(共 ${tabs.length} 格)`)

    await app.close()
    app = undefined
    console.log('\n[k2b2-gate] ok —— 壳把 workbench 交给了 core,一条 home:shell 的做法真的跑在壳里')
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
  console.error('\n[k2b2-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
