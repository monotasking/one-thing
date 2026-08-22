/**
 * 深链确认门**请求面**的渲染侧客户端 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * `ready` / `respond`。推来的那张卡不在这里 —— 那是推送,仍是
 * `platformApi.onDeepLinkRequest`。
 */
import { deeplinkRouter } from '@shared/ipc/deeplink.js'
import { createShellClient } from './shell-client'

export const deeplinkApi = createShellClient(deeplinkRouter)
