/**
 * 协作房间里的「权限请求等太久了」提醒(D202)。
 *
 * 协作回合的审批不自动拒(房里有人在看),但 30 分钟没人答就往房间里写一行系统消息。从前是授权层
 * (`permission/permission-enforcement.ts`)在计时器里动态 import 本功能的房间配置去写这一行 —— 低层够高层,
 * 动态 import 只是把越层藏了起来。现在授权层只发一条全局事实 `permission:ask-stale`,本文件的监听器
 * 查房、写那一句话,措辞与从前逐字相同。
 *
 * 装配(`backend.ts`)在引擎之后**无条件**装一次并 `own()` 退订:今天任何宿主只要有会话就有这条提醒,
 * 不看 `collab` 选项 —— 与从前一致(从前那段代码也不看)。
 */
import type { EventBus } from '@onething/backend/event'
import * as store from '@onething/backend/session'
import { getLogger } from '@onething/backend/logging'
import { postCollabSystemLine } from './collab-room-config.js'

const log = getLogger('collab.permission-reminder')

/** 装上监听器,返回退订函数。 */
export function installPermissionStaleReminder(eventBus: Pick<EventBus, 'onGlobal'>): () => void {
  return eventBus.onGlobal('permission:ask-stale', envelope => {
    const { sessionId, title } = envelope.event
    try {
      const session = store.getSession(sessionId) as
        | { id: string; kind?: string; collab?: { roomSessionId?: string } }
        | undefined
      const roomSessionId = session?.kind === 'room' ? session.id : session?.collab?.roomSessionId
      if (!roomSessionId) return
      postCollabSystemLine(
        roomSessionId,
        `有一个权限请求已等待 30 分钟未处理:${title}(从看板任务卡打开工作会话审批)`,
      )
    } catch (error) {
      log.error('collab permission reminder failed', { sessionId }, error)
    }
  })
}
