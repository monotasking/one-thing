/**
 * R3b —— 目录 → `@shared/ipc` 的 `ToolDefinition`(§10.2-④ 的消费方改口用的那一份)。
 *
 * 「有哪些工具 / 它的 schema 与描述是什么 / 它的 guard 是哪一档」这三个问题,开关
 * 开时全部由 `Catalog` + 派生投影回答,而**读点一个字都不动**:设置页的工具列表、
 * 提示词快照、CLI 的 `listTools` 照旧读同一个 `ToolDefinition` 形状。
 *
 * 三格的来源逐条对得上旧 `OnethingToolRegistry.toolInfoToDefinition`:
 *
 * | 格 | 旧 | 新 |
 * | --- | --- | --- |
 * | `parameters` / `parameterSchema` | `zodToJsonSchema(tool.parameters)` 过 `coreToolDefinitionFromJsonSchema` | `spec.input`(已经是 JSON Schema)过**同一个**函数 |
 * | `permissionGuard` | 工具身上那个字符串 | `deriveLegacyPermissionGuard(spec)`(§12.3) |
 * | `executionMode` / `renderKind` / `renderShell` | 工具字段 | `spec.concurrency` / `spec.presentation` |
 *
 * `enabled` / `autoExecute` 是**目录答不了的问题**(它们是用户设置),所以这里给的
 * 是与旧路逐字相同的默认值(`enabled: true` / `autoExecute: false`)—— 旧
 * `toolInfoToDefinition` 读的也是工具身上的默认值,不是设置页那张表;设置页那张表
 * 由渲染层自己叠(`tools/tool-list-presentation.ts` 之后的那一段)。
 */

import { coreToolDefinitionFromJsonSchema } from '@onething/core/tools'
import type { Catalog, Tool } from '@onething/core/toolkit'
import type { JsonSchemaObject } from '@shared/json.js'
import type { ToolDefinition } from '@shared/ipc.js'
import { getToolkitCatalog } from '@onething/runtime/toolkit'
import { deriveLegacyPermissionGuard } from './guard-projection.js'

/**
 * 目录里的一只工具 → 一条 `ToolDefinition`。
 *
 * `category` 由 id 前缀推:与 `tools/tool-list-presentation.ts` 里那段
 * `id.startsWith('plugin:') ? 'plugin' : 'builtin'` 是同一条判据(旧路的 `category`
 * 也是注册时按同样的来源填的,MCP 那一档统一折成 `custom`)。
 */
export function toolDefinitionFromToolkitTool(tool: Tool): ToolDefinition {
  const spec = tool.spec
  const external = spec.id.startsWith('plugin:') || spec.id.startsWith('mcp:')
  return coreToolDefinitionFromJsonSchema({
    id: spec.id,
    name: spec.title,
    description: spec.description,
    jsonSchema: spec.input as JsonSchemaObject,
    enabled: true,
    autoExecute: false,
    permissionGuard: deriveLegacyPermissionGuard(spec),
    executionMode: spec.concurrency,
    renderKind: spec.presentation.kind,
    renderShell: spec.presentation.shell,
    category: external ? 'custom' : 'builtin',
  }) as ToolDefinition
}

/** 一整档目录的投影。次序 = 注册次序(§14.4-7 记过这一条)。 */
export function toolDefinitionsFromCatalog(catalog: Catalog): ToolDefinition[] {
  return catalog.all().map(toolDefinitionFromToolkitTool)
}

/**
 * 目录已经装好时的那一份;否则 `undefined`(调用方原样退回旧路)。
 *
 * 走产品层那个晚绑定端口(`getToolkitCatalog`)而**不是** wiring 的懒建口,有两个
 * 理由:一个投影函数不该有"顺手建一档目录"这种副作用;而且那条 import 边会把整棵
 * 装配树(适配器 → 派工 → 引擎 → 提示词)拖进每一个只想列个清单的调用方,在
 * `app/engine/prompt/*` 那种地方直接绕成环。
 *
 * 不在这里判开关:调用方各自有一个 `isToolkitEnabled()` 的分支,判两次会让"开关
 * 关时旧路一个字不改"这句话变成两处口径。
 */
export function toolkitCatalogToolDefinitions(): ToolDefinition[] | undefined {
  const catalog = getToolkitCatalog()
  return catalog ? toolDefinitionsFromCatalog(catalog) : undefined
}
