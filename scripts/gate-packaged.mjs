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
 *   ③ 等 `<store>/run/http.json`(后端起来的唯一凭证)。第④步批 2b 起:`owner === 'backend'` 且
 *      `pid !== app pid` —— 写它的是 app 用自己的二进制 + `ELECTRON_RUN_AS_NODE` 拉起的后端子进程
 *      (这一条同时证了打包态 `RunAsNode` 保险丝开着、`backend.cjs` 被 asarUnpack 出来)
 *   ④ 用它的 token 打 `GET /api/capabilities` 与 `POST /api/rpc`(sessions.list)
 *   ⑤ CDP `GET /json` 断言至少一个 page 且 url 指向 asar 里的 index.html
 *   ⑥ SIGTERM app → 等退出 → 断言后端子进程也退了、`run/http.json` 已删、没有残留进程(缺省档:随 app 同停)
 *   ⑦「退出后继续运行」档(第④步批 2b,`--no-keep-running` 跳过):经 `settings` 域把
 *      `general.backendKeepRunningAfterQuit` 打开 → 起 app、退 app → 断言后端还活着、发现文件还在 → 再起 app →
 *      断言它**没有**再拉一个(发现文件 pid 不变、同一只二进制的后端进程只有一个)→ 退 app → 直接 SIGTERM 后端收尾
 *
 * 离屏:子进程带 `ONETHING_GATE_HEADLESS=1`(窗不 `show()`、不进 Dock,页面照样加载,CDP 照样看得见 page)——
 * 这道门开的是真 app,但不抢用户的前台。
 *
 * ── 钥匙串那一格(必读)────────────────────────────────────────────────────
 * 打包出来的 app 是一个**新的代码签名身份**;`safeStorage` 是绑身份的 Keychain 门面,
 * 首次启动可能等待系统授权。本门在 ③ 超时且检测到 SecurityAgent 时以 3 退出，
 * 提示人工检查；这个全局进程检测不能证明对话框属于本次子进程，也不能排除回归。
 * 所有失败路径都先等待隔离子进程退出，再删除测试目录；不以 process.exit 跳过清理。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const noBuild = process.argv.includes('--no-build')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function log(line) { process.stdout.write(`[gate:packaged] ${line}\n`) }
function fail(line, code = 1) { throw Object.assign(new Error(line), { exitCode: code }) }
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

/** 起一次包(⑦ 用):与 ② 同一份环境,交回进程与「退了没有」。 */
function launchApp(binary, store, userData) {
  const app = spawn(binary, [`--user-data-dir=${userData}`], {
    env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_CREDENTIALS_KEYRING: 'file', ELECTRON_ENABLE_LOGGING: '0', ONETHING_GATE_HEADLESS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { exited: null }
  app.stdout.on('data', () => {})
  app.stderr.on('data', () => {})
  const exitedPromise = new Promise(resolve => app.once('exit', (code, signal) => { state.exited = { code, signal }; resolve() }))
  return { app, state, exitedPromise }
}

async function waitDiscovery(store, ms, predicate = () => true) {
  const file = path.join(store, 'run', 'http.json')
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'))
      if (record?.port && record?.token && predicate(record)) return record
    } catch {}
    await sleep(250)
  }
  return null
}

/**
 * ⑦「退出后继续运行」档。起两次 app、一台后端:第一次起 app → 打开开关 → 退 app → 后端留着;第二次起 app →
 * 借那一台(pid 不变、后端进程只有一个)→ 退 app → 门自己 SIGTERM 后端收尾。全在 ② 那间临时 store 上。
 */
async function keepRunningLeg({ binary, store, userData, headers }) {
  const pidAliveHere = pid => { try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' } }
  const first = launchApp(binary, store, userData)
  let backendPid
  try {
    const record = await waitDiscovery(store, 25_000, r => r.owner === 'backend')
    if (!record) fail('⑦ 第一次起 app:25s 内没见后端的发现文件')
    backendPid = record.pid
    const base = `http://${record.host}:${record.port}`
    const call = async (domain, method, payload) => {
      const response = await fetch(`${base}/api/rpc`, { method: 'POST', headers: headers(record.token), body: JSON.stringify({ domain, method, payload }) })
      const body = await response.json()
      if (!body?.ok) fail(`⑦ ${domain}.${method} 未 ok:${JSON.stringify(body).slice(0, 200)}`)
      return body.data
    }
    const current = await call('settings', 'getSettings', {})
    const saved = await call('settings', 'saveSettings', { ...current.settings, general: { ...current.settings.general, backendKeepRunningAfterQuit: true } })
    if (saved?.settings?.general?.backendKeepRunningAfterQuit !== true) fail('⑦ 开关没存上')
    // 主进程那台客户端经 settings:changed 重读设置;给它一拍再退。
    await sleep(1500)
    first.app.kill('SIGTERM')
    await Promise.race([first.exitedPromise, sleep(10_000)])
    if (!first.state.exited) fail('⑦ 第一次 app SIGTERM 10s 未退出')
    await sleep(1000)
    if (!pidAliveHere(backendPid)) fail(`⑦ 开着「继续运行」退 app 之后后端 ${backendPid} 不在了`)
    if (!existsSync(path.join(store, 'run', 'http.json'))) fail('⑦ 开着「继续运行」退 app 之后发现文件没了')
    log(`⑦ 退 app 之后后端还活着(pid ${backendPid}),发现文件还在 ✓`)
  } finally {
    if (!first.state.exited) try { first.app.kill('SIGKILL') } catch {}
  }

  // 「有没有再拉一个」的两条读数:每次拉起都会截断重写 `run/backend-stdio.log`(看它的 mtime),
  // 主进程的 `shell.jsonl` 里借到一台会记一行 `adopted a live backend`。不数进程:后端改了进程名,
  // 而且用户自己开着的桌面也是同一只二进制。
  const stdioLog = path.join(store, 'run', 'backend-stdio.log')
  const stdioBefore = existsSync(stdioLog) ? statSync(stdioLog).mtimeMs : 0
  const second = launchApp(binary, store, userData)
  try {
    // 给第二次起的 app 足够的时间去「借」或者(错误地)拉第二台。
    await sleep(8_000)
    const record = await waitDiscovery(store, 5_000)
    if (!record || record.pid !== backendPid) fail(`⑦ 第二次起 app 后发现文件 pid 变了:${record?.pid} ≠ ${backendPid}`)
    if ((existsSync(stdioLog) ? statSync(stdioLog).mtimeMs : 0) !== stdioBefore) fail('⑦ 第二次起 app 又拉了一台后端(backend-stdio.log 被重写了)')
    second.app.kill('SIGTERM')
    await Promise.race([second.exitedPromise, sleep(10_000)])
    if (!second.state.exited) fail('⑦ 第二次 app SIGTERM 10s 未退出')
    const shellLog = path.join(store, 'log', 'shell.jsonl')
    const adopted = existsSync(shellLog) && readFileSync(shellLog, 'utf8').includes('adopted a live backend')
    if (!adopted) fail('⑦ shell.jsonl 里没有「adopted a live backend」那一行')
    log('⑦ 第二次起 app:借了那一台(pid 不变、没有重写 stdio 文件、shell.jsonl 记着借),没有再拉一个 ✓')
  } finally {
    if (!second.state.exited) try { second.app.kill('SIGKILL') } catch {}
    if (backendPid && pidAliveHere(backendPid)) {
      try { process.kill(backendPid, 'SIGTERM') } catch {}
      for (let i = 0; i < 80 && pidAliveHere(backendPid); i++) await sleep(100)
      if (pidAliveHere(backendPid)) try { process.kill(backendPid, 'SIGKILL') } catch {}
    }
  }
  if (existsSync(path.join(store, 'run', 'http.json'))) fail('⑦ SIGTERM 后端之后发现文件仍在')
  log('⑦ 门 SIGTERM 后端收尾,发现文件已删 ✓')
}

async function main() {
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
  env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_CREDENTIALS_KEYRING: 'file', ELECTRON_ENABLE_LOGGING: '0', ONETHING_GATE_HEADLESS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let exited = null
const exitPromise = new Promise(resolve => {
  child.once('exit', (code, signal) => { exited = { code, signal }; resolve() })
  child.once('error', error => { exited = { code: 1, signal: null, error: error.message }; resolve() })
})
let stderrTail = ''
let stdoutTail = ''
child.stderr.on('data', d => { stderrTail = (stderrTail + String(d)).slice(-16384) })
// Always consume both pipes: the probe itself must not stall app startup by
// leaving stdout unread. Bounded tails remain available on every failure path.
child.stdout.on('data', d => { stdoutTail = (stdoutTail + String(d)).slice(-16384) })
const startupDiagnostics = () => `stdout:\n${stdoutTail}\nstderr:\n${stderrTail}`

const discoveryPath = path.join(store, 'run', 'http.json')

/** 这间临时 store 里的后端子进程(③ 记下;收尸时只收它 —— 发现文件里、这间 store 的那一台)。 */
const backendPids = new Set()
const pidAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' } }

async function cleanup() {
  for (const pid of backendPids) {
    if (!pidAlive(pid)) continue
    try { process.kill(pid, 'SIGTERM') } catch {}
    for (let i = 0; i < 80 && pidAlive(pid); i++) await sleep(100)
    if (pidAlive(pid)) try { process.kill(pid, 'SIGKILL') } catch {}
  }
  if (!exited && child.pid) {
    try { child.kill('SIGTERM') } catch {}
    for (let i = 0; i < 100 && !exited; i++) await sleep(100)
    if (!exited) {
      try { child.kill('SIGKILL') } catch {}
      await Promise.race([exitPromise, sleep(5000)])
    }
  }
  if (!exited) fail(`验收子进程仍未退出，保留隔离目录用于诊断:${store}`)
  rmSync(store, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
}

try {
  // ③ 等发现文件
  log('③ 等 run/http.json')
  let record = null
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (exited) fail(`app 提前退出 code=${exited.code} signal=${exited.signal}\n${startupDiagnostics()}`)
    if (existsSync(discoveryPath)) {
      try { record = JSON.parse(readFileSync(discoveryPath, 'utf8')) } catch {}
      if (record?.port && record?.token) break
    }
    await sleep(250)
  }
  if (!record) {
    const agent = spawnSync('pgrep', ['-x', 'SecurityAgent'], { encoding: 'utf8' })
    if (agent.status === 0) {
      fail('25s 内 core 没起来，且检测到 SecurityAgent。新签名应用可能在等待钥匙串授权；' +
        `需人工检查首次启动，不能仅凭此检测排除其他启动问题。\n${startupDiagnostics()}`, 3)
    }
    fail(`25s 内没见 ${discoveryPath}\n${startupDiagnostics()}`)
  }
  log(`core 起来了:http://${record.host}:${record.port} owner=${record.owner} pid=${record.pid}`)
  if (record.owner !== 'backend') fail(`owner 应为 backend(app 拉起的后端子进程),读到 ${record.owner}`)
  if (record.pid === child.pid) fail(`发现文件 pid ${record.pid} 就是 app 自己 —— 后端应在另一个进程里`)
  backendPids.add(record.pid)
  log(`③ 后端是另一个进程 ✓(app pid ${child.pid},后端 pid ${record.pid})`)

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
  for (let i = 0; i < 80 && pidAlive(record.pid); i++) await sleep(100)
  if (pidAlive(record.pid)) fail(`app 退了,后端子进程 ${record.pid} 8s 内没跟着退(缺省档应随 app 同停)`)
  if (existsSync(discoveryPath)) fail('退出后 run/http.json 仍在')
  const leftovers = spawnSync('pgrep', ['-f', binary], { encoding: 'utf8' })
  if (leftovers.status === 0 && leftovers.stdout.trim()) fail(`残留进程:${leftovers.stdout.trim()}`)
  log(`⑥ 退出干净(code=${exited.code} signal=${exited.signal}),后端子进程跟着退了,发现文件已删,零残留`)

  if (!process.argv.includes('--no-keep-running')) await keepRunningLeg({ binary, store, userData, headers: (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' }) })
  log('complete: GREEN')
} finally {
  await cleanup()
}
}

void main().catch(error => {
  process.stderr.write(`[gate:packaged] FAIL: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1
})
