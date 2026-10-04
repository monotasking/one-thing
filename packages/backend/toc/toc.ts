export {
  DEFAULT_ABSENCE_GAP_MS,
  coarseSegments,
  isEngineDrivenMessage,
  mergeSegments,
  segmentsFromGoals,
  startsNewSegment,
  touchesDisjointFiles,
  userWasAway,
  type SegmentSourceMessage,
  type SegmentSourceTurn,
} from './segment.js'
export {
  DEFAULT_SELF_EXPLANATORY_USER_CHARS,
  DEFAULT_TOC_INPUT_TOKEN_BUDGET,
  buildTocPrompt,
  sampleHeadAndTail,
  shouldIncludeReasoning,
  type BuiltTocPrompt,
  type TocTurnInput,
} from './input.js'
export {
  DEFAULT_TRIVIAL_USER_CHARS,
  isTrivialTurn,
  parseTocDecision,
  type TocAction,
  type TocDecision,
  type TurnSignals,
} from './decide.js'
export { applyTurnDecision, openSegmentOf, type ApplyTurnInput } from './apply.js'
export { renderTocTurnSystemPrompt } from './toc-render.js'
export {
  SEGMENT_LOG_COMPACT_THRESHOLD,
  createSessionSegmentStore,
  type SessionSegmentStore,
  type SessionSegmentStoreOptions,
} from './toc-store.js'
export type {
  AnchoredSessionSegment,
  SessionSegment,
  SessionSegmentFile,
  SessionSegmentKind,
  SessionSegmentOrigin,
  SessionSegmentOutcome,
} from './toc-types.js'
