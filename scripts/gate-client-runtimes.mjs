#!/usr/bin/env node
/**
 * gate:client —— **`@onething/client` 在系统 Node 与 Electron 下都真的跑得起来,
 * 不靠注释证明**(C0,`docs/design/client-sdk-2026-09.md` §7;与 `gate:native` 同一条法)。
 *
 * ## 这道门判什么
 *
 * 这个包的整个卖点是一句话:「浏览器与 Node 同一份代码」。它值多少钱,取决于
 * 「Node 那半边」是不是真的跑过。今天有两个 Node:server / CLI / vitest 用的**系统
 * Node**,桌面主进程用的是 **Electron 自带的那个 Node**。两者的 `fetch`(undici 版本)、
 * `ReadableStream`、`TextDecoder` 各是各的实现 —— vitest 绿只证了前者。
 *
 * 于是这道门在**两个运行时**里各跑一遍同一段真活:
 *
 *   ① `POST /api/rpc` 拿到 `{ok:true}`,并且服务器那边看见的是 `Authorization: Bearer`、
 *      URL 里**没有** token(拍点丙:token 只进 header);
 *   ② `GET /api/events` 收满 3 条 SSE(会话事件 / 流分片 / 设置变更三种名字都过一遍);
 *   ③ 服务器把第一条连接掐掉,客户端自愈重连并带上 `?after=<最后一个 id>` —— 续播语义。
 *
 * 任一失败即红,并把那个运行时**自己的原话**打出来(不由这个脚本转述),连同
 * `process.versions` 的读数。
 *
 * ## 为什么要现打一个 bundle
 *
 * 包里是 `.ts`,两个运行时都不认。用 esbuild 现打一份 CJS 到临时目录,跑完删。
 * `@shared` 不是包而是别名,所以 bundle 时喂一条 alias —— 这也顺带证明了这个包的
 * import 图在**打包器**眼里是闭合的(没有偷偷指回某个壳)。
 *
 * 用法:`node scripts/gate-client-runtimes.mjs [--json] [--keep]`
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')
const keepBundle = process.argv.includes('--keep')

/** Electron 二进制的路径:`require('electron')` 导出的就是它(判据同 gate:native)。 */
function electronBinaryPath() {
  const pathFile = join(repoRoot, 'node_modules', 'electron', 'path.txt')
  const distDir = join(repoRoot, 'node_modules', 'electron', 'dist')
  if (!existsSync(pathFile) || !existsSync(distDir)) return undefined
  const full = join(distDir, readFileSync(pathFile, 'utf8').trim())
  return existsSync(full) ? full : undefined
}

/**
 * 驱动程序:起一台假 core,用 `createHttpTransport` 跑那三件事,把读数打成一行。
 *
 * 它自己就是被测代码的**唯一**消费者 —— 断言写在这里而不是在 vitest 里,因为
 * Electron 下没有 vitest。
 */
const DRIVER_SOURCE = String.raw`
import { createServer } from 'node:http'
import { createHttpTransport } from '@onething/client'

const seen = []
let connections = 0
let closeFirst = () => {}

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  seen.push({ url: request.url, authorization: request.headers.authorization ?? null })

  if (url.pathname === '/api/rpc') {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, data: { of: body.domain + '.' + body.method } }))
    })
    return
  }

  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(': connected\n\n')
    connections += 1
    if (connections === 1) {
      response.write('retry: 20\n\n')
      response.write('id: 11\nevent: session:event\ndata: {"sessionId":"s1","sequence":11}\n\n')
      response.write('event: session:stream\ndata: {"sessionId":"s1","chunk":{"type":"text-delta"}}\n\n')
      // 掐掉:重连必须自愈,并带上 ?after=11。
      closeFirst = () => response.end()
      setTimeout(() => closeFirst(), 30)
      return
    }
    response.write('event: settings:changed\ndata: {"ai":{}}\n\n')
    return
  }

  response.writeHead(404)
  response.end()
})

function fail(step, detail) {
  process.stderr.write('__GATE_ERR__' + JSON.stringify({ step, detail }))
  process.exit(3)
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const transport = createHttpTransport({ baseUrl, token: 'gate-token' })

  // ① invoke
  const response = await transport.invoke({ domain: 'sessions', method: 'list', payload: {} })
  if (!response.ok || response.data.of !== 'sessions.list') fail('invoke', response)
  const rpcRequest = seen.find(entry => entry.url === '/api/rpc')
  if (!rpcRequest) fail('invoke', 'server never saw POST /api/rpc')
  if (rpcRequest.authorization !== 'Bearer gate-token') fail('bearer', rpcRequest)
  if (rpcRequest.url.includes('token')) fail('token-in-url', rpcRequest)

  // ② + ③ events(3 条,跨一次掉线重连)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  const got = []
  for await (const event of transport.events({ signal: controller.signal })) {
    got.push({ name: event.name, id: event.id ?? null })
    if (got.length === 3) controller.abort()
  }
  clearTimeout(timer)
  transport.close()

  const names = got.map(entry => entry.name)
  if (names.join(',') !== 'session:event,session:stream,settings:changed') fail('event-names', got)

  const eventRequests = seen.filter(entry => entry.url.startsWith('/api/events'))
  if (eventRequests.length !== 2) fail('reconnect', eventRequests)
  if (eventRequests[0].url !== '/api/events') fail('first-connection-should-have-no-after', eventRequests)
  if (eventRequests[1].url !== '/api/events?after=11') fail('after-resume', eventRequests)
  if (eventRequests.some(entry => entry.authorization !== 'Bearer gate-token')) fail('sse-bearer', eventRequests)
  if (eventRequests.some(entry => entry.url.includes('token'))) fail('sse-token-in-url', eventRequests)

  process.stdout.write('__GATE_OK__' + JSON.stringify({
    node: process.versions.node,
    modules: process.versions.modules,
    electron: process.versions.electron ?? null,
    undici: process.versions.undici ?? null,
    events: names,
    connections: eventRequests.map(entry => entry.url),
  }))
}

main()
  .catch(error => fail('threw', String(error && error.stack || error)))
  .finally(() => { server.closeAllConnections?.(); server.close() })
`

function buildBundle(outDir) {
  const entry = join(outDir, 'driver.mjs')
  const bundle = join(outDir, 'driver.cjs')
  // esbuild 直接吃 stdin 也行,但落一个文件更好排障(--keep 时留着看)。
  const write = spawnSync('node', ['-e', `require('node:fs').writeFileSync(process.argv[1], process.argv[2])`, entry, DRIVER_SOURCE], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (write.status !== 0) return { ok: false, message: write.stderr || 'failed to write driver' }

  const result = spawnSync(join(repoRoot, 'node_modules', '.bin', 'esbuild'), [
    entry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    `--alias:@shared=${join(repoRoot, 'packages', 'shared')}`,
    `--outfile=${bundle}`,
    '--log-level=warning',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    // 驱动住在临时目录里,向上找不到仓的 node_modules。喂 `NODE_PATH`(esbuild CLI
    // 认这个环境变量,`nodePaths` 只在 JS API 上有)而不是给 `@onething/client`
    // 也来一条 alias:走 node_modules 那条路,包的 `package.json` "exports" 才真的
    // 被用上 —— exports 写错(比如漏了 `.`)这道门当场红,而 alias 会把它盖过去。
    env: { ...process.env, NODE_PATH: join(repoRoot, 'node_modules') },
  })
  if (result.status !== 0) {
    return { ok: false, message: (result.stderr || result.stdout || `esbuild exit ${result.status}`).trim() }
  }
  return { ok: true, bundle }
}

function runUnder(label, exe, bundle, extraEnv) {
  const res = spawnSync(exe, [bundle], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    timeout: 120000,
  })
  const stdout = res.stdout ?? ''
  const stderr = res.stderr ?? ''
  if (res.error) return { label, ok: false, message: res.error.message }
  if (stdout.includes('__GATE_OK__')) {
    let readings = {}
    try {
      readings = JSON.parse(stdout.slice(stdout.indexOf('__GATE_OK__') + '__GATE_OK__'.length))
    } catch { /* 读数解不出来不影响「跑通了」这个判据 */ }
    return { label, ok: true, readings }
  }
  const marked = stderr.indexOf('__GATE_ERR__')
  // **整条原话都要留**(与 gate:native 同一条判例:按第一行截断正好把唯一有用的
  // 读数扔掉)。折成一行,尾部再截长。
  const message = marked >= 0
    ? stderr.slice(marked + '__GATE_ERR__'.length).trim()
    : (stderr.trim() || stdout.trim() || `exit ${res.status}`)
  return {
    label,
    ok: false,
    message: message.split('\n').map(line => line.trim()).filter(Boolean).join(' / ').slice(0, 800),
  }
}

const outDir = mkdtempSync(join(tmpdir(), 'onething-gate-client-'))
let exitCode = 0
const results = []

try {
  const built = buildBundle(outDir)
  if (!built.ok) {
    // 打不出 bundle 本身就是红:说明这个包的 import 图对打包器不闭合。
    results.push({ label: 'bundle', ok: false, message: built.message })
    exitCode = 1
  } else {
    results.push(runUnder(`node ${process.versions.node}`, process.execPath, built.bundle, {}))

    const electron = electronBinaryPath()
    if (!electron) {
      results.push({
        label: 'electron',
        ok: false,
        message: 'node_modules/electron 没装 —— 两个运行时里少一个,这道门不能算绿',
      })
    } else {
      results.push(runUnder('electron (ELECTRON_RUN_AS_NODE)', electron, built.bundle, {
        ELECTRON_RUN_AS_NODE: '1',
      }))
    }
    if (results.some(result => !result.ok)) exitCode = 1
  }
} finally {
  // 收尸:临时 bundle 不留在盘上(`--keep` 时留着排障,并把路径打出来)。
  if (keepBundle) console.log(`[gate:client] kept bundle at ${outDir}`)
  else rmSync(outDir, { recursive: true, force: true })
}

if (asJson) {
  console.log(JSON.stringify({ ok: exitCode === 0, results }, null, 2))
} else {
  for (const result of results) {
    if (result.ok) {
      const readings = result.readings ?? {}
      console.log(`[gate:client] ok: ${result.label}`)
      console.log(`  versions: node=${readings.node ?? '?'} modules=${readings.modules ?? '?'}`
        + ` electron=${readings.electron ?? '-'} undici=${readings.undici ?? '-'}`)
      console.log(`  events:   ${(readings.events ?? []).join(', ')}`)
      console.log(`  streams:  ${(readings.connections ?? []).join(' → ')}`)
    } else {
      console.error(`[gate:client] failed: ${result.label}`)
      console.error(`  ${result.message}`)
    }
  }
  console.log(exitCode === 0
    ? '[gate:client] complete: @onething/client runs under BOTH system Node and Electron'
    : '[gate:client] complete: FAILED')
}

process.exit(exitCode)
