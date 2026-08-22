/**
 * Search Everywhere **窗口面**的渲染侧客户端 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * 四个动词:`toggle` / `close` / `setAnchor` / `executeAction`。
 * `platformApi.searchQuery` 不在这里 —— 它是数据面,还没迁(见 `@shared/ipc/search.ts`)。
 * `onSearchAction` 也不在:那是推送,router 没有推送面。
 */
import { searchWindowRouter } from '@shared/ipc/search.js'
import { createShellClient } from './shell-client'

export const searchWindowApi = createShellClient(searchWindowRouter)
