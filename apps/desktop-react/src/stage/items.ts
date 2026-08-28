import type { StageItemSpec } from './types'

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
  // 接管型:点它换一整屏(会话总览),不进 Placement,所以也没有打开方式可选。
  { id: 'sessions', titleKey: 'item.sessions', scope: 'global', icon: 'LayoutGrid', takeover: true },
  { id: 'settings', titleKey: 'item.settings', scope: 'global', icon: 'Settings' },
]

export const SESSION_ITEMS = STAGE_ITEMS.filter((i) => i.scope === 'session')
export const GLOBAL_ITEMS = STAGE_ITEMS.filter((i) => i.scope === 'global')

export function findItem(id: string | null): StageItemSpec | undefined {
  if (!id) return undefined
  return STAGE_ITEMS.find((i) => i.id === id)
}
