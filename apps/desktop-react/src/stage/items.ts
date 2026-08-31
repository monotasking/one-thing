import type { StageItemSpec } from './types'

/**
 * 会话总览这块瓦的 id。它被三处**非本地**地引用(顶栏那道入口 / 内容表 /
 * 「进入会话就把它收回 Dock」),所以不许各写各的字面量 —— 一处改名,三处一起改。
 */
export const SESSIONS_ITEM_ID = 'sessions'

/**
 * 通知中心这块瓦的 id。与 SESSIONS_ITEM_ID 同一条理由不许各写各的字面量:
 * 它被内容表、Dock 的未读点、以及 toast 折叠丸那道「打开中心」的门三处引用。
 *
 * 它是一块**普通的瓦** —— 有内容、有落点、有打开方式,和别的瓦逐字走同一条路。
 * 「通知」不该是个特权浮层:能钉能浮能上舞台,这一条是零成本换来的。
 */
export const NOTIFICATIONS_ITEM_ID = 'notifications'

/**
 * 模型服务这块瓦的 id。与上面两个同一条理由不许各写各的字面量:
 * 它被内容表与真机门(gate:a11y 的第三屏)两处引用。
 */
export const PROVIDERS_ITEM_ID = 'providers'

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
  // 未读**不在这张表里**:表是静态声明,未读是当下的事实(住在 services/notify-store)。
  // Dock 渲染时才把两者对上 —— 表里写死一个 dot 就等于让声明冒充状态。
  { id: NOTIFICATIONS_ITEM_ID, titleKey: 'item.notifications', scope: 'global', icon: 'Bell' },
  // 模型服务是**另一块瓦**,不是设置页里的一节:它有自己的左栏名册与右面分坑,
  // 而设置页的版式是「分区不分页的单列表单」(见 content/SettingsMock.tsx 顶部)。
  // 把一块两栏的面塞进那张单列表单,等于让两种版式在同一页里打架。
  { id: PROVIDERS_ITEM_ID, titleKey: 'item.providers', scope: 'global', icon: 'Boxes' },
  { id: 'settings', titleKey: 'item.settings', scope: 'global', icon: 'Settings' },
]

export const SESSION_ITEMS = STAGE_ITEMS.filter((i) => i.scope === 'session')
export const GLOBAL_ITEMS = STAGE_ITEMS.filter((i) => i.scope === 'global')

export function findItem(id: string | null): StageItemSpec | undefined {
  if (!id) return undefined
  return STAGE_ITEMS.find((i) => i.id === id)
}
