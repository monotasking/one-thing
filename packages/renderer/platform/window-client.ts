/**
 * 发起窗自己的两件事(关掉它 / 改它的红绿灯显隐)的渲染侧客户端 ——
 * 结构债 P4 终态批 A1-a + A1-b(2026-08-23)。
 *
 * `close` 的入参是空信封,`setButtonVisibility` 只带「显还是隐」:**要动哪扇窗
 * 由宿主从 `callerId` 认**,渲染层没有机会点名。
 */
import { windowRouter } from '@shared/ipc/window.js'
import { createShellClient } from './shell-client'

export const windowApi = createShellClient(windowRouter)
