import { coreToolCallSnapshot, findCoreToolCall, patchCoreToolCall, replaceCoreToolCall } from './tool-call-cow.js'
import type { JsonObject, JsonValue } from '../json.js'
import { ToolExecutionScheduler } from '../agent-loop/tool-execution-scheduler.js'
import { coreDiffHunksFromJson, type CoreDiffHunk } from '../tools/diff-hunks.js'
import { detectSkillUsage, generateStepTitle } from './tool-step.js'
import { toLogger, type CompatLogger } from '../logging/index.js'

export interface CoreToolCallLike {
  id: string
  status?: string
  rejected?: boolean
}

export interface CoreStepLike {
  toolCallId?: string
}

export interface CoreContentPartLike<TToolCall extends CoreToolCallLike = CoreToolCallLike> {
  type: string
  toolCalls?: TToolCall[]
}

export interface CoreToolExecutionJobLike<TToolCall extends CoreToolCallLike = CoreToolCallLike> {
  toolCall: TToolCall
  settled: boolean
  published: boolean
}

export interface CoreMutableToolCallLike extends CoreToolCallLike {
  status?: string
  error?: string
  endTime?: number
  durationMs?: number
}

export interface CoreToolCallAbortUpdateOptions {
  error?: string
  now?: () => number
}

export interface CoreToolExecutionJob<TToolCall extends CoreMutableToolCallLike = CoreMutableToolCallLike>
  extends CoreToolExecutionJobLike<TToolCall> {
  promise: Promise<void>
  barrier: boolean
}

/** COW(F3):返回新对象,不动入参。 */
export function markToolCallAbortedBeforeExecution<TToolCall extends CoreMutableToolCallLike>(
  toolCall: TToolCall,
  options: CoreToolCallAbortUpdateOptions = {},
): TToolCall {
  return {
    ...toolCall,
    status: 'failed',
    error: options.error ?? 'Execution cancelled by user',
    endTime: (options.now ?? Date.now)(),
  }
}

export interface CoreToolCallDataLike {
  toolName: string
  args: JsonObject
}

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CoreToolOrchestratorLogger = CompatLogger

export interface CoreToolOrchestratorOptions<
  TToolCall extends CoreMutableToolCallLike,
  TToolCallData extends CoreToolCallDataLike = CoreToolCallDataLike,
> {
  toolCalls: TToolCall[]
  turnToolCalls: TToolCall[]
  beforeFirstTool: () => void
  executeTool: (toolCall: TToolCall, toolCallData: TToolCallData, existingStepId?: string) => Promise<void>
  updateToolCalls: () => void
  emitToolCall: (toolCall: TToolCall) => void
  emitToolResult: (toolCall: TToolCall) => void
  removeToolCallArtifacts?: (ids: Set<string>) => boolean
  emitToolCallRemovalUpdate?: () => void
  isBarrierTool?: (toolCall: TToolCall, toolCallData: TToolCallData) => boolean
  repeatedToolCallThreshold?: number
  scheduler?: ToolExecutionScheduler
  now?: () => number
  logger?: CoreToolOrchestratorLogger
}

export interface CoreMCPPermissionEffect {
  kind: 'mcp'
  resources: string[]
  barrier: true
  metadata: {
    toolName: string
    arguments: JsonObject
  }
}

export interface CoreMCPPermissionPreview {
  title: string
  metadata: {
    toolName: string
    arguments: JsonObject
  }
}

export interface CoreMCPPermissionPlan {
  resourceName: string
  effects: CoreMCPPermissionEffect[]
  preview: CoreMCPPermissionPreview
}

export interface CoreMCPPartialResultUpdate {
  content: Array<{ type: 'text'; text: string }>
  details: {
    phase: string
    toolName: string
    functionName?: JsonValue
  }
}

export interface CoreToolResultContentLike {
  type: string
  text?: string
  path?: string
}

export interface CoreToolResultLike {
  content: CoreToolResultContentLike[]
}

export interface CoreToolExecutionPartialStepUpdate<TPartialResult> {
  status: 'running'
  partialResult: TPartialResult
  partialResultIsPartial: true
  result: string
}

export interface CoreToolCallChangesLike {
  diff: string
  /** Structured hunks; render from these, never by re-parsing `diff` text. */
  hunks?: CoreDiffHunk[]
  filePath: string
  additions: number
  deletions: number
  /** @deprecated Rollback uses auditPath; kept only for legacy persisted sessions. */
  originalContent?: string
  originalContentHash?: string
  afterContentHash?: string
  auditId?: string
  auditPath?: string
}

export interface CoreToolCallWithChanges {
  changes?: CoreToolCallChangesLike
}

export interface CoreToolMetadataUpdate {
  title?: unknown
  metadata?: JsonObject
}

export interface CoreToolMetadataStepUpdate<TToolCall> {
  title?: string
  result?: string
  toolCall?: TToolCall
}

export interface CoreToolExecutionResultLike {
  success: boolean
  data?: unknown
  error?: string
  requiresConfirmation?: boolean
  commandType?: string
  aborted?: boolean
  rejected?: boolean
  rejectionReason?: string
}

export interface CoreToolExecutionToolCallLike<TJson = JsonValue, TChanges = unknown> {
  status?: string
  result?: TJson
  error?: string
  rejected?: boolean
  rejectionReason?: string
  requiresConfirmation?: boolean
  commandType?: string
  changes?: TChanges
}

export type CoreToolExecutionFinalStepStatus =
  | 'awaiting-confirmation'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface CoreToolExecutionFailureLike {
  error?: string
  rejected?: boolean
  rejectionReason?: string
  status?: string
}

export interface CoreToolExecutionFinalStepUpdate<TToolCall, TStructuredResult> {
  status: CoreToolExecutionFinalStepStatus
  title?: string
  toolCall: TToolCall
  partialResult?: TStructuredResult
  partialResultIsPartial?: false
  result?: string
  error?: string
  rejected?: boolean
  rejectionReason?: string
}

export interface CoreToolExecutionEndUpdate<TStructuredResult> {
  result?: TStructuredResult
  isError: boolean
  error?: string
}

export interface CoreToolExecutionFinalPresentation<TToolCall, TStructuredResult> {
  executionEnd?: CoreToolExecutionEndUpdate<TStructuredResult>
  stepUpdate: CoreToolExecutionFinalStepUpdate<TToolCall, TStructuredResult>
  /** 结算后的**新** toolCall(COW,F3):调用方要拿它换掉工作数组里的那一格 */
  toolCall: TToolCall
}

export interface CoreExecutableToolCallLike<TJson extends JsonValue | undefined = JsonValue, TChanges = unknown>
  extends CoreMutableToolCallLike, CoreToolExecutionToolCallLike<TJson, TChanges> {
  id: string
  toolName: string
  startTime?: number
}

export interface CoreExecutableStepLike<TToolCall> {
  id: string
  title: string
  status?: string
  toolCallId?: string
  toolCall?: TToolCall
  turnIndex?: number
  result?: unknown
  error?: string
}

export interface CoreExecutableMessageLike<TStep> {
  id: string
  steps?: TStep[]
}

export interface CoreExecutableSessionLike<TStep> {
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  messages?: CoreExecutableMessageLike<TStep>[]
}

export interface CoreToolExecutionStreamContextLike {
  sessionId: string
  assistantMessageId: string
  abortSignal?: { aborted?: boolean }
}

export interface CoreToolExecutionStore<
  TToolCall extends CoreExecutableToolCallLike<JsonValue | undefined>,
  TStep extends CoreExecutableStepLike<TToolCall>,
  TSession extends CoreExecutableSessionLike<TStep> = CoreExecutableSessionLike<TStep>,
> {
  /** 只用来读工作目录等会话级字段;消息读走 `getMessage`(P0.2 C1) */
  getSession(sessionId: string): TSession | null | undefined
  /** 读门面(P0.2 C1):缺席时回落到 `getSession()?.messages.find` 的旧读法 */
  getMessage?(sessionId: string, messageId: string): CoreExecutableMessageLike<TStep> | undefined
  updateMessageToolCalls(sessionId: string, assistantMessageId: string, toolCalls: TToolCall[]): void
}

export interface CoreToolExecutionEmitter<
  TToolCall extends CoreExecutableToolCallLike<JsonValue | undefined>,
  TStep extends CoreExecutableStepLike<TToolCall>,
  TPartialResult extends CoreToolResultLike,
  TStructuredResult,
> {
  sendToolResult(toolCall: TToolCall): void
  sendSkillActivated(skillName: string): void
  sendStepUpdated(stepId: string, updates: Partial<TStep>): void
  sendStepAdded(step: TStep): void
  sendToolExecutionStart(toolCallId: string, stepId: string, toolName: string, args: JsonObject, startTime?: number): void
  sendToolCall(toolCall: TToolCall): void
  sendToolExecutionUpdate(toolCallId: string, stepId: string, partialResult: TPartialResult): void
  sendToolExecutionEnd(toolCallId: string, stepId: string, result?: TStructuredResult, isError?: boolean, error?: string, durationMs?: number): void
}

export interface CoreToolDirectExecutionCallbacks<
  TStep extends CoreExecutableStepLike<TToolCall>,
  TToolCall extends CoreExecutableToolCallLike<JsonValue | undefined>,
  TMetadataUpdate extends CoreToolMetadataUpdate,
  TPartialResult extends CoreToolResultLike,
> {
  sessionId: string
  messageId: string
  toolCallId?: string
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  abortSignal?: { aborted?: boolean }
  onMetadata?: (update: TMetadataUpdate) => void
  onPartialResult?: (update: TPartialResult) => void
  onStepStart?: (step: TStep) => void
  onStepComplete?: (step: TStep) => void
  beforeSideEffect?: () => Promise<void>
}

export interface ExecuteCoreToolAndUpdateOptions<
  TToolCall extends CoreExecutableToolCallLike<TJson, TChanges>,
  TStep extends CoreExecutableStepLike<TToolCall>,
  TResult extends CoreToolExecutionResultLike,
  TMetadataUpdate extends CoreToolMetadataUpdate = CoreToolMetadataUpdate,
  TPartialResult extends CoreToolResultLike = CoreToolResultLike,
  TStructuredResult = CoreToolResultLike,
  TJson extends JsonValue | undefined = JsonValue,
  TChanges = unknown,
  TSession extends CoreExecutableSessionLike<TStep> = CoreExecutableSessionLike<TStep>,
> {
  ctx: CoreToolExecutionStreamContextLike
  toolCall: TToolCall
  toolCallData: CoreToolCallDataLike
  allToolCalls: TToolCall[]
  turnIndex?: number
  existingStepId?: string
  beforeSideEffect?: () => Promise<void>
  store: CoreToolExecutionStore<TToolCall, TStep, TSession>
  emitter: CoreToolExecutionEmitter<TToolCall, TStep, TPartialResult, TStructuredResult>
  executeToolDirectly: (
    toolName: string,
    args: JsonObject,
    context: CoreToolDirectExecutionCallbacks<TStep, TToolCall, TMetadataUpdate, TPartialResult>
  ) => Promise<TResult>
  createStep: (toolCall: TToolCall, skillName?: string | null, turnIndex?: number) => TStep
  toJsonValue: (value: unknown) => TJson
  toStructured: (value: unknown) => TStructuredResult
  formatFailure: (failure: CoreToolExecutionFailureLike) => string
  now?: () => number
  logger?: CoreToolOrchestratorLogger
}

export interface CoreToolCallArtifactRemovalPlan<TStep, TPart, TToolCall> {
  removed: boolean
  hadSteps: boolean
  hadContentParts: boolean
  nextSteps?: TStep[]
  nextContentParts?: TPart[]
  updates?: {
    toolCalls: TToolCall[]
    steps?: TStep[]
    contentParts?: TPart[]
  }
}

export interface BuildToolExecutionFinalPresentationOptions<
  TToolCall extends CoreToolExecutionToolCallLike<TJson, TChanges>,
  TStructuredResult,
  TJson = JsonValue,
  TChanges = unknown,
> {
  toolCall: TToolCall
  result: CoreToolExecutionResultLike
  currentTitle?: string
  changes?: TChanges
  toJsonValue: (value: unknown) => TJson
  toStructured: (value: unknown) => TStructuredResult
  formatFailure: (failure: CoreToolExecutionFailureLike) => string
}

export function shouldStopAfterTool(toolCall: Pick<CoreToolCallLike, 'status' | 'rejected'>): boolean {
  return Boolean(toolCall.rejected) || toolCall.status === 'cancelled'
}

export {
  recordToolCallSignature,
  stableStringify,
  toolCallSignature,
  type CoreRepeatedToolCallResult,
} from '../agent-loop/tool-signature.js'
import { recordToolCallSignature, type CoreRepeatedToolCallResult } from '../agent-loop/tool-signature.js'

export class CoreToolOrchestrator<
  TToolCall extends CoreMutableToolCallLike,
  TToolCallData extends CoreToolCallDataLike = CoreToolCallDataLike,
> {
  private readonly toolCalls: TToolCall[]
  private readonly turnToolCalls: TToolCall[]
  private readonly options: CoreToolOrchestratorOptions<TToolCall, TToolCallData>
  private readonly executedToolCallIds = new Set<string>()
  private readonly jobs: CoreToolExecutionJob<TToolCall>[] = []
  private readonly discardedToolCallIds = new Set<string>()
  private readonly toolSignatureCounts = new Map<string, number>()
  private readonly scheduler: ToolExecutionScheduler
  private stoppedByFailedToolCallId: string | null = null

  constructor(options: CoreToolOrchestratorOptions<TToolCall, TToolCallData>) {
    this.options = options
    this.toolCalls = options.toolCalls
    this.turnToolCalls = options.turnToolCalls
    this.scheduler = options.scheduler ?? new ToolExecutionScheduler()
  }

  hasExecuted(toolCallId: string): boolean {
    return this.executedToolCallIds.has(toolCallId)
  }

  get jobCount(): number {
    return this.jobs.length
  }

  shouldDeferNewToolCall(): boolean {
    return this.hasUnsettledJob() || this.stoppedByFailedToolCallId !== null
  }

  start(toolCall: TToolCall, toolCallData: TToolCallData, existingStepId?: string): void {
    if (this.executedToolCallIds.has(toolCall.id)) return

    this.options.beforeFirstTool()
    this.executedToolCallIds.add(toolCall.id)

    const shouldDiscardImmediately = this.stoppedByFailedToolCallId !== null
    const hiddenBehindBarrier = this.hasUnsettledJob() || shouldDiscardImmediately
    const isBarrier = this.options.isBarrierTool?.(toolCall, toolCallData) ?? true

    if (shouldDiscardImmediately) {
      this.discardedToolCallIds.add(toolCall.id)
      this.executedToolCallIds.delete(toolCall.id)
      this.unpublishToolCall(toolCall.id)
      return
    }

    const doomLoop = this.checkDoomLoop(toolCallData)
    if (doomLoop.detected) {
      this.publishToolCall(toolCall, false)
      // COW(F3):换出新对象换进工作表,不改已经交给 store 的那一份。
      const failed = patchCoreToolCall(this.toolCalls, toolCall, {
        status: 'failed',
        error: doomLoop.message,
        endTime: this.now(),
      } as Partial<TToolCall>)
      replaceCoreToolCall(this.turnToolCalls, failed)
      this.options.updateToolCalls()
      this.options.emitToolCall(failed)
      this.options.emitToolResult(failed)
      return
    }

    if (hiddenBehindBarrier) {
      this.unpublishToolCall(toolCall.id)
    } else {
      this.publishToolCall(toolCall, false)
    }

    const job: CoreToolExecutionJob<TToolCall> = {
      toolCall,
      settled: false,
      barrier: isBarrier,
      published: !hiddenBehindBarrier,
      promise: Promise.resolve(),
    }

    job.promise = this.scheduler.enqueue(
      async () => {
        if (this.discardedToolCallIds.has(toolCall.id)) {
          job.settled = true
          return
        }

        try {
          if (!job.published) {
            this.publishToolCall(toolCall, false)
            job.published = true
          }

          await this.options.executeTool(toolCall, toolCallData, existingStepId)
          // COW(F3)之后,跨 await 持有的引用一律过期:结算态要按 id 从工作表
          // 重新取,否则「失败即停链」会看到 executing 而永远不停。
          const settled = findCoreToolCall(this.toolCalls, toolCall.id) ?? toolCall
          if (shouldStopAfterTool(settled)) {
            this.stoppedByFailedToolCallId = settled.id
            this.discardQueuedTailAfter(
              settled.id,
              settled.rejected ? 'rejected' : settled.status ?? 'failed',
            )
          }
        } catch (err) {
          toLogger(this.options.logger).error('[CoreToolOrchestrator] tool execution job error:', undefined, err)
        } finally {
          job.settled = true
        }
      },
      { barrier: isBarrier },
    )

    this.jobs.push(job)
  }

  async waitForAll(): Promise<void> {
    if (this.jobs.length === 0) return
    await Promise.allSettled(this.jobs.map((job) => job.promise))
  }

  private hasUnsettledJob(): boolean {
    return this.jobs.some((job) => !job.settled)
  }

  private publishToolCall(toolCall: TToolCall, emitQueued: boolean): void {
    if (!this.toolCalls.some((existing) => existing.id === toolCall.id)) {
      this.toolCalls.push(toolCall)
    }
    if (!this.turnToolCalls.some((existing) => existing.id === toolCall.id)) {
      this.turnToolCalls.push(toolCall)
    }
    if (emitQueued) {
      const queued = patchCoreToolCall(this.toolCalls, toolCall, { status: 'queued' } as Partial<TToolCall>)
      replaceCoreToolCall(this.turnToolCalls, queued)
      this.options.emitToolCall(queued)
    }
    this.options.updateToolCalls()
  }

  private unpublishToolCall(toolCallId: string): void {
    const ids = new Set([toolCallId])
    const removedToolCalls = removeToolCallsById(this.toolCalls, ids)
    removeToolCallsById(this.turnToolCalls, ids)

    const removedArtifacts = this.options.removeToolCallArtifacts?.(ids) ?? false
    if (removedToolCalls === 0 && !removedArtifacts) return

    this.options.updateToolCalls()
    if (!removedArtifacts) {
      this.options.emitToolCallRemovalUpdate?.()
    }
  }

  private checkDoomLoop(toolCallData: TToolCallData): CoreRepeatedToolCallResult {
    return recordToolCallSignature(
      this.toolSignatureCounts,
      toolCallData.toolName,
      toolCallData.args,
      this.options.repeatedToolCallThreshold,
    )
  }

  private discardQueuedTailAfter(toolCallId: string, reason: string): void {
    const tailIds = queuedTailToolCallIdsAfter(this.jobs, toolCallId)
    if (tailIds.length === 0) return

    for (const id of tailIds) {
      this.discardedToolCallIds.add(id)
      this.executedToolCallIds.delete(id)
    }

    const tailIdSet = new Set(tailIds)
    removeToolCallsById(this.toolCalls, tailIdSet)
    removeToolCallsById(this.turnToolCalls, tailIdSet)

    this.options.updateToolCalls()
    this.options.removeToolCallArtifacts?.(tailIdSet)
    toLogger(this.options.logger).info(
      `[CoreToolOrchestrator] Discarded ${tailIds.length} queued tool(s) after ${reason} tool ${toolCallId}`,
    )
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

export function queuedTailToolCallIdsAfter<TJob extends CoreToolExecutionJobLike>(
  jobs: TJob[],
  toolCallId: string,
): string[] {
  const index = jobs.findIndex(job => job.toolCall.id === toolCallId)
  if (index < 0) return []

  return jobs
    .slice(index + 1)
    .filter(job => !job.settled && (!job.published || job.toolCall.status === 'queued'))
    .map(job => job.toolCall.id)
}

export function removeToolCallsById<TToolCall extends CoreToolCallLike>(
  toolCalls: TToolCall[],
  ids: Set<string>,
): number {
  let removed = 0
  for (let index = toolCalls.length - 1; index >= 0; index--) {
    if (ids.has(toolCalls[index].id)) {
      toolCalls.splice(index, 1)
      removed++
    }
  }
  return removed
}

export function filterSteps<TStep extends CoreStepLike>(
  steps: TStep[] | undefined,
  ids: Set<string>,
): TStep[] | undefined {
  if (!steps) return undefined
  return steps.filter(step => !step.toolCallId || !ids.has(step.toolCallId))
}

export function filterContentParts<TPart extends CoreContentPartLike>(
  parts: TPart[] | undefined,
  ids: Set<string>,
): TPart[] | undefined {
  if (!parts) return undefined
  return parts
    .map((part) => {
      if (part.type !== 'tool-call') return part
      return {
        ...part,
        toolCalls: (part.toolCalls ?? []).filter(toolCall => !ids.has(toolCall.id)),
      } as TPart
    })
    .filter(part => part.type !== 'tool-call' || (part.toolCalls?.length ?? 0) > 0)
}

export function planToolCallArtifactRemoval<
  TStep extends CoreStepLike,
  TPart extends CoreContentPartLike<TToolCall>,
  TToolCall extends CoreToolCallLike,
>(
  input: {
    message?: {
      steps?: TStep[]
      contentParts?: TPart[]
    }
    ids: Set<string>
    toolCalls: TToolCall[]
  },
): CoreToolCallArtifactRemovalPlan<TStep, TPart, TToolCall> {
  const hadSteps = input.message?.steps?.some(
    step => !!step.toolCallId && input.ids.has(step.toolCallId),
  ) ?? false
  const hadContentParts = input.message?.contentParts?.some(
    part => part.type === 'tool-call' &&
      (part.toolCalls ?? []).some(toolCall => input.ids.has(toolCall.id)),
  ) ?? false

  if (!hadSteps && !hadContentParts) {
    return {
      removed: false,
      hadSteps,
      hadContentParts,
    }
  }

  const nextSteps = hadSteps ? filterSteps(input.message?.steps, input.ids) : undefined
  const nextContentParts = hadContentParts
    ? filterContentParts(input.message?.contentParts, input.ids)
    : undefined

  return {
    removed: true,
    hadSteps,
    hadContentParts,
    nextSteps,
    nextContentParts,
    updates: {
      toolCalls: [...input.toolCalls],
      ...(hadSteps ? { steps: nextSteps } : {}),
      ...(hadContentParts ? { contentParts: nextContentParts } : {}),
    },
  }
}

export function isMCPRouterToolName(toolName: string): boolean {
  return toolName === 'mcp_search' || toolName === 'tool_function'
}

export function isReadOnlyMCPRouterCall(toolName: string, args: JsonObject): boolean {
  return isMCPRouterToolName(toolName) && args.action !== 'call'
}

export function resolveMCPPermissionResourceName(toolName: string, args: JsonObject): string {
  const routerResourceName = typeof args.tool === 'string'
    ? args.tool
    : typeof args.function === 'string' ? args.function : undefined
  return isMCPRouterToolName(toolName) && routerResourceName
    ? routerResourceName
    : toolName
}

export function buildMCPPermissionPlan(
  toolName: string,
  args: JsonObject,
  options: { resolveServerId?: (toolRef: string) => string | undefined } = {},
): CoreMCPPermissionPlan | null {
  if (isReadOnlyMCPRouterCall(toolName, args)) return null

  const resourceName = resolveMCPPermissionResourceName(toolName, args)
  // Grants are keyed per server, not per bare tool name. Router tool ids stay
  // unqualified while a name is unique across servers, so a permanent "allow
  // search" grant would silently carry over to a different server that later
  // exposes its own `search`. The prompt still shows the friendly name.
  const serverId = options.resolveServerId?.(resourceName)
  return {
    resourceName,
    effects: [{
      kind: 'mcp',
      resources: [serverId ? `mcp:${serverId}:${resourceName}` : resourceName],
      barrier: true,
      metadata: { toolName, arguments: args },
    }],
    preview: {
      title: `Call MCP tool: ${resourceName}`,
      metadata: { toolName, arguments: args },
    },
  }
}

export function buildMCPPartialResultUpdate(
  text: string,
  phase: string,
  toolName: string,
  args: JsonObject,
): CoreMCPPartialResultUpdate {
  return {
    content: [{ type: 'text', text }],
    details: { phase, toolName, functionName: args.function },
  }
}

export function toolResultObject<TObject extends object = Record<string, unknown>>(value: unknown): TObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as TObject
    : undefined
}

export function streamableToolResult<TObject extends object = Record<string, unknown>>(
  value: unknown,
): string | TObject | undefined {
  if (typeof value === 'string') return value
  return toolResultObject<TObject>(value)
}

export function textFromStructuredToolResult(result: CoreToolResultLike | undefined): string {
  if (!result) return ''
  const text = result.content
    .map((part) => {
      if (part.type === 'text') return part.text ?? ''
      if (part.type === 'file') return part.path ? `[File: ${part.path}]` : ''
      if (part.type === 'image') return part.path ? `[Image: ${part.path}]` : '[Image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
  return text || JSON.stringify(result)
}

export function buildToolExecutionPartialStepUpdate<TPartialResult extends CoreToolResultLike>(
  update: TPartialResult,
): CoreToolExecutionPartialStepUpdate<TPartialResult> {
  return {
    status: 'running',
    partialResult: update,
    partialResultIsPartial: true,
    result: textFromStructuredToolResult(update) || JSON.stringify(update),
  }
}

export function changesFromToolMetadata(metadata: JsonObject | undefined): CoreToolCallChangesLike | undefined {
  if (!metadata?.diff || !metadata.path) return undefined
  return {
    diff: String(metadata.diff),
    hunks: coreDiffHunksFromJson(metadata.diffHunks),
    filePath: String(metadata.path),
    additions: Number(metadata.additions) || 0,
    deletions: Number(metadata.deletions) || 0,
    originalContentHash: typeof metadata.originalContentHash === 'string' ? metadata.originalContentHash : undefined,
    afterContentHash: typeof metadata.afterContentHash === 'string' ? metadata.afterContentHash : undefined,
    auditId: typeof metadata.auditId === 'string' ? metadata.auditId : undefined,
    auditPath: typeof metadata.auditPath === 'string' ? metadata.auditPath : undefined,
  }
}

export function buildToolMetadataStepUpdate<TToolCall extends CoreToolCallWithChanges>(
  toolCall: TToolCall | undefined,
  update: CoreToolMetadataUpdate,
): CoreToolMetadataStepUpdate<TToolCall> {
  const metadataUpdates: CoreToolMetadataStepUpdate<TToolCall> = {}
  if (update.title && typeof update.title === 'string') {
    metadataUpdates.title = update.title
  }
  if (update.metadata) {
    metadataUpdates.result = typeof update.metadata.output === 'string'
      ? update.metadata.output
      : JSON.stringify(update.metadata)

    const changes = changesFromToolMetadata(update.metadata)
    if (changes && toolCall) {
      // COW(F3):新对象,不动入参。调用方拿 `metadataUpdates.toolCall` 用。
      metadataUpdates.toolCall = { ...toolCall, changes }
    }
  }
  return metadataUpdates
}

function toolExecutionResultText(data: unknown): string | undefined {
  return typeof data === 'string' ? data : JSON.stringify(data)
}

export function buildToolExecutionFinalPresentation<
  TToolCall extends CoreToolExecutionToolCallLike<TJson, TChanges>,
  TStructuredResult,
  TJson = JsonValue,
  TChanges = unknown,
>(
  options: BuildToolExecutionFinalPresentationOptions<TToolCall, TStructuredResult, TJson, TChanges>,
): CoreToolExecutionFinalPresentation<TToolCall & { changes?: TChanges }, TStructuredResult> {
  const { result } = options

  if (result.requiresConfirmation) {
    const toolCall = {
      ...options.toolCall,
      status: 'pending',
      requiresConfirmation: true,
      commandType: result.commandType,
      error: result.error,
    }
    return {
      toolCall,
      stepUpdate: {
        status: 'awaiting-confirmation',
        toolCall: { ...toolCall, changes: options.changes },
      },
    }
  }

  const stepStatus: Exclude<CoreToolExecutionFinalStepStatus, 'awaiting-confirmation'> = result.aborted
    ? 'cancelled'
    : result.success ? 'completed' : 'failed'
  const finalError = result.success
    ? undefined
    : options.formatFailure({
      error: result.error,
      rejected: result.rejected,
      rejectionReason: result.rejectionReason,
      status: stepStatus,
    })

  const toolCall = {
    ...options.toolCall,
    status: stepStatus,
    result: options.toJsonValue(result.data),
    error: finalError,
    rejected: result.rejected || undefined,
    rejectionReason: result.rejectionReason,
    requiresConfirmation: false,
  }

  const rawTitle = toolResultObject<{ title?: unknown }>(result.data)?.title
  const finalTitle = (typeof rawTitle === 'string' ? rawTitle : null) || options.currentTitle
  const structuredResult = result.success
    ? options.toStructured(streamableToolResult(result.data))
    : undefined

  return {
    toolCall,
    executionEnd: {
      result: structuredResult,
      isError: !result.success,
      error: finalError,
    },
    stepUpdate: {
      status: stepStatus,
      title: finalTitle,
      toolCall: { ...toolCall, changes: options.changes },
      partialResult: structuredResult,
      partialResultIsPartial: false,
      result: toolExecutionResultText(result.data),
      error: finalError,
      rejected: result.rejected || undefined,
      rejectionReason: result.rejectionReason,
    },
  }
}

export async function executeCoreToolAndUpdate<
  TToolCall extends CoreExecutableToolCallLike<TJson, TChanges>,
  TStep extends CoreExecutableStepLike<TToolCall>,
  TResult extends CoreToolExecutionResultLike,
  TMetadataUpdate extends CoreToolMetadataUpdate = CoreToolMetadataUpdate,
  TPartialResult extends CoreToolResultLike = CoreToolResultLike,
  TStructuredResult = CoreToolResultLike,
  TJson extends JsonValue | undefined = JsonValue,
  TChanges = unknown,
  TSession extends CoreExecutableSessionLike<TStep> = CoreExecutableSessionLike<TStep>,
>(
  options: ExecuteCoreToolAndUpdateOptions<
    TToolCall,
    TStep,
    TResult,
    TMetadataUpdate,
    TPartialResult,
    TStructuredResult,
    TJson,
    TChanges,
    TSession
  >,
): Promise<void> {
  const {
    ctx,
    toolCallData,
    allToolCalls,
    turnIndex,
    existingStepId,
    store,
    emitter,
  } = options
  const now = options.now ?? Date.now
  const logger = toLogger(options.logger)
  // COW(F3):`toolCall` 是「当前这一版」的游标 —— 每次改都换新对象并写回
  // `allToolCalls` 的那一格,交给 store 的永远是快照。老对象不动一个字段。
  let toolCall = options.toolCall

  if (ctx.abortSignal?.aborted) {
    logger.info(`[Backend] Tool execution aborted before start: ${toolCallData.toolName}`)
    toolCall = replaceCoreToolCall(allToolCalls, markToolCallAbortedBeforeExecution(toolCall, { now }))
    store.updateMessageToolCalls(ctx.sessionId, ctx.assistantMessageId, coreToolCallSnapshot(allToolCalls))
    emitter.sendToolResult(toolCall)
    return
  }

  const skillName = detectSkillUsage(toolCallData.toolName, toolCallData.args)
  if (skillName) {
    logger.info(`[Backend] Skill activated: ${skillName}`)
    emitter.sendSkillActivated(skillName)
  }

  const session = store.getSession(ctx.sessionId)
  // C1(P0.2):消息读走读门面;宿主没接就回落旧读法(测试用的 mock store)。
  const message = store.getMessage
    ? store.getMessage(ctx.sessionId, ctx.assistantMessageId)
    : session?.messages?.find(item => item.id === ctx.assistantMessageId)
  let existingStep: TStep | undefined

  if (existingStepId) {
    existingStep = message?.steps?.find(step => step.id === existingStepId)
  }
  if (!existingStep) {
    existingStep = message?.steps?.find(step => step.toolCallId === toolCall.id)
  }

  // COW(F3):`step` 也是本地游标 —— 复用已存在的那条时**新建一份**再改,
  // 会话里的那条 step 由 `sendStepUpdated` 走命令面落。
  let step: TStep
  if (existingStep) {
    step = {
      ...existingStep,
      title: generateStepTitle(toolCall.toolName, toolCallData.args, skillName),
      toolCall: { ...toolCall },
      turnIndex,
    }

    emitter.sendStepUpdated(step.id, {
      title: step.title,
      toolCall: step.toolCall,
      turnIndex: step.turnIndex,
    } as Partial<TStep>)
  } else {
    step = options.createStep(toolCall, skillName, turnIndex)
    emitter.sendStepAdded(step)
  }

  toolCall = patchCoreToolCall(allToolCalls, toolCall, {
    status: 'executing',
    startTime: now(),
  } as Partial<TToolCall>)

  emitter.sendToolExecutionStart(toolCall.id, step.id, toolCallData.toolName, toolCallData.args, toolCall.startTime)

  store.updateMessageToolCalls(ctx.sessionId, ctx.assistantMessageId, coreToolCallSnapshot(allToolCalls))
  emitter.sendToolCall(toolCall)

  const workingDirectory = session?.workingDirectory
  const workingDirectoryRoots = session?.workingDirectoryRoots
  let sideEffectStarted = false

  const markSideEffectStarted = async () => {
    await options.beforeSideEffect?.()

    if (sideEffectStarted) return
    sideEffectStarted = true

    toolCall = patchCoreToolCall(allToolCalls, toolCall, {
      status: 'executing',
      requiresConfirmation: false,
      startTime: now(),
    } as Partial<TToolCall>)
    store.updateMessageToolCalls(ctx.sessionId, ctx.assistantMessageId, coreToolCallSnapshot(allToolCalls))
    emitter.sendToolCall(toolCall)
    emitter.sendStepUpdated(step.id, {
      status: 'running',
      toolCall: { ...toolCall, changes: step.toolCall?.changes },
    } as Partial<TStep>)
  }

  const result = await options.executeToolDirectly(
    toolCallData.toolName,
    { ...toolCallData.args },
    {
      sessionId: ctx.sessionId,
      messageId: ctx.assistantMessageId,
      toolCallId: toolCall.id,
      workingDirectory,
      workingDirectoryRoots,
      abortSignal: ctx.abortSignal,
      onMetadata: (update) => {
        const metadataToolCall = step.toolCall ?? { ...toolCall }
        const metadataUpdates = buildToolMetadataStepUpdate(metadataToolCall as CoreToolCallWithChanges, update)
        if (metadataUpdates.toolCall) {
          // step 是本地游标:换成带 changes 的新版本(不改会话里的那条)。
          step = { ...step, toolCall: metadataUpdates.toolCall as TToolCall }
        }
        if (Object.keys(metadataUpdates).length > 0) {
          emitter.sendStepUpdated(step.id, metadataUpdates as Partial<TStep>)
        }
      },
      onPartialResult: (update) => {
        emitter.sendToolExecutionUpdate(toolCall.id, step.id, update)
        emitter.sendStepUpdated(step.id, buildToolExecutionPartialStepUpdate(update) as unknown as Partial<TStep>)
      },
      onStepStart: subStep => {
        emitter.sendStepAdded(subStep)
      },
      onStepComplete: subStep => {
        emitter.sendStepUpdated(subStep.id, {
          status: subStep.status,
          result: subStep.result,
          error: subStep.error,
        } as Partial<TStep>)
      },
      beforeSideEffect: markSideEffectStarted,
    },
  )

  const endTime = now()
  toolCall = patchCoreToolCall(allToolCalls, toolCall, {
    endTime,
    ...(toolCall.startTime != null
      ? { durationMs: Math.max(0, endTime - toolCall.startTime) }
      : {}),
  } as Partial<TToolCall>)

  const presentation = buildToolExecutionFinalPresentation({
    toolCall,
    result,
    currentTitle: step.title,
    changes: step.toolCall?.changes,
    toJsonValue: options.toJsonValue,
    toStructured: options.toStructured,
    formatFailure: options.formatFailure,
  })

  if (presentation.executionEnd) {
    emitter.sendToolExecutionEnd(
      toolCall.id,
      step.id,
      presentation.executionEnd.result,
      presentation.executionEnd.isError,
      presentation.executionEnd.error,
      toolCall.durationMs,
    )
  }
  emitter.sendStepUpdated(step.id, presentation.stepUpdate as Partial<TStep>)

  // 结算后的那一版换进工作数组,再整表快照写回 —— 调用方(orchestrator)之后
  // 要按 id 重新取才拿得到 status/rejected 的最新值。
  toolCall = replaceCoreToolCall(allToolCalls, presentation.toolCall as TToolCall)
  store.updateMessageToolCalls(ctx.sessionId, ctx.assistantMessageId, coreToolCallSnapshot(allToolCalls))
  emitter.sendToolResult(toolCall)
  logger.info('[WaitingGap] tool settled', { tool: toolCall.toolName, status: toolCall.status, t: now() })
}
