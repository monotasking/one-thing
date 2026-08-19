/**
 * 会话命令面 / 读门面的**测试替身** —— P0.2 调用点迁移的配套。
 *
 * 迁移之前,业务模块直接调 `store.addMessage` / `session.messages`,所以单测只要
 * `vi.mock('../store.js')` 一个假会话表就够了。迁移之后调用点走
 * `sessionCommands` / `sessionReads`,而它们**静态**依赖真的
 * `app/stores/sessions.ts`(→ settings → paths → 整棵存储树),在只想验一条协作
 * 规则的单测里把整个装配层拖进来既慢又要挨个补 mock。
 *
 * 于是给这两扇门一个共用替身:语义与生产实现逐条对齐(读回只读视图、写按命令
 * 落到同一份假会话上),测试只需要
 *
 * ```ts
 * vi.mock('../../session/reads.js', () => import('../session/testing/facade-mock.js'))
 * vi.mock('../../session/commands.js', () => import('../session/testing/facade-mock.js'))
 * bindSessionFacadeMock(id => mocks.sessions.get(id))
 * ```
 *
 * 两个 mock 指向**同一个模块**,所以读写共享同一份状态 —— 这正是生产里的关系。
 * 不放在 `__tests__/` 下,是因为 vitest 的 include 只收 `*.test.ts`,而这个文件
 * 需要被别的目录 import。
 */

// 替身吃的是各个单测自己的「假会话 / 假消息」形状(字段各不相同),所以这里刻意
// 不收口成 ChatMessage —— 收口的下场是每个测试都要为替身补一堆用不到的必填字段。
type AnyMessage = Record<string, any>
type AnySession = Record<string, any>

let resolveSession: (sessionId: string) => AnySession | undefined = () => undefined
let listSessions: () => AnySession[] = () => []
let readTranscript: (sessionId: string) => string | undefined = () => undefined

/**
 * 装上假会话表。`readTranscript` 给那些**真往临时店里写 jsonl** 的测试用
 * (迁移器、history 工具)—— 门面的两个抄本读法都从它取数。
 */
export function bindSessionFacadeMock(options: {
  getSession: (sessionId: string) => any
  getSessions?: () => any[]
  readTranscript?: (sessionId: string) => string | undefined
} | ((sessionId: string) => any)): void {
  if (typeof options === 'function') {
    resolveSession = options
    listSessions = () => []
    readTranscript = () => undefined
    return
  }
  resolveSession = options.getSession
  listSessions = options.getSessions ?? (() => [])
  readTranscript = options.readTranscript ?? (() => undefined)
}

function messagesOf(sessionId: string): AnyMessage[] {
  const session = resolveSession(sessionId)
  return Array.isArray(session?.messages) ? (session!.messages as AnyMessage[]) : []
}

export const sessionReads = {
  listMessages(sessionId: string, _options: { sanitize?: boolean } = {}) {
    return { messages: messagesOf(sessionId), changed: false }
  },
  pageMessages(request: { sessionId: string; anchor?: string; limit?: number }) {
    const messages = messagesOf(request.sessionId)
    const limit = request.limit ?? messages.length
    const page = request.anchor === 'tail' ? messages.slice(-limit) : messages.slice(0, limit)
    return { messages: page, hasMoreBefore: false, hasMoreAfter: false, totalCount: messages.length }
  },
  listUserMarkers(sessionId: string) {
    return messagesOf(sessionId)
      .map((message, index): AnyMessage => ({ ...message, index }))
      .filter(message => message.role === 'user')
  },
  getMessage(sessionId: string, messageId: string) {
    return messagesOf(sessionId).find(message => message.id === messageId)
  },
  findMessage(
    sessionId: string,
    predicate: (message: any, index: number) => boolean,
    options: { from?: 'start' | 'end' } = {},
  ) {
    const messages = messagesOf(sessionId)
    if (options.from === 'end') {
      for (let index = messages.length - 1; index >= 0; index--) {
        if (predicate(messages[index], index)) return messages[index]
      }
      return undefined
    }
    return messages.find(predicate)
  },
  getMessageIndex(sessionId: string, messageId: string) {
    return messagesOf(sessionId).findIndex(message => message.id === messageId)
  },
  countMessages(sessionId: string) {
    return messagesOf(sessionId).length
  },
  lastMessageOfRole(sessionId: string, role: string) {
    const messages = messagesOf(sessionId)
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === role) return messages[index]
    }
    return undefined
  },
  firstUserPreview(sessionId: string, maxLength = 120) {
    const first = messagesOf(sessionId).find(message => message.role === 'user')
    const text = typeof first?.content === 'string' ? first.content.trim() : ''
    if (!text) return undefined
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
  },
  sliceForHistory(
    sessionId: string,
    options: { upToMessageId?: string; includeUpTo?: boolean } = {},
  ) {
    const messages = messagesOf(sessionId)
    if (!options.upToMessageId) return messages
    const index = messages.findIndex(message => message.id === options.upToMessageId)
    if (index === -1) return messages
    return messages.slice(0, options.includeUpTo === false ? index : index + 1)
  },
  *iterateMessages(sessionId: string) {
    for (const message of messagesOf(sessionId)) yield message
  },
  *iterateMessagesRaw(sessionId: string) {
    for (const message of messagesOf(sessionId)) yield message
  },
  *scanSessionsForSearch(sessionIds?: readonly string[]) {
    if (!sessionIds) {
      for (const session of listSessions()) yield session
      return
    }
    for (const sessionId of sessionIds) {
      const session = resolveSession(sessionId)
      if (session) yield session
    }
  },
  readTranscriptFile(sessionId: string) {
    return readTranscript(sessionId)
  },
  readTranscriptBuffer(sessionId: string) {
    const text = readTranscript(sessionId)
    return text === undefined ? undefined : Buffer.from(text, 'utf-8')
  },
  getSession(sessionId: string) {
    return resolveSession(sessionId)
  },
}

export const sessionCommands = {
  appendMessage(sessionId: string, payload: { message: AnyMessage; stampCollab?: boolean }) {
    resolveSession(sessionId)?.messages?.push(payload.message)
  },
  upsertMessage(sessionId: string, payload: { message: AnyMessage }) {
    const messages = messagesOf(sessionId)
    const index = messages.findIndex(message => message.id === payload.message.id)
    if (index >= 0) messages[index] = payload.message
    else messages.push(payload.message)
    return true
  },
  patchMessage(
    sessionId: string,
    payload: { messageId: string; patch: Record<string, unknown> },
  ) {
    const message = messagesOf(sessionId).find(entry => entry.id === payload.messageId)
    if (!message) return false
    Object.assign(message, payload.patch)
    return true
  },
  appendContentPart(sessionId: string, payload: { messageId: string; part: unknown }) {
    const message = messagesOf(sessionId).find(entry => entry.id === payload.messageId)
    if (!message) return false
    message.contentParts = [...(message.contentParts ?? []), payload.part]
    return true
  },
  upsertStep(sessionId: string, payload: { messageId: string; step: any }) {
    const message = messagesOf(sessionId).find(entry => entry.id === payload.messageId)
    if (!message) return false
    const steps = (message.steps ?? []) as any[]
    const index = steps.findIndex(step => step.toolCallId && step.toolCallId === payload.step.toolCallId)
    message.steps = index >= 0
      ? steps.map((step, at) => (at === index ? { ...step, ...payload.step } : step))
      : [...steps, payload.step]
    return true
  },
  patchStep(
    sessionId: string,
    payload: { messageId: string; stepId: string; updates: Record<string, unknown> },
  ) {
    const message = messagesOf(sessionId).find(entry => entry.id === payload.messageId)
    if (!message) return false
    const steps = (message.steps ?? []) as any[]
    const index = steps.findIndex(step => step.id === payload.stepId)
    if (index < 0) return false
    message.steps = steps.map((step, at) => (at === index ? { ...step, ...payload.updates } : step))
    return true
  },
  patchStepsUsageByTurn(): string[] {
    return []
  },
  setToolCalls(sessionId: string, payload: { messageId: string; toolCalls: unknown[] }) {
    const message = messagesOf(sessionId).find(entry => entry.id === payload.messageId)
    if (!message) return false
    message.toolCalls = payload.toolCalls
    return true
  },
  truncateFrom(
    sessionId: string,
    payload: { messageId: string; inclusive: boolean; newContent?: string },
  ) {
    const session = resolveSession(sessionId)
    const messages = messagesOf(sessionId)
    const index = messages.findIndex(message => message.id === payload.messageId)
    if (index < 0 || !session) return false
    if (payload.inclusive) session.messages = messages.slice(0, index)
    else {
      const kept = messages.slice(0, index + 1)
      kept[index] = { ...kept[index], content: payload.newContent ?? '' }
      session.messages = kept
    }
    return true
  },
  deleteMessage(
    sessionId: string,
    payload: { messageId?: string; matchMarker?: (message: AnyMessage) => boolean },
  ) {
    const session = resolveSession(sessionId)
    const messages = messagesOf(sessionId)
    const index = payload.messageId !== undefined
      ? messages.findIndex(message => message.id === payload.messageId)
      : messages.findIndex(message => payload.matchMarker?.(message) === true)
    if (index < 0 || !session) return false
    session.messages = messages.filter((_, at) => at !== index)
    return true
  },
  async replaceAll(
    sessionId: string,
    payload: { messages: AnyMessage[]; reason: 'clear' | 'replaced' | 'normalize' },
  ) {
    const session = resolveSession(sessionId)
    if (!session) return { replaced: false, previousCount: 0 }
    const previousCount = messagesOf(sessionId).length
    session.messages = payload.messages
    return { replaced: true, previousCount }
  },
  repairOnLoad() {
    return false
  },
}

/** 生产模块还导出这两个名字;替身给出同名空壳,免得 mock 少键报错。 */
export function getSessionCommands() {
  return sessionCommands
}

export function createSessionCommands() {
  return sessionCommands
}
