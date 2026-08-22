/**
 * 外壳能力的**宿主壳路由**(结构债 P4 终态批 A1-b,2026-08-23)。
 *
 * 三条:用系统默认程序打开一个本地路径、把一个 URL 交给系统浏览器、问这台宿主
 * 的数据目录在哪。它们从前是 `apps/electron/src/ipc/shell-controller.ts` 里三条
 * **不在 `IPC_CHANNELS` 表上的字面量通道**(`shell:open-path` / `shell:open-external`
 * / `app:get-data-path`)—— A1-a 的报告点名的那批遗留,transport 门连数都数不到。
 *
 * 与产品层的 `configureShellHost`(`@onething/runtime/shell/host-ports`)是**两件事**,
 * 不要合并:那个端口是「产品代码(技能域等)要打开一个目录」的注入口,方向是
 * 装配层 → 宿主;这里是「渲染层要打开一个路径」的传输面,方向是渲染层 → 宿主。
 * 同一批 `openElectronPath` / `openElectronExternal` 实现被两条路各自调用,一直如此。
 *
 * `openPath` 的输出**是一个字符串**而不是信封:Electron 的 `shell.openPath` 回的
 * 就是错误串('' = 成功),迁移前渲染层拿到的也正是它 —— 这批只搬路,不改形状。
 */
import { defineRouter } from './router.js'

export interface ShellOpenPathRequest {
	filePath: string
}

export interface ShellOpenExternalRequest {
	url: string
}

export interface ShellOpenExternalResponse {
	success: boolean
	error?: string
}

export type ShellRoutes = {
	/** Electron `shell.openPath` 的原样回值:空串 = 成功,否则是错误描述。 */
	openPath: { input: ShellOpenPathRequest; output: string }
	openExternal: { input: ShellOpenExternalRequest; output: ShellOpenExternalResponse }
	/** 这台宿主的 store 根(`getOnethingStorePath()`)。 */
	getDataPath: { input: Record<string, never>; output: string }
}

export const shellRouter = defineRouter<ShellRoutes>('shell', [
	'openPath',
	'openExternal',
	'getDataPath',
])
