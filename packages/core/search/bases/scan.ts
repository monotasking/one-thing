/**
 * 扫描型基座。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 第二行
 *
 * 惰性:`scan(ctx)` 产一条流 → `match(query)` 过滤 → 取到 limit 就停,不把整棵树读完。
 * 分页是**续扫**:游标记位置,下一页从那儿接着扫(目录变了接受微漂 —— 这是明说的取舍,
 * 不是 bug)。`total` 不给 —— 扫描器不知道全集有多大,不知道就别编。
 */

import type {
  Candidate,
  PageRequest,
  SearchContext,
  SearchPage,
  SearchQuery,
} from '../candidate.js'
import type { CapabilityManifest, SearchCapability } from '../capability.js'
import type { CursorCodec, PositionCursor } from '../cursor.js'
import { createCursorCodec } from '../cursor.js'

export const POSITION_CURSOR_KIND = 'position'

export interface ScanCapabilityOptions<TItem> {
  manifest: CapabilityManifest
  scan(query: SearchQuery, ctx: SearchContext): AsyncIterable<TItem>
  /** 命中就返回候选,不中返回 null */
  match(query: SearchQuery, ctx: SearchContext): (item: TItem) => Candidate | null
  /** 这一条在扫描序里的位置;续扫靠它 */
  positionOf(item: TItem): string
  supports?(query: SearchQuery): boolean
  codec?: CursorCodec
  now?: () => number
}

export function scanCapability<TItem>(options: ScanCapabilityOptions<TItem>): SearchCapability {
  const manifest = options.manifest
  const codec = options.codec ?? createCursorCodec()
  const now = options.now ?? (() => Date.now())

  return {
    manifest,
    supports: options.supports ?? (query => query.raw.trim().length > 0),

    async search(query: SearchQuery, page: PageRequest, ctx: SearchContext): Promise<SearchPage> {
      const startedAt = now()
      const resume = readPosition(codec, page.cursor, manifest.id)
      const matcher = options.match(query, ctx)

      const items: Candidate[] = []
      let position: string | undefined
      /** 已经交出去的最后一条的位置 —— 游标记它,下一页从它的下一条接着扫。 */
      let lastGiven: string | undefined
      let skipping = resume !== undefined

      for await (const item of options.scan(query, ctx)) {
        if (ctx.signal.aborted) break
        position = options.positionOf(item)
        if (skipping) {
          // 上一页停在这儿:这一条已经给过了,从它的下一条接着扫。
          if (position === resume) skipping = false
          continue
        }
        const candidate = matcher(item)
        if (candidate === null) continue
        items.push(candidate)
        if (items.length > page.limit) {
          // 多扫出一条才发游标 —— 「恰好装满」不等于「还有下一页」,而契约说
          // cursor 缺席 = 取尽。代价是每页多扫到下一个命中为止,这是诚实的价钱。
          items.pop()
          return {
            items,
            took: now() - startedAt,
            cursor: codec.encode<PositionCursor>({
              capability: manifest.id,
              kind: POSITION_CURSOR_KIND,
              payload: { position: lastGiven! },
            }),
          }
        }
        lastGiven = position
      }

      // 扫到底了:没有游标 = 取尽。
      return { items, took: now() - startedAt }
    },
  }
}

function readPosition(
  codec: CursorCodec,
  cursor: string | undefined,
  capability: string,
): string | undefined {
  if (cursor === undefined) return undefined
  const decoded = codec.tryDecode<PositionCursor>(cursor)
  if (decoded === undefined) return undefined
  if (decoded.capability !== capability || decoded.kind !== POSITION_CURSOR_KIND) return undefined
  const payload = decoded.payload
  return payload !== null && typeof payload === 'object' && typeof payload.position === 'string'
    ? payload.position
    : undefined
}
