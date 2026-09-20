import type { RefTag } from '@onething/core/references'
import type { RefTypeSpec } from './spec.js'

/**
 * 线上引用类型的注册表。
 *
 * **这个文件里不出现任何一种引用的名字**,和 `packages/core/references` 一样 ——
 * 它只管「唯一性」与「顺序」两件事:
 *
 * - 重复 `type` 直接抛。两份同名自述谁赢是说不清的,而提示词是要逐字稳定的。
 * - `list()` 交的是**登记顺序**,不是字典序:提示词片段走 `channel: 'system'`,
 *   跨会话必须逐字相同,而登记顺序由 `types/index.ts` 从上往下决定,是确定的。
 */
export class RefTypeRegistry {
  private readonly specs = new Map<string, RefTypeSpec>()

  /** 登记一种;返回撤销它的手。重复 type 抛。 */
  register(spec: RefTypeSpec): () => void {
    if (this.specs.has(spec.type)) {
      throw new Error(`duplicate reference type: ${spec.type}`)
    }
    this.specs.set(spec.type, spec)
    return () => {
      // 身份守卫:别人已经顶掉这一格时,撤销的是自己那一份,不能误删新的。
      if (this.specs.get(spec.type) === spec) this.specs.delete(spec.type)
    }
  }

  list(): readonly RefTypeSpec[] {
    return [...this.specs.values()]
  }

  get(type: string): RefTypeSpec | undefined {
    return this.specs.get(type)
  }

  /**
   * 这张表对一个标签的纯文本说法;没有自己的说法就答 null,由编解码器的缺省
   * 投影接手。形状正好是 `projectRefTagsToPlainText` 的 `describe` 参数。
   */
  describePlainText = (tag: RefTag): string | null => {
    return this.specs.get(tag.type)?.plainText?.(tag) ?? null
  }
}

/** 进程内一份;`types/index.ts` 逐行登记内置的那几种。 */
export const refTypes = new RefTypeRegistry()
