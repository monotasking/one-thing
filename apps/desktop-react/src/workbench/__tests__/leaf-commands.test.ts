import { describe, expect, it } from 'vitest'
import { CLOSED_STACK_DEPTH, popClosedTab, pushClosedTab } from '../closed-tabs'
import { nextTabIndex, prevTabIndex, tabIndexForSlot } from '../leaf-commands'
import type { ClosedTab } from '../closed-tabs'

/**
 * **标签族那三只纯算术 + 关闭栈**(K2)。
 *
 * 它们是「⌘⇧] 环绕」「⌘9 = 最后一格」「栈深 10」这三句话的全部实现,所以这一组
 * 是它们唯一需要真机之外的守卫;`useLeafCommands` 那一层只负责「此刻交不交得出
 * handler」,由 `pane-leaf` / `topbar-tabs` 两组渲染用例与真机门 `gate:workspace`
 * 量(判词在 `leaf-commands.ts` 的文件头上)。
 */

describe('上下一格:环绕', () => {
  it('最后一格的下一格是第一格,第一格的上一格是最后一格', () => {
    expect(nextTabIndex(3, 0)).toBe(1)
    expect(nextTabIndex(3, 1)).toBe(2)
    expect(nextTabIndex(3, 2)).toBe(0)
    expect(prevTabIndex(3, 0)).toBe(2)
    expect(prevTabIndex(3, 1)).toBe(0)
    expect(prevTabIndex(3, 2)).toBe(1)
  })

  /**
   * **单格叶不响**(`null` = 不交 handler = 派发器穿过去)。一个原地打转的键
   * 与「按了没反应」在屏幕上是同一件事,而「穿过去」至少把这一下还给了页面。
   */
  it('单格 / 空叶答 null', () => {
    expect(nextTabIndex(1, 0)).toBeNull()
    expect(prevTabIndex(1, 0)).toBeNull()
    expect(nextTabIndex(0, 0)).toBeNull()
    expect(prevTabIndex(0, 0)).toBeNull()
  })

  it('活动下标是 -1(空叶的那一档)时不越界', () => {
    expect(nextTabIndex(2, -1)).toBe(1)
    expect(prevTabIndex(2, -1)).toBe(1)
  })
})

describe('第 n 格:9 是「最后一格」', () => {
  it('1–8 就是第 n 格(1 起)', () => {
    expect(tabIndexForSlot(5, 1)).toBe(0)
    expect(tabIndexForSlot(5, 5)).toBe(4)
  })

  /** 浏览器惯例:⌘9 永远跳到最后一个标签,不管一共有几格。 */
  it('9 = 最后一格,与一共有几格无关', () => {
    expect(tabIndexForSlot(3, 9)).toBe(2)
    expect(tabIndexForSlot(12, 9)).toBe(11)
    expect(tabIndexForSlot(1, 9)).toBe(0)
  })

  it('越界的那几格答 null(那一格不存在,键就该是哑的)', () => {
    expect(tabIndexForSlot(3, 4)).toBeNull()
    expect(tabIndexForSlot(3, 8)).toBeNull()
    expect(tabIndexForSlot(0, 1)).toBeNull()
    expect(tabIndexForSlot(0, 9)).toBeNull()
  })
})

describe('关闭栈:每叶一份,深 10,不落盘', () => {
  const entry = (n: number): ClosedTab => ({ kind: 'doc', snapshot: { n }, index: n })

  it('后进先出', () => {
    let stack = pushClosedTab(undefined, entry(1))
    stack = pushClosedTab(stack, entry(2))
    const first = popClosedTab(stack)!
    expect(first.entry.index).toBe(2)
    const second = popClosedTab(first.rest)!
    expect(second.entry.index).toBe(1)
    expect(popClosedTab(second.rest)).toBeNull()
  })

  it('空栈答 null(⌘⇧T 于是不交 handler)', () => {
    expect(popClosedTab(undefined)).toBeNull()
    expect(popClosedTab([])).toBeNull()
  })

  /**
   * **深 10,超了从栈底丢**(最老的先忘)。它是预算不是能力 —— 一条无界的栈会把
   * 关掉的浏览器 tab 的 url 一直攥在手里。
   */
  it('封顶 10 格,丢的是最老的那一格', () => {
    let stack: readonly ClosedTab[] = []
    for (let n = 1; n <= 13; n += 1) stack = pushClosedTab(stack, entry(n))
    expect(stack).toHaveLength(CLOSED_STACK_DEPTH)
    expect(stack[0].index).toBe(4)
    expect(stack[stack.length - 1].index).toBe(13)
  })

  it('纯函数:原表一个字不动', () => {
    const before: readonly ClosedTab[] = [entry(1)]
    const after = pushClosedTab(before, entry(2))
    expect(before).toHaveLength(1)
    expect(after).toHaveLength(2)
    expect(popClosedTab(after)!.rest).toHaveLength(1)
  })
})
