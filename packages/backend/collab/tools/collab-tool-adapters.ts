/**
 * 协作四只工具的适配器(越层清零 A1,2026-10-04 从 `toolkit/toolkit-adapters.ts` 的「协作」一段逐字搬来)。
 *
 * 与 toolkit 那份适配器同一条纪律:这里只 import 适配函数与 store,一只工具对象都不 import。
 * 场子门与 actor 解析被 `CollabTool` 收成了一处(见 `collab-tool-family.ts` 的头注释),所以这里多出
 * 两个通用口(`sessionKind` / `sessionAgentId`),而 board 的适配器只答「这条会话挂着哪间房」。
 */

import * as store from '@onething/backend/session'
import {
  collabLinkedRoomSessionId,
  fixedExecutionContext,
  sessionAccess,
  SessionAccessError,
} from '@onething/backend/session'
import { findAgent } from '@onething/backend/agent'
import { resolveCollabAgentHandle } from '../collab-handles.js'
import type { CollabBoardAction } from '../collab-board.js'
import { collabRoomMembers } from '../collab-members.js'
import { applyBoardAction } from '../collab-board-store.js'
import { searchCollabHistory } from '../collab-history-tool.js'
import { speakIntoCollabRoom } from '../collab-say-tool.js'
// R4b:落盘口不再在这里重建一份 —— 与旧 `app/collab/actors/notebook-tool.ts` 的
// `appendNote` 曾经"逐字相同"的那份代码,现在直接用原处那一个(它已导出)。
import { appendNote } from '../actors/collab-actors-notebook-tool.js'
import type { CollabToolAdapters } from './collab-tool-family.js'
import type { SendMessageToolAdapters } from './collab-tool-send-message.js'
import type { BoardToolAdapters } from './collab-tool-board.js'
import type { HistoryToolAdapters } from './collab-tool-history.js'
import type { NotebookToolAdapters } from './collab-tool-notebook.js'

// ── 协作 ────────────────────────────────────────────────────────────────────

interface CollabSessionLike {
  kind?: string | null
  agentId?: string
  collab?: { roomSessionId?: string } | null
}

/**
 * 场子门与身份回退的两个通用口。四个协作工具共用同一份 —— 旧路那四份手写的
 * `session.agentId` 反查(say / board / history / notebook 各一)在这里收成一处。
 */
export function collabAdapters(): CollabToolAdapters {
  return {
    sessionKind: sessionId => (store.getSession(sessionId) as CollabSessionLike | undefined)?.kind ?? undefined,
    sessionAgentId: sessionId => (store.getSession(sessionId) as CollabSessionLike | undefined)?.agentId,
  }
}

export function sendMessageAdapters(): SendMessageToolAdapters {
  return {
    ...collabAdapters(),
    speak: (input, executionContext) => speakIntoCollabRoom(input, { executionContext }),
    /**
     * `sendDm` 走**动态 import**:模块图上 `dm-tool → say-tool` 这条边早就存在
     * (私聊落库就是 say 的执行器),反向再加一条静态边就是一个环。
     */
    async sendDm(input, executionContext) {
      const { sendCollabDm } = await import('../collab-dm-tool.js')
      return sendCollabDm({
        sessionId: input.sessionId,
        to: input.to,
        message: input.content,
        ...(input.wake ? { wake: true } : {}),
        ...(input.wakeRoom ? { wakeRoom: input.wakeRoom } : {}),
      }, { executionContext })
    },
  }
}

function agentName(agentId: string): string {
  const agent = findAgent(agentId)
  return agent ? agent.name : agentId
}

export function boardAdapters(): BoardToolAdapters {
  return {
    ...collabAdapters(),
    resolveLinkedRoom: (sessionId, executionContext) => {
      sessionAccess.resolve(fixedExecutionContext(executionContext), sessionId, 'read')
      return collabLinkedRoomSessionId(store.getSession(sessionId) as CollabSessionLike | undefined)
    },
    /**
     * 指派给谁。走统一解析器而不是自己遍历:名字、句柄、`名字#句柄`、全 id 四种
     * 写法一视同仁,而**重名**是明确拒绝,不是"遍历撞上的第一个"。
     */
    resolveMember(roomSessionId, nameOrId, executionContext) {
      sessionAccess.resolve(fixedExecutionContext(executionContext), roomSessionId, 'read')
      const room = store.getSession(roomSessionId)?.room
      if (!room) return null
      // 纯文本解析:头像与职责说明都进不了判据,所以两样都不取。
      const members = collabRoomMembers(room.memberAgentIds, { withAvatar: false })
      const resolved = resolveCollabAgentHandle(nameOrId, members)
      return resolved.ok ? resolved.agentId : null
    },
    agentName,
    applyAction: (roomSessionId, action: CollabBoardAction, actor, options) => {
      if (!options?.sourceSessionId) throw new SessionAccessError()
      const executionContext = fixedExecutionContext(options.executionContext)
      const authorize = () => sessionAccess.resolveAll(executionContext,
        [options.sourceSessionId, roomSessionId], action.action === 'list' ? 'read' : 'write')
      authorize()
      return applyBoardAction(roomSessionId, action, actor, { beforeReadOrWrite: authorize })
    },
  }
}

export function historyAdapters(): HistoryToolAdapters {
  return { ...collabAdapters(), search: (input, executionContext) => searchCollabHistory(input, { executionContext }) }
}

export function notebookAdapters(): NotebookToolAdapters {
  return { ...collabAdapters(), append: (input, executionContext) => appendNote(input, { executionContext }) }
}
