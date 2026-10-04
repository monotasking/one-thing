

export type {
  EventMoment,
  EventSpec,
  OpContext,
  OpHome,
  OpSpec,
  ReadSpec,
  ResourceExposure,
  MomentWeight,
  ResourceSpec,
  StateScope,
  StateSpec,
  StateVolatility,
} from './resource-spec.js'

export {
  assertResourceSpec,
  describeResourceSpecProblem,
  formatResourceSpecProblem,
  ResourceSpecError,
} from './resource-contract.js'
export type { ResourceSpecMember, ResourceSpecProblem } from './resource-contract.js'

export { ResourceRegistry, ResourceSchemeTakenError } from './resource-registry.js'
export type { ResolvedRef } from './resource-registry.js'

export { planFromSpec } from './resource-provider.js'
export type { ResourceProvider, ResourceReadContext } from './resource-provider.js'

export {
  RESOURCE_OP_KEY,
  RESOURCE_READ_KEY,
  RESOURCE_REF_KEY,
  toolDescriptionOf,
  toolEffectsOf,
  toolInputSchemaOf,
} from './resource-schema.js'

export { assertWithinOpEffects, ResourceTool } from './resource-tool.js'
export type { ResourceCall, ResourceToolOptions, ShellDispatch } from './resource-tool.js'

export {
  RESOURCE_META_TOOL_ID,
  ResourceMetaCallShapeError,
  ResourceMetaTool,
} from './meta-tool.js'
export type { ResourceMetaCall } from './meta-tool.js'

export { ResourceEventHub } from './resource-events.js'
export type { ResourceEvent, ResourceEventListener } from './resource-events.js'

export { NO_ORIGIN_SESSION, ResourceKernel } from './kernel.js'
export type { ReadGuard, ReadVerdict, ResourceCallOptions, ResourceKernelOptions } from './kernel.js'

export { ReadOutcome } from './read-outcome.js'

export {
  describeResourceRefProblem,
  describeUnknownResourceReadProblem,
  ResourceInputValidator,
} from './validator.js'

export {
  ResourceCallShapeError,
  ResourceEffectViolationError,
  ResourceHomeUnavailableError,
  ResourceOpUnavailableError,
  ResourceOpUnknownError,
  ResourceReadUnknownError,
  ResourceRefError,
  ResourceSchemeUnknownError,
  ResourceWatchPrefixError,
} from './resource-errors.js'
