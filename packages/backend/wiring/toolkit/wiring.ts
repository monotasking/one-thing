/**
 * R2b —— 接线(设计文档 §12.5 的三处引擎缝在装配层的那一半)。
 *
 * 这个文件是**唯一**把新树接到活着的执行路上的地方。三件事:
 *
 *  1. `buildToolkitCatalog(tier)` —— 缝 4:三档目录 + `feature_*` 独立入口,
 *     建好之后通过 `configureToolkitCatalog` 递给产品层的晚绑定端口(缝 1 落在
 *     `agent-loop/stream-runtime.ts`,那里不许 import `@onething/backend`)。
 *  2. `runToolkitToolDirectly(...)` —— 缝 2:`executeToolDirectly` 的新路。签名与
 *     返回形状**与旧路逐字相同**(`OnethingToolExecutionResult`),所以
 *     `ipc-bridge.ts` / `apps/server/src/http.ts` / 渲染器一个字都不动。
 *  3. 缝 3 的两半:四个回调 → `IpcProjector`(一个 Observer),两条插件拦截链 →
 *     一个 `Interceptor`。
 *
 * ## 目录里没有的工具怎么办
 *
 * R4b 之前是"退回旧路";旧树删掉之后**没有第二条路** —— `runToolkitToolDirectly`
 * 仍然返回 `undefined`,但它现在的意思是"这个宿主里没有这个工具",调用方据此报
 * 一句 tool-not-found,而不是换一条链。
 *
 * 插件工具在目录里(`app/toolkit/plugin-tools.ts`,由 `app/plugins/api.ts` 在注册时
 * 装进来),`feature_*` 由 self-evolution feature 自己装。
 */

import type { Catalog, Decision, Intent, Invocation, Outcome, Result } from '@onething/core/toolkit'
import { Outcome as OutcomeOps } from '@onething/core/toolkit'
import type { Authorizer } from '@onething/core/toolkit'
import type { Principal } from '@onething/core/permission'
import type { JsonObject } from '@shared/json.js'
import type { Step, ToolPartialResult } from '@shared/ipc.js'
import { configureToolkitCatalog, getToolkitCatalog } from '@onething/runtime/toolkit'
import type { ToolExecutionResult as OnethingToolExecutionResult } from '@onething/runtime/toolkit/execution-types.wiring'
import { createCatalogForTier, type ToolCatalogTier } from './catalog.js'
import { IpcProjector, type LegacyMetadataUpdate } from '@onething/runtime/toolkit/ipc-observer.wiring'
import { createPermissionAuthorizer } from './authorizer.js'
import { createAppToolRunner } from './runner.js'
import { toolkitAuditSink } from './audit-sink.js'
import { refreshMcpToolsInCatalog, syncMcpToolsIntoCatalog } from '@onething/runtime/toolkit/mcp-catalog.wiring'
import { runPluginToolCallIntercept } from '../../plugins/tool-call-intercept.js'
import { runPluginToolResultIntercept } from '../../plugins/tool-result-intercept.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('toolkit')


/* ── 缝 4:目录 ───────────────────────────────────────────────────────────── */

let built: { catalog: Catalog; tier: ToolCatalogTier } | undefined

/**
 * 建一档目录并挂到产品层端口上。`createOnethingBackend` 在工具注册阶段旁边调它
 * 一次(开关开时才调 —— 不调就零开销)。
 */
export function buildToolkitCatalog(tier: ToolCatalogTier): Catalog {
  if (built?.tier === tier) return built.catalog
  const catalog = createCatalogForTier(tier)
  /*
   * §13.5:`feature_*` 不在三档里(旧树同规)。
   *
   * **R3b 起它们也不由这里注册**:自进化三件套由 self-evolution feature 在
   * `mount` 时自己装进目录(`app/features/builtin/self-evolution.ts`),与旧树
   * 同一条纪律——吃自己狗粮。R2b 图省事在这里代注册了一次,那让 feature 的
   * 生命周期与它注册的工具的生命周期分了家(卸载 feature 摘不掉工具)。
   * 宿主档门与那张动态挂载表的寿命都跟着挪了过去。
   */
  configureToolkitCatalog(catalog)
  built = { catalog, tier }
  return catalog
}

/** 服务器工具面变了(§13.7 裁定 5 的挂点)。 */
export function refreshToolkitMcpTools(): void {
  const catalog = built?.catalog ?? getToolkitCatalog()
  if (!catalog) return
  refreshMcpToolsInCatalog(catalog)
}

/**
 * 拿到当下这一份目录。`buildToolkitCatalog` 没被调过(单测直接跑引擎、宿主没走
 * backend)时懒建 **full** 档。建不起来就返回 undefined —— R4b 之后没有旧路可退,
 * 调用方各自据此报"这个宿主没有工具",而不是静悄悄换一条链。
 *
 * R4b:`ONETHING_TOOLKIT_TIER` 这个切换期兜底环境变量随开关一起删(§14.5-5)。
 * 真宿主的档位一律由 `createOnethingBackend` 显式传进 `buildToolkitCatalog`。
 */
export function getOrBuildToolkitCatalog(): Catalog | undefined {
  if (built) return built.catalog
  const configured = getToolkitCatalog()
  if (configured) return configured
  try {
    return buildToolkitCatalog('full')
  } catch (error) {
    log.error('toolkit catalog build failed; this host has no tools', {}, error)
    return undefined
  }
}

/** 测试钩子:摘掉目录,回到"没接线"的状态。 */
export function resetToolkitCatalogForTests(): void {
  built = undefined
  configureToolkitCatalog(undefined)
}

/* ── 缝 3:两条插件拦截链 → 一个 Interceptor ───────────────────────────────── */

/**
 * 与 `core/engine/direct-tool-execution.ts` 的私有 `toolResultView` **逐字相同**。
 *
 * 复制而不是 import,理由同 R2a 决定⑥ / R3a §13.6-1:那个文件在 §6 的删除清单上,
 * 新树对它的每一条 import 都是一根会在 R4 断掉的绳子。这是十行纯函数。
 */
function toolResultView(result: OnethingToolExecutionResult): { content: string; isError: boolean } {
  if (!result.success) return { content: result.error ?? '', isError: true }
  const data = result.data
  if (typeof data === 'string') return { content: data, isError: false }
  if (data === undefined || data === null) return { content: '', isError: false }
  try {
    return { content: JSON.stringify(data), isError: false }
  } catch {
    return { content: String(data), isError: false }
  }
}

/**
 * `replace` 判决映射回 `Outcome`。
 *
 * **一处有意的偏差**:成功态的 `replace` 在旧路里把 `data` 顶成一个**裸字符串**
 * (`{...result, data: verdict.content}`),而 canonical `Result` 里没有"裸值"这个
 * 形状 —— 新路投影出来的是 `{ title, output: content, metadata: {} }`。给模型看的
 * 文本一模一样,变的是 `data` 这一层的包装。不为它在内核里开一个特例:那等于让
 * 一条插件改写路径长出自己的结果形状。
 */
function outcomeWithReplacedResult(verdict: { content: string; isError: boolean }): Outcome {
  if (verdict.isError) return OutcomeOps.failed(new Error(verdict.content))
  const result: Result = { content: [{ type: 'text', text: verdict.content }] }
  return OutcomeOps.ok(result)
}

class PluginInterceptor {
  private readonly projector: IpcProjector
  /** 改写之后的参数。结果拦截链要拿**最终跑的那份**,与旧路一致。 */
  private currentInput: unknown

  constructor(projector: IpcProjector, initialInput: unknown) {
    this.projector = projector
    this.currentInput = initialInput
  }

  async beforePlan(invocation: Invocation) {
    const outcome = await runPluginToolCallIntercept({
      sessionId: invocation.sessionId,
      toolName: invocation.toolId,
      toolCallId: invocation.callId,
      input: invocation.input,
    })
    if (outcome.action === 'block') {
      // fail-closed 的措辞留在原地:改写结果的 zod 校验发生在链**内部**
      // (`CorePluginToolCallInterceptRegistry.validateInput`),校验不过时链自己
      // 就返回 block + "校验失败"的理由。这里只转手,不重新措辞(§11.4 第 2 条)。
      return { block: true as const, reason: outcome.reason, blockedBy: outcome.blockedBy }
    }
    if (outcome.rewrittenBy.length === 0) return {}
    this.currentInput = outcome.input
    return { input: outcome.input, rewrittenBy: outcome.rewrittenBy }
  }

  async afterApply(outcome: Outcome, invocation: Invocation): Promise<Outcome> {
    // 只有工具**真正产出的结果**进改写链:被拦截器挡下、被权限拒绝、被用户取消
    // 的都不进(分别是拦截器的、权限系统的、用户的),与旧路逐字一致。
    if (outcome.kind === 'denied' || outcome.kind === 'aborted') return outcome
    const legacy = this.projector.toExecutionResult(outcome)
    const verdict = await runPluginToolResultIntercept({
      sessionId: invocation.sessionId,
      toolName: invocation.toolId,
      toolCallId: invocation.callId,
      input: this.currentInput as JsonObject,
      result: toolResultView(legacy),
    })
    if (verdict.action !== 'replace') return outcome
    return outcomeWithReplacedResult(verdict.result)
  }
}

/* ── 缝 2:执行函数 ───────────────────────────────────────────────────────── */

/**
 * 旧路里 `beforeSideEffect` 由**工具自己**在动手之前调(edit / write / bash 三只),
 * 外加 MCP 分支在权限通过之后调一次。它做两件事:等排他队列(并行工具的副作用
 * 串行化),以及**权限通过后刷一次 UI 状态**(卡片从"待确认"翻成"执行中")。
 *
 * 新路里 plan/apply 之间那道缝天然覆盖了"权限通过之后",所以它落在授权者的
 * 装饰器上。但**只对这三只 + 报了效果的 MCP 调用**触发 —— 旧路里 read / time /
 * variable 从不调它,一视同仁地调会给渲染器凭空多发几条状态更新。
 */
const SIDE_EFFECT_GATE_TOOLS = new Set(['edit', 'write', 'bash'])

function withSideEffectGate(
  inner: Authorizer,
  shouldGate: (intent: Intent) => boolean,
  beforeSideEffect: (() => Promise<void>) | undefined,
): Authorizer {
  if (!beforeSideEffect) return inner
  return {
    async decide(intent: Intent, invocation: Invocation, scope): Promise<Decision> {
      const decision = await inner.decide(intent, invocation, scope)
      if (decision.kind === 'allow' && shouldGate(intent)) await beforeSideEffect()
      return decision
    },
  }
}

export interface ToolkitDirectContext {
  sessionId: string
  messageId: string
  toolCallId?: string
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  abortSignal?: AbortSignal
  principal?: Principal
  agentId?: string
  onMetadata?: (update: LegacyMetadataUpdate) => void
  onPartialResult?: (update: ToolPartialResult) => void
  onStepStart?: (step: Step) => void
  onStepComplete?: (step: Step) => void
  beforeSideEffect?: () => Promise<void>
}

let callSeq = 0

function mintCallId(): string {
  callSeq += 1
  return `toolkit-${Date.now()}-${callSeq}`
}

/**
 * 一次工具调用。
 *
 * 返回 `undefined` = 这个工具不在目录里。R4b 之前调用方据此退回旧路;旧树删掉
 * 之后它的意思变成"这个宿主没有这个工具",调用方各自报 tool-not-found。
 */
export async function runToolkitToolDirectly(
  toolName: string,
  args: JsonObject,
  context: ToolkitDirectContext,
): Promise<OnethingToolExecutionResult | undefined> {
  const catalog = getOrBuildToolkitCatalog()
  if (!catalog) return undefined

  let tool = catalog.get(toolName)
  if (!tool) {
    // MCP 的目录是活的(flat/router 随阈值翻转),现同步一次再找。
    syncMcpToolsIntoCatalog(catalog)
    tool = catalog.get(toolName)
  }
  if (!tool) return undefined

  try {
    await catalog.ensurePrepared(tool.spec.id)
  } catch (error) {
    /*
     * 懒初始化失败(MCP 连不上)= 这次调用跑不了。R4b 之前这里返回 `undefined`
     * 让旧路自己报错;旧路没了之后返回 `undefined` 会被读成"没有这个工具",那是
     * 一句假话 —— 工具在,是它的准备失败了。所以如实报一次失败。
     */
    log.error('toolkit tool prepare failed', { toolId: tool.spec.id }, error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const invocation: Invocation = {
    callId: context.toolCallId ?? mintCallId(),
    toolId: toolName,
    input: args,
    sessionId: context.sessionId,
    messageId: context.messageId,
    // 旧路把 `principal` 原样递给 `enforcePermissionPolicy`(可以是 undefined)。
    // 这里同样原样透传:补一个默认主体会把"不知道是谁"变成"是某个人",而权限
    // 授予是按主体记的。
    principal: context.principal as Principal,
    cwd: context.workingDirectory,
    workspaceRoot: context.workingDirectory,
    ...(context.workingDirectoryRoots ? { workingDirectoryRoots: context.workingDirectoryRoots } : {}),
  }

  const projector = new IpcProjector({
    onMetadata: context.onMetadata,
    onPartialResult: context.onPartialResult,
    onStepStart: context.onStepStart,
    onStepComplete: context.onStepComplete,
  })
  const interceptor = new PluginInterceptor(projector, args)
  const isMcp = tool.spec.effects.includes('mcp')
  const authorizer = withSideEffectGate(
    createPermissionAuthorizer(),
    intent => (isMcp ? intent.effects.length > 0 : SIDE_EFFECT_GATE_TOOLS.has(tool.spec.id)),
    context.beforeSideEffect,
  )

  const runner = createAppToolRunner({
    observer: projector,
    audit: toolkitAuditSink,
    interceptor,
    authorizer,
  })

  const outcome = await runner.run(tool, invocation, context.abortSignal)
  return projector.toExecutionResult(outcome)
}
