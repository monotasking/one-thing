/**
 * R2b —— 目录端口 + 工具面投影(缝 1 的产品层那一半)。
 *
 * 缝 1 落在 `agent-loop/stream-runtime.ts`,而那里是**产品层** —— 它不许 import
 * `@onething/backend`(架构栅栏逐字扫这条边)。所以三档目录由装配层建好之后,通过
 * 这个晚绑定端口递进来,与 `configure*Host` 那一族同一个姿势:import 这个模块
 * 不做任何配置,配置发生在 `createOnethingBackend` 的装配序列里。
 *
 * 投影只做一件事:`Surface` → agent-loop 已经认识的 `AgentSourceToolDefinition`
 * 形状。**刻意不绕过 `planAgentLoopTools`** —— 模型看到的工具名由
 * `createAIToolName` 生成、MCP 与内置的合并次序、`hasTools` 的判定全都在那里,
 * 换掉的是"这些定义从哪儿来",不是"定义怎么变成模型工具面"。
 */

import { Surface, normalizeLegacyAllowlist } from '@onething/core/toolkit'
import type { Catalog, ToolUserSetting } from '@onething/core/toolkit'
import type { JsonObject } from '@onething/core'
import { resolveScene, type SceneSessionLike } from './scene.js'

let configuredCatalog: Catalog | undefined

/** 装配层在 backend 的工具注册阶段调用一次。传 `undefined` = 摘掉(测试用)。 */
export function configureToolkitCatalog(catalog: Catalog | undefined): void {
  configuredCatalog = catalog
}

export function getToolkitCatalog(): Catalog | undefined {
  return configuredCatalog
}

export interface ToolkitSurfaceInput {
  session?: SceneSessionLike | null
  enabledSkillNames?: Iterable<string> | null
  /**
   * agent 白名单。旧路把**空数组**读成"不限制",内核读成"一个都不给" ——
   * R2a 决定⑤ 的归一门在这里过一次(`normalizeLegacyAllowlist`),行为与今天逐字
   * 一致。
   */
  allowlist?: readonly string[] | null
  toolSettings?: Readonly<Record<string, ToolUserSetting>>
  /** provider 自带的原生工具名 + MCP 名:只进 `names()`,进不了 `tools()`。 */
  extraNames?: readonly string[]
}

export function resolveToolkitSurface(input: ToolkitSurfaceInput): Surface | undefined {
  const catalog = configuredCatalog
  if (!catalog) return undefined
  return Surface.resolve({
    catalog,
    scene: resolveScene({
      session: input.session,
      enabledSkillNames: input.enabledSkillNames,
    }),
    allowlist: normalizeLegacyAllowlist(input.allowlist),
    settings: input.toolSettings,
    extraNames: input.extraNames,
  })
}

/** agent-loop 的 `AgentSourceToolDefinition` 里我们填得出的那几格。 */
export interface ToolkitAgentSourceTool {
  id: string
  name: string
  description: string
  parameterSchema: JsonObject
  executionMode: 'parallel' | 'sequential'
}

export function toolkitAgentSourceTools(surface: Surface): ToolkitAgentSourceTool[] {
  return surface.tools().map(tool => ({
    id: tool.spec.id,
    name: tool.spec.title,
    description: tool.spec.description,
    parameterSchema: tool.spec.input as JsonObject,
    executionMode: tool.spec.concurrency,
  }))
}
