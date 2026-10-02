/**
 * 「请用户挑一个东西」的**宿主注入口** —— 原生打开对话框(选目录 / 选文件)。
 *
 * 与 `shell/host-ports.ts`(「用系统的方式打开一个东西」)是两件能力,不并进去:`shell`
 * 是一格**闩**,声明了就会让 `hasShellHost()` / `capabilities.shellTools` / oauth 的
 * `openExternal` 一起翻真 —— 挑目录不该顺手改这三处判据。
 *
 * 判例照 `shell/host-ports.ts`:产品层零依赖、**late-bound**(每次调用现读)、**未注入即
 * 结构化降级**而不是抛错 —— 没有窗口的进程(独立 server、CLI 守护进程)里「拉起一扇
 * 对话框」是做不到的事,不是 bug。降级答 `unavailable: true`,客户端据它退到路径输入框。
 *
 * 形状与跨进程契约里的 `ShowOpenDialogRequest/Response` 结构相同(产品层不许 import
 * 那份契约,所以这里自己写一份,由 `rpc/domains/dialog.ts` 的类型检查对齐)。
 */

export type OpenDialogProperty = 'openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory'

export interface OpenDialogRequest {
  properties?: OpenDialogProperty[]
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface OpenDialogResponse {
  canceled: boolean
  filePaths: string[]
  /** 这台宿主没有原生对话框 —— 与「用户点了取消」分开。 */
  unavailable?: boolean
}

export interface DialogHostPorts {
  /** `dialog.showOpenDialog` 的包装。挂在哪扇窗上由宿主自己决定。 */
  showOpen(request: OpenDialogRequest): Promise<OpenDialogResponse>
}

let hostPorts: DialogHostPorts | null = null

export function configureDialogHost(ports: DialogHostPorts): void {
  hostPorts = ports
}

/** 还原到未注入态(C0 R6)。`applyHostPorts` 的还原函数逆序调它。 */
export function resetDialogHost(): void {
  hostPorts = null
}

/** 永远可调用:未注入时答结构化的「这台宿主没有对话框」。 */
export async function showOpenDialogViaHost(request: OpenDialogRequest): Promise<OpenDialogResponse> {
  const port = hostPorts
  if (!port) return { canceled: true, filePaths: [], unavailable: true }
  return port.showOpen(request)
}
