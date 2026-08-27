import type {
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
} from '@shared/ipc.js'
import {
  getMessagesPageFromJsonFilePath,
} from '@onething/core/session/storage/json-message-page-file'
import { getOnethingSessionPath } from '@onething/runtime/storage'

export function getMessagesPageFromJsonFile(
  request: GetSessionMessagesPageRequest,
): GetSessionMessagesPageResponse | null {
  const sessionPath = getOnethingSessionPath(request.sessionId)
  return getMessagesPageFromJsonFilePath(request, sessionPath) as GetSessionMessagesPageResponse | null
}
