/**
 * 「关掉发起窗」的渲染侧客户端 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * 入参是空信封:要关哪扇窗由宿主从 `callerId` 认,渲染层没有机会点名。
 */
import { windowRouter } from '@shared/ipc/window.js'
import { createShellClient } from './shell-client'

export const windowApi = createShellClient(windowRouter)
