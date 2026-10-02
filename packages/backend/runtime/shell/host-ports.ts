/**
 * 宿主外壳能力的注入口 —— 「用系统的方式打开一个东西」。
 *
 * 四个域今天各自直连 Electron 宿主的 shell 原语:files 的
 * `reveal`、skills 的 `openDirectory`、themes 的 `openThemesFolder`、oauth 的
 * `start`(openExternal)。它们要的其实是同一件能力,而这件能力**只有 Electron
 * 桌面有** —— server / CLI 守护进程没有文件管理器,也没有默认浏览器。
 *
 * 判例照 `auth/host-ports.ts` 与 `configureTodoPlanHost({ revealDirectory })`:
 * 产品层零依赖、**late-bound**(每次调用现读,所以宿主启动时接线对模块求值期就
 * 构造好的单例同样生效)、**未注入即降级**而不是抛错 —— 没有宿主的进程里,
 * 「打开目录」是一件做不到的事,不是一个 bug。
 *
 * 返回形状与 Electron 的原语对齐,免得调用点为降级再写一层翻译:
 *  - `openPath` 沿用 `shell.openPath` 的约定 —— **空串 = 成功**,非空串 = 失败原因;
 *  - `openExternal` / `revealPath` 回结构化的 `{ success, error? }`。
 *
 * 结构债 P4c 第二批:本批只有 skills 域接上它(`rpc/domains/skills.ts` 的
 * `openDirectory`);files / themes / oauth 三处留给后批(拍板 #19/#20)。
 */

/** 未注入宿主时给出的统一原因串。调用点按它分支毫无意义 —— 它只用来说人话。 */
export const SHELL_HOST_UNAVAILABLE = 'shell host not available'

export interface ShellHostResult {
  success: boolean
  error?: string
}

/**
 * 宿主可以贡献的三件事。全都可选:给一件就有一件,不给的那件降级。
 */
export interface ShellHostPorts {
  /** `shell.openPath` 语义:resolve 出空串 = 成功,非空串 = 失败原因。 */
  openPath?(targetPath: string): Promise<string> | string
  /** `shell.openExternal` 的包装。 */
  openExternal?(url: string): Promise<ShellHostResult> | ShellHostResult
  /** `shell.showItemInFolder` 的包装(在文件管理器里定位到目标)。 */
  revealPath?(targetPath: string): Promise<void> | void
}

/** 永远可调用的门面 —— 未注入时三件事都是 no-op + 结构化失败。 */
export interface ShellHost {
  openPath(targetPath: string): Promise<string>
  openExternal(url: string): Promise<ShellHostResult>
  revealPath(targetPath: string): Promise<ShellHostResult>
}

let hostPorts: ShellHostPorts = {}
/**
 * 宿主**声明过**这件能力没有(C0 R7)。
 *
 * 与 `hostPorts` 分开记,因为它们回答的是两个问题:`hostPorts` 是"具体给了哪几件",
 * 这一格是"这台宿主认不认领外壳能力"。R7 之前 `hasShellHost()` 数的是前者的内容,
 * 而 `hasVoiceHost()` / `hasTerminalHost()` 数的是后者(闩 / 广播器非 null)——
 * 同一族访问器两种口径。统一成闩:`configureShellHost({})` 也算声明,与
 * `configureVoiceHost({})` 逐字同义(声明了一张空表是宿主自己的事)。
 */
let declared = false

export function configureShellHost(ports: ShellHostPorts): void {
  hostPorts = ports
  declared = true
}

/**
 * 还原到**未注入**态(C0 R6)。`applyHostPorts` 的还原函数逆序调它,于是
 * `backend.dispose()` 之后这个进程回到"没有宿主声明过这件能力"。
 */
export function resetShellHost(): void {
  hostPorts = {}
  declared = false
}

/** 当前注入的原始端口。串联/诊断用;日常调用请走 `getShellHost()`。 */
export function getShellHostPorts(): ShellHostPorts {
  return hostPorts
}

/**
 * 宿主到底有没有外壳能力(UI 据此决定要不要画那个按钮)。
 *
 * C0 R7:判据是**宿主声明过**(闩),不再是"这张表里至少有一个函数"。今天没有
 * 任何宿主写 `shell: {}` —— Vue 桌面给三件齐全的实现,其余四个宿主一律 `null` ——
 * 所以两种口径对现网的每一台宿主给出的答案逐字相同;变的是口径本身的一致性
 * (与 `hasVoiceHost()` / `hasTerminalHost()` 同一句话)。真写了 `shell: {}` 的
 * 宿主从此拿到 `true`,而三件事各自的降级仍在 `getShellHost()` 里 —— 那才是
 * "给了没给这一件"的产地。
 */
export function hasShellHost(): boolean {
  return declared
}

/**
 * 门面对象是**常量**,三个方法每次调用现读 `hostPorts` —— 所以谁先谁后都不影响:
 * 模块求值期拿到的这一个对象,在宿主 `configureShellHost` 之后自动变得有能力。
 */
const shellHost: ShellHost = {
  async openPath(targetPath) {
    const port = hostPorts.openPath
    if (!port) return SHELL_HOST_UNAVAILABLE
    return (await port(targetPath)) ?? ''
  },
  async openExternal(url) {
    const port = hostPorts.openExternal
    if (!port) return { success: false, error: SHELL_HOST_UNAVAILABLE }
    return await port(url)
  },
  async revealPath(targetPath) {
    const port = hostPorts.revealPath
    if (!port) return { success: false, error: SHELL_HOST_UNAVAILABLE }
    await port(targetPath)
    return { success: true }
  },
}

export function getShellHost(): ShellHost {
  return shellHost
}
