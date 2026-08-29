import { createContext, useContext } from 'react'

/**
 * 一块内容对**自己这一份实例**的两件事实。
 *
 * 同一块内容(同一个 id)可能同时存在好几份实例:架子上那一组 tab 每一份都挂着
 * (keep-alive),Dock 悬停预览泡里还有一份。它们渲染的是同一张 `renderContent` 表,
 * 所以「我这一份现在算数吗」不能由内容自己猜 —— 由**摆它的那个宿主**说。
 *
 * 两件事故意分开,因为它们真的会分头取值:
 *  · `visible` —— 这一份在不在屏幕上。keep-alive 的后台 tab 是唯一的 false;
 *    预览泡里那一份是**看得见的**,所以它是 true。
 *  · `interactive` —— 这一份可不可以占用**全局**输入(window 上的键盘监听、抢焦点)。
 *    后台 tab 不行(看不见的东西不该吃 Esc);预览泡也不行(悬停看一眼不该动状态机,
 *    更不该让方向键同时驱动两份同一个 store)。
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
