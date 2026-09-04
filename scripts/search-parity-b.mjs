#!/usr/bin/env bun
/**
 * `search:parity-B` —— 检索重建 **S3 的对账门**
 * (`docs/design/search-index-2026-09.md` §10 S3 行 / §11 S3 / §13「parity-B 的差集口径」)。
 *
 *   bun run search:parity-B [--queries N] [--sessions N] [--limit N] [--json] [--verbose]
 *
 * 断言一句话:
 *
 *   **对 messages / chats / daily 三档,索引路的命中集 ⊇ 旧扫描路的命中集。**
 *
 * parity-A 守的是「一个字都没变」,那道门 S3b 之后只剩还在旧路上的三档;换了索引的
 * 这三档**本来就该变**(旧扫描是子串、全库读盘、归档跳过;索引是词与前缀、由投影建、
 * 归档照收),所以判据从「逐字同」换成 ⊇:**旧路找得到的,新路不许找不到**,而新路
 * 多找到的(归档会话、别的会话里的同词)是 S3 要的改变,不是差。
 *
 * ## 为什么是两条进程,谁跑在哪
 *
 * 索引住一条 `worker_threads` Worker 里,而 Worker 里唯一持有 sqlite 句柄的是
 * `node:sqlite` —— **bun 的运行时没有这个内建模块**(§13 留账,实测
 * `No such built-in module`)。所以:
 *
 *  - **新路**(索引)由**真产物 + node** 答:本脚本 `spawn(process.execPath →` 不,
 *    是 `spawn('node', ['dist/server/main.js'])`,查询走它的 `POST /api/rpc`。这与
 *    `gate:search-index` 是同一条现场,证的也是同一件事:折的是真 FTS,不是替身。
 *  - **旧路**(扫描)由本进程(bun)答:它要 `createOnethingSearchRuntimeAdapters`,
 *    那是 TS 源码 + `?raw` 导入,**node 起不来**(node 的类型剥离不改写
 *    `./x.js → ./x.ts`,而提示词里有 `?raw`)。bun 下索引照旧解析不到 Worker 产物、
 *    如实降级 —— 无害,因为这一侧要的恰好只有旧扫描。
 *
 * 两侧**不同时活着**:先在本进程跑完旧路、`dispose()`,再起 server 跑新路。一间
 * 临时 store 上不会有两个写者。
 *
 * ## 现场
 *
 * 照 parity-A 的复制法(`~/.onething` 只读,会话复制进 `mktemp -d`,跑完删),
 * 同一个封顶(单间 3 MiB / 总量 `MAX_COPY_BYTES`)。查询集也是 parity-A 那份生成法
 * (同一个种子 `0x5ea2c4`、同一套配比),**去掉 `/` 与 `>` 开头的那两类** —— 它们是
 * `actions` / 命令面板的意图前缀,与这三档无关。会话标题直接读临时 store 的
 * `sessions/index.json`(`getSessionsList` 读的就是它),这样查询集在起 server 之前
 * 就定死了。
 *
 * ## 差集怎么分类(§13「parity-B 的差集口径」)
 *
 * 差集 = **旧有新无**。逐条分:
 *
 *  - **(a) 中段子串** —— 查询词是旧路命中文本里某个词元的**中段**(`888` 打中
 *    `00888`)。索引是词与前缀,结构上永远不命中它;这是 §2 拍定的语义,不是漏。
 *    判据:用 core 的 `compositeAnalyzer`(索引与查询共用的那一个)切旧路那条的
 *    `title + subtitle`,查询的某个词元是某个文档词元的子串**且不是任何文档词元的
 *    前缀** → 计入允许差。
 *  - **(b) 需放宽才含** —— 新路的放宽阶梯「有结果即停」(§6.2),严格档答满了就不会
 *    往下试,于是「只有放宽之后才含的那条」不会出现在缺省那一页。`SearchService` 的
 *    请求面上**没有 ladder 这一格**(它是 `fanout` 内部逐级填的),所以这里用契约里
 *    有的东西复核:把查询**收到那条命中自己的会话上**(`filters.sessionId`)再问一遍
 *    —— 候选池只剩那一间,严格档零命中就会自然放宽,含了即证「放宽才含」。单独计数,
 *    **不算红**。
 *  - **(c) 其余** —— **红**,逐条打印 `category / query / key / 旧路那条的标题与摘要 /
 *    新路对同一 key 的最佳阶梯`。
 *
 * **两侧都截断的那些查询不进判据**:旧 `searchMessages` 攒够 `limit` 就整体 break
 * (按会话表次序),新路是按分排序后切页 —— 同一个 500 切在不同的位置上,比的就成了
 * 「谁被截断了」而不是「命中集含不含」。所以任一侧答满 `--limit` 的那条查询记为
 * `truncated` 单独计数并跳过(与 parity-A 的 `ALL_PARITY_LIMIT` 是同一条理由)。
 *
 * ## 反方向的那一格只计数不判
 *
 * 归档会话:旧 `searchChats` / `searchMessages` 有一句 `if (isArchived) continue`,
 * 索引照建文档(拍点丙 a:搜得到带徽)。这是**新有旧无**,不进差集;打印
 * `archivedOnlyInIndex` 一格,让这条已裁的可感知变化在门里有个读数。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

/** parity-A 的 200 条同一份生成法;`/` 与 `>` 两类生成之后被滤掉。 */
const QUERY_COUNT = Number(value('queries', '200'))
const SESSION_COUNT = Number(value('sessions', '150'))
/** 比命中集不比截断:两边都放开到装不满为止。 */
const LIMIT = Number(value('limit', '500'))
const AS_JSON = flag('json')
const VERBOSE = flag('verbose')

/** 复制封顶 —— 与 parity-A 同一个数。 */
const MAX_COPY_BYTES = 160 * 1024 * 1024

/** 换了索引的那三档。`all` 不在这道门里(它由 parity-A 守旧那三组)。 */
const CATEGORIES = ['messages', 'chats', 'daily']

/** 每条查询最多复核几条缺席命中(「需放宽才含」那一问要各发一次 HTTP)。 */
const RELAX_PROBE_PER_QUERY = 5

const serverEntry = path.join(root, 'dist/server/main.js')
const workerEntry = path.join(root, 'dist/server/search-worker.cjs')

const sourceStore = process.env.ONETHING_PARITY_SOURCE_STORE
  ?? path.join(os.homedir(), '.onething')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/*
 * **这个脚本本身必须跑在 bun 下**(索引那一半由它 spawn 出来的 node 跑,见文件头)。
 * 在 node 下起会在 `import('@onething/backend')` 那一行炸成一句难认的
 * `Cannot find module …/store.js` —— node 的类型剥离不改写 `./x.js → ./x.ts`。
 * 与其让人去猜,不如当场说清楚。
 */
if (typeof Bun === 'undefined') {
  console.error('[search:parity-B] 这道门要用 bun 起:`bun run search:parity-B`。')
  console.error('  旧扫描那一半要 TS 源码 + `?raw` 导入,node 起不来;索引那一半由本脚本'
    + ' spawn 一个 node 跑 `dist/server/main.js`(bun 没有 node:sqlite)。')
  process.exit(1)
}

/* ───────────────────────────── 现场:临时 store ───────────────────────────── */

function directorySize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    try {
      total += fs.statSync(path.join(dir, entry.name)).size
    } catch {
      /* 读不到就当 0 —— 这里只是排序用的体积 */
    }
  }
  return total
}

/** 与 parity-A 的 `buildTempStore` 同一条:源只读,单间封顶,带上 index.json。 */
function buildTempStore() {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-parity-b-'))
  const sessionsOut = path.join(store, 'sessions')
  fs.mkdirSync(sessionsOut, { recursive: true })

  const settings = path.join(sourceStore, 'settings.json')
  if (fs.existsSync(settings)) fs.copyFileSync(settings, path.join(store, 'settings.json'))

  const sessionsIn = path.join(sourceStore, 'sessions')
  if (!fs.existsSync(sessionsIn)) throw new Error(`源 store 里没有 sessions/:${sessionsIn}`)

  const candidates = []
  for (const entry of fs.readdirSync(sessionsIn, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'legacy-backup') continue
    const dir = path.join(sessionsIn, entry.name)
    if (!fs.existsSync(path.join(dir, 'meta.json'))) continue
    candidates.push({ id: entry.name, dir, size: directorySize(dir) })
  }

  const PER_SESSION_CAP = 3 * 1024 * 1024
  candidates.sort((a, b) => b.size - a.size)

  let copiedBytes = 0
  let copied = 0
  const kept = new Set()
  for (const candidate of candidates) {
    if (copied >= SESSION_COUNT) break
    if (candidate.size > PER_SESSION_CAP) continue
    if (copiedBytes + candidate.size > MAX_COPY_BYTES) continue
    const out = path.join(sessionsOut, candidate.id)
    fs.mkdirSync(out, { recursive: true })
    for (const file of ['meta.json', 'events.jsonl', 'messages.jsonl']) {
      const from = path.join(candidate.dir, file)
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(out, file))
    }
    const blobs = path.join(candidate.dir, 'blobs')
    if (fs.existsSync(blobs)) fs.cpSync(blobs, path.join(out, 'blobs'), { recursive: true })
    copiedBytes += candidate.size
    copied += 1
    kept.add(candidate.id)
  }

  const indexIn = path.join(sessionsIn, 'index.json')
  let titles = []
  if (fs.existsSync(indexIn)) {
    const all = JSON.parse(fs.readFileSync(indexIn, 'utf-8'))
    const filtered = Array.isArray(all) ? all.filter(meta => kept.has(meta?.id)) : all
    fs.writeFileSync(path.join(sessionsOut, 'index.json'), JSON.stringify(filtered))
    if (Array.isArray(filtered)) titles = filtered.map(meta => meta?.name).filter(Boolean)
  }

  return { store, sessions: copied, bytes: copiedBytes, available: candidates.length, titles }
}

/* ───────────────────────────── 查询集(与 parity-A 同种子)───────────────────── */

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const toFullWidth = text => text.replace(/[!-~]/g, ch =>
  String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).replace(/ /g, '　')

/**
 * parity-A 的 `buildQueries` 逐字同一份(同种子、同配比、同抽法),末尾多一步
 * **滤掉 `/` 与 `>` 两类**。留着同一份生成法是为了两道门读的是同一批查询 ——
 * 它们对同一个语料的同一个 PRNG 序列,滤只滤在最后。
 */
function buildQueries(corpus, sessionTitles) {
  const random = mulberry32(0x5ea2c4)
  const pick = list => list[Math.floor(random() * list.length)] ?? ''

  const latin = new Set()
  const cjk = new Set()
  for (const doc of corpus.docs ?? []) {
    for (const field of [doc.title, doc.content]) {
      if (typeof field !== 'string') continue
      for (const word of field.match(/[A-Za-z][A-Za-z0-9_-]{2,15}/g) ?? []) latin.add(word)
      for (const run of field.match(/[一-龥]{2,4}/g) ?? []) cjk.add(run)
    }
  }
  const latinWords = [...latin]
  const cjkWords = [...cjk]
  const titles = sessionTitles.filter(title => typeof title === 'string' && title.trim().length > 0)

  const budget = {
    slash: Math.round(QUERY_COUNT * 0.10),
    angle: Math.round(QUERY_COUNT * 0.05),
    fullwidth: Math.round(QUERY_COUNT * 0.05),
    latin: Math.round(QUERY_COUNT * 0.20),
  }
  budget.cjk = QUERY_COUNT - budget.slash - budget.angle - budget.fullwidth - budget.latin

  const queries = []
  const push = (kind, text) => queries.push({ kind, text })

  push('slash', '/')
  push('angle', '>')
  for (let i = 1; i < budget.slash; i += 1) push('slash', `/${pick(latinWords)}`)
  for (let i = 1; i < budget.angle; i += 1) push('angle', `>${pick(latinWords)}`)
  for (let i = 0; i < budget.fullwidth; i += 1) push('fullwidth', toFullWidth(pick(latinWords)))
  for (let i = 0; i < budget.latin; i += 1) {
    push('latin', random() < 0.34 && titles.length > 0 ? pick(titles) : pick(latinWords))
  }
  for (let i = 0; i < budget.cjk; i += 1) {
    push('cjk', random() < 0.25 ? `${pick(cjkWords)} ${pick(cjkWords)}` : pick(cjkWords))
  }

  /*
   * **日期形的一小把**(parity-A 没有这一类,这里加)。
   *
   * 理由是防假绿:`daily` 那一档的旧扫描把文件名当可搜文本(`${iso} ${relPath}`),
   * 语料里抽出来的中英词几乎不可能打中一个 `2026-09-05.md`,于是整档两边都是 0 条,
   * ⊇ 在 `[] ⊇ []` 上恒真 —— 那正是 parity-A 的两条防假绿门槛在骂的东西。给这一档
   * 一批**它答得出来**的查询,这道门才真的在守它。
   *
   * 取本月与前十一个月(`YYYY-MM`)加今天的 ISO 与今年:都是**从当天算出来**的,
   * 不写死日期。它们对 messages / chats 同样是合法查询,顺带多几条读数。
   */
  const today = new Date()
  const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  push('date', today.toISOString().slice(0, 10))
  push('date', String(today.getFullYear()))
  for (let back = 0; back < 11; back += 1) {
    push('date', iso(new Date(today.getFullYear(), today.getMonth() - back, 1)))
  }

  // `/` 与 `>` 是 actions / 命令面板的意图前缀,与这三档无关。
  return queries.filter(query =>
    query.text.length > 0 && query.kind !== 'slash' && query.kind !== 'angle')
}

/* ───────────────────────────── 旧路(本进程,bun)───────────────────────────── */

async function collectLegacy(storePath, queries) {
  process.env.ONETHING_STORE_PATH = storePath
  process.env.ONETHING_SESSION_SHADOW = '0'
  // 这一侧**不要**索引:bun 没有 node:sqlite,指了产物只会让 Worker 崩着重起。
  delete process.env.ONETHING_SEARCH_WORKER

  const [{ createOnethingBackend }, providers] = await Promise.all([
    import('@onething/backend'),
    import('@onething/backend/wiring/search/providers.js'),
  ])

  const backend = await createOnethingBackend({
    host: {
      storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
      terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null,
      plugins: null, gateway: null, settings: null, evals: null, mcp: null,
      localTrust: { origin: 'desktop-embedded' },
    },
    toolRegistry: 'headless',
    sender: { on() {}, once() {}, emit() {}, removeListener() {}, isDestroyed: () => false, send() {} },
  })

  const collected = new Map()
  try {
    for (const query of queries) {
      for (const category of CATEGORIES) {
        // `executeSearch` 就是旧路那个入口(`createOnethingSearchProviders` 交出来的
        // 那一只),六路扫描器的唯一产地 —— 与 S2 的 parity-A 吃的是同一份实现。
        const results = await providers.executeSearch(query.text, category, LIMIT)
        collected.set(`${category} ${query.text}`, results ?? [])
      }
    }
  } finally {
    await backend.dispose()
  }
  return collected
}

/* ───────────────────────────── 新路(真产物 + node)─────────────────────────── */

async function waitForDiscovery(storePath, timeoutMs = 60_000) {
  const discoveryFile = path.join(storePath, 'run', 'http.json')
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(discoveryFile)) {
      try {
        const discovery = JSON.parse(fs.readFileSync(discoveryFile, 'utf-8'))
        if (discovery?.port) return discovery
      } catch {
        /* 半写状态,下一拍再读 */
      }
    }
    await sleep(200)
  }
  throw new Error('server did not publish its discovery file in time')
}

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
    if (!body || body.ok !== true) {
      throw new Error(`rpc ${domain}.${method}: ${JSON.stringify(body?.error ?? body)}`)
    }
    return body.data
  }
}

/**
 * 冷建等它追上账本。
 *
 * 判据是 `search.status` 的 **`docs`**(索引里现在有多少份文档)—— 涨到不再涨、且
 * `pending === 0`,连着五拍。
 *
 * 施工时**试错过两版**,两版都在真机上红了,读数留在这里当路标:
 *
 *  ① 光等 `index.stale === false`:发现文件一出现就开始问,头几拍落在「Worker 起来
 *     了、校对还没往队列里放东西」那个窗口里,三拍都答不 stale,于是这道门在一个
 *     **空索引**上开始对账,收尾的稳定性复核当场红(同一条查询前 0 条后 2 条)。
 *  ② 改盯**一枚探针词的 `total`** 涨停:探针词一旦集中在早早折完的那几间会话里,
 *     它的 `total` 会在整份索引才折了一小半的时候就不动了 —— 同样的红。
 *
 * 两次都是同一个错:拿**局部**的量去判**整体**建完没有。`docs` 是全库的、单调的,
 * 这是外面唯一能拿到的诚实判据(它是 S3c 给 `status` 加的那一格)。
 */
async function waitForIndexIdle(rpc, timeoutMs = 15 * 60_000) {
  const startedAt = Date.now()
  let sawWork = false
  let lastDocs = -1
  let stableStreak = 0
  let lastPending = 0
  while (Date.now() - startedAt < timeoutMs) {
    const status = await rpc('search', 'status')
    if (status?.docs === undefined) {
      throw new Error(`search.status 没有 docs 那一格 —— 这台宿主没有索引:${JSON.stringify(status)}`)
    }
    lastPending = status.pending
    if (status.pending > 0) sawWork = true
    if (status.docs !== lastDocs) {
      lastDocs = status.docs
      stableStreak = 0
    } else if (status.pending === 0 && status.docs > 0) {
      stableStreak += 1
      if (stableStreak >= 5) break
    } else {
      stableStreak = 0
    }
    await sleep(200)
  }
  return { ms: Date.now() - startedAt, sawWork, docs: lastDocs, pending: lastPending }
}

async function collectIndexed(rpc, queries) {
  const collected = new Map()
  for (const query of queries) {
    for (const category of CATEGORIES) {
      const response = await rpc('search', 'query', { query: query.text, category, limit: LIMIT })
      collected.set(`${category} ${query.text}`, response?.results ?? [])
    }
  }
  return collected
}

/* ───────────────────────────── 分类 ───────────────────────────── */

/**
 * 一条「旧有新无」为什么新路答不出来 —— 用**索引自己的两件东西**问,不猜。
 *
 *  - `redactText`(`core/search/redact`):索引前的脱敏(§5.2c)。索引看得见的从来
 *    不是原文,是**洗过的那一份**,所以问分析器时问的也必须是洗过的那一份;
 *  - `compositeAnalyzer`:索引与查询共用的那一个分析器(§6.3)。索引问的问题只有
 *    一个 —— 「这个查询词在文档的词表里当得成**前缀**吗」。
 *
 * 于是三种答案:
 *
 *  - `'indexable'` —— 洗过之后每个词仍然当得成前缀:索引**本该**命中它。这一条要么
 *    是「需放宽才含」(由调用方用 `filters.sessionId` 复核),要么就是红。
 *  - `'mid-token'` —— 洗过之后每个词都还在,但至少有一个只当得成**中段**(`888` 打中
 *    `00888`)。§2 拍定的语义,允许差。
 *  - `'unknown'` —— 两条都不是:说不出理由,红。
 *
 * **曾经有过第四种 `'redacted'`,S3c 把它删了**:那一形是「原文里有、洗过之后没了」,
 * S3c 第一版把它当成第三类允许差,而真机跑出来的两条(`translatesAutoresizing…` /
 * `elcc_bot_res_signal_buttonOnly_buttonNumber`)根本不是密钥,是**规则 7 的误伤**。
 * 把误伤记成允许差就是把它合法化 —— 治法是收窄规则(`core/search/redact.ts` 的
 * `isLikelySecretToken`),不是给门开一格。今天真被洗掉的只剩真密钥形,而密钥被洗掉
 * 之后旧路也不该拿它当落点,所以这一格没有合法的居民了:再出现就是红。
 */
function classifyMissing(analyzer, redactText, queryText, hitText) {
  const queryTokens = analyzer.analyze(queryText).map(token => token.text)
  if (queryTokens.length === 0) return 'unknown'
  const visibleTokens = analyzer.analyze(redactText(hitText)).map(token => token.text)

  const prefixOf = (term, tokens) => tokens.some(token => token.startsWith(term))
  const substringOf = (term, tokens) => tokens.some(token => token.includes(term))

  if (queryTokens.every(term => prefixOf(term, visibleTokens))) return 'indexable'
  if (queryTokens.every(term => substringOf(term, visibleTokens))) return 'mid-token'
  return 'unknown'
}

/** 旧路那条命中的可搜文本 —— 摘要(标题)与副标题;命中区间按构造就在里面。 */
const hitTextOf = result => [result?.title, result?.subtitle].filter(Boolean).join(' ')

/* ───────────────────────────── 跑 ───────────────────────────── */

async function main() {
  for (const [label, file] of [['dist/server/main.js', serverEntry],
    ['dist/server/search-worker.cjs', workerEntry]]) {
    if (!fs.existsSync(file)) {
      console.error(`[search:parity-B] 缺 ${label} —— 先在仓根跑 \`bun run server:build\``)
      process.exit(1)
    }
  }

  const prepared = buildTempStore()
  const corpus = JSON.parse(
    fs.readFileSync(path.join(root, 'packages/core/search/__tests__/fixtures/corpus.json'), 'utf-8'),
  )
  const queries = buildQueries(corpus, prepared.titles)
  const { compositeAnalyzer } = await import('@onething/core/search')
  const { redactText } = await import('@onething/core/search/redact')

  const startedAt = Date.now()
  let child
  const rows = new Map(CATEGORIES.map(category => [category, {
    queries: 0, truncated: 0, legacyRows: 0, indexedRows: 0,
    contains: 0, midToken: 0, needsRelax: 0, red: 0, archivedOnlyInIndex: 0,
  }]))
  const reds = []
  const samples = { midToken: undefined, needsRelax: undefined }
  let cold = { ms: 0, sawWork: false, pending: 0 }
  let indexSizeBytes = 0

  try {
    // ── ① 旧路先跑完(本进程),再彻底放手 ────────────────────────────
    const legacyStartedAt = Date.now()
    const legacy = await collectLegacy(prepared.store, queries)
    const legacyMs = Date.now() - legacyStartedAt

    // ── ② 起真产物,等索引追上账本 ────────────────────────────────────
    child = spawn('node', [serverEntry], {
      cwd: root,
      env: {
        ...process.env,
        ONETHING_STORE_PATH: prepared.store,
        ONETHING_SERVER_DATA_ROOT: prepared.store,
        ONETHING_SERVER_HOST: '127.0.0.1',
        ONETHING_SERVER_PORT: '',
        ONETHING_SESSION_SHADOW: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverOut = []
    child.stdout.on('data', chunk => serverOut.push(chunk.toString()))
    child.stderr.on('data', chunk => serverOut.push(chunk.toString()))

    const discovery = await waitForDiscovery(prepared.store)
    const rpc = createRpc(discovery)
    const status = await rpc('search', 'status')
    if (status?.mode !== 'owner') {
      throw new Error(`索引没起来:search.status = ${JSON.stringify(status)}\n${serverOut.slice(-20).join('')}`)
    }
    cold = await waitForIndexIdle(rpc)

    const indexPath = path.join(prepared.store, 'index', 'search.v1.sqlite')
    indexSizeBytes = fs.existsSync(indexPath) ? fs.statSync(indexPath).size : 0

    // ── ③ 新路跑同一批查询 ────────────────────────────────────────────
    const indexedStartedAt = Date.now()
    const indexed = await collectIndexed(rpc, queries)
    const indexedMs = Date.now() - indexedStartedAt

    /*
     * 「比得太早了吗」的复核。
     *
     * `waitForIndexIdle` 等的是 `index.stale`,而 `stale` 是索引**自己报**的 ——
     * 拿它当唯一判据就是「拿自己证自己」。所以跑完整批之后,抽头 15 条查询**再问
     * 一遍**,命中集逐字相同才算这份读数是在一个稳定的索引上取的:还在填的索引会
     * 在这一步答出不同的集合。
     */
    for (const query of queries.slice(0, 15)) {
      const again = await rpc('search', 'query', { query: query.text, category: 'messages', limit: LIMIT })
      const first = indexed.get(`messages ${query.text}`) ?? []
      const second = again?.results ?? []
      const before = first.map(result => result?.id).join('\n')
      const after = second.map(result => result?.id).join('\n')
      if (before !== after) {
        const firstIds = new Set(first.map(result => result?.id))
        const secondIds = new Set(second.map(result => result?.id))
        const appeared = second.filter(result => !firstIds.has(result?.id))
        const vanished = first.filter(result => !secondIds.has(result?.id))
        for (const row of appeared) console.error(`  后来才有: ${row?.id} ${JSON.stringify(row?.title)?.slice(0, 120)}`)
        for (const row of vanished) console.error(`  后来没了: ${row?.id} ${JSON.stringify(row?.title)?.slice(0, 120)}`)
        throw new Error(`索引在对账期间还在变(query=${JSON.stringify(query.text)}):`
          + `前 ${first.length} 条 / 后 ${second.length} 条 —— 不认这次读数`)
      }
    }

    // ── ④ 逐条比 ──────────────────────────────────────────────────────
    for (const query of queries) {
      for (const category of CATEGORIES) {
        const key = `${category} ${query.text}`
        const legacyRows = legacy.get(key) ?? []
        const indexedRows = indexed.get(key) ?? []
        const row = rows.get(category)
        row.queries += 1
        row.legacyRows += legacyRows.length
        row.indexedRows += indexedRows.length
        row.archivedOnlyInIndex += indexedRows.filter(r => r?.facets?.archived === true).length

        // 两边都放开到 LIMIT;任一侧答满了就是「被截断」,⊇ 在这一条上判不出来。
        if (legacyRows.length >= LIMIT || indexedRows.length >= LIMIT) {
          row.truncated += 1
          continue
        }

        const indexedIds = new Set(indexedRows.map(result => result?.id))
        const missing = legacyRows.filter(result => !indexedIds.has(result?.id))
        if (missing.length === 0) {
          row.contains += 1
          continue
        }

        let probes = 0
        for (const miss of missing) {
          const verdict = classifyMissing(compositeAnalyzer, redactText, query.text, hitTextOf(miss))
          if (verdict === 'mid-token') {
            row.midToken += 1
            samples.midToken ??= { category, query: query.text, id: miss.id, title: miss.title }
            continue
          }
          // 「需放宽才含」:把查询收到这条命中自己的会话上再问一次 —— 候选池只剩
          // 那一间,严格档零命中就会自然放宽(§6.2「有结果即停」)。
          const scope = miss?.sessionId
          if (scope !== undefined && category !== 'daily' && probes < RELAX_PROBE_PER_QUERY) {
            probes += 1
            let scoped
            try {
              scoped = await rpc('search', 'query', {
                query: query.text, category, limit: LIMIT, filters: { sessionId: scope },
              })
            } catch {
              scoped = undefined
            }
            if ((scoped?.results ?? []).some(result => result?.id === miss?.id)) {
              row.needsRelax += 1
              samples.needsRelax ??= {
                category, query: query.text, id: miss.id, relaxed: scoped?.relaxed,
              }
              continue
            }
          }
          row.red += 1
          reds.push({
            category,
            query: query.text,
            kind: query.kind,
            key: miss?.id,
            verdict,
            legacyTitle: miss?.title,
            legacySubtitle: miss?.subtitle,
            legacyCount: legacyRows.length,
            indexedCount: indexedRows.length,
          })
        }
      }
    }

    if (!AS_JSON) {
      console.log(`[search:parity-B] 旧路 ${(legacyMs / 1000).toFixed(1)}s / 新路 `
        + `${(indexedMs / 1000).toFixed(1)}s;冷建 ${(cold.ms / 1000).toFixed(1)}s`
        + `(${cold.docs} 份文档,见过在忙 ${cold.sawWork});`
        + `库 ${(indexSizeBytes / 1048576).toFixed(1)} MiB`)
    }
    if (reds.length > 0) {
      console.error(`[search:parity-B] server 输出尾:\n${serverOut.slice(-20).join('')}`)
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      for (let i = 0; i < 60 && child.exitCode === null && child.signalCode === null; i += 1) {
        await sleep(100)
      }
      try { child.kill('SIGKILL') } catch { /* 已经没了就算了 */ }
    }
    fs.rmSync(prepared.store, { recursive: true, force: true })
  }

  const totals = {
    queries: 0, truncated: 0, legacyRows: 0, indexedRows: 0, contains: 0,
    midToken: 0, needsRelax: 0, red: 0, archivedOnlyInIndex: 0,
  }
  for (const row of rows.values()) for (const k of Object.keys(totals)) totals[k] += row[k]

  const summary = {
    store: { sessions: prepared.sessions, availableSessions: prepared.available, bytes: prepared.bytes },
    queries: queries.length,
    limit: LIMIT,
    coldBuildMs: cold.ms,
    indexDocs: cold.docs,
    indexBytes: indexSizeBytes,
    perCategory: Object.fromEntries([...rows].map(([category, row]) => [category, row])),
    totals,
    tookMs: Date.now() - startedAt,
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ ...summary, reds: reds.slice(0, 50), samples }, null, 2))
  } else {
    console.log(`[search:parity-B] 临时 store: ${prepared.sessions}/${prepared.available} 会话,`
      + `${(prepared.bytes / 1048576).toFixed(1)} MiB;${queries.length} 条查询 × ${CATEGORIES.length} 档`)
    const pad = (text, width) => String(text).padStart(width)
    console.log('  档         查询  旧命中  新命中   ⊇成立  中段子串  需放宽  截断跳过    红  归档(仅新)')
    for (const [category, row] of rows) {
      console.log(`  ${category.padEnd(9)}${pad(row.queries, 5)}${pad(row.legacyRows, 8)}`
        + `${pad(row.indexedRows, 8)}${pad(row.contains, 8)}${pad(row.midToken, 10)}`
        + `${pad(row.needsRelax, 8)}${pad(row.truncated, 10)}`
        + `${pad(row.red, 6)}${pad(row.archivedOnlyInIndex, 12)}`)
    }
    /*
     * 两侧都是 0 条的那一档,⊇ 是**平凡真** —— 说出来,别让读的人以为它被守住了。
     * 这台机器上 `daily` 就是这样:`resolveDailyNoteSearchDirs()` 答 `[]`(设置里
     * `general.dailyNotes.useObsidianConfig` 开着但 Obsidian 的配置解不出目录),
     * 于是新旧两条路都没有笔记可搜。
     */
    for (const [category, row] of rows) {
      if (row.legacyRows === 0 && row.indexedRows === 0) {
        console.log(`  注意:${category} 档两侧都是 0 条 —— ⊇ 在这一档是平凡真,这次没守住它`)
      }
    }
    if (samples.midToken) console.log(`  例(中段子串):${JSON.stringify(samples.midToken)}`)
    if (samples.needsRelax) console.log(`  例(需放宽才含):${JSON.stringify(samples.needsRelax)}`)
    for (const red of reds.slice(0, VERBOSE ? reds.length : 20)) {
      console.log(`[search:parity-B] failed: category=${red.category} query=${JSON.stringify(red.query)} `
        + `verdict=${red.verdict} key=${red.key}(旧 ${red.legacyCount} 条 / 新 ${red.indexedCount} 条)`)
      console.log(`  旧路那条: ${JSON.stringify(red.legacyTitle)} / ${JSON.stringify(red.legacySubtitle)}`)
    }
    console.log(reds.length === 0
      ? '[search:parity-B] ok: 索引命中集 ⊇ 旧扫描命中集'
      : `[search:parity-B] ${reds.length} 条旧路命中在索引里找不到,且不是「中段子串」也不是「需放宽才含」`)
  }

  /*
   * 防假绿三条(与 parity-A 同款)。
   *
   * ③(「索引对账期间没在变」)不在这里 —— 它在上面那段复核里,**跑不过就抛**,
   * 因为它一旦不成立,下面这些数字本身就没有意义,不该被拿去算通过率。
   */
  if (totals.legacyRows < queries.length) {
    console.error(`[search:parity-B] failed: 旧路只答出 ${totals.legacyRows} 条(下限 ${queries.length})`
      + ' —— 现场没搭起来,不认这次绿')
    process.exit(1)
  }
  if (totals.indexedRows < queries.length) {
    console.error(`[search:parity-B] failed: 索引路只答出 ${totals.indexedRows} 条(下限 ${queries.length})`
      + ' —— 索引没建起来,不认这次绿')
    process.exit(1)
  }
  if (totals.contains + totals.truncated === 0) {
    console.error('[search:parity-B] failed: 一条查询都没进判据 —— 不认这次绿')
    process.exit(1)
  }
  process.exit(reds.length === 0 ? 0 : 1)
}

main().catch(error => {
  console.error('[search:parity-B] crashed:', error)
  // 现场清干净比退出码重要:临时 store 已在 finally 里删,残留进程再扫一遍。
  spawnSync('pkill', ['-f', serverEntry])
  process.exit(1)
})
