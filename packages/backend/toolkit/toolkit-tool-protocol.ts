

export type {
  PrepareEnv,
  Scene,
  ToolBudgetHint,
  ToolPresentation,
  ToolPresentationKind,
  ToolPromptContribution,
  ToolSpec,
} from './toolkit-spec.js'

export { Tool } from './toolkit-tool.js'

export { Decision, Intent } from './toolkit-intent.js'
export type { IntentInit, Preview } from './toolkit-intent.js'

export {
  Outcome,
  PARTIAL_OUTPUT_CLOSE_TAG,
  PARTIAL_OUTPUT_OPEN_TAG,
  TOOL_CANCELLED_MESSAGE,
} from './toolkit-outcome.js'

export { emptyResult, resultToText, textResult } from './toolkit-result.js'
export type { Result, ResultPart } from './toolkit-result.js'

export { isLifecycleEvent, LIFECYCLE_EVENT_TYPE } from './toolkit-events.js'
export type {
  Emit,
  ObservedEvent,
  ObservedEventType,
  ToolEvent,
  ToolEventType,
  ToolLifecycleEvent,
} from './toolkit-events.js'

export {
  AbortScope,
  createToolAbortError,
  createToolTimeoutError,
  isToolAbortError,
  isToolTimeoutError,
  TOOL_TIMEOUT_ERROR_NAME,
} from './toolkit-abort-scope.js'
export type { AbortScopeOptions, AbortView, ToolTimeoutError } from './toolkit-abort-scope.js'

export { byteLength, DEFAULT_OUTPUT_BUDGET, OutputBudget } from './toolkit-output-budget.js'
export type { OutputBudgetLimits, OutputBudgetOptions, SpillPort, SpillRequest } from './toolkit-output-budget.js'

export { bindJobRegistry, jobSnapshot } from './toolkit-job.js'
export type {
  Job,
  JobEvent,
  JobOwner,
  JobRegistry,
  JobSnapshot,
  JobSpec,
  JobStatus,
} from './toolkit-job.js'

export { RunContext } from './toolkit-run-context.js'
export type { Invocation, PlanContext, RunContextInit, SessionSnapshot } from './toolkit-run-context.js'

export { Catalog } from './toolkit-catalog.js'
export { normalizeLegacyAllowlist, Surface } from './toolkit-surface.js'
export type { SurfaceResolveInput } from './toolkit-surface.js'

export { combineValidators, systemClock, withUserToolSettings } from './toolkit-ports.js'
export type {
  Authorizer,
  Clock,
  InterceptVerdict,
  Interceptor,
  Observer,
  PartialValidator,
  SandboxPolicy,
  ToolUserSetting,
  ValidationResult,
  Validator,
} from './toolkit-ports.js'

export { assertWithinDeclaredEffects, EffectViolationError, ToolRunner } from './toolkit-runner.js'
export type { ToolRunnerPorts } from './toolkit-runner.js'
