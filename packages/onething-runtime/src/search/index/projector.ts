/**
 * `IndexProjector` —— 账本 → 文档。
 *
 * 设计:docs/design/search-index-2026-09.md §5.2(那张「哪些事件折成什么」的表)
 * + §5.1(文档模型)+ 拍点乙 a(默认字段:正文 + 会话标题 + 附件名;推理做开关;
 * 工具结果不索引)。
 *
 * 它是一个 **fold**,而且**不自己拼 chunk**:复用 core 的 `reduceSessionProjection`
 * 拿结算后的消息、`materializeNode` 物化助手节点。理由与整套事件溯源同一条 ——
 * 「同一段正文只许有一个产地」。索引自己再拼一遍 delta,就是第二个产地,而两个
 * 产地迟早会答出两份不一样的正文。
 *
 * ## 事件 → 动作(§5.2 逐行)
 *
 * | 账本事件 | 这里怎么落 |
 * | --- | --- |
 * | `user/message` / `system/message` / `message/imported` | 折进投影 → **立刻**产一份消息文档(用户消息一到就可搜) |
 * | `assistant/chunks` / `assistant/part-end` | 只折进投影,**不产文档**(流式中不搜半条) |
 * | `run/end` | 助手节点 `ended` 翻真 → 物化、产文档 |
 * | `user/message-edited` | 投影里就是同一个节点被替换 → 产出的文档跟着换(整键替换,天然幂等) |
 * | `message/deleted` / `session/cleared` | 节点从投影里消失 / 被遮蔽 → 这一份文档不再产出 = 墓碑 |
 * | `session/compacted` | **被压掉的消息照旧索引**(见下),压缩卡自己不产文档 |
 * | `tool/call` | 不产文档;从参数里抽 path(edit / write / read)给本 run 的助手文档加 `touched-file` 边 |
 * | `session/workdir-changed` / `model-changed` / `agent-changed` | 无关,跳过(reducer 折进 `sessionMeta`,这里不读) |
 *
 * **墓碑为什么是「不产出」而不是一条删除指令**:`documentsOf(key)` 交出的是「这把
 * 钥匙下的**全部**文档」,索引侧做的是**整键替换**(§5.2b)。于是删一条消息与
 * 改一条消息在这里是同一件事 —— 重折一遍,少了的就是没了。少一条指令,少一种
 * 「删漏了」的形。
 *
 * **与设计 §5.2 那张表的一处出入(S3a 实测后修正)**:表上写 `session/compacted`
 * → 「被压缩的消息打墓碑(按投影状态里消失的节点)」。真跑一遍才知道:
 * `reduceSessionProjection` 的 `session/compacted` 分支**只隐藏那条占位消息**,被压
 * 掉的那些一格都不 `hidden` —— 压缩遮蔽的是**模型可见历史**(`state.surface` 的
 * replace 区间),不是屏幕上的记录。用户压缩之后照样能往上滚看见旧消息,把它们
 * 打成墓碑就是「屏幕上有、搜不到」。所以这里**照旧索引**它们,只是压缩卡自己不产
 * 文档(它的正文是摘要,那张表也没给它「产一份文档」这个动作)。
 * `session/cleared` 那一行成立:reducer 把全部节点 `hidden = true`。
 *
 * **改名 / 归档 / 删除不经账本**(拍点甲 b):它们是会话的元数据,由 `LedgerFeed`
 * 读 `meta.json` 给进来(见 `SessionMetaSnapshot`),不是这里的事件。
 */

import type { DocPayload } from '@onething/core/search'
// 事件词表与投影都经 `@onething/core/session` 这一个桶出口(`session/index.ts` 的
// 末两行把 `events/` 与 `projection/` 都再导出了)—— 不为这一处新开子路径键。
import type {
  ProjectedChatMessage,
  ProjectedToolCall,
  ProjectionBlobResolver,
  ProjectionNode,
  SessionLogEventRecord,
} from '@onething/core/session'
import { foldSessionProjection, materializeNode } from '@onething/core/session'

/**
 * 能力 id。S5 之前会话那一类叫 `chats`(壳与 CLI 都认它),消息那一类叫
 * `messages` —— 与 `runtime/search/capabilities/{sessions,messages}.ts` 的 manifest
 * 逐字相同。runtime 允许出现能力名(core 才不许),但仍然做成可注入的一格:
 * S5 改名时改的是装配处的一行,不是这个文件。
 */
export const DEFAULT_MESSAGE_CAPABILITY = 'messages'
export const DEFAULT_SESSION_CAPABILITY = 'chats'

/** `meta.json` 里索引要用的那几格(会话外壳,不是历史)。 */
export interface SessionMetaSnapshot {
  name?: string
  workspaceId?: string
  isArchived?: boolean
  createdAt?: number
  updatedAt?: number
}

/**
 * 「这次工具调用碰了哪个文件」的取法:工具 id → 参数名候选。
 *
 * 做成一张**表**而不是 `if (toolId === 'edit' || …)`:加一种碰文件的工具 = 加一行
 * 数据。今天三只内置工具的参数名都叫 `path`(`EditInputSchema` / `WriteInputSchema`
 * / `ReadInputSchema`),`file_path` / `filePath` 是给别处(MCP / 插件工具)留的
 * 兼容名 —— 取第一个是字符串且非空的那一格。
 */
export type TouchedFileArgTable = Record<string, readonly string[]>

export const DEFAULT_TOUCHED_FILE_ARGS: TouchedFileArgTable = {
  edit: ['path', 'file_path', 'filePath'],
  write: ['path', 'file_path', 'filePath'],
  read: ['path', 'file_path', 'filePath'],
}

/** 关系边的名字(§5.1)。core 不认识它们,只存与 join。 */
export const REL_IN_SESSION = 'in-session'
export const REL_TOUCHED_FILE = 'touched-file'

export interface IndexProjectorOptions {
  /**
   * 推理段进不进索引(拍点乙:**(a) 缺省不含**,做成「含推理」开关)。
   * 工具结果**一律不索引** —— 那不是开关,是拍点乙定死的边界(真库里
   * `events.jsonl` 480MB 的大头就是它)。
   */
  includeReasoning?: boolean
  /** 超 64KB 的正文在事件行里是 blob 引用,物化时经它解出(§5.5)。 */
  resolveBlob?: ProjectionBlobResolver
  messageCapability?: string
  sessionCapability?: string
  touchedFileArgs?: TouchedFileArgTable
}

export interface ProjectSessionInput {
  sessionId: string
  events: readonly SessionLogEventRecord[]
  meta?: SessionMetaSnapshot
}

export class IndexProjector {
  private readonly includeReasoning: boolean
  private readonly resolveBlob: ProjectionBlobResolver | undefined
  private readonly messageCapability: string
  private readonly sessionCapability: string
  private readonly touchedFileArgs: TouchedFileArgTable

  constructor(options: IndexProjectorOptions = {}) {
    this.includeReasoning = options.includeReasoning ?? false
    this.resolveBlob = options.resolveBlob
    this.messageCapability = options.messageCapability ?? DEFAULT_MESSAGE_CAPABILITY
    this.sessionCapability = options.sessionCapability ?? DEFAULT_SESSION_CAPABILITY
    this.touchedFileArgs = options.touchedFileArgs ?? DEFAULT_TOUCHED_FILE_ARGS
  }

  /** 这把钥匙(= 一条会话)下的全部文档。整键替换的粒度就是它。 */
  project(input: ProjectSessionInput): DocPayload[] {
    const state = foldSessionProjection(input.events)
    const spaceId = input.meta?.workspaceId ?? ''
    const archived = input.meta?.isArchived === true
    const docs: DocPayload[] = []

    // 会话标题一份文档 —— 标题来自 meta.json,不是账本(拍点甲 b)。
    const title = input.meta?.name ?? ''
    if (title.length > 0) {
      docs.push({
        capability: this.sessionCapability,
        key: input.sessionId,
        time: input.meta?.updatedAt ?? input.meta?.createdAt ?? 0,
        facets: { sessionId: input.sessionId, spaceId, archived, time: input.meta?.updatedAt ?? 0 },
        fields: { title },
      })
    }

    for (const node of state.nodes) {
      if (node.hidden === true) continue
      const doc = this.documentOf(node, input.sessionId, spaceId, archived)
      if (doc !== undefined) docs.push(doc)
    }
    return docs
  }

  private documentOf(
    node: ProjectionNode,
    sessionId: string,
    spaceId: string,
    archived: boolean,
  ): DocPayload | undefined {
    // 助手节点只在 run 收尾之后才有文档(§5.2「流式中不搜半条」);
    // `compacted` 是一张压缩卡,它的正文是被压掉那些消息的摘要 —— §5.2 那张表
    // 只给了「墓碑」这一个动作,没有「把摘要也索引一份」,不擅自加。
    if (node.kind === 'compacted') return undefined
    if (node.kind === 'assistant' && !node.ended) return undefined

    const message = materializeNode(node, this.resolveBlob === undefined
      ? {}
      : { resolveBlob: this.resolveBlob })

    const fields: Record<string, string> = { content: typeof message.content === 'string' ? message.content : '' }
    const attachments = attachmentNames(message)
    if (attachments.length > 0) fields.attachments = attachments.join('\n')
    if (this.includeReasoning) {
      const reasoning = reasoningText(message)
      if (reasoning.length > 0) fields.reasoning = reasoning
    }

    const relations = [{ rel: REL_IN_SESSION, to: sessionId }]
    for (const file of this.touchedFiles(message.toolCalls)) {
      relations.push({ rel: REL_TOUCHED_FILE, to: file })
    }

    const time = typeof message.timestamp === 'number' ? message.timestamp : 0
    return {
      capability: this.messageCapability,
      key: `${sessionId}:${message.id}`,
      time,
      facets: { sessionId, spaceId, role: message.role, archived, time },
      fields,
      relations,
    }
  }

  /** 从 `tool/call` 的参数里抽 path(§5.2 最后一行)。去重,保序。 */
  private touchedFiles(toolCalls: readonly ProjectedToolCall[] | undefined): string[] {
    if (toolCalls === undefined) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const call of toolCalls) {
      // `toolId` 是引擎归一之后的身份,`toolName` 是模型写的那个串;老账本只有后者。
      const names = this.touchedFileArgs[call.toolId] ?? this.touchedFileArgs[call.toolName]
      if (names === undefined) continue
      for (const name of names) {
        const value = call.arguments?.[name]
        if (typeof value !== 'string' || value.length === 0) continue
        if (!seen.has(value)) {
          seen.add(value)
          out.push(value)
        }
        break
      }
    }
    return out
  }
}

/** 附件**名**(拍点乙 a:附件名进索引,附件正文不进)。 */
function attachmentNames(message: ProjectedChatMessage): string[] {
  const attachments = message.attachments
  if (!Array.isArray(attachments)) return []
  const names: string[] = []
  for (const attachment of attachments) {
    if (attachment === null || typeof attachment !== 'object') continue
    const name = (attachment as { fileName?: unknown }).fileName
    if (typeof name === 'string' && name.length > 0) names.push(name)
  }
  return names
}

/**
 * 推理正文:顶部那一段(`message.reasoning`)加上 `contentParts` 里的推理格。
 * 两个落点由引擎的推理摆放规则划分,投影按同一条规则物化 —— 这里只是把它们
 * 拼成一段可搜文本,不重新判定谁在哪。
 */
function reasoningText(message: ProjectedChatMessage): string {
  const parts: string[] = []
  if (typeof message.reasoning === 'string' && message.reasoning.length > 0) {
    parts.push(message.reasoning)
  }
  for (const part of message.contentParts ?? []) {
    if (part.type === 'reasoning' && part.content.length > 0) parts.push(part.content)
  }
  return parts.join('\n')
}
