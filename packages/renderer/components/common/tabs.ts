import type { ComputedRef, InjectionKey, Ref, VNodeChild } from 'vue'

export type TabPaneName = string | number
export type TabsType = '' | 'card' | 'border-card'
export type TabsPosition = 'top' | 'right' | 'bottom' | 'left'
export type TabsEditAction = 'add' | 'remove'

export interface TabPaneSlotProps {
  active: boolean
  disabled: boolean
  index: number
  label: string
  name: TabPaneName
}

export interface TabPaneState {
  uid: number
  element: Ref<HTMLElement | null>
  label: ComputedRef<string>
  name: ComputedRef<TabPaneName | undefined>
  disabled: ComputedRef<boolean>
  closable: ComputedRef<boolean>
  lazy: ComputedRef<boolean>
  /**
   * 页签段(越小越靠前,缺省 0 = 单一段)。
   *
   * 页签条的次序本来**只**是注册(mount)次序 —— 数据数组重排搬不动它,因为
   * 已挂载的 pane 不会重新注册。想让"某一类页签恒在尾段"(工作台的工作区域
   * 页签就是)于是无从谈起:先开 Media 再开 Files,Files 反而排在 Media 之后。
   *
   * 这一格把"段"提成显式声明:同段内仍按注册次序(稳定排序),段之间按数字。
   * 不声明 = 全体同段 = 与从前逐字节一致。
   */
  order: ComputedRef<number>
  renderLabel?: (props: TabPaneSlotProps) => VNodeChild
}

export interface TabsPaneContext extends TabPaneSlotProps {
  closable: boolean
  lazy: boolean
  uid: number
}

export type TabsBeforeLeave = (
  newName: TabPaneName,
  oldName: TabPaneName | undefined,
) => boolean | void | Promise<boolean | void>

export interface TabsContext {
  registerPane: (pane: TabPaneState) => void
  unregisterPane: (uid: number) => void
  isPaneActive: (uid: number) => boolean
  getPaneName: (uid: number) => TabPaneName | undefined
  getPaneTabId: (uid: number) => string | undefined
  getPanePanelId: (uid: number) => string | undefined
}

export const tabsContextKey: InjectionKey<TabsContext> = Symbol('tabs-context')
