/**
 * plugins 的**宿主注入端口** —— 结构债 P4 终态批 C2。
 *
 * 十九条数据面迁到通用 RPC 通道之后,处理者整只落在装配层。它们身上唯一一件
 * 装配层做不到的事是**原生文件对话框**:`file-pick` 描述树节点的一次导入
 * (B 期,用户壁纸)要拉起 `dialog.showOpenDialog`,并且要挂在**发起这次点击的
 * 那个窗口**上 —— 只有 Electron 桌面宿主有这两样。
 *
 * 判例照 `gateway/gateway-lifecycle-port.ts`:**late-bound**(每次调用现读,宿主接线
 * 晚于模块求值也照样生效)、**未注入即结构化降级**而不是抛错 —— 没有窗口的
 * 进程里「拉起文件对话框」是一件做不到的事,不是 bug。降级文案逐字沿用迁移前
 * `platform/web.ts` 那只硬桩。
 *
 * 端口收的第二个参数是 `RpcDispatchContext.callerId`(宿主从 `event.sender.id`
 * 铸的,不从信封里读),桌面据它把对话框挂回发起窗 —— 与 `PLUGINS_REQUEST_PROGRESS`
 * 的定向回送同一个理由:挂错窗口的模态对话框在 macOS 上是一张飘在别处的纸。
 */
import type {
  PickPluginFileRequest,
  PickPluginFileResponse,
} from '@shared/ipc/plugins.js'

/**
 * 未注入宿主时的那句话 —— 与迁移前 `platform/web.ts` 的 `pickPluginFile` 桩
 * **逐字相同**。
 */
export const PLUGIN_FILE_PICK_HOST_UNAVAILABLE
  = 'Importing files into a plugin works on the desktop app only.'

/** 一次子进程执行的结果 —— 形状就是插件命令执行链要的那三格。 */
export interface PluginCommandExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * 未注入执行器时的那三格。起插件管理器的档位(桌面 / CLI)都注入后端自己的执行器;
 * 缺省档没有管理器,http 上的插件命令走 server 自己那本只读镜像(它带着自己的「shell 已禁用」)。
 * 留着是为了让单元测试拿到一条能读懂的答案,而不是一个抛出的异常。
 */
export const PLUGIN_COMMAND_EXEC_UNAVAILABLE
  = 'Shell execution is unavailable in this runtime.'

export interface PluginsHostPorts {
  /**
   * 一次 `file-pick`:对话框 → 闸 → 拷贝 → 一个 `storage:` 地址。
   * `callerId` = 发起这次调用的 renderer(桌面上是 `webContents.id`)。
   */
  pickFile?(
    request: PickPluginFileRequest,
    callerId?: string | number,
  ): Promise<PickPluginFileResponse> | PickPluginFileResponse
  /**
   * 插件命令声明的 `exec`(一条 shell 命令 + 参数 + cwd)。
   *
   * 第④步批 4 起由**后端进程自己**实现(`./plugin-command-process.ts`,execa):插件管理器住在后端进程里,
   * `backend-launcher.ts` 在桌面档 / CLI 档把它填进宿主表这一格;缺省档(`server:start`)不填,
   * 那里不起插件管理器。仍是端口而不是直接调,是因为「这台进程许不许插件起子进程」是档位的事实,不是插件的。
   */
  execCommand?(
    command: string,
    args: string[],
    options: { cwd?: string },
  ): Promise<PluginCommandExecResult>
}

let hostPorts: PluginsHostPorts = {}

export function configurePluginsHost(ports: PluginsHostPorts): void {
  hostPorts = ports ?? {}
}

/**
 * 还原到**未注入**态(C0 R6)。`applyHostPorts` 的还原函数逆序调它,于是
 * `backend.dispose()` 之后这个进程回到"没有宿主声明过这件能力"。
 */
export function resetPluginsHost(): void {
  hostPorts = {}
}

/** 当前注入的端口(诊断 / 测试用)。 */
export function getPluginsHostPorts(): PluginsHostPorts {
  return hostPorts
}

/** 本进程到底有没有原生文件对话框(域按它分支)。 */
export function hasPluginFilePickHost(): boolean {
  return typeof hostPorts.pickFile === 'function'
}

/**
 * 永远可调用的门面。未注入 = 那句结构化降级(**不是** `canceled`:
 * 取消是用户的选择,做不到是宿主的事实,两者在调用方眼里必须分得开)。
 */
export async function execPluginCommandOnHost(
  command: string,
  args: string[] = [],
  options: { cwd?: string } = {},
): Promise<PluginCommandExecResult> {
  const port = hostPorts.execCommand
  if (!port) {
    return { stdout: '', stderr: PLUGIN_COMMAND_EXEC_UNAVAILABLE, exitCode: 126 }
  }
  return port(command, args, options)
}

export async function pickPluginFileOnHost(
  request: PickPluginFileRequest,
  callerId?: string | number,
): Promise<PickPluginFileResponse> {
  const port = hostPorts.pickFile
  if (!port) return { error: PLUGIN_FILE_PICK_HOST_UNAVAILABLE }
  return port(request, callerId)
}
