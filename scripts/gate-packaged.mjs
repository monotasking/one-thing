#!/usr/bin/env node
/**
 * `npm run gate:packaged` —— 打包链的真验收(运行时统一第三步,2026-09-03)。
 *
 * 只信一件事:electron-builder 打出来的那只 .app **起得来、服务得了、退得干净**。
 * asar 里 `loadFile` 的页面路径、preload 路径、`process.resourcesPath` 下的
 * skills / templates / models、node-pty 的解包 —— 全部靠这一趟一次证,不靠注释。
 *
 * 步骤:
 *   ① `npm run build:unpack`(除非 `--no-build`,那就直接用 release/ 里现有的包)
 *   ② 起 `release/<platform>/onething.app/Contents/MacOS/onething`
 *        env ONETHING_STORE_PATH = 临时目录(**禁碰 ~/.onething**),
 *        `--user-data-dir=<临时>`,`--remote-debugging-port=<随机>`
 *   ③ 等 `<store>/run/http.json`(core 起来 + 内嵌 HTTP 面挂上的唯一凭证)
 *   ④ 用它的 token 打 `GET /api/capabilities` 与 `POST /api/rpc`(sessions.list)
 *   ⑤ CDP `GET /json` 断言至少一个 page 且 url 指向 asar 里的 index.html
 *   ⑥ SIGTERM → 等退出 → 断言 `run/http.json` 已删、没有残留进程
 *
 * ── 钥匙串那一格(必读)────────────────────────────────────────────────────
 * 打包出来的 app 是一个**新的代码签名身份**;`safeStorage` 是绑身份的 Keychain 门面,
 * 第一次起会弹「onething 想访问钥匙串」授权框,脚本起的进程没人点,core 就卡在
 * `createOnethingBackend` 里(0% CPU、无日志、无窗口;判例见根 CLAUDE.md)。本门在
 * ③ 超时后检测那只框:见到就**明说「需要人手点一次始终允许」并以 3 退出**,不挂死。
 * 这不是回归,是 macOS 凭证隔离按设计工作;点过一次以后同一份包再起就正常。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const noBuild = process.argv.includes('--no-build')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function log(line) { process.stdout.write(`[gate:packaged] ${line}\n`) }
function fail(line, code = 1) { process.stderr.write(`[gate:packaged] FAIL: ${line}\n`); process.exit(code) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function packagedBinary() {
  if (process.platform !== 'darwin') fail('本门今天只在 macOS 上跑(其它平台的包路径未接)', 2)
  const arch = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
  const candidates = [
    path.join(repoRoot, 'release', arch, 'onething.app/Contents/MacOS/onething'),
    path.join(repoRoot, 'release', 'mac', 'onething.app/Contents/MacOS/onething'),
  ]
  const found = candidates.find(p => existsSync(p))
  if (!found) fail(`找不到打包产物:${candidates.join(' | ')}`)
  return found
}

// ① 打包
if (!noBuild) {
  log('① npm run build:unpack')
  const r = spawnSync(npm, ['run', 'build:unpack'], { cwd: repoRoot, stdio: 'inherit', env: process.env })
  if (r.status !== 0) fail(`build:unpack 退出码 ${r.status}`)
}
const binary = packagedBinary()
log(`包:${binary}`)

// ② 起包
const store = mkdtempSync(path.join(tmpdir(), 'onething-gate-packaged-store-'))
const userData = mkdtempSync(path.join(tmpdir(), 'onething-gate-packaged-udd-'))
const cdpPort = 20000 + Math.floor(Math.random() * 20000)
const child = spawn(binary, [`--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`], {
  env: { ...process.env, ONETHING_STORE_PATH: store, ELECTRON_ENABLE_LOGGING: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let exited = null
child.on('exit', (code, signal) => { exited = { code, signal } })
const stderrTail = []
child.stderr.on('data', d => { stderrTail.push(String(d)); if (stderrTail.length > 40) stderrTail.shift() })

const discoveryPath = path.join(store, 'run', 'http.json')

async function cleanup() {
  if (!exited && child.pid) {
    try { child.kill('SIGTERM') } catch {}
    for (let i = 0; i < 100 && !exited; i++) await sleep(100)
    if (!exited) { try { child.kill('SIGKILL') } catch {} }
  }
  rmSync(store, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
}

try {
  // ③ 等发现文件
  log('③ 等 run/http.json')
  let record = null
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (exited) fail(`app 提前退出 code=${exited.code} signal=${exited.signal}\n${stderrTail.join('')}`)
    if (existsSync(discoveryPath)) {
      try { record = JSON.parse(readFileSync(discoveryPath, 'utf8')) } catch {}
      if (record?.port && record?.token) break
    }
    await sleep(250)
  }
  if (!record) {
    const agent = spawnSync('pgrep', ['-x', 'SecurityAgent'], { encoding: 'utf8' })
    if (agent.status === 0) {
      await cleanup()
      fail('25s 内 core 没起来,且 SecurityAgent 在跑 —— 是钥匙串授权框:打包出来的 app 是新签名身份,' +
        '需要**人手起一次并点「始终允许」**,之后再跑本门。(这不是回归,见文件头)', 3)
    }
    await cleanup()
    fail(`25s 内没见 ${discoveryPath}\n${stderrTail.join('')}`)
  }
  log(`core 起来了:http://${record.host}:${record.port} owner=${record.owner} pid=${record.pid}`)
  if (record.owner !== 'shell') fail(`owner 应为 shell(React 壳),读到 ${record.owner} —— 起的不是 React 壳`)
  if (record.pid !== child.pid) fail(`发现文件 pid ${record.pid} ≠ 起的进程 ${child.pid}`)

  // ④ 打 API
  const base = `http://${record.host}:${record.port}`
  const headers = { authorization: `Bearer ${record.token}`, 'content-type': 'application/json' }
  const caps = await fetch(`${base}/api/capabilities`, { headers })
  if (!caps.ok) fail(`/api/capabilities ${caps.status}`)
  const capsJson = await caps.json()
  log(`④ capabilities ok(${Object.keys(capsJson).length} 格)`)
  const rpc = await fetch(`${base}/api/rpc`, { method: 'POST', headers, body: JSON.stringify({ domain: 'sessions', method: 'list', payload: {} }) })
  if (!rpc.ok) fail(`/api/rpc ${rpc.status}`)
  const rpcJson = await rpc.json()
  if (!rpcJson || rpcJson.ok !== true) fail(`sessions.list 未 ok:${JSON.stringify(rpcJson).slice(0, 200)}`)
  log('④ rpc sessions.list ok')
  const unauth = await fetch(`${base}/api/capabilities`)
  if (unauth.status !== 401 && unauth.status !== 403) fail(`无 token 应被拒,读到 ${unauth.status}`)
  log('④ 无 token 被拒 ✓')

  /*
   * ④-b 检索索引(检索重建 S3b)。
   *
   * 这两条断言是 `electron-builder.yml` 里 `asarUnpack: search-worker.cjs` 那一行
   * **唯一**的证明:`worker_threads` 起的是 Node 的模块加载,不走 Electron 给 asar
   * 打的那层 fs 补丁,从 asar 里起线程不可靠 —— 没解包的话 Worker 起不来,宿主连崩
   * 两次之后 `status.mode` 就是 `'error'`。所以「打包了还能索引」这件事只有在这只
   * 真 .app 上才证得出来,本机的 typecheck / vitest / gate:search-index 都照不出。
   *
   * 第二条(pending 归零)顺带证「启动校对跑完了」:门用的是一个空的临时 store,
   * 账本零条,所以校对是一瞬间的事;10s 是给冷开的库建表留的余量。
   */
  const searchStatus = async () => {
    const response = await fetch(`${base}/api/rpc`, {
      method: 'POST', headers,
      body: JSON.stringify({ domain: 'search', method: 'status', payload: {} }),
    })
    if (!response.ok) fail(`/api/rpc search.status ${response.status}`)
    const body = await response.json()
    if (!body || body.ok !== true) fail(`search.status 未 ok:${JSON.stringify(body).slice(0, 200)}`)
    return body.data
  }
  const status = await searchStatus()
  if (status?.mode !== 'owner') {
    fail(`search.status.mode 应为 owner,读到 ${JSON.stringify(status)} —— `
      + 'Worker 起不来,多半是 search-worker.cjs 没被 asarUnpack 出来')
  }
  log(`④-b search.status.mode=owner ✓(pending=${status.pending})`)
  let settled = status
  for (let i = 0; i < 40 && settled.pending > 0; i++) {
    await sleep(250)
    settled = await searchStatus()
  }
  if (settled.pending !== 0) fail(`10s 内 search.status.pending 没归零(${settled.pending})`)
  log('④-b 索引 pending 归零 ✓')

  /*
   * ④-c 语义召回的扩展(检索重建 S7,`docs/design/search-index-2026-09.md` §15.2)。
   *
   * 两条断言,一起才成立:
   *  ① **开关关着**(拍点壬 a 的默认档)所以 `vector === 'off'` —— 打包 app 不许自作
   *     主张去下 110MB 模型,这一条守的正是「默认关」这件事本身;
   *  ② 可**扩展装得上**(`vectorExtension === 'loadable'`)—— 这是
   *     `electron-builder.yml` 里 `asarUnpack: sqlite-vec-*` 那几行的唯一证明:
   *     没解包的话 `loadExtension` 打不开 asar 里的路径,macOS 硬化运行时下未签名的
   *     dylib 也装不上,两种都会让这一格答 `'missing'`。
   *
   * 为什么不是「把开关打开再看 `vector === 'ready'`」(§15.5 原来写的那句):真 app 里
   * 没有假嵌入器,打开开关就等于让这道门去下模型 —— 门从此依赖网络,而且第一次跑要
   * 几分钟。**探针与开关分成两格**之后,漏解包这件事在默认档上就抓得到,比原来那句更早。
   *
   * 09-05 补一条**今天更强的理由**(拍点癸' (c),§13 留账一):打包桌面档**不带**
   * `@huggingface/transformers` 及它拖来的 onnxruntime / sharp(`electron-builder.yml`
   * 的 `files:` 排除了它们,app 因此从 498M 回到 146M),所以这台 app 上把开关打开也
   * 下不了模型 —— 它会 `ERR_MODULE_NOT_FOUND` → 优雅降级回 `'off'`。**这两条断言因此
   * 恰好就是 (c) 的现实**:运行时不在(`vector: 'off'`),而 sqlite-vec 这几百 KB 的
   * 纯 C 扩展留着并解包(`vectorExtension: 'loadable'`)。用户改拍 (a) / (b) 之后,
   * 这里要跟着升级成「真模型可装载」。
   */
  if (status?.vector !== 'off') {
    fail(`search.status.vector 默认应为 off(拍点壬 a),读到 ${JSON.stringify(status?.vector)}`)
  }
  if (settled.vectorExtension !== 'loadable') {
    fail(`search.status.vectorExtension 应为 loadable,读到 ${JSON.stringify(settled.vectorExtension)} —— `
      + 'sqlite-vec 的 vec0 没被 asarUnpack 出来,或硬化运行时下未签名装不上')
  }
  log('④-c 语义召回:开关默认关 ✓,sqlite-vec 扩展可装载 ✓')

  /*
   * ④-c 种一条消息,再从索引里搜出来 —— 「Worker 活着」与「Worker 真的在折账本」
   * 是两件事,前者由 ④-b 证,后者要有一条真消息走完 `user/message` → append 观察者
   * → enqueue → 折 → FTS 这条链。
   *
   * 这个临时 store 没有配 provider,发出去的那一轮**会在模型那一步失败** —— 不要紧:
   * 用户那条消息在派给 provider **之前**就已经落进 `events.jsonl` 了,而索引折的正是
   * 账本。所以这里只等消息可搜,不等回答。
   */
  const marker = `gatepackaged${Date.now().toString(36)}`
  const rpcCall = async (domain, method, payload) => {
    const response = await fetch(`${base}/api/rpc`, {
      method: 'POST', headers, body: JSON.stringify({ domain, method, payload }),
    })
    if (!response.ok) fail(`/api/rpc ${domain}.${method} ${response.status}`)
    const body = await response.json()
    if (!body || body.ok !== true) fail(`${domain}.${method} 未 ok:${JSON.stringify(body).slice(0, 200)}`)
    return body.data
  }
  const made = await rpcCall('sessions', 'create', { name: `gate ${marker}` })
  const sessionId = made?.session?.id
  if (!sessionId) fail(`sessions.create 没给出会话 id:${JSON.stringify(made).slice(0, 200)}`)
  await rpcCall('session-command', 'emit', {
    sessionId,
    command: { type: 'command:send-message', content: marker, suppressTitleGeneration: true },
  })
  let hits = []
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    const found = await rpcCall('search', 'query', { query: marker, category: 'messages', limit: 5 })
    hits = found?.results ?? []
    if (hits.length > 0) break
  }
  if (hits.length === 0) fail(`10s 内 search.query(messages, "${marker}") 一条都没命中 —— 索引没在折账本`)
  log(`④-c 刚发的消息搜得到 ✓(${hits.length} 条)`)

  // ⑤ CDP 窗口
  let pages = []
  for (let i = 0; i < 40; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json() } catch {}
    if (pages.some(p => p.type === 'page')) break
    await sleep(250)
  }
  const page = pages.find(p => p.type === 'page')
  if (!page) fail('CDP 没见到任何 page(窗口没开)')
  if (!/app\.asar.*index\.html|dist\/index\.html/.test(page.url)) fail(`page url 不是 asar 里的 index.html:${page.url}`)
  log(`⑤ 窗口在:${page.url}`)

  // ⑥ 退出
  child.kill('SIGTERM')
  for (let i = 0; i < 100 && !exited; i++) await sleep(100)
  if (!exited) fail('SIGTERM 10s 未退出')
  if (existsSync(discoveryPath)) fail('退出后 run/http.json 仍在')
  const leftovers = spawnSync('pgrep', ['-f', binary], { encoding: 'utf8' })
  if (leftovers.status === 0 && leftovers.stdout.trim()) fail(`残留进程:${leftovers.stdout.trim()}`)
  log(`⑥ 退出干净(code=${exited.code} signal=${exited.signal}),发现文件已删,零残留`)
  log('complete: GREEN')
} finally {
  await cleanup()
}
