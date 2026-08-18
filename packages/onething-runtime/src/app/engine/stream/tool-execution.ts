/**
 * Tool Execution Module
 * Handles tool detection, execution, and step management
 */

import * as store from '../../store.js'
import type { Step, StepType, SkillDefinition, ToolCall } from '@shared/ipc.js'
import type { JsonObject } from '@shared/json.js'
import { analyzeTool, executeTool } from '../../tools/index.js'
import { isMCPTool, executeMCPTool, resolveMCPServerIdForToolRef } from '../../mcp/index.js'
import type { ToolExecutionContext, ToolExecutionResult, ToolPartialResultUpdate } from '../../tools/types.js'
import type { ToolEffect, ToolPreview } from '@onething/core/tools'
import type { Principal } from '@onething/core/permission'
import type { StreamContext } from './stream-processor.js'
import { createEventOnlyEmitter } from '../../events/event-only-emitter.js'
import { enforcePermissionPolicy } from '../../tools/core/permission-policy.js'
import { runPluginToolCallIntercept } from '../../plugins/tool-call-intercept.js'
import { runPluginToolResultIntercept } from '../../plugins/tool-result-intercept.js'
import {
  createCoreId,
  createToolExecutionStepWithFactory,
  detectSkillUsage,
  generateStepTitle,
  getStepType,
} from '@onething/core/engine'
import type { JsonValue } from '@onething/core'
import {
  executeOnethingDirectTool,
  executeOnethingToolAndUpdate,
} from '@onething/runtime/tools'
// R2b:切换期的内部开关(§7 纪律 2)。它只读一个环境变量,不拉任何新树模块。
import { isToolkitEnabled } from '@onething/runtime/toolkit/flag'

export {
  detectSkillUsage,
  generateStepTitle,
  getStepType,
}

/**
 * Execute a tool directly without going through Tool Agent LLM
 * This is the new direct execution path for simple tool calls
 */
export async function executeToolDirectly(
  toolName: string,
  args: JsonObject,
  context: {
    sessionId: string
    messageId: string
    toolCallId?: string
    workingDirectory?: string  // Session's active working directory
    workingDirectoryRoots?: string[] // Additional sandbox roots
    abortSignal?: AbortSignal
    /** Actor behind this call; minted at the engine boundary, never derived here. */
    principal?: Principal
    onMetadata?: ToolExecutionContext['onMetadata']
    onPartialResult?: (update: ToolPartialResultUpdate) => void
    // Step event callbacks for sub-agent tools (e.g., CustomAgent)
    onStepStart?: (step: Step) => void
    onStepComplete?: (step: Step) => void
    beforeSideEffect?: () => Promise<void>
  }
): Promise<ToolExecutionResult> {
  // ── R2b 缝 2 + 缝 3(docs/design/tool-system-oop-2026-08.md §12.5)────────
  //
  // 这一个函数是**每一次工具直调的唯一必经点**:agent-loop 的每一次
  // tool-call-done、orchestrator 的每一次 start、sub-agent 的递归入口(下面
  // executeToolAndUpdate 那一处)最后都收敛到这里。所以三处缝里的两处
  // (执行函数 + 事件源)只需要这一段分支:四个回调在 `runToolkitToolDirectly`
  // 里被包成 `IpcProjector`(一个 Observer),两条插件拦截链被包成一个
  // `Interceptor`,返回形状与旧路逐字相同。
  //
  // 动态 import:开关关时这一行不执行,新树一个模块都不加载。
  // 目录里没有这个工具时它返回 undefined,原样落回下面的旧路。
  if (isToolkitEnabled()) {
    const { runToolkitToolDirectly } = await import('../../toolkit/wiring.js')
    const outcome = await runToolkitToolDirectly(toolName, args, context)
    if (outcome) return outcome as ToolExecutionResult
  }

  return executeOnethingDirectTool<
    ToolExecutionResult,
    ToolExecutionContext,
    NonNullable<ToolExecutionContext['onMetadata']> extends (update: infer TUpdate) => void ? TUpdate : never,
    ToolPartialResultUpdate,
    Step,
    ToolEffect,
    ToolPreview
  >({
    toolName,
    args,
    context,
    isMCPTool,
    executeMCPTool,
    resolveMCPServerId: resolveMCPServerIdForToolRef,
    analyzeTool,
    executeTool,
    enforcePermission: enforcePermissionPolicy,
    // N4:插件的工具调用拦截链。装配层在这里把它塞进 core 的必经点 ——
    // core 只认一个函数类型,不认识插件系统(与 sandboxHost 同一个姿势)。
    // 链本身在 `app/plugins/tool-call-intercept.ts`:逐 handler fail-closed,
    // 该插件熔断后 fail-open。没有插件注册时它是一次零分配的早退。
    interceptToolCall: async ({ sessionId, toolName, toolCallId, input }) => {
      const outcome = await runPluginToolCallIntercept({ sessionId, toolName, toolCallId, input })
      return outcome.action === 'block'
        ? { action: 'block', reason: outcome.reason }
        : { action: 'allow', input: outcome.input as JsonObject }
    },
    // N5:插件的工具结果改写链。装配层在这里把它塞进 core 的必经点(工具执行**之后**、
    // 结果回模型之前)。链本身在 `app/plugins/tool-result-intercept.ts`:逐 handler
    // fail-open,该插件熔断后仍 fail-open(只省预算)。没有插件注册时是零分配早退。
    interceptToolResult: async ({ sessionId, toolName, toolCallId, input, result }) => {
      const outcome = await runPluginToolResultIntercept({ sessionId, toolName, toolCallId, input, result })
      return outcome.action === 'replace'
        ? { action: 'replace', content: outcome.result.content, isError: outcome.result.isError }
        : { action: 'keep' }
    },
    logger: console,
  })
}

/**
 * Create a new step object with full tool call information
 */
export function createStep(
  toolCall: ToolCall,
  skillName?: string | null,
  turnIndex?: number
): Step {
  return createToolExecutionStepWithFactory(toolCall, {
    createId: createCoreId,
    now: Date.now,
    skillName,
    turnIndex,
  }) as Step
}

/**
 * Execute a tool (MCP or built-in) and update tool call status
 */
export async function executeToolAndUpdate(
  ctx: StreamContext,
  toolCall: ToolCall,
  toolCallData: { toolName: string; args: JsonObject },
  allToolCalls: ToolCall[],
  _skills: SkillDefinition[] = [],
  turnIndex?: number,
  existingStepId?: string,
  options: {
    beforeSideEffect?: () => Promise<void>
  } = {},
): Promise<void> {
  const emitter = createEventOnlyEmitter(ctx)
  await executeOnethingToolAndUpdate<
    ToolCall,
    Step,
    ToolExecutionResult,
    NonNullable<ToolExecutionContext['onMetadata']> extends (update: infer TUpdate) => void ? TUpdate : never,
    ToolPartialResultUpdate,
    unknown,
    JsonValue | undefined,
    ToolCall['changes']
  >({
    ctx: {
      sessionId: ctx.sessionId,
      assistantMessageId: ctx.assistantMessageId,
      abortSignal: ctx.abortSignal,
    },
    toolCall,
    toolCallData,
    allToolCalls,
    turnIndex,
    existingStepId,
    beforeSideEffect: options.beforeSideEffect,
    store: {
      getSession: store.getSession,
      updateMessageToolCalls: store.updateMessageToolCalls,
    },
    emitter,
    executeToolDirectly: (name, directArgs, directContext) =>
      executeToolDirectly(name, directArgs, directContext as Parameters<typeof executeToolDirectly>[2]),
    createStep,
    now: Date.now,
    logger: console,
  })
}
