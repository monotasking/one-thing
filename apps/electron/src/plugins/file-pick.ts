/**
 * `file-pick` 节点的**原生对话框**(B 期,用户壁纸)。
 *
 * 这一层是 Electron 独有的那一段:拉起 `dialog.showOpenDialog`,把用户选中的
 * 路径**就地**交给装配层的拷贝函数。路径一步也不回到 renderer,更不回到插件 ——
 * 出口只有一个 `storage:` 地址。
 *
 * 为什么住这里而不住 `main/ipc/plugins.ts`:那个文件是**适配器**(把共享契约
 * 接到 `@onething/electron-host/ipc/plugins` 的工厂上),按边界检查器的规矩它
 * 一行 electron 都不吃。凡是要 electron 的,住 `@onething/electron-host/*`。
 *
 * 手势锚定在这里是天然的:原生对话框只能由用户的那一次点击拉起来,插件没有
 * 可以伪造的入口 —— 所以这条路径上没有(也不需要)`userGesture` 那种布尔。
 */
import { BrowserWindow, dialog } from 'electron'
import { resolvePluginFilePickAccept } from '@onething/core/plugins'
import { importPluginFile } from '@onething/backend/plugins/file-import.js'
import type { PickPluginFileRequest, PickPluginFileResponse } from '@shared/ipc/plugins.js'

export interface PickPluginFileDeps {
  /** 注入点,测试用。 */
  showOpenDialog?: typeof dialog.showOpenDialog
  fromWebContents?: typeof BrowserWindow.fromWebContents
  importFile?: typeof importPluginFile
}

/**
 * 一次 file-pick:对话框 → 闸 → 拷贝 → 地址。
 *
 * `sender` 是发起这次点击的 WebContents。对话框挂**它那个窗口**上 ——
 * 描述树既画在主窗也画在设置窗,挂错窗口的模态对话框在 macOS 上是一张
 * 飘在别处的纸(与 pluginRequest 的 progress 定向回送同一个理由)。
 */
export async function pickPluginFileOnDesktop(
  request: PickPluginFileRequest,
  sender: unknown,
  deps: PickPluginFileDeps = {},
): Promise<PickPluginFileResponse> {
  if (!request?.pluginId) return { error: 'That file could not be imported.' }

  const showOpenDialog = deps.showOpenDialog ?? dialog.showOpenDialog
  const fromWebContents = deps.fromWebContents ?? BrowserWindow.fromWebContents
  const importFile = deps.importFile ?? importPluginFile

  const dialogOptions = {
    title: request.label || 'Choose a file',
    properties: ['openFile' as const],
    filters: [{
      name: 'Images',
      // accept 的收窄判据在 core;这里只是给系统面板一个同源的过滤器,让用户
      // 一开始就看不到选不了的文件。**它是便利,不是安全边界** —— 真正的闸
      // 在拷贝入口再跑一遍(用户可以在面板里手打一个路径绕过过滤器)。
      extensions: resolvePluginFilePickAccept(request.accept),
    }],
  }

  const parent = sender ? fromWebContents(sender as never) : null
  const result = parent
    ? await showOpenDialog(parent, dialogOptions)
    : await showOpenDialog(dialogOptions)

  // 取消 = **不是失败**:调用方什么也不做,插件根本不被叫醒。
  if (result.canceled || !result.filePaths.length) return { canceled: true }

  const outcome = importFile({
    pluginId: request.pluginId,
    sourcePath: result.filePaths[0],
    accept: request.accept,
    maxBytes: request.maxBytes,
  })
  return outcome.ok ? { ...outcome.result } : { error: outcome.reason }
}
