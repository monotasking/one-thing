/**
 * App wiring of `notebook`(docs/design/collab-actor-v3.md §1.2)。
 *
 * 分工与这个目录里其它 `*-tool.ts` 一致:契约、参数与文案是产品口径,住在
 * `tools/builtin/notebook.ts`;格式与预算是纯规则,住在
 * `collab/actors/notebook-rules.ts`;这里只做三件事 —— **认出我是谁、过场子门、
 * 落盘**。
 *
 * ## 「我是谁」从会话推,不从参数收
 *
 * 笔记是**私人**的,而工具参数是模型写的。让模型传 agentId,等于给了它一条写进
 * 别人笔记本的路;而这条路一旦被走通,受害者不会看到任何异常 —— 它只会在下一轮
 * 读到一句自己从没记过的话。所以身份只从会话自己身上推(`session.agentId`,
 * 执行会话与工作会话都在创建时写死了它)。
 *
 * **刻意不从会话 id 反解**:`agent-exec-<agentId>-<roomId>` 里两段都可能带连字符,
 * 反解是有歧义的 —— 而一个解错的 agentId 会安静地写进另一个人的本子。
 *
 * ## 场子门走那张一览表
 *
 * `notebook` 在 `COLLAB_TOOL_VENUES` 里是 `['agent', 'work']`。拒绝文案写在这里
 * 而不是门里:每个执行器那句话都要说出**下一步**,一句通用的「场子不对」会让
 * 模型不知道能做什么(与 board/history/send_message 同一条纪律)。
 */
import { COLLAB_NOTEBOOK_INJECT_MAX_CHARS } from '@onething/runtime/collab/actors'
import type { NotebookToolResult } from '@onething/runtime/toolkit'

import * as store from '../../store.js'
import { collabVenueOf } from '../venue.js'
import { createCollabNotebookFileStore, type CollabNotebookStore } from './notebook-store.js'

/** 场子不对时那句话。说出这个工具**在哪儿**能用,而不是它在这儿不能用。 */
export const COLLAB_NOTEBOOK_WRONG_VENUE =
  '笔记本只在群聊/私聊的回合与工作台会话里可用 —— 普通对话没有「别的房」,不需要跨房记忆。'

/** 认不出身份时那句话。 */
export const COLLAB_NOTEBOOK_NO_IDENTITY =
  '这条会话认不出是哪位同事的,笔记没有可归属的本子。'

const notebookStore: CollabNotebookStore = createCollabNotebookFileStore()

/** 笔记落盘口。R4b:`app/toolkit/adapters.ts` 从这里取,不再自己重建一份。 */
export function appendNote(input: { sessionId: string; note: string }): Promise<NotebookToolResult> {
  const session = store.getSession(input.sessionId)
  const venue = collabVenueOf(session)
  if (venue !== 'agent' && venue !== 'work') {
    return Promise.resolve({ ok: false, error: COLLAB_NOTEBOOK_WRONG_VENUE })
  }

  // 执行会话与工作会话都在创建时写死了 `agentId`(`ensureCollabAgentSession` /
  // 工作会话的建立点)。没有它 = 这条会话不属于任何一位同事,认不出比猜一个好。
  const agentId = session?.agentId?.trim()
  if (!agentId) return Promise.resolve({ ok: false, error: COLLAB_NOTEBOOK_NO_IDENTITY })

  const roomId = session?.collab?.roomSessionId
  const roomLabel = roomId ? store.getSession(roomId)?.name?.trim() : undefined
  const written = notebookStore.append({
    agentId,
    note: input.note,
    at: Date.now(),
    ...(roomLabel ? { roomLabel } : {}),
  })
  return Promise.resolve({
    ok: true,
    entry: written.entry,
    totalChars: written.totalChars,
    budgetChars: COLLAB_NOTEBOOK_INJECT_MAX_CHARS,
  })
}

