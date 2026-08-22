/**
 * 「开设置窗」的渲染侧客户端 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * 一个动词。设置域的四条数据面在 `platform/settings-client.ts`(走
 * `rpc:invoke`);这一条要 Electron 本体,所以走 `shell:invoke`。
 */
import { settingsWindowRouter } from '@shared/ipc/settings.js'
import { createShellClient } from './shell-client'

export const settingsWindowApi = createShellClient(settingsWindowRouter)
