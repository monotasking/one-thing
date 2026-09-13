import { createContext, useContext } from 'react'

/**
 * **这一块输入面板对着哪条会话**(W5-c-2,正本 `composer-in-leaf-2026-09.md` §4.3)。
 *
 * ── 为什么是一格 context,不是一路 prop ──────────────────────────────────
 * 路线 A 之后收件人是**叶递给 `Composer` 的 prop**,而这块面板底下有五六件子件
 * (模型抽屉 / 附件摞 / ask 表 / 读数卡 / 候选列表)也要读同一格事实。一路 prop
 * 传下去等于给每一件都多开一个参数,而它们之间没有一件会用别的会话 ——
 * 「这块面板是谁的」是**整棵子树共享的一格环境事实**,那正是 context 的形状。
 *
 * 它替掉的是从前那句 `useExposeStore((st) => st.currentSessionId)`:那是一句
 * **投影**(焦点叶在看哪条),在只有一块面板的路线 B 下与「这块面板是谁的」恒等,
 * 分屏之后两者分家 —— 抽屉里选的模型会挂到另一条会话上去。
 *
 * 缺省是空串,与保留键那片叶读作空串逐字同义(「是会话叶,但还没绑会话」)。
 * 没有 Provider 时读到的也是它 —— 那正是「还没绑会话」那一态,不是错。
 */
export const ComposerSessionContext = createContext<string>('')

/** 子件读这块面板的收件人。 */
export function useComposerSessionId(): string {
  return useContext(ComposerSessionContext)
}
