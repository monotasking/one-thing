/**
 * `sqlite-vec` 的装载与 `VectorIndex` 的产品实现(S7)。
 *
 * 设计:docs/design/search-index-2026-09.md §15.1 / §15.2
 *
 * ## 为什么这块二进制过得了「原生模块只许 N-API」那条法
 *
 * 它不是 Node 插件,是一个 **SQLite 可加载扩展**(纯 C,`vec0.dylib` / `.so` /
 * `.dll`)。它向宿主要的符号只有 libc 那几个 —— 本机 `nm -u` 读数 **21 条,全是
 * `___memcpy_chk` / `_strtod` 这一类**,一个 `_v8…` / `node::…` 都没有(SQLite 扩展
 * 拿 `sqlite3_api` 结构体调宿主,不靠动态符号)。法条明文允许「SQLite 这类内建 /
 * 纯 C 扩展」,但**只许门证明**:`gate:native` 里那一列会在系统 Node 与
 * `ELECTRON_RUN_AS_NODE=1` 的 Electron 下各真装一次并跑 `select vec_version()`。
 * 这段注释不是证据,那道门才是。
 *
 * ## 装不上不是错,是一格状态
 *
 * `loadExtension` 失败(没装平台包 / 打包时没解包 / 硬化运行时签名不对)时,
 * **词法路一个字都不许受影响**:开库照常、FTS 照常,只有 `status.vector` 变
 * `'off'` 并 `warn` 一句。这是 §15 的第一条纪律 —— 语义召回是加法,不是前提。
 *
 * ## 为什么授权是 `docId IN (子查询)` 而不是 JOIN(施工时量出来的)
 *
 * vec0 的 KNN 是「取最近的 k 条」。SQL 的 `JOIN docs ... WHERE cap = 'a'` 是**后
 * 过滤**:先取 k 条最近的,再筛,授权范围外的候选先占掉了名额。实测五条向量、
 * 只有最远的两条在范围内、`k = 2`:
 *
 * | 写法 | 读数 |
 * | --- | --- |
 * | 无过滤 `k=2` | docId 1, 2(最近的两条) |
 * | `JOIN docs d ON d.docId = vd.docId WHERE d.cap='a'` | **`[]`** —— 后过滤,两条全被筛掉 |
 * | `docId IN (SELECT docId FROM docs WHERE cap='a')` | **docId 4, 5** —— 下推进 KNN,答的是范围内最近的两条 |
 *
 * 所以这里走 `IN (子查询)`:vec0 把元数据列上的 `IN` 下推进扫描,**授权于是是查询
 * 的输入而不是结果的过滤**(§6.4b)。这一条不是优化,是正确性。
 *
 * ## node:sqlite 绑整数要 BigInt(施工时踩过)
 *
 * `stmt.run(1)` 在 node:sqlite 里绑的是 REAL,vec0 当场抛
 * `Expected integer for INTEGER metadata column docId, received FLOAT`。所以
 * `docId` / `chunk` / `k` 一律 `BigInt(...)` 绑进去。
 */

import { createRequire } from 'node:module'
import type { DatabaseSync, StatementSync } from 'node:sqlite'

import type { VectorHit, VectorIndex, VectorSearchScope } from '@onething/core/search'

import { getLogger } from '../../logging/index.js'

const log = getLogger('search.index.vector')

export type SqlValue = string | number | bigint | null | Uint8Array

/** vec0 虚表名。换维度要换表(vec0 的维度写死在建表语句里),所以名字带维数。 */
export function vecTableName(dims: number): string {
  return `vec_docs_${dims}`
}

/**
 * 扩展文件在哪儿。`sqlite-vec` 这个 npm 包自己会按 `${platform}-${arch}` 找平台
 * 子包 —— 这里不重写那套判断,只把它的答案接过来。
 *
 * 引荐者取 `cwd`(与 `sqlite-index.ts` 装载 `node:sqlite` 同一条理由):这个模块会被
 * 打成 CJS 与 ESM 两种产物,`import.meta.url` 在 CJS 里要靠打包器补 shim。
 */
export function sqliteVecExtensionPath(): string | undefined {
  try {
    const load = createRequire(`${process.cwd()}/`) as (id: string) => { getLoadablePath(): string }
    return load('sqlite-vec').getLoadablePath()
  } catch (error) {
    log.warn('sqlite-vec package is not resolvable; semantic recall is off', { err: error })
    return undefined
  }
}

/** 打开库时要不要允许装扩展。**只有开了语义召回才允许** —— 少一个默认打开的口子。 */
export interface SqliteVecOpenOptions {
  allowExtension: boolean
}

/**
 * 一次性探针:这台机器 / 这份产物能不能装上扩展。
 *
 * `gate:packaged` 读的就是它投影出来的 `status.vectorExtension` —— 开关关着的时候
 * 也答得出「装得上」,于是「asarUnpack 漏了」这种事在开关打开之前就被门抓到,而不是
 * 等用户去设置里打开才发现。
 *
 * 它自己开一个 `:memory:` 库,不碰真库。
 */
export function probeSqliteVecExtension(
  openMemoryDb: (options: { allowExtension: true }) => DatabaseSync,
): 'loadable' | 'missing' {
  const path = sqliteVecExtensionPath()
  if (path === undefined) return 'missing'
  let db: DatabaseSync | undefined
  try {
    db = openMemoryDb({ allowExtension: true })
    loadInto(db, path)
    const row = db.prepare('SELECT vec_version() AS v').get() as { v?: string } | undefined
    if (typeof row?.v !== 'string') return 'missing'
    return 'loadable'
  } catch (error) {
    log.warn('sqlite-vec extension does not load here', { path }, error)
    return 'missing'
  } finally {
    try { db?.close() } catch { /* 探针关不掉也不该影响任何人 */ }
  }
}

function loadInto(db: DatabaseSync, path: string): void {
  // node:sqlite 的两代 API:老的要先 enableLoadExtension(true),新的开库时就定了。
  const widened = db as DatabaseSync & { enableLoadExtension?: (on: boolean) => void }
  widened.enableLoadExtension?.(true)
  db.loadExtension(path)
}

export interface SqliteVectorIndexOptions {
  db: DatabaseSync
  dims: number
  /**
   * 把一个范围编译成 `docs` 表上的 WHERE 片段(表别名 `d`)。`null` = 恒不命中。
   * 由 `SqliteIndex` 提供 —— facet 怎么落库是它的知识,不是这个文件的。
   */
  compileScope(scope: VectorSearchScope): { sql: string; params: SqlValue[] } | null
}

/**
 * `vec_docs_<dims>` 上的 KNN。一段一行,`(docId, chunk)` 是元数据列 —— **不是主键**:
 * 同一份文档有多段,docId 不唯一(§15.3「每段一行,docId 相同、chunk 序号不同」)。
 */
export class SqliteVectorIndex implements VectorIndex {
  readonly dims: number
  private readonly db: DatabaseSync
  private readonly table: string
  private readonly compileScope: SqliteVectorIndexOptions['compileScope']
  private readonly statements = new Map<string, StatementSync>()

  constructor(options: SqliteVectorIndexOptions) {
    this.db = options.db
    this.dims = options.dims
    this.table = vecTableName(options.dims)
    this.compileScope = options.compileScope
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${this.table} USING vec0(`
      + `embedding float[${options.dims}], docId integer, chunk integer)`,
    )
  }

  upsert(docId: number, chunk: number, embedding: Float32Array): void {
    if (embedding.length !== this.dims) {
      throw new Error(`embedding has ${embedding.length} dims, index expects ${this.dims}`)
    }
    this.prepare(`DELETE FROM ${this.table} WHERE docId = ? AND chunk = ?`)
      .run(BigInt(docId), BigInt(chunk))
    this.prepare(`INSERT INTO ${this.table}(embedding, docId, chunk) VALUES(?, ?, ?)`)
      .run(bytesOf(embedding), BigInt(docId), BigInt(chunk))
  }

  remove(docId: number): void {
    this.prepare(`DELETE FROM ${this.table} WHERE docId = ?`).run(BigInt(docId))
  }

  clear(): void {
    // 换模型 = 全量重嵌(§5.4 库头那一条)。`DELETE FROM` 虚表就是清空。
    this.db.exec(`DELETE FROM ${this.table}`)
  }

  size(): number {
    const row = this.prepare(`SELECT COUNT(*) AS n FROM ${this.table}`).get() as { n: number } | undefined
    return Number(row?.n ?? 0)
  }

  /** 这份文档已经嵌了几段(增量时判断「要不要重嵌」用)。 */
  chunksOf(docId: number): number {
    const row = this.prepare(`SELECT COUNT(*) AS n FROM ${this.table} WHERE docId = ?`)
      .get(BigInt(docId)) as { n: number } | undefined
    return Number(row?.n ?? 0)
  }

  search(embedding: Float32Array, k: number, scope?: VectorSearchScope): VectorHit[] {
    if (k <= 0) return []
    const compiled = scope === undefined ? { sql: '', params: [] as SqlValue[] } : this.compileScope(scope)
    // `null` = 范围是空集(比如 `sessionId: []`)。空集上没有 KNN 可做。
    if (compiled === null) return []

    const where = compiled.sql.length === 0
      ? ''
      : ` AND docId IN (SELECT d.docId FROM docs d WHERE 1 = 1${compiled.sql})`
    const rows = this.prepare(
      `SELECT docId, chunk, distance FROM ${this.table}`
      + ` WHERE embedding MATCH ? AND k = ?${where} ORDER BY distance`,
    ).all(bytesOf(embedding), BigInt(Math.floor(k)), ...compiled.params) as Array<{
      docId: number; chunk: number; distance: number
    }>
    return rows.map(row => ({
      docId: Number(row.docId),
      chunk: Number(row.chunk),
      distance: Number(row.distance),
    }))
  }

  private prepare(sql: string): StatementSync {
    const existing = this.statements.get(sql)
    if (existing !== undefined) return existing
    const made = this.db.prepare(sql)
    this.statements.set(sql, made)
    return made
  }
}

/**
 * 在一个已开的库上装扩展并建向量索引。**装不上就答 `undefined`** —— 调用方据此把
 * `status.vector` 记成 `'off'`,词法路照旧(文件头第二节)。
 */
export function attachVectorIndex(
  options: SqliteVectorIndexOptions & { extensionPath?: string },
): SqliteVectorIndex | undefined {
  const path = options.extensionPath ?? sqliteVecExtensionPath()
  if (path === undefined) return undefined
  try {
    loadInto(options.db, path)
  } catch (error) {
    log.warn('sqlite-vec failed to load; the lexical path is unaffected', {
      fields: { path },
      err: error,
    })
    return undefined
  }
  try {
    return new SqliteVectorIndex(options)
  } catch (error) {
    log.warn('sqlite-vec loaded but the vec0 table could not be created', { err: error })
    return undefined
  }
}

/** `Float32Array` → sqlite 认的 blob。**必须是 `Uint8Array`**,不是底层 buffer。 */
function bytesOf(embedding: Float32Array): Uint8Array {
  return new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength)
}
