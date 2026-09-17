import { planStrip } from '../../content/todo/plan-strip'
import type { ComposerStrip, StripBarModel } from '../strip'
import { statusStrip } from './status'

/**
 * 输入框顶条的登记表。**顺序固定**:每条的 `useBar` 是 hook,Composer 每次渲染按这张表的
 * 顺序逐条调用 —— 表是模块级常量、运行时不增不减,hook 的调用次序因此恒定。
 */
export const COMPOSER_STRIPS: readonly ComposerStrip[] = [statusStrip, planStrip]
  .slice()
  .sort((a, b) => a.order - b.order)

export function findComposerStrip(id: string): ComposerStrip | undefined {
  return COMPOSER_STRIPS.find((strip) => strip.id === id)
}

/** 逐条问一遍「此刻出不出现」。只在 Composer 顶层调用。 */
export function useComposerStripBars(sessionId: string): { strip: ComposerStrip; bar: StripBarModel | null }[] {
  // 表是常量、顺序恒定,循环里调 hook 的次序每次渲染都一样(rules-of-hooks 要防的正是次序会变)。
  return COMPOSER_STRIPS.map((strip) => ({ strip, bar: strip.useBar(sessionId) }))
}
