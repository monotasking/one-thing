/**
 * R2b —— `permissionGuard` 的读源切换(设计文档 §10.2-③ / §12.3)。
 *
 * 这个字段在 IPC 契约、设置页工具列表、提示词快照里都保留着,但概念本身在新树里
 * 已经不存在:它是 `spec.effects` 的**派生值**(`app/toolkit/guard-projection.ts`)。
 * 开关开时目录投影从派生表取,而**读点一个字都不动** ——
 * `tools/tool-list-presentation.ts` / `prompts/system-prompt-snapshot.ts` / 设置页
 * 照旧读 `ToolDefinition.permissionGuard`。
 *
 * 端口住在这里而不是 registry 里,有两个理由:registry 那个门面被静态检查器盯着
 * 行数(它必须一直是一层薄壳),以及这样 registry 不必 import 新树 —— 那会给一条
 * 开关关着的路加一条静态边。
 */

import type { ToolDefinition } from './types.js'
import { isToolkitEnabled } from '@onething/runtime/toolkit/flag'

export type ToolkitGuardLookup = (toolId: string) => ToolDefinition['permissionGuard'] | undefined

let guardLookup: ToolkitGuardLookup | null = null

/** 装配层在建好目录之后调一次(`app/toolkit/wiring.ts`)。传 null = 摘掉。 */
export function configureToolkitGuardProjection(lookup: ToolkitGuardLookup | null): void {
  guardLookup = lookup
}

/**
 * 只覆盖新树目录里**有**的工具;插件工具与旧树独有的条目保持原值
 * (`undefined` = 新树不认识它,别动)。
 */
export function withDerivedToolGuards(tools: ToolDefinition[]): ToolDefinition[] {
  const lookup = guardLookup
  if (!lookup || !isToolkitEnabled()) return tools
  return tools.map(tool => {
    const derived = lookup(tool.id)
    return derived === undefined ? tool : { ...tool, permissionGuard: derived }
  })
}
