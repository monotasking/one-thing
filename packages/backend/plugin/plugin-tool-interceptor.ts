/**
 * 插件给工具调用的拦截端口(D191):把两条拦截链的入口原样装进工具目录要的那个形状
 * (`ToolkitInterceptor`,声明在 `toolkit/toolkit-wiring.ts`)。
 *
 * 工具目录从前直接引这两只函数,于是 toolkit 认识 plugin、入口一交出就长出上层功能。现在反过来:
 * plugin 交出这一只端口对象,`backend.ts` 在造目录那一步把它递进 `buildToolkitCatalog`。
 * 两只函数一个字没改 —— 没有任何插件登记钩子时它们本来就是零分配的早退。
 * 本文件只引兄弟文件,不引 plugin 入口;对 toolkit 只有类型引用。
 */
import type { ToolkitInterceptor } from '@onething/backend/toolkit'
import { runPluginToolCallIntercept } from './plugin-tool-call-intercept-bound.js'
import { runPluginToolResultIntercept } from './plugin-tool-result-intercept-bound.js'

export const pluginToolInterceptor: ToolkitInterceptor = {
  beforeCall: runPluginToolCallIntercept,
  afterResult: runPluginToolResultIntercept,
}
