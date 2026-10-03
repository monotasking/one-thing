import { ensureOnethingStoreDirs } from '@onething/backend/runtime/storage'
import { initializeSessionRepositoryIndex } from '@onething/backend/runtime/sessions'

// Re-export all store modules
export { ensureOnethingStoreDirs, getOnethingStorePath } from '@onething/backend/runtime/storage'
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
  landSessionAccountUsageInStore as landSessionAccountUsage,
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
} from '@onething/backend/runtime/sessions'

// Ensure all necessary directories exist on startup
export function initializeStores(): void {
  ensureOnethingStoreDirs()
  initializeSessionRepositoryIndex()
}
