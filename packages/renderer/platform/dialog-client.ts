/**
 * 原生「打开」对话框的渲染侧客户端 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * 全仓调用点最多的一条宿主能力(选文件 / 选目录 / 多选)。入参与出参形状与
 * 迁移前 `platformApi.showOpenDialog(options)` 逐字相同,只是名字变成
 * `dialogApi.showOpen(options)`。
 */
import { dialogRouter } from '@shared/ipc/dialog.js'
import { createShellClient } from './shell-client'

export const dialogApi = createShellClient(dialogRouter)
