import { dialogRouter } from '@shared/ipc/dialog'
import type { ShowOpenDialogRequest, ShowOpenDialogResponse } from '@shared/ipc/dialog'

/**
 * 原生打开对话框的端口(`dialog` RPC 域)。
 *
 * 对话框是**宿主**拉起的:桌面壳在主进程注入 `dialog` 端口,独立 server / 浏览器壳连上的
 * 那台 core 没有窗口,答 `unavailable: true` —— 调用方据它退到路径输入框
 * (`content/files/open-dir-hub.ts` 的 `requestDirectory`),不当作取消。
 */
export interface DialogPort {
  showOpen(request: ShowOpenDialogRequest): Promise<ShowOpenDialogResponse>
}

let port: DialogPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureDialogPort(next: DialogPort | undefined): void {
  port = next
  pending = undefined
}

/** 惰性建:它要的是连通之后才存在的客户端(与 skills-port 同一判词)。 */
async function realPort(): Promise<DialogPort> {
  const { onethingClient } = await import('../platform/connection')
  const client = await onethingClient()
  const api = client.api(dialogRouter)
  return { showOpen: (request) => api.showOpen(request) }
}

let pending: Promise<DialogPort> | undefined

export function dialogPort(): Promise<DialogPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}

/** 一次「挑一个目录」的结果:挑到了 / 用户取消 / 这台宿主没有对话框。 */
export type PickDirectoryOutcome =
  | { kind: 'picked'; path: string }
  | { kind: 'canceled' }
  | { kind: 'unavailable' }

export async function pickDirectoryNative(
  options: { title?: string; defaultPath?: string } = {},
): Promise<PickDirectoryOutcome> {
  let response: ShowOpenDialogResponse
  try {
    const p = await dialogPort()
    response = await p.showOpen({
      properties: ['openDirectory', 'createDirectory'],
      title: options.title,
      defaultPath: options.defaultPath,
    })
  } catch {
    // 连不上 / 老 core 没有这个域:与「没有对话框」同一条退路。
    return { kind: 'unavailable' }
  }
  if (response.unavailable) return { kind: 'unavailable' }
  const path = response.filePaths[0]
  if (response.canceled || !path) return { kind: 'canceled' }
  return { kind: 'picked', path }
}
