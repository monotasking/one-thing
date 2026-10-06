import type { ShowOpenDialogRequest, ShowOpenDialogResponse } from '@shared/contracts/client-action'
import { showNativeOpenDialog } from '../platform/host'

/**
 * 原生打开对话框的端口。
 *
 * 对话框是**客户端自己**开的(第④步批 1,决策 D278):桌面经 preload 的 `host:client-action`
 * 交给主进程,不再绕后端的 `dialog` 域;浏览器壳没有那条口,答 `unavailable: true` —— 调用方据它
 * 退到路径输入框(`content/files/open-dir-hub.ts` 的 `requestDirectory`),不当作取消。
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

/** 真实现:直接交给这台客户端的宿主(不经后端,所以也不等连通)。 */
async function realPort(): Promise<DialogPort> {
  return { showOpen: (request) => showNativeOpenDialog(request) }
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
    // 宿主那一侧抛了:与「没有对话框」同一条退路。
    return { kind: 'unavailable' }
  }
  if (response.unavailable) return { kind: 'unavailable' }
  const path = response.filePaths[0]
  if (response.canceled || !path) return { kind: 'canceled' }
  return { kind: 'picked', path }
}
