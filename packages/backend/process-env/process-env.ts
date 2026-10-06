/**
 * process-env —— 这个进程的环境变量从哪来、缺了什么由谁补。
 *
 * 今天只有一件事:从 Dock / Finder 起的 app 只拿到 launchd 给的那截 `PATH`,于是 ACP 适配器、MCP stdio、
 * bash 工具里的 Homebrew / nvm / bun 命令找不到。这里起一次用户的登录 shell,把它报回来的 `PATH`
 * 并进本进程、把缺席的变量补上(启动者独占的 `ONETHING_*` / `npm_*` / `ELECTRON_*` 永远不补),
 * 结果缓存在 store 里的 `login-shell-env.json`,命中时同步注入、后台再校正一次。
 *
 * 交出一个函数:`hydrateProcessEnvFromLoginShell`(补水;Electron 主进程与不带界面的后端进程的桌面档在
 * 第一次 spawn 之前调)。为什么这样补、09-26 那次缓存事故与三条修法,写在 `process-env-login-shell.ts` 的文件头。
 *
 * 不依赖任何功能(L0):只用 node 内建;store 根按 `ONETHING_STORE_PATH` → `~/.onething` 自己解析,
 * 与 `storage` 的 `getOnethingStorePath()` 同语义。
 */

// 补水。
export { hydrateProcessEnvFromLoginShell } from './process-env-login-shell.js'
