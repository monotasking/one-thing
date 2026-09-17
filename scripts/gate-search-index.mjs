#!/usr/bin/env node
/**
 * `bun run gate:search-index` —— 检索索引的真机门(检索重建 S3b 立骨架,S3c 补
 * 事件循环延迟与 parity-B;`docs/design/search-index-2026-09.md` §10 S3 行)。
 *
 * 它证的是**产物**:`dist/server/main.js` 起在一间临时 store 上,索引 Worker
 * (`dist/server/search-worker.cjs`)真的被 `worker_threads` 起了起来、真的在折账本。
 * 单测里的 Worker 是同线程的 `MessageChannel`(S3a 的手法),那条路证不了这一件。
 *
 * 十一条常跑 + 一条**可选**(①–④ S3b,⑤–⑦ S3c,⑧ S7,⑨ 检索面终稿,⑩ 设置页那一格与
 * 热生效,⑪ 代理与 Worker 日志,⑫ 真嵌入器 —— 默认跳过,见它自己的段首):
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
 *   ⑨ **组游标回传**(检索面终稿 §0 ②):全部档拿到的 `groups[].cursor` 回传给
 *      同词同片的单类请求,第二页不重不漏 —— 这条证的是「每块自己原地续页」那一格
 *      契约真的接得住,而且两条路(全部档的配额 vs 单类档的页大小)的游标指纹一致
 *      (设计里的风险 #4 只能由门跑出来)
 *   ⑧ **语义召回整条链**(S7,§15):开关打开(设置里那一格,`modelId` 由
 *      `ONETHING_SEARCH_EMBEDDER=fake` 换成确定性的假嵌入器 —— 门不下 110MB 模型)
 *      → `status.vector` 走过 downloading / embedding 到 `'ready'` → 黄金复述集里
 *      的一条**改写句**经 HTTP 命中那条消息。假嵌入器证的是**链路**不是模型
 *      (`packages/core/search/__tests__/fixtures/paraphrase.json` 的头注写着这句)。
 *   ⑫ **真嵌入器真的跑得起来**(2026-09-17;**默认不跑** —— 它要下 130MB 模型、要出外网)。
 *      `ONETHING_GATE_REAL_EMBEDDER=1` 且 `HTTPS_PROXY` / `HF_ENDPOINT` 至少有一个在场
 *      才跑;否则打印跳过的理由。判的是「`device: 'cpu'` 那条路通到底」:状态走到
 *      `ready`,再拿一句**与原文零词重叠**的改写句经 HTTP 命中它自己那条。⑫b 顺带证
 *      **认领**:把清单删掉、代理指到一个连不上的口、换一条 Worker → 它只读本地就
 *      认得回 `ready`,清单也补了回来(2026-09-17 那条「下载了也当做没下载」的事故)。
 *   ⑪ **模型下载走 app 的代理 + Worker 的话落得了地**(2026-09-17,09-17 用户真机事故):
 *      ⑪a 下不来时 `status.vector` 翻 `'off'`、`status.vectorError` 说得出「下载模型失败」,
 *          而且 Worker 那句 warn 真的出现在宿主的 `server.jsonl` 里(`fields.thread`);
 *      ⑪b 把 `network.proxy` 指向一台本机假代理 → 换一条 Worker → 模型请求经过了它。
 *      全程不下真模型、不碰外网(`HF_ENDPOINT` 指一个没人监听的本机端口)。
 *   ⑩ **开关保存即生效**(2026-09-17;结清 §13「S7 待拍(三)——开关保存后不热生效」):
 *      出厂档起一条 server(`vector: 'off'`)→ 经 `settings.saveSettings` 打开那一格 →
 *      `status.vector` **不重启就**离开 `'off'` → 再关回去 → 回到 `'off'`。全程词法路
 *      照答(换 Worker 期间查询排队不抛),`mode` 一直是 `'owner'`。
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
import net from 'node:net'
import http from 'node:http'
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

/** 一个目录里的每个文件(相对路径,递归)。⑬e 数「试装前后文件一件没少」用。 */
function listFilesDeep(root, base = root) {
  const out = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) out.push(...listFilesDeep(full, base))
    else out.push(path.relative(base, full))
  }
  return out.sort()
}

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
   * ── ⑨ 组游标回传:全部档拿到的那一格,在单类档上接得住 ───────────────
   *
   * 检索面终稿 §0 ② 的那一格 `groups[].cursor`。风险 #4 说的正是这一条:全部档的
   * 首页由 `defaultBudgetPolicy` 产(messages 配额 5)、第二页由
   * `singleCapabilityBudgetPolicy` 产,两条路的放宽档 `level` 若不一致,游标的指纹
   * 就对不上 —— 那件事**只能由门跑出来**,单测里的假索引证不了(它不跑放宽阶梯)。
   *
   * 判据三条:全部档那一组带游标;回传之后第二页与第一页 **id 不相交**(不重);
   * 两页合起来的条数等于 `total` 能覆盖的那一段(不漏)。
   */
  const PAGE_MARKER = `gatepage${letters(8)}`
  const PAGE_ROWS = 9
  for (let i = 0; i < PAGE_ROWS; i += 1) {
    await rpc('sessions', 'addSystemMessage', {
      sessionId,
      message: {
        id: `${PAGE_MARKER}-${i}`,
        role: 'system',
        content: `${PAGE_MARKER} 第 ${i} 条`,
        timestamp: Date.now() + i,
      },
    })
  }
  const paged = await waitForHit(PAGE_MARKER, 'all',
    result => result.id.includes(PAGE_MARKER), 10_000)
  check(paged.hit !== undefined, `⑨ 全部档搜得到那 ${PAGE_ROWS} 条(${paged.ms}ms)`)

  const all = await rpc('search', 'query', { query: PAGE_MARKER, category: 'all' })
  const group = (all?.groups ?? []).find(entry => entry.capability === 'messages')
  const firstIds = (group?.results ?? []).map(result => result.id)
  check(typeof group?.cursor === 'string' && group.cursor.length > 0,
    `⑨ messages 那一组带 cursor(本页 ${firstIds.length} 条 / total ${group?.total};`
    + `${group?.cursor === undefined ? '缺席 = 投影那一行没了' : '有'})`)

  if (typeof group?.cursor === 'string') {
    const second = await rpc('search', 'query', {
      query: PAGE_MARKER,
      category: 'messages',
      limit: firstIds.length,
      cursor: group.cursor,
    })
    const nextIds = (second?.results ?? []).map(result => result.id)
    const overlap = nextIds.filter(id => firstIds.includes(id))
    check(nextIds.length > 0,
      `⑨ 第二页不是空的(${nextIds.length} 条;空 = 游标的指纹没对上,风险 #4)`)
    check(overlap.length === 0,
      `⑨ 第二页与第一页不重(重了 ${overlap.length} 条${overlap.length ? `:${overlap.join(', ')}` : ''})`)
    check(new Set([...firstIds, ...nextIds]).size === firstIds.length + nextIds.length,
      `⑨ 两页合起来 ${firstIds.length + nextIds.length} 条互不相同(不漏)`)
  }

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
await runSemanticHotApplyPhase()
await runSemanticProxyPhase()
await runSemanticModelPhase()
await runRealEmbedderPhase()

if (failures.length > 0) {
  console.error(`[gate:search-index] ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('[gate:search-index] ok')

/* ═══════════════════ ⑪ 模型下载走代理 + Worker 的话落得了地 ════════════════════
 *
 * 09-17 用户真机事故的两条,各一半:
 *  ⑪a **原因说得出**:语义召回开着、模型下不来 → `status.vector` 翻 `'off'`,
 *      `status.vectorError` 里有那句人话,**而且 Worker 那句 warn 真的出现在宿主的
 *      `server.jsonl` 里**(这一条就是「设置页写着『原因在日志里』而日志里一行都没有」
 *      的验尸报告 —— Worker 从来没有接过宿主的 sink)。
 *  ⑪b **代理真的用上了**:把 `network.proxy` 指向一台本机假代理 → 换一条 Worker →
 *      模型请求经过了它(数 CONNECT;实测 undici 的 `ProxyAgent` 对 `http://` 的目标
 *      **也发 CONNECT**,所以数的就是它)。
 *
 * **不下载真模型,也不碰外网**:`HF_ENDPOINT` 指到一个**没人监听**的本机端口。
 * 于是 ⑪a 的失败原因是货真价实的 `fetch failed / ECONNREFUSED`(那正是人话前缀的判据,
 * 答 404 的假站不是 —— 404 是一个真答复,不是「连不上」),而 ⑪b 里同一条 URL 换成
 * 走代理之后,代理那一侧就能数到它。
 *
 * 这一条**不能**开 `ONETHING_SEARCH_EMBEDDER=fake`:假嵌入器根本不出网,那就什么都证不了。
 */
async function runSemanticProxyPhase() {
  const storeE = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-proxy-gate-'))
  let server
  let provider
  let proxy
  let deadPort
  try {
    console.log(`[gate:search-index] ⑪ temp store: ${storeE}`)
    provider = await startFakeProvider(MOCK_PORT + 4, REPLY_TEXT)
    proxy = await startCountingProxy()
    deadPort = await findClosedPort()

    // 语义召回开着、**真嵌入器**、镜像站指向一个没人监听的端口。
    fs.writeFileSync(path.join(storeE, 'settings.json'), JSON.stringify({
      ai: fakeProviderAiSettings(MOCK_PORT + 4),
      tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
      diagnostics: { enabled: false },
      search: { semantic: { enabled: true } },
    }, null, 2))

    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...FAKE_PROVIDER_ENV,
        ONETHING_STORE_PATH: storeE,
        ONETHING_SERVER_DATA_ROOT: storeE,
        ONETHING_SERVER_HOST: '127.0.0.1',
        ONETHING_SERVER_PORT: '',
        // 这一条的整个前提:**不出外网**。没人监听 = 连不上 = 那句人话前缀的判据。
        HF_ENDPOINT: `http://127.0.0.1:${deadPort}`,
        // 环境里可能有真代理(开发机上常有);这一条要的是「设置里那一格」说了算。
        HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', ALL_PROXY: '',
        ONETHING_SEARCH_EMBEDDER: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = []
    server.stdout.on('data', chunk => out.push(chunk.toString()))
    server.stderr.on('data', chunk => out.push(chunk.toString()))

    const discovery = await waitForDiscovery(storeE)
    const rpc = createRpc(discovery)

    // 一条消息 = 一份待嵌的文档 = 写路真的会去装载模型(不然什么都不会发生)。
    const made = await rpc('sessions', 'create', { name: `代理门 ${MARKER}` })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error(`⑪ sessions.create 没给出会话 id:${JSON.stringify(made)}`)
    await rpc('session-command', 'emit', {
      sessionId,
      command: { type: 'command:send-message', content: `身份牌 ${MARKER} 已经私发四人了`, suppressTitleGeneration: true },
    })

    /*
     * ── ⑪a 原因说得出 ────────────────────────────────────────────────────
     *
     * **口径换过一次**(2026-09-17 晚,§15.8):在「开关 = 下载」的那一版里,打开开关
     * 就会去下模型,所以这一格读的是 `vectorErrorKind`。拆开之后翻开关不再下载 ——
     * 下载是 `search.semanticModelDownload` 这一发,失败的原因也就落在
     * **`status.model.errorKind`** 上(`vectorErrorKind` 此刻答的是 `'model'`:
     * 「模型还没下」,那是另一句真话)。
     */
    const noModel = await waitForStatus(rpc, status => status?.model?.state === 'absent',
      '模型那一格说得出「没下」', 60_000)
    check(noModel.status?.vectorErrorKind === 'model',
      `⑪a 模型没下时 vectorErrorKind 说的是 model(读到 ${JSON.stringify(noModel.status?.vectorErrorKind)})`)

    const kicked = await rpc('search', 'semanticModelDownload', {})
    check(kicked?.success === true, `⑪a 起了一发下载(读到 ${JSON.stringify(kicked?.model?.state)})`)
    const failed = await waitForStatus(rpc, status => status?.model?.state === 'failed',
      '下不来之后落在 failed', 60_000)
    const kind = failed.status?.model?.errorKind
    const reason = failed.status?.model?.error
    check(kind === 'network',
      `⑪a status.model.errorKind 判成 network(读到 ${JSON.stringify(kind)})`)
    check(typeof reason === 'string' && reason.length > 0,
      `⑪a status.model.error 带着原话(读到 ${JSON.stringify(reason)})`)

    /*
     * Worker 那句话真的进了宿主的 jsonl —— 这一格就是「日志落地」那一半的证据。
     * **要等**:`JsonlFileSink` 是缓冲写的,`status` 一翻 `'off'` 那一刻它还没落盘
     * (施工时这么红过一次,是时序不是回归)。
     */
    const logFile = path.join(storeE, 'log', 'server.jsonl')
    const workerWarns = () => readJsonl(logFile)
      .filter(record => record?.fields?.thread === 'search-worker')
    await waitFor(() => workerWarns().some(record => record.level === 'warn'), 20_000)
    const fromWorker = workerWarns()
    check(fromWorker.length > 0,
      `⑪a 宿主 server.jsonl 里有 Worker 说的话(${fromWorker.length} 条;ns: ${[...new Set(fromWorker.map(r => r.ns))].join(', ')})`)
    check(fromWorker.some(record => record.level === 'warn' && record.ns?.startsWith('search.')),
      '⑪a 其中有那句 warn(语义召回自己关回去了)')

    // ── ⑪b 代理真的用上了 ────────────────────────────────────────────────
    const current = await rpc('settings', 'getSettings')
    if (!current?.settings) throw new Error('⑪ settings.getSettings 没给出设置')
    const saved = await rpc('settings', 'saveSettings', {
      ...current.settings,
      network: { proxy: { enabled: true, url: proxy.url, bypassRules: '' } },
    })
    if (saved?.success !== true) throw new Error(`⑪ settings.saveSettings 未成功:${JSON.stringify(saved)}`)

    /*
     * 换完 Worker 还要**再按一次下载**:改代理 = 换一条 Worker,新那条起来时模型那件
     * 东西是新造的(它去问一次磁盘,答「没下」),而**没有人会替人按那颗钮** ——
     * 那样数到 0 次 CONNECT 是「没人下过」,不是「代理没接上」。
     *
     * (2026-09-17 晚改:这里原本是「再发一条消息」—— 那一版里写路装模型时顺带下载,
     * 现在写路只读本地。病历留着:判据换了,理由是产品的形换了。)
     */
    await waitForStatus(rpc, status => status?.model?.state === 'absent',
      '换完 Worker 之后模型那一格回到 absent', 20_000)
    await rpc('search', 'semanticModelDownload', {})

    /*
     * 等的是**镜像站那一条**来过,不是「来过任何一条」。代理那一格一改,provider 的
     * 调用也跟着走代理了(它本来就该 —— `bound-fetch` 读的是同一格设置),于是假代理上
     * 先看见的多半是假 provider 那一条;拿「有没有 CONNECT」当判据会提前收工,
     * 然后在下一行说「镜像站没来过」。施工时这么红过一次。
     */
    const mirrorTarget = `127.0.0.1:${deadPort}`
    const seenMirror = await waitFor(() => proxy.connects.includes(mirrorTarget), 60_000)
    check(seenMirror,
      `⑪b 改完代理换了一条 Worker,模型请求经过了它(CONNECT ${proxy.connects.length} 次:${[...new Set(proxy.connects)].join(', ')})`)

    if (failures.length > 0) {
      console.error(`[gate:search-index] ⑪ server 输出尾:\n${out.slice(-40).join('')}`)
    }
  } catch (error) {
    failures.push(String(error?.stack || error))
    console.error(`[gate:search-index] ⑪ ${error?.stack || error}`)
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      await sleep(1500)
      try { server.kill('SIGKILL') } catch { /* 已经没了就算了 */ }
    }
    if (provider) provider.close()
    if (proxy) await proxy.close()
    fs.rmSync(storeE, { recursive: true, force: true })
  }
}

/** 轮询到 `predicate` 为真(或到点),把走过的每一格 `vector` 记下来。 */
async function waitForStatus(rpc, predicate, label, timeoutMs) {
  const startedAt = Date.now()
  const seen = new Set()
  let status
  while (Date.now() - startedAt < timeoutMs) {
    status = await rpc('search', 'status')
    seen.add(status?.vector ?? '(absent)')
    if (predicate(status)) return { status, seen, ms: Date.now() - startedAt }
    await sleep(200)
  }
  throw new Error(`等不到「${label}」(走过 ${[...seen].join(' → ')})`)
}

async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true
    await sleep(200)
  }
  return false
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

/** 一个没人监听的本机端口(开一只 listener 问出端口号再关掉)。 */
async function findClosedPort() {
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

/**
 * 一台只数数的假代理。CONNECT 一律答 502 并关掉 —— 这一条要证的是「请求**来过这里**」,
 * 不是「它能不能通」。
 */
async function startCountingProxy() {
  const connects = []
  const sockets = new Set()
  const server = http.createServer((_req, res) => { res.writeHead(400); res.end() })
  server.on('connect', (request, socket) => {
    connects.push(request.url ?? '')
    sockets.add(socket)
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    socket.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    connects,
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

/* ═══════════════════ ⑬ 模型是一件独立的东西:开关不下载,下载看得见进度 ═══════════
 *
 * 2026-09-17 用户裁定:「把开关和下载模型拆开,另外下载模型要能够知道进度。」
 * 在这之前,翻一下开关 = 换一条 Worker = 嵌入器 `ready()` 里顺带下 112.8MB(真机冷下
 * 191 秒),屏上只有一句「正在下载模型…」,没有进度也取消不了。
 *
 * 这一条在**真产物**上证四件事(自己一间 store、自己一条 server、一台**本机假 HF 站**):
 *  ⑬a **开关不再触发下载**:模型没下 + 开关开着 → `vector` 翻 `'off'`、
 *      `vectorErrorKind` 判成 `'model'`,而且假站的**请求计数是 0** —— 一个字节的网络
 *      请求都没发。这是这一批的主判据。
 *  ⑬b **下载真的出网、进度真的在走**:`search.semanticModelDownload` 之后
 *      `status.model.loadedBytes` 单调增、`totalBytes` 不缩,假站真的收到了请求
 *      (这一格同时是 ⑬a 那个 0 的**对照组** —— 不然「0 次」可能只是假站没接上)。
 *  ⑬c **取消**:中途 `semanticModelCancel` → 当场回 `absent`,而且此后**不会**变成
 *      `ready`(半截文件说不了「下全了」——判据是那份落定才写的清单,`model-store.ts`)。
 *  ⑬d **删除**:`semanticModelRemove` → `absent`,模型目录清干净。
 *  ⑬e **认领的另一半**(2026-09-17 §15.8):取消之后盘上留着几件、清单不在 —— 关开关
 *      换出来的那条 Worker 于是撞上「文件在、清单不在」那一形。这台假站的东西**装不
 *      起来**,所以正确答案是不认领:维持 `absent`、文件一件不少、清单没有、零网络。
 *      (「装得上就认领」那一半在单测与可选的 ⑫b。)
 *
 * ## 这台假站给的 onnx 是假的,所以这一条**证不到 `ready`**(写清楚,免得下次误读)
 *
 * 真要走到 `ready`,`onnxruntime-node` 得能把那份 onnx 建成一个推理会话 —— 一份用零
 * 填出来的文件做不到,而在门里生成一份**真的**小 onnx 要么得引 protobuf、要么得预置一份
 * 二进制产物,两样都比它们要守的东西贵。所以分工是:
 *  - **走到 `ready`** 由可选的 ⑫(真嵌入器、真出网)守;
 *  - **状态机**(进度怎么聚、取消是什么语义、清单什么时候写、半截文件为什么不算数)
 *    由单测守(`search/index/__tests__/model-download.test.ts` +
 *    `search/embedding/__tests__/model-store.test.ts`);
 *  - 这一条守的是**只有真机才说得出的那三句**:零网络、真出网、真取消。
 *
 * **反证**:把嵌入器装载第一句那个 `isEmbedderModelPresent` 拆掉(或把
 * `allowRemoteModels` 改回 true)→ ⑬a 的计数不再是 0 → 红。
 */
async function runSemanticModelPhase() {
  const storeG = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-model-gate-'))
  let server
  let provider
  let station
  try {
    console.log(`[gate:search-index] ⑬ temp store: ${storeG}`)
    provider = await startFakeProvider(MOCK_PORT + 6, REPLY_TEXT)
    station = await startFakeModelStation()

    fs.writeFileSync(path.join(storeG, 'settings.json'), JSON.stringify({
      ai: fakeProviderAiSettings(MOCK_PORT + 6),
      tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
      diagnostics: { enabled: false },
      // 开关**开着**,模型**没下** —— 这一批要守的就是这一形。
      search: { semantic: { enabled: true } },
    }, null, 2))

    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...FAKE_PROVIDER_ENV,
        ONETHING_STORE_PATH: storeG,
        ONETHING_SERVER_DATA_ROOT: storeG,
        ONETHING_SERVER_HOST: '127.0.0.1',
        ONETHING_SERVER_PORT: '',
        // 出网只许去这台假站;真代理一律清掉(开发机上常有)。
        HF_ENDPOINT: station.url,
        HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', ALL_PROXY: '',
        ONETHING_SEARCH_EMBEDDER: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = []
    server.stdout.on('data', chunk => out.push(chunk.toString()))
    server.stderr.on('data', chunk => out.push(chunk.toString()))

    const discovery = await waitForDiscovery(storeG)
    const rpc = createRpc(discovery)

    // 一条消息 = 一份待嵌的文档 = 写路真的会去装载嵌入器(不然什么都不会发生)。
    const made = await rpc('sessions', 'create', { name: `模型门 ${MARKER}` })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error(`⑬ sessions.create 没给出会话 id:${JSON.stringify(made)}`)
    await rpc('session-command', 'emit', {
      sessionId,
      command: { type: 'command:send-message', content: `身份牌 ${MARKER} 已经私发四人了`, suppressTitleGeneration: true },
    })

    // ── ⑬a 开关不再触发下载 ──────────────────────────────────────────────
    const offed = await waitForStatus(rpc, status => status?.vector === 'off', "模型没下 → 翻回 'off'", 60_000)
    check(offed.status?.vectorErrorKind === 'model',
      `⑬a 模型没下 → vectorErrorKind 判成 model(读到 ${JSON.stringify(offed.status?.vectorErrorKind)})`)
    check(offed.status?.model?.state === 'absent',
      `⑬a status.model 说得出「没下」(读到 ${JSON.stringify(offed.status?.model?.state)})`)
    check(station.hits.length === 0,
      `⑬a **一个网络请求都没发**(假站计数 ${station.hits.length}:${[...new Set(station.hits)].join(', ')})`)

    // ── ⑬b 按下载:真出网、进度真的在走 ──────────────────────────────────
    const started = await rpc('search', 'semanticModelDownload', {})
    check(started?.success === true && started?.model?.state === 'downloading',
      `⑬b download 当场答「起来了」(读到 ${JSON.stringify(started?.model?.state)})`)

    const samples = []
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const status = await rpc('search', 'status')
      const model = status?.model
      if (model === undefined) break
      samples.push({ loaded: model.loadedBytes ?? 0, total: model.totalBytes ?? 0, state: model.state })
      if (model.state !== 'downloading') break
      if (samples.filter(s => s.loaded > 0).length >= 3) break
      await sleep(150)
    }
    const moving = samples.filter(s => s.loaded > 0)
    check(moving.length >= 2 && moving[moving.length - 1].loaded >= moving[0].loaded,
      `⑬b loadedBytes 单调增(读到 ${samples.map(s => s.loaded).join(' → ')})`)
    check(moving.every(s => s.total >= s.loaded),
      `⑬b totalBytes 不小于已下(读到 ${samples.map(s => s.total).join(' → ')})`)
    check(station.hits.length > 0,
      `⑬b 请求真的到了假站(${station.hits.length} 条:${[...new Set(station.hits)].slice(0, 4).join(', ')})`)

    // ── ⑬c 取消:当场回 absent,而且此后不会变成 ready ────────────────────
    const cancelled = await rpc('search', 'semanticModelCancel', {})
    check(cancelled?.success === true && cancelled?.model?.state === 'absent',
      `⑬c cancel 当场回 absent(读到 ${JSON.stringify(cancelled?.model?.state)})`)
    // 给在飞的那一发一点时间落定 —— 它落定之后照样只能是 absent(没有清单)。
    await sleep(1500)
    const afterCancel = await rpc('search', 'status')
    check(afterCancel?.model?.state !== 'ready',
      `⑬c 半截文件不会被当成下全了(读到 ${JSON.stringify(afterCancel?.model?.state)})`)

    /*
     * ── ⑬e 认领:装不上的那一堆不许被认领(2026-09-17 §15.8「认领」)──────
     *
     * 取消之后盘上留着几件(三份 json 下全了,那份 onnx 被 `FileCache` 自己删了),
     * 而清单**不在**。下面那一步关开关会换一条 Worker,新 Worker 于是撞上「清单缺席、
     * 文件却在」那一形 —— 正是认领要处理的那一形。这台假站给的东西**装不起来**,
     * 所以正确答案是「不认领」:维持 `absent`、**文件一个都不删**、不出网。
     *
     * 「装得上就认领」那一半这一条证不到(假 onnx 建不出会话),它归单测
     * (`model-download.test.ts`)与可选的 ⑫(真模型、删掉清单重起)。
     */
    const modelDirG = path.join(storeG, 'models', 'embeddings', 'multilingual-e5-small')
    const beforeAdopt = fs.existsSync(modelDirG) ? listFilesDeep(modelDirG) : []
    check(beforeAdopt.length > 0,
      `⑬e 取消之后盘上确实留着东西,认领有得可试(${beforeAdopt.length} 件:${beforeAdopt.slice(0, 4).join(', ')})`)
    const hitsBeforeAdopt = station.hits.length

    // ── ⑬d 删除:正在用的不许抽走,关掉之后才删得动 ──────────────────────
    const refused = await rpc('search', 'semanticModelRemove', {})
    check(refused?.success === false && refused?.error === 'model-in-use',
      `⑬d 开关开着时 remove 结构化拒绝(读到 ${JSON.stringify(refused?.error)})`)

    const current = await rpc('settings', 'getSettings')
    if (!current?.settings) throw new Error('⑬ settings.getSettings 没给出设置')
    const saved = await rpc('settings', 'saveSettings', {
      ...current.settings,
      search: { ...current.settings.search, semantic: { ...current.settings.search?.semantic, enabled: false } },
    })
    if (saved?.success !== true) throw new Error(`⑬ settings.saveSettings 未成功:${JSON.stringify(saved)}`)
    /*
     * 关开关 = 换一条 Worker(热生效,⑩);等新的那条起来再删。
     *
     * **这条等待同时是认领那一格的等待**:试装期间 `status.model` 整格缺席(壳读成
     * 「检查中…」),所以 `model !== undefined` 就是「认领已经落定」。
     */
    const adopted = await waitForStatus(rpc, status => status?.model !== undefined && status?.vector === 'off',
      '关掉之后新 Worker 就位', 20_000)
    check(adopted.status?.model?.state === 'absent',
      `⑬e 装不上的那一堆没有被认领(读到 ${JSON.stringify(adopted.status?.model?.state)};${(adopted.ms / 1000).toFixed(1)}s)`)
    const afterAdopt = listFilesDeep(modelDirG)
    check(afterAdopt.length === beforeAdopt.length,
      `⑬e 认领失败**不删文件**(试装前 ${beforeAdopt.length} 件 / 试装后 ${afterAdopt.length} 件)`)
    check(!afterAdopt.includes('.onething-model.json'),
      '⑬e 装不上就没有清单(清单是「下全了」这句话本身)')
    check(station.hits.length === hitsBeforeAdopt,
      `⑬e 认领**一个网络请求都不发**(试装前后假站计数 ${hitsBeforeAdopt} → ${station.hits.length})`)

    const removed = await rpc('search', 'semanticModelRemove', {})
    check(removed?.success === true && removed?.model?.state === 'absent',
      `⑬d 关掉之后 remove 成了(读到 ${JSON.stringify(removed?.model?.state)} / ${JSON.stringify(removed?.error)})`)
    const modelsDir = path.join(storeG, 'models', 'embeddings')
    const leftovers = fs.existsSync(modelsDir) ? fs.readdirSync(modelsDir) : []
    check(leftovers.length === 0,
      `⑬d 模型目录清干净了(剩 ${leftovers.length} 项:${leftovers.join(', ')})`)

    // 词法路自始至终没被这一整段碰过。
    const lexical = await rpc('search', 'query', { query: MARKER, category: 'messages', limit: 10 })
    check((lexical?.results ?? []).some(result => result.sessionId === sessionId),
      '⑬ 全程词法路照答(模型那一摊与它无关)')

    if (failures.length > 0) {
      console.error(`[gate:search-index] ⑬ server 输出尾:\n${out.slice(-40).join('')}`)
    }
  } catch (error) {
    failures.push(String(error?.stack || error))
    console.error(`[gate:search-index] ⑬ ${error?.stack || error}`)
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      await sleep(1500)
      try { server.kill('SIGKILL') } catch { /* 已经没了就算了 */ }
    }
    if (provider) provider.close()
    if (station) await station.close()
    fs.rmSync(storeG, { recursive: true, force: true })
  }
}

/**
 * 一台**本机假 HuggingFace 站**:按 `{model}/resolve/{revision}/{file}` 答几份小文件
 * 外加一份**慢慢吐**的大「onnx」。
 *
 * 路径模板不是猜的 —— `@huggingface/transformers` 3.8.1 的 `env.remotePathTemplate`
 * 就是 `'{model}/resolve/{revision}/'`(`src/env.js:143`),`HF_ENDPOINT` 换掉的是它
 * 前面的 `remoteHost`。
 *
 * 大文件**分块慢答**(每块之间歇一下)是有意的:进度要看得见、取消要有得取消。
 * 它当然不是一份真的 onnx —— 这一条证不到 `ready`,理由写在段首。
 */
async function startFakeModelStation() {
  const hits = []
  const sockets = new Set()
  const CHUNK = 256 * 1024
  const CHUNKS = 48 // ≈ 12MB,按每块 25ms 算约 1.2s
  /*
   * 三份小文件。`tokenizer.json` **必须是一份能真的构造出来的分词器**(BertNormalizer +
   * BertPreTokenizer + WordPiece)—— 缺一格 transformers 在
   * `Normalizer.fromConfig` 就抛,那一发在**请求 onnx 之前**就结束了,于是进度与取消
   * 两条都没得量(施工时第一版正是这么红的:`Cannot read properties of undefined
   * (reading 'type')`,一个字节的大文件都没下)。
   */
  const small = {
    'config.json': JSON.stringify({ model_type: 'bert', hidden_size: 384 }),
    'tokenizer_config.json': JSON.stringify({ model_max_length: 512 }),
    'tokenizer.json': JSON.stringify({
      version: '1.0',
      truncation: null,
      padding: null,
      added_tokens: [],
      normalizer: {
        type: 'BertNormalizer',
        clean_text: true,
        handle_chinese_chars: true,
        strip_accents: null,
        lowercase: true,
      },
      pre_tokenizer: { type: 'BertPreTokenizer' },
      post_processor: null,
      decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
      model: {
        type: 'WordPiece',
        unk_token: '[UNK]',
        continuing_subword_prefix: '##',
        max_input_chars_per_word: 100,
        vocab: { '[UNK]': 0, '[CLS]': 1, '[SEP]': 2, a: 3 },
      },
    }),
  }

  const server = http.createServer(async (request, response) => {
    const url = request.url ?? ''
    hits.push(url)
    const file = url.split('/resolve/main/')[1] ?? ''
    const body = small[file]
    if (body !== undefined) {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    if (!file.endsWith('.onnx')) {
      response.writeHead(404, { 'content-length': 0 })
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': CHUNK * CHUNKS,
    })
    const block = Buffer.alloc(CHUNK, 0)
    for (let at = 0; at < CHUNKS; at += 1) {
      if (response.writableEnded || response.destroyed) return
      response.write(block)
      await sleep(25)
    }
    response.end()
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

/* ═══════════════════ ⑫ 真嵌入器真的跑得起来(**可选**,默认跳过)═══════════════
 *
 * ①–⑪ 全都跑假嵌入器,所以它们证的是**链路**不是模型 —— 而 §15.7b 那堵墙(嵌入器
 * 写死 `device: 'wasm'`,可 `@huggingface/transformers` 的 node 产物在 macOS 上只认
 * `'cpu'`)恰恰就藏在假嵌入器照不到的地方,活了两周。这一条是那道缺口的门:**真模型、
 * 真 onnxruntime-node、真出网**,一路走到 `ready`,再拿一句与原文**零词重叠**的改写句
 * 经 HTTP 命中它自己那条。
 *
 * **默认不跑**,两个理由都很硬:要下 130MB(`model_quantized.onnx` 112.8MB +
 * `tokenizer.json` 16.3MB),要连 huggingface。所以它要**两把钥匙同时在**:
 *   - `ONETHING_GATE_REAL_EMBEDDER=1` —— 人明说要跑;
 *   - `HTTPS_PROXY` 或 `HF_ENDPOINT` 至少一个在场 —— 这台机器说得出「怎么出网」。
 * 少一把就打印跳过的理由走人(**打印**,不是静默:一条悄悄没跑的门等于没有门)。
 *
 * 两件施工上的安排:
 *  - **代理走产品那条路**:`HTTPS_PROXY` 的值写进 `settings.network.proxy`,而子进程的
 *    `HTTPS_PROXY` 等环境变量一律清掉 —— 09-17 事故的原话就是「设置里代理开着、
 *    provider 通得好好的、模型一个字节下不来」,所以门要量的是**设置里那一格**。
 *  - **模型有缓存**:`<store>/models/embeddings` 软链到 `ONETHING_GATE_EMBEDDER_CACHE`
 *    (缺省 `<tmp>/onething-gate-embeddings`)。第一趟下 130MB / 本机约 200s,之后每趟
 *    约 3s。产品那一侧一个字不改 —— 它照旧只认 `<store>/models/embeddings`。
 */
async function runRealEmbedderPhase() {
  const wanted = process.env.ONETHING_GATE_REAL_EMBEDDER === '1'
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || ''
  const endpoint = process.env.HF_ENDPOINT || ''
  if (!wanted) {
    console.log('[gate:search-index] ⑫ 跳过:要真下模型、真出网 —— 置 ONETHING_GATE_REAL_EMBEDDER=1 才跑')
    return
  }
  if (proxyUrl === '' && endpoint === '') {
    console.log('[gate:search-index] ⑫ 跳过:ONETHING_GATE_REAL_EMBEDDER=1 但 HTTPS_PROXY 与 HF_ENDPOINT 都不在场'
      + '(这台机器说不出怎么出网,跑了也是一条必红的门)')
    return
  }

  const timeoutMs = Number(process.env.ONETHING_GATE_REAL_EMBEDDER_TIMEOUT_MS || 900_000)
  const cacheDir = process.env.ONETHING_GATE_EMBEDDER_CACHE
    || path.join(os.tmpdir(), 'onething-gate-embeddings')
  const storeF = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-real-embedder-gate-'))
  let server
  let provider
  try {
    console.log(`[gate:search-index] ⑫ temp store: ${storeF};模型缓存 ${cacheDir}`
      + `;出网 ${proxyUrl ? `代理 ${proxyUrl}` : `镜像 ${endpoint}`}`)
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.mkdirSync(path.join(storeF, 'models'), { recursive: true })
    fs.symlinkSync(cacheDir, path.join(storeF, 'models', 'embeddings'), 'dir')

    provider = await startFakeProvider(MOCK_PORT + 5, REPLY_TEXT)
    fs.writeFileSync(path.join(storeF, 'settings.json'), JSON.stringify({
      ai: fakeProviderAiSettings(MOCK_PORT + 5),
      tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
      diagnostics: { enabled: false },
      // 出厂那一档的 modelId(不给 `ONETHING_SEARCH_EMBEDDER`)= 真嵌入器。
      search: { semantic: { enabled: true } },
      ...(proxyUrl !== ''
        ? { network: { proxy: { enabled: true, url: proxyUrl, bypassRules: 'localhost;127.0.0.1;::1;*.local' } } }
        : {}),
    }, null, 2))

    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...FAKE_PROVIDER_ENV,
        ONETHING_STORE_PATH: storeF,
        ONETHING_SERVER_DATA_ROOT: storeF,
        ONETHING_SERVER_HOST: '127.0.0.1',
        ONETHING_SERVER_PORT: '',
        // 代理只许从**设置**走(见段首)。镜像站是环境变量那条既有逃生口,照传。
        HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', ALL_PROXY: '',
        ...(endpoint !== '' ? { HF_ENDPOINT: endpoint } : {}),
        ONETHING_SEARCH_EMBEDDER: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = []
    server.stdout.on('data', chunk => out.push(chunk.toString()))
    server.stderr.on('data', chunk => out.push(chunk.toString()))

    const discovery = await waitForDiscovery(storeF)
    const rpc = createRpc(discovery)

    /*
     * 两条原文各进一间会话,查询句与各自原文**零词重叠** —— 词法严格档捞不着,
     * 命中只可能来自向量路。判据与 ⑧ 同一条:**各回各家**(KNN 没有下限,所以判的是
     * 区分度,不是「不相关的不该命中」)。
     */
    const CASES = [
      { content: '身份牌已经私发四人了,狼人那一组今晚先动手。', query: '这局游戏怎么分配角色' },
      { content: '明天上午的机票改签到下午三点,酒店那边我已经打过电话。', query: '出行安排变动了' },
    ]
    for (const item of CASES) {
      const made = await rpc('sessions', 'create', { name: `真嵌入器门 ${MARKER}` })
      item.sessionId = made?.session?.id
      if (!item.sessionId) throw new Error(`⑫ sessions.create 没给出会话 id:${JSON.stringify(made)}`)
      await rpc('session-command', 'emit', {
        sessionId: item.sessionId,
        command: { type: 'command:send-message', content: item.content, suppressTitleGeneration: true },
      })
    }

    /*
     * **先下模型,再等它生效**(2026-09-17 那一刀之后的流程)。开关开着不再等于开始
     * 下载 —— 那一格现在只说「要不要用」,下载是这一发 RPC。
     *
     * 下完之后**不用再翻一次开关**:Worker 把「落定了」喊回宿主,装配在开关本来就开着
     * 时换一条 Worker(`wiring/search/index.ts`)。所以下面那条等待既是「真模型装得起来」
     * 的判据,也是「下完就生效」这条链的真机证据。
     */
    const already = (await rpc('search', 'status'))?.model?.state
    if (already !== 'ready') {
      const kicked = await rpc('search', 'semanticModelDownload', {})
      check(kicked?.success === true, `⑫ 起了一发下载(读到 ${JSON.stringify(kicked?.model?.state)})`)
    }
    // 第一趟要下 130MB,所以这条等待是分钟级的(缺省 15 分钟封顶)。
    const downloaded = await waitForStatus(rpc, status => status?.model?.state === 'ready',
      '真模型下全', timeoutMs)
    check(true, `⑫ 模型下到 ready(${(downloaded.ms / 1000).toFixed(1)}s;`
      + `${Math.round((downloaded.status?.model?.totalBytes ?? 0) / 1e6)} MB)`)

    const ready = await waitForStatus(rpc, status =>
      status?.vector === 'ready' && (status?.vectorPending ?? 1) === 0 && (status?.pending ?? 1) === 0,
    "真模型装好、嵌完(下完自动生效,没有再翻开关)", timeoutMs)
    check(true, `⑫ status.vector 走到 ready(${(ready.ms / 1000).toFixed(1)}s;走过 ${[...ready.seen].join(' → ')})`)
    /*
     * **「一路没关过」那条断言退役了**(2026-09-17):冷跑时开关开着而模型还没下,
     * 第一条 Worker 本来就该翻 `'off'`(原因码 `'model'`)—— 那是这一批要的行为,不是
     * 回归。现在判的是**落定那一刻**:没有残留的死因。
     */
    check(ready.status?.vectorErrorKind === undefined && ready.status?.vectorError === undefined,
      `⑫ 走到 ready 之后没有残留死因(读到 ${JSON.stringify(ready.status?.vectorErrorKind)} / ${JSON.stringify(ready.status?.vectorError)})`)

    for (const item of CASES) {
      const page = await rpc('search', 'query', { query: item.query, category: 'messages', limit: 10 })
      const results = page?.results ?? []
      const rank = results.findIndex(result => result.sessionId === item.sessionId)
      check(rank === 0,
        `⑫ 零词重叠的改写句「${item.query}」把自己那条排第一(名次 ${rank},共 ${results.length} 条)`)
    }

    /*
     * ── ⑫b 认领:删掉清单、换一条 Worker → 自己认回 `ready`,**零网络** ────────
     *
     * 2026-09-17 下午的事故就是这一形:上一版下全了 113 MB,这一版把判据换成清单,
     * 于是那份真下全了的模型被当成没下过(用户原话「为什么下载了也当做没下载?」)。
     * 这里把现场还原出来 —— 把清单删掉就是「文件在、清单不在」——
     * 再把代理指到一个**连不上的口**:认领只准读本地,所以它照样要走到 `ready`。
     *
     * 「装不上就不认领」那一半由 ⑬e(假站那份零填 onnx)与单测守。
     */
    const manifestPath = path.join(storeF, 'models', 'embeddings', 'multilingual-e5-small',
      // 清单文件名,`embedding/model-store.ts` 的 `MODEL_MANIFEST_FILE`。
      '.onething-model.json')
    check(fs.existsSync(manifestPath), '⑫b 下全之后盘上有一份清单(它就是「下全了」这句话)')
    fs.rmSync(manifestPath, { force: true })

    const beforeAdopt = await rpc('settings', 'getSettings')
    const deadProxy = { enabled: true, url: 'http://127.0.0.1:1', bypassRules: '' }
    // 关开关 = 换一条 Worker;顺手把代理指死 —— 认领要是偷偷出网,这一步就走不到 ready。
    const offed = await rpc('settings', 'saveSettings', {
      ...beforeAdopt.settings,
      network: { ...beforeAdopt.settings?.network, proxy: deadProxy },
      search: { ...beforeAdopt.settings?.search, semantic: { ...beforeAdopt.settings?.search?.semantic, enabled: false } },
    })
    if (offed?.success !== true) throw new Error(`⑫b settings.saveSettings 未成功:${JSON.stringify(offed)}`)
    const readopted = await waitForStatus(rpc, status => status?.model?.state === 'ready',
      '清单没了也认得回来(只读本地)', 120_000)
    check(true, `⑫b 认领回 ready(${(readopted.ms / 1000).toFixed(1)}s;`
      + `${Math.round((readopted.status?.model?.totalBytes ?? 0) / 1e6)} MB)`)
    check(fs.existsSync(manifestPath), '⑫b 认领把清单补了回来')

    // 再把开关打开:模型就在本地,代理死着也照样走到 ready。
    const nowSettings = await rpc('settings', 'getSettings')
    const backOn = await rpc('settings', 'saveSettings', {
      ...nowSettings.settings,
      search: { ...nowSettings.settings?.search, semantic: { ...nowSettings.settings?.search?.semantic, enabled: true } },
    })
    if (backOn?.success !== true) throw new Error(`⑫b settings.saveSettings 未成功:${JSON.stringify(backOn)}`)
    /*
     * **判据是那句改写句,不是 `vector === 'ready'`**:文档在上一段早就嵌完了,新
     * Worker 没有待嵌的东西,于是 `vectorState` 一直停在开局的 `'downloading'`
     * ——「没活干」与「没装上」在那一格上长得一样(第一版这一条就是这么卡住 120s 的)。
     * 一句零词重叠的改写句要命中,查询侧必须真的把它嵌出来,所以它才是判据。
     */
    const liveAgain = await waitForStatus(rpc, status =>
      status?.vector !== 'off' && status?.model?.state === 'ready',
    '认领回来之后语义召回重新装上', 120_000)
    check(true, `⑫b 认领之后语义召回重新装上(${(liveAgain.ms / 1000).toFixed(1)}s,全程代理指着一个连不上的口)`)
    const readopted0 = CASES[0]
    const againPage = await rpc('search', 'query', { query: readopted0.query, category: 'messages', limit: 10 })
    const againRank = (againPage?.results ?? []).findIndex(result => result.sessionId === readopted0.sessionId)
    check(againRank === 0,
      `⑫b 认领之后那句零词重叠的改写句照样排第一(名次 ${againRank},共 ${(againPage?.results ?? []).length} 条)`)

    if (failures.length > 0) {
      console.error(`[gate:search-index] ⑫ server 输出尾:\n${out.slice(-40).join('')}`)
    }
  } catch (error) {
    failures.push(String(error?.stack || error))
    console.error(`[gate:search-index] ⑫ ${error?.stack || error}`)
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      await sleep(1500)
      try { server.kill('SIGKILL') } catch { /* 已经没了就算了 */ }
    }
    if (provider) provider.close()
    // `models/embeddings` 是软链 —— `rmSync` 删的是链本身,缓存里的模型留着给下一趟。
    fs.rmSync(storeF, { recursive: true, force: true })
  }
}

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
     * `@huggingface/transformers` 只许出现在 `search/embedding/transformers-onnx.ts`
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

/* ═══════════════════ ⑩ 开关保存即生效(自己的一间 store、自己的一条 server)══════
 *
 * 结清 §13 留账「S7 待拍(三)——开关保存后不热生效」。⑧ 证的是「**开着**的时候整条
 * 链是通的」,这一条证的是**另一件事**:从出厂档(关着)起,经 `settings.saveSettings`
 * 打开那一格之后,**不重启这条 server**,`search.status.vector` 就离开了 `'off'`;再关
 * 回去又回到 `'off'`。
 *
 * 为什么必须真机证:换的是一条 `worker_threads` 线程,而单测里的 Worker 是同线程的
 * `MessageChannel`(`wiring/search/__tests__/index-service.test.ts` 判的是装配算术)。
 * 「真起得来第二条线程、而且它开得了同一个库文件」只有产物上跑得出来。
 *
 * **走的是设置那条真路**(`settings.saveSettings` RPC → `settings:changed` →
 * `wiring/search/index.ts` 的那条订阅),不是一个门专用的后门。
 */
async function runSemanticHotApplyPhase() {
  const storeD = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-hotapply-gate-'))
  const paraphrasePath = path.join(repoRoot, 'packages/core/search/__tests__/fixtures/paraphrase.json')
  let server
  let provider
  try {
    console.log(`[gate:search-index] ⑩ temp store: ${storeD}`)
    provider = await startFakeProvider(MOCK_PORT + 3, REPLY_TEXT)
    // **出厂档**:`search` 那一段整个不写 —— 拍点壬 a 的默认关就该是「什么都没说」。
    fs.writeFileSync(path.join(storeD, 'settings.json'), JSON.stringify({
      ai: fakeProviderAiSettings(MOCK_PORT + 3),
      tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
      diagnostics: { enabled: false },
    }, null, 2))

    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...FAKE_PROVIDER_ENV,
        ONETHING_STORE_PATH: storeD,
        ONETHING_SERVER_DATA_ROOT: storeD,
        ONETHING_SERVER_HOST: '127.0.0.1',
        ONETHING_SERVER_PORT: '',
        // 假嵌入器:门不下 110MB 模型(与 ⑧ 同一个口子)。
        ONETHING_SEARCH_EMBEDDER: 'fake',
        ONETHING_SEARCH_EMBEDDER_FAKE_TABLE: paraphrasePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = []
    server.stdout.on('data', chunk => out.push(chunk.toString()))
    server.stderr.on('data', chunk => out.push(chunk.toString()))

    const discovery = await waitForDiscovery(storeD)
    const rpc = createRpc(discovery)

    // 一条会话:换 Worker 前后拿它证「词法路一个字没丢」。
    const made = await rpc('sessions', 'create', { name: `热生效门 ${MARKER}` })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error(`⑩ sessions.create 没给出会话 id:${JSON.stringify(made)}`)
    await rpc('session-command', 'emit', {
      sessionId,
      command: { type: 'command:send-message', content: `身份牌 ${MARKER} 已经私发四人了`, suppressTitleGeneration: true },
    })

    const statusOf = () => rpc('search', 'status')
    const waitForVector = async (predicate, label, timeoutMs = 30_000) => {
      const startedAt = Date.now()
      const seen = new Set()
      let status
      while (Date.now() - startedAt < timeoutMs) {
        status = await statusOf()
        if (status?.vector) seen.add(status.vector)
        else seen.add('(absent)')
        if (predicate(status)) return { status, seen, ms: Date.now() - startedAt }
        await sleep(150)
      }
      throw new Error(`⑩ 等不到「${label}」(走过 ${[...seen].join(' → ')})`)
    }

    const before = await statusOf()
    check(before?.vector === 'off',
      `⑩ 出厂档 status.vector 是 'off'(读到 ${JSON.stringify(before?.vector)})`)
    check(before?.vectorExtension === 'loadable',
      `⑩ 出厂档扩展照旧装得上(读到 ${JSON.stringify(before?.vectorExtension)})`)

    /** 只改 `search.semantic.enabled` 那一格,别的原样写回(与设置页同一条纪律)。 */
    const setSemantic = async enabled => {
      const current = await rpc('settings', 'getSettings')
      if (!current?.settings) throw new Error('⑩ settings.getSettings 没给出设置')
      const saved = await rpc('settings', 'saveSettings', {
        ...current.settings,
        search: { ...current.settings.search, semantic: { enabled, modelId: 'fake' } },
      })
      if (saved?.success !== true) throw new Error(`⑩ settings.saveSettings 未成功:${JSON.stringify(saved)}`)
    }

    // ── 关 → 开:**不重启**这条 server ────────────────────────────────────
    await setSemantic(true)
    const on = await waitForVector(status => status?.vector !== 'off', "开关打开后离开 'off'")
    check(true, `⑩ 保存即生效:${on.ms}ms 内 status.vector 离开 'off'(走过 ${[...on.seen].join(' → ')})`)
    check(on.status?.mode === 'owner',
      `⑩ 换 Worker 之后索引仍是写者(mode = ${JSON.stringify(on.status?.mode)})`)

    // 词法路一个字没丢 —— 换的只是 Worker,库文件还是那一个。
    const lexical = await (async () => {
      const startedAt = Date.now()
      while (Date.now() - startedAt < 10_000) {
        const page = await rpc('search', 'query', { query: MARKER, category: 'messages', limit: 10 })
        if ((page?.results ?? []).some(result => result.sessionId === sessionId)) {
          return { ok: true, ms: Date.now() - startedAt }
        }
        await sleep(150)
      }
      return { ok: false, ms: Date.now() - startedAt }
    })()
    check(lexical.ok, `⑩ 换 Worker 之后词法路照答(${lexical.ms}ms 内命中那条消息)`)

    // ── 开 → 关:回到 'off',而且向量表留着(下次开省一次重嵌)────────────
    await setSemantic(false)
    const off = await waitForVector(status => status?.vector === 'off', "关回去之后回到 'off'")
    check(true, `⑩ 关回去:${off.ms}ms 内 status.vector 回到 'off'`)
    check((off.status?.vectorPending ?? 0) === 0,
      `⑩ 关着的时候没有在排队的嵌入(读到 ${JSON.stringify(off.status?.vectorPending)})`)
    check(fs.existsSync(path.join(storeD, 'index', 'search.v1.sqlite')),
      '⑩ 换过两次 Worker,库文件还是那一个(没有被丢掉重建)')

    if (failures.length > 0) {
      console.error(`[gate:search-index] ⑩ server 输出尾:\n${out.slice(-40).join('')}`)
    }
  } catch (error) {
    failures.push(String(error?.stack || error))
    console.error(`[gate:search-index] ⑩ ${error?.stack || error}`)
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      await sleep(1500)
      try { server.kill('SIGKILL') } catch { /* 已经没了就算了 */ }
    }
    if (provider) provider.close()
    fs.rmSync(storeD, { recursive: true, force: true })
  }
}
