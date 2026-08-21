/**
 * shell —— 宿主外壳能力(打开路径 / 打开外链 / 在文件管理器里定位)的产品层门面。
 * 这个目录里今天只有注入口本身:能力由宿主给,产品层只负责「要」。
 */
export {
  configureShellHost,
  getShellHost,
  getShellHostPorts,
  hasShellHost,
  SHELL_HOST_UNAVAILABLE,
  type ShellHost,
  type ShellHostPorts,
  type ShellHostResult,
} from './host-ports.js'
