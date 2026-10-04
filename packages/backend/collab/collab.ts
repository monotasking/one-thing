export {
  COLLAB_DEFAULT_DAILY_COST_USD,
  COLLAB_DEFAULT_MAX_CHAIN,
  COLLAB_DM_PAIR_MAX_CHAIN,
  COLLAB_HARVEST_SOURCE,
  COLLAB_MESSAGE_SOURCE,
  COLLAB_USAGE_SOURCE_ROOM,
  COLLAB_USAGE_SOURCE_WORK,
  isCollabDriveMessage,
  isCollabHarvestMessage,
  type CollabAgentLike,
  type CollabMentionLike,
  type CollabMessageLike,
  type CollabReplyToLike,
  type CollabRoomBudgets,
  type CollabSelfTaskFact,
  type CollabSelfTaskStatus,
  type CollabSessionKind,
} from './collab-types.js'
/** R3: what a room message IS, decided in one place. The predicates above (and
 *  in say.js / collab-system-lines.js) all delegate here. */
export {
  classifyCollabRoomMessage,
  isCollabChainResetMessage,
  isCollabRoomFact,
  type CollabRoomMessageKind,
} from './collab-classify.js'
export { COLLAB_PASS_SENTINEL, isCollabPassMessage } from './collab-pass.js'
export { COLLAB_CONSUMED_SCAN_TAIL, collectConsumedSourceIds } from './collab-reconcile.js'
export {
  COLLAB_AGENT_SESSION_NAME_PREFIX,
  COLLAB_AGENT_SESSION_PREFIX,
  collabAgentSessionId,
  collabAgentSessionIdsForScan,
  collabAgentSessionName,
  isCollabAgentSessionId,
  stripCollabAgentSessionName,
} from './collab-agent-session.js'
export {
  COLLAB_DM_LEGACY_TOOL_NAME,
  COLLAB_SAY_MAX_CHARS,
  COLLAB_SAY_REFUSED_BUDGET,
  COLLAB_SAY_REFUSED_EMPTY,
  COLLAB_SAY_REFUSED_FROZEN,
  COLLAB_SAY_REFUSED_NOT_MEMBER,
  COLLAB_SAY_REFUSED_NO_ROOM,
  COLLAB_SAY_REFUSED_UNKNOWN_ROOM,
  COLLAB_SAY_SOURCE,
  COLLAB_SEND_MESSAGE_LEGACY_TOOL_NAME,
  COLLAB_SEND_MESSAGE_TOOL_NAME,
  COLLAB_SEND_REFUSED_DM_NO_TARGET,
  COLLAB_SEND_REFUSED_GATEWAY,
  COLLAB_SEND_REFUSED_ROOM_WITH_TO,
  COLLAB_SEND_REFUSED_UNKNOWN_CHANNEL,
  COLLAB_SEND_REFUSED_WAKE_WITHOUT_TARGET,
  COLLAB_TURN_SOURCE,
  COLLAB_WAKE_REFUSED_NO_ROOM,
  COLLAB_WAKE_REFUSED_SELF_NOT_MEMBER,
  COLLAB_WAKE_REFUSED_USER_TARGET,
  formatCollabDmReceipt,
  formatCollabSayReceipt,
  formatCollabThinkingTraceLabel,
  formatCollabWakePoke,
  formatCollabWakeRefusedTargetNotMember,
  isCollabSayMessage,
  isCollabSendDmCall,
  isCollabSendIntoRoom,
  isCollabThinkingMessage,
  normalizeCollabSayContent,
  resolveCollabSayMentions,
  resolveCollabSayRoomSessionId,
  resolveCollabSendChannel,
  resolveCollabSendChannelFromArgs,
  type CollabSendArgsLike,
  type CollabSendChannel,
  type CollabTurnToolCallLike,
} from './collab-say.js'
export {
  buildCollabCommonRules,
  buildCollabWorkRules,
} from './collab-agent-rules.js'
export {
  COLLAB_CARD_SHORT_ID_CHARS,
  escapeCollabPromptText,
  formatCollabCardShortId,
  matchCollabInlineTagAt,
  parseCollabInlineSegments,
  renderCollabInlineTagsAsText,
  sanitizeCollabInlineMarkup,
  type CollabInlineCardSegment,
  type CollabInlineFileSegment,
  type CollabInlineSegment,
  type CollabInlineTagMatch,
  type CollabInlineTagName,
  type CollabInlineTextSegment,
} from './collab-inline-tags.js'
export {
  COLLAB_TURN_MAX_SAY_CALLS,
  COLLAB_TURN_MAX_TOOL_CALLS,
  createCollabTurnCircuitBreaker,
  formatCollabTurnBreakerNote,
  resolveCollabTurnBreakerLimits,
  type CollabTurnBreakerLimits,
  type CollabTurnBreakerSignal,
  type CollabTurnBreakerTrip,
  type CollabTurnCircuitBreaker,
} from './collab-circuit-breaker.js'
export {
  createCollabTypingTracker,
  type CollabTypingSignal,
  type CollabTypingTrackerOptions,
} from './collab-typing.js'
export {
  COLLAB_REACTION_EMOJIS,
  COLLAB_REACTION_SUMMARY_MAX_ENTRIES,
  addCollabReaction,
  appendCollabReactionSummary,
  applyCollabReaction,
  formatCollabReactionSummary,
  hasCollabReactionFrom,
  isSameCollabReactionActor,
  normalizeCollabReactionEmoji,
  tallyCollabReactions,
  toggleCollabReaction,
  type ApplyCollabReactionOptions,
  type CollabReactionActorLike,
  type CollabReactionEmoji,
  type CollabReactionLike,
  type CollabReactionTally,
} from './collab-reactions.js'
export {
  applyCollabBoardAction,
  emptyCollabBoard,
  renderCollabAgentRef,
  renderCollabBoardDigest,
  COLLAB_BLOCK_REASON_MAX_CHARS,
  COLLAB_BOARD_START_RECEIPT_NOTE,
  COLLAB_MAX_HALTS,
  COLLAB_MAX_REJECTIONS,
  COLLAB_REPORT_SUMMARY_MAX_CHARS,
  COLLAB_TASK_STATUSES,
  type ApplyCollabBoardActionResult,
  type CollabBoard,
  type CollabBoardAction,
  type CollabBoardActor,
  type CollabBoardEvent,
  type CollabBoardSelf,
  type CollabTask,
  type CollabTaskEvidence,
  type CollabTaskStatus,
} from './collab-board.js'
export {
  buildCollabMentions,
  COLLAB_MENTION_ALL_LABELS,
  expandCollabAllMentions,
  mergeCollabMentions,
  normalizeCollabMentions,
  parseCollabMentions,
  renderCollabMentionText,
  resolveCollabMentionIds,
  type CollabMentionHit,
  type CollabMentionRenderOptions,
} from './collab-mentions.js'
/** 身份的模型面投影 —— `@名字#句柄`(docs/design/collab-agent-handle.md)。
 *  出站拼、入站剥,UI 与转录里永远看不到句柄。 */
export {
  COLLAB_AGENT_HANDLE_CHARS,
  collabAgentHandle,
  collabAgentIdKey,
  formatCollabAgentHandle,
  parseCollabHandleMentions,
  renderCollabModelMention,
  resolveCollabAgentHandle,
  splitCollabHandleQuery,
  stripCollabAgentHandles,
  type CollabAddressable,
  type CollabHandleQuery,
  type CollabHandleResolution,
} from './collab-handles.js'
/** 身份目录:句柄编解码的共用真源(collab-handle-codec.md §2.1)。
 *  识别归它,授权仍归成员名单 —— 两者不再共用一个数组。 */
export {
  COLLAB_USER_CONSTANT_WORDS,
  collabIdentitiesFromAgents,
  collabIdentityAnswersTo,
  collabIdentityFromAgent,
  collabUserIdentity,
  type CollabIdentity,
} from './collab-identity.js'
export {
  COLLAB_REPLY_EXCERPT_MAX_CHARS,
  COLLAB_REPLY_UNKNOWN_AUTHOR_LABEL,
  COLLAB_REPLY_USER_LABEL,
  buildCollabReplyToSnapshot,
  condenseCollabReplyExcerpt,
  countCollabVisibleMessagesBetween,
  isCollabVisibleRoomMessage,
  shouldAttachCollabReplyTo,
  type BuildCollabReplyToSnapshotOptions,
  type CollabReplyGapOptions,
} from './collab-reply-quote.js'
export {
  COLLAB_ADOPTED_ECHO_TAG,
  COLLAB_CHATROOM_TAG,
  COLLAB_ENVELOPE_TAG,
  COLLAB_NOTIFICATION_TAG,
  buildCollabChatRoomPayload,
  buildCollabDriveRoomContext,
  formatCollabAdoptedEcho,
  formatCollabFlattenedToolCall,
  formatCollabFoldedLine,
  formatCollabNotificationBlock,
  formatCollabReplyQuote,
  formatCollabUserLabel,
  wrapCollabMessageEnvelope,
  projectRoomHistory,
  type BuildCollabChatRoomPayloadOptions,
  type ProjectedRoomMessage,
  type ProjectRoomHistoryOptions,
} from './collab-projection.js'
export {
  COLLAB_DIGEST_MAX_CHARS,
  buildCollabDigestPrompt,
  formatCollabDigestLines,
  parseCollabDigestReply,
  type CollabDayDigest,
} from './collab-digest.js'
export {
  COLLAB_DEFAULT_HISTORY_DAYS,
  COLLAB_DEFAULT_HISTORY_TAIL,
  COLLAB_DEFAULT_UNREAD_MAX,
  collabFoldCutTimestamp,
  collectCollabFoldedFacts,
  createCollabFoldedAccumulator,
  planCollabHistoryWindow,
  resolveCollabUnreadRelation,
  type CollabFoldedSummary,
  type CollabHistoryWindow,
  type CollabHistoryWindowOptions,
  type CollabUnreadRelation,
} from './collab-history-window.js'
export {
  COLLAB_ELSEWHERE_MAX_CALLS,
  COLLAB_ELSEWHERE_MAX_EVENTS,
  COLLAB_ELSEWHERE_TAG,
  buildCollabElsewhere,
  type BuildCollabElsewhereOptions,
  type CollabElsewhereSource,
  type CollabTurnLogMessageLike,
  type CollabTurnLogToolCall,
} from './collab-turn-log.js'
export {
  collabChainGateAllows,
  decideCollabActivations,
  formatCollabActivationLabel,
  resolveCollabChainCap,
  COLLAB_ACTIVATION_LABELS,
  COLLAB_DRIVE_LABEL_TASK_ASSIGNED,
  COLLAB_DRIVE_LABEL_TASK_HALTED,
  COLLAB_DRIVE_LABEL_TASK_REVIEW,
  type CollabActivationReason,
  type CollabActivationRequest,
  type DecideCollabActivationsOptions,
  type DecideCollabActivationsResult,
} from './collab-activation.js'
export {
  COLLAB_USER_DEFAULT_HANDLE,
  COLLAB_USER_DEFAULT_LABEL,
  COLLAB_USER_HANDLE_MAX_CHARS,
  normalizeCollabUserHandle,
} from './collab-user-handle.js'
export {
  buildCollabRoomContext,
  buildCollabRoomSystemPrompt,
  buildCollabWorkContext,
  resolveCollabSpeakerLabel,
  type BuildCollabRoomContextOptions,
  type BuildCollabRoomSystemPromptOptions,
  type BuildCollabWorkContextOptions,
} from './collab-roster.js'
export {
  buildCollabChainHoldLine,
  buildCollabMemberJoinedLine,
  buildCollabMemberRemovedLine,
  buildCollabMembershipLines,
  buildCollabPmAssignedLine,
  buildCollabPmClearedLine,
  buildCollabSilentDeliveryLine,
  buildCollabTaskAssignedLine,
  buildCollabTaskDeliveredLine,
  buildCollabTaskDoneLine,
  buildCollabTaskHaltCapLine,
  buildCollabTaskHaltedLine,
  buildCollabTaskInterruptedLine,
  buildCollabTaskRequeueRefusedLine,
  excerptCollabHaltReason,
  formatCollabProjectedSystemLine,
  formatCollabTaskEvidence,
  isCollabProjectedSystemLine,
  type CollabMembershipChangeOptions,
  COLLAB_HALT_REASON_EXCERPT_CHARS,
  COLLAB_NO_EVIDENCE_TEXT,
  COLLAB_SILENT_SUMMARY_EXCERPT_CHARS,
  COLLAB_PROJECTED_SYSTEM_SOURCES,
  COLLAB_SYSTEM_SOURCE_MEMBERSHIP,
  COLLAB_SYSTEM_SOURCE_TASK,
  COLLAB_SYSTEM_SPEAKER_LABEL,
  COLLAB_TASK_HALTED_DISPOSITION,
} from './collab-system-lines.js'
export {
  filterCollabSelfElectCandidates,
  isCollabConversationMessage,
  isCollabProjectedRoomMessage,
  selectRecentCollabConversationMessages,
  selectRecentCollabProjectedMessages,
  COLLAB_SELF_ELECT_COOLDOWN,
} from './collab-cooldown.js'
export {
  isCollabStopMessage,
  routeCollabRoomWake,
  COLLAB_STOP_WORDS,
  type CollabLiveTurnLike,
  type CollabWakeRoute,
  type RouteCollabRoomWakeOptions,
} from './collab-wake.js'
export {
  buildWillingnessPrompt,
  buildWillingnessWindow,
  parseWillingnessReply,
  COLLAB_WILLINGNESS_LINE_LIMIT,
  COLLAB_WILLINGNESS_PM_FACT,
  COLLAB_WILLINGNESS_QUESTION,
  COLLAB_WILLINGNESS_RECENT_LIMIT,
  type BuildWillingnessPromptOptions,
  type CollabWillingnessPrompt,
  type CollabWillingnessOutcomeKind,
  type CollabWillingnessVerdict,
} from './collab-willingness.js'
// 场子类型与判据(`resolveCollabVenue` / `collabVenueLinksRoom` / `CollabVenue`)、私聊房判据、历史可见窗口
// 越层清零 A2 起住在 session 入口,这里不再转交。
export {
  COLLAB_NOTEBOOK_TOOLS,
  COLLAB_ROOM_TOOLS,
  COLLAB_WORK_REQUIRED_TOOLS,
  COLLAB_TOOL_VENUES,
  isCollabToolAllowedInVenue,
  type CollabVenueTool,
} from './tools/collab-tool-surface.js'
export {
  COLLAB_PLAN_MAX_WAVES,
  COLLAB_PLAN_MAX_WAVE_SIZE,
  COLLAB_PLAN_BACKDROP,
  COLLAB_PLAN_HISTORY_BUDGET,
  COLLAB_PLAN_SILENT,
  COLLAB_PLAN_SYSTEM,
  advanceCollabPlan,
  buildCollabPlanPrompt,
  buildCollabPlanStateLines,
  buildCollabPlanWindow,
  normalizeCollabPlan,
  parseCollabPlanReply,
  type BuildCollabPlanPromptOptions,
  type CollabPlan,
  type CollabPlanAdvance,
  type CollabPlanMemberState,
  type CollabPlanPrompt,
  type NormalizeCollabPlanOptions,
} from './collab-plan.js'
export {
  buildCollabRelayRing,
  collabRelayLoopsFor,
  isCollabForcedSerialRoom,
  isCollabPlanRoom,
  pickCollabRelayStarter,
  synthesizeCollabSerialPlan,
  type CollabRelayRoomLike,
} from './collab-speaking-order.js'
export {
  collabMessageCountsTowardChain,
  collabMessageResetsChain,
  computeCollabChainCount,
} from './collab-chain.js'
/*
 * 协作的四只工具(越层清零 A1,2026-10-04 从 toolkit 搬回协作):工具本身、它们的家族基类、适配器,
 * 以及装配时把它们登记进工具目录的那一句 `registerCollabTools(catalog, tier)`。
 */
export {
  COLLAB_HOST_INJECTABLE_TOOLS,
  COLLAB_TOOLS_BY_TIER,
  registerCollabTools,
  type CollabToolTier,
} from './tools/collab-tool-registration.js'
export { registerCollabAgentToolGrants } from './tools/collab-agent-tool-grants.js'
export { collabAgentPresenceFacts, registerCollabAgentPresence } from './collab-variable-presence.js'
export { CollabTool, collabActorAgentId, sceneVenue } from './tools/collab-tool-family.js'
export type { CollabScope, CollabToolAdapters } from './tools/collab-tool-family.js'
export {
  boardAdapters,
  collabAdapters,
  historyAdapters,
  notebookAdapters,
  sendMessageAdapters,
} from './tools/collab-tool-adapters.js'
export {
  BOARD_DESCRIPTION,
  BoardInputSchema,
  BoardTool,
  createBoardTool,
} from './tools/collab-tool-board.js'
export type { BoardInput, BoardToolAdapters, BoardToolContext } from './tools/collab-tool-board.js'
export {
  createHistoryTool,
  HISTORY_DESCRIPTION,
  HISTORY_MAX_LIMIT,
  HistoryInputSchema,
  HistoryTool,
} from './tools/collab-tool-history.js'
export type { HistoryEntry, HistoryInput, HistoryToolAdapters, HistoryToolResult } from './tools/collab-tool-history.js'
export {
  createNotebookTool,
  NOTEBOOK_DESCRIPTION,
  NOTEBOOK_NOTE_MAX_CHARS,
  NotebookInputSchema,
  NotebookTool,
} from './tools/collab-tool-notebook.js'
export type { NotebookInput, NotebookToolAdapters, NotebookToolResult } from './tools/collab-tool-notebook.js'
export {
  createSendMessageTool,
  SEND_MESSAGE_DESCRIPTION,
  SendMessageInputSchema,
  SendMessageTool,
} from './tools/collab-tool-send-message.js'
export type {
  CollabDmSendResult,
  SayToolResult,
  SendMessageInput,
  SendMessageToolAdapters,
} from './tools/collab-tool-send-message.js'
export { collabToolAllowedInSession } from './tools/collab-tool-surface.js'
