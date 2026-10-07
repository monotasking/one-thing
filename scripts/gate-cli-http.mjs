#!/usr/bin/env node
/**
 * `bun run gate:cli-http` —— 第④步批 3「CLI 走 HTTP」的门(`docs/design/two-process-2026-10.md` §2.4 验收)。
 *
 * 真 CLI 产物(`dist/cli/main.cjs`)对真后端产物(`dist/server/main.js`)逐条跑,不开窗、只用 node:
 *
 *  ① **依附一台活后端**:临时 store A 上先起一台 `server:start` 那一档的后端(假服务商),CLI 不带 `--spawn`:
 *     `session new` 打出会话 JSON;`ask --json` 每行 `{streamId, event}`、正文拼回假服务商那句、最后一条 `done`;
 *     `ask`(人读)把那句印到 stdout;`session list` / `resource list` 的表头与行;`resource read … --json`;
 *     `onething mcp` 的 stdio 握手 + `tools/list` + 一次 `tools/call`(改名),改名真的落了,审计账上的主体是
 *     `system:mcp:<客户端名>`(请求头降级那一条在真线上走通)。
 *  ② **没有后端**:空 store B 上缺省档报「后端没在运行」且退出码非零;`--spawn` 拉得起(发现文件 owner `backend`、
 *     `launcher: 'cli'`、pid 是新进程);`backend status` 读得到拉起者与时长;不带 `--spawn` 的下一条命令照连它;
 *     `backend stop` 停得掉、发现文件删掉、进程没了;`backend start` 再拉一台;旧名 `daemon stop` 打一行改名提示后照停。
 *  ③ **别人的后端不停**:store C 上起一台 `server:start` 档、store D 上起一台桌面档(`ONETHING_BACKEND_LAUNCHER=desktop`,
 *     就是桌面拉起的那一份,只是不开窗),对它们跑 `backend stop` → 退出码 1、说清该去哪儿停、进程还活着。
 *
 * 硬约束:每个子进程都显式带 `ONETHING_STORE_PATH`(临时目录)、`--store` 与 `ONETHING_CREDENTIALS_KEYRING=file`;
 * 门一开头断言临时目录不是 `~/.onething`;收尾杀掉这道门自己起的每一个后端(按自己临时 store 里的发现文件找 pid)。
 *
 * 跑法:`node scripts/gate-cli-http.mjs [--build]`(`--build` 先跑一次 `build:cli`,它连 `dist/server` 一起出)。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { startFakeProvider, fakeProviderAiSettings, FAKE_PROVIDER_ENV } from './lib/gate-fake-provider.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(repoRoot, 'dist/cli/main.cjs')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const REPLY_TEXT = 'gate-cli-http:这是假服务商经 HTTP 交给 CLI 的回答。'
const MCP_CLIENT_NAME = 'gate-cli-http'
const realStore = path.join(os.homedir(), '.onething')

if (process.argv.includes('--build')) {
  const built = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/build-cli.mjs')], { cwd: repoRoot, stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
}
for (const file of [cliEntry, serverEntry]) {
  if (!existsSync(file)) {
    console.error(`[gate:cli-http] 缺产物 ${path.relative(repoRoot, file)} —— 先跑 bun run build:cli(或带 --build)`)
    process.exit(2)
  }
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'onething-gate-cli-http-'))
const store = name => path.join(tmpRoot, name)
// 硬约束:绝不碰真 store。
for (const name of ['A', 'B', 'C', 'D']) {
  if (path.resolve(store(name)) === path.resolve(realStore) || path.resolve(store(name)).startsWith(path.resolve(realStore) + path.sep)) {
    console.error('[gate:cli-http] 临时 store 落在 ~/.onething 里,拒绝运行')
    process.exit(2)
  }
}

let failures = 0
function check(ok, label, detail = '') {
  if (ok) console.log(`  ✓ ${label}`)
  else { failures += 1; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`) }
}

const baseEnv = storePath => {
  const env = { ...process.env, ...FAKE_PROVIDER_ENV, ONETHING_STORE_PATH: storePath, ONETHING_CREDENTIALS_KEYRING: 'file' }
  delete env.ONETHING_CLI_BACKEND
  delete env.ONETHING_BACKEND_LAUNCHER
  delete env.ONETHING_SERVER_PORT
  delete env.ONETHING_SERVER_TOKEN
  return env
}

/**
 * 跑一次真 CLI。永远带 `--store`。**异步**:假服务商住在这道门自己的进程里,用 `spawnSync` 会把事件循环卡住,
 * 假服务商就答不了 CLI 那台后端的请求。
 */
function cli(storePath, args, extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliEntry, ...args, '--store', storePath], {
      cwd: repoRoot, env: { ...baseEnv(storePath), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

const discoveryOf = storePath => {
  try { return JSON.parse(readFileSync(path.join(storePath, 'run', 'http.json'), 'utf8')) } catch { return undefined }
}
const pidAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(100)
  }
  throw new Error(`超时等待:${label}`)
}

/** 门自己起的后端(不经 CLI):`server:start` 档或桌面档。 */
const started = []
async function startBackend(storePath, launcher) {
  const env = baseEnv(storePath)
  if (launcher) env.ONETHING_BACKEND_LAUNCHER = launcher
  const child = spawn(process.execPath, [serverEntry], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = []
  child.stdout.on('data', chunk => out.push(String(chunk)))
  child.stderr.on('data', chunk => out.push(String(chunk)))
  started.push(child)
  await waitFor(`后端起来(${path.basename(storePath)})`, () => discoveryOf(storePath)?.pid === child.pid).catch(error => {
    throw new Error(`${error.message}\n${out.join('').slice(-1500)}`)
  })
  return child
}

function seedFakeProvider(storePath, mockPort) {
  rmSync(storePath, { recursive: true, force: true })
  spawnSync('mkdir', ['-p', storePath])
  writeFileSync(path.join(storePath, 'settings.json'), JSON.stringify({
    ai: fakeProviderAiSettings(mockPort),
    tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
    diagnostics: { enabled: false },
  }, null, 2))
}

// ── ① 依附一台活后端 ────────────────────────────────────────────────────
async function stepAttach() {
  console.log('\n① 依附一台活后端(store A,server:start 档 + 假服务商)')
  const mock = await startFakeProvider(0, REPLY_TEXT)
  try {
    const A = store('A')
    seedFakeProvider(A, mock.address().port)
    const server = await startBackend(A)

    const made = await cli(A, ['session', 'new', 'gate cli http'])
    const session = (() => { try { return JSON.parse(made.stdout) } catch { return undefined } })()
    check(made.code === 0 && typeof session?.id === 'string' && session.name === 'gate cli http' && Array.isArray(session.messages),
      'session new 打出会话 JSON(id / name / messages)', made.stderr || made.stdout)
    const id = session?.id

    const asked = await cli(A, ['ask', '--json', '--session', id, '你好'])
    const lines = asked.stdout.trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return { bad: line } } })
    const text = lines.filter(line => line.event?.type === 'text_delta').map(line => line.event.text).join('')
    check(asked.code === 0 && lines.length > 0 && lines.every(line => typeof line.streamId === 'string' && line.event?.type),
      'ask --json 每行是 {streamId, event}', asked.stderr.slice(-400))
    check(text === REPLY_TEXT, 'ask --json 的 text_delta 拼回假服务商那一句', JSON.stringify(text))
    check(lines.at(-1)?.event?.type === 'done' && lines.at(-1)?.event?.stopReason === 'end_turn', '最后一条是 done / end_turn', JSON.stringify(lines.at(-1)))

    const human = await cli(A, ['ask', '--session', id, '再说一遍'])
    check(human.code === 0 && human.stdout.includes(REPLY_TEXT), 'ask(人读)把回答印到 stdout', human.stderr.slice(-400))

    const listed = await cli(A, ['session', 'list'])
    check(listed.code === 0 && /^id\s+name\s+updatedAt\s+messageCount/.test(listed.stdout) && listed.stdout.includes(id),
      'session list 的表头与这条会话', listed.stdout.slice(0, 300))

    const resources = await cli(A, ['resource', 'list'])
    check(resources.code === 0 && /(^|\n)session\s+Sessions/.test(resources.stdout),
      'resource list 一行一个命名空间,有 session', resources.stdout.slice(0, 300))
    const read = await cli(A, ['resource', 'read', `session:${id}`, 'get', '--json'])
    const readView = (() => { try { return JSON.parse(read.stdout) } catch { return undefined } })()
    check(read.code === 0 && readView?.kind === 'ok', 'resource read … --json 回 {kind: ok}', read.stdout.slice(0, 300) || read.stderr)

    // onething mcp:真 SDK 客户端经 stdio 连真 CLI。
    const transport = new StdioClientTransport({ command: process.execPath, args: [cliEntry, 'mcp', '--store', A], env: baseEnv(A), stderr: 'pipe' })
    const client = new Client({ name: MCP_CLIENT_NAME, version: '1.0.0' })
    try {
      await client.connect(transport)
      const tools = (await client.listTools()).tools.map(tool => tool.name)
      check(tools.includes('resources') && tools.includes('session'), 'mcp:握手 + tools/list 有元工具与 session', tools.join(','))
      const renamed = await client.callTool({ name: 'session', arguments: { op: 'rename', ref: `session:${id}`, title: 'renamed over mcp' } })
      check(renamed.isError !== true, 'mcp:tools/call 改名成功', JSON.stringify(renamed.content).slice(0, 300))
    } finally {
      await client.close().catch(() => {})
    }
    const shownRun = await cli(A, ['session', 'show', id])
    const shown = (() => { try { return JSON.parse(shownRun.stdout) } catch { return undefined } })()
    check(shown?.name === 'renamed over mcp', 'mcp 改的名真的落了', shown?.name)
    const audit = (() => { try { return readFileSync(path.join(A, 'audit', 'resource.jsonl'), 'utf8') } catch { return '' } })()
    const renameRows = audit.split('\n').filter(line => line.includes('rename'))
    check(renameRows.some(line => line.includes(`mcp:${MCP_CLIENT_NAME}`)),
      `审计账上那次改名的主体是 system:mcp:${MCP_CLIENT_NAME}(请求头降级在真线上走通)`, renameRows.at(-1)?.slice(0, 300) ?? '(审计账没有改名那一行)')

    server.kill('SIGTERM')
    await waitFor('A 的后端退出', () => server.exitCode !== null || server.signalCode !== null, 10_000)
  } finally {
    mock.close()
  }
}

// ── ② 没有后端 ──────────────────────────────────────────────────────────
async function stepSpawn() {
  console.log('\n② 没有后端(store B,空的)')
  const B = store('B')
  spawnSync('mkdir', ['-p', B])

  const refused = await cli(B, ['session', 'list'])
  check(refused.code !== 0 && refused.stderr.includes('The backend is not running'), '缺省档报「后端没在运行」且退出码非零', `code=${refused.code} ${refused.stderr.trim()}`)
  check(!discoveryOf(B), '缺省档没有偷偷拉起一台')

  const spawned = await cli(B, ['session', 'list', '--spawn'])
  const record = discoveryOf(B)
  check(spawned.code === 0 && spawned.stdout.includes('(none)'), '--spawn 拉起一台并答上这条命令', spawned.stderr.slice(-400))
  check(record?.owner === 'backend' && record?.launcher === 'cli' && pidAlive(record?.pid), '发现文件 owner backend、launcher cli、进程活着', JSON.stringify(record))

  const status = await cli(B, ['backend', 'status'])
  const parsed = (() => { try { return JSON.parse(status.stdout) } catch { return undefined } })()
  check(status.code === 0 && parsed?.pid === record?.pid && parsed?.port === record?.port && parsed?.launchedBy === 'cli' && typeof parsed?.uptime === 'string',
    'backend status 打 pid / 端口 / 拉起者 / 已运行时长', status.stdout.slice(0, 300))

  const attached = await cli(B, ['session', 'new', 'attached'])
  check(attached.code === 0 && discoveryOf(B)?.pid === record?.pid, '不带 --spawn 的下一条命令照连这一台(不拉第二台)', attached.stderr)

  const stopped = await cli(B, ['backend', 'stop'])
  check(stopped.code === 0 && stopped.stdout.includes('backend stopped'), 'backend stop 停得掉', stopped.stderr || stopped.stdout)
  await delay(300)
  check(!discoveryOf(B) && !pidAlive(record?.pid), 'stop 之后发现文件删了、进程没了')

  const startedAgain = await cli(B, ['backend', 'start'])
  const second = discoveryOf(B)
  check(startedAgain.code === 0 && second?.launcher === 'cli' && second?.pid !== record?.pid, 'backend start 再拉一台', startedAgain.stderr.slice(-400))
  const alias = await cli(B, ['daemon', 'stop'])
  check(alias.code === 0 && alias.stderr.includes('renamed to `onething backend`') && alias.stdout.includes('backend stopped'),
    '旧名 daemon stop 打一行改名提示后照停', alias.stderr + alias.stdout)
  await delay(300)
  check(!discoveryOf(B), '旧名停完发现文件也删了')
}

// ── ③ 别人的后端不停 ────────────────────────────────────────────────────
async function stepRefuse() {
  console.log('\n③ 别人的后端不停(store C:server:start 档;store D:桌面档)')
  for (const [name, launcher, phrase] of [['C', undefined, 'server:start'], ['D', 'desktop', 'started by the desktop app']]) {
    const S = store(name)
    spawnSync('mkdir', ['-p', S])
    const child = await startBackend(S, launcher)
    const refused = await cli(S, ['backend', 'stop'])
    check(refused.code === 1 && refused.stderr.includes(phrase), `${name}:backend stop 被拒,说清该去哪儿停`, `code=${refused.code} ${refused.stderr.trim()}`)
    check(pidAlive(child.pid) && discoveryOf(S)?.pid === child.pid, `${name}:那台后端还活着`)
    child.kill('SIGTERM')
    await waitFor(`${name} 的后端退出`, () => child.exitCode !== null || child.signalCode !== null, 10_000).catch(() => child.kill('SIGKILL'))
  }
}

async function main() {
  console.log(`[gate:cli-http] 临时目录 ${tmpRoot}`)
  try {
    await stepAttach()
    await stepSpawn()
    await stepRefuse()
  } catch (error) {
    check(false, '门跑完', error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    // 收尾:只杀这道门自己起的后端(子进程句柄,以及自己临时 store 里发现文件上的 pid)。
    for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const name of ['A', 'B', 'C', 'D']) {
      const record = discoveryOf(store(name))
      if (record?.pid && pidAlive(record.pid)) { try { process.kill(record.pid, 'SIGKILL') } catch { /* 已经走了 */ } }
    }
    await delay(300)
    rmSync(tmpRoot, { recursive: true, force: true })
  }
  console.log(failures === 0 ? '\n[gate:cli-http] ok' : `\n[gate:cli-http] FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
