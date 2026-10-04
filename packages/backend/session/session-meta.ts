// 会话的索引元数据(从 `session-store-helpers.ts` 拆出,拆分批 1,D226):`CoreSessionMeta` 这份形状,
// 在索引里找 / 插 / 改一条元数据,更新时间与追加消息怎么落到元数据上,会话列表那两格(消息数、最后一句预览)
// 怎么算,以及名字、置顶、归档、权限模式、工作目录、变量、提示词上下文、摘要、模型、agent 这些会话字段的设置器,
// 和从整份会话重算元数据(`extractSessionMeta`)。
import { type NormalizeWorkingDirectoryRootsOptions, normalizeWorkingDirectoryRoots } from './session-load.js'
import type { CoreSession } from './session-details.js'

export const CORE_DEFAULT_AGENT_ID = 'default'

export interface CoreSessionMessage {
  id?: string
  role: string
  content?: unknown
}

export interface CoreSessionMeta {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  agentId?: string
  memoryProfileId?: string
  originIdentityKey?: string
  lastConnector?: string
  lastSentAt?: number
  parentSessionId?: string
  branchFromMessageId?: string
  lastModel?: string
  lastProvider?: string
  /** The user picked lastProvider/lastModel by hand (not the auto-stamp). */
  modelPinned?: boolean
  permissionMode?: string
  isPinned?: boolean
  isArchived?: boolean
  archivedAt?: number
  messageCount?: number
  previewText?: string
  /**
   * **最后一条 user/assistant 消息的纯文本预览**(共享层读侧补齐 E 批)。
   *
   * 与 `previewText`(第一条用户消息)是两格不同的事实,不是它的新版本:
   * 一个回答"这条会话是从哪句话开的",一个回答"它最近说到哪儿"。列表 UI 要的
   * 是后者,而在这一格之前它拿不到 —— 唯一的办法是现场翻消息,那正是会话列表
   * 读路不能做的事(439 条会话 × 一次账本 fold)。
   *
   * **它的新鲜度契约与 `updatedAt` 逐字相同**:两格在同一批写点上一起维护
   * (append / upsert 新增 / truncate / delete / replaceAll),逐 token 的补丁
   * 两格都不碰。所以流式助手占位刚开出来的那一刻(正文还是空的)这一格保持
   * 上一句不变 —— 空正文永远不覆盖,见 `deriveSessionLastMessagePreview`。
   */
  lastMessagePreview?: string
  /**
   * 会话归属的 space(workspace)。**缺席 = default** —— 读取端缺省,不做数据
   * 迁移(`docs/design/workspace-spaces-2026-08.md` 批 B)。core 只负责把它随
   * 会话记录与索引一起存下来,不解释它的语义。
   */
  workspaceId?: string
  /**
   * 这条会话属于哪个应用(2026-09-26,电台 DJ 之流)。**缺席 = 人开的会话**。
   *
   * 有这一格的会话是那个应用的内部记录:会话列表不列它、检索不给它、建它的时候
   * 不把它顶成「当前会话」——只有那个应用自己的面(音乐面上点主持人)能打开它。
   * core 只负责把它随会话记录与索引一起存下来,不认识任何应用的名字;谁是
   * 「那个应用」由写入方说,读表的人只看这一格在不在。
   */
  app?: string
}

export interface ApplySessionIndexMetaMutationWithAdaptersOptions<TMeta extends { id: string }> {
  sessionId: string
  loadIndex(): TMeta[]
  saveIndex(index: TMeta[]): void
  mutateMeta(meta: TMeta): void
}

export interface CoreSessionIndexTimestampSource {
  updatedAt: number
}

export interface CoreSessionIndexMessageSource {
  role: string
  provider?: string
  model?: string
}

/**
 * 与变量子系统的两个枚举同形(core 不许依赖 runtime,所以在这里各声明一份)。
 *
 * type/scope/state 都必须**原样存活到落盘**:state 决定这个变量还进不进
 * `<context-update>`,归一化时把它丢掉,本该一直在模型眼前的状态重载后就凭空
 * 消失了 —— 而它消失得静悄悄,没有任何报错。
 */
export type CoreContextVariableType = 'string' | 'number' | 'bool' | 'list' | 'map' | 'set'
export type CoreContextVariableScope = 'global' | 'session' | 'agent' | 'project'

export interface CoreContextVariableInput {
  name: string
  value: string
  values?: string[]
  type?: CoreContextVariableType
  scope?: CoreContextVariableScope
  state?: boolean
  description?: string
  updatedAt?: number
}

export interface CoreNormalizedContextVariable {
  name: string
  value: string
  values?: string[]
  type?: CoreContextVariableType
  scope?: CoreContextVariableScope
  state?: boolean
  description?: string
  updatedAt: number
}

export interface SessionMetaExtractOptions<TMessage extends CoreSessionMessage = CoreSessionMessage> {
  defaultAgentId?: string
  previewLength?: number
  displayContentForMessage?: (message: TMessage) => string
}

export function findSessionMeta<TMeta extends { id: string }>(
  index: TMeta[],
  sessionId: string,
): TMeta | undefined {
  return index.find(session => session.id === sessionId)
}

export function prependSessionMeta<TMeta>(
  index: TMeta[],
  meta: TMeta,
): TMeta[] {
  index.unshift(meta)
  return index
}

export function updateSessionIndexMeta<TMeta extends { id: string }>(
  index: TMeta[],
  sessionId: string,
  update: (meta: TMeta) => void,
): TMeta | undefined {
  const meta = findSessionMeta(index, sessionId)
  if (!meta) return undefined
  update(meta)
  return meta
}

export function applySessionIndexMetaMutationWithAdapters<TMeta extends { id: string }>(
  options: ApplySessionIndexMetaMutationWithAdaptersOptions<TMeta>,
): TMeta | undefined {
  const index = options.loadIndex()
  const meta = updateSessionIndexMeta(index, options.sessionId, options.mutateMeta)
  if (!meta) return undefined
  options.saveIndex(index)
  return meta
}

export function applySessionUpdatedAtToMeta<TMeta extends { updatedAt: number }>(
  meta: TMeta,
  session: CoreSessionIndexTimestampSource,
): TMeta {
  meta.updatedAt = session.updatedAt
  return meta
}

export function applySessionMessageAppendToMeta<
  TMeta extends { updatedAt: number; lastProvider?: string; lastModel?: string },
>(
  meta: TMeta,
  session: CoreSessionIndexTimestampSource,
  message: CoreSessionIndexMessageSource,
): TMeta {
  applySessionUpdatedAtToMeta(meta, session)
  if (message.role === 'assistant') {
    meta.lastProvider = message.provider ?? meta.lastProvider
    meta.lastModel = message.model ?? meta.lastModel
  }
  return meta
}

/** 预览格的默认长度。写侧一次算定,读侧不再裁。 */
export const SESSION_LAST_MESSAGE_PREVIEW_LENGTH = 120

/** 只有这两种角色算"说过的话";工具结果与系统标记不进预览。 */
const PREVIEWABLE_MESSAGE_ROLES = new Set(['user', 'assistant'])

/** 预览取材只认这三格,与 `ChatMessage` 结构兼容(core 不 import 契约层)。 */
export interface CoreSessionPreviewMessageSource {
  role: string
  content?: unknown
  contentParts?: unknown
}

/**
 * 一条消息的**纯文本预览** —— 纯函数,`lastMessagePreview` 的唯一产地。
 *
 * 规则(逐条有单测):
 *  1. 只有 `user` / `assistant` 算数 —— 工具结果、系统标记、压缩标记都不是"说过的话";
 *  2. 正文取 `content` 那个字符串;它不是字符串(多模态)时退到 `contentParts`,
 *     **只取 `type:'text'` 那些格**(图片 / 推理 / 工具调用 / provider 私有数据一律不进);
 *  3. 空白折成单个空格再 trim —— 列表里一行放不下换行,先归一化再截断才截得准;
 *  4. 截断按**码点**边界(`Array.from`),不按 UTF-16 code unit:按 `.slice()` 截会
 *     把 emoji / 非 BMP 汉字劈成半个代理对,渲染出 U+FFFD;
 *  5. 结果为空 → `undefined`(= "这条消息给不出预览"),调用方据此**保留上一格**,
 *     而不是把预览洗成空串。流式助手占位正是靠这一条不覆盖用户那句话。
 */
export function deriveSessionLastMessagePreview(
  message: CoreSessionPreviewMessageSource | undefined | null,
  maxLength = SESSION_LAST_MESSAGE_PREVIEW_LENGTH,
): string | undefined {
  if (!message || !PREVIEWABLE_MESSAGE_ROLES.has(message.role)) return undefined

  const raw = typeof message.content === 'string' && message.content
    ? message.content
    : textFromContentParts(message.contentParts)

  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  if (maxLength <= 0) return undefined

  const codePoints = Array.from(normalized)
  return codePoints.length <= maxLength ? normalized : codePoints.slice(0, maxLength).join('')
}

function textFromContentParts(contentParts: unknown): string {
  if (!Array.isArray(contentParts)) return ''
  const chunks: string[] = []
  for (const part of contentParts) {
    if (!part || typeof part !== 'object') continue
    const record = part as { type?: unknown; content?: unknown }
    if (record.type !== 'text' || typeof record.content !== 'string') continue
    chunks.push(record.content)
  }
  return chunks.join(' ')
}

/** `applySessionListProjectionToMeta` 的入参 —— 每一格缺席 = 那一格不动。 */
export interface CoreSessionListProjectionUpdate {
  /** 此刻这条会话有多少条消息(调用方从投影数出来的权威值)。 */
  messageCount?: number
  /** 此刻的最后一条消息。缺席 = 调用方没取,预览格保持不动。 */
  lastMessage?: CoreSessionPreviewMessageSource | undefined
  previewLength?: number
}

/**
 * 会话**列表投影**的两格(`messageCount` / `lastMessagePreview`)落到索引元数据上。
 *
 * 挂在写侧、与 `updatedAt` 同刻 —— 会话列表读因此仍然只是一次索引元数据读
 * (O(会话数)),不需要为了一行预览去翻 439 本账。
 *
 * `messageCount === 0` 是唯一会**清掉**预览的情形(会话被清空):此时"最后一条
 * 消息"确实不存在了,留着上一句是说谎。其余情况一律只增不洗(见
 * `deriveSessionLastMessagePreview` 规则 5)。
 */
export function applySessionListProjectionToMeta<
  TMeta extends { messageCount?: number; lastMessagePreview?: string },
>(meta: TMeta, update: CoreSessionListProjectionUpdate): TMeta {
  if (typeof update.messageCount === 'number') meta.messageCount = update.messageCount

  if (update.messageCount === 0) {
    delete meta.lastMessagePreview
    return meta
  }

  const preview = deriveSessionLastMessagePreview(update.lastMessage, update.previewLength)
  if (preview !== undefined) meta.lastMessagePreview = preview
  return meta
}

export function applySessionName<TSession extends { name: string }>(
  session: TSession,
  name: string,
): TSession {
  session.name = name
  return session
}

export function applySessionPin<TSession extends { isPinned?: boolean }>(
  session: TSession,
  isPinned: boolean,
): TSession {
  session.isPinned = isPinned
  return session
}

export function applySessionArchiveState<TSession extends { isArchived?: boolean; archivedAt?: number }>(
  session: TSession,
  isArchived: boolean,
  archivedAt?: number | null,
): TSession {
  session.isArchived = isArchived
  if (isArchived && archivedAt) {
    session.archivedAt = archivedAt
  } else if (!isArchived) {
    delete session.archivedAt
  }
  return session
}

export function applySessionPermissionMode<TMode, TSession extends { permissionMode?: TMode }>(
  session: TSession,
  permissionMode: TMode,
): TSession {
  session.permissionMode = permissionMode
  return session
}

export function applySessionWorkingDirectory<
  TSession extends { workingDirectory?: string; workingDirectoryRoots?: string[] },
>(
  session: TSession,
  workingDirectory: string | null,
  options: NormalizeWorkingDirectoryRootsOptions = {},
): TSession {
  const expand = options.expandPath ?? ((value: string) => value)
  if (workingDirectory === null || workingDirectory === '') {
    delete session.workingDirectory
  } else {
    session.workingDirectory = expand(workingDirectory)
  }
  session.workingDirectoryRoots = normalizeWorkingDirectoryRoots(session.workingDirectoryRoots, {
    ...options,
    active: session.workingDirectory,
  })
  return session
}

export function applySessionWorkingDirectoryRoots<
  TSession extends { workingDirectory?: string; workingDirectoryRoots?: string[] },
>(
  session: TSession,
  roots: string[],
  options: NormalizeWorkingDirectoryRootsOptions = {},
): TSession {
  session.workingDirectoryRoots = normalizeWorkingDirectoryRoots(roots, {
    ...options,
    active: session.workingDirectory,
  })
  return session
}

export function applyInheritedSessionWorkingDirectory<
  TSession extends { workingDirectory?: string; workingDirectoryRoots?: string[] },
>(
  session: TSession,
  workingDirectory: string,
  options: NormalizeWorkingDirectoryRootsOptions = {},
): TSession {
  const expand = options.expandPath ?? ((value: string) => value)
  session.workingDirectory = expand(workingDirectory)
  session.workingDirectoryRoots = normalizeWorkingDirectoryRoots(session.workingDirectoryRoots, {
    ...options,
    active: session.workingDirectory,
  })
  return session
}

export function normalizeSessionVariables<TVariable extends CoreContextVariableInput>(
  variables: TVariable[],
  now = Date.now(),
): CoreNormalizedContextVariable[] {
  return variables.map(variable => ({
    name: variable.name,
    value: variable.value,
    values: variable.values,
    // type/scope/state 属于变量的身份而不是装饰:少写一个,重载回来的就是
    // 另一个变量(类型退回 string、状态层的变量退回"看不见")。
    type: variable.type,
    scope: variable.scope,
    state: variable.state,
    description: variable.description,
    updatedAt: variable.updatedAt ?? now,
  }))
}

export function applySessionVariables<
  TSession extends { variables?: CoreContextVariableInput[] },
  TVariable extends CoreContextVariableInput,
>(
  session: TSession,
  variables: TVariable[],
  now = Date.now(),
): TSession {
  session.variables = normalizeSessionVariables(variables, now)
  return session
}

export function applySessionPromptContext<TSession extends { promptContext?: unknown | null }>(
  session: TSession,
  promptContext: TSession['promptContext'],
): TSession {
  session.promptContext = promptContext
  return session
}

export function applySessionSummary<
  TSession extends {
    summary?: string
    summaryUpToMessageId?: string
    summaryCreatedAt?: number
    updatedAt: number
  },
>(
  session: TSession,
  summary: string,
  summaryUpToMessageId: string,
  now = Date.now(),
): TSession {
  session.summary = summary
  session.summaryUpToMessageId = summaryUpToMessageId
  session.summaryCreatedAt = now
  session.updatedAt = now
  return session
}

/**
 * An explicit model choice — the picker, not the per-message auto-stamp. The
 * pin is what lets an agent's model binding know whether there is a user
 * decision to defer to (docs/design/agent-capability-profile.md A1.4).
 */
export function applySessionModel<
  TSession extends { lastProvider?: string; lastModel?: string; modelPinned?: boolean },
>(
  session: TSession,
  provider: string,
  model: string,
  options: { pinned?: boolean } = {},
): TSession {
  session.lastProvider = provider
  session.lastModel = model
  if (options.pinned !== undefined) session.modelPinned = options.pinned || undefined
  return session
}

export function applySessionAgent<TSession extends { agentId?: string }>(
  session: TSession,
  agentId: string,
  defaultAgentId: string,
): TSession {
  session.agentId = agentId || defaultAgentId
  return session
}

export function applyDefaultAgentIdToSessionMetas<TMeta extends CoreSessionMeta>(
  metas: TMeta[],
  defaultAgentId: string,
): Array<TMeta & { agentId: string }> {
  return metas.map(meta => ({
    ...meta,
    agentId: meta.agentId || defaultAgentId,
  }))
}

export function extractSessionMeta<TMessage extends CoreSessionMessage>(
  session: Omit<CoreSession<TMessage>, 'messages'>,
  messages: readonly TMessage[],
  options: SessionMetaExtractOptions<TMessage> = {},
): CoreSessionMeta {
  const firstUserMessage = messages.find(message => message.role === 'user')
  const previewLength = options.previewLength ?? 100
  const previewText = firstUserMessage
    ? getDisplayContent(firstUserMessage, options).slice(0, previewLength)
    : undefined
  // 最后一条"说过的话"。整份 meta 本来就是按全量消息算的,所以这一步不新增
  // 任何读 —— 与写侧那批增量维护点算的是同一格(同一个纯函数)。
  const lastMessagePreview = deriveSessionLastMessagePreview(
    findLastPreviewableMessage(messages),
  )

  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    parentSessionId: session.parentSessionId,
    branchFromMessageId: session.branchFromMessageId,
    agentId: session.agentId || options.defaultAgentId,
    memoryProfileId: session.memoryProfileId,
    originIdentityKey: session.originIdentityKey,
    lastConnector: session.lastConnector,
    lastSentAt: session.lastSentAt,
    lastModel: session.lastModel,
    lastProvider: session.lastProvider,
    modelPinned: session.modelPinned,
    permissionMode: session.permissionMode,
    isPinned: session.isPinned,
    isArchived: session.isArchived,
    archivedAt: session.archivedAt,
    workspaceId: session.workspaceId,
    ...(session.app ? { app: session.app } : {}),
    messageCount: messages.length,
    previewText,
    ...(lastMessagePreview !== undefined ? { lastMessagePreview } : {}),
  }
}

/**
 * 一组消息里最后一条"说过的话"(user / assistant)。写侧那批增量维护点手上
 * 已经有那一条,只有全量重算(`extractSessionMeta`)与整份替换才需要倒着找。
 */
export function findLastPreviewableMessage<
  TMessage extends CoreSessionPreviewMessageSource,
>(messages: readonly TMessage[]): TMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (PREVIEWABLE_MESSAGE_ROLES.has(messages[index].role)) return messages[index]
  }
  return undefined
}

function getDisplayContent<TMessage extends CoreSessionMessage>(
  message: TMessage,
  options: SessionMetaExtractOptions<TMessage>,
): string {
  if (options.displayContentForMessage) {
    return options.displayContentForMessage(message)
  }
  return typeof message.content === 'string' ? message.content : ''
}
