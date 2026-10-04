/**
 * 音乐 CLI 的 bash 分类策略登记(越层清零 C8,2026-10-04)。
 *
 * 模型靠 bash 驱动音乐 CLI 放歌;每家内置音乐服务商在自己的描述里带着 `bashPolicy`
 * (白名单与「为什么要问」)。这里把**全部**内置策略按可执行文件名登记进工具的 bash 分类器:
 * 只有当前那一家的 CLI 装在机器上,给不存在的可执行文件放行是空操作,所以分类器不需要知道
 * 当前用的是哪一家。装配时(`configureAppRuntimeAdapters()`)调一次,先于任何一次工具执行;幂等。
 */
import { registerBashPolicy } from '@onething/backend/tool'
import { builtinMusicProviders } from './providers/music-providers.js'

export function registerMusicBashPolicies(): void {
  for (const provider of builtinMusicProviders) {
    registerBashPolicy(provider.bashPolicy.binary, provider.bashPolicy)
  }
}
