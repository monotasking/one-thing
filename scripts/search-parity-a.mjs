#!/usr/bin/env bun
/**
 * `search:parity-A` —— 检索重建 **S2 的对账门**
 * (`docs/design/search-index-2026-09.md` §10 S2 行 / §11 S2)。
 *
 *   bun run search:parity-A [--queries N] [--sessions N] [--json] [--verbose]
 *
 * 断言一句话:
 *
 *   **新路(`SearchService` + 六个能力)与旧路(`executeOnethingSearchForIpc`)
 *   对同一条查询、同一档,`results` 逐字节相同。**
 *
 * S2 是「能力包装,行为零变化」那一期,所以这道门守的不是「新路更好」,而是
 * 「新路一个字都没变」。有差就红,并打印 `category / query / 第几条 / 两边那一条`。
 *
 * ## 怎么造现场
 *
 *  - **不在真店上装配**(它会写日志、抢锁):`~/.onething` 里的 `settings.json` 与
 *    一批会话目录(`meta.json` + `events.jsonl`)**复制**进一个临时 store,
 *    `ONETHING_STORE_PATH` 指过去,跑完删掉。源只读。
 *  - 会话取**多少**由 `--sessions` 定(缺省 150,按体积从大到小取、单间封顶 3 MiB、
 *    总量封顶 `MAX_COPY_BYTES`)——全库 1.6G,而今天这条路每次 `searchMessages` 都要
 *    把库翻一遍(那正是 S3 要治的病根),全量跑这道门要按小时算。取样是**有意的取舍**:
 *    门守的是「两条路一致」,不是「召回率」,而两条路吃的是同一份取样。
 *  - 查询 200 条,从 S0 那份脱敏语料(`packages/core/search/__tests__/fixtures/corpus.json`)
 *    的标题与正文里抽,配比按派工单:`/` 开头 20、`>` 开头 10、全角 10、英文 40、
 *    其余中文。抽样用固定种子的 PRNG,所以每次跑的是同一批查询。
 *
 * ## 比什么
 *
 * 只比 `results`,而且把新路多出来的 `target` / `facets` 先剥掉 —— **parity 只守旧形**。
 * 新加的 `total` / `groups` / `cursor` / `relaxed` / `index` 是 §8「只加不改」的加法,
 * 不在这道门的判据里(它们由单测与 S4 的壳门守)。
 *
 * ## S3b 之后这道门只剩三档(2026-09-05)
 *
 * S3b 把 **chats / messages / daily** 换成了索引型能力(FTS5 + 账本投影)。它们与旧
 * 扫描**不该**逐字同,那正是 S3 要的改变:旧扫描是子串匹配、全库读盘、归档会话直接
 * 跳过;索引是词与前缀、由投影建、归档照样收录(§13 留账「中段子串」那一条)。拿
 * 「逐字同」去卡它们等于禁止 S3 发生。
 *
 * 所以判据在这里**分家**,与 §10 的分期一致:
 *
 *  - 这道门(parity-A)继续守**还在旧路上的三档** `files` / `actions` / `prompts`
 *    —— 它们 S3b 一个字没动,任何差都是回归;
 *  - 换索引那三档交给 **S3c 的 `search:parity-B`**,判据是 ⊇(索引严格档命中集包含
 *    旧扫描命中集,残差逐条打印并分类)。
 *
 * `all` 档仍然比,但**只比这三组**(按 `type` 过滤),并且两边都用一个大 limit 跑:
 * 旧路的 `all` 是「各类拼起来再切到 limit」,新路少了三类、切的位置就不一样,不放开
 * limit 的话比的是「谁被截断了」而不是「这三组一样不一样」。
 *
 * **在 bun 下跑这道门时索引根本没起来**(bun 的运行时没有 `node:sqlite`,而且
 * `search-worker.cjs` 不在 `scripts/` 旁边),`createAppSearchService` 于是如实降级成
 * 「索引不可用」。这对本门无害 —— 被降级的正是已经不在判据里的那三档。
 */
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

const QUERY_COUNT = Number(value('queries', '200'))
const SESSION_COUNT = Number(value('sessions', '150'))
const AS_JSON = flag('json')
const VERBOSE = flag('verbose')

/** 复制封顶:再多就不是「取样」而是「搬家」了。 */
const MAX_COPY_BYTES = 160 * 1024 * 1024

/**
 * 还在旧扫描 / 静态表上的那三档 + `all`。chats / messages / daily 换索引之后不在这
 * 道门里(见文件头「S3b 之后这道门只剩三档」)。`all` 排最后,它最贵。
 */
const CATEGORIES = ['actions', 'files', 'prompts', 'all']

/** `all` 档里属于这三档的结果类型 —— 过滤用。 */
const LEGACY_RESULT_TYPES = new Set(['action', 'file', 'prompt'])

/**
 * `all` 档两边都用这个 limit 跑。旧路的 `all` 是「各类拼起来再 `slice(0, limit)`」,
 * 新路少了三类,同一个 20 切在不同的位置上 —— 放开到装不满为止,比的才是这三组本身。
 */
const ALL_PARITY_LIMIT = 500

const sourceStore = process.env.ONETHING_PARITY_SOURCE_STORE
  ?? path.join(os.homedir(), '.onething')

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

function buildTempStore() {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-parity-'))
  const sessionsOut = path.join(store, 'sessions')
  fs.mkdirSync(sessionsOut, { recursive: true })

  const settings = path.join(sourceStore, 'settings.json')
  if (fs.existsSync(settings)) fs.copyFileSync(settings, path.join(store, 'settings.json'))

  const sessionsIn = path.join(sourceStore, 'sessions')
  if (!fs.existsSync(sessionsIn)) {
    throw new Error(`源 store 里没有 sessions/:${sessionsIn}`)
  }

  const candidates = []
  for (const entry of fs.readdirSync(sessionsIn, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'legacy-backup') continue
    const dir = path.join(sessionsIn, entry.name)
    if (!fs.existsSync(path.join(dir, 'meta.json'))) continue
    candidates.push({ id: entry.name, dir, size: directorySize(dir) })
  }
  /*
   * 体积从大到小取,但先把「一个人就吃掉整份预算」的那几间挑出去(> PER_SESSION_CAP)。
   * 为什么不取最小的那批:最小的会话正文接近空,取出来这道门会在一堆零命中上绿 ——
   * 那是假绿。要的是**有内容**的会话,同时把总量压在预算里。
   */
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

  /*
   * `sessions/index.json` 是会话清单的**唯一来源**(`getSessionsList` 读它);
   * 不带上它,临时 store 里就是「一间会话都没有」—— 这道门会在一片空结果上绿。
   * 只留真的复制过来的那几间,免得 chats 命中一间连正文都不在的会话。
   */
  const indexIn = path.join(sessionsIn, 'index.json')
  if (fs.existsSync(indexIn)) {
    const all = JSON.parse(fs.readFileSync(indexIn, 'utf-8'))
    fs.writeFileSync(
      path.join(sessionsOut, 'index.json'),
      JSON.stringify(Array.isArray(all) ? all.filter(meta => kept.has(meta?.id)) : all),
    )
  }

  return { store, sessions: copied, bytes: copiedBytes, available: candidates.length }
}

/* ───────────────────────────── 查询集(固定种子)───────────────────────────── */

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

  /*
   * 头两条是**光杆前缀**,不是凑数的。
   *
   * `actions` 的配额按意图翻倍(4 → 8,§7.1)只有在「命中的命令超过 4 条」时才看得见,
   * 而 `/xxx` 里的 xxx 一旦不匹配任何命令名,两边都是 0 条 —— 施工时实测过:光带
   * `/词` 的查询集,把 `whenIntent` 摘掉这道门照样绿。光杆 `/` 与 `>` 让全表都命中,
   * 配额那一格才真的进了判据。
   */
  push('slash', '/')
  push('angle', '>')
  for (let i = 1; i < budget.slash; i += 1) push('slash', `/${pick(latinWords)}`)
  for (let i = 1; i < budget.angle; i += 1) push('angle', `>${pick(latinWords)}`)
  for (let i = 0; i < budget.fullwidth; i += 1) push('fullwidth', toFullWidth(pick(latinWords)))
  for (let i = 0; i < budget.latin; i += 1) {
    // 三分之一取会话标题(真实的「我想找那次对话」形),其余取语料词。
    push('latin', random() < 0.34 && titles.length > 0 ? pick(titles) : pick(latinWords))
  }
  for (let i = 0; i < budget.cjk; i += 1) {
    push('cjk', random() < 0.25
      ? `${pick(cjkWords)} ${pick(cjkWords)}`
      : pick(cjkWords))
  }
  return queries.filter(query => query.text.length > 0)
}

/* ───────────────────────────── 比对 ───────────────────────────── */

/** 剥掉新路多出来的两格 —— parity 只守旧形(§8 是「只加不改」)。 */
function stripAdditions(results) {
  return (results ?? []).map(result => {
    const copy = { ...result }
    delete copy.target
    delete copy.facets
    return copy
  })
}

function firstDifference(left, right) {
  const max = Math.max(left.length, right.length)
  for (let index = 0; index < max; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) return index
  }
  return -1
}

/* ───────────────────────────── 跑 ───────────────────────────── */

async function main() {
  const prepared = buildTempStore()
  process.env.ONETHING_STORE_PATH = prepared.store
  // 影子核验会往临时 store 里写统计,这道门只读搜索面,关掉省事。
  process.env.ONETHING_SESSION_SHADOW = '0'

  const corpus = JSON.parse(
    fs.readFileSync(path.join(root, 'packages/core/search/__tests__/fixtures/corpus.json'), 'utf-8'),
  )

  const startedAt = Date.now()
  let backend
  let failures = []
  let comparisons = 0
  let nonEmpty = 0
  let resultRows = 0

  try {
    const [{ createOnethingBackend }, providers, runtime, bound] = await Promise.all([
      import('@onething/backend'),
      import('@onething/backend/wiring/search/providers.js'),
      import('@onething/runtime/search'),
      import('@onething/runtime/search/service-bound'),
    ])

    backend = await createOnethingBackend({
      host: {
        storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
        terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null,
        plugins: null, gateway: null, settings: null, evals: null, mcp: null,
        localTrust: { origin: 'desktop-embedded' },
      },
      toolRegistry: 'headless',
      sender: { on() {}, once() {}, emit() {}, removeListener() {}, isDestroyed: () => false, send() {} },
    })

    const service = bound.getOnethingSearchService()
    const { getSessionsList } = await import('@onething/backend/stores/sessions.js')
    const titles = getSessionsList().map(session => session.name).filter(Boolean)
    const queries = buildQueries(corpus, titles)

    for (const query of queries) {
      for (const category of CATEGORIES) {
        const request = category === 'all'
          ? { query: query.text, category, limit: ALL_PARITY_LIMIT }
          : { query: query.text, category }
        /*
         * 挂钟冻一格再比。
         *
         * `searchPrompts` 的「新建提示词」快捷项把 `timestamp: Date.now()` 写进结果 ——
         * 那一格**不是**两条路的差别,是两次调用之间过了 1 毫秒。先冻 `Date.now`
         * 再并发跑两条,两边看到同一个时刻,于是这道门仍然是「逐字节」而不是
         * 「除了某几格之外逐字节」——**不给任何字段开豁免**,是这道门的信誉所在。
         */
        const realNow = Date.now
        const frozen = realNow()
        Date.now = () => frozen
        let legacy
        let wrapped
        try {
          ;[legacy, wrapped] = await Promise.all([
            runtime.executeOnethingSearchForIpc({
              request,
              executeSearch: providers.executeSearch,
            }),
            service.query(request),
          ])
        } finally {
          Date.now = realNow
        }
        comparisons += 1
        // `all` 档只比还在旧路上的那三组(见文件头)。单类档本来就只有一组。
        const keep = category === 'all'
          ? rows => rows.filter(row => LEGACY_RESULT_TYPES.has(row?.type))
          : rows => rows
        const left = keep(legacy.results ?? [])
        const right = keep(stripAdditions(wrapped.results))
        if (left.length > 0) nonEmpty += 1
        resultRows += left.length
        if (JSON.stringify(left) === JSON.stringify(right)) continue

        const index = firstDifference(left, right)
        failures.push({
          category,
          query: query.text,
          kind: query.kind,
          index,
          legacyCount: left.length,
          wrappedCount: right.length,
          legacy: left[index],
          wrapped: right[index],
        })
      }
    }
  } finally {
    await backend?.dispose()
    fs.rmSync(prepared.store, { recursive: true, force: true })
  }

  const tookMs = Date.now() - startedAt
  const summary = {
    store: { sessions: prepared.sessions, availableSessions: prepared.available, bytes: prepared.bytes },
    queries: QUERY_COUNT,
    categories: CATEGORIES.length,
    comparisons,
    comparisonsWithResults: nonEmpty,
    legacyResultRows: resultRows,
    mismatches: failures.length,
    tookMs,
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ ...summary, failures: failures.slice(0, 50) }, null, 2))
  } else {
    console.log('[search:parity-A] 临时 store: '
      + `${prepared.sessions}/${prepared.available} 会话,${(prepared.bytes / 1048576).toFixed(1)} MiB`)
    console.log(`[search:parity-A] ${QUERY_COUNT} 条查询 × ${CATEGORIES.length} 档 = ${comparisons} 次对账`
      + `(其中 ${nonEmpty} 次旧路有结果,共 ${resultRows} 条),耗时 ${(tookMs / 1000).toFixed(1)}s`)
    for (const failure of failures.slice(0, VERBOSE ? failures.length : 20)) {
      console.log(`[search:parity-A] failed: category=${failure.category} query=${JSON.stringify(failure.query)} `
        + `第 ${failure.index} 条(旧 ${failure.legacyCount} 条 / 新 ${failure.wrappedCount} 条)`)
      console.log(`  旧: ${JSON.stringify(failure.legacy)}`)
      console.log(`  新: ${JSON.stringify(failure.wrapped)}`)
    }
    console.log(failures.length === 0
      ? '[search:parity-A] ok: 新旧结果逐字节相同'
      : `[search:parity-A] ${failures.length} 处不一致`)
  }

  /*
   * 防假绿两条(与 boundary / transport 两道门同款):
   *  ① 旧路一条结果都没答出 = 现场没搭起来(空 store / 取材面没接上),不认这次绿;
   *  ② 结果总数低于下限 = 语料退化成一堆零命中,「逐字节相同」在说 `[] === []`。
   */
  // 按查询条数缩放:平均每条查询(七档合计)至少答出一条,否则语料退化了。
  const MIN_RESULT_ROWS = QUERY_COUNT
  if (nonEmpty === 0 || resultRows < MIN_RESULT_ROWS) {
    console.error(`[search:parity-A] failed: 旧路只答出 ${resultRows} 条结果(下限 ${MIN_RESULT_ROWS})`
      + ' —— 现场没搭起来,不认这次绿')
    process.exit(1)
  }
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(error => {
  console.error('[search:parity-A] crashed:', error)
  process.exit(1)
})
