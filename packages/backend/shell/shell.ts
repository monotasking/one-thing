/**
 * shell —— 宿主外壳能力(打开路径 / 打开外链 / 在文件管理器里定位)的产品层门面。
 * 这个目录里今天只有注入口本身:能力由宿主给,产品层只负责「要」。
 * 对外交出一类东西:宿主注入口(装上、读、判有没有、装配释放时复位)与它的形状。
 * 不依赖别的功能。
 */
export {
  configureShellHost,
  getShellHost,
  getShellHostPorts,
  hasShellHost,
  resetShellHost,
  SHELL_HOST_UNAVAILABLE,
  type ShellHost,
  type ShellHostPorts,
  type ShellHostResult,
} from './shell-host-ports.js'
