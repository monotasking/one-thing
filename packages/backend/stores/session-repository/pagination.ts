import type {
  ChatMessage,
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
  SessionMessagePageCursor,
  UserMessageMarker,
} from '@shared/ipc.js'
import {
  decodeMessagePageCursor as decodeCoreMessagePageCursor,
  encodeMessagePageCursor as encodeCoreMessagePageCursor,
  getMessagesPageFromArray as getCoreMessagesPageFromArray,
  getUserMessageMarkersFromArray as getCoreUserMessageMarkersFromArray,
} from '@onething/core/session'

export function encodeMessagePageCursor(cursor: SessionMessagePageCursor): string {
  return encodeCoreMessagePageCursor(cursor)
}

export function decodeMessagePageCursor(cursor: string): SessionMessagePageCursor | null {
  return decodeCoreMessagePageCursor(cursor) as SessionMessagePageCursor | null
}

export function getMessagesPageFromArray(
  messages: ChatMessage[],
  request: GetSessionMessagesPageRequest,
): GetSessionMessagesPageResponse {
  return getCoreMessagesPageFromArray(messages, request) as GetSessionMessagesPageResponse
}

export function getUserMessageMarkersFromArray(messages: ChatMessage[]): UserMessageMarker[] {
  return getCoreUserMessageMarkersFromArray(messages) as UserMessageMarker[]
}
