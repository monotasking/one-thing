/**
 * 命令面板那套**子串匹配**的四件纯函数。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2(静态 / 扫描两种基座)。
 *
 * S5 之前它们是 `providers.ts` 与 `search-runtime.ts` 各存一份的私有函数
 * (两处的 `normalizeQuery` / `normalizeOnethingSearchQuery` 实现逐字相同);
 * 旧扫描路退役之后,读它们的只剩下 `capabilities/` 里的能力自己,于是搬到能力
 * 旁边并**只留一份**。
 *
 * 读者:
 *  - `actions.ts` / `prompts.ts`(静态型)与 `files.ts`(扫描型)—— 匹配与打分
 *    就是这三件;
 *  - `sessions.ts` / `notes.ts`(索引型)只借 `normalizeSearchQuery` 判「这是不是
 *    空词」——裸 `/` 与 `>` 归一化之后也是空串,而那两条路对空词各有各的答法。
 *
 * 索引路的分词 / 打分**不在这里**:那是 core 的分析器与 `SqliteIndex` 的事
 * (§5.4 / §6)。这一份只服务于「内存里的一张小表 + 一次 indexOf」那几类。
 */

import * as os from 'node:os'

export type TextMatchRange = { start: number; end: number }

/**
 * 查询归一化:去空白、转小写、剥掉开头一个 `/` 或 `>`。
 *
 * 剥前缀是因为它们是**意图证据**(`actions.manifest.intentPrefixes`),不是要搜的
 * 字;剥完为空 = 「空词」,由各能力自己决定空词答什么。
 */
export function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase().replace(/^>/, '').replace(/^\//, '').trim()
}

/** 一段文本对归一化后的查询打多少分。空查询恒 1(= 「全都算命中」)。 */
export function scoreText(text: string | undefined, query: string): number {
  if (!query) return 1
  const value = (text || '').toLowerCase()
  if (!value) return 0
  if (value === query) return 100
  if (value.startsWith(query)) return 80
  const idx = value.indexOf(query)
  if (idx >= 0) return 60 - Math.min(idx, 40)
  return 0
}

/** 高亮区间(旧字段 `matchRanges`)。空查询 / 不命中都是**缺席**,不是空数组。 */
export function matchRangesOf(text: string, query: string): TextMatchRange[] | undefined {
  if (!query) return undefined
  const idx = text.toLowerCase().indexOf(query)
  return idx >= 0 ? [{ start: idx, end: idx + query.length }] : undefined
}

/** `~` 开头的路径展开成绝对路径;别的原样。 */
export function expandPath(p: string): string {
  if (p.startsWith('~')) return p.replace('~', os.homedir())
  return p
}
