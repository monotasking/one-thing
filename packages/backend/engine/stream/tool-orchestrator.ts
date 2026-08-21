import * as store from '../../store.js'
import { getEventBus } from '../../events/index.js'
import type { SkillDefinition, ToolCall } from '@shared/ipc.js'
import type { JsonObject } from '@shared/json.js'
import type { StreamContext, StreamProcessor } from './stream-processor.js'
import type { IPCEmitter } from './ipc-emitter.js'
import { executeToolAndUpdate } from './tool-execution.js'
import {
  coreToolCallSnapshot,
  CoreToolOrchestrator,
  planToolCallArtifactRemoval,
} from '@onething/core/engine'
import { sessionReads } from '../../session/reads.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'

const log = getLogger('toolkit.runner')


interface ToolCallData {
  toolName: string
  args: JsonObject
}

export interface ToolOrchestratorOptions {
  ctx: StreamContext
  processor: StreamProcessor
  enabledSkills: SkillDefinition[]
  turnIndex: number
  turnToolCalls: ToolCall[]
  emitter: IPCEmitter
  beforeFirstTool: () => void
}

/**
 * Main-process adapter for core tool orchestration.
 *
 * Core owns duplicate detection, queue hiding, barrier ordering, and tail
 * discard decisions. Main only wires those decisions to store/EventBus/emitter
 * side effects and concrete tool execution.
 */
export class ToolOrchestrator {
  private readonly ctx: StreamContext
  private readonly processor: StreamProcessor
  private readonly enabledSkills: SkillDefinition[]
  private readonly turnIndex: number
  private readonly turnToolCalls: ToolCall[]
  private readonly emitter: IPCEmitter
  private readonly beforeFirstTool: () => void
  private readonly core: CoreToolOrchestrator<ToolCall, ToolCallData>

  constructor(options: ToolOrchestratorOptions) {
    this.ctx = options.ctx
    this.processor = options.processor
    this.enabledSkills = options.enabledSkills
    this.turnIndex = options.turnIndex
    this.turnToolCalls = options.turnToolCalls
    this.emitter = options.emitter
    this.beforeFirstTool = options.beforeFirstTool

    this.core = new CoreToolOrchestrator<ToolCall, ToolCallData>({
      toolCalls: this.processor.toolCalls,
      turnToolCalls: this.turnToolCalls,
      beforeFirstTool: this.beforeFirstTool,
      executeTool: (toolCall, toolCallData, existingStepId) => executeToolAndUpdate(
        this.ctx,
        toolCall,
        toolCallData,
        this.processor.toolCalls,
        this.enabledSkills,
        this.turnIndex,
        existingStepId,
      ),
      updateToolCalls: () => this.updateToolCalls(),
      emitToolCall: (toolCall) => this.emitter.sendToolCall(toolCall),
      emitToolResult: (toolCall) => this.emitter.sendToolResult(toolCall),
      removeToolCallArtifacts: (ids) => this.removeToolCallArtifacts(ids),
      emitToolCallRemovalUpdate: () => this.emitToolCallRemovalUpdate(),
      logger: consolePort(log),
    })
  }

  hasExecuted(toolCallId: string): boolean {
    return this.core.hasExecuted(toolCallId)
  }

  get jobCount(): number {
    return this.core.jobCount
  }

  shouldDeferNewToolCall(): boolean {
    return this.core.shouldDeferNewToolCall()
  }

  start(
    toolCall: ToolCall,
    toolCallData: ToolCallData,
    existingStepId?: string,
  ): void {
    this.core.start(toolCall, toolCallData, existingStepId)
  }

  async waitForAll(): Promise<void> {
    await this.core.waitForAll()
  }

  private updateToolCalls(): void {
    store.updateMessageToolCalls(
      this.ctx.sessionId,
      this.ctx.assistantMessageId,
      // 快照(P0.2 area ①,F3):命令面会把这个数组**直接挂到消息上**,
      // 交出去的那份就归会话了,引擎的工作数组不能与它是同一个。
      coreToolCallSnapshot(this.processor.toolCalls),
    )
  }

  private removeToolCallArtifacts(ids: Set<string>): boolean {
    // C1(P0.2):读走门面。
    const message = sessionReads.getMessage(this.ctx.sessionId, this.ctx.assistantMessageId)
    const plan = planToolCallArtifactRemoval({
      message,
      ids,
      toolCalls: this.processor.toolCalls,
    })
    if (!plan.removed) return false

    if (plan.hadSteps) {
      store.updateMessageSteps(
        this.ctx.sessionId,
        this.ctx.assistantMessageId,
        plan.nextSteps,
      )
    }
    if (plan.hadContentParts) {
      store.updateMessageContentParts(
        this.ctx.sessionId,
        this.ctx.assistantMessageId,
        plan.nextContentParts,
      )
    }

    try {
      getEventBus()
        .emit(this.ctx.sessionId, {
          type: SESSION_EVENT_TYPES.MESSAGE_UPDATED,
          messageId: this.ctx.assistantMessageId,
          updates: plan.updates ?? { toolCalls: [...this.processor.toolCalls] },
        })
        .catch((err) =>
          log.error('message updated emit failed', { sessionId: this.ctx.sessionId }, err),
        )
    } catch (err) {
      log.error('remove tool call artifacts emit failed', { sessionId: this.ctx.sessionId }, err)
    }
    return true
  }

  private emitToolCallRemovalUpdate(): void {
    try {
      getEventBus()
        .emit(this.ctx.sessionId, {
          type: SESSION_EVENT_TYPES.MESSAGE_UPDATED,
          messageId: this.ctx.assistantMessageId,
          updates: { toolCalls: [...this.processor.toolCalls] },
        })
        .catch((err) =>
          log.error('message updated emit failed', { sessionId: this.ctx.sessionId }, err),
        )
    } catch (err) {
      log.error('tool call removal emit failed', { sessionId: this.ctx.sessionId }, err)
    }
  }
}
