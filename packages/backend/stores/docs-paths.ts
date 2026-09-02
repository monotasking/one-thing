/**
 * `configureStorePathHost` —— 打包资源目录的宿主注入口(CLAUDE.md 的 configure*Host 表)。
 *
 * P3'a-2 之前这些函数与整整 38 条 `getX() { return getOnethingX() }` 的转发住在
 * `app/stores/paths.ts` 里,于是「store 根在哪」这件事在仓库里有三个名字:
 * `core/storage/paths.ts` 的通用 `getStorePath`(吃显式 options)、
 * `runtime/storage/paths.ts` 的 `getOnethingStorePath`(产品实现)、以及那层同名转发。
 * 转发层已删,调用点直指 `@onething/runtime/storage`。
 *
 * 留在装配层的只有这一件真事:**docs 目录要看宿主打没打包**。`isPackaged` /
 * `resourcesPath` 只有 Electron 宿主知道,产品层拿不到,所以它是端口而不是转发。
 */
import {
  getOnethingDocsDir,
  getOnethingMacOSAutomationDocsPath,
  getOnethingToolUsageDocsPath,
} from '@onething/runtime/storage'

export interface StorePathHost {
  isPackaged?: boolean
  resourcesPath?: string
}

let storePathHost: StorePathHost = {}

export function configureStorePathHost(host: StorePathHost): void {
  storePathHost = host
}

function hostOptions() {
  return {
    isPackaged: Boolean(storePathHost.isPackaged),
    resourcesPath: storePathHost.resourcesPath || process.resourcesPath,
    cwd: process.cwd(),
  }
}

export function getDocsDir(): string {
  return getOnethingDocsDir(hostOptions())
}

export function getMacOSAutomationDocsPath(): string {
  return getOnethingMacOSAutomationDocsPath(hostOptions())
}

export function getToolUsageDocsPath(): string {
  return getOnethingToolUsageDocsPath(hostOptions())
}
