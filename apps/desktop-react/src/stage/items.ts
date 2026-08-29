import type { StageItemSpec } from './types'

/**
 * 会话总览这块瓦的 id。它被三处**非本地**地引用(顶栏那道入口 / 内容表 /
 * 「进入会话就把它收回 Dock」),所以不许各写各的字面量 —— 一处改名,三处一起改。
 */
export const SESSIONS_ITEM_ID = 'sessions'

/**
 * L1 是静态 mock 表。之后接真实数据时,只有这张表换来源,
 * 形态机 / 组件一行不改 —— 这是把 items 单独放一个文件的全部理由。
 */
export const STAGE_ITEMS: StageItemSpec[] = [
  { id: 'files', titleKey: 'item.files', scope: 'session', icon: 'FolderTree' },
  { id: 'diff', titleKey: 'item.diff', scope: 'session', icon: 'GitCompare', badge: { count: 2, tone: 'danger' } },
  { id: 'terminal', titleKey: 'item.terminal', scope: 'session', icon: 'Terminal', badge: { text: '✓', tone: 'ok' } },
  { id: 'browser', titleKey: 'item.browser', scope: 'global', icon: 'Globe' },
  // 检索是一块普通的瓦:参与 Placement 全套(⌘P 也只是"按它的打开方式开一下")。
  { id: 'search', titleKey: 'item.search', scope: 'global', icon: 'Search' },
  // 会话总览同样是一块普通的瓦(08-29 拍板去接管化):它有内容、有落点、有打开方式,
  // 和别的瓦逐字走同一条路 —— 「换一整屏」那种特权形态已经退役。
  { id: SESSIONS_ITEM_ID, titleKey: 'item.sessions', scope: 'global', icon: 'LayoutGrid' },
  { id: 'settings', titleKey: 'item.settings', scope: 'global', icon: 'Settings' },
]

export const SESSION_ITEMS = STAGE_ITEMS.filter((i) => i.scope === 'session')
export const GLOBAL_ITEMS = STAGE_ITEMS.filter((i) => i.scope === 'global')

export function findItem(id: string | null): StageItemSpec | undefined {
  if (!id) return undefined
  return STAGE_ITEMS.find((i) => i.id === id)
}
