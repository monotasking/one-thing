import {
  agentSupportsTools,
  resolveAgentModelCapabilities,
  runAgentLoop,
  type AgentProvider,
  type AgentJsonObject, type AgentLoopOptions,
} from '@onething/core/agent-loop'
import path from 'path'
import {
  SUPPORT_FILE_ROOTS,
  assertSkillReviewToolPath,
  buildSkillReviewAgentRunPlan,
  buildSkillReviewFileAgentTools,
  buildSkillReviewTargetMessages,
  ensureAgentReviewedSkillsCompleteWithAdapters,
  findMutableSkillReviewSkill,
  findSkillReviewVisibleSkill,
  formatSkillReviewVisibleSkillSummary,
  hasSkillReviewAgentMutation,
  isMutatedToolResult,
  normalizeSkillReviewTargetDecision,
  parseSkillReviewTargetDecision,
  skillReviewTranscriptFromMessages,
  type CoreSkillReviewExecutionResult,
  type CoreSkillReviewFileToolAdapter,
  type CoreSkillReviewManageArgs,
  type CoreSkillReviewMessage,
  type CoreSkillReviewPromptMessage,
  type CoreSkillReviewVisibleSkill,
} from './skill-review-core.js'
import type { CoreSkillReviewSettings } from './skill-review-state-core.js'
import type {
  CoreTrigger,
  CoreTriggerContext,
} from '@onething/core/engine'
import {
  isFile,
  listFilesUnderRoots,
  pathExistsInDir,
  readTextFile,
  writeTextFile,
  writeTextFileInDir,
} from '@onething/core/storage'
import {
  isSkillReviewRunning,
  markSkillReviewRunning,
  recordOnethingSkillReviewCounter,
} from './skill-review-state.js'

export interface OnethingSkillReviewSessionLike {
  workingDirectory?: string
}

export interface OnethingSkillReviewProviderConfigLike {
  apiKey?: string
  baseUrl?: string
  model: string
  oauthToken?: unknown
  authContext?: unknown
  thinkingByModel?: Record<string, boolean | undefined>
  thinkingEffortByModel?: Record<string, unknown>
}

export interface OnethingSkillReviewAgentProviderRef {
  provider: AgentProvider
  providerId: string
  model: string
  thinking?: boolean
  thinkingEffort?: unknown
  thinkingByModel?: Record<string, boolean | undefined>
  thinkingEffortByModel?: Record<string, unknown>
}

export type OnethingSkillReviewContext<
  TSettings extends CoreSkillReviewSettings = CoreSkillReviewSettings,
  TSession extends OnethingSkillReviewSessionLike = OnethingSkillReviewSessionLike,
  TMessage = unknown,
  TProviderConfig extends OnethingSkillReviewProviderConfigLike = OnethingSkillReviewProviderConfigLike,
> = CoreTriggerContext<TSettings, TSession, TMessage, TProviderConfig>

/**
 * 这次审查用哪三只文件工具。
 *
 * R4b:宿主给的是**已经适配好**的三张表(或一个按回合现算的函数),产品层不再
 * 认识任何一棵工具注册表 —— 旧的 `createOnethingSkillReviewFileToolAdapters`
 * (把 `Tool.Info` 包成适配器)随旧树删除。返回 `undefined` = 这台宿主给不出
 * 这三只(readonly 档),本次审查整个跳过而不是拿半组去跑。
 */
export type { CoreSkillReviewFileToolAdapter }

export type OnethingSkillReviewFileToolAdapters<TContext> = Record<
  'read' | 'write' | 'edit',
  CoreSkillReviewFileToolAdapter
> | ((ctx: TContext, options: { mutableRoots: string[] }) => Record<
  'read' | 'write' | 'edit',
  CoreSkillReviewFileToolAdapter
> | undefined)

export interface OnethingSkillReviewProviderRequestDump {
  providerId: string
  model: string
  mode: 'stream'
  metadata?: Record<string, unknown>
  requestBody: unknown
}

export interface OnethingSkillReviewAdapters<
  TContext extends OnethingSkillReviewContext = OnethingSkillReviewContext,
  TSkill extends CoreSkillReviewVisibleSkill = CoreSkillReviewVisibleSkill,
> {
  isDisabled?(): boolean
  homeDir?(): string | undefined
  getVisibleSkills(workingDirectory?: string): readonly TSkill[]
  getUserSkillsPath(): string
  executeSkillManage(
    args: CoreSkillReviewManageArgs,
    options: { workingDirectory?: string },
  ): CoreSkillReviewExecutionResult | Promise<CoreSkillReviewExecutionResult>
  invalidateSkillsCache?(): void | Promise<void>
  createAgentProvider(ctx: TContext): Promise<OnethingSkillReviewAgentProviderRef | undefined> | OnethingSkillReviewAgentProviderRef | undefined
  requestDumper?(request: OnethingSkillReviewProviderRequestDump): Promise<string | undefined>
  /**
   * Bill an agent loop this trigger ran. Skill review runs on the tool-call
   * model in the background, so without this its tokens are invisible.
   * Optional — hosts that do not track usage omit it.
   */
  onUsage?(
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
    context: { providerId: string; model: string; sessionId?: string },
  ): void
  fileTools: OnethingSkillReviewFileToolAdapters<TContext>
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

interface SkillReviewTarget {
  action: 'create' | 'update'
  name: string
  mutableRoots: string[]
  pathBase: string
}

type SkillReviewTrigger = CoreTrigger<OnethingSkillReviewContext>

function getLogger<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
): Pick<Console, 'log' | 'warn' | 'error'> {
  return adapters.logger ?? console
}

function userSkillSummary<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
  workingDirectory?: string,
): string {
  return formatSkillReviewVisibleSkillSummary(adapters.getVisibleSkills(workingDirectory))
}

function visibleSkill<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
  name: string,
  workingDirectory?: string,
): CoreSkillReviewVisibleSkill | undefined {
  return findSkillReviewVisibleSkill(adapters.getVisibleSkills(workingDirectory), name)
}

function mutableSkill<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
  name: string,
  workingDirectory?: string,
): CoreSkillReviewVisibleSkill | undefined {
  return findMutableSkillReviewSkill(adapters.getVisibleSkills(workingDirectory), name)
}

function assertSkillToolPath<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
  rawPath: string,
  ctx: TContext,
  pathBase: string,
  mutableRoots: string[],
): string {
  return assertSkillReviewToolPath({
    rawPath,
    workingDirectory: pathBase,
    userSkillsPath: adapters.getUserSkillsPath(),
    homeDir: adapters.homeDir?.(),
    mutableRoots,
  })
}

function listSkillSupportFiles(skillDir: string): string[] {
  return listFilesUnderRoots(skillDir, SUPPORT_FILE_ROOTS)
}

function ensureAgentReviewedSkillsComplete<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
  mutatedPaths: Set<string>,
  mutableRoots: string[],
  workingDirectory?: string,
): boolean {
  return ensureAgentReviewedSkillsCompleteWithAdapters({
    mutatedPaths,
    mutableRoots,
    adapters: {
      isSkillFile: isFile,
      readSkillFile: readTextFile,
      writeSkillFile: writeTextFile,
      listSupportFiles: listSkillSupportFiles,
      supportFileExists: pathExistsInDir,
      writeSupportFile: writeTextFileInDir,
    },
  })
}

function resolveFileToolAdapters<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
  ctx: TContext,
  mutableRoots: string[],
): Record<'read' | 'write' | 'edit', CoreSkillReviewFileToolAdapter> | undefined {
  const fileTools = adapters.fileTools
  return typeof fileTools === 'function'
    ? fileTools(ctx, { mutableRoots })
    : fileTools
}

/** `undefined` = 这台宿主给不出这三只文件工具,本次审查跳过。 */
function createSkillFileAgentTools<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
  ctx: TContext,
  target: SkillReviewTarget,
) {
  const fileToolAdapters = resolveFileToolAdapters(adapters, ctx, target.mutableRoots)
  if (!fileToolAdapters) return undefined
  return buildSkillReviewFileAgentTools({
    userSkillsRoot: adapters.getUserSkillsPath(),
    resolvePath: rawPath => assertSkillToolPath(adapters, rawPath, ctx, target.pathBase, target.mutableRoots),
    adapters: fileToolAdapters,
  })
}

function buildTargetReviewMessages<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
  ctx: TContext,
): CoreSkillReviewPromptMessage[] {
  const workingDirectory = ctx.session.workingDirectory
  return buildSkillReviewTargetMessages({
    sessionId: ctx.sessionId,
    workingDirectory,
    visibleSkillSummary: userSkillSummary(adapters, workingDirectory),
    transcript: skillReviewTranscriptFromMessages(ctx.messages as CoreSkillReviewMessage[]),
  })
}

function resolveSkillReviewTarget<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
  ctx: TContext,
  rawDecision: string,
): SkillReviewTarget | undefined {
  const logger = getLogger(adapters)
  let decision
  try {
    decision = normalizeSkillReviewTargetDecision(parseSkillReviewTargetDecision(rawDecision))
  } catch (error) {
    logger.warn(`[SkillReview] Target planning failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }

  if (decision.action === 'none') return undefined

  const workingDirectory = ctx.session.workingDirectory
  const existing = visibleSkill(adapters, decision.name ?? '', workingDirectory)
  const mutable = mutableSkill(adapters, decision.name ?? '', workingDirectory)

  if (decision.action === 'update' || existing) {
    if (!mutable) {
      logger.warn(`[SkillReview] Skipping ${decision.action} for ${decision.name}; target skill is not mutable or not visible.`)
      return undefined
    }
    return {
      action: 'update',
      name: mutable.name,
      mutableRoots: [path.resolve(mutable.directoryPath)],
      pathBase: path.resolve(mutable.directoryPath),
    }
  }

  const targetName = decision.name
  if (!targetName) return undefined

  const skillRoot = path.resolve(adapters.getUserSkillsPath(), targetName)
  return {
    action: 'create',
    name: targetName,
    mutableRoots: [skillRoot],
    pathBase: skillRoot,
  }
}

async function planSkillReviewTarget<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
  ctx: TContext,
  agentProvider: OnethingSkillReviewAgentProviderRef,
): Promise<SkillReviewTarget | undefined> {
  const agentLoopOptions: AgentLoopOptions = {
    provider: agentProvider.provider,
    model: agentProvider.model,
    messages: buildTargetReviewMessages(adapters, ctx),
    tools: [],
    selectedToolNames: [],
    maxTurns: 1,
    temperature: 0.1,
    maxTokens: 800,
    thinking: agentProvider.thinking === true ? 'enabled' : agentProvider.thinking === false ? 'disabled' : undefined,
    reasoningEffort: agentProvider.thinking === true
      ? (agentProvider.thinkingEffort === 'max' ? 'max' : 'high')
      : undefined,
    sessionId: ctx.sessionId,
    messageId: `skill-review-target:${ctx.sessionId}`,
    workingDirectory: ctx.session.workingDirectory,
  };
  const result = await runAgentLoop(agentLoopOptions)
  if (result.usage) {
    adapters.onUsage?.(result.usage, {
      providerId: agentProvider.providerId,
      model: agentProvider.model,
      sessionId: ctx.sessionId,
    })
  }

  return resolveSkillReviewTarget(adapters, ctx, result.text)
}

async function runAgentSkillReview<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
  ctx: TContext,
  agentProvider: OnethingSkillReviewAgentProviderRef,
  target: SkillReviewTarget,
): Promise<void> {
  const workingDirectory = ctx.session.workingDirectory
  const runPlan = buildSkillReviewAgentRunPlan({
    model: agentProvider.model,
    thinking: agentProvider.thinking,
    thinkingEffort: agentProvider.thinkingEffort,
    thinkingByModel: agentProvider.thinkingByModel,
    thinkingEffortByModel: agentProvider.thinkingEffortByModel,
    sessionId: ctx.sessionId,
    workingDirectory,
    visibleSkillSummary: userSkillSummary(adapters, workingDirectory),
    mutableSkillRoots: target.mutableRoots,
    transcript: skillReviewTranscriptFromMessages(ctx.messages as CoreSkillReviewMessage[]),
  })
  const skillFileTools = createSkillFileAgentTools(adapters, ctx, target)
  if (!skillFileTools) {
    // readonly 档(没有 read/write/edit)。一次没有文件工具的技能审查写不出任何
    // 东西,跑它只是白烧一次模型调用。
    getLogger(adapters).log('[SkillReview] host has no read/write/edit tools; skipping')
    return
  }

  const agentLoopOptions2: AgentLoopOptions = {
    provider: agentProvider.provider,
    model: runPlan.model,
    messages: runPlan.messages,
    tools: skillFileTools.tools,
    selectedToolNames: runPlan.selectedToolNames,
    toolChoice: runPlan.toolChoice,
    maxTurns: runPlan.maxTurns,
    temperature: runPlan.temperature,
    maxTokens: runPlan.maxTokens,
    thinking: runPlan.thinking,
    reasoningEffort: runPlan.reasoningEffort,
    sessionId: runPlan.sessionId,
    messageId: runPlan.messageId,
    workingDirectory: runPlan.workingDirectory,
    onEvent(event) {
      if (event.type === 'tool-result') {
        getLogger(adapters).log(`[SkillReview] Agent tool ${event.toolCall.name}: ${event.result.error ?? 'ok'}`)
      }
    },
  };
  const result = await runAgentLoop(agentLoopOptions2)
  if (result.usage) {
    adapters.onUsage?.(result.usage, {
      providerId: agentProvider.providerId,
      model: agentProvider.model,
      sessionId: runPlan.sessionId,
    })
  }

  const agentMutated = result.toolResults.some(toolResult => {
    return isMutatedToolResult(toolResult.result.data)
  })
  const completedSkillPackage = skillFileTools.mutatedPaths.size > 0
    ? ensureAgentReviewedSkillsComplete(
      adapters,
      skillFileTools.mutatedPaths,
      target.mutableRoots,
      ctx.session.workingDirectory,
    )
    : false
  const mutated = hasSkillReviewAgentMutation({
    agentMutated,
    mutatedPathCount: skillFileTools.mutatedPaths.size,
    completedSkillPackage,
  })

  if (mutated) {
    await adapters.invalidateSkillsCache?.()
  } else {
    getLogger(adapters).log(`[SkillReview] Agent completed without skill changes for session ${ctx.sessionId}`)
  }
}

export async function runOnethingSkillReview<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
  ctx: TContext,
): Promise<void> {
  const logger = getLogger(adapters)
  const agentProvider = await adapters.createAgentProvider(ctx)
  if (!agentProvider) {
    logger.log(`[SkillReview] Skipping review for session ${ctx.sessionId}; no tool-call agent provider is configured.`)
    return
  }

  const capabilities = await resolveAgentModelCapabilities(agentProvider.provider, agentProvider.model)
  if (!agentSupportsTools(capabilities)) {
    logger.warn(`[SkillReview] Skipping review for session ${ctx.sessionId}; tool provider ${agentProvider.providerId}/${agentProvider.model} does not support tool calls.`)
    return
  }

  const target = await planSkillReviewTarget(adapters, ctx, agentProvider)
  if (!target) {
    logger.log(`[SkillReview] No skill changes for session ${ctx.sessionId}`)
    return
  }

  await runAgentSkillReview(adapters, ctx, agentProvider, target)
}

// 技能文件由这两个工具直接写(skill_manage 已移除)。
const SKILL_AUTHORING_TOOLS = ['write', 'edit']

export function createOnethingSkillReviewTrigger<TContext extends OnethingSkillReviewContext>(
  adapters: OnethingSkillReviewAdapters<TContext>,
): CoreTrigger<TContext> {
  return {
    id: 'hermes-skill-review',
    name: 'Hermes Skill Review',
    priority: 100,

    async shouldTrigger(ctx) {
      if (adapters.isDisabled?.()) return false
      if (isSkillReviewRunning(ctx.sessionId)) return false

      return recordOnethingSkillReviewCounter({
        sessionId: ctx.sessionId,
        settings: ctx.settings,
        toolIterations: ctx.toolIterations ?? 0,
        skillAuthoringAvailable: SKILL_AUTHORING_TOOLS.some(tool => ctx.enabledToolNames?.includes(tool) ?? false),
        skillManageCalled: ctx.skillManageCalled ?? false,
      })
    },

    async execute(ctx) {
      markSkillReviewRunning(ctx.sessionId, true)
      try {
        await runOnethingSkillReview(adapters, ctx)
      } finally {
        markSkillReviewRunning(ctx.sessionId, false)
      }
    },
  }
}

export type { AgentJsonObject, SkillReviewTrigger }
