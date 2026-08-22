/**
 * themes(主题)域的渲染侧客户端 —— 结构债 P4c 第七批。
 *
 * 形状照 `skills-client.ts` / `spaces-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动;**不包一层旧签名** —— 被删掉的五个壳方法
 * 是位置参数的(`getTheme(themeId)`、`applyTheme(themeId, mode)`),这里一律是
 * 信封:`themesApi.get({ themeId })`、`themesApi.apply({ themeId, mode })`。
 *
 * 无参的三条(`getAll` / `refresh` / `openFolder`)按本仓惯例递 `{}`。
 */
import { themesRouter } from '@shared/ipc/themes.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const themesApi = createRouterClient(themesRouter, request =>
  platformApi.rpcInvoke(request),
)
