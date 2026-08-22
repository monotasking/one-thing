/**
 * Search Everywhere — shared types
 */
import { defineRouter } from './router.js'

export {
  ONETHING_SEARCH_CATEGORIES as SEARCH_CATEGORIES,
  isOnethingSearchCategory as isSearchCategory,
} from '@onething/runtime/search/protocol'
export type {
  OnethingSearchCategory as SearchCategory,
} from '@onething/runtime/search/protocol'

import type { OnethingSearchCategory } from '@onething/runtime/search/protocol'

export interface SearchRequest {
  query: string
  category: OnethingSearchCategory
  limit?: number
}

export interface SearchResult {
  id: string
  /**
   * 'plugin' 是搜索供给方(M2)贡献的结果。宿主据此按 provider label(`group`)
   * 分组渲染,点击只回到插件自己的 action(actionId 带 `plugin-search:` 前缀)——
   * 插件结果拿不到 sessionId / messageId / filePath,不能伪装成内置结果。
   */
  type: 'chat' | 'message' | 'action' | 'file' | 'daily' | 'prompt' | 'plugin'
  title: string
  subtitle?: string
  detail?: string
  sessionId?: string
  messageId?: string
  actionId?: string
  filePath?: string
  timestamp?: number
  shortcut?: string
  matchRanges?: Array<{ start: number; end: number }>
  /** 分组标签(M2 插件结果 = provider label)—— 让插件结果来源可辨。 */
  group?: string
  /** 宿主枚举图标名(M2 插件结果),不是 URL/SVG。 */
  icon?: string
}

export interface SearchResponse {
  success: boolean
  results: SearchResult[]
}

export interface SearchWindowSplitIntent {
  type: 'split-panel'
  panelId: string
}

export type SearchWindowIntent = SearchWindowSplitIntent

export interface SearchWindowOpenOptions {
  intent?: SearchWindowIntent
}

export interface SearchWindowShownPayload {
  intent?: SearchWindowIntent | null
}

/** Anchor rect reported by the main window renderer (CSS px, viewport-relative). */
export interface SearchWindowAnchor {
  x: number
  y: number
  width: number
  height: number
}

export interface SearchWindowGuideState {
  visible: boolean
  centerX: boolean
  defaultTop: boolean
  defaultHeight: boolean
  defaultBounds: boolean
}

/**
 * Search Everywhere 的**窗口面**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 四条走**宿主壳路由**(`shell:invoke`):开关搜索窗、报锚点矩形、以及「执行一条
 * 结果动作」—— 最后这条看着像数据面,其实整件事都是窗口活:关掉搜索窗、找到主窗、
 * 把 actionId 送进去、再把主窗聚焦。
 *
 * 查询**不在这张表上**,是刻意的:它的处理者一行 electron 都不 import(桌面是
 * `wiring/search/providers` 的 `executeSearch`,server 是同一件事的 per-owner
 * 沙箱版),按判据它是**数据面**。A1-b(2026-08-23)把它迁进了 `rpc:invoke` 的
 * backend `search` 域(见本文件下方的 `searchRouter`),`SEARCH_QUERY` 那条常量
 * 随之删除。
 */
export interface SearchWindowResponse {
  success: boolean
}

export interface SearchWindowSetAnchorRequest {
  anchor: SearchWindowAnchor | null
}

export interface SearchExecuteActionRequest {
  actionId: string
}

export interface SearchExecuteActionResponse {
  success: boolean
  /** server 侧会把 `create-daily-note:` 解析成 `open-file:` 后回传。 */
  actionId?: string
  error?: string
}

export type SearchWindowRoutes = {
  toggle: { input: SearchWindowOpenOptions; output: SearchWindowResponse }
  close: { input: Record<string, never>; output: SearchWindowResponse }
  setAnchor: { input: SearchWindowSetAnchorRequest; output: SearchWindowResponse }
  executeAction: { input: SearchExecuteActionRequest; output: SearchExecuteActionResponse }
}

export const searchWindowRouter = defineRouter<SearchWindowRoutes>('search-window', [
  'toggle',
  'close',
  'setAnchor',
  'executeAction',
])

/**
 * Search Everywhere 的**数据面**(结构债 P4 终态批 A1-b,2026-08-23)。
 *
 * 只有一条 `query`,走的是**装配层**的 `rpc:invoke` 而不是上面那张宿主壳表 ——
 * 处理者一行 electron 都不碰。它是继 files / tools / mcp 之后又一个
 * **按 `context.transport` 分叉**的域:
 *  - `ipc`(桌面)= `wiring/search/providers` 的 `executeSearch`,整台机器的一份
 *    会话 / 文件 / 提示词表,逐字沿用迁移前 `apps/electron/src/search/ipc.ts` 那条
 *    手写 handler;
 *  - `http`(server)= per-owner 沙箱里的同一件事(`server/search-providers.ts`
 *    那个单槽端口,装的就是从前 `POST /api/search/query` 背后的同一个闭包)。
 *
 * `SEARCH_ACTION` 是推送、`executeAction` 是窗口活(在 `searchWindowRouter` 上),
 * 两者都不在这里。
 */
export type SearchRoutes = {
  query: { input: SearchRequest; output: SearchResponse }
}

export const searchRouter = defineRouter<SearchRoutes>('search', ['query'])
