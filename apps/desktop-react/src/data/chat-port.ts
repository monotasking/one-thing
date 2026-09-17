import type {
  ListRawSessionEventsResponse,
  ReadSessionBlobResponse,
} from '@shared/ipc/session-events'
import type { SessionCommandEmitResult } from '@shared/ipc/session-command'
import type {
  PermissionGetPendingResponse,
  PermissionResponse,
} from '@shared/ipc/permissions'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { SessionStreamPayload } from '@shared/events/envelope'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import { sessionEventsRouter } from '@shared/ipc/session-events'
import { sessionCommandRouter } from '@shared/ipc/session-command'
import { permissionRouter } from '@shared/ipc/permissions'
import { resourcesRouter } from '@shared/ipc/resources'
import { materializePageReferences } from './page-references'
import { materializeFileAttachments } from './file-attachments'
import type { PageResultSlot, SessionTailPage } from './page-results'

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
  /**
   * **首屏那一页 + 账本水位**(工单 4 A 的 `session` 读法 `page`,工单 5 ③ 的
   * 冷载入口)。
   *
   * 与 `listRaw` 的关系是**取代,不是并列**:冷载从此拉这一条(24 条折好的
   * 消息 + 水位),不再把整份 55MB 账本搬进渲染进程再折一遍。`listRaw` 留下来
   * 只服务一种情形 —— 水位那一刻有一条**开着的 run**(`activeMessageId` 在场):
   * 它的 delta 在空状态上一条都折不下,那一次只能走整份。判据全文在
   * `chat-source.ts` 的 `loadPage`。
   *
   * 经 `resources.read` 一条路,**不加具名 RPC 方法** —— 资源管线已在 RPC 域上,
   * 再起一个 `sessions.getPage` 就是同一件事两个名字(工单 4 A 的原话)。
   */
  readPage(sessionId: string, query?: { limit?: number; before?: string }): Promise<SessionTailPage>
  /**
   * 一格**大结果**的正文(工单 5 ②)。页里超过内联预算的结果只带
   * `{bytes, hash, preview}`,人点开工具卡的那一刻按这条取。
   *
   * 读不到(会话没了 / 那一格结果不在)一律 `undefined` —— 调用方画那句
   * 「读不到」,而不是画一段空白的结果。
   */
  readToolResult(sessionId: string, toolCallId: string, slot: PageResultSlot): Promise<unknown>
  /** 会话事件账本的**全集原词汇**,按 seq 升序 —— 折叠器唯一的底。 */
  listRaw(sessionId: string): Promise<ListRawSessionEventsResponse>
  /** 账本里超 64KB 的正文只留 `BlobRef`,换回真身走这一条。 */
  readBlob(sessionId: string, hash: string): Promise<ReadSessionBlobResponse>
  /** 会话事件推送(账本活事件 `session:ledger-event` 骑在这条面上)。 */
  onSessionEvent(callback: (envelope: SessionEventEnvelope) => void): () => void
  /** 流分片推送(活尾巴的唯一进料口)。 */
  onSessionStream(callback: (payload: SessionStreamPayload) => void): () => void
  /** 推送连接恢复后重新核对账本;不等待下一条事件(结束事件可能已丢失)。 */
  onReconnect?(callback: () => void): () => void
  /**
   * 发一条用户消息。
   *
   * 页面引用在草稿里是一枚
   * `{{page:<tabId>}}`,与 `@` 文件引用逐字同一种占位法,所以它跟着正文一起
   * 到达这一口,由下面那一步物化成一件附件。调用方(输入面板 /
   * ask 交卷 / 将来的草稿纸)一个字都不必知道有「页面附件」这回事。
   *
   * ── 文件 token 的展开**不在这一口**(09-12 判例)────────────────────────
   * `@` 引用在这块屏幕上是 `{{file:<绝对路径>}}`(chip 是呈现,token 才是位置),
   * 而把它展成 `@<绝对路径>` 的那一句住在**输入面的草稿出口**
   * (`ComposerInput.readDraft`),不在这里。
   *
   * D3 波二把它放在这一口,理由是「单一出口」;真机上那个位置生出的是一条
   * **永不消失的重复气泡**:`chat-source` 在发送那一刻落的乐观 overlay 记的是
   * 草稿原文(token 句),而账本回来的是展开句,`reconcileOverlay` 的「正文逐字
   * 相同」于是永远认不上。判词一句话:**乐观上屏的那句话与账本上的那句话必须是
   * 同一串字节**,所以展开要发生在「这句话被记下来」之前 —— 也就是草稿的出口。
   *
   * 所以这一口今天**一个字都不改正文**,除了下面那一步页面引用。
   *
   * `retryMessage` 不涉:那条消息早已落账,重跑的是账本上的原文。
   *
   * ── 剩下的那一步:物化页面引用(B3-b) ────────────────────────────────
   * `materializePageReferences` 只在正文里真有 `{{page:` 时才发一次
   * `resources.read`。它仍然排在文件展开**之后**(今天是结构上的:上游那道展开
   * 早在草稿出口就做完了),这条先后是闸不是风格 —— 反过来等于让一段页面自控的
   * 正文被当成草稿再扫一遍,判词整段在 `data/page-references.ts` 上。
   *
   * ── 第二格:`messageId`(09-13)──────────────────────────────────────────
   * 调用方在发出去**之前**铸好这条消息将来在账本上的 id,随命令一起过去。
   * 它在这一口**透传**:这里不铸、不校验、不改写
   * (引擎自己判形与会话内唯一,不合格就当没给 —— 判词在
   * `CoreStreamEngine.resolveUserMessageId`)。
   *
   * 为什么不在这一口铸:铸的那一刻必须与「乐观气泡落进 overlay」是同一件事
   * (那一格就是拿它认领的),而那一步在 `chat-source.send` 里 —— 隔着一个
   * `await` 的端口铸出来的 id 到不了那一格。同一条判词的另一半写在上面那段
   * 「乐观上屏的那句话与账本上的那句话必须是同一串字节」旁边:今天认领不再
   * 比字节了,比的是这一格 id。
   */
  sendMessage(sessionId: string, content: string, messageId?: string, files?: readonly File[]): Promise<SessionCommandEmitResult>
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
  /**
   * 这条会话此刻**挂着的审批**(`permission.getPending`)。
   *
   * ── 为什么它在这条端口上 ─────────────────────────────────────────────────
   * 判据与 `/compact` 那一段逐字同源:**谁按下它**。权限卡长在工具卡里、答它的手
   * 就在聊天区那一屏,所以它归这里;账页(列/撤)是设置页的事,归
   * `data/permission-grants-port.ts`。
   *
   * ── 为什么需要它(活卡明明由事件送来)────────────────────────────────────
   * 活卡从 `permission:request` 拿,**重载之后从这一口拿**(a50d4f99 留账原话)。
   * 一次冷载 / 一次缺号重折都会让壳错过那条事件,而卡是「引擎在等一个人回答」的
   * 唯一出口 —— 少画一张卡,屏幕上就是一个永远停在「执行中」的工具与一台在等的
   * 引擎。所以它与 `listRaw` 一样是**对账口**:写就地更新,重拉对账。
   */
  listPendingPermissions(sessionId: string): Promise<PermissionGetPendingResponse>
  /**
   * 答一张权限卡(`command:permission-respond`)。
   *
   * 与 `abort` / `retryMessage` 逐条同惯例:同一条命令总线,**一个字段都不多给**。
   *  · 不带 `channel` —— 缺席时 http 面会 `采纳那次 ask 记下的 targetChannel`
   *    (仓根 CLAUDE.md「Chat Message Flow」那一段的原话),壳替它拍板就是在两处
   *    定义同一件事;
   *  · 不带 `requestId`,带 `toolCallId` —— 后者是契约上那格**耐久相关键**
   *    (`session-commands.ts` 的原话:应答方不必看见过那个易逝的 requestId),
   *    而卡的地址本来就是工具调用;
   *  · `decision: 'always'` **没有第五个字段**(a50d4f99 留账):scheme 由后端从
   *    那次 ask 上取,壳回传等于让发送方指定许可范围。
   */
  respondPermission(
    sessionId: string,
    toolCallId: string,
    decision: PermissionResponse,
  ): Promise<SessionCommandEmitResult>
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
  const permissionApi = client.api(permissionRouter)
  const resources = client.api(resourcesRouter)

  /** `session:<id>` 上的一条读法。结局是投影不是异常(`ResourceReadView` 四支)。 */
  async function readSession(sessionId: string, name: string, query?: Record<string, unknown>): Promise<unknown> {
    const view = await resources.read({
      ref: `session:${sessionId}`,
      name,
      ...(query ? { query } : {}),
    })
    if (view.kind === 'ok') return view.value
    // 三种「没读成」在这一层是同一件事:调用方拿不到那份数据。措辞照抄,
    // 不在这里发明一句 —— 与 chat-source 别处的失败路逐条同判。
    throw new Error(
      view.kind === 'failed' ? view.error.message : view.kind === 'denied' ? view.reason : view.message,
    )
  }
  const { SESSION_COMMAND_TYPES } = await import('@shared/events/session-commands')
  return {
    ready: () => whenConnected(),
    readPage: async (sessionId, query) =>
      await readSession(sessionId, 'page', query as Record<string, unknown> | undefined) as SessionTailPage,
    readToolResult: async (sessionId, toolCallId, slot) => {
      const answer = await readSession(sessionId, 'toolResult', { toolCallId, slot }) as
        { found?: boolean; value?: unknown } | undefined
      return answer?.found ? answer.value : undefined
    },
    listRaw: (sessionId) => sessionEventsApi.listRaw({ sessionId }),
    readBlob: (sessionId, hash) => sessionEventsApi.readBlob({ sessionId, hash }),
    onSessionEvent: (callback) => client.events.on(IPC_CHANNELS.SESSION_EVENT, callback),
    onSessionStream: (callback) => client.events.on(IPC_CHANNELS.SESSION_STREAM, callback),
    onReconnect: (callback) => {
      let interrupted = client.events.status() === 'reconnecting'
      return client.events.onStatusChange(status => {
        if (status === 'reconnecting') interrupted = true
        else if (interrupted && (status === 'connecting' || status === 'live')) {
          interrupted = false
          // connecting 在 HTTP 重连成功时就到达;新连接可以一直没有事件。
          callback()
        }
      })
    },
    // 命令**整条透传**,一个字段都不多给:`channel` 缺席时引擎按会话自己的
    // 频道走(默认 'ipc'),渲染层替它拍这个板就是在两处定义同一件事。
    sendMessage: async (sessionId, content, messageId, files) => {
      /*
       * 正文**原样过去**,只物化页面引用(见接口上的注)。文件 token 那道展开在
       * 输入面的草稿出口就做完了,这里不再扫第二遍 —— 也正因为这一口不展,
       * 一段页面自控的正文里写着 `{{file:/Users/…/.ssh/id_rsa}}` 在结构上就走私
       * 不进引擎的文件内联通道(2026-07-27 判例要的那个结果,今天由「壳里只有一处
       * 展开,而它在页面正文进入正文之前」保证)。
       *
       * 这一步**只有正文里真有 `{{page:` 时才发生**(那只函数第一句就是这道闸),
       * 所以绝大多数消息的出站路一发往返都不多。
       */
      const [{ text, attachments: pageAttachments }, fileAttachments] = await Promise.all([
        materializePageReferences(content),
        files?.length ? materializeFileAttachments(files) : Promise.resolve([]),
      ])
      const attachments = [...fileAttachments, ...pageAttachments]
      return sessionCommands.emit({
        sessionId,
        command: {
          type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
          content: text,
          // 没铸就**这一格根本不出现**(契约上它是可选的,缺席 = 引擎自己铸)。
          ...(messageId ? { messageId } : {}),
          // 没有文件或页面引用时**这一格根本不出现** —— 一个空数组与「没有附件」在
          // 账本上不是同一件事(契约上它是可选的)。
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      })
    },
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
    listPendingPermissions: (sessionId) => permissionApi.getPending({ sessionId }),
    respondPermission: (sessionId, toolCallId, decision) =>
      sessionCommands.emit({
        sessionId,
        command: { type: SESSION_COMMAND_TYPES.PERMISSION_RESPOND, toolCallId, decision },
      }),
  }
}

let pending: Promise<ChatPort> | undefined

export function chatPort(): Promise<ChatPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
