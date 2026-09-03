#!/usr/bin/env node
/**
 * 运行时统一第四步 4a 的真机门:**React 壳的浏览器形态**(`web:dev:react`)。
 *
 * 用户已拍「浏览器壳由 React 壳提供」。这道门是那句话的证词,和 Vue 那道
 * `gate:web-shell` 逐条同构(它**一个字都没动**,4b 删 apps/web 时才随之退役):
 *
 *  ① **聊天链路真的通** —— 真 `server:build` 产物 + 真 `web:dev:react` 的 `/api`
 *     动态代理 + 无头 Chromium:在真输入框里敲一句、真点发送,收到假 provider
 *     的**流式**回复上屏。走的是同一条 HTTP/SSE 面,不是渲染层自己画的。
 *  ② **token 不进 URL** —— `GET /api/events` 这条请求,浏览器发出的那一份 URL 上
 *     没有 `token=`;而代理转给真 server 的那一跳带着正确的
 *     `Authorization: Bearer`。两半分别测,因为它们本来就是两跳:
 *     **token 止步于 dev 代理,不进浏览器**(见 apps/desktop-react/vite/dev-api-proxy.ts)。
 *     浏览器那一跳测不出 Authorization —— 它天生没有,那是设计。
 *
 * ── 为什么②要插一台记录型反向代理 ────────────────────────────────────────
 * 与 Vue 那道门同一个理由,做法也照抄:先让真 server 把端口写进发现文件,再把
 * 发现文件的 `port` 改指到这台代理(`pid`/`token`/`host`/`owner` 一个字不动 ——
 * dev 代理的 pid 存活检查认的是真 server 那个 pid,它确实活着),代理原样转发 +
 * 记录每条请求的 header。
 *
 * ── 反证(怎么让它红)────────────────────────────────────────────────────
 * 摘掉 vite.config.ts 里 web 模式那一句 `onethingDevApiProxy()`:浏览器直打
 * `/api/*`,vite 自己 404 / 或打到没有 token 的地方 → ①在「用户消息落屏」处红。
 *
 * 跑法:仓根先 `bun run server:build`,然后 `node scripts/gate-web-shell-react.mjs`
 * (或 `npm run gate:web-shell:react`)。每次一个全新的临时 store + 固定
 * `ONETHING_SERVER_PORT`/`ONETHING_SERVER_TOKEN`,跑完删干净;**绝不碰 `~/.onething`**。
 * 端口都可用 env 换,免得撞上用户正在跑的东西:
 *   `ONETHING_GATE_WEB_PORT`(缺省 5174)/ `ONETHING_GATE_SERVER_PORT`(缺省 18992)
 *   / `ONETHING_GATE_MOCK_PORT`(缺省 18786)。
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

const numberFromEnv = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// 端口与 Vue 那道门**刻意错开**:两道门可以在同一台机器上前后脚跑而不打架。
const SERVER_PORT = numberFromEnv('ONETHING_GATE_SERVER_PORT', 18992)
const WEB_PORT = numberFromEnv('ONETHING_GATE_WEB_PORT', 5174)
const MOCK_PORT = numberFromEnv('ONETHING_GATE_MOCK_PORT', 18786)
const SERVER_TOKEN = 'gate-web-shell-react-token'
const SESSION_NAME = 'gate:web-shell:react · 浏览器壳'
const TYPED_TEXT = 'gate-web-shell-react:这一句是从 React 浏览器壳输入框发出去的'
const REPLY_TEXT = 'gate-web-shell-react:这是假 provider 经 React 浏览器壳收到的流式回答。'

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

/**
 * 收尸:删临时 store,**带重试**。
 *
 * 一次实测踩到的:`waitExit(server)` 已经返回(进程真的没了),`rm -rf` 仍然
 * `ENOTEMPTY … /log` —— 日志那一侧(JsonlFileSink 的 flush / 轮转)在收到 SIGTERM
 * 之后还会往 `<store>/log/` 里落最后一两个字节,恰好落在遍历与 rmdir 之间。
 * 那是**收尸的竞态,不是门的断言失败**,所以这里退避重试而不是把整道门判红;
 * 真删不掉才抛(那时是真有人攥着文件不放,值得响)。
 */
async function removeStore(store) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(store, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 5) throw error
      await delay(300)
    }
  }
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

/** 记录型反向代理:看清 dev 代理转出去的那一跳到底带没带 Authorization 头(文件头②)。 */
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

/** 用固定 token 直接打真 server(不经代理)—— 脚本侧「别人写进 store」的那只手。 */
async function rpc(domain, method, payload = {}) {
  const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVER_TOKEN}` },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  const body = await response.json()
  if (!body || body.ok !== true) {
    throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  }
  return body.data
}

/** 点一个 testid(与 apps/desktop-react 的门脚本同一手法)。 */
async function clickTestId(page, testId) {
  const clicked = await page.evaluate(id => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testId)
  if (!clicked) throw new Error(`点不到:[data-testid="${testId}"] 不在 DOM 里`)
}

/** 在 contenteditable 里「打」一段话(理由见 apps/desktop-react/scripts/gate-chat.mjs)。 */
async function typeIntoComposer(page, text) {
  const ok = await page.evaluate(value => {
    const box = document.querySelector('[data-testid="composer-input"]')
    if (!box) return false
    box.textContent = value
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, text)
  if (!ok) throw new Error('打不进去:[data-testid="composer-input"] 不在 DOM 里')
}

/** 屏幕上那棵树:按 DOM 序取 (id, role, 正文)。 */
function readScreenTree(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-message-id]')).map(el => ({
      id: el.getAttribute('data-message-id'),
      role: el.getAttribute('data-role'),
      text: el.textContent ?? '',
    })),
  )
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error('[gate-web-shell-react] 找不到 dist/server/main.js —— 先在仓根跑 `bun run server:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'gate-web-shell-react-store-'))
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

    // 门自己建一条会话:React 壳冷启动落在「没有活跃会话」,先有一条才谈得上进它。
    const made = await rpc('sessions', 'create', { name: SESSION_NAME })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(made)}`)
    assert(Boolean(sessionId), `建了一条空会话:${sessionId}`)

    console.log('\n[2.5/7] 插一台记录型反向代理,看清 dev 代理转出去那一跳的 header')
    recordingProxy = await startRecordingProxy(SERVER_PORT)
    writeFileSync(discoveryPath, JSON.stringify({ ...discovery, port: recordingProxy.port }, null, 2))
    assert(await portConnects('127.0.0.1', recordingProxy.port), `记录代理端口 ${recordingProxy.port} 可连`)

    console.log(`\n[3/7] 起 web:dev:react(React 壳 web 模式,:${WEB_PORT},同一个隔离 store)`)
    const webErr = []
    webDev = spawn(process.execPath, [
      path.join(repoRoot, 'node_modules/.bin/vite'),
      '--config', 'apps/desktop-react/vite.config.ts',
      '--mode', 'web',
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

    console.log('\n[4/7] 无头 Chromium 打开 React 浏览器壳,抓网络请求')
    browser = await chromium.launch()
    const page = await browser.newPage()
    const requests = []
    page.on('request', req => {
      if (req.url().includes('/api/')) requests.push({ url: req.url(), headers: req.headers() })
    })
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(String(error)))
    await page.goto(`http://127.0.0.1:${WEB_PORT}`, { waitUntil: 'domcontentloaded' })

    // `window.__d0` 是壳自己的连通探针(见 src/platform/connection.ts)。浏览器里
    // `hosted` 必须是 false —— 那正是「没有 Electron 宿主」这条路;`rpcOk` 证同源
    // `/api/rpc` 经 dev 代理真的往返成功了。
    const probe = await waitFor('壳完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    }).catch(async error => {
      const value = await page.evaluate(() => window.__d0 ?? null).catch(() => null)
      throw new Error(`${error.message}\n__d0=${JSON.stringify(value)}\n页面错误:${pageErrors.join('\n')}`)
    })
    assert(probe.hosted === false, '浏览器里没有 Electron 宿主(hosted=false)—— 走的正是无宿主那条路')
    assert(probe.rpcOk === true, `同源 /api/rpc 经 dev 代理往返成功(baseUrl=${probe.baseUrl ?? '(同源)'})`)

    console.log('\n[5/7] 进那条会话')
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    await clickTestId(page, 'dock-tile-sessions')
    await waitFor('总览画出那张卡', () =>
      page.evaluate(id => Boolean(document.querySelector(`[data-testid="card-${id}"]`)), sessionId),
    )
    await clickTestId(page, `card-${sessionId}`)
    await waitFor('聊天区就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="chat-stream"]'))),
    )

    console.log('\n[6/7] ① 真敲一句、真发送 → assistant 流式回复经 HTTP/SSE 上屏')
    await typeIntoComposer(page, TYPED_TEXT)
    await clickTestId(page, 'composer-send')

    const afterSend = await waitFor('用户消息落屏', async () => {
      const tree = await readScreenTree(page)
      return tree.find(row => row.role === 'user' && row.text.includes(TYPED_TEXT))
    })
    assert(Boolean(afterSend.id), `用户消息落屏,id=${afterSend.id}`)

    const afterReply = await waitFor('assistant 回复经 SSE 上屏', async () => {
      const tree = await readScreenTree(page)
      return tree.find(row => row.role === 'assistant' && row.text.includes(REPLY_TEXT))
    }, 25_000).catch(async error => {
      const tree = await readScreenTree(page).catch(() => [])
      throw new Error(`${error.message}\n当前屏幕树:${JSON.stringify(tree)}\n页面错误:${pageErrors.join('\n')}`)
    })
    assert(Boolean(afterReply.id), `assistant 流式回复落屏,id=${afterReply.id}`)

    console.log('\n[7/7] ② token 不进 URL(浏览器侧)—— 而是在 Authorization 头里(代理转发那一跳)')
    const browserEventsRequests = requests.filter(r => r.url.includes('/api/events'))
    assert(browserEventsRequests.length > 0, `浏览器侧抓到 ${browserEventsRequests.length} 条 /api/events 请求`)
    for (const req of browserEventsRequests) {
      assert(!req.url.includes('token='), `浏览器发出的 URL 无 token=:${req.url}`)
    }
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

    console.log('\n[gate-web-shell-react] 全绿:React 浏览器壳发送 → 账本 → SSE 流式回复上屏,且 token 不进 URL')
  } finally {
    console.log('\n[清理] 关浏览器 / 停 web dev / 停记录代理 / 停 server / 停假 provider / 删临时目录')
    await browser?.close().catch(() => {})
    webDev?.kill('SIGTERM')
    await waitExit(webDev)
    await new Promise(resolve => recordingProxy ? recordingProxy.server.close(resolve) : resolve())
    server?.kill('SIGTERM')
    await waitExit(server)
    await new Promise(resolve => mockServer ? mockServer.close(resolve) : resolve())
    await removeStore(store)
  }
}

main().catch(error => {
  console.error('\n[gate-web-shell-react] 红:', error.message)
  process.exitCode = 1
})
