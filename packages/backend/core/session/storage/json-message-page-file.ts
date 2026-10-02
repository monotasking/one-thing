/**
 * legacy 整份 JSON 抄本的**按路径读**分页 —— §17.8 U1-a 把它从
 * `json-message-page.ts` 拆出来的那一格。
 *
 * 拆的理由只有一条:它是那个文件里**唯一**碰 `node:fs` 的东西(两行:
 * `existsSync` + `readFileSync`),而它所在的文件挂在 `session/storage/index.ts`
 * 的再导出面上、`session/index.ts` 那个桶再导出 storage —— 于是**整个桶**
 * 在浏览器里 import 不动。分页算法本身(`getMessagesPageFromJson`,吃的是
 * 一段 JSON 文本)是纯的,留在原处。
 *
 * 这一件**不进桶**:要按路径读盘的调用方走这条叶子路径(今天两处,
 * `runtime/sessions/session-repository.ts` 与 `backend/stores/session-repository/`)。
 */

import fs from 'node:fs'
import type {
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
  StoredChatMessage,
} from './types.js'
import { getMessagesPageFromJson } from './json-message-page.js'

export function getMessagesPageFromJsonFilePath<TMessage extends StoredChatMessage = StoredChatMessage>(
  request: GetSessionMessagesPageRequest,
  filePath: string,
): GetSessionMessagesPageResponse<TMessage> | null {
  if (!fs.existsSync(filePath)) return null
  const json = fs.readFileSync(filePath, 'utf-8')
  return getMessagesPageFromJson<TMessage>(request, json)
}
