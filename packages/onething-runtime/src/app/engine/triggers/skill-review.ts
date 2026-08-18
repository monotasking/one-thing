import type { AgentToolExecutionContext } from '@onething/core/agent-loop'
import type {
  CoreSkillReviewManageArgs,
} from '@onething/runtime/triggers'
import {
  createOnethingSkillReviewFileToolAdapters,
  createOnethingSkillReviewTrigger,
} from '@onething/runtime/triggers'
import { getUserSkillsPath } from '../../skills/index.js'
import { executeSkillManage, type SkillManageArgs } from '../../skills/manage.js'
import {
  getSkillsForSession,
  invalidateSessionSkillsCache as invalidateSkillsCache,
} from '../../skills/session-skills.js'
import { ReadTool } from '../../tools/builtin/read.js'
import { WriteTool } from '../../tools/builtin/write.js'
import { EditTool } from '../../tools/builtin/edit.js'
import type { ToolContext } from '../../tools/core/tool.js'
import type { Trigger, TriggerContext } from './index.js'
import { billSkillUsage } from '../../usage/bill-side-line.js'
import { createUtilityProvider } from '../../providers/utility-provider.js'
// R3b:开关开时三只文件工具从**目录**取,执行走 runner(设计文档 §10.2-④)。
import { Decision } from '@onething/core/toolkit'
import type { Invocation, Observer, Tool as ToolkitTool } from '@onething/core/toolkit'
import { Outcome as OutcomeOps } from '@onething/core/toolkit'
import { toJsonObject, type JsonObject } from '@shared/json.js'
import { isToolkitEnabled } from '@onething/runtime/toolkit/flag'
import { contractForSchema, getToolkitCatalog } from '@onething/runtime/toolkit'
import { createAppToolRunner } from '../../toolkit/runner.js'

function isSkillReviewDisabledByEnv(): boolean {
  return process.env.ONETHING_DISABLE_SKILL_REVIEW === '1' ||
    process.env.ONETHING_DISABLE_SKILL_REVIEW === 'true'
}

function asSkillManageArgs(args: CoreSkillReviewManageArgs): SkillManageArgs {
  return args as SkillManageArgs
}

function getFreshSkillsForSession(workingDirectory?: string): ReturnType<typeof getSkillsForSession> {
  invalidateSkillsCache()
  return getSkillsForSession(workingDirectory)
}

function createToolContext(
  ctx: TriggerContext,
  toolCallId: string,
  mutableRoots: string[],
): ToolContext {
  return {
    sessionId: ctx.sessionId,
    messageId: `skill-review:${ctx.sessionId}`,
    toolCallId,
    workingDirectory: ctx.session.workingDirectory,
    workingDirectoryRoots: mutableRoots,
    metadata: () => {},
    updateResult: () => {},
    beforeSideEffect: async () => {},
  }
}

/**
 * R3b —— 目录里的一只文件工具 → skill review 要的那张适配器。
 *
 * **权限口径与旧路逐字相同:不过权限门。** 旧路直调 `ReadTool.execute(...)`
 * (注册表那层的 `enforcePermission` 根本没经过),因为这是一次后台触发,写的是
 * 用户自己的 skills 目录、根由 `mutableRoots` 夹死,而它跑的时候没有人在看屏幕 ——
 * 弹一张没人点的卡等于把这个功能变成"120 秒后自动失败"。所以这里显式装一个
 * 恒 allow 的授权者:**把旧路那个隐含的绕过写成一句看得见的话**,而不是让它继续
 * 靠"调的是工具对象不是注册表"这种偶然成立。
 *
 * 换来的是新树那几样:统一取消(`AbortScope`)、统一截断(`OutputBudget`)、
 * 两阶段(plan 里那套路径夹紧照跑)。
 */
function toolkitFileToolAdapter(
  tool: ToolkitTool,
  toInvocation: (args: unknown, toolCtx: AgentToolExecutionContext) => Invocation,
): ReturnType<typeof createOnethingSkillReviewFileToolAdapters>['read'] {
  const contract = contractForSchema(tool.spec.input)
  const schema = tool.spec.input as { properties?: unknown; required?: unknown }
  const noopObserver: Observer = { on: () => {} }
  return {
    description: tool.spec.description,
    parameters: toJsonObject({
      type: 'object',
      properties: schema.properties,
      required: schema.required,
    }) as never,
    parse(args) {
      if (!contract) return { success: true, data: args as never }
      const parsed = contract.zod.safeParse(args)
      return parsed.success
        ? { success: true, data: parsed.data as never }
        : { success: false, error: parsed.error.message }
    },
    async execute(args, toolCtx) {
      const runner = createAppToolRunner({
        observer: noopObserver,
        authorizer: { decide: async () => Decision.allow() },
      })
      const outcome = await runner.run(tool, toInvocation(args, toolCtx))
      if (outcome.kind !== 'ok') {
        throw new Error(OutcomeOps.toModelText(outcome))
      }
      return {
        output: OutcomeOps.toModelText(outcome),
        metadata: (outcome.result.details ?? {}) as Record<string, unknown>,
      }
    },
  }
}

function createToolkitSkillReviewFileToolAdapters(
  ctx: TriggerContext,
  mutableRoots: string[],
): ReturnType<typeof createOnethingSkillReviewFileToolAdapters> | undefined {
  const catalog = getToolkitCatalog()
  if (!catalog) return undefined
  const read = catalog.get('read')
  const write = catalog.get('write')
  const edit = catalog.get('edit')
  // 三只缺一就整组退回旧路:半新半旧的一组适配器会让"这次审查用的是哪套口径"
  // 变成一个没人答得上来的问题(readonly 档没有 write/edit,那时本来就该退)。
  if (!read || !write || !edit) return undefined
  const toInvocation = (toolCtx: AgentToolExecutionContext): Invocation => ({
    callId: toolCtx.toolCallId,
    toolId: '',
    input: {} as JsonObject,
    sessionId: ctx.sessionId,
    messageId: `skill-review:${ctx.sessionId}`,
    principal: undefined as never,
    ...(ctx.session.workingDirectory ? { cwd: ctx.session.workingDirectory } : {}),
    workingDirectoryRoots: mutableRoots,
  })
  const bind = (tool: ToolkitTool) => toolkitFileToolAdapter(tool, (args, toolCtx) => ({
    ...toInvocation(toolCtx),
    toolId: tool.spec.id,
    input: args as JsonObject,
  }))
  return { read: bind(read), write: bind(write), edit: bind(edit) }
}

function createMainSkillReviewFileToolAdapters(
  ctx: TriggerContext,
  mutableRoots: string[],
): ReturnType<typeof createOnethingSkillReviewFileToolAdapters> {
  if (isToolkitEnabled()) {
    const fromCatalog = createToolkitSkillReviewFileToolAdapters(ctx, mutableRoots)
    if (fromCatalog) return fromCatalog
  }
  return createOnethingSkillReviewFileToolAdapters({
    tools: {
      read: ReadTool,
      write: WriteTool,
      edit: EditTool,
    },
    toToolContext: (toolCtx: AgentToolExecutionContext): ToolContext =>
      createToolContext(ctx, toolCtx.toolCallId, mutableRoots),
  })
}

// No fallback to the chat provider on purpose: skill review is background
// work, and running it silently on an expensive chat model is worse than not
// running it at all. Leaving the tool-call model unset disables the feature.
async function createSkillReviewAgentProvider(ctx: TriggerContext) {
  return createUtilityProvider(ctx.settings, {
    workingDirectory: ctx.session.workingDirectory,
    sessionId: ctx.sessionId,
  })
}

export function createSkillReviewTrigger(): Trigger {
  return createOnethingSkillReviewTrigger<TriggerContext>({
    isDisabled: isSkillReviewDisabledByEnv,
    homeDir: () => process.env.HOME,
    getVisibleSkills: getFreshSkillsForSession,
    getUserSkillsPath,
    executeSkillManage: (args, options) =>
      executeSkillManage(asSkillManageArgs(args), { workingDirectory: options.workingDirectory }),
    invalidateSkillsCache,
    createAgentProvider: createSkillReviewAgentProvider,
    onUsage: (usage, context) =>
      billSkillUsage(context.providerId, context.model, context.sessionId)(usage),
    fileTools: (ctx, options) => createMainSkillReviewFileToolAdapters(ctx, options.mutableRoots),
    logger: console,
  }) as Trigger
}
