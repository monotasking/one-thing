import type { ComponentType } from 'react'

/**
 * 输入框顶上的一条「条 + 抽屉」(正本 `docs/todo-2026-09.md` §5.2)。
 *
 * 从前这一格写死是执行状态(`StatusBar` + `DrawerStatus`);今天它是一张登记表
 * (`strips/index.ts`),**Composer 里不出现任何一条的名字**:它按 `order` 依次问每一条
 * 「此刻在这个会话里要不要出现、画什么」,点开哪一条就在抽屉槽里挂那一条的 `Drawer`。
 * 抽屉仍是**一个槽**,后开的顶替先开的(`DrawerKind` 的 `strip` 那一支)。
 *
 * 加一条 = 写一个 `ComposerStrip`(能力自己的模块)+ 登记表一行。
 */
export interface ComposerStrip {
  readonly id: string
  /** 小的在上。 */
  readonly order: number
  /**
   * 这一条此刻要不要出现。**是一只 hook**:每次 Composer 渲染都按登记表的固定顺序调用,
   * 所以里面可以订阅数据;返回 null = 不出现。
   */
  useBar(sessionId: string): StripBarModel | null
  /** 抽屉内容。只在这一条被展开时挂载。 */
  readonly Drawer: ComponentType<{ sessionId: string }>
}

/** 条上左边那枚记号。是数据不是节点:画法归 `StripBar`,各条不各带一份 CSS。 */
export type StripIndicator =
  | { readonly kind: 'spinner' }
  | { readonly kind: 'done' }
  /** 0–1。说得出走到哪儿才用它。 */
  | { readonly kind: 'progress'; readonly value: number }

export interface StripBarModel {
  readonly indicator: StripIndicator
  /** 条上那句话。超出截断。 */
  readonly text: string
  /** 跟在后面的淡色半句(可缺)。 */
  readonly detail?: string
  readonly tone?: 'normal' | 'accent' | 'muted'
  /** 无障碍名(开合这条抽屉的那颗钮)。 */
  readonly label: string
}
