import type { AgentToolExecutionContext } from '@onething/core/agent-loop'
import type {
  CoreSkillReviewFileToolAdapter,
  CoreSkillReviewManageArgs,
} from '@onething/runtime/triggers'
import { createOnethingSkillReviewTrigger } from '@onething/runtime/triggers'
import { getUserSkillsPath } from '../../skills/index.js'
import { executeSkillManage, type SkillManageArgs } from '../../skills/manage.js'
import {
  getSkillsForSession,
  invalidateSessionSkillsCache as invalidateSkillsCache,
} from '../../skills/session-skills.js'
import type { Trigger, TriggerContext } from './index.js'
import { billSkillUsage } from '../../usage/bill-side-line.js'
import { createUtilityProvider } from '../../providers/utility-provider.js'
// 三只文件工具从**目录**取,执行走 runner(设计文档 §10.2-④)。
import { Decision } from '@onething/core/toolkit'
import type { Invocation, Observer, Tool as ToolkitTool } from '@onething/core/toolkit'
import { Outcome as OutcomeOps } from '@onething/core/toolkit'
import { toJsonObject, type JsonObject } from '@shared/json.js'
import { contractForSchema, getToolkitCatalog } from '@onething/runtime/toolkit'
import { createAppToolRunner } from '../../toolkit/runner.js'
import { consolePort, getLogger } from '../../logging/index.js'
import type { CoreSkillReviewVisibleSkill } from '@onething/runtime/triggers/skill-review-core'
import type { OnethingSkillReviewAdapters } from '@onething/runtime/triggers/skill-review'

const log = getLogger('engine.triggers')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


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

/**
 * 目录里的一只文件工具 → skill review 要的那张适配器。
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
export function toolkitFileToolAdapter(
  tool: ToolkitTool,
  toInvocation: (args: unknown, toolCtx: AgentToolExecutionContext) => Invocation,
): CoreSkillReviewFileToolAdapter {
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

export function createToolkitSkillReviewFileToolAdapters(
  ctx: TriggerContext,
  mutableRoots: string[],
): Record<'read' | 'write' | 'edit', CoreSkillReviewFileToolAdapter> | undefined {
  const catalog = getToolkitCatalog()
  if (!catalog) return undefined
  const read = catalog.get('read')
  const write = catalog.get('write')
  const edit = catalog.get('edit')
  // 三只缺一就整组不给:readonly 档没有 write/edit,那时这个触发器本来就该
  // 什么都不做,而不是拿半组适配器去跑一次注定写不进去的审查。
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

/**
 * R4b:旧路(直接 import `ReadTool`/`WriteTool`/`EditTool` 三个旧对象再调
 * `.execute`)已随旧树删除,目录是唯一来源。三只缺一 → `undefined`,产品层的
 * 触发器据此不装文件工具(它自己接得住这一格)。
 */
function createMainSkillReviewFileToolAdapters(
  ctx: TriggerContext,
  mutableRoots: string[],
): Record<'read' | 'write' | 'edit', CoreSkillReviewFileToolAdapter> | undefined {
  return createToolkitSkillReviewFileToolAdapters(ctx, mutableRoots)
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
  const skillReviewAdapters: OnethingSkillReviewAdapters<TriggerContext, CoreSkillReviewVisibleSkill> = {
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
    logger: consoleLog,
  };
  return createOnethingSkillReviewTrigger<TriggerContext>(skillReviewAdapters) as Trigger
}
