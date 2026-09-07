/**
 * R3a —— 新树的适配器工厂(§6 的 `app/toolkit/`)。
 *
 * 每一个工厂的内容与旧 `app/tools/builtin/*.ts` / `app/collab/*-tool.ts` 里那几行
 * **逐字相同**:同一个 `getGoal`、同一个 `dispatchTask`、同一个
 * `speakIntoCollabRoom`、同一个 `createRequiredAppFetch({ policy: 'webSearch' })`。
 * 这里只 import 那些**适配函数与 store**,一个旧 Tool 对象都不 import —— 新树的
 * 目录不该经过旧树。
 *
 * 唯一的结构差别在协作那一族:场子门与 actor 解析被 `CollabTool` 收成了一处
 * (见 `runtime/toolkit/families/collab.ts` 的头注释),所以这里多出两个通用口
 * (`sessionKind` / `sessionAgentId`),而 board 的适配器少了 `resolveContext`
 * 那一半 —— 它现在只答"这条会话挂着哪间房"。
 */

import {
  createBraveSearchProvider,
  type SearchProvider,
} from '@onething/runtime/tools'
import { remainingGoalTokens } from '@onething/runtime/goals'
import {
  resolveCollabAgentHandle,
  type CollabBoardAction,
} from '@onething/runtime/collab'
import type {
  AskUserToolAdapters,
  BoardToolAdapters,
  CollabToolAdapters,
  GoalToolAdapters,
  HistoryToolAdapters,
  NotebookToolAdapters,
  PracticeToolAdapters,
  RadioToolAdapters,
  SendMessageToolAdapters,
  TaskToolPorts,
  WebOpenToolAdapters,
  WebSearchToolAdapters,
} from '@onething/runtime/toolkit'

import * as store from '../../store.js'
import { getSettings } from '../../stores/settings.js'
import { createRequiredAppFetch } from '../../provider-binding/bound-fetch.js'
import { getGoal, goalLimits, updateGoalFromModel } from '../goals/index.js'
import { getPracticeServiceSafe, PracticeServiceClosedError } from '@onething/runtime/practice/service.wiring'
import { getCurrentBackendInstance } from '../../current.js'
import { assertMusicOperator } from '../music/access.js'
import { dispatchTask } from '../tasks/dispatch.js'
import { Interaction } from '@onething/core/interaction'
import { NO_HUMAN_DECLINE_REASON, noHumanInTheRoom } from '../interaction/no-human.js'
import { findAgent } from '../agents/index.js'
import { collabRoomMembers } from '../collab/members.js'
import { applyBoardAction } from '../collab/board-store.js'
import { searchCollabHistory } from '../collab/history-tool.js'
import { speakIntoCollabRoom } from '../collab/say-tool.js'
import { collabLinkedRoomSessionId } from '../collab/venue.js'
// R4b:落盘口不再在这里重建一份 —— 与旧 `app/collab/actors/notebook-tool.ts` 的
// `appendNote` 曾经"逐字相同"的那份代码,现在直接用原处那一个(它已导出)。
import { appendNote } from '../collab/actors/notebook-tool.js'
import { sessionAccess, SessionAccessError } from '../../session/access.js'
import { fixedExecutionContext } from '../engine/execution-context.js'
import type { BraveSearchProviderAdapters } from '@onething/runtime/tools/builtin/web-search/providers/brave'

// ── 网络 ────────────────────────────────────────────────────────────────────

const createWebSearchFetch = () => createRequiredAppFetch({ policy: 'webSearch' })

export function webSearchAdapters(): WebSearchToolAdapters {
  const braveSearchProviderAdapters: BraveSearchProviderAdapters = {
    getApiKey: () => getSettings().tools?.webSearch?.braveApiKey,
    getFetch: createWebSearchFetch,
  };
  const providers: Record<string, SearchProvider> = {
    brave: createBraveSearchProvider(braveSearchProviderAdapters),
  }
  return { providers, getFetch: createWebSearchFetch }
}

export function webOpenAdapters(): WebOpenToolAdapters {
  return { getFetch: createWebSearchFetch }
}

// ── 会话面 ──────────────────────────────────────────────────────────────────

export function goalAdapters(): GoalToolAdapters {
  return {
    getGoal,
    updateGoalFromModel,
    remainingTokens: goal => remainingGoalTokens(goal, goalLimits()),
  }
}

export function taskPorts(): TaskToolPorts {
  return { dispatch: (request, executionContext) => dispatchTask(request, { executionContext }) }
}

// ── 交互 ────────────────────────────────────────────────────────────────────

export function askUserAdapters(): AskUserToolAdapters {
  return {
    ask: async input => {
      // pair 房里没有人类。当场 declined 并把「这里没人能回答你」写给模型,
      // 而不是让它在一间空房里等到 deadline。
      if (noHumanInTheRoom(input.sessionId)) {
        return { id: '', answers: {}, outcome: 'declined', reason: NO_HUMAN_DECLINE_REASON }
      }
      return Interaction.ask({
        sessionId: input.sessionId,
        origin: 'host-tool',
        questions: input.questions,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
        timeoutMs: input.timeoutMs,
      })
    },
    abort: input => {
      Interaction.abort({
        sessionId: input.sessionId,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        reason: input.reason,
      })
    },
  }
}

// ── 生活面 ──────────────────────────────────────────────────────────────────

export function practiceAdapters(): PracticeToolAdapters {
  const captured = getPracticeServiceSafe()
  const service = () => {
    if (!captured) throw new PracticeServiceClosedError()
    return captured
  }
  return {
    log: input => service().logPractice({
      name: input.name,
      source: 'agent',
      note: input.note,
      exercise: input.exercise ?? {},
      ts: input.ts,
    }),
    query: request => service().getPracticeSummary(request),
    recent: (days, limit) => service().getRecentPracticeRecords(days, limit),
  }
}

export function radioAdapters(): RadioToolAdapters {
  const captured = getCurrentBackendInstance()?.music.radio
  const radio = () => {
    if (!captured) throw new Error('Music service is unavailable')
    return captured
  }
  return {
    open: (intent, options, executionContext) => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return radio().radioToolOpen(intent, options)
    },
    close: executionContext => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return radio().radioToolClose()
    },
    status: executionContext => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return radio().radioToolStatus()
    },
    request: (song, executionContext) => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return radio().requestSong(song)
    },
  }
}

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
      const { sendCollabDm } = await import('../collab/dm-tool.js')
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
