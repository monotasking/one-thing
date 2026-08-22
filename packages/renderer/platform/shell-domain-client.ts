/**
 * 外壳能力(打开路径 / 打开外链 / 数据目录)的渲染侧客户端 —— 结构债 P4 终态批
 * A1-b(2026-08-23)。
 *
 * 文件名带 `-domain-` 是为了不和 `platform/shell-client.ts` 撞:那只文件是**传输面**
 * (`createShellClient` 工厂,所有壳域共用),这只是 `shell` **这一个域**的客户端。
 *
 * 三条从前是 `apps/electron/src/ipc/shell-controller.ts` 里不在 `IPC_CHANNELS` 表上
 * 的字面量通道。第四条 `setWindowButtonVisibility` 归 `window` 域,在
 * `platform/window-client.ts` 上。
 */
import { shellRouter } from '@shared/ipc/shell.js'
import { createShellClient } from './shell-client'

export const shellApi = createShellClient(shellRouter)
