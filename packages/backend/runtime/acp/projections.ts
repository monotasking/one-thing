/**
 * ACP 会话状态投影的**装配**(A2-b):把两只投影接到这台后端的真依赖上,交给 `AcpSubsystem`。
 *
 *  - 计划 → 待办:`getTodoPlanStore()`(晚取;store 跟着装配走)。
 *  - 标题 → 会话名:读 `store.getSession`,写 `store.renameSession(id, title, 'auto')` + 一条
 *    `session:renamed`(与引擎自动起题那一发同形)。
 *
 * 这里是唯一认识两只投影名字的地方;子系统只收一张表。
 */
import { SESSION_EVENT_TYPES } from '@shared/events/session-event-types'
import type { EventBus } from '@onething/backend/events/index.js'
import { getSession, renameSession } from '@onething/backend/stores/sessions.js'
import { getTodoPlanStore } from '@onething/backend/runtime/todo-plan/todo-plan-service'
import { AcpPlanProjection } from './plan-projection.js'
import type { AcpSessionStateProjection } from './subsystem.js'
import { AcpTitleProjection } from './title-projection.js'

export type AcpProjectionBus = Pick<EventBus, 'emit'>

export function createAcpSessionProjections(deps: { eventBus: AcpProjectionBus }): AcpSessionStateProjection[] {
  return [
    new AcpPlanProjection({ store: getTodoPlanStore }),
    new AcpTitleProjection({
      getSession: sessionId => getSession(sessionId),
      rename: async (sessionId, title) => {
        if (renameSession(sessionId, title, 'auto') === false) return
        await deps.eventBus.emit(sessionId, { type: SESSION_EVENT_TYPES.SESSION_RENAMED, name: title })
      },
    }),
  ]
}
