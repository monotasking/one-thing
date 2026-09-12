/**
 * B0 spike ②-⑥ 的一半:拿 **chrome-devtools-mcp 本人**(本机 1.9.0)去连一个开着
 * `--remote-debugging-port` 的 Electron,用 MCP 协议(JSON-RPC over stdio)发一次
 * `list_pages`,把它原样的回答打出来 —— 这是「chrome-mcp 能控内置浏览器」的直接证据,
 * 比 puppeteer 自己连一遍更有说服力(puppeteer 是 MCP 的底,不是 MCP 本身)。
 *
 * 跑法(纯 node,不需要 Electron):
 *   node scripts/spike-browser/mcp-list-pages.mjs --browserUrl=http://127.0.0.1:19402 \
 *        [--mcp=<chrome-devtools-mcp 包目录>] [--tools]
 * 输出一行 `MCP_JSON={…}`。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const argv = process.argv.slice(2)
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const browserUrl = arg('browserUrl')
const MCP = arg('mcp', '/Users/yitiansong/.npm/_npx/15c61037b1978c83/node_modules/chrome-devtools-mcp')
const WANT_TOOLS = argv.includes('--tools')
/** 1.9.0 的 take_snapshot 要 pageId(list_pages 打出来的序号) */
const PAGE_ID = arg('pageId', '1')

if (!browserUrl) {
  console.log('MCP_JSON=' + JSON.stringify({ error: 'missing --browserUrl' }))
  process.exit(1)
}

const entry = path.join(MCP, 'build/src/bin/chrome-devtools-mcp.js')
let version = null
try { version = require(path.join(MCP, 'package.json')).version } catch {}

const child = spawn(process.execPath, [entry, '--browserUrl', browserUrl], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})

let stdout = ''
let stderr = ''
const seen = new Map()
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')

let done = false
function finish(reason) {
  if (done) return
  done = true
  clearTimeout(timer)
  try { child.kill('SIGKILL') } catch {}
  const listPages = seen.get(3)
  const tools = seen.get(2)
  const snapshot = seen.get(4)
  const newPage = seen.get(5)
  const textOf = (r) => (r?.result?.content || []).map((c) => String(c.text || '')).join('\n')
  console.log('MCP_JSON=' + JSON.stringify({
    version,
    browserUrl,
    reason,
    serverInfo: seen.get(1)?.result?.serverInfo ?? null,
    toolCount: tools?.result?.tools?.length ?? null,
    toolNames: WANT_TOOLS ? (tools?.result?.tools || []).map((t) => t.name) : undefined,
    listPagesError: listPages?.error ?? null,
    listPagesIsError: listPages?.result?.isError ?? null,
    listPagesText: listPages ? textOf(listPages).slice(0, 2000) : null,
    // 「列得出来」只是第一步,能不能**驱动**才是要的:take_snapshot 是 click / fill 的底
    takeSnapshot: snapshot ? { isError: snapshot.result?.isError ?? null, error: snapshot.error ?? null, text: textOf(snapshot).slice(0, 600) } : null,
    // new_page 在 Electron 上开出什么(puppeteer 那半已知 Target.createTarget Not supported)
    newPage: newPage ? { isError: newPage.result?.isError ?? null, error: newPage.error ?? null, text: textOf(newPage).slice(0, 400) } : null,
    stderrTail: stderr.split('\n').filter(Boolean).slice(-8),
  }))
  process.exit(0)
}

const timer = setTimeout(() => finish('timeout-30s'), 30000)

child.stdout.on('data', (d) => {
  stdout += d.toString()
  const lines = stdout.split('\n')
  stdout = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id != null) seen.set(msg.id, msg)
    } catch { /* 非 JSON 行忽略 */ }
  }
  if (seen.has(5)) setTimeout(() => finish('ok'), 200)
})
child.stderr.on('data', (d) => { stderr += d.toString() })
child.on('error', (e) => { stderr += `spawn error: ${e.message}\n`; finish('spawn-error') })
child.on('exit', (c, s) => { stderr += `child exit code=${c} signal=${s}\n`; setTimeout(() => finish(`child-exit-${c}`), 300) })

send({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'spike-browser', version: '0.0.0' } },
})
setTimeout(() => {
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  setTimeout(() => send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_pages', arguments: {} } }), 400)
  setTimeout(() => send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'take_snapshot', arguments: { pageId: Number(PAGE_ID) } } }), 1800)
  setTimeout(() => send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'new_page', arguments: { url: 'about:blank' } } }), 3600)
}, 1000)
