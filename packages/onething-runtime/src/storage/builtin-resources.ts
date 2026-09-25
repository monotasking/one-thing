import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 应用自带资源目录(`resources/<name>`)的定位 —— 技能(`skills`)与 ACP 种子(`acp-agents`)
 * 共用这一条规则(A1-a 从 `skills/loader.ts` 的 `getBuiltinSkillsPath` 抽出来,行为逐字不变):
 *
 *  - 开发 / 无头(没打包)= `<cwd>/resources/<name>`,cwd 是仓根;
 *  - 打包 = `<process.resourcesPath>/<name>`(`electron-builder.yml` 的 `extraResources`
 *    把 `resources/<name>` 搬到那里),拿不到 resourcesPath 就退回 cwd。
 *
 * 「打没打包 / resources 在哪」是宿主才知道的事,所以由调用方递三只取值函数进来;
 * 本文件零依赖,不读任何进程级单例。
 */
export interface BuiltinResourceEnvironment {
  isPackaged?: () => boolean
  getResourcesPath?: () => string | undefined
  getCwd?: () => string
}

export function getBuiltinResourcePath(name: string, env: BuiltinResourceEnvironment = {}): string {
  const cwd = env.getCwd?.() ?? process.cwd()
  if (!env.isPackaged?.()) return path.join(cwd, 'resources', name)
  const resourcesPath = env.getResourcesPath?.()
    ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return path.join(resourcesPath ?? cwd, name)
}

/**
 * 同一条规则,多一步兜底:按规则算出的目录不存在时,再看 Electron 自己的 `process.resourcesPath`。
 *
 * 为什么:React 壳今天给 `skillsEnvironment` 递的是 `null`(`apps/desktop-react/electron/host-ports.ts`
 * 的留账②),打包态按规则算出来的是 `<cwd>/resources/<name>`,而打包 app 的 cwd 是 `/`。ACP 种子
 * (A1-a)取代了 defaults 里写死的四条 agent,找不到种子 = 打包桌面上内置 agent 全部消失。
 * 技能仍走 {@link getBuiltinResourcePath},行为不变。
 */
export function findBuiltinResourcePath(name: string, env: BuiltinResourceEnvironment = {}): string {
  const resolved = getBuiltinResourcePath(name, env)
  if (existsSync(resolved)) return resolved
  const electronResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const fallback = electronResources ? path.join(electronResources, name) : undefined
  return fallback && existsSync(fallback) ? fallback : resolved
}
