/**
 * toc —— 会话目录:把一个长会话按回合切成几段(每段一个标题),回合结束后由一只小模型决定开新段还是并进旧段。
 *
 * 对外交出几类东西:切段的纯规则、给小模型的提示词与它的回答解析、把决定应用到段表上、段的存储与形状;
 * 以及运行期的两只:回合结束触发器(`createSessionTocTrigger`)与读一个会话的段(`readSessionSegments`)。
 * 依赖 provider-call、session、settings、storage、usage、goal、agent-loop、logging(都是运行期那两只带进来的)。
 */
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
} from './toc-segment.js'
export {
  DEFAULT_SELF_EXPLANATORY_USER_CHARS,
  DEFAULT_TOC_INPUT_TOKEN_BUDGET,
  buildTocPrompt,
  sampleHeadAndTail,
  shouldIncludeReasoning,
  type BuiltTocPrompt,
  type TocTurnInput,
} from './toc-input.js'
export {
  DEFAULT_TRIVIAL_USER_CHARS,
  isTrivialTurn,
  parseTocDecision,
  type TocAction,
  type TocDecision,
  type TurnSignals,
} from './toc-decide.js'
export { applyTurnDecision, openSegmentOf, type ApplyTurnInput } from './toc-apply.js'
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

// 运行期:回合结束触发器、读一个会话的段。
export { createSessionTocTrigger } from './toc-session-trigger.js'
export { readSessionSegments } from './toc-recorder.js'
