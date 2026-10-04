/**
 * headless —— 不带界面的后端(CLI 守护进程用的那一份装配):`HeadlessBackend` 按 headless 档装配后端,
 * 并把守护进程的 NDJSON 请求接到各功能上。
 *
 * 对外交出一样东西:`HeadlessBackend`。守护进程给 CLI 的几种投影(`headless-cli-projections.ts`)只在功能内部用。
 * 依赖几乎所有功能(它是装配配方,L4)。
 */
export { HeadlessBackend } from './headless-backend.js'
