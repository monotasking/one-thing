import type { ReactNode } from 'react'
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

export function renderContent(id: string | null): ReactNode {
  if (!id) return null
  const R = RENDERERS[id]
  return R ? <R /> : null
}
