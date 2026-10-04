/**
 * dialog —— 「请用户挑一个东西」(原生打开对话框:选目录 / 选文件)的宿主注入口。
 *
 * 对外交出一类东西:宿主注入口(装上、装配释放时复位)与宿主要实现的形状 `DialogHostPorts`。
 * 开给界面调用的操作在第二个入口 `dialog-client-api.ts`(D26),不经这里。不依赖别的功能。
 */
export { configureDialogHost, resetDialogHost } from './dialog-host-ports.js'
export type { DialogHostPorts } from './dialog-host-ports.js'
