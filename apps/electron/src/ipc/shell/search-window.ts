/**
 * Search Everywhere 窗口面的**宿主处理者**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 四条从手写通道搬到 `searchWindowRouter`。`executeAction` 看着像数据面,其实整件
 * 事都是窗口活:关掉搜索窗、找到主窗、把 actionId 送进去、再把主窗聚焦 —— 所以
 * 它在这张表上,而只查不动窗的 `search:query` 不在(判据见契约里的记账)。
 *
 * `toggle` / `executeAction` 要知道**是从哪扇窗按的**:那不从信封里读,而是宿主
 * 盖的章 —— `ShellDispatchContext.callerId`,由注入进来的 `resolveWindow` 翻成一扇
 * 真窗。本文件因此一行 electron 都不 import。
 */
import type {
  SearchExecuteActionRequest,
  SearchExecuteActionResponse,
  SearchWindowOpenOptions,
  SearchWindowResponse,
  SearchWindowRoutes,
  SearchWindowSetAnchorRequest,
} from '@shared/ipc/search.js'
import { searchWindowRouter } from '@shared/ipc/search.js'
import {
  registerShellDomain,
  type ShellDispatchContext,
  type ShellRouteHandlers,
} from '../shell-registry.js'

export interface SearchWindowShellOperations<TWindow> {
  /** 把宿主盖的 callerId 翻成一扇窗(拿不到就是 null,与从前 `event.sender` 缺席同义)。 */
  resolveWindow(context: ShellDispatchContext): TWindow | null
  toggle(sourceWindow: TWindow | null, openOptions?: SearchWindowOpenOptions): SearchWindowResponse
  close(): SearchWindowResponse
  setAnchor(request: SearchWindowSetAnchorRequest): SearchWindowResponse
  executeAction(
    sourceWindow: TWindow | null,
    actionId: string,
  ): SearchExecuteActionResponse | Promise<SearchExecuteActionResponse>
}

export function createSearchWindowShellHandlers<TWindow>(
  operations: SearchWindowShellOperations<TWindow>,
): ShellRouteHandlers<SearchWindowRoutes> {
  return {
    toggle: async (request, context) =>
      operations.toggle(operations.resolveWindow(context ?? {}), request ?? {}),
    close: async () => operations.close(),
    setAnchor: async request => operations.setAnchor(request ?? { anchor: null }),
    executeAction: async (request: SearchExecuteActionRequest, context) =>
      operations.executeAction(operations.resolveWindow(context ?? {}), request?.actionId ?? ''),
  }
}

export function registerSearchWindowShellDomain<TWindow>(
  operations: SearchWindowShellOperations<TWindow>,
): () => void {
  return registerShellDomain(searchWindowRouter, createSearchWindowShellHandlers(operations))
}
