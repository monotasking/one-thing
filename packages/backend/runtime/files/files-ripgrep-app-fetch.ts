/**
 * 装配那一步:让 ripgrep 二进制的下载走应用自己的受管 fetch(代理设置、超时、重试都跟着设置走)。
 *
 * 包根归位 B(2026-10-04)从包根 `utils/ripgrep.ts` 搬来。从前那只文件还原样转发了 `./ripgrep.js` 的十几个名字,
 * 转发已删:那些名字一直经 files 入口交出(`export * from './ripgrep.js'`),用的人改从入口拿。
 */
import { configureOnethingRipgrepRuntime } from './ripgrep.js'
import { createRequiredAppFetch } from '@onething/backend/runtime/settings'

let ripgrepConfigured = false

/** Explicit assembly step: ripgrep binary downloads go through the app fetch. */
export function configureAppRipgrep(): void {
  if (ripgrepConfigured) return
  ripgrepConfigured = true
  configureOnethingRipgrepRuntime({
    createFetch: createRequiredAppFetch,
  })
}
