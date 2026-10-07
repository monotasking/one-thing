#!/usr/bin/env node
/**
 * `bun run gate:gateway` —— 第④步批 4「网关挂后端」的门(`docs/design/two-process-2026-10.md` §2.5 验收)。
 *
 * 真后端产物(`dist/server/main.js`,系统 node 跑)+ 假服务商 + **假渠道**:一台只在 127.0.0.1 上的假 iLink
 * 服务器(微信渠道说的那套 HTTP 协议:`getupdates` 长轮询、`sendmessage`、`getconfig` / `sendtyping`)。
 * 临时 store 里预置一份指向它的登录态,真的微信渠道代码就连到它 —— **一条外网请求都不发,不碰任何真渠道**。
 *
 *  ① **设置开着**(`channels.wechat.enabled: true`,桌面档):后端起来就自动连上网关(不用谁点「启动」);
 *     假渠道进一条消息 → 进程内的引擎经假服务商答 → 假渠道收到一条回复,正文是假服务商那一句;
 *     `gateway.getStatus` 答 running;SIGTERM 之后 5 秒内退出,日志里有「gateway stopped」、没有「timed out」。
 *  ② **设置关着**:后端起来之后假渠道一条请求都没收到,`gateway.getStatus` 答没在跑。
 *  ③ **缺省档**(`server:start`)设置开着也不起:假渠道零请求,`gateway.getStatus` 答原来那句「不可用」。
 *
 * 硬约束:只用 node;每个后端都带临时 `ONETHING_STORE_PATH` 与 `ONETHING_CREDENTIALS_KEYRING=file`;`SHELL` 指一只
 * 什么都不改的假登录 shell(不读用户的 rc 文件);代理环境变量清空;收尾只杀这道门自己起的进程。
 *
 * 跑法:`node scripts/gate-gateway.mjs [--build]`(`--build` 先跑一次 `server:build`)。
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeProvider, fakeProviderAiSettings, FAKE_PROVIDER_ENV } from './lib/gate-fake-provider.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const realStore = path.join(os.homedir(), '.onething')
const REPLY_TEXT = 'gate-gateway:这是假服务商经网关交给假渠道的回答。'
const INBOUND_TEXT = '你好,网关'
const PEER = 'gate-peer@im.wechat'

if (process.argv.includes('--build')) {
  const built = spawnSync('bun', ['run', 'server:build'], { cwd: repoRoot, stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
}
if (!existsSync(serverEntry)) {
  console.error('[gate:gateway] 缺产物 dist/server/main.js —— 先跑 bun run server:build(或带 --build)')
  process.exit(2)
}
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'onething-gate-gateway-'))
if (path.resolve(tmpRoot).startsWith(path.resolve(realStore))) {
  console.error('[gate:gateway] 临时目录落在 ~/.onething 里,拒绝运行')
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

/** 假 iLink:第一次 `getupdates` 交一条消息,之后每次空答(稍等一会儿,像长轮询);`sendmessage` 记下来。 */
function startFakeIlink() {
  const requests = []
  const sent = []
  let delivered = false
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      requests.push(req.url)
      const json = obj => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (req.url === '/ilink/bot/getupdates') {
        if (!delivered) {
          delivered = true
          return json({
            ret: 0,
            get_updates_buf: 'gate-buf-1',
            msgs: [{
              message_id: 1, from_user_id: PEER, to_user_id: 'gate-bot', message_type: 1, context_token: 'gate-ctx',
              item_list: [{ type: 1, text_item: { text: INBOUND_TEXT } }],
            }],
          })
        }
        await delay(400)
        return json({ ret: 0, msgs: [], get_updates_buf: 'gate-buf-1' })
      }
      if (req.url === '/ilink/bot/sendmessage') {
        try { sent.push(JSON.parse(body)) } catch { sent.push({ bad: body }) }
        return json({ ret: 0 })
      }
      if (req.url === '/ilink/bot/getconfig') return json({ ret: 0, typing_ticket: 'gate-ticket' })
      if (req.url === '/ilink/bot/sendtyping') return json({ ret: 0 })
      res.writeHead(404).end()
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, sent, port: server.address().port })))
}

function makeQuietShell() {
  const fakeShell = path.join(tmpRoot, 'quiet-login-shell')
  writeFileSync(fakeShell, '#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n')
  chmodSync(fakeShell, 0o755)
  return fakeShell
}

function seedStore(storePath, { providerPort, ilinkPort, wechatEnabled }) {
  mkdirSync(storePath, { recursive: true })
  writeFileSync(path.join(storePath, 'settings.json'), JSON.stringify({
    ai: fakeProviderAiSettings(providerPort),
    tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
    diagnostics: { enabled: false },
    channels: { wechat: { enabled: wechatEnabled } },
  }, null, 2))
  // 登录态:真的微信渠道代码读它,`baseurl` 指假 iLink。
  const tokenDir = path.join(storePath, 'gateway', 'wechat-accounts', 'default')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(path.join(tokenDir, 'token.json'), JSON.stringify({
    bot_token: 'gate-bot-token', baseurl: `http://127.0.0.1:${ilinkPort}`, ilink_user_id: 'gate-bot', ilink_bot_id: 'gate-bot',
  }))
}

const started = []
async function startBackend(storePath, launcher, shell) {
  const env = {
    ...process.env, ...FAKE_PROVIDER_ENV,
    ONETHING_STORE_PATH: storePath, ONETHING_CREDENTIALS_KEYRING: 'file', SHELL: shell, NO_PROXY: '127.0.0.1,localhost',
  }
  for (const key of ['ONETHING_BACKEND_LAUNCHER', 'ONETHING_SERVER_PORT', 'ONETHING_SERVER_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY',
    'ONETHING_GATEWAY', 'GATEWAY_ENABLED', 'GATEWAY_CHANNELS', 'TELEGRAM_BOT_TOKEN', 'GATEWAY_TELEGRAM_BOT_TOKEN', 'GATEWAY_ALLOWLIST']) delete env[key]
  if (launcher) env.ONETHING_BACKEND_LAUNCHER = launcher
  const child = spawn(process.execPath, [serverEntry], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = []
  child.stdout.on('data', chunk => out.push(String(chunk)))
  child.stderr.on('data', chunk => out.push(String(chunk)))
  started.push(child)
  await waitFor('后端起来', () => discoveryOf(storePath)?.pid === child.pid).catch(error => {
    throw new Error(`${error.message}\n${out.join('').slice(-1500)}`)
  })
  const discovery = discoveryOf(storePath)
  const rpc = async (domain, method, payload = {}) => {
    const response = await fetch(`http://${discovery.host}:${discovery.port}/api/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ domain, method, payload }),
    })
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

const sentText = message => (message?.msg?.item_list ?? []).map(item => item?.text_item?.text ?? '').join('')
const readLog = storePath => { try { return readFileSync(path.join(storePath, 'log', 'app.jsonl'), 'utf8') } catch { return '' } }

async function stepEnabled(provider, shell) {
  console.log('\n① 设置开着(桌面档):后端起来自动连、一条消息进一条回复出、SIGTERM 收得干净')
  const ilink = await startFakeIlink()
  const store = path.join(tmpRoot, 'enabled')
  seedStore(store, { providerPort: provider.address().port, ilinkPort: ilink.port, wechatEnabled: true })
  const backend = await startBackend(store, 'desktop', shell)
  try {
    await waitFor('网关自动连上假渠道', () => ilink.requests.includes('/ilink/bot/getupdates'), 20_000).catch(() => {})
    check(ilink.requests.includes('/ilink/bot/getupdates'), '后端起来就自动开始轮询(没人点「启动」)', backend.output().slice(-600))
    const reply = await waitFor('假渠道收到回复', () => ilink.sent.find(message => sentText(message).includes(REPLY_TEXT)), 30_000).catch(() => undefined)
    check(Boolean(reply), '假渠道进一条消息 → 进程内引擎答 → 假渠道收到那一句回复', JSON.stringify(ilink.sent).slice(0, 400) || backend.output().slice(-600))
    check(reply?.msg?.to_user_id === PEER && reply?.msg?.context_token === 'gate-ctx', '回复发回原来那个人、带着原消息的 context_token', JSON.stringify(reply?.msg ?? null).slice(0, 300))
    const status = await backend.rpc('gateway', 'getStatus')
    check(status?.success === true && status.status?.running === true && status.status?.enabled === true, 'gateway.getStatus 答 running / enabled', JSON.stringify(status).slice(0, 300))
  } finally {
    const stopped = await stopBackend(backend.child)
    const log = readLog(store)
    check(stopped.exited && stopped.ms < 5000, `SIGTERM 之后 5 秒内退出(${stopped.ms}ms,code ${stopped.code})`)
    check(log.includes('gateway stopped') && !log.includes('gateway shutdown timed out'), '日志里网关拆除完成、没有超时', log.split('\n').filter(line => line.includes('gateway')).slice(-4).join('\n'))
    ilink.server.close()
  }
}

async function stepDisabled(provider, shell) {
  console.log('\n② 设置关着:不起')
  const ilink = await startFakeIlink()
  const store = path.join(tmpRoot, 'disabled')
  seedStore(store, { providerPort: provider.address().port, ilinkPort: ilink.port, wechatEnabled: false })
  const backend = await startBackend(store, 'desktop', shell)
  try {
    await delay(2500)
    check(ilink.requests.length === 0, '假渠道一条请求都没收到', ilink.requests.join(','))
    const status = await backend.rpc('gateway', 'getStatus')
    check(status?.success === true && status.status?.running === false && status.status?.enabled === false, 'gateway.getStatus 答没在跑、没开', JSON.stringify(status).slice(0, 300))
  } finally {
    await stopBackend(backend.child)
    ilink.server.close()
  }
}

async function stepDefaultLauncher(provider, shell) {
  console.log('\n③ 缺省档(server:start):设置开着也不起,答案逐字不变')
  const ilink = await startFakeIlink()
  const store = path.join(tmpRoot, 'default')
  seedStore(store, { providerPort: provider.address().port, ilinkPort: ilink.port, wechatEnabled: true })
  const backend = await startBackend(store, undefined, shell)
  try {
    await delay(2500)
    check(ilink.requests.length === 0, '假渠道零请求', ilink.requests.join(','))
    const status = await backend.rpc('gateway', 'getStatus')
    check(status?.success === false && status.error === 'Gateway connections are not available in this runtime.', 'gateway.getStatus 答「Gateway connections are not available in this runtime.」', JSON.stringify(status))
  } finally {
    await stopBackend(backend.child)
    ilink.server.close()
  }
}

const provider = await startFakeProvider(0, REPLY_TEXT)
const shell = makeQuietShell()
try {
  await stepEnabled(provider, shell)
  await stepDisabled(provider, shell)
  await stepDefaultLauncher(provider, shell)
} catch (error) {
  failures += 1
  console.log(`  ✗ 门中途出错:${error instanceof Error ? error.message : String(error)}`)
} finally {
  for (const child of started) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  provider.close()
  rmSync(tmpRoot, { recursive: true, force: true })
}
console.log(failures === 0 ? '\n[gate:gateway] 全绿' : `\n[gate:gateway] ${failures} 项红`)
process.exit(failures === 0 ? 0 : 1)
