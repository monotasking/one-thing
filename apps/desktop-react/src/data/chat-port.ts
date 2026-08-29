import type {
  ListRawSessionEventsResponse,
  ReadSessionBlobResponse,
} from '@shared/ipc/session-events'
import type { SessionCommandEmitResult } from '@shared/ipc/session-command'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { SessionStreamPayload } from '@renderer/platform/types'

/**
 * 聊天数据源与 `@renderer/platform` 之间的那一层**端口**(D3,路线 A)。
 *
 * 与 `sessions-port.ts` 逐条同判例:形状是**平台调用面的子集**,不是新契约,
 * 存在的唯一理由是可测 —— chat-source 的全部判据(增量折 / 缺号重折 / 活尾巴 /
 * 认领出站)都是纯逻辑,不该为了测它去起一台 core。
 *
 * 六个方法逐条对应:
 *  - `sessionEventsApi.listRaw / readBlob`(`@shared/ipc/session-events`);
 *  - `platformApi.onSessionEvent / onSessionStream`;
 *  - `sessionCommands.emit`(`@shared/ipc/session-command`);
 *  - `whenConnected()`(D0 的连通面)。
 *
 * ── 为什么是 `listRaw` 而不是 `list` ─────────────────────────────────────
 * `list` 在出口按**老七类**(轨迹面板的词汇)再筛一道,折叠器要的开张事件
 * (`run/start` / `assistant/chunks` / `message/patched` …)全在那七类之外 ——
 * 喂 `list` 折出来的是空树。这一条契约注释里写死了「投影消费者必须走这一条」。
 */
export interface ChatPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /** 会话事件账本的**全集原词汇**,按 seq 升序 —— 折叠器唯一的底。 */
  listRaw(sessionId: string): Promise<ListRawSessionEventsResponse>
  /** 账本里超 64KB 的正文只留 `BlobRef`,换回真身走这一条。 */
  readBlob(sessionId: string, hash: string): Promise<ReadSessionBlobResponse>
  /** 会话事件推送(账本活事件 `session:ledger-event` 骑在这条面上)。 */
  onSessionEvent(callback: (envelope: SessionEventEnvelope) => void): () => void
  /** 流分片推送(活尾巴的唯一进料口)。 */
  onSessionStream(callback: (payload: SessionStreamPayload) => void): () => void
  /** 发一条纯文本用户消息。@提及 / 附件不在 D3 —— 端口上也就没有那两个参数。 */
  sendMessage(sessionId: string, content: string): Promise<SessionCommandEmitResult>
}

let port: ChatPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureChatPort(next: ChatPort | undefined): void {
  port = next
}

/**
 * 真实现是**惰性**建的,理由与 sessions-port 逐字相同:`@renderer/platform`
 * 在模块顶层就会去摸 `window`,而端口被换掉的测试根本不该把它拖进来。
 */
async function realPort(): Promise<ChatPort> {
  const [{ platformApi }, { sessionEventsApi }, { sessionCommands }, { whenConnected }] =
    await Promise.all([
      import('@renderer/platform'),
      import('@renderer/platform/session-events-client'),
      import('@renderer/platform/session-command-client'),
      import('../platform/connection'),
    ])
  const { SESSION_COMMAND_TYPES } = await import('@shared/events/session-commands')
  return {
    ready: () => whenConnected(),
    listRaw: (sessionId) => sessionEventsApi.listRaw({ sessionId }),
    readBlob: (sessionId, hash) => sessionEventsApi.readBlob({ sessionId, hash }),
    onSessionEvent: (callback) => platformApi.onSessionEvent(callback),
    onSessionStream: (callback) => platformApi.onSessionStream(callback),
    // 命令**整条透传**,一个字段都不多给:`channel` 缺席时引擎按会话自己的
    // 频道走(默认 'ipc'),渲染层替它拍这个板就是在两处定义同一件事。
    sendMessage: (sessionId, content) =>
      sessionCommands.emit({
        sessionId,
        command: { type: SESSION_COMMAND_TYPES.SEND_MESSAGE, content },
      }),
  }
}

let pending: Promise<ChatPort> | undefined

export function chatPort(): Promise<ChatPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
