/**
 * **命令面自己的事件产地**(F 线 F2,§16.2 的 F2 行 / §16.7 / §16.8 / §16.9)。
 *
 * F2 之前,一条命令留在账本上的那条事件是**派生物**:命令先让 core reducer 改内存
 * store,一个**翻译器**(`event-translator.ts`,F2-c 已整体删除)再从"刚刚改成了
 * 什么"反推一条事件补上。F2 把产地翻
 * 过来 —— 事件成为命令的**第一手表达**:命令面先在这里把事件构造出来并 append
 * (F1 保证 append 返回前活投影 / 活 surface 已经前进,§16.6),老 reducer 随后照常
 * 把同一条命令应用到 store,作为 F0 的**影子验证器**(§16.5)独立推导一遍。
 *
 * 所以这个文件与那个翻译器的差别不是"放在哪儿",是**谁先说话**:
 *
 * | | 产地 | 时序 |
 * |---|---|---|
 * | 翻转前(退役了的 `event-translator.ts`) | 从 store 的 mutation 反推 | reducer 之后 |
 * | 本文件 | 命令自己构造 | reducer **之前** |
 *
 * F2-a 翻转的三条:`appendMessage` / `deleteMessage` / `patchMessage`;
 * F2-b 再翻两条:`upsertMessage` / `truncateFrom`;F2-c 收尾两条:
 * `replaceAll` / `patchSession` —— **十三条命令的事件产地至此全在这里**,
 * `event-translator.ts` 随之整体退役(§16.9)。两个**非命令**采集点
 * (`session/created` / `session/compacted`)搬去了 `lifecycle-events.ts`:
 * 它们不是命令,谁先说话由它们各自的产地决定,名字得说实话。
 * **共用件只有一份**:两个产地各自演化出一份 `messageForEvent` 就是"同一条消息
 * 在两种事件里长得不一样"的温床。
 *
 * 纪律(与翻译器同源,§9.3 / §13.18):
 *
 * 1. **只写事实**。这条命令没改成任何东西(那条消息不在)就一条事件都不写 ——
 *    翻转之后"改没改成"由**命令面**在写事件之前自己问一次(它问的是与 reducer
 *    同一份 store,见 `commands.ts`),而不再是等 reducer 的回执。
 * 2. **正文只有一个来源**。`content` / `reasoning` / `contentParts` 永远不进
 *    `message/patched`;`isStreaming` 是 `run/start`…`run/end` 之间的**状态**,不是字段。
 * 3. **写侧取材的例外表**(F3 翻面 §16.10、F4-a 摘掉一类 §16.12、F4-b2 改判一类
 *    §16.17;原纪律 §13.18 发现 B)。从前是"一律走 `*FromTranscript`,永不走
 *    `getMessage`",理由是活投影滞后 —— F1(§16.6)之后那条理由不成立了。今天
 *    写侧**默认可以读活投影**,只剩**一类**具名例外仍读 store:**判据同源**
 *    (命令面的存在性 / 底稿,见 `commands.ts` 文件头)。F3 的第三类"事件产地
 *    缺口"(流中 assistant 占位没有那一格)已随 F4-a 摘除:那两处是 `run/start`
 *    的生产者,而 `addMessage` 现在把**入库的那一条**直接交回它们,不必回读。
 *    F3 的第二类"只在 store 的运行时形状"(收尾链的 `steps[]` 与 `data-steps`
 *    锚点)已随 F4-b2 改判搬走,又随 **F4-c c4-b(§16.25 钥匙①)整个消失** ——
 *    锚点由推送侧从折叠产物现算,收尾链改读投影,`getLiveRunWriterMessage` 已删。
 * 4. **失败一律自吞**,除了 `SessionEventWriteError`(§14.6 裁定 7)—— 见 `safely`。
 */

import type { ChatMessage, ChatSession, MessageAttachment } from '@shared/ipc.js'
import type { BlobRef } from '@onething/core/session'
import { putSessionBlob } from './blob-store.js'
import { appendSurfaceAwareEvent, isSessionTranslationEnabled, sessionSurface } from './event-surface.js'
import { SessionEventWriteError } from './event-log.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.events')

/** 正文字段永远不由命令产出(它们的来源是 chunks)。 */
export const BODY_KEYS = new Set(['content', 'contentParts', 'reasoning'])
/** 派生字段:投影自己算得出来,记一份补丁只会制造第二个真相。 */
export const DERIVED_KEYS = new Set(['isStreaming', 'isThinking', 'thinkingStartTime', 'seq', 'steps', 'toolCalls'])

/**
 * 事件产出失败一律自吞 —— **除了"账本写不进去"这一类**(§14.6 裁定 7)。
 *
 * 自吞的理由:构造坏了不能影响聊天。但 `SessionEventWriteError` 说的不是"构造坏了",
 * 是"这条事件没落进磁盘";而 `events.jsonl` 已是唯一持久化,吞掉它等于让一段历史
 * 悄悄消失。所以这一类往上抛,由命令面的调用方变成一次可见的失败。
 */
export function safely(what: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    if (error instanceof SessionEventWriteError) throw error
    log.warn('session event production failed', { what }, error)
  }
}

/**
 * 附件里的 `base64Data` 换成 `BlobRef`(§10.1 G8)。
 *
 * 一张图能有几 MB,而事件行是要被逐行 parse 的 —— 把 base64 写进事件行等于让
 * 每一次 fold 都把它读一遍。落 blob、行里只留 `{hash, bytes, mime}`。
 * blob 写不进去时**摘掉** `base64Data`(而不是留原文):事件行的大小上限是
 * 硬约束。
 */
export function attachmentsForEvent(
  sessionId: string,
  attachments: readonly MessageAttachment[] | undefined,
): unknown[] | undefined {
  if (!attachments?.length) return undefined
  return attachments.map(attachment => {
    if (!attachment.base64Data) return attachment
    const blob: BlobRef | undefined = putSessionBlob(
      sessionId,
      Buffer.from(attachment.base64Data, 'base64'),
      attachment.mimeType,
    )
    const { base64Data: _dropped, ...rest } = attachment
    return blob ? { ...rest, base64Data: blob } : rest
  })
}

/** 一条消息在事件里的形状:正文原样,附件换引用。 */
export function messageForEvent(sessionId: string, message: ChatMessage): Record<string, unknown> {
  const attachments = attachmentsForEvent(sessionId, message.attachments)
  const { attachments: _dropped, ...rest } = message
  return {
    ...rest,
    ...(attachments ? { attachments } : {}),
  }
}

// ============ 已翻转的命令:事件是第一手产出 ============

export const sessionCommandEvents = {
  /**
   * `appendMessage`(F2-a)。三条分支:
   *  - user → `user/message`;
   *  - assistant **且 isStreaming** → 一条都不写:它是一次执行的占位,
   *    `run/start` 才是它在 surface 上的那一格(§9.3);
   *  - 其余(system / error / 直接落定的 assistant)→ `system/message`,
   *    role 原样。它是一条**完整消息**,和 `message/imported` 同形。
   */
  appendMessage(sessionId: string, message: ChatMessage, time?: number): void {
    if (!isSessionTranslationEnabled(sessionId)) return
    safely('appendMessage', () => {
      if (message.role === 'assistant' && message.isStreaming) return
      const type = message.role === 'user' ? 'user/message' : 'system/message'
      appendSurfaceAwareEvent(
        sessionId,
        type,
        { message: messageForEvent(sessionId, message) as never },
        { surfaceOp: 'append', ...(time !== undefined ? { time } : {}) },
      )
    })
  },

  /** `deleteMessage`(F2-a):只遮蔽它自己那一格(后面的照旧在 surface 上)。 */
  deleteMessage(sessionId: string, messageId: string, time?: number): void {
    if (!isSessionTranslationEnabled(sessionId)) return
    safely('deleteMessage', () => {
      const seq = sessionSurface(sessionId).seqOf(messageId)
      appendSurfaceAwareEvent(
        sessionId,
        'message/deleted',
        { messageId },
        {
          ...(seq !== undefined
            ? { surfaceOp: { op: 'replace' as const, start: seq, end: seq }, sourceEventSeqs: [seq] }
            : {}),
          ...(time !== undefined ? { time } : {}),
        },
      )
    })
  },

  /**
   * `patchMessage`(F2-a)。`turnContext` 单独走 `context/turn-update`(它取代了
   * `ChatMessage.turnContext` 字段,§9.2);正文与派生字段一律丢弃;
   * 剩下全空就一条都不写。
   *
   * `fullBody` 是 **upsert 的整条替换**用的那一档(F2-b 之后 upsert 就在本文件里,
   * 见下):正文三件套照旧带上 —— 那一条的语义就是"这条消息现在整条长这样"。
   */
  patchMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<ChatMessage>,
    options: { fullBody?: boolean; time?: number } = {},
  ): void {
    if (!isSessionTranslationEnabled(sessionId)) return
    safely('patchMessage', () => {
      const at = options.time !== undefined ? { time: options.time } : {}
      const turnContext = (patch as { turnContext?: { set?: Record<string, string>; removed?: string[] } }).turnContext
      if (turnContext) {
        appendSurfaceAwareEvent(
          sessionId,
          'context/turn-update',
          {
            messageId,
            ...(turnContext.set ? { set: turnContext.set } : {}),
            ...(turnContext.removed ? { removed: turnContext.removed } : {}),
          },
          at,
        )
      }

      const kept: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'turnContext' || key === 'id') continue
        if (DERIVED_KEYS.has(key)) continue
        // `fullBody`(upsert 的整条替换)是唯一放行正文的档;归约器仍然会对
        // assistant 节点把这三格剥掉。
        if (!options.fullBody && BODY_KEYS.has(key)) continue
        if (value === undefined) continue
        kept[key] = key === 'attachments'
          ? attachmentsForEvent(sessionId, value as MessageAttachment[])
          : value
      }
      if (Object.keys(kept).length === 0) return
      appendSurfaceAwareEvent(
        sessionId,
        'message/patched',
        {
          messageId,
          patch: kept,
          // §17.7.1 批 2 裁定 2:`fullBody` 这一档就是 upsert 的整条替换,而它
          // 与 `patchMessage` 在会话账上的待遇不同(前者盖 `updatedAt`)。事件上
          // 记的是**调用类别**这个事实,盖不盖章的策略住 `core/session/account.ts`。
          ...(options.fullBody ? { via: 'upsert' as const } : {}),
        },
        at,
      )
    })
  },

  /**
   * `upsertMessage`(F2-b)。两条分支,岔口是**这条消息在不在**——
   * 与 core reducer 的 `findIndex(item => item.id === message.id) === -1` 同源同义,
   * 由命令面在写事件之前从 **store 侧**问一次(F3 §16.10 复核:留在 store,理由是
   * 判据同源 —— 与 reducer 问同一份 store,写事件与改 store 才不会一边发生一边不
   * 发生;原来那句"活投影滞后会误判成新增"(§13.18 发现 B)F1 之后已不成立)。
   *
   *  - **不在** → 与 `appendMessage` 是**同一条**构造(reducer 那边也正是同一个
   *    `applyAppend`):流中的 assistant 占位照旧一条都不写,`run/start` 才是它
   *    在 surface 上的那一格;
   *  - **在** → `message/patched` 的 `fullBody` 档:正文三件套照旧带上,因为 upsert
   *    的语义就是"这条消息现在整条长这样"。安全边界在归约器的 `sanitizePatch`
   *    (它对 assistant 节点仍然剥掉正文三件套),不在这里。
   *
   * 借道的是**同一份**构造而不是复制一份 —— 两个产地各自演化出一份 append/patch,
   * 就是"同一条命令写出两种事件"的温床。
   */
  upsertMessage(sessionId: string, message: ChatMessage, existed: boolean, time?: number): void {
    if (!existed) {
      sessionCommandEvents.appendMessage(sessionId, message, time)
      return
    }
    sessionCommandEvents.patchMessage(
      sessionId,
      message.id,
      message as Partial<ChatMessage>,
      { fullBody: true, ...(time !== undefined ? { time } : {}) },
    )
  },

  /**
   * `truncateFrom`(F2-b)。两种语义,两条事件:
   *  - `inclusive`(regenerate)→ `message/deleted` + replace 遮蔽"这条到末尾";
   *  - 否则(edit-resend)→ `user/message-edited` + 同样的 replace,新节点接上。
   *
   * range 与 `sourceEventSeqs` 都从**活 surface** 取 —— 手数下标会在压缩之后错位
   * (那个节点排在最前面而 seq 最大)。F1 之后活 surface 上还有 `tool/result` 这类
   * 格子,所以这一段遮蔽比 F1 之前更全:那是已拍定的行为,不是本批的副作用。
   *
   * **编辑那一支的新正文由命令自己合成**(翻转之前是 reducer 先写、翻译器再从 store
   * 把它读回来):底稿 = 编辑**前**那条(命令面从 **store 侧**取 —— 底稿同源,
   * 见 `commands.ts` 的 `truncateFrom` 与 §16.10),
   * 叠上 `newContent` / `contentParts`,再盖上 `now`。这三步逐字镜像 core 的
   * `applyTruncate`,而 `now` 由命令决定一次、**同时**递给事件与 reducer(§16.8),
   * 所以两条推导上的 `timestamp` 不是"差不多相等",是同一个数 —— 否则恒等门
   * (§16.5)比的就是两个时钟读数。
   */
  truncateFrom(
    sessionId: string,
    payload: {
      messageId: string
      inclusive: boolean
      newContent?: string
      contentParts?: ChatMessage['contentParts'] | null
    },
    context: { before?: Readonly<ChatMessage>; now: number },
  ): void {
    if (!isSessionTranslationEnabled(sessionId)) return
    safely('truncateFrom', () => {
      const range = sessionSurface(sessionId).rangeFrom(payload.messageId)
      const surfaceOp = range
        ? ({ op: 'replace', start: range.start, end: range.end } as const)
        : undefined
      // 时钟同源(裁定 1):`context.now` 是命令取的那**一次**刻 —— 它既是事件
      // 的落账时刻、又是 reducer 盖 `updatedAt` 与被改写消息 `timestamp` 的那个数。
      const options = {
        ...(surfaceOp ? { surfaceOp, sourceEventSeqs: range!.seqs } : {}),
        time: context.now,
      }

      if (payload.inclusive) {
        appendSurfaceAwareEvent(sessionId, 'message/deleted', { messageId: payload.messageId }, options)
        return
      }
      // 底稿不在 = 这次命令什么都改不成(reducer 的 `index === -1`)。命令面已经
      // 用同一个判据挡在前面,这里是第二道 —— 只写事实。
      if (!context.before) return
      appendSurfaceAwareEvent(
        sessionId,
        'user/message-edited',
        {
          messageId: payload.messageId,
          message: messageForEvent(sessionId, editedMessage(payload, context.before, context.now)) as never,
        },
        { ...options, surfaceOp: surfaceOp ?? 'append' },
      )
    })
  },

  /**
   * `replaceAll`(F2-c)。三种 reason,两种事件:
   *  - `clear` → 一条 `session/cleared{reason:'clear'}` 遮蔽整条 surface;
   *  - `replaced`(collab 的 MESSAGES_REPLACED,G11)→ 同样一条 cleared,
   *    再逐条 `message/imported` 把新的一份接上;
   *  - `normalize` → **一条都不写**:它是冷加载的形状规整,消息集合没变
   *    (这是判例,不是优化 —— 记一条 cleared 会把一次"什么都没发生"变成
   *    surface 上的一次全量遮蔽)。
   *
   * `wholeRange()` 取的是**活 surface**,与 store 无关,所以翻转到 reducer 之前
   * 取到的范围与从前逐字相同。
   */
  replaceAll(
    sessionId: string,
    messages: readonly ChatMessage[],
    reason: 'clear' | 'replaced' | 'normalize',
    time?: number,
  ): void {
    if (reason === 'normalize') return
    if (!isSessionTranslationEnabled(sessionId)) return
    safely('replaceAll', () => {
      const at = time !== undefined ? { time } : {}
      const whole = sessionSurface(sessionId).wholeRange()
      appendSurfaceAwareEvent(
        sessionId,
        'session/cleared',
        { reason },
        {
          ...(whole
            ? {
                surfaceOp: { op: 'replace' as const, start: whole.start, end: whole.end },
                sourceEventSeqs: whole.seqs,
              }
            : {}),
          ...at,
        },
      )
      if (reason !== 'replaced') return
      for (const message of messages) {
        appendSurfaceAwareEvent(
          sessionId,
          'message/imported',
          { message: messageForEvent(sessionId, message) as never },
          { surfaceOp: 'append', ...at },
        )
      }
    })
  },

  /**
   * `patchSession`(F2-c)。只有三格进事件:agent / model / workdir —— 它们改变
   * **模型看到的世界**(system 变量、工具的工作树、人格)。其余会话级字段
   * (name / pin / archived / summary…)是 UI 偏好,留在 `meta.json`(§2)。
   *
   * **三个产地共用这一份构造**(§13.10 M7):命令面(翻转后事件在 reducer 之前)、
   * `stores/sessions.ts` 的 `updateSessionAgent`、server 的 `sessions.update`。
   * 后两条**绕开了命令面**,而且必须在写成功之后才叫得动这里 —— 它们的 `to`
   * 取的是**落库之后**那一格(agent 那一格在仓库里带着"空值回落默认 agent"的
   * 规范化;server 那条路的会话对象是就地改的)。所以本方法对"谁先说话"是中立的:
   * 它拿的是调用方算好的 `patch` 与 `before`,顺序由调用方的事实决定。
   */
  patchSession(
    sessionId: string,
    patch: Partial<ChatSession>,
    before: Pick<ChatSession, 'agentId' | 'lastModel' | 'lastProvider' | 'workingDirectory'> | undefined,
  ): void {
    if (!isSessionTranslationEnabled(sessionId)) return
    safely('patchSession', () => {
      if (patch.agentId !== undefined && patch.agentId !== before?.agentId) {
        appendSurfaceAwareEvent(sessionId, 'session/agent-changed', {
          ...(before?.agentId ? { from: before.agentId } : {}),
          to: patch.agentId,
        })
      }
      if (patch.lastModel !== undefined && patch.lastModel !== before?.lastModel) {
        appendSurfaceAwareEvent(sessionId, 'session/model-changed', {
          ...(before?.lastModel ? { from: before.lastModel } : {}),
          to: patch.lastModel,
          ...(patch.lastProvider ? { provider: patch.lastProvider } : {}),
        })
      }
      if (
        patch.workingDirectory !== undefined
        && patch.workingDirectory !== before?.workingDirectory
      ) {
        appendSurfaceAwareEvent(sessionId, 'session/workdir-changed', {
          ...(before?.workingDirectory ? { from: before.workingDirectory } : {}),
          to: patch.workingDirectory,
        })
      }
    })
  },
}

/**
 * `truncateFrom{inclusive:false}` 改写出来的那条消息 —— **逐字镜像**
 * `packages/core/session/commands.ts` 的 `applyTruncate`:
 *
 * ```
 * target.content = command.newContent
 * if (command.hasContentParts) { 非空 → 赋值;空 → delete }
 * target.timestamp = now
 * ```
 *
 * `hasContentParts` 的判据是"payload 上有没有 `contentParts` 这个键"(与命令面
 * 递给 store 端口的那一个同义,不是"值是不是真"),所以 `contentParts: null`
 * 是**显式清空**,而键不在则一格都不动。
 *
 * 写法上**只构造、不赋值**:`session:gate` 的规则 B 只放行 core reducer 里的消息
 * 字段赋值,而这里本来也不该改任何一条在册的消息 —— 它算的是"这条命令要写进事件
 * 里的那一份",拿到的 `before` 是只读的(dev / vitest 下还是深冻结的)。
 */
function editedMessage(
  payload: {
    newContent?: string
    contentParts?: ChatMessage['contentParts'] | null
  },
  before: Readonly<ChatMessage>,
  now: number,
): ChatMessage {
  const declared = Object.prototype.hasOwnProperty.call(payload, 'contentParts')
  const clearing = declared && !(payload.contentParts && payload.contentParts.length > 0)
  // 清空那一档要的是"这个键不在了",所以底稿先把它摘掉(而不是赋一个空值)。
  const { contentParts: _cleared, ...withoutParts } = before
  return {
    ...(clearing ? withoutParts : before),
    ...(declared && !clearing ? { contentParts: payload.contentParts } : {}),
    content: payload.newContent ?? '',
    timestamp: now,
  } as ChatMessage
}
