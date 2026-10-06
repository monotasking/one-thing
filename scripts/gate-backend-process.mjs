#!/usr/bin/env node
/**
 * `gate:backend-process` —— 第④步批 2a「后端进程能独当一面」的门(`docs/design/two-process-2026-10.md` §2.3 验收,
 * 不开窗的那一半;批 2b 再加「起 Electron 离屏 → 杀后端子进程 → 断言 D11」那一半)。
 *
 * 跑的是**产物**:`apps/desktop-react/dist-electron/backend.cjs`(`electron:build` 或
 * `node apps/desktop-react/scripts/build-electron.mjs` 打出来的那一份,批 2b 起桌面拉起的就是它)。
 * 两个运行时各跑一遍同一份产物(决策 D1 / D12):
 *   - **Electron 二进制 + `ELECTRON_RUN_AS_NODE=1`**(批 2b 桌面拉起它的方式);
 *   - **系统 Node**(D12 的 (b) 路:没装 app 的机器上 CLI 用系统 Node 跑后端)。
 *
 * 每个运行时、桌面档(`ONETHING_BACKEND_LAUNCHER=desktop`)下逐项断言:
 *   ① 发现文件 `owner === 'backend'`,`pid` 就是起的那个子进程;
 *   ② `GET /api/capabilities` 的 `terminal` 与 `localFileSystem` 为真;
 *   ③ MCP 真起了:临时 store 里一份假的 stdio MCP 服务器配置,`mcp.getServers` 答 `connected` 且列出它的工具;
 *   ④ 用户定时任务已初始化:store 里预置的一条任务出现在 `scheduler.list` 里;
 *   ⑤ 日志进 `app.jsonl`,记着起了哪几件(定时任务 / 电台 / 首启模型拉取),stdout 上没有日志回显;
 *   ⑥ 进程名是 `onething-backend`;
 *   ⑦ SIGTERM 后 5 秒内退出、退出码 0、发现文件删掉;
 *   ⑧ 它活着时再起一台缺省档(`server:start` 那一份)会让位、退出码 1(决策 D6:不看 owner)。
 * 不断言的:ACP 名册的「装没装」探测按的是不是补过的 PATH(登录 shell 赶在 `acp.start()` 之前落定靠的是
 * `createRealServerBackend` 里那一行的次序,D291);电台真出声(那要播放器与音频设备)。
 * 另跑一遍**缺省档对照**(不设档位,系统 Node):owner `server`、MCP 不连(server 缺省的 `DisabledServerMCPClient`)、
 * 那条任务不在调度器里、日志进 `server.jsonl`,以及两台缺省档互相让位(D6 修掉的那个洞)—— 证明上面几项断言
 * 分得清两档,不是恒真。
 *
 * 纪律:
 *  - 临时 store(`mkdtemp`),显式覆盖 `ONETHING_STORE_PATH`,不碰 `~/.onething`;
 *  - `ONETHING_CREDENTIALS_KEYRING=file`:macOS 缺省档是钥匙串,这一格是这道门与用户真钥匙串之间唯一的那道闸;
 *  - 不开窗:`ELECTRON_RUN_AS_NODE=1` 起出来的是一条 node,没有 Chromium、没有窗口、不进 Dock;
 *  - 首启模型拉取会去 models.dev:store 里预置一格模型目录,它看到「已有目录」就跳过,门不出网;
 *  - 起的子进程(后端、它拉起的假 MCP 服务器)跑完全部收掉,临时目录删掉。
 *
 * 用法:`bun run gate:backend-process [--build] [--runtimes=electron,node] [--timing=5]`。
 *   `--build` 用桌面构建配方导出的同一组 esbuild 选项把产物打进门自己的缓存目录(不碰 `dist-electron/`);
 *   `--runtimes=node` 只跑系统 Node 那一半(CI 用:CI 的 Linux 机器上 Electron 二进制起不起得来没人证过);
 *   `--timing=N` 另在 Electron 下起 N 次、报「spawn 到发现文件活着」的中位数(同一个 store,登录 shell 缓存命中)。
 * 退出码非零 = 红。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { build } from 'esbuild'

import { electronBinaryPath } from './gate-native-abi.mjs'
import {
  acpMcpBridgeEsbuildOptions,
  backendEsbuildOptions,
  searchWorkerEsbuildOptions,
} from '../apps/desktop-react/scripts/build-electron.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cacheDir = join(repoRoot, 'node_modules', '.cache', 'onething-gate-backend-process')
const fakeMcpFile = join(cacheDir, 'fake-mcp-server.mjs')
const FAKE_MCP_ID = 'gate-fake-mcp'
const FAKE_MCP_TOOL = 'gate_echo'
const SEEDED_TASK_ID = 'gate-seeded-task'
const ALIVE_TIMEOUT_MS = 60_000
const EXIT_BUDGET_MS = 5_000

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, value = ''] = arg.replace(/^--/, '').split('=')
  return [key, value]
}))
const runtimes = (args.get('runtimes') || 'electron,node').split(',').filter(Boolean)
const timingRuns = Number.parseInt(args.get('timing') || '0', 10) || 0
// `--build`:用桌面构建配方里**同一组**导出的 esbuild 选项,把后端进程与它旁边那两份(检索 Worker、ACP 桥)
// 打进门自己的缓存目录再跑 —— CI 用它,不必先跑整条桌面构建,也不碰 `dist-electron/`。
const ownBuildDir = join(cacheDir, 'dist-electron')
const backendEntry = args.has('build')
  ? join(ownBuildDir, 'backend.cjs')
  : join(repoRoot, 'apps/desktop-react/dist-electron/backend.cjs')

const results = []
let red = 0
function check(ok, label, detail = '') {
  results.push({ ok, label, detail })
  if (!ok) red++
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` —— ${detail}` : ''}\n`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 一台最小的 stdio MCP 服务器:一个工具,stdout 只走协议帧。用产品自己依赖的那份 SDK。 */
function writeFakeMcpServer() {
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(fakeMcpFile, `
import { Server } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
const server = new Server({ name: 'gate-fake', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler('tools/list', async () => ({ tools: [{ name: ${JSON.stringify(FAKE_MCP_TOOL)}, description: 'gate', inputSchema: { type: 'object', properties: {} } }] }))
server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: 'ok' }] }))
await server.connect(new StdioServerTransport())
`)
}

/** 临时 store:一份假 MCP 配置、一格模型目录(让首启拉取跳过)、一条停用的定时任务。 */
function seedStore(store) {
  writeFileSync(join(store, 'settings.json'), JSON.stringify({
    mcp: {
      enabled: true,
      servers: [{
        id: FAKE_MCP_ID,
        name: 'Gate fake MCP',
        transport: 'stdio',
        enabled: true,
        // 用跑这道门的系统 Node 起它:与后端跑在哪个运行时无关,只证「后端真去 spawn 了」。
        command: process.execPath,
        args: [fakeMcpFile],
      }],
    },
    ai: {
      providers: {
        openai: { enabled: true, models: { 'gate-model': { id: 'gate-model', name: 'gate-model' } } },
      },
    },
  }, null, 2))
  mkdirSync(join(store, 'scheduler'), { recursive: true })
  const now = Date.now()
  writeFileSync(join(store, 'scheduler', 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [{
      id: SEEDED_TASK_ID,
      name: 'gate seeded task',
      prompt: 'never runs',
      agentId: 'default',
      enabled: false,
      schedule: { kind: 'cron', expr: '0 0 1 1 *' },
      createdAt: now,
      updatedAt: now,
    }],
  }, null, 2))
}

function childEnv(store, { launcher, electron }) {
  const env = {}
  // 启动者独占的键一个都不继承:这道门的 store / 端口 / token / 档位只由下面几行说。
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ONETHING_') || key.startsWith('ELECTRON_')) continue
    env[key] = value
  }
  env.ONETHING_STORE_PATH = store
  env.ONETHING_CREDENTIALS_KEYRING = 'file'
  env.ONETHING_SERVER_HOST = '127.0.0.1'
  env.ONETHING_SERVER_TERMINAL = '1'
  if (launcher) env.ONETHING_BACKEND_LAUNCHER = launcher
  if (electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

function startBackend(runtime, store, launcher) {
  const command = runtime === 'electron' ? electronBinaryPath() : process.execPath
  const spawnedAt = performance.now()
  const child = spawn(command, [backendEntry], {
    cwd: repoRoot,
    env: childEnv(store, { launcher, electron: runtime === 'electron' }),
    // 与批 2b 桌面拉起它的形状一样:stdout / stderr 是管道,这里持续读走。
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = { stdout: '', stderr: '' }
  child.stdout.on('data', chunk => { out.stdout += chunk })
  child.stderr.on('data', chunk => { out.stderr += chunk })
  const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal, at: performance.now() })))
  return { child, out, exited, spawnedAt }
}

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(join(store, 'run', 'http.json'), 'utf8'))
  } catch {
    return undefined
  }
}

function portConnects(host, port) {
  return new Promise(r => {
    const socket = connect({ host, port })
    const settle = value => { socket.destroy(); r(value) }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/** 「活着」与桌面 `main.ts` 的 `isAlive` 同一个判据:pid 是这个子进程,且端口连得上。轮询 50ms。 */
async function waitAlive(store, run) {
  let exitedEarly = false
  void run.exited.then(() => { exitedEarly = true })
  const deadline = Date.now() + ALIVE_TIMEOUT_MS
  while (Date.now() < deadline && !exitedEarly) {
    const record = readDiscovery(store)
    if (record?.pid === run.child.pid && await portConnects(record.host, record.port)) {
      return { record, ms: Math.round(performance.now() - run.spawnedAt) }
    }
    await sleep(50)
  }
  return { record: undefined, ms: undefined }
}

function client(record) {
  const base = `http://127.0.0.1:${record.port}`
  const headers = { 'content-type': 'application/json', ...(record.token ? { authorization: `Bearer ${record.token}` } : {}) }
  return {
    async capabilities() {
      const response = await fetch(`${base}/api/capabilities`, { headers })
      return response.json()
    },
    async rpc(domain, method, payload = {}) {
      const response = await fetch(`${base}/api/rpc`, { method: 'POST', headers, body: JSON.stringify({ domain, method, payload }) })
      const body = await response.json()
      if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method}: ${JSON.stringify(body?.error ?? body)}`)
      return body.data
    },
  }
}

async function fakeServerState(api, wantConnected) {
  const deadline = Date.now() + 15_000
  let state
  while (Date.now() < deadline) {
    const data = await api.rpc('mcp', 'getServers')
    state = (data?.servers ?? data ?? []).find?.(server => server?.config?.id === FAKE_MCP_ID)
    if (!wantConnected && state && state.status !== 'connecting') return state
    if (state?.status === 'connected') return state
    await sleep(200)
  }
  return state
}

function logRecords(store, baseName) {
  try {
    return readFileSync(join(store, 'log', `${baseName}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

function processCommand(pid) {
  return new Promise(r => {
    const ps = spawn('ps', ['-o', 'command=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] })
    let text = ''
    ps.stdout.on('data', chunk => { text += chunk })
    ps.once('exit', () => r(text.trim()))
    ps.once('error', () => r(''))
  })
}

/**
 * D6:这个 store 已经有一台活着的后端时,再起一台缺省档(`server:start`)必须让位 —— 不看 owner。
 * 批 2a 之前它只对 `owner !== 'server'` 让位,两台 `server:start` 互不拒绝。
 */
async function checkSecondServerYields(store, owner, label) {
  const second = startBackend('node', store, undefined)
  const outcome = await Promise.race([second.exited, sleep(20_000).then(() => undefined)])
  if (!outcome) second.child.kill('SIGKILL')
  check(outcome?.code === 1 && second.out.stderr.includes(`already served by the ${owner} core`),
    `${label} ⑧ 再起一台缺省档对活着的 ${owner} 让位(D6:不看 owner)`,
    `code=${outcome?.code} stderr=${second.out.stderr.trim().slice(0, 160)}`)
}

async function stopAndCheck(run, store, label) {
  const sentAt = performance.now()
  run.child.kill('SIGTERM')
  const outcome = await Promise.race([run.exited, sleep(EXIT_BUDGET_MS + 2_000).then(() => undefined)])
  if (!outcome) {
    run.child.kill('SIGKILL')
    check(false, `${label} ⑦ SIGTERM 后 ${EXIT_BUDGET_MS / 1000} 秒内退出`, '没退,已 SIGKILL')
    return
  }
  const ms = Math.round(outcome.at - sentAt)
  check(ms <= EXIT_BUDGET_MS && outcome.code === 0,
    `${label} ⑦ SIGTERM 后 ${EXIT_BUDGET_MS / 1000} 秒内退出、退出码 0`, `${ms}ms,code=${outcome.code} signal=${outcome.signal}`)
  check(!existsSync(join(store, 'run', 'http.json')), `${label} ⑦ 退出后发现文件已删`)
}

async function runDesktop(runtime) {
  const label = `[${runtime}]`
  process.stdout.write(`\n${label} 桌面档(ONETHING_BACKEND_LAUNCHER=desktop)\n`)
  const store = mkdtempSync(join(tmpdir(), `onething-gate-backend-process-${runtime}-`))
  let run
  try {
    seedStore(store)
    run = startBackend(runtime, store, 'desktop')
    const { record, ms } = await waitAlive(store, run)
    if (!record) {
      check(false, `${label} 起来了(发现文件活着)`, `stderr 尾巴:${run.out.stderr.slice(-1500)}`)
      return
    }
    process.stdout.write(`  · spawn → 发现文件活着 ${ms}ms(登录 shell 缓存未命中)\n`)
    check(record.owner === 'backend' && record.pid === run.child.pid,
      `${label} ① 发现文件 owner === 'backend' 且 pid 是子进程`, `owner=${record.owner} pid=${record.pid}/${run.child.pid}`)
    const api = client(record)
    const caps = await api.capabilities()
    check(caps?.terminal === true && caps?.localFileSystem === true,
      `${label} ② capabilities.terminal 与 localFileSystem 为真`, `terminal=${caps?.terminal} localFileSystem=${caps?.localFileSystem}`)
    const mcp = await fakeServerState(api, true)
    check(mcp?.status === 'connected' && (mcp?.tools ?? []).some(tool => tool?.name === FAKE_MCP_TOOL),
      `${label} ③ 假的 stdio MCP 服务器已连上、工具列得出`, `status=${mcp?.status} error=${mcp?.error ?? ''} tools=${(mcp?.tools ?? []).map(t => t?.name).join(',')}`)
    const tasks = await api.rpc('scheduler', 'list')
    check((tasks?.tasks ?? []).some(task => task?.id === SEEDED_TASK_ID),
      `${label} ④ 预置的用户定时任务进了调度器`, `tasks=${(tasks?.tasks ?? []).map(t => t?.id).join(',')}`)
    const command = await processCommand(run.child.pid)
    check(command.startsWith('onething-backend'), `${label} ⑥ 进程名是 onething-backend`, `ps: ${command.slice(0, 80)}`)
    await checkSecondServerYields(store, 'backend', label)
    await stopAndCheck(run, store, label)
    // 日志在退出之后读:文件 sink 攒批写,活着的时候读到的可能还缺最后几行。
    const records = logRecords(store, 'app')
    const launch = records.find(r => r.msg === 'launch services started')
    const services = launch?.fields?.services ?? []
    check(['userSchedulerTasks', 'music', 'modelRegistryRefresh'].every(name => services.includes(name)) && !existsSync(join(store, 'log', 'server.jsonl')),
      `${label} ⑤ 日志进 app.jsonl,记着起了定时任务 / 电台 / 首启模型拉取`, `services=${services.join(',')}`)
    check(!/\bINFO\b/.test(run.out.stdout), `${label} ⑤ stdout 上没有日志回显`, `stdout ${run.out.stdout.length} 字节${run.out.stdout ? `:${JSON.stringify(run.out.stdout.slice(0, 160))}` : ''}`)
    check(!records.some(r => r.msg === 'models.dev catalog downloaded'), `${label} 首启模型拉取看到已有目录就跳过(门不出网)`)
  } catch (error) {
    check(false, `${label} 跑完`, error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    if (run && run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL')
    rmSync(store, { recursive: true, force: true })
  }
}

async function runDefaultContrast() {
  const label = '[node 缺省档]'
  process.stdout.write(`\n${label} 对照:不设 ONETHING_BACKEND_LAUNCHER\n`)
  const store = mkdtempSync(join(tmpdir(), 'onething-gate-backend-process-default-'))
  let run
  try {
    seedStore(store)
    run = startBackend('node', store, undefined)
    const { record } = await waitAlive(store, run)
    if (!record) {
      check(false, `${label} 起来了`, run.out.stderr.slice(-1500))
      return
    }
    check(record.owner === 'server', `${label} 发现文件 owner === 'server'(与批 2a 之前相同)`, `owner=${record.owner}`)
    const api = client(record)
    const mcp = await fakeServerState(api, false)
    check(Boolean(mcp) && mcp.status !== 'connected', `${label} 同一份 MCP 配置读得到、但不连(server 缺省的 DisabledServerMCPClient)`, `status=${mcp?.status} error=${mcp?.error ?? ''}`)
    const tasks = await api.rpc('scheduler', 'list')
    check(!(tasks?.tasks ?? []).some(task => task?.id === SEEDED_TASK_ID), `${label} 用户定时任务不进调度器`)
    await checkSecondServerYields(store, 'server', label)
    await stopAndCheck(run, store, label)
    // 退出之后再看:文件 sink 是攒批写的,刚起来那一刻文件可能还没落盘。
    check(existsSync(join(store, 'log', 'server.jsonl')) && !existsSync(join(store, 'log', 'app.jsonl')), `${label} 日志进 server.jsonl`)
  } catch (error) {
    check(false, `${label} 跑完`, error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    if (run && run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL')
    rmSync(store, { recursive: true, force: true })
  }
}

async function runTiming(n) {
  process.stdout.write(`\n[timing] Electron + ELECTRON_RUN_AS_NODE=1,桌面档,同一个 store 起 ${n + 1} 次(第一次热身,不计)\n`)
  const store = mkdtempSync(join(tmpdir(), 'onething-gate-backend-process-timing-'))
  const samples = []
  try {
    seedStore(store)
    for (let i = 0; i <= n; i++) {
      const run = startBackend('electron', store, 'desktop')
      const { record, ms } = await waitAlive(store, run)
      run.child.kill('SIGTERM')
      await Promise.race([run.exited, sleep(EXIT_BUDGET_MS + 2_000)])
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL')
      if (!record) { check(false, `[timing] 第 ${i} 次起来了`); return }
      process.stdout.write(`  · 第 ${i} 次:${ms}ms${i === 0 ? '(热身,登录 shell 缓存未命中)' : ''}\n`)
      if (i > 0) samples.push(ms)
    }
    const sorted = [...samples].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    process.stdout.write(`  · spawn → 发现文件活着:中位数 ${median}ms(${sorted.join(' / ')})\n`)
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
}

async function main() {
  if (args.has('build')) {
    for (const options of [backendEsbuildOptions, searchWorkerEsbuildOptions, acpMcpBridgeEsbuildOptions]) {
      await build({ ...options({ outdir: ownBuildDir, repoRoot }), logLevel: 'warning' })
    }
  }
  if (!existsSync(backendEntry)) {
    console.error(`[gate:backend-process] 没有 ${backendEntry} —— 先跑 \`bun run electron:build\`(或 \`node apps/desktop-react/scripts/build-electron.mjs\`)`)
    process.exit(1)
  }
  if (runtimes.includes('electron') && !electronBinaryPath()) {
    console.error('[gate:backend-process] 找不到 Electron 二进制(node_modules/electron 没装好);只跑系统 Node 那一半用 --runtimes=node')
    process.exit(1)
  }
  writeFakeMcpServer()
  try {
    for (const runtime of runtimes) await runDesktop(runtime)
    await runDefaultContrast()
    if (timingRuns > 0) await runTiming(timingRuns)
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
  process.stdout.write(`\n[gate:backend-process] ${results.length - red}/${results.length} 项通过\n`)
  if (red > 0) process.exitCode = 1
}

await main()
