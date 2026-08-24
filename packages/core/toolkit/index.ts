/**
 * `@onething/core/toolkit` —— 工具系统内核(`docs/design/tool-system-oop-2026-08.md` §3)。
 *
 * 零依赖、纯 TS:不认识 electron、不认识宿主 IPC 契约包、不认识任何 provider 与
 * 渲染器。所有与外界的关系都走端口(ports.ts)与投影器(在 runtime/app 层)。
 *
 * R0 只建内核,一处未接线 —— 旧工具树照常运行。
 */

export {
  EFFECT_CLASSES,
  EFFECT_POLICY,
  effectPolicyFor,
  isBarrierEffect,
  isKnownEffectClass,
  makeEffect,
  policyOf,
  requiresAuthorization,
} from './effects.js'
export type { Effect, EffectClass, EffectPolicy, EffectPolicyRow } from './effects.js'

export type {
  JsonSchema,
  PrepareEnv,
  Scene,
  ToolBudgetHint,
  ToolPresentation,
  ToolPresentationKind,
  ToolPromptContribution,
  ToolSpec,
} from './spec.js'

export { Tool } from './tool.js'

export { Decision, Intent } from './intent.js'
export type { IntentInit, Preview } from './intent.js'

export {
  Outcome,
  PARTIAL_OUTPUT_CLOSE_TAG,
  PARTIAL_OUTPUT_OPEN_TAG,
  TOOL_CANCELLED_MESSAGE,
} from './outcome.js'

export { emptyResult, resultToText, textResult } from './result.js'
export type { Result, ResultPart } from './result.js'

export { isLifecycleEvent, LIFECYCLE_EVENT_TYPE } from './events.js'
export type {
  Emit,
  ObservedEvent,
  ObservedEventType,
  ToolEvent,
  ToolEventType,
  ToolLifecycleEvent,
} from './events.js'

export {
  AbortScope,
  createToolAbortError,
  createToolTimeoutError,
  isToolAbortError,
  isToolTimeoutError,
  TOOL_TIMEOUT_ERROR_NAME,
} from './abort-scope.js'
export type { AbortScopeOptions, AbortView, ToolTimeoutError } from './abort-scope.js'

export { byteLength, DEFAULT_OUTPUT_BUDGET, OutputBudget } from './output-budget.js'
export type { OutputBudgetLimits, OutputBudgetOptions, SpillPort, SpillRequest } from './output-budget.js'

export { bindJobRegistry, jobSnapshot } from './job.js'
export type {
  Job,
  JobEvent,
  JobOwner,
  JobRegistry,
  JobSnapshot,
  JobSpec,
  JobStatus,
} from './job.js'

export { RunContext } from './run-context.js'
export type { Invocation, PlanContext, RunContextInit, SessionSnapshot } from './run-context.js'

export { Catalog } from './catalog.js'
export { normalizeLegacyAllowlist, Surface } from './surface.js'
export type { SurfaceResolveInput } from './surface.js'

export { systemClock, withUserToolSettings } from './ports.js'
export type {
  Authorizer,
  Clock,
  InterceptVerdict,
  Interceptor,
  Observer,
  SandboxPolicy,
  ToolUserSetting,
  ValidationResult,
  Validator,
} from './ports.js'

export { assertWithinDeclaredEffects, EffectViolationError, ToolRunner } from './runner.js'
export type { ToolRunnerPorts } from './runner.js'
