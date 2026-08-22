/**
 * plugins 域的**宿主本体那几件事** —— 结构债 P4 终态批 C2。
 *
 * 十九条数据面已经整只迁到通用 RPC 通道(`pluginsRouter` +
 * `packages/backend/rpc/domains/plugins.ts`),留给桌面的只剩三件**只有 Electron
 * 做得到**的事,全都经 `configurePluginsHost` / `configurePluginRequestProgressBroadcaster`
 * 注入给装配层:
 *
 *  1. `file-pick` 的原生对话框(实现在 `./file-pick.ts`);这里只负责把
 *     `RpcDispatchContext.callerId` 还原成发起那次点击的 `WebContents` ——
 *     对话框要挂在**那扇窗**上(描述树既画在主窗也画在设置窗,挂错窗口的模态
 *     对话框在 macOS 上是一张飘在别处的纸);
 *  2. `PLUGINS_REQUEST_PROGRESS` 的**定向回送**:同一个 `callerId`,同一个理由 ——
 *     走 IPCBridge 只投主窗单 sender,设置窗发起的请求进度会永远静默;
 *  3. 插件命令声明的 `exec`:execa 是桌面这棵树的依赖,不该被
 *     `packages/backend` 拖进 `dist/server/main.js` 那个单文件包。
 *
 * 为什么住 `@onething/electron-host/plugins/*` 而不是 `main/ipc/plugins.ts`:
 * 后者是**适配器**,按边界检查器的规矩它一行 electron 都不吃(同 file-pick 判例)。
 */
import { webContents } from 'electron'
import type {
  PickPluginFileRequest,
  PickPluginFileResponse,
  PluginRequestProgressPayload,
} from '@shared/ipc/plugins.js'
import { pickPluginFileOnDesktop } from './file-pick.js'

function resolveCallerWebContents(callerId: string | number | undefined) {
  if (typeof callerId !== 'number') return null
  const target = webContents.fromId(callerId)
  return target && !target.isDestroyed() ? target : null
}

/** 一次 `file-pick`,对话框挂在 `callerId` 那扇窗上(拿不到就挂在应用上)。 */
export function pickPluginFileForCaller(
  request: PickPluginFileRequest,
  callerId: string | number | undefined,
): Promise<PickPluginFileResponse> {
  return pickPluginFileOnDesktop(request, resolveCallerWebContents(callerId))
}

/**
 * 把一条进度定向回送给发起那次调用的窗口。
 *
 * 窗口关掉 = 收件人不在了,这不是错误 —— 静默丢弃(与迁移前
 * `sender.isDestroyed()` 那道检查逐字同义),只在真的 send 失败时记一行。
 */
export function sendPluginRequestProgressToCaller(
  channel: string,
  progress: PluginRequestProgressPayload,
  callerId: string | number | undefined,
  onError?: (error: unknown) => void,
): void {
  const target = resolveCallerWebContents(callerId)
  if (!target) return
  try {
    target.send(channel, progress)
  } catch (error) {
    onError?.(error)
  }
}

/** 插件命令的子进程执行器(execa;`reject:false`,失败也照实回三格)。 */
export async function execPluginCommandOnDesktop(
  command: string,
  args: string[] = [],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execa } = await import('execa')
  try {
    const result = await execa(command, args, {
      cwd: options.cwd,
      reject: false,
    })
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 0,
    }
  } catch (error: any) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || '',
      exitCode: error.exitCode ?? 1,
    }
  }
}
