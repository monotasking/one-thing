#!/usr/bin/env node
/**
 * `bun run gate:search-index` —— 检索索引的真机门(检索重建 S3b 立骨架,S3c 补
 * 事件循环延迟与 parity-B;`docs/design/search-index-2026-09.md` §10 S3 行)。
 *
 * 它证的是**产物**:`dist/server/main.js` 起在一间临时 store 上,索引 Worker
 * (`dist/server/search-worker.cjs`)真的被 `worker_threads` 起了起来、真的在折账本。
 * 单测里的 Worker 是同线程的 `MessageChannel`(S3a 的手法),那条路证不了这一件。
 *
 * 七条(①–④ S3b,⑤–⑦ S3c):
 *   ① `search.status` → `mode: 'owner'`(起不来就是 `'error'`)
 *   ② 发一条消息(假 provider 回一段固定文本)→ 1s 内 messages 档搜得到**用户那句**
 *      与**助手那段**(这条走的是完整链:`user/message` / `run/end` → append 观察者
 *      → enqueue → 折 → FTS)
 *   ③ chats 档按标题命中(标题来自 `meta.json`,不是账本 —— 拍点甲 b 的那一路)
 *   ④ 杀进程 → `<store>/index/search.v1.sqlite` 在、`run/http.json` 已删、零残留进程
 *   ⑤ **主线程事件循环延迟**(§5.3 末句),四小条:
 *      ⑤a 300 会话 × 30 条消息(含 10 条 > 64KB)的**冷建全程** p99 < 20ms
 *      ⑤b 随后**连发 20 条消息**(假 provider)期间 p99 < 20ms —— 这一段的线不是 5ms,
 *          理由是量出来的控制组读数,写在 ⑤b 那段注释里
 *      ⑤c **只有折**的窗口(子进程往 40 间已种会话各追加一条,其中 8 条 > 64KB,
 *          由目录监视触发整键重折)p99 < 5ms —— §5.3 那条线真正住的地方
 *      ⑤d 结构判据:主线程那一侧零 `node:sqlite` import(见下)
 *   ⑥ **改名 / 归档 / 删除各一例经 feed 生效**(§5.2 拍点甲 b:这三件不走账本,
 *      靠 `metaRev` 指纹与总线):改名后按新标题命中、旧标题不命中;归档后结果带
 *      `archived` facet(拍点丙 a 的可感知变化);删除后 messages / chats 都不命中
 *   ⑦ **另一个进程写的账本**:门自己起一个 `node` 子进程往某间会话的 `events.jsonl`
 *      追加一条 `user/message` —— 进程内的 append 观察者对它一无所知,能把它折进去的
 *      只有 Worker 里的目录监视(§5.2 / §5.6)
 *   ⑧ **语义召回整条链**(S7,§15):开关打开(设置里那一格,`modelId` 由
 *      `ONETHING_SEARCH_EMBEDDER=fake` 换成确定性的假嵌入器 —— 门不下 110MB 模型)
 *      → `status.vector` 走过 downloading / embedding 到 `'ready'` → 黄金复述集里
 *      的一条**改写句**经 HTTP 命中那条消息。假嵌入器证的是**链路**不是模型
 *      (`packages/core/search/__tests__/fixtures/paraphrase.json` 的头注写着这句)。
 *
 * ## ⑤ 的量法:`--require` 预加载探针 + SIGUSR2
 *
 * 被测进程用 `node --require scripts/lib/gate-loop-probe.cjs dist/server/main.js` 起,
 * 探针在**产品代码之前**装一只真的 `monitorEventLoopDelay`;门发 `SIGUSR2`,探针把
 * 直方图写进 `ONETHING_GATE_LOOP_OUT` 指的文件再 reset。**产品代码一个字没动**,
 * 契约上也没有为门而生的格子。派工单给的两条路各自的下场记在探针文件头里
 * (CDP 那条实测走不通:`Runtime.evaluate` 里 `await import('node:perf_hooks')` 抛
 * `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`)。
 *
 * **反证**:派工单说的「把 `ONETHING_SEARCH_WORKER` 指到不存在的路径」**不是**这一条
 * 的反证 —— 那走的是「索引不可用」那条支,三档答零结果,量到的是一条闲着的主线程。
 * 真反证是把 SqliteIndex 的整键重折搬回主线程,而那要动产品代码 —— **⑤c 就是为它
 * 立的那条线**:那个窗口里除了折没有别的事,折一搬过来必红。除此之外门里还有一条
 * **结构判据**(⑤d):`packages/backend/**` 与 `packages/onething-runtime/src/search/`
 * 的 `service.ts` / `capabilities/**` 里**零 `node:sqlite` import** —— 主线程这一侧
 * 碰不到 sqlite 是结构保证的,而不是靠这次跑出来的读数运气好。
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
import { seedLedger } from './lib/gate-seed-ledger.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const workerEntry = path.join(repoRoot, 'dist/server/search-worker.cjs')
/** 「另一个进程」的入口:⑦ 与 ⑤c 都靠它往账本尾巴上追加事件。 */
const seeder = path.join(repoRoot, 'scripts/lib/gate-seed-ledger.mjs')

const MOCK_PORT = 34821
/** 假 provider 回的整段话 —— 里面那个词是③要搜的。 */
const REPLY_TEXT = '索引这件事我记下了:身份牌已经私发四人了。'
/**
 * 记号:**只用小写字母**,随机八位。
 *
 * 「只用字母」不是洁癖,是两次真机红换来的:分析器会把一个 latin 词按 camel / 数字
 * 边界**拆成小段**再一起进倒排(`gatesearchmtnc9l8l` → `gatesearch` / `mtnc` / `9` /
 * `l` / `8` / `l`),而放宽阶梯的 ③④ 级数的就是这些小段。于是
 *  - 带时间戳的两个记号(同一毫秒生成)会共享 `mtnc9l8l` 那几段,
 *  - 一个记号加后缀当另一个记号,前缀匹配直接就中,
 * 两种写法都会让 ⑥ 的「旧标题**不再**命中」永远红 —— 红的是记号,不是产品。
 * 纯字母且互不相交的两个记号没有这个问题。
 */
const letters = count => Array.from({ length: count },
  () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')
/** 用户那句里的记号(随机,免得撞上库里别的东西)。 */
const MARKER = `gatesearch${letters(8)}`
const SESSION_NAME = `索引门 ${MARKER}`
/** ⑥ 改名之后的标题里那个记号 —— 与 `MARKER` 一段都不共享(见上)。 */
const RENAME_MARKER = `gaterenamed${letters(8)}`

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

/** 一份发现记录 → 一只 `POST /api/rpc` 调用器(两段现场共用)。 */
function createRpc(discovery) {
  const base = `http://127.0.0.1:${discovery.port}`
  const headers = {
    'content-type': 'application/json',
    ...(discovery.token ? { authorization: `Bearer ${discovery.token}` } : {}),
  }
  return async (domain, method, payload = {}) => {
    const response = await fetch(`${base}/api/rpc`, {
      method: 'POST', headers, body: JSON.stringify({ domain, method, payload }),
    })
    if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
    const body = await response.json()
    if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method}: ${JSON.stringify(body?.error ?? body)}`)
    return body.data
  }
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
  const rpc = createRpc(discovery)

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

  /*
   * ── ⑦ 另一个进程写的账本 ─────────────────────────────────────────
   *
   * 起一个 `node` 子进程往这间会话的 `events.jsonl` 尾巴上追加一条 `user/message`。
   * server 进程内的 append 观察者(§5.3)对这一条**一无所知** —— 它只听得见本进程
   * 自己的写。能把它折进索引的只有 Worker 里的目录监视(§5.2 / §5.6 「读者写的
   * 消息要绕一圈目录监视」),所以这一条证的正是那条路还活着。
   *
   * 预算 3s:`DIRECTORY_WATCH_DEBOUNCE_MS = 500` 是地板,真机实测在它上面还要加
   * 一次整键重折。**故意比 ② 的 400ms 宽** —— 两条路的时间尺度本来就不同,而 ②
   * 那条紧预算的意义正是把它们分开。
   */
  const externalMarker = `${MARKER}external`
  const appended = spawnSync('node', [seeder, 'append', storePath, sessionId,
    `${externalMarker} 另一个进程写进来的一句`, `${externalMarker}-msg`], { encoding: 'utf-8' })
  check(appended.status === 0,
    `⑦ 子进程追加事件成功(seq ${appended.stdout?.trim()}${appended.status === 0 ? '' : `;stderr ${appended.stderr}`})`)
  const external = await waitForHit(externalMarker, 'messages',
    result => result.sessionId === sessionId, 3_000)
  check(external.hit !== undefined,
    `⑦ 另一个进程写的那句 ${external.ms}ms 内搜得到(走的是目录监视,不是 append 观察者)`)

  /*
   * ── ⑥ 改名 / 归档 / 删除各一例经 feed 生效 ───────────────────────
   *
   * 这三件**不在账本里**(拍点甲 b:索引不加账本事件),靠 `LedgerFeed` 的指纹
   * `${lastSeq}:${metaMtimeMs}` 与总线的 `session:renamed` / `session:deleted`。所以
   * 这一条走的是 RPC 的真写面(`sessions.rename` / `.updateArchived` / `.delete`),
   * 不是直接改文件。
   */
  const RENAMED = `索引门改名 ${RENAME_MARKER}`
  await rpc('sessions', 'rename', { sessionId, newName: RENAMED })
  const renamed = await waitForHit(RENAME_MARKER, 'chats',
    result => result.sessionId === sessionId, 3_000)
  check(renamed.hit !== undefined, `⑥ 改名后按新标题命中 ${renamed.ms}ms`)
  const oldTitle = await rpc('search', 'query', { query: MARKER, category: 'chats', limit: 20 })
  check(!(oldTitle?.results ?? []).some(result => result?.sessionId === sessionId),
    '⑥ 旧标题不再命中(整键替换,不是往上叠)')

  /*
   * 归档:拍点丙 (a) 定的可感知变化 —— 旧 `searchChats` 有一句
   * `.filter(s => !s.isArchived)`,索引照建文档并把 `archived` 摆成一格 facet。
   * 门断言的是**新行为**:缺省过滤下**照样搜得到**,而且那一条带着徽。
   */
  await rpc('sessions', 'updateArchived', { sessionId, isArchived: true })
  const archived = await waitForHit(RENAME_MARKER, 'chats',
    result => result.sessionId === sessionId && result.facets?.archived === true, 3_000)
  check(archived.hit !== undefined,
    `⑥ 归档后仍然搜得到、且带 archived facet ${archived.ms}ms(拍点丙 a;旧扫描是直接跳过)`)

  await rpc('sessions', 'delete', { sessionId })
  const gone = async (query, category) => {
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      const found = await rpc('search', 'query', { query, category, limit: 20 })
      if (!(found?.results ?? []).some(result => result?.sessionId === sessionId)) {
        return Date.now() - (deadline - 3_000)
      }
      await sleep(100)
    }
    return undefined
  }
  const goneMessages = await gone(MARKER, 'messages')
  check(goneMessages !== undefined, `⑥ 删除后 messages 档不再命中(${goneMessages}ms;墓碑那一路)`)
  const goneChats = await gone(RENAME_MARKER, 'chats')
  check(goneChats !== undefined, `⑥ 删除后 chats 档不再命中(${goneChats}ms)`)

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

/* ═══════════════════ ⑤ 事件循环延迟(自己的一间 store、自己的一条 server)═══════════
 *
 * 为什么**另起一条**而不是并进上面那一条:①②③ 的判据里有一个 400ms 的紧预算
 * (「走的是 append 观察者不是目录监视」),而这一条要的现场是 300 会话 × 30 条消息
 * 的冷建 —— 把两者塞进同一个进程,那个紧预算就会因为一间大得多的 store 而变得说不清
 * 是在守什么。两条 server、两间临时 store,各守各的。
 */
await runLoopDelayPhase()
await runSemanticPhase()

if (failures.length > 0) {
  console.error(`[gate:search-index] ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('[gate:search-index] ok')

async function runLoopDelayPhase() {
  const storeB = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-loop-gate-'))
  const readingPath = path.join(storeB, 'loop-delay.json')
  let server
  let provider
  try {
    console.log(`[gate:search-index] ⑤ temp store: ${storeB}`)

    // ── ⑤d 结构判据(见文件头「反证」)──────────────────────────────
    const sqliteHits = spawnSync('grep', ['-rln', "node:sqlite",
      path.join(repoRoot, 'packages/backend'),
      path.join(repoRoot, 'packages/onething-runtime/src/search/service.ts'),
      path.join(repoRoot, 'packages/onething-runtime/src/search/capabilities'),
    ], { encoding: 'utf-8' })
    // grep 没命中时退出码是 1;命中了才有 stdout。
    const offenders = (sqliteHits.stdout ?? '').trim()
    check(offenders.length === 0,
      `⑤d 主线程那一侧零 node:sqlite import${offenders ? `(见到 ${offenders.replace(/\n/g, ', ')})` : ''}`)

    /*
     * ⑤d(S7 补):**嵌入运行时也不许出现在主线程那一侧**。
     *
     * ⑤a–⑤c 三个窗口跑的是**开关关着**的默认档,所以它们量不到嵌入 —— 「嵌入搬回
     * 主线程」这条反证在那三个窗口上照不出来。能照出来的是结构:
     * `@huggingface/transformers` 只许出现在 `search/embedding/transformers-wasm.ts`
     * 一个文件里(而且是**动态** import),`packages/backend/**` 与主线程那一侧的
     * 检索代码里一次都不许出现。把它 import 到主线程 = 这一条当场红。
     */
    const wasmHits = spawnSync('grep', ['-rln', '@huggingface/transformers',
      path.join(repoRoot, 'packages/backend'),
      path.join(repoRoot, 'packages/core'),
      path.join(repoRoot, 'packages/onething-runtime/src/search/service.ts'),
      path.join(repoRoot, 'packages/onething-runtime/src/search/capabilities'),
      path.join(repoRoot, 'apps/desktop-react/electron'),
    ], { encoding: 'utf-8' })
    const wasmOffenders = (wasmHits.stdout ?? '').trim()
    check(wasmOffenders.length === 0,
      `⑤d 主线程那一侧零 @huggingface/transformers import`
      + `${wasmOffenders ? `(见到 ${wasmOffenders.replace(/\n/g, ', ')})` : ''}`)

    // ── 种账本:300 会话 × 30 条消息,含 10 条 > 64KB 的正文 ────────
    const corpus = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'packages/core/search/__tests__/fixtures/corpus.json'), 'utf-8'))
    const seedStartedAt = Date.now()
    const seeded = seedLedger({ storePath: storeB, sessions: 300, messagesPerSession: 30, corpus })
    console.log(`  info 种了 ${seeded.sessions} 间 × ${seeded.messages / seeded.sessions} 条 = `
      + `${seeded.messages} 条消息(${(seeded.bytes / 1048576).toFixed(1)} MiB,含 ${seeded.longMessages} 条 > 64KB),`
      + `耗时 ${Date.now() - seedStartedAt}ms`)

    provider = await startFakeProvider(MOCK_PORT + 1, REPLY_TEXT)
    fs.writeFileSync(path.join(storeB, 'settings.json'), JSON.stringify({
      ai: fakeProviderAiSettings(MOCK_PORT + 1),
      tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
      diagnostics: { enabled: false },
    }, null, 2))

    server = spawn('node', ['--require', path.join(repoRoot, 'scripts/lib/gate-loop-probe.cjs'), serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...FAKE_PROVIDER_ENV,
        ONETHING_STORE_PATH: storeB,
        ONETHING_SERVER_DATA_ROOT: storeB,
        ONETHING_SERVER_HOST: '127.0.0.1',
        ONETHING_SERVER_PORT: '',
        ONETHING_GATE_LOOP_OUT: readingPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverOutB = []
    server.stdout.on('data', chunk => serverOutB.push(chunk.toString()))
    server.stderr.on('data', chunk => serverOutB.push(chunk.toString()))

    const coldStartedAt = Date.now()
    const discovery = await waitForDiscovery(storeB, 60_000)
    const rpc = createRpc(discovery)

    /** SIGUSR2 → 探针落盘 → 读回来(读完探针已 reset,下一段从零开始)。 */
    const readLoopDelay = async label => {
      const before = fs.existsSync(readingPath) ? fs.statSync(readingPath).mtimeMs : 0
      server.kill('SIGUSR2')
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        if (fs.existsSync(readingPath) && fs.statSync(readingPath).mtimeMs !== before) {
          const reading = JSON.parse(fs.readFileSync(readingPath, 'utf-8'))
          console.log(`  info 事件循环延迟(${label}):p50 ${reading.p50}ms / p99 ${reading.p99}ms / `
            + `max ${reading.max}ms / mean ${reading.mean}ms / 采样 ${reading.count}`)
          return reading
        }
        await sleep(50)
      }
      throw new Error(`探针没在 5s 内写出 ${label} 的读数 —— --require 那条预加载没生效?`)
    }

    /*
     * 冷建等它追上账本。判据是 `search.status` 的 `docs` 涨到不再涨 + `pending === 0`
     * —— 判据与 S3c 那道已退役的 `search:parity-B` 同一条,理由也同一条(光看
     * `pending` 会在校对还没入队的那一瞬间抢答「追上了」,施工时真被咬过)。
     */
    let docs = -1
    let stable = 0
    let sawWork = false
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline) {
      const status = await rpc('search', 'status')
      if (status?.pending > 0) sawWork = true
      if (status?.docs !== docs) { docs = status?.docs ?? -1; stable = 0 } else if (status?.pending === 0 && docs > 0) {
        stable += 1
        if (stable >= 5) break
      } else stable = 0
      await sleep(200)
    }
    const coldMs = Date.now() - coldStartedAt
    check(docs >= seeded.messages,
      `⑤a 冷建把 ${docs} 份文档折进了索引(种了 ${seeded.messages} 条消息 + ${seeded.sessions} 个标题)`)
    console.log(`  info 冷建 ${coldMs}ms(从进程起到 docs 涨停;见过在忙 ${sawWork});`
      + `库 ${(fs.statSync(path.join(storeB, 'index', 'search.v1.sqlite')).size / 1048576).toFixed(1)} MiB`)

    const cold = await readLoopDelay('冷建全程')
    check(cold.p99 < 20,
      `⑤a 冷建全程主线程事件循环 p99 ${cold.p99}ms < 20ms(§5.3:sqlite 只在 Worker 里)`)

    /*
     * ── ⑤b 增量:连发 20 条消息 ───────────────────────────────────
     *
     * 派工单指定的那一形。**这一段的线是 20ms 不是 5ms**,理由是量出来的:
     *
     * 同一份现场跑一次**索引整个关掉**的控制组(`ONETHING_SEARCH_WORKER` 指到一个
     * 存在但不是 Worker 的文件 → 起两次都崩 → `mode: 'error'`、`docs: 0`),这 20 条
     * 消息的窗口读数是 **p50 1.281 / p99 7.377 / max 27.4ms**;同一台机器带着索引跑
     * 是 **p50 1.270 / p99 5.9 / max 49.4ms**。**索引关掉反而更高** —— 也就是说这个
     * 窗口的地板是「20 个真回合」本身(HTTP、引擎、SSE、会话落盘),不是折。拿 5ms
     * 去卡它,卡的是引擎不是索引;那条线该由隔离出来的 ⑤c 来守。
     */
    const made = await rpc('sessions', 'create', { name: `事件循环门 ${MARKER}` })
    const loopSessionId = made?.session?.id
    if (!loopSessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(made)}`)
    const incrementalStartedAt = Date.now()
    for (let i = 0; i < 20; i += 1) {
      await rpc('session-command', 'emit', {
        sessionId: loopSessionId,
        command: {
          type: 'command:send-message',
          content: `${MARKER} 第 ${i} 条:身份牌已经私发四人了`,
          suppressTitleGeneration: true,
        },
      })
      await sleep(150)
    }
    // 等最后一条折完(用 pending 归零判),再取读数 —— 增量折要落在窗口里面。
    const drainDeadline = Date.now() + 30_000
    while (Date.now() < drainDeadline) {
      const status = await rpc('search', 'status')
      if (status?.pending === 0) break
      await sleep(100)
    }
    console.log(`  info 增量段 ${Date.now() - incrementalStartedAt}ms(20 条消息)`)
    const incremental = await readLoopDelay('增量折期间(20 个真回合)')
    check(incremental.p99 < 20,
      `⑤b 20 个真回合期间主线程事件循环 p99 ${incremental.p99}ms < 20ms`
      + '(5ms 那条线归 ⑤c —— 这个窗口的地板是回合本身,控制组读数见注释)')

    /*
     * ── ⑤c 把「折」单独拎出来量 ───────────────────────────────────
     *
     * §5.3 那句「增量折期间 p99 < 5ms」说的是**折**这件事不许占主线程。要量它就得
     * 让窗口里除了折**没有别的**。
     *
     * 手法:往 200 间已种会话各塞一条系统消息(`sessions.addSystemMessage`,每 5 条
     * 一条 > 64KB)。这条路**正是 §5.3 说的那一条** —— 消息落盘 → 进程内 append
     * 观察者 → `enqueue` → Worker 折 —— 而它周围没有模型轮、没有 SSE、没有权限往返,
     * 所以窗口里除了折基本没有别的事。折的是**整键重折**:每条塞进去,那间会话的
     * 30 条旧消息连同新的这条一起重新过一遍分析器。
     *
     * **这一条才是「把索引搬回主线程就红」的那一条**:整键重折要读整份 events.jsonl
     * 再过分析器,200 次搬到主线程上必然越过 5ms。
     *
     * 为什么不是目录监视那条路(第一版这么写的,读数留在这里):子进程批量追加 40 条
     * 之后,目录监视要等到它 30 秒一轮的 mtime 兜底扫描才看见(`fs.watch` 那条快路在
     * 一次 40 间目录的突发下没命中),而折本身只花 55ms —— 窗口要么被 33 秒空闲稀释、
     * 要么只剩 41 个采样,两种都不足以支撑一条 p99 判据。那 33 秒的通知延迟本身是个
     * 值得记的读数(§5.6 说的是「~1s」),已写进设计 §13 留账。
     */
    /*
     * 60 键:一次 `addSystemMessage` 往返实测 ~0.9s(HTTP + 冷会话读盘 + 落盘),
     * 200 键要 176 秒 —— 读数没更可信(p99 2.519ms,与 60 键那档同量级),只是让这道门
     * 多跑两分钟。60 键给出 4 万量级的采样,够撑一条 p99。
     */
    const FOLD_KEYS = 60
    const LONG_EVERY = 5
    const foldMarker = `gatefold${letters(8)}`
    const longBody = 'x'.repeat(70 * 1024)
    const beforeDocs = (await rpc('search', 'status')).docs
    await readLoopDelay('(丢弃:⑤b 与 ⑤c 之间)')
    const foldStartedAt = Date.now()
    for (let i = 0; i < FOLD_KEYS; i += 1) {
      const body = i % LONG_EVERY === 0 ? `${foldMarker} ${longBody}` : `${foldMarker} 第 ${i} 条`
      await rpc('sessions', 'addSystemMessage', {
        sessionId: `seed-${String(i).padStart(4, '0')}`,
        message: {
          id: `${foldMarker}-${i}`,
          role: 'system',
          content: body,
          timestamp: Date.now(),
        },
      })
    }
    const foldDeadline = Date.now() + 120_000
    let afterDocs = beforeDocs
    while (Date.now() < foldDeadline) {
      const status = await rpc('search', 'status')
      afterDocs = status?.docs ?? afterDocs
      if (afterDocs >= beforeDocs + FOLD_KEYS && status?.pending === 0) break
      await sleep(50)
    }
    const foldMs = Date.now() - foldStartedAt
    check(afterDocs >= beforeDocs + FOLD_KEYS,
      `⑤c ${FOLD_KEYS} 条系统消息都折进了索引(docs ${beforeDocs} → ${afterDocs};${foldMs}ms)`)
    const folding = await readLoopDelay('增量折期间(只有折)')
    check(folding.p99 < 5,
      `⑤c 只有折的窗口里主线程事件循环 p99 ${folding.p99}ms < 5ms(§5.3;`
      + '把整键重折搬回主线程这一条必红)')

    if (failures.length > 0) {
      console.error(`[gate:search-index] ⑤ server 输出尾:\n${serverOutB.slice(-40).join('')}`)
    }
  } catch (error) {
    failures.push(String(error?.stack || error))
    console.error(`[gate:search-index] ⑤ ${error?.stack || error}`)
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      await sleep(1500)
      try { server.kill('SIGKILL') } catch { /* 已经没了就算了 */ }
    }
    if (provider) provider.close()
    fs.rmSync(storeB, { recursive: true, force: true })
  }
}


/* ═══════════════════ ⑧ 语义召回(S7,§15;自己的一间 store、自己的一条 server)═══════
 *
 * **不下载真模型**:`ONETHING_SEARCH_EMBEDDER=fake` 把 `modelId` 换成 core 里那只
 * 确定性的假嵌入器,同义表由 `ONETHING_SEARCH_EMBEDDER_FAKE_TABLE` 指向黄金复述集。
 * 于是这一条证的是「切段 → 写 vec_docs → 查询嵌入 → KNN → 融合 → 出候选」这一整条链
 * 在**真产物 + 真 Worker + 真 sqlite-vec 扩展**上是通的;模型本身的召回质量由真机冒烟
 * 说话(§15.5)。
 *
 * **开关走的是设置那条真路**(`settings.json` 的 `search.semantic.enabled`),不是一个
 * 门专用的后门 —— 拍点壬 a 的「默认关、设置里一键开」因此在这里被真的走了一遍。
 */
async function runSemanticPhase() {
  const storeC = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-semantic-gate-'))
  const paraphrasePath = path.join(repoRoot, 'packages/core/search/__tests__/fixtures/paraphrase.json')
  let server
  let provider
  try {
    console.log(`[gate:search-index] ⑧ temp store: ${storeC}`)
    const paraphrase = JSON.parse(fs.readFileSync(paraphrasePath, 'utf-8'))
    const corpus = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'packages/core/search/__tests__/fixtures/corpus.json'), 'utf-8'))

    /*
     * 挑复述集的**两条**,各自的原文各进一间会话,再拿各自的改写句去查 ——
     * 判据是「各回各家」。
     *
     * 为什么不是「一条命中 + 一条不命中」(第一版的写法,当场被打红):**KNN 没有
     * 下限**。`k = 5` 答的永远是最近的五条,哪怕全都不相关 —— 一间只有两条消息的
     * store 上,任何一句话都能把那两条召回来,所以「不相关的查询不该命中」在这个
     * 现场根本不成立(机制层面留了 `manifest.retrievers.vector.maxDistance` 这一格,
     * 但今天故意没有定值,理由见 `core/search/capability.ts` 那格注释与 §13)。
     * **能判的是区分度**:两条各自的改写句要各把自己那条排在第一。
     */
    const sourceOf = item => {
      const phrases = Object.entries(paraphrase.synonyms)
        .filter(([, concept]) => concept === item.concept)
        .map(([phrase]) => phrase)
      const doc = corpus.docs.find(candidate => candidate.capability === 'messages'
        && phrases.some(phrase => String(candidate.content ?? '').toLowerCase().includes(phrase)))
      if (!doc) throw new Error(`⑧ 语料里找不到复述集 ${item.id} 的原文`)
      return doc
    }
    const probe = paraphrase.cases[0]
    const rival = paraphrase.cases.find(item => item.concept !== probe.concept)
    const sourceDoc = sourceOf(probe)
    const rivalDoc = sourceOf(rival)

    provider = await startFakeProvider(MOCK_PORT + 2, REPLY_TEXT)
    fs.writeFileSync(path.join(storeC, 'settings.json'), JSON.stringify({
      ai: fakeProviderAiSettings(MOCK_PORT + 2),
      tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
      diagnostics: { enabled: false },
      // 拍点壬 a 的那一格 —— 门把它打开,走的是产品的那条路。
      search: { semantic: { enabled: true, modelId: 'fake' } },
    }, null, 2))

    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...FAKE_PROVIDER_ENV,
        ONETHING_STORE_PATH: storeC,
        ONETHING_SERVER_DATA_ROOT: storeC,
        ONETHING_SERVER_HOST: '127.0.0.1',
        ONETHING_SERVER_PORT: '',
        ONETHING_SEARCH_EMBEDDER: 'fake',
        ONETHING_SEARCH_EMBEDDER_FAKE_TABLE: paraphrasePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = []
    server.stdout.on('data', chunk => out.push(chunk.toString()))
    server.stderr.on('data', chunk => out.push(chunk.toString()))

    const discovery = await waitForDiscovery(storeC)
    const rpc = createRpc(discovery)

    // 扩展装得上吗 —— 这一格与开关无关,`gate:packaged` 读的也是它。
    const first = await rpc('search', 'status')
    check(first?.vectorExtension === 'loadable',
      `⑧ sqlite-vec 扩展可装载(读到 ${JSON.stringify(first?.vectorExtension)})`)
    check(first?.vector !== 'off',
      `⑧ 开关打开后 status.vector 离开 'off'(读到 ${JSON.stringify(first?.vector)})`)

    // 两条原文,各进一间会话。助手那段由假 provider 答,与这一条无关。
    const seed = async (name, content) => {
      const made = await rpc('sessions', 'create', { name })
      const id = made?.session?.id
      if (!id) throw new Error(`⑧ sessions.create 没给出会话 id:${JSON.stringify(made)}`)
      await rpc('session-command', 'emit', {
        sessionId: id,
        command: { type: 'command:send-message', content, suppressTitleGeneration: true },
      })
      return id
    }
    const sessionId = await seed(`语义门 ${MARKER} A`, sourceDoc.content)
    const rivalSession = await seed(`语义门 ${MARKER} B`, rivalDoc.content)

    // 状态走到 ready 且 vectorPending 归零。**把走过的每一格记下来** —— 只看终点
    // 的话「一上来就是 ready」与「真嵌过」分不出来。
    const seen = new Set()
    let status = first
    const readyStartedAt = Date.now()
    while (Date.now() - readyStartedAt < 30_000) {
      status = await rpc('search', 'status')
      if (status?.vector) seen.add(status.vector)
      if (status?.vector === 'ready' && (status?.vectorPending ?? 0) === 0 && (status?.pending ?? 1) === 0) break
      await sleep(150)
    }
    check(status?.vector === 'ready',
      `⑧ status.vector 走到 ready(${Date.now() - readyStartedAt}ms;走过 ${[...seen].join(' → ')})`)
    check((status?.vectorPending ?? -1) === 0,
      `⑧ vectorPending 归零(读到 ${JSON.stringify(status?.vectorPending)})`)
    // **不判「走过 embedding」**:假嵌入器的 `ready()` 是空操作、两条消息一瞬间就
    // 嵌完了,150ms 的轮询永远抓不到中间态 —— 那会是一条只在慢机器上绿的断言。
    // 能判的是「开关没有自己关回去」:模型装载失败那一支就是把它钉回 `'off'`。
    check(!seen.has('off'),
      `⑧ 开关一路没有自己关回去(走过 ${[...seen].join(' → ')})`)

    // 复述集那条**改写句**:与原文不共用词,词法严格档零命中,靠向量路捞回来。
    const found = await (async () => {
      const startedAt = Date.now()
      while (Date.now() - startedAt < 10_000) {
        const page = await rpc('search', 'query', { query: probe.query, category: 'messages', limit: 10 })
        const hit = (page?.results ?? []).find(result => result.sessionId === sessionId)
        if (hit) return { hit, ms: Date.now() - startedAt }
        await sleep(150)
      }
      return { hit: undefined, ms: Date.now() - startedAt }
    })()
    check(found.hit !== undefined,
      `⑧ 复述集 ${probe.id} 的改写句经 HTTP 命中(${found.ms}ms;查询「${probe.query}」)`)

    // 区分度:另一条改写句要把**它自己那条**排在第一,而不是把上面那条排在第一。
    const rivalPage = await rpc('search', 'query', { query: rival.query, category: 'messages', limit: 10 })
    const rivalFirst = (rivalPage?.results ?? [])[0]
    check(rivalFirst?.sessionId === rivalSession,
      `⑧ 区分度:${rival.id} 的改写句把自己那条排第一`
      + (rivalFirst?.sessionId === sessionId ? `(实际排第一的是 ${probe.id} 那条)` : ''))
    const mineFirst = (await rpc('search', 'query', { query: probe.query, category: 'messages', limit: 10 }))
      ?.results?.[0]
    check(mineFirst?.sessionId === sessionId,
      `⑧ 区分度:${probe.id} 的改写句把自己那条排第一`)

    if (failures.length > 0) {
      console.error(`[gate:search-index] ⑧ server 输出尾:\n${out.slice(-40).join('')}`)
    }
  } catch (error) {
    failures.push(String(error?.stack || error))
    console.error(`[gate:search-index] ⑧ ${error?.stack || error}`)
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      await sleep(1500)
      try { server.kill('SIGKILL') } catch { /* 已经没了就算了 */ }
    }
    if (provider) provider.close()
    fs.rmSync(storeC, { recursive: true, force: true })
  }
}
