import type {
  ListRawSessionEventsResponse,
  ReadSessionBlobResponse,
} from '@shared/ipc/session-events'
import type { SessionCommandEmitResult } from '@shared/ipc/session-command'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { SessionStreamPayload } from '@shared/events/envelope'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import { sessionEventsRouter } from '@shared/ipc/session-events'
import { sessionCommandRouter } from '@shared/ipc/session-command'
import { expandFileTokens } from '@onething/runtime/prompts/prompt-references'

/**
 * 聊天数据源与 core 的客户端(`@onething/client`)之间的那一层**端口**(D3,路线 A)。
 *
 * 与 `sessions-port.ts` 逐条同判例:形状是**平台调用面的子集**,不是新契约,
 * 存在的唯一理由是可测 —— chat-source 的全部判据(增量折 / 缺号重折 / 活尾巴 /
 * 认领出站)都是纯逻辑,不该为了测它去起一台 core。
 *
 * 六个方法逐条对应:
 *  - `sessionEventsRouter` 的 `listRaw / readBlob`;
 *  - 推送面上的 `session:event` / `session:stream`(同一条 SSE,由客户端的
 *    事件枢纽按名分发 —— 从前这两条各开一条 EventSource);
 *  - `sessionCommandRouter` 的 `emit`;
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
  /**
   * 发一条纯文本用户消息。附件不在这一批 —— 端口上也就没有那个参数。
   *
   * ── 出站唯一的那道展开(D3 波二)──────────────────────────────────────
   * `@` 引用在草稿里是 `{{file:<绝对路径>}}`(chip 是呈现,token 才是位置),
   * **交出去之前**由 `expandFileTokens` 就地换回 `@<绝对路径>`。落点定在这一条
   * 而不是输入面板,理由是「单一出口」:壳里所有会变成一条用户消息的路
   * (发送键 / 回车 / ask 交卷 / 将来的草稿纸)最后都汇到这一口,
   * 在上游各展开一次必然漏掉其中一条。
   *
   * `retryMessage` 不涉:那条消息早已落账,重跑的是账本上的原文。
   */
  sendMessage(sessionId: string, content: string): Promise<SessionCommandEmitResult>
  /*
   * `/compact` **不在这条端口上**(D4 波二)。它骑的确实是同一条命令总线
   * (`command:compact-context`),但它不是「聊天这块屏幕的一个动作」——
   * 它是斜杠命令表里的一条,与 `/cd` `/new` 一起住在 `data/commands-port.ts`。
   * 判据是**谁按下它**,不是它最后落到哪条总线上:按发送键的那一下归这里,
   * 从命令表里派出去的那一下归那里。
   */
  /**
   * 中止这条会话正在跑的那一轮(`command:abort`)。
   *
   * 与 `sendMessage` 骑**同一条**命令总线,一个字段都不多给 —— 尤其没有
   * `reason`:契约上它是可选的自由文本,而壳这边没有第二种中止理由
   * (人按了停止,就是这一种)。填一句现造的话进账本,那是造事实。
   */
  abort(sessionId: string): Promise<SessionCommandEmitResult>
  /**
   * 重跑一条助手消息(`command:retry-message`)—— 消息动作行的「重试」。
   *
   * 与 `abort` 逐条同惯例:同一条命令总线,**一个字段都不多给**。契约上还有
   * `providerId` / `model` 两格覆盖(Vue 壳从"发送时的 provider 覆盖"里取),
   * 壳这边没有那个概念,填一个现造的值就是替引擎拍板 —— 缺席时引擎按会话
   * 自己的解析链走,那正是"照原样再跑一次"该有的语义。
   */
  retryMessage(sessionId: string, messageId: string): Promise<SessionCommandEmitResult>
}

let port: ChatPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureChatPort(next: ChatPort | undefined): void {
  port = next
}

/**
 * 真实现是**惰性**建的,理由与 sessions-port 逐字相同:它要的是那个连通之后
 * 才存在的客户端,而端口被换掉的测试根本不该把连通面拖进来。
 *
 * ── 命令**整条**交出去,不再过一道「摊平 mentions」 ──────────────────────
 * Vue 那侧的 `withPlainCommandMentions` 是为它自己的 composer 准备的:那里的
 * mention 是 Vue 的响应式 Proxy,不摊平过不了结构化克隆。这台壳的命令里
 * **根本没有 mentions 这一格**(见 `sendMessage` 的注:附件与 @ 都在正文里),
 * 所以那一道在这里是空转 —— 不搬。哪天壳长出 mentions,摊平的落点是**这里**。
 */
async function realPort(): Promise<ChatPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const sessionEventsApi = client.api(sessionEventsRouter)
  const sessionCommands = client.api(sessionCommandRouter)
  const { SESSION_COMMAND_TYPES } = await import('@shared/events/session-commands')
  return {
    ready: () => whenConnected(),
    listRaw: (sessionId) => sessionEventsApi.listRaw({ sessionId }),
    readBlob: (sessionId, hash) => sessionEventsApi.readBlob({ sessionId, hash }),
    onSessionEvent: (callback) => client.events.on(IPC_CHANNELS.SESSION_EVENT, callback),
    onSessionStream: (callback) => client.events.on(IPC_CHANNELS.SESSION_STREAM, callback),
    // 命令**整条透传**,一个字段都不多给:`channel` 缺席时引擎按会话自己的
    // 频道走(默认 'ipc'),渲染层替它拍这个板就是在两处定义同一件事。
    sendMessage: (sessionId, content) =>
      sessionCommands.emit({
        sessionId,
        // 出站唯一的那道展开:`{{file:…}}` → `@<路径>`(见接口上的注)。
        command: { type: SESSION_COMMAND_TYPES.SEND_MESSAGE, content: expandFileTokens(content) },
      }),
    abort: (sessionId) =>
      sessionCommands.emit({
        sessionId,
        command: { type: SESSION_COMMAND_TYPES.ABORT },
      }),
    retryMessage: (sessionId, messageId) =>
      sessionCommands.emit({
        sessionId,
        command: { type: SESSION_COMMAND_TYPES.RETRY_MESSAGE, messageId },
      }),
  }
}

let pending: Promise<ChatPort> | undefined

export function chatPort(): Promise<ChatPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
