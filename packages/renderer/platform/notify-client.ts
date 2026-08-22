/**
 * 系统通知与 dock 徽标的渲染侧客户端 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * 两个动词。`onActivate`(用户点了通知)不在这里 —— 那是推送,仍是
 * `platformApi.notify.onActivate`。
 */
import { notifyRouter } from '@shared/ipc/notify.js'
import { createShellClient } from './shell-client'

export const notifyApi = createShellClient(notifyRouter)
