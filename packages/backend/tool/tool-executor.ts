import { isJsonObject } from '@shared/json.js'
import type { PermissionPolicy } from './tool-policy.js'
import type { ToolCall, ToolExecutionContext, ToolResult } from './tool-types.js'
import type { ToolRegistry } from './tool-engine-registry.js'

export interface ToolExecutorOptions {
  registry: ToolRegistry
  policy: PermissionPolicy
}

export class ToolExecutor {
  private readonly registry: ToolRegistry
  private readonly policy: PermissionPolicy

  constructor(options: ToolExecutorOptions) {
    this.registry = options.registry
    this.policy = options.policy
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.registry.get(call.name)
    if (!tool) {
      return {
        toolCallId: call.id,
        toolName: call.name,
        content: `Tool not found: ${call.name}`,
        isError: true,
      }
    }

    const args = isJsonObject(call.args) ? call.args : {}
    const allowed = await this.policy.allow(call.name, args)
    if (!allowed) {
      return {
        toolCallId: call.id,
        toolName: call.name,
        content: `Tool denied by permission policy: ${call.name}`,
        isError: true,
      }
    }

    try {
      const result = await tool.execute(args, context)
      return {
        ...result,
        toolCallId: result.toolCallId ?? call.id,
        toolName: result.toolName ?? call.name,
      }
    } catch (error) {
      return {
        toolCallId: call.id,
        toolName: call.name,
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  }
}
