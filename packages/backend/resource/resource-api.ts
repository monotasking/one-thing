

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
} from './spec.js'

export {
  assertResourceSpec,
  describeResourceSpecProblem,
  formatResourceSpecProblem,
  ResourceSpecError,
} from './contract.js'
export type { ResourceSpecMember, ResourceSpecProblem } from './contract.js'

export { ResourceRegistry, ResourceSchemeTakenError } from './registry.js'
export type { ResolvedRef } from './registry.js'

export { planFromSpec } from './provider.js'
export type { ResourceProvider, ResourceReadContext } from './provider.js'

export {
  RESOURCE_OP_KEY,
  RESOURCE_READ_KEY,
  RESOURCE_REF_KEY,
  toolDescriptionOf,
  toolEffectsOf,
  toolInputSchemaOf,
} from './schema.js'

export { assertWithinOpEffects, ResourceTool } from './tool.js'
export type { ResourceCall, ResourceToolOptions, ShellDispatch } from './tool.js'

export {
  RESOURCE_META_TOOL_ID,
  ResourceMetaCallShapeError,
  ResourceMetaTool,
} from './meta-tool.js'
export type { ResourceMetaCall } from './meta-tool.js'

export { ResourceEventHub } from './events.js'
export type { ResourceEvent, ResourceEventListener } from './events.js'

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
} from './errors.js'
