#!/usr/bin/env node
/**
 * `bun run gate:plugin` —— 第④步批 4「插件挂后端」的门(`docs/design/two-process-2026-10.md` §2.5 验收)。
 *
 * 真后端产物(`dist/server/main.js`,系统 node 跑;桌面档与 CLI 档拉起的就是这同一份代码)逐条跑,不开窗:
 *
 *  ① **桌面档**(`ONETHING_BACKEND_LAUNCHER=desktop`):`SHELL` 指一只假登录 shell,它报回的 PATH 比后端进程自己的
 *     多一个临时目录,探针程序 `onething-gate-probe` 只住在那里 ——
 *     `GET /api/capabilities` 的 `pluginsManage` 为真;
 *     预置在账本里、`plugin-settings.json` **没有记录**的那个插件(仓里的 `sample-plugins/plan-status`)不跑,
 *     记了 `false` 的那个不跑;
 *     经 `plugins.install` 装门的夹具插件(`scripts/gate-plugin/fixture`)→ 当场记了 `enabled: true`、装完就在跑;
 *     `plugins.executeCommand` 跑它的命令 → 命令经宿主的 `exec` 跑通探针(PATH 含登录 shell 那一截);
 *     `file-pick`:一扇假壳(带 `X-Onething-Shell-Id` 的 HTTP 客户端)替用户选好文件,经 `plugins.pickFile` 的 `file`
 *     一格交回(字节形与路径形各一次)→ 答 `storage:` 地址、文件真落进插件数据目录;
 *     SIGTERM 之后 5 秒内退出。
 *  ② **CLI 档**:同一个夹具在系统 node 跑的 `dist/server/main.js` 里经 `execa` 跑通(D12 (b) 那份产物里 execa 能用)。
 *  ③ **缺省档**(`server:start`):`pluginsManage` 为假、装插件答原来那句「只在桌面宿主」—— 逐字不变。
 *
 * 硬约束:只用 node;每个后端都带临时 `ONETHING_STORE_PATH` 与 `ONETHING_CREDENTIALS_KEYRING=file`;npm 走
 * `npm_config_offline=true`(本地目录装,不连 registry);一开头断言临时目录不在 `~/.onething` 里;收尾只杀这道门自己起的进程。
 *
 * 跑法:`node scripts/gate-plugin.mjs [--build]`(`--build` 先跑一次 `server:build`)。
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const fixtureDir = path.join(repoRoot, 'scripts/gate-plugin/fixture')
const planStatusDir = path.join(repoRoot, 'sample-plugins/plan-status')
const realStore = path.join(os.homedir(), '.onething')
const FIXTURE_PKG = 'onething-plugin-gate-exec'
const PLAN_PKG = 'onething-plugin-plan-status'
const OFF_PKG = 'onething-plugin-gate-off'
const SHELL_ID = 'gate-plugin-fake-shell'
// 1×1 透明 PNG。
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

if (process.argv.includes('--build')) {
  const built = spawnSync('bun', ['run', 'server:build'], { cwd: repoRoot, stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
}
if (!existsSync(serverEntry)) {
  console.error('[gate:plugin] 缺产物 dist/server/main.js —— 先跑 bun run server:build(或带 --build)')
  process.exit(2)
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'onething-gate-plugin-'))
if (path.resolve(tmpRoot).startsWith(path.resolve(realStore))) {
  console.error('[gate:plugin] 临时目录落在 ~/.onething 里,拒绝运行')
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
    await delay(150)
  }
  throw new Error(`超时等待:${label}`)
}
const discoveryOf = storePath => {
  try { return JSON.parse(readFileSync(path.join(storePath, 'run', 'http.json'), 'utf8')) } catch { return undefined }
}

/** 探针程序与假登录 shell。探针只住在 `probeBin` 里;假 shell 报回的 PATH 比后端自己的多这一截。 */
function makeProbeAndShell() {
  const probeBin = path.join(tmpRoot, 'login-shell-bin')
  mkdirSync(probeBin, { recursive: true })
  const probe = path.join(probeBin, 'onething-gate-probe')
  writeFileSync(probe, '#!/bin/sh\necho "probe-ran:$1"\n')
  chmodSync(probe, 0o755)
  const fakeShell = path.join(tmpRoot, 'fake-login-shell')
  // 后端以 `<shell> -l -i -c <命令>` 读登录 shell 的环境;这只假 shell 把探针目录接在 PATH 前面再照跑那条命令。
  writeFileSync(fakeShell, `#!/bin/sh\nfor last; do :; done\nPATH="${probeBin}:$PATH"\nexport PATH\nexec /bin/sh -c "$last"\n`)
  chmodSync(fakeShell, 0o755)
  return { probeBin, fakeShell }
}

function baseEnv(storePath) {
  const env = {
    ...process.env,
    ONETHING_STORE_PATH: storePath,
    ONETHING_CREDENTIALS_KEYRING: 'file',
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    NO_PROXY: '127.0.0.1,localhost',
  }
  for (const key of ['ONETHING_BACKEND_LAUNCHER', 'ONETHING_SERVER_PORT', 'ONETHING_SERVER_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY']) delete env[key]
  return env
}

const started = []
async function startBackend(storePath, launcher, extraEnv = {}) {
  const env = { ...baseEnv(storePath), ...extraEnv }
  if (launcher) env.ONETHING_BACKEND_LAUNCHER = launcher
  const child = spawn(process.execPath, [serverEntry], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = []
  child.stdout.on('data', chunk => out.push(String(chunk)))
  child.stderr.on('data', chunk => out.push(String(chunk)))
  started.push(child)
  await waitFor(`后端起来(${path.basename(storePath)})`, () => discoveryOf(storePath)?.pid === child.pid).catch(error => {
    throw new Error(`${error.message}\n${out.join('').slice(-1500)}`)
  })
  const discovery = discoveryOf(storePath)
  const base = `http://${discovery.host}:${discovery.port}`
  const headers = { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json', 'x-onething-shell-id': SHELL_ID }
  const rpc = async (domain, method, payload = {}) => {
    const response = await fetch(`${base}/api/rpc`, { method: 'POST', headers, body: JSON.stringify({ domain, method, payload }) })
    const body = await response.json()
    if (!body.ok) throw new Error(`${domain}.${method}: ${body.error?.message}`)
    return body.data
  }
  const capabilities = async () => (await fetch(`${base}/api/capabilities`, { headers })).json()
  return { child, rpc, capabilities, output: () => out.join('') }
}

async function stopBackend(child, label) {
  const t0 = Date.now()
  child.kill('SIGTERM')
  await waitFor(`${label} 退出`, () => child.exitCode !== null || child.signalCode !== null, 10_000).catch(() => {})
  return { exited: child.exitCode !== null || child.signalCode !== null, ms: Date.now() - t0, code: child.exitCode }
}

/** 账本里预置两个插件(不经 npm):仓里的 plan-status(不记开关)与夹具的一份副本(记成 false)。 */
function seedLedger(storePath) {
  const pluginsDir = path.join(storePath, 'plugins')
  const modules = path.join(pluginsDir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  cpSync(planStatusDir, path.join(modules, PLAN_PKG), { recursive: true, filter: source => !source.includes(`${path.sep}node_modules`) })
  cpSync(fixtureDir, path.join(modules, OFF_PKG), { recursive: true })
  const offPackage = JSON.parse(readFileSync(path.join(modules, OFF_PKG, 'package.json'), 'utf8'))
  writeFileSync(path.join(modules, OFF_PKG, 'package.json'), JSON.stringify({ ...offPackage, name: OFF_PKG }))
  writeFileSync(path.join(pluginsDir, 'package.json'), JSON.stringify({
    name: 'onething-installed-plugins', private: true,
    dependencies: { [PLAN_PKG]: `file:${planStatusDir}`, [OFF_PKG]: 'file:gate-off' },
  }, null, 2))
  writeFileSync(path.join(storePath, 'plugin-settings.json'), JSON.stringify({ enabled: { [OFF_PKG]: false } }))
}

const pluginRow = (list, id) => (list?.plugins ?? list ?? []).find?.(row => (row.id ?? row.definition?.id) === id)

// ── ① 桌面档 ─────────────────────────────────────────────────────────────
async function stepDesktop() {
  console.log('\n① 桌面档:插件管理器在后端里起、按开关跑、exec 走登录 shell 的 PATH、file-pick 交回文件')
  const store = path.join(tmpRoot, 'desktop')
  mkdirSync(store, { recursive: true })
  seedLedger(store)
  const { probeBin, fakeShell } = makeProbeAndShell()
  const pathWithoutProbe = (process.env.PATH ?? '').split(path.delimiter).filter(entry => entry && entry !== probeBin).join(path.delimiter)
  const backend = await startBackend(store, 'desktop', { SHELL: fakeShell, PATH: pathWithoutProbe })
  try {
    await waitFor('插件管理器起来', async () => (await backend.capabilities())?.pluginsManage === true).catch(() => {})
    const caps = await backend.capabilities()
    check(caps?.pluginsManage === true, 'GET /api/capabilities 的 pluginsManage 为真', JSON.stringify(caps))

    const listed = await waitFor('插件表里出现预置的两个', async () => {
      const list = await backend.rpc('plugins', 'list')
      return pluginRow(list, PLAN_PKG) && pluginRow(list, OFF_PKG) ? list : undefined
    })
    const plan = pluginRow(listed, PLAN_PKG)
    const off = pluginRow(listed, OFF_PKG)
    check(plan?.enabled === false && plan?.loaded !== true, '没有开关记录的已装插件(sample-plugins/plan-status)按关闭处理、不跑', JSON.stringify(plan))
    check(off?.enabled === false && off?.loaded !== true, '开关记成 false 的插件不跑', JSON.stringify(off))

    const installed = await backend.rpc('plugins', 'install', { pkg: FIXTURE_PKG, path: fixtureDir })
    check(installed?.success === true, 'plugins.install 从本地目录装上夹具插件', JSON.stringify(installed))
    const settings = JSON.parse(readFileSync(path.join(store, 'plugin-settings.json'), 'utf8'))
    check(settings.enabled?.[FIXTURE_PKG] === true && settings.enabled?.[OFF_PKG] === false,
      '装的那一次当场记了 enabled: true,别人的开关不动', JSON.stringify(settings))
    const after = await backend.rpc('plugins', 'list')
    check(pluginRow(after, FIXTURE_PKG)?.loaded === true, '夹具插件装完就在跑', JSON.stringify(pluginRow(after, FIXTURE_PKG)))

    const commands = await backend.rpc('plugins', 'commands')
    const names = JSON.stringify(commands)
    check(names.includes(`/${FIXTURE_PKG}`) && !names.includes(`/${OFF_PKG}`), '命令表里有在跑的那个、没有关着的那个', names.slice(0, 300))

    const ran = await backend.rpc('plugins', 'executeCommand', { commandName: `/${FIXTURE_PKG}`, args: '', sessionId: '' })
    check(ran?.success === true && String(ran?.message).includes('exit=0') && String(ran?.message).includes('probe-ran:from-plugin'),
      '插件命令经宿主的 exec 跑通探针(探针只在登录 shell 的 PATH 里)', JSON.stringify(ran))

    const picked = await backend.rpc('plugins', 'pickFile', {
      pluginId: FIXTURE_PKG, accept: ['png'], file: { name: 'wallpaper.png', base64: PNG_BASE64 },
    })
    const importedFile = picked?.name ? path.join(store, 'plugins', FIXTURE_PKG, 'storage', 'imports', picked.name) : ''
    check(typeof picked?.path === 'string' && picked.path.startsWith('storage:') && existsSync(importedFile),
      'file-pick(字节形):假壳交回的文件落进插件数据目录,答 storage: 地址', JSON.stringify(picked))
    const localPng = path.join(tmpRoot, 'local-pick.png')
    writeFileSync(localPng, Buffer.from(PNG_BASE64, 'base64'))
    const pickedPath = await backend.rpc('plugins', 'pickFile', { pluginId: FIXTURE_PKG, accept: ['png'], file: { path: localPng } })
    check(typeof pickedPath?.path === 'string' && pickedPath.path.startsWith('storage:') && pickedPath.name !== picked?.name,
      'file-pick(路径形,本机可信的来访者):照样过闸、拷进来、不覆盖上一张', JSON.stringify(pickedPath))
    const rejected = await backend.rpc('plugins', 'pickFile', { pluginId: FIXTURE_PKG, accept: ['png'], file: { name: 'notes.txt', base64: 'aGk=' } })
    check(typeof rejected?.error === 'string' && !rejected.path, 'file-pick:扩展名不在 accept 里的照旧被闸挡下', JSON.stringify(rejected))
  } finally {
    const stopped = await stopBackend(backend.child, '桌面档后端')
    check(stopped.exited && stopped.ms < 5000, `SIGTERM 之后 5 秒内退出(${stopped.ms}ms,code ${stopped.code})`, backend.output().slice(-800))
  }
}

// ── ② CLI 档 ─────────────────────────────────────────────────────────────
async function stepCli() {
  console.log('\n② CLI 档:同一个夹具在系统 node 跑的 dist/server/main.js 里经 execa 跑通')
  const store = path.join(tmpRoot, 'cli')
  mkdirSync(store, { recursive: true })
  const probeBin = path.join(tmpRoot, 'login-shell-bin')
  const backend = await startBackend(store, 'cli', { PATH: `${probeBin}${path.delimiter}${process.env.PATH ?? ''}` })
  try {
    await waitFor('插件管理器起来', async () => (await backend.capabilities())?.pluginsManage === true).catch(() => {})
    check((await backend.capabilities())?.pluginsManage === true, 'pluginsManage 为真')
    const installed = await backend.rpc('plugins', 'install', { pkg: FIXTURE_PKG, path: fixtureDir })
    check(installed?.success === true, 'plugins.install 装上夹具', JSON.stringify(installed))
    const ran = await backend.rpc('plugins', 'executeCommand', { commandName: `/${FIXTURE_PKG}`, args: '', sessionId: '' })
    check(ran?.success === true && String(ran?.message).includes('probe-ran:from-plugin'), 'execa 在这份产物里能用:命令跑通', JSON.stringify(ran))
  } finally {
    const stopped = await stopBackend(backend.child, 'CLI 档后端')
    check(stopped.exited && stopped.ms < 5000, `SIGTERM 之后 5 秒内退出(${stopped.ms}ms)`)
  }
}

// ── ③ 缺省档 ─────────────────────────────────────────────────────────────
async function stepDefault() {
  console.log('\n③ 缺省档(server:start):不起插件,答案逐字不变')
  const store = path.join(tmpRoot, 'default')
  mkdirSync(store, { recursive: true })
  const backend = await startBackend(store, undefined)
  try {
    check((await backend.capabilities())?.pluginsManage === false, 'pluginsManage 为假')
    const installed = await backend.rpc('plugins', 'install', { pkg: FIXTURE_PKG, path: fixtureDir })
    check(installed?.success === false && installed?.error === 'Plugins are installed on the desktop host only.',
      '装插件答原来那句「Plugins are installed on the desktop host only.」', JSON.stringify(installed))
  } finally {
    await stopBackend(backend.child, '缺省档后端')
  }
}

try {
  await stepDesktop()
  await stepCli()
  await stepDefault()
} catch (error) {
  failures += 1
  console.log(`  ✗ 门中途出错:${error instanceof Error ? error.message : String(error)}`)
} finally {
  for (const child of started) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  rmSync(tmpRoot, { recursive: true, force: true })
}
console.log(failures === 0 ? '\n[gate:plugin] 全绿' : `\n[gate:plugin] ${failures} 项红`)
process.exit(failures === 0 ? 0 : 1)
