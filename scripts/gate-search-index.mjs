#!/usr/bin/env node
/**
 * `bun run gate:search-index` —— 检索索引的真机门(检索重建 S3b 立骨架,S3c 补
 * 事件循环延迟与 parity-B;`docs/design/search-index-2026-09.md` §10 S3 行)。
 *
 * 它证的是**产物**:`dist/server/main.js` 起在一间临时 store 上,索引 Worker
 * (`dist/server/search-worker.cjs`)真的被 `worker_threads` 起了起来、真的在折账本。
 * 单测里的 Worker 是同线程的 `MessageChannel`(S3a 的手法),那条路证不了这一件。
 *
 * 四条:
 *   ① `search.status` → `mode: 'owner'`(起不来就是 `'error'`)
 *   ② 发一条消息(假 provider 回一段固定文本)→ 1s 内 messages 档搜得到**用户那句**
 *      与**助手那段**(这条走的是完整链:`user/message` / `run/end` → append 观察者
 *      → enqueue → 折 → FTS)
 *   ③ chats 档按标题命中(标题来自 `meta.json`,不是账本 —— 拍点甲 b 的那一路)
 *   ④ 杀进程 → `<store>/index/search.v1.sqlite` 在、`run/http.json` 已删、零残留进程
 *
 * **必须用 node 起,不许 `bun scripts/gate-search-index.mjs`**:bun 的运行时没有
 * `node:sqlite`(§13 留账实测「No such built-in module」),索引在它下面根本开不了库。
 *
 * 绝不碰真 `~/.onething` —— 全程 `ONETHING_STORE_PATH` 指向 mkdtemp 出来的临时目录。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAKE_PROVIDER_ENV, fakeProviderAiSettings, startFakeProvider } from './lib/gate-fake-provider.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const workerEntry = path.join(repoRoot, 'dist/server/search-worker.cjs')

const MOCK_PORT = 34821
/** 假 provider 回的整段话 —— 里面那个词是③要搜的。 */
const REPLY_TEXT = '索引这件事我记下了:身份牌已经私发四人了。'
/** 用户那句里的记号(随机,免得撞上库里别的东西)。 */
const MARKER = `gatesearch${Date.now().toString(36)}`
const SESSION_NAME = `索引门 ${MARKER}`

const failures = []
let child
let mock

function check(condition, message) {
  if (condition) console.log(`  ok   ${message}`)
  else {
    failures.push(message)
    console.error(`  FAIL ${message}`)
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitForDiscovery(storePath, timeoutMs = 30_000) {
  const discoveryFile = path.join(storePath, 'run', 'http.json')
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(discoveryFile)) {
      try {
        const discovery = JSON.parse(fs.readFileSync(discoveryFile, 'utf-8'))
        if (discovery?.port) return discovery
      } catch {
        // 半写状态,下一拍再读。
      }
    }
    await sleep(200)
  }
  throw new Error('server did not publish its discovery file in time')
}

for (const [label, file] of [['dist/server/main.js', serverEntry], ['dist/server/search-worker.cjs', workerEntry]]) {
  if (!fs.existsSync(file)) {
    console.error(`[gate:search-index] 缺 ${label} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
}

const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-index-gate-'))

try {
  console.log(`[gate:search-index] temp store: ${storePath}`)
  mock = await startFakeProvider(MOCK_PORT, REPLY_TEXT)
  fs.writeFileSync(path.join(storePath, 'settings.json'), JSON.stringify({
    ai: fakeProviderAiSettings(MOCK_PORT),
    tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
    diagnostics: { enabled: false },
  }, null, 2))

  child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...FAKE_PROVIDER_ENV,
      ONETHING_STORE_PATH: storePath,
      ONETHING_SERVER_DATA_ROOT: storePath,
      ONETHING_SERVER_HOST: '127.0.0.1',
      ONETHING_SERVER_PORT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const serverOut = []
  child.stdout.on('data', chunk => serverOut.push(chunk.toString()))
  child.stderr.on('data', chunk => serverOut.push(chunk.toString()))

  const discovery = await waitForDiscovery(storePath)
  const base = `http://127.0.0.1:${discovery.port}`
  const headers = {
    'content-type': 'application/json',
    ...(discovery.token ? { authorization: `Bearer ${discovery.token}` } : {}),
  }

  const rpc = async (domain, method, payload = {}) => {
    const response = await fetch(`${base}/api/rpc`, {
      method: 'POST', headers, body: JSON.stringify({ domain, method, payload }),
    })
    if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
    const body = await response.json()
    if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method}: ${JSON.stringify(body?.error ?? body)}`)
    return body.data
  }

  // ── ① Worker 起来了 ────────────────────────────────────────────────
  const status = await rpc('search', 'status')
  check(status?.mode === 'owner',
    `① search.status.mode = owner(读到 ${JSON.stringify(status)})`)

  // ── ② 发一条消息,两句都搜得到 ────────────────────────────────────
  const made = await rpc('sessions', 'create', { name: SESSION_NAME })
  const sessionId = made?.session?.id
  if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(made)}`)

  await rpc('session-command', 'emit', {
    sessionId,
    command: {
      type: 'command:send-message',
      content: `${MARKER} 身份牌已经私发四人了`,
      suppressTitleGeneration: true,
    },
  })

  /** 等到命中或超时。返回真正等了多久 —— 读数进报告。 */
  const waitForHit = async (query, category, predicate, budgetMs) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < budgetMs) {
      const found = await rpc('search', 'query', { query, category, limit: 10 })
      const hit = (found?.results ?? []).find(predicate)
      if (hit) return { hit, ms: Date.now() - startedAt, index: found.index }
      await sleep(100)
    }
    return { hit: undefined, ms: Date.now() - startedAt, index: undefined }
  }

  /*
   * 用户那句:`user/message` 一落盘就该可搜(§5.2「用户消息一到就可搜」)。
   *
   * **预算 400ms 是判据的一部分,不是宽限**。索引有两条路听得见一条新消息:
   * 进程内的 append 观察者(§5.3,毫秒级)与 Worker 里的目录监视(§5.2,为了另一个
   * 进程写的账本,`DIRECTORY_WATCH_DEBOUNCE_MS = 500` 是它的**地板**)。给 5 秒的话
   * 两条路都过得去 —— 这道门就照不出「观察者被摘掉了」,而那正是它该照的东西。
   * 400 卡在中间:观察者那条实测 81 / 135 / 135ms,目录监视那条实测 781ms
   * (2026-09-05 三趟 + 一次摘掉观察者的反证)。
   */
  const APPEND_OBSERVER_BUDGET_MS = 400
  const user = await waitForHit(MARKER, 'messages', result => result.sessionId === sessionId,
    APPEND_OBSERVER_BUDGET_MS)
  check(user.hit !== undefined,
    `② 用户那句 ${user.ms}ms 内搜得到(预算 ${APPEND_OBSERVER_BUDGET_MS}ms = 走的是 append 观察者那条路,`
    + `不是 ${500}ms 起步的目录监视;记号 ${MARKER})`)
  if (user.index !== undefined) {
    console.log(`  info 响应带 index 那一格:${JSON.stringify(user.index)}`)
  }

  // 助手那段:要等 `run/end`(流式中不搜半条),所以预算给到 15s(假 provider
  // 自己要 ~100ms,其余是模型轮 + 折的时间)。
  const assistant = await waitForHit('私发', 'messages',
    result => result.sessionId === sessionId && result.detail === 'Assistant message', 15_000)
  check(assistant.hit !== undefined, `② 助手那段 ${assistant.ms}ms 内搜得到(run/end 之后才建文档)`)

  // ── ③ chats 档按标题命中 ──────────────────────────────────────────
  const chat = await waitForHit(MARKER, 'chats', result => result.sessionId === sessionId, 5_000)
  check(chat.hit !== undefined, `③ chats 档按标题命中 ${chat.ms}ms(标题来自 meta.json,不是账本)`)

  const indexPath = path.join(storePath, 'index', 'search.v1.sqlite')
  const sizeKiB = fs.existsSync(indexPath) ? (fs.statSync(indexPath).size / 1024).toFixed(1) : '?'
  console.log(`  info 库:${indexPath} ${sizeKiB} KiB`)

  // ── ④ 退干净 ──────────────────────────────────────────────────────
  child.kill('SIGTERM')
  for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i += 1) await sleep(100)
  const exited = child.exitCode !== null || child.signalCode !== null
  check(exited, '④ SIGTERM 10s 内退出')
  check(fs.existsSync(indexPath), `④ 索引库还在(${path.relative(storePath, indexPath)})`)
  check(!fs.existsSync(path.join(storePath, 'run', 'http.json')), '④ run/http.json 已删')
  // 模式用**绝对路径**:同一台机器上可能有别的检出 / worktree 也在跑一份
  // `dist/server/main.js`,`pgrep -f 'dist/server/main.js'` 会把它们一起数进来
  // (施工时真踩到:隔壁 worktree 的 server 让这一条红了)。
  const leftovers = spawnSync('pgrep', ['-f', serverEntry], { encoding: 'utf-8' })
  check(!(leftovers.status === 0 && leftovers.stdout.trim()),
    `④ 零残留进程${leftovers.stdout.trim() ? `(见到 ${leftovers.stdout.trim()})` : ''}`)

  if (failures.length > 0) console.error(`[gate:search-index] server 输出尾:\n${serverOut.slice(-40).join('')}`)
} catch (error) {
  failures.push(String(error?.stack || error))
  console.error(`[gate:search-index] ${error?.stack || error}`)
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await sleep(800)
    try { child.kill('SIGKILL') } catch { /* 已经没了就算了 */ }
  }
  if (mock) mock.close()
  fs.rmSync(storePath, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`[gate:search-index] ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('[gate:search-index] ok')
