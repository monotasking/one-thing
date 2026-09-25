#!/usr/bin/env node
/**
 * `npm run gate:providers-auth` —— 订阅登录的生命周期住在后端(批 1,正本
 * `docs/design/provider-settings-rework-2026-09.md` §3.1 / §3.3)。
 *
 * 它证的是**产物**:`dist/server/main.js` 起在一间临时 store 上,旁边一台本地假 OAuth 站
 * (设备码端点 + token 端点 + 一张授权页),Kimi Code(设备码流)经它自己的环境变量
 * `KIMI_CODE_OAUTH_HOST` 指到这台站上 —— 产品代码一行不改。全程只走 `POST /api/rpc` 与
 * `GET /api/events`,**门里一次 `devicePoll` 都不调**:轮询是后端自己的事,这正是要证的。
 *
 *   ① `oauth.start` 答完,`oauth:flow { phase: 'pending' }` 出网(带这条流的 flowId);
 *   ② 假站上「用户点了授权」→ `completed` 出网,`oauth.status.isLoggedIn`;且整条流里
 *      `pending` 只出过**一次**(轮询中间不发);
 *   ③ 再起一条 → token 端点被打过之后 `oauth.cancel` → `cancelled` 出网,之后
 *      token 端点**一次都不再被打**(计数,等三个轮询间隔);
 *   ④ 一条 `expires_in: 2` 的流 → `expired` 出网,之后同样不再打;
 *   ⑤ 留一条在飞的流(10 分钟有效)→ SIGTERM → 进程 10 秒内以 0 退出,server.jsonl 里
 *      `oauth flows disposed` 那一行说收了 1 条流、剩 0 只计时器,退出之后假站再没收到一问。
 *
 * 壳侧(链接可点、复制钮、`openExternal` 被调一次且参数是返回网址)不在这道门里:
 * `src/providers/components/__tests__/auth-flow-screen.test.tsx` 覆盖。
 *
 * **必须用 node 起**(同 gate:acp):server 的检索 Worker 要 `node:sqlite`,bun 没有。
 * 不构建:缺 `dist/server/main.js` 就叫你先在仓根 `bun run server:build`。
 * 绝不碰真 `~/.onething` —— `ONETHING_STORE_PATH` 指向 mkdtemp 出来的临时目录;不连 5175。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const PROVIDER = 'kimi-code'
/** 假站答的轮询间隔(秒)。RFC 8628 的 interval 是整秒;1 秒让门跑得快,又足够数得清。 */
const INTERVAL_S = 1

if (!fs.existsSync(serverEntry)) {
  console.error('[gate:providers-auth] 缺 dist/server/main.js —— 先在仓根跑 `bun run server:build`')
  process.exit(1)
}

const failures = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function check(condition, message) {
  if (condition) console.log(`  ok   ${message}`)
  else {
    failures.push(message)
    console.error(`  FAIL ${message}`)
  }
}

async function waitFor(predicate, budgetMs, stepMs = 50) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < budgetMs) {
    const value = await predicate()
    if (value) return value
    await sleep(stepMs)
  }
  return undefined
}

/* ── 假 OAuth 站 ─────────────────────────────────────────────────────────── */

/**
 * 每一条设备码一格账:`approved` 由「授权页上点了同意」翻真;`hits` 数 token 端点为它被打了几次;
 * `hitsAfter(t)` 数某一刻之后的次数 —— ③④⑤ 的判据就是它不再涨。
 */
function startFakeStation() {
  const codes = new Map()
  const hitLog = []
  let seq = 0
  let nextExpiresIn = 600

  const readBody = req => new Promise(resolve => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => resolve(body))
  })
  const send = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const base = `http://127.0.0.1:${server.address().port}`
    if (req.method === 'POST' && url.pathname === '/api/oauth/device_authorization') {
      await readBody(req)
      seq += 1
      const deviceCode = `dc-${seq}`
      const userCode = `GATE-${String(seq).padStart(4, '0')}`
      codes.set(deviceCode, { userCode, approved: false })
      send(res, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${base}/device`,
        verification_uri_complete: `${base}/device?user_code=${userCode}`,
        expires_in: nextExpiresIn,
        interval: INTERVAL_S,
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/oauth/token') {
      const form = new URLSearchParams(await readBody(req))
      const deviceCode = form.get('device_code') ?? ''
      hitLog.push({ deviceCode, at: Date.now() })
      const entry = codes.get(deviceCode)
      if (!entry) return send(res, 400, { error: 'invalid_grant' })
      if (!entry.approved) return send(res, 400, { error: 'authorization_pending' })
      send(res, 200, {
        access_token: `at-${deviceCode}`,
        refresh_token: `rt-${deviceCode}`,
        expires_in: 3600,
        token_type: 'Bearer',
      })
      return
    }
    // 授权页:门不点它(那是用户的事),只证它在 —— 网址是能打开的东西。
    if (req.method === 'GET' && url.pathname === '/device') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><title>gate device</title><p>${url.searchParams.get('user_code') ?? ''}</p>`)
      return
    }
    send(res, 404, { error: 'not_found' })
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        approve: userCode => {
          for (const entry of codes.values()) if (entry.userCode === userCode) entry.approved = true
        },
        deviceCodeOf: userCode => [...codes.entries()].find(([, entry]) => entry.userCode === userCode)?.[0],
        hits: deviceCode => hitLog.filter(hit => hit.deviceCode === deviceCode).length,
        hitsSince: at => hitLog.filter(hit => hit.at > at).length,
        setExpiresIn: seconds => { nextExpiresIn = seconds },
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

/* ── server 与它的两张面 ─────────────────────────────────────────────────── */

async function waitForDiscovery(storePath, timeoutMs = 30_000) {
  const discoveryFile = path.join(storePath, 'run', 'http.json')
  const found = await waitFor(() => {
    if (!fs.existsSync(discoveryFile)) return undefined
    try {
      const discovery = JSON.parse(fs.readFileSync(discoveryFile, 'utf-8'))
      return discovery?.port ? discovery : undefined
    } catch {
      return undefined // 半写状态,下一拍再读。
    }
  }, timeoutMs, 200)
  if (!found) throw new Error('server did not publish its discovery file in time')
  return found
}

function createRpc(discovery) {
  const base = `http://127.0.0.1:${discovery.port}`
  const headers = {
    'content-type': 'application/json',
    ...(discovery.token ? { authorization: `Bearer ${discovery.token}` } : {}),
  }
  return async (domain, method, payload = {}) => {
    const response = await fetch(`${base}/api/rpc`, { method: 'POST', headers, body: JSON.stringify({ domain, method, payload }) })
    if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
    const body = await response.json()
    if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method}: ${JSON.stringify(body?.error ?? body)}`)
    return body.data
  }
}

/** 订 `GET /api/events`,只收 `oauth:*` 帧(`{ event, data, at }`)。 */
async function openEventStream(discovery) {
  const controller = new AbortController()
  const frames = []
  const response = await fetch(`http://127.0.0.1:${discovery.port}/api/events`, {
    headers: discovery.token ? { authorization: `Bearer ${discovery.token}` } : {},
    signal: controller.signal,
  })
  if (!response.ok || !response.body) throw new Error(`GET /api/events HTTP ${response.status}`)
  const decoder = new TextDecoder()
  let buffer = ''
  const pump = (async () => {
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        let cut
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          let event = 'message'
          const dataLines = []
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          }
          if (!event.startsWith('oauth:') || dataLines.length === 0) continue
          try {
            frames.push({ event, data: JSON.parse(dataLines.join('\n')), at: Date.now() })
          } catch {
            // 不认的帧不收。
          }
        }
      }
    } catch {
      // 收尾时 abort 掉,这里吞掉那一下。
    }
  })()
  return { frames, close: async () => { controller.abort(); await pump } }
}

const flowFrames = (frames, flowId) => frames.filter(frame => frame.event === 'oauth:flow' && frame.data?.flowId === flowId)
const phaseSeen = (frames, flowId, phase) => flowFrames(frames, flowId).find(frame => frame.data.phase === phase)

/* ── 门 ─────────────────────────────────────────────────────────────────── */

const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-gate-auth-'))
const station = await startFakeStation()
let child
let sse
const serverOut = []

try {
  // 代理变量一律不带:假站在回环上,走代理只会让门量到代理。
  const env = { ...process.env }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...env,
      NO_PROXY: '127.0.0.1,localhost',
      ONETHING_STORE_PATH: storePath,
      ONETHING_SERVER_DATA_ROOT: storePath,
      ONETHING_SERVER_HOST: '127.0.0.1',
      ONETHING_SERVER_PORT: '',
      KIMI_CODE_OAUTH_HOST: station.base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => serverOut.push(chunk.toString()))
  child.stderr.on('data', chunk => serverOut.push(chunk.toString()))

  const discovery = await waitForDiscovery(storePath)
  const rpc = createRpc(discovery)
  sse = await openEventStream(discovery)

  // ── ① start → pending 出网 ───────────────────────────────────────────
  console.log('[gate:providers-auth] ① start → pending')
  const first = await rpc('oauth', 'start', { providerId: PROVIDER })
  check(first?.success === true && typeof first.flowId === 'string' && first.flowKind === 'device-code',
    `oauth.start 起了一条设备码流(flowId = ${first?.flowId})`)
  check(first?.verificationUri === `${station.base}/device?user_code=${first?.userCode}`,
    `交回的授权页就是 verification_uri_complete(${first?.verificationUri})`)
  const pending1 = await waitFor(() => phaseSeen(sse.frames, first.flowId, 'pending'), 5_000)
  check(Boolean(pending1) && pending1.data.providerId === PROVIDER, 'oauth:flow pending 出网,带这条流的 flowId 与 providerId')

  // ── ② 授权 → completed 出网 + 登上 ─────────────────────────────────────
  console.log('[gate:providers-auth] ② 授权 → completed')
  const firstCode = station.deviceCodeOf(first.userCode)
  await waitFor(() => station.hits(firstCode) >= 2, 5_000)
  check(station.hits(firstCode) >= 2, `后端自己在轮询:没调一次 devicePoll,token 端点已被打 ${station.hits(firstCode)} 次`)
  station.approve(first.userCode)
  const completed = await waitFor(() => phaseSeen(sse.frames, first.flowId, 'completed'), 5_000)
  check(Boolean(completed), 'oauth:flow completed 出网')
  const status = await rpc('oauth', 'status', { providerId: PROVIDER })
  check(status?.isLoggedIn === true, `oauth.status.isLoggedIn = ${status?.isLoggedIn}`)
  const pendingCount = flowFrames(sse.frames, first.flowId).filter(frame => frame.data.phase === 'pending').length
  check(pendingCount === 1, `pending 整条流只发一次(轮询中间不发):${pendingCount} 次`)
  const afterCompleted = Date.now()
  await sleep(INTERVAL_S * 1000 * 2 + 300)
  check(station.hits(firstCode) > 0 && station.hitsSince(afterCompleted) === 0, '完成之后后端不再问 token 端点')

  // ── ③ cancel → cancelled 出网,不再打 token 端点 ──────────────────────
  console.log('[gate:providers-auth] ③ cancel')
  const second = await rpc('oauth', 'start', { providerId: PROVIDER })
  const secondCode = station.deviceCodeOf(second.userCode)
  await waitFor(() => station.hits(secondCode) >= 1, 5_000)
  const cancel = await rpc('oauth', 'cancel', { flowId: second.flowId })
  check(cancel?.success === true && cancel.cancelled === true, `oauth.cancel 真的取消了一条在跑的流(${JSON.stringify(cancel)})`)
  const cancelled = await waitFor(() => phaseSeen(sse.frames, second.flowId, 'cancelled'), 3_000)
  check(Boolean(cancelled), 'oauth:flow cancelled 出网')
  const hitsAtCancel = station.hits(secondCode)
  await sleep(INTERVAL_S * 1000 * 3 + 300)
  check(station.hits(secondCode) === hitsAtCancel, `取消之后 token 端点零新增(取消时 ${hitsAtCancel} 次,等 3 个间隔后 ${station.hits(secondCode)} 次)`)
  const again = await rpc('oauth', 'cancel', { flowId: second.flowId })
  check(again?.cancelled === false, '再取消一次答 cancelled: false(流早已不在)')

  // ── ④ expiresAt 到点 → expired 出网,不再打 ─────────────────────────────
  console.log('[gate:providers-auth] ④ 到点超时')
  station.setExpiresIn(2)
  const third = await rpc('oauth', 'start', { providerId: PROVIDER })
  const thirdCode = station.deviceCodeOf(third.userCode)
  const expired = await waitFor(() => phaseSeen(sse.frames, third.flowId, 'expired'), 6_000)
  check(Boolean(expired), `oauth:flow expired 出网(起流后 ${expired ? expired.at - (phaseSeen(sse.frames, third.flowId, 'pending')?.at ?? expired.at) : '—'}ms)`)
  const hitsAtExpiry = station.hits(thirdCode)
  await sleep(INTERVAL_S * 1000 * 3 + 300)
  check(station.hits(thirdCode) === hitsAtExpiry, `超时之后 token 端点零新增(${hitsAtExpiry} → ${station.hits(thirdCode)})`)

  // ── ⑤ dispose:一条在飞的流,SIGTERM 干净退出,零残留计时器 ──────────
  console.log('[gate:providers-auth] ⑤ dispose')
  station.setExpiresIn(600)
  const fourth = await rpc('oauth', 'start', { providerId: PROVIDER })
  const fourthCode = station.deviceCodeOf(fourth.userCode)
  await waitFor(() => station.hits(fourthCode) >= 1, 5_000)
  await sse.close()
  sse = undefined
  child.kill('SIGTERM')
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 10_000, 100)
  check(child.exitCode === 0, `SIGTERM 之后 10 秒内以 0 退出(exitCode = ${child.exitCode}, signal = ${child.signalCode})`)
  const exitedAt = Date.now()
  await sleep(INTERVAL_S * 1000 * 2 + 300)
  check(station.hitsSince(exitedAt) === 0, '退出之后假站再没收到一问')

  const logDir = path.join(storePath, 'log')
  const records = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter(name => name.endsWith('.jsonl'))
      .flatMap(name => fs.readFileSync(path.join(logDir, name), 'utf-8').split('\n'))
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
    : []
  const disposed = records.find(record => record.msg === 'oauth flows disposed')
  check(disposed?.fields?.flows === 1 && disposed?.fields?.timers === 0,
    `server 日志:oauth flows disposed ${JSON.stringify(disposed?.fields ?? null)}(收 1 条流、剩 0 只计时器)`)

  if (failures.length > 0) console.error(`[gate:providers-auth] server 输出尾:\n${serverOut.slice(-40).join('')}`)
} catch (error) {
  failures.push(String(error?.stack || error))
  console.error(`[gate:providers-auth] ${error?.stack || error}`)
  console.error(`[gate:providers-auth] server 输出尾:\n${serverOut.slice(-40).join('')}`)
} finally {
  if (sse) await sse.close().catch(() => {})
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await sleep(800)
    try { child.kill('SIGKILL') } catch { /* 已经没了就算了 */ }
  }
  await station.close()
  fs.rmSync(storePath, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`[gate:providers-auth] ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('[gate:providers-auth] ok —— ① pending / ② completed / ③ cancelled / ④ expired / ⑤ dispose 全绿')
