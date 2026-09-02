import { createContext, useContext } from 'react'

/**
 * 一块内容对**自己这一份实例**的两件事实。
 *
 * 同一块内容(同一个 id)可能同时存在好几份实例:架子上那一组 tab 每一份都挂着
 * (keep-alive)。它们渲染的是同一张 `renderContent` 表,所以「我这一份现在算数吗」
 * 不能由内容自己猜 —— 由**摆它的那个宿主**说。
 *
 *  · `visible` —— 这一份在不在屏幕上。keep-alive 的后台 tab 是 false。
 *  · `interactive` —— 这一份可不可以占用**全局**输入(window 上的键盘监听、抢焦点)。
 *    后台 tab 不行:看不见的东西不该吃 Esc、不该抢光标。
 *
 * ── 为什么还是两格(09-02 复核)──────────────────────────────────────────
 * 第三个宿主(Dock 悬停预览泡)退役之前,它是唯一让这两格**分头取值**的人:
 * 泡里那一份 `visible: true` 而 `interactive: false`(看得见,但不许把键盘接过去)。
 * 泡没了之后今天全仓只剩架子那一个非缺省宿主,两格恒等。
 *
 * 仍然保留两格,理由是它们答的是两个问题而不是同一个问题的两种写法:读的人
 * (NotificationsPanel 问「这些算不算被看见了」、use-live 问「这一份该不该听键盘」)
 * 各自问的那一句在语义上就不同,合成一格等于要求下一个宿主先证明这两件事必然同步。
 * 记在这里,免得下次有人看见「两格恒等」就以为是冗余。
 *
 * 缺省是「又看得见又算数」:舞台 / 浮窗里的内容不必显式声明,它们本来就是唯一那一份。
 */
export interface PanelVisibility {
  visible: boolean
  interactive: boolean
}

export const DEFAULT_PANEL_VISIBILITY: PanelVisibility = { visible: true, interactive: true }

export const PanelVisibilityContext = createContext<PanelVisibility>(DEFAULT_PANEL_VISIBILITY)

/** 内容侧读这两件事实的唯一口子。 */
export function usePanelVisibility(): PanelVisibility {
  return useContext(PanelVisibilityContext)
}
