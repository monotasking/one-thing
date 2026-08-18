import { ensureStoreDirs } from './paths.js'
import { initializeSessionRepositoryIndex } from './sessions.js'

// Re-export all store modules
export { ensureStoreDirs, getStorePath } from './paths.js'
export { getSettings, saveSettings } from './settings.js'
export { getCurrentSessionId, setCurrentSessionId } from './app-state.js'
export {
  getSessions,
  getSession,
  createSession,
  createSessionWithoutFocus,
  createBranchSession,
  deleteSession,
  onSessionsDeleted,
  renameSession,
  addMessage,
  insertMessageAfter,
  deleteMessage,
  deleteMessageAndTruncate,
  clearSessionMessages,
  updateMessageAndTruncate,
  updateMessageContent,
  updateMessageReasoning,
  updateMessageStreaming,
  updateMessageUsage,
  updateMessageToolCalls,
  updateMessageContentParts,
  addMessageContentPart,
  updateMessageThinkingTime,
  updateMessageSkill,
  updateMessageError,
  updateMessageMentions,
  updateMessageReactions,
  updateMessageReplyTo,
  updateMessageTurnContext,
  addMessageStep,
  updateMessageStep,
  updateMessageSteps,
  updateStepsUsageByTurn,
  updateSessionSummary,
  updateSessionPin,
  updateSessionArchived,
  updateSessionModel,
  updateSessionAgent,
  updateSessionCollab,
  updateSessionTask,
  updateSessionPermissionMode,
  updateSessionWorkingDirectory,
  updateSessionWorkingDirectoryRoots,
  updateSessionVariables,
  updateSessionGoal,
  updateSessionGoals,
  inheritSessionWorkingDirectory,
  updateSessionTokenUsage,
  updateSessionContextSize,
  updateSessionPromptContext,
  getSessionTokenUsage,
  deriveRetainedContextSize,
  // Optimized session loading (Phase 4: Metadata Separation)
  getSessionsList,
  getSessionDetails,
  getSessionMessages,
  getSessionMessagesPage,
  getSessionUserMessageMarkers,
  initializeSessionRepositoryIndex,
  flushSessionSave,
  flushAllPendingSaves,
  saveSessionSnapshot,
  invalidateSessionCache,
  getSessionCacheStats,
} from './sessions.js'

// Ensure all necessary directories exist on startup
export function initializeStores(): void {
  ensureStoreDirs()
  initializeSessionRepositoryIndex()
}
