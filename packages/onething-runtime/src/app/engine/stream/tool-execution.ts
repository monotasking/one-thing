/**
 * Tool Execution Module
 * Handles tool detection, execution, and step management
 */

import { sessionReads } from '../../session/reads.js'
import * as store from '../../store.js'
import type { Step, StepType, SkillDefinition, ToolCall } from '@shared/ipc.js'
import type { JsonObject } from '@shared/json.js'
import type { ToolExecutionContext, ToolExecutionResult, ToolPartialResultUpdate } from '../../toolkit/execution-types.js'
import type { Principal } from '@onething/core/permission'
import type { StreamContext } from './stream-processor.js'
import { createEventOnlyEmitter } from '../../events/event-only-emitter.js'
import {
  createCoreId,
  createToolExecutionStepWithFactory,
  detectSkillUsage,
  executeCoreToolAndUpdate,
  generateStepTitle,
  getStepType,
} from '@onething/core/engine'
import {
  toJsonValue,
  toolFailureText,
  toolResultToStructured,
  type JsonValue,
  type ToolResultLike,
} from '@onething/core'
import { runToolkitToolDirectly } from '../../toolkit/wiring.js'
import { consolePort, getLogger } from '../../logging/index.js'

const log = getLogger('toolkit.runner')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


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
  /*
   * 缝 2 + 缝 3(docs/design/tool-system-oop-2026-08.md §12.5)。
   *
   * 这一个函数是**每一次工具直调的唯一必经点**:agent-loop 的每一次
   * tool-call-done、orchestrator 的每一次 start、sub-agent 的递归入口(下面
   * executeToolAndUpdate 那一处)最后都收敛到这里。四个回调在
   * `runToolkitToolDirectly` 里被包成 `IpcProjector`(一个 Observer),两条插件
   * 拦截链被包成一个 `Interceptor`,MCP 由目录同步接住,权限走 `Authorizer`。
   *
   * R4b:旧的那一半(`executeOnethingDirectTool` 把 ctx 回调逐个翻成 IPC、
   * 自己接 MCP 分支与两条拦截链的约 350 行)已随旧树删除。目录里没有这个名字
   * 时不再有第二条路,如实报一次 tool-not-found。
   */
  const outcome = await runToolkitToolDirectly(toolName, args, context)
  if (outcome) return outcome as ToolExecutionResult
  return { success: false, error: `Tool not found: ${toolName}` }
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
  await executeCoreToolAndUpdate<
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
      // C1(P0.2):消息读走读门面。
      getMessage: (sessionId, messageId) => sessionReads.getMessage(sessionId, messageId),
      updateMessageToolCalls: store.updateMessageToolCalls,
    },
    emitter,
    executeToolDirectly: (name, directArgs, directContext) =>
      executeToolDirectly(name, directArgs, directContext as Parameters<typeof executeToolDirectly>[2]),
    createStep,
    now: Date.now,
    logger: consoleLog,
    // R4b:三个转换器原本住在 `runtime/tools/tool-execution.ts` 的
    // `executeOnethingToolAndUpdate` 里(那个文件只是这三行的一层壳)。壳随旧树
    // 删掉,三行原样搬到唯一的调用点。
    toJsonValue: value => toJsonValue(value) as JsonValue | undefined,
    toStructured: value => toolResultToStructured(value as ToolResultLike | string | undefined),
    formatFailure: toolFailureText,
  })
}
