import { ensureOnethingStoreDirs } from '@onething/runtime/storage'
import { initializeSessionRepositoryIndex } from './sessions.js'

// Re-export all store modules
export { ensureOnethingStoreDirs, getOnethingStorePath } from '@onething/runtime/storage'
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
  landSessionAccountUsage,
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
  patchSessionFields,
  invalidateSessionCache,
  getSessionCacheStats,
} from './sessions.js'

// Ensure all necessary directories exist on startup
export function initializeStores(): void {
  ensureOnethingStoreDirs()
  initializeSessionRepositoryIndex()
}
