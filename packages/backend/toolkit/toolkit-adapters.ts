/**
 * R3a —— 新树的适配器工厂(§6 的 `app/toolkit/`)。
 *
 * 每一个工厂的内容与旧 `app/tools/builtin/*.ts` / `app/collab/*-tool.ts` 里那几行
 * **逐字相同**:同一个 `getGoal`、同一个 `dispatchTask`、同一个
 * `speakIntoCollabRoom`、同一个 `createRequiredAppFetch({ policy: 'webSearch' })`。
 * 这里只 import 那些**适配函数与 store**,一个旧 Tool 对象都不 import —— 新树的
 * 目录不该经过旧树。
 *
 * 协作那一族(send_message / board / history / notebook)的适配器不在这里:越层清零 A1
 * (2026-10-04)把四只协作工具连同它们的适配器搬回协作自己(`collab/tools/collab-tool-adapters.ts`),
 * 由 `registerCollabTools` 在装配时登记进目录 —— 工具目录不再认识协作。
 */

import {
  createBraveSearchProvider,
  type SearchProvider,
} from '@onething/backend/tool'
import { remainingGoalTokens } from '@onething/backend/goal'
import type { AskUserToolAdapters } from './builtin/toolkit-builtin-ask-user.js'
import type { GoalToolAdapters } from './builtin/toolkit-builtin-goal.js'
import type { PracticeToolAdapters } from './builtin/toolkit-builtin-practice.js'
import type { RadioToolAdapters } from './toolkit-radio-adapters.js'
import type { TaskToolPorts } from './builtin/toolkit-builtin-task.js'
import type { WebOpenToolAdapters } from './builtin/toolkit-builtin-web-open.js'
import type { WebSearchToolAdapters } from './builtin/toolkit-builtin-web-search.js'

import { createRequiredAppFetch, getSettings } from '@onething/backend/settings'
import { getGoal, goalLimits, updateGoalFromModel } from '@onething/backend/goal/goal-manager'
import { getPracticeServiceSafe, PracticeServiceClosedError } from '@onething/backend/practice/practice-service-slot'
import { getCurrentBackendInstance } from '@onething/backend/backend-current.js'
import { assertMusicOperator } from '@onething/backend/music/music-access'
import { dispatchTask } from '@onething/backend/task/task-dispatch'
import { Interaction } from '@onething/backend/interaction'
import { NO_HUMAN_DECLINE_REASON, noHumanInTheRoom } from '@onething/backend/interaction/interaction-no-human'
import { fixedExecutionContext } from '../session/session.js'
import type { BraveSearchProviderAdapters } from '@onething/backend/tool'

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
