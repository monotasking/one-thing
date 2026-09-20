import type { RefTag } from '@onething/core/references'

/**
 * 一种引用类型的**自述**(`docs/design/reference-tag-2026-09.md` §2.2)。
 *
 * 这是「能力自述、别人读表」里的那份自述:提示词那一行、纯文本出口那一句,
 * 都是从这张表算出来的,而不是谁在别处按类型名枚举出来的。加一种引用 =
 * 新增一只 `types/<x>.ts` + `types/index.ts` 一行登记,别的地方零改动。
 */
export interface RefTypeAttrSpec {
  /** 属性名,写进标签里的那个字。 */
  name: string
  /** 缺席即报废(提示词里标 required)。 */
  required?: boolean
  /** 一句话:这一格填什么。写给模型看,英文祈使/名词短语。 */
  description: string
}

export interface RefTypeSpec {
  /** 线上 type。全表唯一。 */
  type: string
  /** 提示词里那一行:什么时候写它。 */
  summary: string
  attrs: readonly RefTypeAttrSpec[]
  /** 提示词里的那个例子;由 `formatRefTag` 渲染,所以它永远是合法的正形。 */
  example: RefTag
  /**
   * 纯文本投影(IM / CLI)。缺席 = 编解码器的缺省投影
   * (`label` ▷ `path[:line]` ▷ `href` ▷ `name`)。
   */
  plainText?(tag: RefTag): string | null
}
