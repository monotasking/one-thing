/**
 * 检索内核(S1)。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位 / §10 S1 行
 *
 * 三件东西:能力注册表(联邦骨架)、索引接口 + 一份纯 TS 实现、查询流水线。
 * 产品实现(SqliteIndex / 各个能力 / 索引服务)在 runtime,壳在 apps。
 *
 * **法条**:本目录不出现任何能力 id 字面量,不在 `.kind` / `.capability` 上 switch
 * (S0 由边界检查器 `checkCoreSearchNamesNoCapability` 执法)。
 */

export type {
  ActionDescriptor,
  Candidate,
  FacetFilter,
  FacetValue,
  GroupResult,
  LadderStep,
  PageRequest,
  PreviewPayload,
  QueryNode,
  RelaxLevel,
  SearchContext,
  SearchPage,
  SearchPrincipal,
  SearchQuery,
  SearchScope,
  TextRange,
} from './candidate.js'
export { ALL_CAPABILITIES, DEFAULT_INTENT } from './candidate.js'

export {
  DuplicateCapabilityError,
  capabilityOrder,
  capabilityServesSurface,
  createCapabilityRegistry,
} from './capability.js'
export type {
  CapabilityBudget,
  CapabilityKind,
  CapabilityManifest,
  CapabilityRegistry,
  FacetDeclaration,
  FieldSchema,
  RankingDeclaration,
  SearchCapability,
  VectorRetrieverWhen,
  VisibilityRule,
  VisibilityScope,
} from './capability.js'

export { composeDocumentFilters } from './feed.js'
export type {
  DocPayload,
  DocumentFeed,
  DocumentFilter,
  DocumentFilterContext,
  FeedPolicy,
} from './feed.js'

export * from './analyzer/index.js'
export * from './index/index.js'
export * from './pipeline/index.js'
export * from './bases/index.js'

export {
  CursorDecodeError,
  createCursorCodec,
  hashQueryShape,
} from './cursor.js'
export type { CursorCodec, CursorPayload, OffsetCursor, PositionCursor } from './cursor.js'
