/**
 * `SqliteIndex` —— 倒排的**产品实现**:`node:sqlite` 的 FTS5。
 *
 * 设计:docs/design/search-index-2026-09.md §0(引擎那一段)/ §5.1 / §5.4 / §6.5。
 *
 * 它与 core 的 `MemoryIndex` 答**同一份契约卷子**
 * (`packages/core/search/__tests__/index-contract.ts`,两边各跑一遍)——
 * 那就是 §5.1 末句「换实现不改上层」从一句话变成活证据的地方。上层(索引基座的
 * 词法召回)只认 `InvertedIndex` / `DocTable` / `LexicalSearcher` / `Vocabulary`
 * 四个接口,谁来实现都一样。
 *
 * ## 为什么是 `node:sqlite` 而不是 better-sqlite3
 *
 * 仓顶那条法(原生模块只许 N-API):better-sqlite3 是 V8 ABI 专属插件,同一份
 * `node_modules` 要同时喂 Electron 与 Node 两个运行时,结构上不可能两边都对。
 * `node:sqlite` 是**内建**的 —— 零原生依赖、零 ABI 问题,Node 22.13+ 免 flag,
 * Electron 41(Node 24)自带。代价是它只有 `DatabaseSync`(每条语句阻塞事件
 * 循环),所以整个索引服务住 Worker(§5.3),这个类**只在 Worker 线程里被 new**。
 *
 * ## 为什么分词不交给 FTS5
 *
 * FTS5 的 `trigram` 分词器对**短于 3 字**的查询直接零结果 —— 中文双字词(「私发」)
 * 全灭,而那正是黄金表里的一条(§10 S1)。所以分词由 core 的 TS 分析器做,FTS5 只
 * 索引**一列预切好、空格分隔的 token 串**,分词器用 `unicode61`。于是:
 *
 * - 「身份牌」= 二元 `身份 份牌`,查询侧同一个分析器切出同一串,FTS5 的**短语查询**
 *   `"身份 份牌"` 就是相邻判据(实测命中 1;倒过来 `"份牌 身份"` 命中 0);
 * - 短语的相邻判据用的是**token 流的先后**,不是 `LexicalPhrase.terms[].offset` ——
 *   FTS5 给我喂进去的 token 串自己排位置(0,1,2…),而查询侧短语是同一个分析器
 *   切出的同一串 token,两边的位置因此天生对齐。camel 那一形(`getUserProfile`
 *   切成整词 + 三段,分析器位是 0,0,1,2)在 FTS5 这边是 0,1,2,3,而查询侧切法逐字
 *   相同,所以短语照样成立 —— 这是**表示法不同、判据同一**,不是放松。
 *
 * ## 表
 *
 * | 表 | 装什么 |
 * | --- | --- |
 * | `docs` | 一行一份文档:capability / key / time / facets / fields(脱敏后的正文)/ relations / truncated |
 * | `doc_facets` | `(docId, key, value, num)` —— facet 过滤走它(WHERE 子句),不 scan `facets_json` |
 * | `doc_fields` | `(docId, field, length)` —— `fieldLength` / `averageFieldLength` 的产地 |
 * | `docs_fts` | FTS5:`tokens` 一列 + `docId` / `field` UNINDEXED,**一文档一字段一行** |
 * | `docs_vocab_row` / `docs_vocab_inst` | `fts5vocab` 视图:词典区间(`terms`)与词位(`postings`) |
 * | `edges` | `(fromDoc, rel, "to")` —— 关系边(§5.1);`rel` 的名字这里不认识 |
 * | `checkpoint` | `(feedId, key, fingerprint)` —— 按 feed 记,不按 feed 名枚举(§5.4) |
 * | `tombstones` | `(capability, key)` —— feed 说「这把钥匙不存在了」留下的记号 |
 * | `field_slots` | `(field, slot)` —— 见下面「fts 的 rowid 是算出来的」 |
 * | `meta` | `version` / `analyzerId` / `embeddingModelId` / `generation`(§5.4 库头三格 + 代次) |
 *
 * **fts 的 rowid 是算出来的**:`rowid = docId * 32 + slot(field)`。于是「删掉这份
 * 文档的全部字段行」是一次 `rowid BETWEEN` 区间删(O(log n)),而不是拿 UNINDEXED 的
 * `docId` 全表扫。代价是**全库最多 32 个不同的字段名** —— 今天用到 4 个
 * (title / content / attachments / reasoning),超了当场抛,不静默错乱。
 */

import { createRequire } from 'node:module'
import type { DatabaseSync, StatementSync } from 'node:sqlite'

import type { FacetFilter, FacetValue, FieldSchema, VectorSearchScope } from '@onething/core/search'
import type {
  DocPayload,
  DocTable,
  IndexWriter,
  IndexedDoc,
  InvertedIndex,
  LexicalHit,
  LexicalQuery,
  LexicalResult,
  LexicalSearcher,
  Posting,
  Vocabulary,
} from '@onething/core/search'
import {
  DEFAULT_NORMALIZERS,
  composeNormalizers,
  createDefaultAnalyzerRegistry,
} from '@onething/core/search'
import type { AnalyzerRegistry } from '@onething/core/search'

import { SqliteVectorIndex, attachVectorIndex, probeSqliteVecExtension } from './sqlite-vec.js'

/** §5.5:单文档字段上限,超出只索引前这么多字,文档标 truncated。 */
export const DEFAULT_MAX_FIELD_CHARS = 200_000

/** 每份文档在 fts 里能占的 rowid 槽数 = 全库字段名上限。 */
const FIELD_SLOTS = 32

/** 库头 `meta.version`;不符就丢库全量重放(§5.4「不做迁移」)。 */
export const SQLITE_INDEX_SCHEMA_VERSION = '1'

/**
 * 攒够这么多次**写**跑一次 `PRAGMA wal_checkpoint(PASSIVE)`。
 *
 * 设计 §5.4 原文是「每 200 次增量或 5 分钟 checkpoint」+「墓碑超 20% 后台 VACUUM」。
 * 这里只做前半:VACUUM 要独占库、在 WAL 下会把读者挡住,而它换来的只是磁盘占用 ——
 * 派生数据删了即重建,占用不是问题。**把「墓碑 20% VACUUM」换成「写够 N 次
 * PASSIVE checkpoint」**是本期的明说取舍(S3a 报告有记);真需要压缩时手删
 * `index/` 目录比在线 VACUUM 便宜得多。
 */
const WAL_CHECKPOINT_EVERY_WRITES = 200

/**
 * Node 22 装载 `node:sqlite` 会打一条 ExperimentalWarning。**精确压掉它一条** ——
 * 不许 `removeAllListeners('warning')`(那会连同别人装的告警监听一起端掉,而
 * Node 的默认打印本来就是一个监听器)。办法是包一层 `process.emitWarning`:名字
 * 与正文都对上才吞,其余原样转给原函数。
 */
let warningSuppressed = false
function suppressSqliteExperimentalWarning(): void {
  if (warningSuppressed) return
  warningSuppressed = true
  const original = process.emitWarning.bind(process)
  const patched = (warning: string | Error, ...rest: unknown[]): void => {
    const name = warning instanceof Error
      ? warning.name
      : typeof rest[0] === 'string'
        ? rest[0]
        : (rest[0] as { type?: string } | undefined)?.type
    const message = warning instanceof Error ? warning.message : String(warning)
    if (name === 'ExperimentalWarning' && /SQLite/.test(message)) return
    ;(original as (...args: unknown[]) => void)(warning, ...rest)
  }
  process.emitWarning = patched as typeof process.emitWarning
}

/**
 * `node:sqlite` **懒装载** —— 那条告警是在**装载模块**那一刻打的,不是 `new
 * DatabaseSync` 那一刻(实测:`await import('node:sqlite')` 一行就打了)。而 ESM 的
 * `import` 语句会被提升到模块体之前,所以静态 import 无论如何都赶在补丁前面。
 * 于是这里改成:先打补丁,再 `require`。
 *
 * 引荐者取 `cwd` 而不是 `import.meta.url` —— 引荐者只决定**相对**说明符怎么解析,
 * 而 `node:sqlite` 是内建模块,任何合法引荐者都一样;取 cwd 让这个文件在宿主把
 * Worker 打成 ESM 还是 CJS 两种产物下都成立(`import.meta.url` 在 CJS 产物里要靠
 * 打包器补 shim)。
 */
type SqliteModule = typeof import('node:sqlite')
let databaseSyncCtor: SqliteModule['DatabaseSync'] | undefined
function loadDatabaseSync(): SqliteModule['DatabaseSync'] {
  if (databaseSyncCtor !== undefined) return databaseSyncCtor
  suppressSqliteExperimentalWarning()
  const load = createRequire(`${process.cwd()}/`) as (id: string) => SqliteModule
  databaseSyncCtor = load('node:sqlite').DatabaseSync
  return databaseSyncCtor
}

export interface SqliteIndexOptions {
  /** 库文件路径;`:memory:` 也认(单测用,WAL 在内存库上是空操作)。 */
  path: string
  analyzers?: AnalyzerRegistry
  maxFieldChars?: number
  /**
   * 文档侧的归一化。**必须与查询侧是同一条列表**(与 `MemoryIndex` 同一条理由:
   * 两侧切法不同就等于没索引)。缺省 = `DEFAULT_NORMALIZERS`。
   */
  normalize?: (text: string) => { text: string }
  /** 库头 `meta.analyzerId`;与库里记的不符 → 丢库重建。 */
  analyzerId?: string
  /**
   * 语义召回(S7)。**缺席 = 连扩展都不装**:开关关着的时候库就该跟 S3 那时逐字
   * 一样,少一个默认打开的口子。`dims` 由嵌入器说,不写死。
   */
  vector?: { dims: number }
}

interface DocRow {
  docId: number
  capability: string
  key: string
  time: number
  facets_json: string
  fields_json: string
  relations_json: string | null
  truncated: number
}

/** 一次 MATCH 的产物:哪份文档的哪个字段命中了,分多少。 */
interface ClauseRow {
  docId: number
  field: string
  score: number
}

export class SqliteIndex implements InvertedIndex, DocTable, LexicalSearcher, IndexWriter, Vocabulary {
  private readonly db: DatabaseSync
  private readonly analyzers: AnalyzerRegistry
  private readonly maxFieldChars: number
  private readonly normalize: (text: string) => { text: string }
  private readonly schemas = new Map<string, Record<string, FieldSchema>>()
  private readonly slots = new Map<string, number>()
  private readonly statements = new Map<string, StatementSync>()
  /** 装上了就有,装不上就没有(`sqlite-vec.ts` 文件头第二节)。 */
  readonly vector: SqliteVectorIndex | undefined
  /** 扩展本身装不装得上 —— 与「开关开没开」是两件事(`gate:packaged` 读它)。 */
  readonly vectorExtension: 'loadable' | 'missing'
  private writesSinceCheckpoint = 0
  private generationValue = 0
  private closed = false

  constructor(options: SqliteIndexOptions) {
    const DatabaseSyncCtor = loadDatabaseSync()
    this.analyzers = options.analyzers ?? createDefaultAnalyzerRegistry()
    this.maxFieldChars = options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS
    this.normalize = options.normalize ?? composeNormalizers(DEFAULT_NORMALIZERS)
    // `allowExtension` 只在真要装向量扩展时才开(见 `SqliteIndexOptions.vector`)。
    this.db = options.vector === undefined
      ? new DatabaseSyncCtor(options.path)
      : new DatabaseSyncCtor(options.path, { allowExtension: true })
    // WAL:读者与写者互不阻塞(§5.4 / §5.6 那张表的前提)。内存库上是空操作。
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.createSchema()
    this.loadSlots()
    this.generationValue = Number(this.readMeta('generation') ?? '0')
    this.writeMeta('version', SQLITE_INDEX_SCHEMA_VERSION)
    if (options.analyzerId !== undefined) this.writeMeta('analyzerId', options.analyzerId)

    if (options.vector === undefined) {
      this.vector = undefined
      // 开关关着也要答得出「装得上吗」:探针自己开一个内存库,不碰真库。
      this.vectorExtension = probeSqliteVecExtension(
        probeOptions => new DatabaseSyncCtor(':memory:', probeOptions),
      )
    } else {
      this.vector = attachVectorIndex({
        db: this.db,
        dims: options.vector.dims,
        compileScope: scope => this.compileVectorScope(scope),
      })
      this.vectorExtension = this.vector === undefined ? 'missing' : 'loadable'
    }
  }

  /**
   * 一个向量范围 → `docs` 表上的 WHERE 片段(别名 `d`)。与词法路的 `buildScope`
   * **同一条编译**:两条召回路问索引的是同一句话,授权才不会在其中一条上漏掉。
   */
  compileVectorScope(scope: VectorSearchScope): { sql: string; params: SqlValue[] } | null {
    return this.buildScope({ capability: scope.capability, filters: scope.filters } as LexicalQuery)
  }

  // ---- 库头 -------------------------------------------------------------

  /**
   * 库头三格之一。`version` / `analyzerId` / `embeddingModelId` 任一不符 → 丢库
   * 全量重放(§5.4「不做迁移」)。判定住调用方(worker-core),这里只提供读写。
   */
  readMeta(key: string): string | undefined {
    const row = this.prepare('SELECT v FROM meta WHERE k = ?').get(key) as { v: string } | undefined
    return row?.v
  }

  writeMeta(key: string, value: string): void {
    this.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, value)
  }

  /**
   * 索引代次:每次写入递增。索引基座拿它进 `queryHash`,索引一变在飞的游标自然
   * 失效(§4.2「索引变了 hash 变,cursor 自然失效」)。
   */
  generation(): number {
    return this.generationValue
  }

  /** 字段 → 分析器 + 权重。数据来自 manifest.schema,索引不认识能力,只认这张表。 */
  setSchema(capability: string, schema: Record<string, FieldSchema>): void {
    this.schemas.set(capability, schema)
    // 字段名要在第一次写文档之前就占好槽,否则同一个字段在不同能力上可能拿到
    // 不同的槽号,rowid 区间删就会漏。
    for (const field of Object.keys(schema)) this.slotOf(field)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.statements.clear()
    this.db.close()
  }

  // ---- 写面 -------------------------------------------------------------

  replaceKey(capability: string, key: string, docs: readonly DocPayload[]): void {
    this.transaction(() => {
      this.removeKeyRows(capability, key)
      this.prepare('DELETE FROM tombstones WHERE capability = ? AND key = ?').run(capability, key)
      for (const payload of docs) this.insertDocument(payload)
    })
    this.afterWrite()
  }

  tombstone(capability: string, key: string): void {
    this.transaction(() => {
      this.removeKeyRows(capability, key)
      this.prepare('INSERT OR IGNORE INTO tombstones(capability, key) VALUES(?, ?)').run(capability, key)
    })
    this.afterWrite()
  }

  /** feed 说「这把钥匙已不存在」时留下的记号;校对时读它,不再重折。 */
  isTombstoned(capability: string, key: string): boolean {
    const row = this.prepare('SELECT 1 AS hit FROM tombstones WHERE capability = ? AND key = ?')
      .get(capability, key) as { hit: number } | undefined
    return row !== undefined
  }

  tombstoneCount(): number {
    return this.count('SELECT COUNT(*) AS n FROM tombstones')
  }

  /**
   * 删掉一把钥匙,**不留墓碑**。
   *
   * 与 `tombstone` 的分工是语义上的:墓碑说的是「**feed 说这把钥匙不存在了**」
   * (会话目录被 `rmSync` 了),而 `deleteKey` 说的是「这把钥匙的内容变了,这一份
   * 文档不再是它的一部分」——被删掉的一条消息、被压缩掉的那一段。前者是 §5.4
   * 校对时要读回来的记号,后者只是整键重折的自然结果,留记号只会让 `tombstones`
   * 表变成一本永不清理的流水账。
   */
  deleteKey(capability: string, key: string): void {
    this.transaction(() => {
      this.removeKeyRows(capability, key)
    })
    this.afterWrite()
  }

  // ---- 检查点(§5.4)-----------------------------------------------------

  readCheckpoint(feedId: string, key: string): string | undefined {
    const row = this.prepare('SELECT fingerprint FROM checkpoint WHERE feedId = ? AND key = ?')
      .get(feedId, key) as { fingerprint: string } | undefined
    return row?.fingerprint
  }

  /**
   * 写检查点,并记下**这一把 feed 钥匙此刻拥有哪些索引钥匙**。
   *
   * 设计 §5.4 给的表是三列 `(feedId, key, fingerprint)`,这里多一列 `keys_json` ——
   * 一处明说的出入,理由是**两级钥匙**:feed 的钥匙是 sessionId,而索引的钥匙是
   * `${sessionId}:${messageId}`(§5.1),一把 feed 钥匙盖着几十份文档。整键重折之后
   * 「上一轮有、这一轮没有」的那些必须删掉(删掉的消息、被压缩的那一段),而
   * 「上一轮有哪些」除了记下来没有别的问法 —— 拿 facet 反查等于让索引认识
   * `sessionId` 这个键名,那是把能力的词汇塞进索引。
   */
  writeCheckpoint(
    feedId: string,
    key: string,
    fingerprint: string,
    ownedKeys: ReadonlyArray<{ capability: string; key: string }> = [],
  ): void {
    this.prepare(
      'INSERT INTO checkpoint(feedId, key, fingerprint, keys_json) VALUES(?, ?, ?, ?)'
      + ' ON CONFLICT(feedId, key) DO UPDATE SET fingerprint = excluded.fingerprint,'
      + ' keys_json = excluded.keys_json',
    ).run(feedId, key, fingerprint, JSON.stringify(ownedKeys))
  }

  /** 上一轮这把 feed 钥匙拥有的索引钥匙。没有记录 = 空表。 */
  readCheckpointOwnedKeys(feedId: string, key: string): Array<{ capability: string; key: string }> {
    const row = this.prepare('SELECT keys_json FROM checkpoint WHERE feedId = ? AND key = ?')
      .get(feedId, key) as { keys_json: string | null } | undefined
    if (row?.keys_json == null) return []
    try {
      return JSON.parse(row.keys_json) as Array<{ capability: string; key: string }>
    } catch {
      return []
    }
  }

  dropCheckpoint(feedId: string, key: string): void {
    this.prepare('DELETE FROM checkpoint WHERE feedId = ? AND key = ?').run(feedId, key)
  }

  /** 校对时枚举「库里记着的钥匙」——feed 说不存在的那些要打墓碑(§5.4)。 */
  checkpointKeys(feedId: string): string[] {
    return (this.prepare('SELECT key FROM checkpoint WHERE feedId = ? ORDER BY key').all(feedId) as Array<{ key: string }>)
      .map(row => row.key)
  }

  // ---- 关系边(§5.1)-----------------------------------------------------

  /** `rel` 的名字这里不认识,只存与查 —— 「哪些对话改过这个文件」是一次边表查询。 */
  docIdsByEdge(rel: string, to: string): number[] {
    return (this.prepare('SELECT DISTINCT fromDoc FROM edges WHERE rel = ? AND "to" = ?').all(rel, to) as Array<{ fromDoc: number }>)
      .map(row => row.fromDoc)
  }

  // ---- DocTable ---------------------------------------------------------

  get(docId: number): IndexedDoc | undefined {
    const row = this.prepare('SELECT * FROM docs WHERE docId = ?').get(docId) as DocRow | undefined
    return row === undefined ? undefined : toIndexedDoc(row)
  }

  byKey(capability: string, key: string): IndexedDoc[] {
    const rows = this.prepare('SELECT * FROM docs WHERE capability = ? AND key = ? ORDER BY docId')
      .all(capability, key) as unknown as DocRow[]
    return rows.map(toIndexedDoc)
  }

  /** 全库的 docId。**只有换模型全量重嵌那一条路读它**(§5.4),不是热路径。 */
  allDocIds(): number[] {
    return (this.prepare('SELECT docId FROM docs ORDER BY docId').all() as Array<{ docId: number }>)
      .map(row => Number(row.docId))
  }

  size(): number {
    return this.count('SELECT COUNT(*) AS n FROM docs')
  }

  // ---- InvertedIndex ----------------------------------------------------

  /**
   * 词位说明:这里的 `positions` 是 **FTS5 的 token 偏移**(喂进去那串 token 的
   * 先后 0,1,2…),不是分析器的 `Token.position`。两者在 CJK 二元与纯拉丁上逐字
   * 相同,只有 camel 拆段那一形不同(分析器让整词与首段共位,FTS5 顺序排)。
   * **相邻判据由 FTS5 的短语查询回答,不读这一格**,所以差别不影响任何判定;
   * 这个方法存在是为了接口完整与契约用例的取证。
   */
  postings(field: string, term: string): Posting[] {
    const slot = this.slots.get(field)
    if (slot === undefined) return []
    const rows = this.prepare(
      'SELECT doc, offset FROM docs_vocab_inst WHERE term = ? AND (doc % ?) = ? ORDER BY doc, offset',
    ).all(term, FIELD_SLOTS, slot) as Array<{ doc: number; offset: number }>
    const byDoc = new Map<number, Posting>()
    for (const row of rows) {
      const docId = Math.floor(row.doc / FIELD_SLOTS)
      const existing = byDoc.get(docId)
      if (existing === undefined) byDoc.set(docId, { docId, tf: 1, positions: [row.offset] })
      else {
        existing.tf += 1
        existing.positions.push(row.offset)
      }
    }
    return [...byDoc.values()]
  }

  docFreq(field: string, term: string): number {
    const expression = ftsPhrase([term])
    if (expression === undefined) return 0
    return this.count(
      'SELECT COUNT(*) AS n FROM docs_fts WHERE docs_fts MATCH ? AND field = ?',
      expression,
      field,
    )
  }

  docCount(): number {
    return this.size()
  }

  fieldLength(docId: number, field: string): number {
    const row = this.prepare('SELECT length FROM doc_fields WHERE docId = ? AND field = ?')
      .get(docId, field) as { length: number } | undefined
    return row?.length ?? 0
  }

  averageFieldLength(field: string): number {
    const row = this.prepare('SELECT AVG(length) AS avg FROM doc_fields WHERE field = ?')
      .get(field) as { avg: number | null } | undefined
    return row?.avg ?? 0
  }

  /**
   * 词典区间展开(§6.2b 的 prefix expander 只看它)。返回按字典序。
   *
   * 两步:`fts5vocab(row)` 给出**全库**的词典区间(它按 term 有序,所以区间取数很
   * 便宜),再用 `fts5vocab(instance)` 的一次 `IN` 查询按**字段**筛
   * (`doc % 32` 就是字段槽,见文件头「fts 的 rowid 是算出来的」)。
   */
  terms(field: string, prefix: string, limit: number): string[] {
    const cap = Math.max(0, limit)
    if (cap === 0) return []
    const slot = this.slots.get(field)
    if (slot === undefined) return []
    const upper = prefixUpperBound(prefix)
    const candidates = (this.prepare(
      upper === undefined
        ? 'SELECT term FROM docs_vocab_row ORDER BY term LIMIT ?'
        : 'SELECT term FROM docs_vocab_row WHERE term >= ? AND term < ? ORDER BY term LIMIT ?',
      ).all(...(upper === undefined ? [cap * 4 + FIELD_SLOTS] : [prefix, upper, cap * 4 + FIELD_SLOTS])) as Array<{ term: string }>)
      .map(row => row.term)
    if (candidates.length === 0) return []

    const placeholders = candidates.map(() => '?').join(', ')
    const matched = new Set((this.prepare(
      `SELECT DISTINCT term FROM docs_vocab_inst WHERE term IN (${placeholders}) AND (doc % ?) = ?`,
    ).all(...candidates, FIELD_SLOTS, slot) as Array<{ term: string }>).map(row => row.term))

    return candidates.filter(term => matched.has(term)).slice(0, cap)
  }

  // ---- LexicalSearcher --------------------------------------------------

  /**
   * 一次词法查询。
   *
   * **翻译方案(设计 §5.1 给了两条路,这里选的是「一条 clause 一次 MATCH,权重在
   * TS 里加」)**:
   *
   * - 每个 `terms[i]`(它的 alternatives 是 expander 展开出来的候选词)翻成一条
   *   `(词1 OR 词2 OR …)` 的 MATCH;每个 `phrases[i]` 翻成一条 —— 严格档是
   *   `"t1 t2 t3"` 短语,阶梯 ② 之后降级成 `(t1 AND t2 AND t3)`;`excluded` 合成
   *   一条 OR。放宽阶梯的四级于是全部落在**同一套翻译**上:①短语 + 全 AND、
   *   ②短语降级、③ minShouldMatch 减半(在 TS 里数命中条数)、④单词(min=1)。
   * - 每条 clause 的 SQL 回来的是**行分**(`bm25()`,一文档一字段一行),
   *   TS 侧按 `manifest.schema` 的 weight 加权求和到文档。
   *
   * **为什么权重在 TS 不在 SQL 的 CASE**:字段权重是 `LexicalQuery.fields` 传进来的
   * **运行期数据**(能力可以按场景改,契约用例就现改了一次把 title 调到 0),写进
   * SQL 的 CASE 就得为每种权重表生成一条不同的 SQL、也就没法预编译复用;而在 TS
   * 里加权是对一页行数(几十到几百)的乘加,便宜且可读。另一半理由是**判定要在
   * 一个地方**:minShouldMatch 的计数、短语必须全中、excluded 出局,这三件事本来
   * 就在 TS 里,分数再分家只会让「为什么这条排在前面」有两处产地。
   *
   * 语义与 `MemoryIndex` 逐条对齐(契约用例两边各跑一遍),两处**表示法**不同已
   * 在别处写明:短语按 token 流相邻(见文件头)、`postings` 的词位是 FTS 偏移。
   */
  search(query: LexicalQuery): LexicalResult {
    const fieldNames = Object.keys(query.fields).filter(field => this.slots.has(field))
    if (fieldNames.length === 0) return { hits: [], total: 0 }

    const scope = this.buildScope(query)
    if (scope === null) return { hits: [], total: 0 }

    const termClauses = query.terms
      .map(term => ftsAny(term.alternatives.map(alternative => alternative.term)))
    const phraseClauses = query.phrases.map(phrase => {
      const words = phrase.terms.map(part => part.term)
      return query.phraseAdjacent ? ftsPhrase(words) : ftsAll(words)
    })
    if (termClauses.every(clause => clause === undefined) && phraseClauses.length === 0) {
      return { hits: [], total: 0 }
    }
    // 短语那一路只要有一条翻不出来,它就是「必中却中不了」,整条查询无解。
    if (phraseClauses.some(clause => clause === undefined)) return { hits: [], total: 0 }

    const excluded = this.excludedDocIds(query, fieldNames, scope)

    interface Accumulator {
      score: number
      matched: string[]
      fields: Set<string>
      matchedTerms: number
      matchedPhrases: number
    }
    const accumulators = new Map<number, Accumulator>()
    const take = (docId: number): Accumulator => {
      let entry = accumulators.get(docId)
      if (entry === undefined) {
        entry = { score: 0, matched: [], fields: new Set(), matchedTerms: 0, matchedPhrases: 0 }
        accumulators.set(docId, entry)
      }
      return entry
    }

    const applyClause = (
      expression: string,
      label: readonly string[],
      bump: (entry: Accumulator) => void,
    ): void => {
      const seen = new Set<number>()
      for (const row of this.runClause(expression, fieldNames, scope)) {
        if (excluded.has(row.docId)) continue
        const entry = take(row.docId)
        entry.score += (query.fields[row.field] ?? 1) * row.score
        entry.fields.add(row.field)
        if (!seen.has(row.docId)) {
          seen.add(row.docId)
          bump(entry)
          entry.matched.push(...label)
        }
      }
    }

    query.terms.forEach((term, index) => {
      const expression = termClauses[index]
      if (expression === undefined) return
      // `matched` 记原词(alternatives[0] 永远是原词,权重 1)—— 与 MemoryIndex
      // 「记贡献最大的那一个候选」的口径略有出入,但两边都只被 explain 与摘要读。
      const label = term.alternatives[0]?.term
      applyClause(expression, label === undefined ? [] : [label], entry => { entry.matchedTerms += 1 })
    })

    query.phrases.forEach((phrase, index) => {
      const expression = phraseClauses[index]
      if (expression === undefined) return
      applyClause(expression, phrase.terms.map(part => part.term), entry => { entry.matchedPhrases += 1 })
    })

    const requiredTerms = Math.min(query.minShouldMatch, query.terms.length)
    const requiredPhrases = query.phrases.length
    const hits: LexicalHit[] = []
    for (const [docId, entry] of accumulators) {
      if (entry.matchedTerms < requiredTerms) continue
      if (entry.matchedPhrases < requiredPhrases) continue
      if (entry.matched.length === 0) continue
      hits.push({ docId, score: entry.score, matched: entry.matched, fields: [...entry.fields] })
    }

    hits.sort((a, b) => (b.score - a.score) || (a.docId - b.docId))
    const offset = query.offset ?? 0
    return { hits: hits.slice(offset, offset + query.limit), total: hits.length }
  }

  // ---- 内部:查询 -------------------------------------------------------

  /** 一条 clause 的 SQL:MATCH × 字段 × 作用域(能力 + facet 过滤)。 */
  private runClause(
    expression: string,
    fieldNames: readonly string[],
    scope: { sql: string; params: SqlValue[] },
  ): ClauseRow[] {
    const fieldPlaceholders = fieldNames.map(() => '?').join(', ')
    const sql = `SELECT f.docId AS docId, f.field AS field, -bm25(docs_fts) AS score`
      + ` FROM docs_fts f JOIN docs d ON d.docId = f.docId`
      + ` WHERE docs_fts MATCH ? AND f.field IN (${fieldPlaceholders})${scope.sql}`
    return this.prepare(sql).all(expression, ...fieldNames, ...scope.params) as unknown as ClauseRow[]
  }

  /**
   * `excluded` 是「命中即出局」(MemoryIndex 的 `hasExcluded`:任一字段里出现过
   * 就出局)。一次 OR 查询取出全部要踢的 docId。
   */
  private excludedDocIds(
    query: LexicalQuery,
    fieldNames: readonly string[],
    scope: { sql: string; params: SqlValue[] },
  ): Set<number> {
    const expression = ftsAny(query.excluded)
    if (expression === undefined) return new Set()
    return new Set(this.runClause(expression, fieldNames, scope).map(row => row.docId))
  }

  /**
   * 能力 + facet 过滤翻成 WHERE 片段。返回 `null` = 这次查询恒空
   * (例如 `space: []` —— MemoryIndex 那边 `[].includes(v)` 也恒假)。
   *
   * facet 走 `doc_facets` 的 `EXISTS` / `NOT EXISTS`,与 core 的
   * `matchesFacetFilter` 四种形状逐条对齐:标量相等 / 数组属于 / 区间(只认数)/
   * 取反(**没有这个 facet 的文档算通过**,与 core 那句 `value === undefined ||
   * !excluded.includes(value)` 同义)。
   */
  private buildScope(query: LexicalQuery): { sql: string; params: SqlValue[] } | null {
    const parts: string[] = []
    const params: SqlValue[] = []
    if (query.capability !== undefined) {
      parts.push('d.capability = ?')
      params.push(query.capability)
    }
    for (const [key, filter] of Object.entries(query.filters ?? {})) {
      const clause = facetClause(key, filter)
      if (clause === null) return null
      if (clause === undefined) continue
      parts.push(clause.sql)
      params.push(...clause.params)
    }
    return { sql: parts.length === 0 ? '' : ` AND ${parts.join(' AND ')}`, params }
  }

  // ---- 内部:写 ---------------------------------------------------------

  private insertDocument(payload: DocPayload): void {
    const schema = this.schemas.get(payload.capability)
    const lengths: Array<{ field: string; length: number; tokens: string }> = []
    let truncated = false

    for (const [field, rawValue] of Object.entries(payload.fields)) {
      const value = rawValue.length > this.maxFieldChars ? rawValue.slice(0, this.maxFieldChars) : rawValue
      if (value.length < rawValue.length) truncated = true
      const analyzer = this.analyzers.resolve(schema?.[field]?.analyzer)
      // 先归一化再切 —— 与查询侧同一条列表,同一个顺序。
      const tokens = analyzer.analyze(this.normalize(value).text)
      lengths.push({ field, length: tokens.length, tokens: tokens.map(token => token.text).join(' ') })
    }

    const info = this.prepare(
      'INSERT INTO docs(capability, key, time, facets_json, fields_json, relations_json, truncated)'
      + ' VALUES(?, ?, ?, ?, ?, ?, ?)',
    ).run(
      payload.capability,
      payload.key,
      payload.time,
      JSON.stringify(payload.facets),
      JSON.stringify(payload.fields),
      payload.relations === undefined ? null : JSON.stringify(payload.relations),
      truncated ? 1 : 0,
    )
    const docId = Number(info.lastInsertRowid)

    const facetInsert = this.prepare('INSERT INTO doc_facets(docId, key, value, num) VALUES(?, ?, ?, ?)')
    for (const [key, value] of Object.entries(payload.facets)) {
      facetInsert.run(docId, key, canonicalFacet(value), typeof value === 'number' ? value : null)
    }

    const fieldInsert = this.prepare('INSERT INTO doc_fields(docId, field, length) VALUES(?, ?, ?)')
    const ftsInsert = this.prepare('INSERT INTO docs_fts(rowid, tokens, docId, field) VALUES(?, ?, ?, ?)')
    for (const entry of lengths) {
      fieldInsert.run(docId, entry.field, entry.length)
      ftsInsert.run(this.ftsRowId(docId, entry.field), entry.tokens, docId, entry.field)
    }

    const edgeInsert = this.prepare('INSERT INTO edges(fromDoc, rel, "to") VALUES(?, ?, ?)')
    for (const edge of payload.relations ?? []) edgeInsert.run(docId, edge.rel, edge.to)
  }

  private removeKeyRows(capability: string, key: string): void {
    const rows = this.prepare('SELECT docId FROM docs WHERE capability = ? AND key = ?')
      .all(capability, key) as Array<{ docId: number }>
    if (rows.length === 0) return
    const deleteFts = this.prepare('DELETE FROM docs_fts WHERE rowid BETWEEN ? AND ?')
    const deleteFacets = this.prepare('DELETE FROM doc_facets WHERE docId = ?')
    const deleteFields = this.prepare('DELETE FROM doc_fields WHERE docId = ?')
    const deleteEdges = this.prepare('DELETE FROM edges WHERE fromDoc = ?')
    const deleteDoc = this.prepare('DELETE FROM docs WHERE docId = ?')
    for (const row of rows) {
      const base = row.docId * FIELD_SLOTS
      deleteFts.run(base, base + FIELD_SLOTS - 1)
      // 文档没了,它的那几段向量也没了 —— 少这一句就会攒出一堆指向空文档的段,
      // KNN 把它们当候选、`docs.get()` 又答不出来,于是名额被白白占掉。
      this.vector?.remove(row.docId)
      deleteFacets.run(row.docId)
      deleteFields.run(row.docId)
      deleteEdges.run(row.docId)
      deleteDoc.run(row.docId)
    }
  }

  private afterWrite(): void {
    this.generationValue += 1
    this.writeMeta('generation', String(this.generationValue))
    this.writesSinceCheckpoint += 1
    if (this.writesSinceCheckpoint >= WAL_CHECKPOINT_EVERY_WRITES) {
      this.writesSinceCheckpoint = 0
      try {
        this.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
      } catch {
        // PASSIVE checkpoint 拿不到锁就是拿不到 —— 下一次再说,不是错误。
      }
    }
  }

  /** 一把 statement 缓存:同一条 SQL 只 prepare 一次。 */
  private prepare(sql: string): StatementSync {
    const existing = this.statements.get(sql)
    if (existing !== undefined) return existing
    const statement = this.db.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  private transaction(body: () => void): void {
    this.db.exec('BEGIN')
    try {
      body()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private count(sql: string, ...params: SqlValue[]): number {
    const row = this.prepare(sql).get(...params) as { n: number } | undefined
    return row?.n ?? 0
  }

  private ftsRowId(docId: number, field: string): number {
    return docId * FIELD_SLOTS + this.slotOf(field)
  }

  /** 字段名 → 槽号(全库唯一,持久化在 `field_slots`)。超过 32 个字段名当场抛。 */
  private slotOf(field: string): number {
    const existing = this.slots.get(field)
    if (existing !== undefined) return existing
    const next = this.slots.size
    if (next >= FIELD_SLOTS) {
      throw new Error(`SqliteIndex: too many distinct field names (max ${FIELD_SLOTS}): ${field}`)
    }
    this.prepare('INSERT OR IGNORE INTO field_slots(field, slot) VALUES(?, ?)').run(field, next)
    const row = this.prepare('SELECT slot FROM field_slots WHERE field = ?').get(field) as { slot: number }
    this.slots.set(field, row.slot)
    return row.slot
  }

  private loadSlots(): void {
    for (const row of this.prepare('SELECT field, slot FROM field_slots').all() as Array<{ field: string; slot: number }>) {
      this.slots.set(row.field, row.slot)
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS docs (
        docId INTEGER PRIMARY KEY,
        capability TEXT NOT NULL,
        key TEXT NOT NULL,
        time INTEGER NOT NULL,
        facets_json TEXT NOT NULL,
        fields_json TEXT NOT NULL,
        relations_json TEXT,
        truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS docs_by_key ON docs(capability, key);
      CREATE TABLE IF NOT EXISTS doc_facets (
        docId INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        num REAL
      );
      CREATE INDEX IF NOT EXISTS doc_facets_by_doc ON doc_facets(docId);
      CREATE INDEX IF NOT EXISTS doc_facets_by_key ON doc_facets(key, value);
      CREATE TABLE IF NOT EXISTS doc_fields (
        docId INTEGER NOT NULL,
        field TEXT NOT NULL,
        length INTEGER NOT NULL,
        PRIMARY KEY (docId, field)
      );
      CREATE INDEX IF NOT EXISTS doc_fields_by_field ON doc_fields(field);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        tokens,
        docId UNINDEXED,
        field UNINDEXED,
        tokenize = "unicode61 tokenchars '_'"
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_vocab_row USING fts5vocab(docs_fts, 'row');
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_vocab_inst USING fts5vocab(docs_fts, 'instance');
      CREATE TABLE IF NOT EXISTS edges (
        fromDoc INTEGER NOT NULL,
        rel TEXT NOT NULL,
        "to" TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS edges_by_doc ON edges(fromDoc);
      CREATE INDEX IF NOT EXISTS edges_by_target ON edges(rel, "to");
      CREATE TABLE IF NOT EXISTS checkpoint (
        feedId TEXT NOT NULL,
        key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        keys_json TEXT,
        PRIMARY KEY (feedId, key)
      );
      CREATE TABLE IF NOT EXISTS tombstones (
        capability TEXT NOT NULL,
        key TEXT NOT NULL,
        PRIMARY KEY (capability, key)
      );
      CREATE TABLE IF NOT EXISTS field_slots (
        field TEXT PRIMARY KEY,
        slot INTEGER NOT NULL UNIQUE
      );
    `)
  }
}

// ---- 纯函数 -------------------------------------------------------------

type SqlValue = string | number | null

function toIndexedDoc(row: DocRow): IndexedDoc {
  const relations = row.relations_json === null
    ? undefined
    : JSON.parse(row.relations_json) as DocPayload['relations']
  return {
    docId: row.docId,
    capability: row.capability,
    key: row.key,
    time: row.time,
    facets: JSON.parse(row.facets_json) as Record<string, FacetValue>,
    fields: JSON.parse(row.fields_json) as Record<string, string>,
    ...(relations !== undefined ? { relations } : {}),
    ...(row.truncated === 1 ? { truncated: true } : {}),
  }
}

/**
 * facet 值的**规范文本形**:`JSON.stringify` —— 于是 `"s1"` / `false` / `12` 三种
 * 类型在同一列里互不相等,`archived: false` 不会撞上 `count: 0`。
 */
function canonicalFacet(value: FacetValue): string {
  return JSON.stringify(value)
}

/** FTS5 的串字面量:双引号包起来,内部的双引号翻倍。 */
function ftsLiteral(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

/** 一个词都没有 = 这条 clause 翻不出来(调用方按「恒不命中」处理)。 */
function ftsAny(terms: readonly string[]): string | undefined {
  const parts = terms.filter(term => term.length > 0).map(ftsLiteral)
  return parts.length === 0 ? undefined : `(${parts.join(' OR ')})`
}

function ftsAll(terms: readonly string[]): string | undefined {
  const parts = terms.filter(term => term.length > 0).map(ftsLiteral)
  return parts.length === 0 ? undefined : `(${parts.join(' AND ')})`
}

/** 短语:一串 token 一次引号 —— 相邻由 FTS5 判(见文件头)。 */
function ftsPhrase(terms: readonly string[]): string | undefined {
  const parts = terms.filter(term => term.length > 0)
  if (parts.length === 0) return undefined
  return ftsLiteral(parts.join(' '))
}

/**
 * 前缀区间的上界:把最后一个码位加一。`undefined` = 空前缀(没有上界,全表)。
 * 用码位而不是 charCode,免得在代理对上切一刀切出个非法串。
 */
function prefixUpperBound(prefix: string): string | undefined {
  if (prefix.length === 0) return undefined
  const points = [...prefix]
  const last = points[points.length - 1]!
  const next = String.fromCodePoint(last.codePointAt(0)! + 1)
  return [...points.slice(0, -1), next].join('')
}

/**
 * 一条 facet 过滤的 SQL 片段。
 * `null` = 恒不命中(空数组);`undefined` = 这一条不产生约束。
 */
function facetClause(
  key: string,
  filter: FacetFilter,
): { sql: string; params: SqlValue[] } | null | undefined {
  const exists = (inner: string, params: SqlValue[]): { sql: string; params: SqlValue[] } => ({
    sql: `EXISTS (SELECT 1 FROM doc_facets df WHERE df.docId = d.docId AND df.key = ? AND ${inner})`,
    params: [key, ...params],
  })

  if (Array.isArray(filter)) {
    if (filter.length === 0) return null
    const placeholders = filter.map(() => '?').join(', ')
    return exists(`df.value IN (${placeholders})`, filter.map(canonicalFacet))
  }

  if (filter !== null && typeof filter === 'object') {
    if ('not' in filter) {
      const excluded = Array.isArray(filter.not) ? filter.not : [filter.not]
      if (excluded.length === 0) return undefined
      const placeholders = excluded.map(() => '?').join(', ')
      return {
        sql: `NOT EXISTS (SELECT 1 FROM doc_facets df WHERE df.docId = d.docId AND df.key = ?`
          + ` AND df.value IN (${placeholders}))`,
        params: [key, ...excluded.map(canonicalFacet)],
      }
    }
    const conditions = ['df.num IS NOT NULL']
    const params: SqlValue[] = []
    if (filter.gte !== undefined) {
      conditions.push('df.num >= ?')
      params.push(filter.gte)
    }
    if (filter.lte !== undefined) {
      conditions.push('df.num <= ?')
      params.push(filter.lte)
    }
    return exists(conditions.join(' AND '), params)
  }

  return exists('df.value = ?', [canonicalFacet(filter)])
}
