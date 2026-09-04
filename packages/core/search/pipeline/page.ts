/**
 * page:按游标切页。
 *
 * 设计:docs/design/search-index-2026-09.md §7.3 / §4.2
 *
 * 契约上 **cursor 缺席 = 取尽,total 缺席 = 不知道**。所以这里只在「确实还有下一页」
 * 时才发游标 —— 壳因此可以不再用「回来的比要的少」猜,那种猜法在最后一页恰好装满时
 * 永远猜错。
 *
 * 游标带 `queryHash`:索引变了 hash 变,旧游标自然失效(§11 S1 反证第四条守它)。
 */

import type { Candidate, PageRequest, SearchPage } from '../candidate.js'
import type { CursorCodec, OffsetCursor } from '../cursor.js'

/** 索引型基座的游标形名字。core 不在它上面 switch,只是编解码时对个名。 */
export const OFFSET_CURSOR_KIND = 'offset'

export interface PaginateOptions {
  capability: string
  codec: CursorCodec
  queryHash: string
  /** 全集大小(能力知道就给) */
  total?: number
  /** items 是从第几条开始的 */
  offset?: number
}

/**
 * items 是**这一页**的内容时给 `offset` 与 `total`;items 是全集时不给 offset,
 * 这里自己切。两种用法都要:索引型在库里切好,静态型把整张表交上来。
 */
export function paginate(
  items: readonly Candidate[],
  request: PageRequest,
  options: PaginateOptions,
  took = 0,
): SearchPage {
  const offset = options.offset ?? 0
  const sliced = options.offset === undefined
    ? items.slice(0, Math.max(0, request.limit))
    : [...items]
  const total = options.total ?? (options.offset === undefined ? items.length : undefined)
  const consumed = offset + sliced.length
  const hasMore = total === undefined ? sliced.length >= request.limit : consumed < total

  const page: SearchPage = { items: sliced, took }
  if (total !== undefined) page.total = total
  if (hasMore && sliced.length > 0) {
    const payload: OffsetCursor = { queryHash: options.queryHash, offset: consumed }
    page.cursor = options.codec.encode({
      capability: options.capability,
      kind: OFFSET_CURSOR_KIND,
      payload,
    })
  }
  return page
}

/**
 * 读游标里的 offset。指纹对不上(索引变了 / 换了查询)就当从头来 —— 不抛,
 * 因为壳手里的旧游标不是错误,是过期。
 */
export function readOffsetCursor(
  codec: CursorCodec,
  cursor: string | undefined,
  expect: { capability: string; queryHash: string },
): number {
  if (cursor === undefined) return 0
  const decoded = codec.tryDecode<OffsetCursor>(cursor)
  if (decoded === undefined) return 0
  if (decoded.capability !== expect.capability) return 0
  if (decoded.kind !== OFFSET_CURSOR_KIND) return 0
  const payload = decoded.payload
  if (payload === null || typeof payload !== 'object') return 0
  if (payload.queryHash !== expect.queryHash) return 0
  return Number.isInteger(payload.offset) && payload.offset > 0 ? payload.offset : 0
}
