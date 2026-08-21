import type {
  ChatMessage,
  ChatSession,
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
  SessionDetails,
  SessionMeta,
  TokenUsage,
  UserMessageMarker,
} from '@shared/ipc.js'
import type {
  CoreSessionRepository,
  TurnUsage,
} from '@onething/core/session'

export type { TurnUsage }
export type {
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
  UserMessageMarker,
}

export interface SessionRepository
  extends CoreSessionRepository<
    SessionMeta,
    SessionDetails,
    ChatSession,
    ChatMessage,
    TokenUsage,
    ChatMessage['contentParts']
  > {}
