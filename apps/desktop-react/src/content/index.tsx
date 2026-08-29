import type { ReactNode } from 'react'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { DEFAULT_PANEL_VISIBILITY, PanelVisibilityContext } from './visibility'
import type { PanelVisibility } from './visibility'
import { FilesMock } from './FilesMock'
import { DiffMock } from './DiffMock'
import { BrowserMock } from './BrowserMock'
import { TerminalMock } from './TerminalMock'
import { SettingsMock } from './SettingsMock'
import { SearchPanel } from '../search/components/SearchPanel'
import { ExposeView } from '../expose/components/ExposeView'
import { SESSIONS_ITEM_ID } from '../stage/items'

/**
 * 内容按 id 查表 —— 舞台和钉栏共用同一张表,
 * 所以「同一个东西在浮层里和在右栏里长得一样」是结构保证,不靠自觉。
 *
 * **`ChatStream` 不在这张表里**:它是外壳中央那条恒在的聊天区(住在 AppShell 的
 * `.chatArea` 里),不是一块可以被钉进架子或抬上舞台的面板。它跟这些面板同住
 * `src/content/` 只是因为它们都是「内容」,不是因为它们同一种东西。
 */
const RENDERERS: Record<string, () => ReactNode> = {
  files: FilesMock,
  diff: DiffMock,
  browser: BrowserMock,
  terminal: TerminalMock,
  settings: SettingsMock,
  search: SearchPanel,
  [SESSIONS_ITEM_ID]: ExposeView,
}

/**
 * 内容的**唯一出口**,所以错误边界包在这一层而不是每块面板自己包 ——
 * 一块面板炸了只塌它自己(舞台上的、钉栏里的、浮窗里的都一样),
 * 外壳和别的面板照常活着。
 *
 * 边界的 `where` 就是这块内容的 id:错误卡上显示的、崩溃日志里记的,
 * 与查表用的是同一个字符串,不另起一套人话名字。
 *
 * `visibility` 是**宿主对这一份实例的声明**(见 ./visibility.ts):同一块内容可能
 * 同时挂着好几份(架子 keep-alive 的后台 tab、Dock 预览泡),谁算数由摆它的人说。
 * 不传 = 又看得见又算数 —— 舞台 / 浮窗那种「只有一份」的宿主不必操心。
 */
export function renderContent(
  id: string | null,
  visibility: PanelVisibility = DEFAULT_PANEL_VISIBILITY,
): ReactNode {
  if (!id) return null
  const R = RENDERERS[id]
  if (!R) return null
  // 可见性挂在**边界外面**:错误卡也是这一份实例的一部分,后台那一份的错误卡
  // 同样不该抢键盘。边界在里面,所以「重试」重挂的仍然只有面板自己。
  return (
    <PanelVisibilityContext.Provider value={visibility}>
      <ErrorBoundary where={id}>
        <R />
      </ErrorBoundary>
    </PanelVisibilityContext.Provider>
  )
}
