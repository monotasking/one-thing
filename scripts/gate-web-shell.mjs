#!/usr/bin/env node
/**
 * C2 收尾批的真机门 ②:apps/web(浏览器壳)聊天链路 + token 不进 URL。
 *
 * C2(`docs/design/client-sdk-2026-09.md` §5.2)把 `packages/renderer/platform/web.ts`
 * 的推送订阅从手写 `new EventSource(...)` 换成了 `@onething/client` 的
 * `createHttpTransport`(fetch + 自解析 SSE)。`EventSource` 带不了 header,所以老实现
 * 靠 `?token=` 把 Bearer token 塞进 URL;新实现用 `fetch` 带得了 header,于是那扇
 * 门理应焊死。这道门证两件事:
 *
 *  ① 聊天链路本身没坏 —— 真无头 Chromium 打真 `server:build` 产物 + 真
 *     `apps/web` dev 代理,发一条消息、收到假 provider 的流式回复。
 *  ② `GET /api/events` 这条请求的 URL 上**没有** `token=`,而 `Authorization`
 *     头**有**(`apps/web/dev-api-proxy.ts` 按发现文件注入的那一手)。
 *
 * 跑法:仓根先 `bun run server:build`,然后 `node scripts/gate-web-shell.mjs`。
 * 每次一个全新的临时 store + 固定 `ONETHING_SERVER_PORT`/`ONETHING_SERVER_TOKEN`,
 * 跑完删干净;绝不碰 `~/.onething`。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startFakeProvider, fakeProviderAiSettings, FAKE_PROVIDER_ENV } from './lib/gate-fake-provider.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')

const SERVER_PORT = 18991
const SERVER_TOKEN = 'gate-web-shell-token'
const WEB_PORT = 5174
const MOCK_PORT = 18785
const TYPED_TEXT = 'gate-web-shell:这一句是从 web 壳输入框发出去的'
const REPLY_TEXT = 'gate-web-shell:这是假 provider 经 web 壳收到的流式回答。'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 等子进程真的退出(而不是只发了信号)再清理它的 store —— 避免残留半个临时目录。 */
function waitExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}

async function waitFor(label, predicate, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(200)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}`)
}

function portConnects(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = value => { socket.destroy(); resolve(value) }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/**
 * 一台记录型反向代理,插在「apps/web 的 dev 代理」与「真 server」之间,只为了看清
 * **代理转出去的那一跳**到底带没带 Authorization 头 —— 浏览器自己发出的那条请求
 * 天生就没有这个头(token 止步于 dev 代理,不进浏览器,这是设计;见 web-sse.ts
 * 文件头),所以这件事测不到浏览器发出的请求上,只能测代理转发出去的那一条。
 * 做法:先让真 server 把端口写进发现文件,再把发现文件的 `port` 改指到这台代理
 * (pid/token/host/owner 不动 —— dev-api-proxy 的 pid 存活检查认的是真 server 那个
 * pid,它确实活着),代理原样转发 + 记录每条请求的 header,收尾把记录交出去。
 */
function startRecordingProxy(targetPort) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: { ...req.headers } })
    const proxyReq = http.request(
      { host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: req.headers },
      proxyRes => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
        proxyRes.pipe(res)
      },
    )
    proxyReq.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
    req.pipe(proxyReq)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
}

function readScreenTree(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.message[data-message-id]')).map(el => ({
      id: el.getAttribute('data-message-id'),
      role: el.classList.contains('user') ? 'user' : el.classList.contains('assistant') ? 'assistant' : 'other',
      text: el.textContent ?? '',
    })),
  )
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error('[gate-web-shell] 找不到 dist/server/main.js —— 先在仓根跑 `bun run server:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'gate-web-shell-store-'))
  let mockServer
  let server
  let recordingProxy
  let webDev
  let browser

  try {
    console.log('\n[1/7] 起假 provider,写隔离 settings.json')
    mockServer = await startFakeProvider(MOCK_PORT, REPLY_TEXT)
    writeFileSync(path.join(store, 'settings.json'), JSON.stringify({
      ai: fakeProviderAiSettings(MOCK_PORT),
      tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
      diagnostics: { enabled: false },
    }, null, 2))

    console.log('\n[2/7] 起隔离 store 上的真 server(dist/server/main.js)')
    const serverErr = []
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...FAKE_PROVIDER_ENV,
        ONETHING_STORE_PATH: store,
        ONETHING_SERVER_PORT: String(SERVER_PORT),
        ONETHING_SERVER_TOKEN: SERVER_TOKEN,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stderr.on('data', chunk => serverErr.push(chunk.toString()))
    server.stdout.on('data', chunk => serverErr.push(chunk.toString()))

    await waitFor('core 端口可连', () => portConnects('127.0.0.1', SERVER_PORT)).catch(error => {
      throw new Error(`${error.message}\nserver 输出尾:\n${serverErr.slice(-40).join('')}`)
    })
    const discoveryPath = path.join(store, 'run', 'http.json')
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf-8'))
    assert(discovery.owner === 'server', `owner=${discovery.owner}`)
    assert(discovery.port === SERVER_PORT, `固定端口生效:${discovery.port}`)

    console.log('\n[2.5/7] 插一台记录型反向代理,看清 dev 代理转出去那一跳的 header')
    recordingProxy = await startRecordingProxy(SERVER_PORT)
    // 只改 port —— pid/token/host/owner 原样保留:dev-api-proxy 的存活检查认的是
    // 真 server 那个 pid(它确实活着),token 也还是真 server 铸的那个。
    writeFileSync(discoveryPath, JSON.stringify({ ...discovery, port: recordingProxy.port }, null, 2))
    assert(await portConnects('127.0.0.1', recordingProxy.port), `记录代理端口 ${recordingProxy.port} 可连`)

    console.log('\n[3/7] 起 apps/web dev 代理(同一个隔离 store,读同一份发现文件)')
    const webErr = []
    webDev = spawn(process.execPath, [
      path.join(repoRoot, 'node_modules/.bin/vite'),
      '--config', 'apps/web/vite.config.ts',
      '--port', String(WEB_PORT),
      '--strictPort',
    ], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    webDev.stderr.on('data', chunk => webErr.push(chunk.toString()))
    webDev.stdout.on('data', chunk => webErr.push(chunk.toString()))
    await waitFor('web dev 服务端口可连', () => portConnects('127.0.0.1', WEB_PORT)).catch(error => {
      throw new Error(`${error.message}\nweb dev 输出尾:\n${webErr.slice(-40).join('')}`)
    })

    console.log('\n[4/7] 无头 Chromium 打开 web 壳,抓网络请求')
    browser = await chromium.launch()
    const page = await browser.newPage()
    const requests = []
    page.on('request', req => {
      if (req.url().includes('/api/')) {
        requests.push({ url: req.url(), headers: req.headers() })
      }
    })
    await page.goto(`http://127.0.0.1:${WEB_PORT}`, { waitUntil: 'domcontentloaded' })

    console.log('\n[5/7] 冷启动落在「没有活跃会话」——点 New Chat 起一条草稿会话')
    await waitFor('New Chat 按钮在 DOM 里', () =>
      page.evaluate(() => Array.from(document.querySelectorAll('button, [role="button"], a'))
        .some(el => (el.textContent || '').includes('New Chat'))),
    )
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .find(el => (el.textContent || '').includes('New Chat'))
      btn?.click()
    })
    await waitFor('composer 输入区在 DOM 里', () =>
      page.evaluate(() => Boolean(document.querySelector('.composer-input [contenteditable="true"]'))),
    )

    console.log('\n[6/7] ① 真敲一句、真发送,②assistant 流式回复经 HTTP/SSE 上屏')
    await page.click('.composer-input [contenteditable="true"]')
    await page.keyboard.type(TYPED_TEXT, { delay: 5 })
    await page.click('.send-btn')

    const afterSend = await waitFor('用户消息落屏', async () => {
      const tree = await readScreenTree(page)
      return tree.find(row => row.role === 'user' && row.text.includes(TYPED_TEXT))
    })
    assert(Boolean(afterSend.id), `用户消息落屏,id=${afterSend.id}`)

    const afterReply = await waitFor('assistant 回复经 SSE 上屏', async () => {
      const tree = await readScreenTree(page)
      return tree.find(row => row.role === 'assistant' && row.text.includes(REPLY_TEXT))
    }, 20_000).catch(async error => {
      const tree = await readScreenTree(page).catch(() => [])
      throw new Error(`${error.message}\n当前屏幕树:${JSON.stringify(tree)}`)
    })
    assert(Boolean(afterReply.id), `assistant 回复落屏,id=${afterReply.id}`)

    console.log('\n[7/7] token 不进 URL(浏览器侧)—— 而是在 Authorization 头里(代理转发那一跳)')
    // 浏览器侧:token 止步于 dev 代理,浏览器自己发出的请求天生没有 Authorization 头
    // (这是设计,不是缺口)—— 这里只钉「URL 里没有 token=」。
    const browserEventsRequests = requests.filter(r => r.url.includes('/api/events'))
    assert(browserEventsRequests.length > 0, `浏览器侧抓到 ${browserEventsRequests.length} 条 /api/events 请求`)
    for (const req of browserEventsRequests) {
      assert(!req.url.includes('token='), `浏览器发出的 URL 无 token=:${req.url}`)
    }
    // 代理转发侧:dev-api-proxy 按发现文件读到 token 之后补的 Authorization 头,
    // 只有在它转发给真 server 的那一跳才看得见 —— 记录代理挡在中间,原样转发。
    const proxiedEventsRequests = recordingProxy.seen.filter(r => r.url.includes('/api/events'))
    assert(proxiedEventsRequests.length > 0, `代理转发侧抓到 ${proxiedEventsRequests.length} 条 /api/events 请求`)
    for (const req of proxiedEventsRequests) {
      assert(!req.url.includes('token='), `代理转发的 URL 也无 token=:${req.url}`)
      const auth = req.headers.authorization
      assert(
        typeof auth === 'string' && auth === `Bearer ${SERVER_TOKEN}`,
        `代理转发那一跳带着正确的 Authorization 头:${auth ? 'Bearer ***(match)' : '(缺失)'}`,
      )
    }

    console.log('\n[gate-web-shell] 全绿:发送 → 账本 → SSE 流式回复上屏,且 token 不进 URL')
  } finally {
    console.log('\n[清理] 关浏览器 / 停 web dev / 停记录代理 / 停 server / 停假 provider / 删临时目录')
    await browser?.close().catch(() => {})
    webDev?.kill('SIGTERM')
    await waitExit(webDev)
    await new Promise(resolve => recordingProxy ? recordingProxy.server.close(resolve) : resolve())
    server?.kill('SIGTERM')
    await waitExit(server)
    await new Promise(resolve => mockServer ? mockServer.close(resolve) : resolve())
    await rm(store, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[gate-web-shell] 红:', error.message)
  process.exitCode = 1
})
