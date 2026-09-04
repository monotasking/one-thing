/**
 * 索引前的横切面:两个缺省 `DocumentFilter`。
 *
 * 设计:docs/design/search-index-2026-09.md §5.2c —— 「缺省两个:**排除清单**
 * (用户设置里的「不索引这些会话 / 目录 / 模式」)与**脱敏**(密钥样式整段替换为
 * 占位,不进倒排也不进摘要)。空间隔离不在这里做 —— 它是查询时的 facet,索引照建。」
 *
 * 两个都是 `(doc, ctx) => doc | null` 的纯函数,按注册序串行(`composeDocumentFilters`
 * 在 core),任一返回 `null` 即止。顺序是注册顺序说了算,不是运气:**排除在前、
 * 脱敏在后** —— 不索引的那些根本不必洗。
 */

import type { DocPayload, DocumentFilter, DocumentFilterContext } from '@onething/core/search'
import { redactText } from '@onething/core/search/redact'

/**
 * 脱敏:把每一个字段的正文过一遍 core 的规则表(八条,`core/search/redact.ts`)。
 *
 * 洗的是 `fields` —— 它既是倒排的输入,也是摘要开窗的正文(§5.1「正文**存进**
 * 文档表」),一处洗两处干净。`facets` 不洗:它是能力声明的枚举值(sessionId /
 * role / archived),不是自由文本。
 *
 * 全部字段都没变时**返回同一个对象**:整键替换是幂等的,少造一个对象就少一次
 * 「明明没变却看起来变了」的可能。
 */
export const redactionFilter: DocumentFilter = doc => {
  let changed = false
  const fields: Record<string, string> = {}
  for (const [field, value] of Object.entries(doc.fields)) {
    const redacted = redactText(value)
    if (redacted !== value) changed = true
    fields[field] = redacted
  }
  return changed ? { ...doc, fields } : doc
}

/** 「这一份该不该索引」的判据。`true` = 排除。 */
export type ExclusionPredicate = (doc: DocPayload, ctx: DocumentFilterContext) => boolean

/**
 * 排除清单。判据由外面注入(设置里的「不索引这些会话 / 目录 / 模式」),**缺省
 * 全放行** —— 这个文件不认识任何设置项,也不认识任何能力 id;它只把「谁说了算」
 * 这件事留给注入点。
 */
export function exclusionFilter(predicate?: ExclusionPredicate): DocumentFilter {
  if (predicate === undefined) return doc => doc
  return (doc, ctx) => (predicate(doc, ctx) ? null : doc)
}

/**
 * 缺省的过滤器列表(顺序即语义,见文件头)。装配层可以在两侧再加自己的。
 */
export function defaultDocumentFilters(predicate?: ExclusionPredicate): DocumentFilter[] {
  return [exclusionFilter(predicate), redactionFilter]
}
