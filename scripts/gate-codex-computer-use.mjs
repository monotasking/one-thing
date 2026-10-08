#!/usr/bin/env node
/**
 * `gate:codex-computer-use` —— onething 用得上 Codex 装在本机的那台闭源 Computer Use MCP
 * (`docs/design/computer-use-2026-10.md` §2 实测、§5 P2 验收)。
 *
 * 跑的是真后端产物 `dist/server/main.js`(系统 node,CLI 档:MCP 真连)对着**真**的那台服务器:
 * 临时 store 里一条服务器配置 = §3.1 的配方 —— ChatGPT.app 自带的签名 `codex` 当跳板
 * (`codex sandbox -c sandbox_mode="danger-full-access" -- <SkyComputerUseClient> mcp`)。逐项断言:
 *   ① 服务器连上,十只工具列得出(`list_apps` / `get_app_state` / `click` / `type_text` …);
 *   ② `list_apps` 真答(没有「Sender process is not authenticated」—— 证的就是跳板);
 *   ③ 经 RPC 直接调 `get_app_state`:这条路没有会话坐标,所以服务器的 elicitation 被 onething
 *      **结构化拒绝**(日志 `mcp elicitation declined` / `no-in-flight-call`),工具结果是「approval denied」——
 *      证的是 elicitation 处理函数真接在这台服务器上,而且**没有一张卡、没有一个 app 被碰**;
 *   ④ SIGTERM 后 5 秒内退出(跳板 + 客户端那棵子进程树一起收掉)。
 *
 * 纪律:
 *  - ChatGPT.app 的 codex 或 Computer Use 客户端不在 → **skipped(退出 0)**,不是红;非 macOS 同理;
 *  - 临时 store(`mkdtemp`),`ONETHING_CREDENTIALS_KEYRING=file`,不碰 `~/.onething`;
 *  - **绝不碰用户的「始终允许」名单**:这道门里没有一次同意,③ 正是拒绝那一支;
 *  - `CODEX_HOME` 照用户环境(缺省 `~/.codex`),只读它的路径,不写。
 *
 * 跑法:`bun run gate:codex-computer-use [--build]`(`--build` 先跑一次 `server:build`)。退出码非零 = 红。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const realStore = path.join(os.homedir(), '.onething')
const SERVER_ID = 'codex-computer-use'
const EXPECTED_TOOLS = ['list_apps', 'get_app_state', 'click', 'perform_secondary_action', 'set_value', 'select_text', 'scroll', 'drag', 'press_key', 'type_text']

/** §3.1 的配方:两条路径 + 一条命令行。改配方只改这里。 */
export function codexComputerUseRecipe(codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex')) {
  const launcher = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
  const client = path.join(codexHome, 'computer-use', 'Codex Computer Use.app', 'Contents', 'SharedSupport', 'SkyComputerUseClient.app', 'Contents', 'MacOS', 'SkyComputerUseClient')
  return {
    launcher,
    client,
    config: {
      id: SERVER_ID,
      name: 'Codex 电脑操控',
      transport: 'stdio',
      enabled: true,
      command: launcher,
      args: ['sandbox', '-c', 'sandbox_mode="danger-full-access"', '--', client, 'mcp'],
      cwd: path.join(codexHome, 'computer-use'),
      env: { CODEX_HOME: codexHome },
    },
  }
}

const recipe = codexComputerUseRecipe()
if (process.platform !== 'darwin' || !existsSync(recipe.launcher) || !existsSync(recipe.client)) {
  console.log(`[gate:codex-computer-use] skipped —— 这台机器没有 ChatGPT.app 的 codex 或 Computer Use 客户端(${recipe.launcher} / ${recipe.client})`)
  process.exit(0)
}

if (process.argv.includes('--build')) {
  const built = spawnSync('bun', ['run', 'server:build'], { cwd: repoRoot, stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
}
if (!existsSync(serverEntry)) {
  console.error('[gate:codex-computer-use] 缺产物 dist/server/main.js —— 先跑 bun run server:build(或带 --build)')
  process.exit(2)
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'onething-gate-codex-cu-'))
if (path.resolve(tmpRoot).startsWith(path.resolve(realStore))) {
  console.error('[gate:codex-computer-use] 临时目录落在 ~/.onething 里,拒绝运行')
  process.exit(2)
}

let failures = 0
function check(ok, label, detail = '') {
  if (ok) console.log(`  ✓ ${label}`)
  else { failures += 1; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`) }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(200)
  }
  throw new Error(`超时等待:${label}`)
}
const discoveryOf = storePath => {
  try { return JSON.parse(readFileSync(path.join(storePath, 'run', 'http.json'), 'utf8')) } catch { return undefined }
}
const logLines = storePath => {
  try {
    return readFileSync(path.join(storePath, 'log', 'app.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return {} } })
  } catch { return [] }
}
const textOf = result => (result?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n')

function baseEnv(storePath) {
  const env = {
    ...process.env,
    ONETHING_STORE_PATH: storePath,
    ONETHING_CREDENTIALS_KEYRING: 'file',
    ONETHING_BACKEND_LAUNCHER: 'cli',
    NO_PROXY: '127.0.0.1,localhost',
  }
  for (const key of ['ONETHING_SERVER_PORT', 'ONETHING_SERVER_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY']) delete env[key]
  return env
}

let backend
async function startBackend(storePath) {
  const child = spawn(process.execPath, [serverEntry], { cwd: repoRoot, env: baseEnv(storePath), stdio: ['ignore', 'pipe', 'pipe'] })
  const out = []
  child.stdout.on('data', chunk => out.push(String(chunk)))
  child.stderr.on('data', chunk => out.push(String(chunk)))
  await waitFor('后端起来', () => discoveryOf(storePath)?.pid === child.pid).catch(error => {
    throw new Error(`${error.message}\n${out.join('').slice(-1500)}`)
  })
  const discovery = discoveryOf(storePath)
  const base = `http://${discovery.host}:${discovery.port}`
  const headers = { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' }
  const rpc = async (domain, method, payload = {}) => {
    const response = await fetch(`${base}/api/rpc`, { method: 'POST', headers, body: JSON.stringify({ domain, method, payload }) })
    const body = await response.json()
    if (!body.ok) throw new Error(`${domain}.${method}: ${body.error?.message}`)
    return body.data
  }
  return { child, rpc, output: () => out.join('') }
}

async function stopBackend(child) {
  const t0 = Date.now()
  child.kill('SIGTERM')
  await waitFor('后端退出', () => child.exitCode !== null || child.signalCode !== null, 10_000).catch(() => {})
  return { exited: child.exitCode !== null || child.signalCode !== null, ms: Date.now() - t0, code: child.exitCode }
}

try {
  const store = path.join(tmpRoot, 'store')
  writeFileSync(path.join(tmpRoot, '.keep'), '')
  spawnSync('mkdir', ['-p', store])
  writeFileSync(path.join(store, 'settings.json'), JSON.stringify({ mcp: { enabled: true, servers: [recipe.config] } }, null, 2))

  console.log('① 连上 Codex 电脑操控那台 MCP(签名 codex 跳板)')
  backend = await startBackend(store)
  const state = await waitFor('服务器 connected', async () => {
    const data = await backend.rpc('mcp', 'getServers')
    const found = (data?.servers ?? []).find(server => server?.config?.id === SERVER_ID)
    return found?.status === 'connected' || found?.status === 'error' ? found : undefined
  }, 90_000)
  check(state.status === 'connected', `服务器连上(status=${state.status})`, state.error ?? '')
  const toolNames = new Set((state.tools ?? []).map(tool => tool.name))
  const missing = EXPECTED_TOOLS.filter(name => !toolNames.has(name))
  check(missing.length === 0, `十只工具列得出(${toolNames.size} 只)`, missing.length ? `缺:${missing.join(', ')}` : '')

  console.log('② list_apps 真答(跳板让服务认了我们)')
  const apps = await backend.rpc('mcp', 'callTool', { serverId: SERVER_ID, toolName: 'list_apps', arguments: {} })
  const appsText = textOf(apps)
  check(apps.success === true && !/not authenticated/i.test(appsText) && appsText.length > 0,
    `list_apps 答了 ${appsText.split('\n').length} 行`, appsText.slice(0, 300) || JSON.stringify(apps).slice(0, 300))

  console.log('③ 没有会话坐标的调用:服务器的 elicitation 被结构化拒绝,不出卡、不碰 app')
  const stateBefore = await backend.rpc('mcp', 'callTool', { serverId: SERVER_ID, toolName: 'get_app_state', arguments: { app: 'Calculator' } })
  const stateText = textOf(stateBefore) + (stateBefore.error ?? '')
  check(/approval denied/i.test(stateText) || stateBefore.success === false,
    'get_app_state 拿不到状态(elicitation 被拒)', stateText.slice(0, 300))
  const declined = await waitFor('日志里的拒绝记录', () =>
    logLines(store).find(line => line.msg === 'mcp elicitation declined' && line.fields?.reason === 'no-in-flight-call'), 10_000).catch(() => undefined)
  check(Boolean(declined), '日志记着 mcp elicitation declined / no-in-flight-call', declined ? '' : logLines(store).filter(line => String(line.ns ?? '').startsWith('mcp')).slice(-5).map(line => JSON.stringify(line)).join('\n'))

  console.log('④ SIGTERM 收尾')
  const stopped = await stopBackend(backend.child)
  backend = undefined
  check(stopped.exited && stopped.ms < 5000, `SIGTERM 之后 5 秒内退出(${stopped.ms}ms,code ${stopped.code})`)
  await delay(500)
  const leftover = spawnSync('pgrep', ['-f', 'SkyComputerUseClient mcp'], { encoding: 'utf8' })
  const ours = (leftover.stdout || '').trim().split('\n').filter(Boolean)
  // 别的宿主(Codex App 自己)也可能开着一只客户端,这里只报数,不当红:门起的那棵树随后端 SIGTERM 一起收。
  if (ours.length) console.log(`  · 机器上还有 ${ours.length} 只 SkyComputerUseClient mcp(可能是 Codex App 自己的)`)
} catch (error) {
  failures += 1
  console.log(`  ✗ 门自己炸了:${error?.stack ?? error}`)
  if (backend) console.log(backend.output().slice(-2000))
} finally {
  if (backend?.child && backend.child.exitCode === null && backend.child.signalCode === null) backend.child.kill('SIGKILL')
  rmSync(tmpRoot, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n[gate:codex-computer-use] 全绿' : `\n[gate:codex-computer-use] 红:${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
