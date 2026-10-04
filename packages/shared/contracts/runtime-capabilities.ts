/**
 * `GET /api/capabilities` 的答复形状:这个宿主能做什么。
 *
 * 客户端(`@onething/backend-client` 的传输层)读它决定开哪些功能;后端的运行时门面
 * (`packages/backend/http-server/http-server-runtime-facade.ts`)从这里取形状并负责算出答案。
 */
export interface RuntimeHostCapabilities {
  localFileSystem: boolean
  workspaceFileSystem: boolean
  nativeWindowControls: boolean
  shellTools: boolean
  clipboardWrite: boolean
  desktopWindows: boolean
  globalMenuEvents: boolean
  /**
   * 多 agent 协作房(P4 终态批 B,拍板 #12)。**可选**,因为这一位不是「宿主
   * 环境有没有」而是「这个进程里跑没跑那套 actor」—— 只有真的知道答案的宿主才
   * 该开口。省略 = 不表态,客户端用自己的默认值。
   *
   * 装配了 `createOnethingBackend({ collab: true })` 的宿主(桌面 + 它的内嵌
   * HTTP 面)为 true;独立 `server:start` 今天不装配,为 false。
   */
  collabRooms?: boolean
  /**
   * 真 PTY 终端(B3,`docs/design/backend-transport-forks-2026-09.md` §2.3)。
   * 与 `collabRooms` 同一个性质:问的不是"浏览器有没有这件东西",而是**这个进程
   * 的宿主注没注入终端的输出广播器**(`OnethingHostPorts.terminal`)—— 也就是
   * `terminal` 域自己那道闸 `hasTerminalHost()` 读的同一件事。省略 = 不表态。
   */
  terminal?: boolean
  /**
   * 插件**写面**(B3)。判据是 `getPluginManager() !== null` —— 与 `plugins` 域
   * 判"这个进程装没装管理器"的那一问同源。省略 = 不表态,客户端用自己的默认值
   * (渲染侧默认 `false`)。
   */
  pluginsManage?: boolean
  /**
   * 这台机器的家目录(09-13)。**判据与 `localFileSystem` 同一条**
   * (`isHostLocallyTrusted()`):一个不可信的客户端连路径都不夹,更不该知道
   * 这台机器的家目录叫什么 —— 那是一行白送的用户名。不可信 = `null`。
   *
   * 它是**显示层的事实**:客户端拿它把路径前缀画成 `~`(判词在壳的
   * `ui/PathText` 上),而复制、打开、无障碍名一律仍是全路径。后端这一侧
   * 不用它做任何判断 —— 路径的夹取判据在各自那个域里,与这一格无关。
   *
   * 可选是因为它与 `collabRooms` / `terminal` / `pluginsManage` 同族:
   * 省略 = 这个宿主不表态,客户端用自己的默认值(壳:不缩)。
   */
  homeDir?: string | null
}
