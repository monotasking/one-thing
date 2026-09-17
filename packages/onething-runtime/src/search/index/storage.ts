/**
 * 索引这件东西**占了多少地方**,以及**该不该收拾一下** —— 两件事的判据,全是纯函数。
 *
 * 设计:docs/design/search-index-2026-09.md §5.1(表结构)/ §5.4(检查点与快照那一节
 * 里「不做 VACUUM」那条明说的取舍,2026-09-18 按真店读数改判,见下)。
 *
 * 起因是用户 09-17 的一句话:「我要知道搜索占得空间,不管是现在的 fts5 还是向量库。」
 *
 * ## 为什么归类判据在这里,而不是一张表名清单
 *
 * 「哪几张表算向量库」这个问题有两种答法。写死一张 `['vec_docs_384', …]` 的清单是
 * 一个**枚举点**:换一档嵌入器就换维度,`vec0` 的虚表名带着维数(`sqlite-vec.ts` 的
 * `vecTableName`),影子表还会随 `sqlite-vec` 升版增减(今天是 `_chunks` / `_rowids` /
 * `_info` / `_vector_chunks00` / `_metadatachunks00` / `_metadatachunks01`,明天不一定)。
 * 抄一份迟早漂开,而漂开的后果是「向量库那一行长期报少」——一个不会报错的错。
 *
 * 所以判据反过来:**问库自己**。`sqlite_schema` 里哪几张是 `vec0` 虚表,它们各自的
 * 影子表就是「那张虚表名 + `_`」开头的那些(SQLite 影子表的命名规矩),再加上 SQLite
 * 替影子表自动建的那些 `sqlite_autoindex_<影子表名>_N`。于是这个文件里没有一个模型
 * 名、没有一个维数、没有一张表名清单 —— 加一档 768 维的嵌入器,这里一个字不用改。
 *
 * **其余一律归字面**(FTS5 的影子表、`docs` / `doc_facets` / `edges` / `checkpoint`、
 * 各自的索引、以及空闲页)。理由:用户问的是「占了多少地方」,而一个 161 MB 的库里
 * 那些说不出归属的页**真的占着地方**。把它们摊进「字面索引」那一行,好过另起一行
 * 「其它」让人猜。
 *
 * ## 为什么 09-18 把 VACUUM 从「不做」改成「有界地做一次」
 *
 * §5.4 原文写的是「不做 `VACUUM`(要独占库,WAL 下挡读者,换来的只是磁盘占用,而
 * 派生数据删了即重建)」。真店副本上量完之后,那句话的两半都不成立了:
 *
 * | 读数(真店副本,11,767 份文档) | 字节 |
 * | --- | --- |
 * | 库文件 | 161,361,920 |
 * | 其中 `docs_fts_data`(FTS5 的段) | 108,695,552 |
 * | `optimize` 之后的 `docs_fts_data` | **8,429,568**(段数 26 → 1,耗时 636ms) |
 * | `optimize` + `VACUUM` 之后的库文件 | **58,765,312**(VACUUM 290ms) |
 *
 * 也就是说:**161 MB 里有 100 MB 是陈旧的 FTS5 段**。它们是「整键重折 = 删掉再插一遍」
 * 的必然产物 —— FTS5 的删除写的是一条反向记录,旧的倒排数据要等段合并才真的消失,
 * 而自动合并显然追不上这个仓的重折频率(真店那一份的 `meta.generation` 是 497,919)。
 * 「换来的只是磁盘占用」在 3 倍的量级上不再是一句可以耸肩的话,尤其是我们刚刚才答应
 * 用户要把这个数**报在屏幕上**。
 *
 * 次序是量出来的,不能反:先 `optimize` 再 `VACUUM` = 636 + 290ms、161 → 59 MB;
 * 只 `VACUUM` 不 `optimize` = 1445ms、161 → 159 MB(陈旧段此刻还是「活数据」,
 * 照搬一遍而已)。
 *
 * 安全性也是量出来的,不是推的:副本上 `optimize` + `VACUUM` + `wal_checkpoint` 之后
 * `PRAGMA integrity_check` 答 `ok`、文档数 11,767 不变、`vec_docs_384` 的 506 行还在,
 * **同一个查询向量的 KNN 前十条(docId / chunk / distance)逐字节相同**。`docs.docId`
 * 是 `INTEGER PRIMARY KEY`,FTS5 与 vec0 的影子表也各有自己的 `INTEGER PRIMARY KEY` /
 * `AUTOINCREMENT`,所以 VACUUM 不会动任何一个被别处引用的 rowid。
 */

/** 库占了多少地方,按「谁占的」分开。**不含模型** —— 那是另一件东西,不在库里。 */
export interface IndexStorageBreakdown {
  /** 字面索引:整个库文件**减去**向量那一族(含 FTS5、关系表、索引、空闲页)。 */
  lexicalBytes: number
  /**
   * 向量库。**缺席 = 这个库里根本没有向量表**(语义召回从没开过),或者量不出来
   * (`dbstat` 不可用)—— 与「0 字节」不是一回事,屏幕上前者画「—」,后者画「0 MB」。
   */
  vectorBytes?: number
  /** 预写日志(`-wal`)。它是同一个库的一部分,只是另一个文件。 */
  walBytes: number
  /** 量得不准(`dbstat` 这台机器上没有):向量那一半没分出来,全算进了字面。 */
  approximate?: boolean
}

/** SQLite 替影子表自动建的索引的前缀。剥掉它才看得见它服务的是哪张表。 */
const AUTOINDEX_PREFIX = 'sqlite_autoindex_'

/**
 * 哪些表 / 索引属于向量那一族。**纯函数**:`names` 是库里所有表与索引的名字,
 * `virtualTables` 是 `sqlite_schema` 认出来的 `vec0` 虚表名。
 *
 * 虚表名本身也算进去 —— 它在 `dbstat` 里不会出现(虚表自己没有页),留着是为了
 * 「这个库有没有向量表」这个问题有唯一一个产地(`vectorBytes` 的缺席判据)。
 */
export function vectorTableFamily(
  names: readonly string[],
  virtualTables: readonly string[],
): string[] {
  if (virtualTables.length === 0) return []
  return names.filter(name => {
    const bare = name.startsWith(AUTOINDEX_PREFIX) ? name.slice(AUTOINDEX_PREFIX.length) : name
    return virtualTables.some(table => bare === table || bare.startsWith(`${table}_`))
  })
}

/* ── 收拾一下:判据与预案 ────────────────────────────────────────────────── */

/** 决定「要不要收拾」时手上的那几个数。全都是 O(1) 或近似 O(1) 问得到的。 */
export interface IndexMaintenanceStats {
  /** FTS5 此刻有几个段(`SELECT COUNT(DISTINCT segid) FROM docs_fts_idx`)。 */
  segments: number
  /** 库一共多少页 / 其中空闲多少页 / 一页多少字节。 */
  pageCount: number
  freelistCount: number
  pageSize: number
}

export interface IndexMaintenancePolicy {
  /**
   * 段数到了这个数才 `optimize`。
   *
   * 取 8 的理由:FTS5 自己的自动合并把每一层压到 4 个段以内,所以**健康的库段数是
   * 个位数**;真店那一份是 26。8 在两者之间,而且它两边都不贴边 —— 贴着 4 会在一个
   * 本来就健康的库上反复做无用功(每次起 Worker 一次 600ms),贴着 26 会等到病入膏肓。
   */
  minSegments: number
  /**
   * 空闲页占比到了这个数才 `VACUUM`。`optimize` 之后真店那一份是 **64%**(25,558 /
   * 40,180),健康的库是千分之几,所以 10% 这条线两边都离得很远。
   */
  minFreelistRatio: number
  /**
   * `VACUUM` 要**照搬一遍活数据**,所以耗时跟着活数据走。副本上的读数是
   * 58 MB / 290ms ≈ 200 MB/s;派工单给的预算是 2s,这里取 256 MB(≈1.3s)留一半余量。
   * 活数据超过它就**只做 `optimize` + `wal_checkpoint(TRUNCATE)`** —— 段收干净了,
   * 空出来的页下次写入会被重用,只是文件不缩。少收一点地方,好过把 Worker 按住五秒。
   */
  maxVacuumBytes: number
}

export const DEFAULT_INDEX_MAINTENANCE_POLICY: IndexMaintenancePolicy = {
  minSegments: 8,
  minFreelistRatio: 0.1,
  maxVacuumBytes: 256 * 1024 * 1024,
}

/**
 * 段太多了吗。**纯函数** —— 于是「什么时候会 optimize」可以逐条单测。
 */
export function shouldOptimizeFullText(
  stats: IndexMaintenanceStats,
  policy: IndexMaintenancePolicy = DEFAULT_INDEX_MAINTENANCE_POLICY,
): boolean {
  return stats.segments >= policy.minSegments
}

/**
 * 空得该缩一缩了吗,而且缩得起吗。
 *
 * **这一问必须拿 `optimize` 之后的读数问**(施工时踩过):真店那一份在 optimize
 * 之前空闲页只有 224 页(0.5%),optimize 之后才是 25,558 页(64%)—— 陈旧段在
 * optimize 之前是「活数据」。拿之前的读数问,答案永远是「不用缩」,那 100 MB 就
 * 只会变成空闲页留在文件里,屏幕上那一行照旧写 161 MB。所以调用方量两次。
 *
 * 第二条判据是**缩得起吗**:VACUUM 照搬的是活数据,所以耗时跟着活数据走,而不是
 * 跟着文件大小走(一个 161 MB 里 100 MB 空着的库,它只搬 61 MB)。
 */
export function shouldVacuum(
  stats: IndexMaintenanceStats,
  policy: IndexMaintenancePolicy = DEFAULT_INDEX_MAINTENANCE_POLICY,
): boolean {
  if (stats.pageCount <= 0) return false
  if (stats.freelistCount / stats.pageCount < policy.minFreelistRatio) return false
  const liveBytes = Math.max(0, stats.pageCount - stats.freelistCount) * stats.pageSize
  return liveBytes <= policy.maxVacuumBytes
}
