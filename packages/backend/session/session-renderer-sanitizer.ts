/**
 * 交给 renderer 的那一份消息:剥掉 `provider-data` part。
 *
 * F9(P0.2 区 ②):**"动没动"由函数自己说,不再靠 `===` 比引用**。从前
 * `sanitizeOnethingSessionForRenderer` 用 `messages === session.messages` 判断
 * "这次 sanitize 是否真的改了东西",在 COW 之后是一条会静默失真的判据 ——
 * 只要上游哪一步换了数组(命令面 COW 就是天天在换),身份判断恒为假,于是每次
 * 都整份复制一遍会话。所以三个入口都多出一个 `*Result` 版本,显式带回
 * `changed`;不带 `Result` 的旧名字签名一字不改,只是取 `.value`。
 */

export interface OnethingRendererContentPartLike {
  type?: string
}

export interface OnethingRendererMessageLike {
  contentParts?: OnethingRendererContentPartLike[]
}

export interface OnethingRendererSessionLike<TMessage extends OnethingRendererMessageLike = OnethingRendererMessageLike> {
  messages: TMessage[]
}

/** `value` 是结果(没变就是原对象),`changed` 是这次到底有没有剥掉东西。 */
export interface OnethingRendererSanitizeResult<TValue> {
  value: TValue
  changed: boolean
}

function sanitizeContentParts<TPart extends OnethingRendererContentPartLike>(
  parts: TPart[] | undefined,
): OnethingRendererSanitizeResult<TPart[] | undefined> {
  if (!parts?.some(part => part.type === 'provider-data')) return { value: parts, changed: false }
  return { value: parts.filter(part => part.type !== 'provider-data'), changed: true }
}

export function sanitizeOnethingMessageForRendererResult<TMessage extends OnethingRendererMessageLike>(
  message: TMessage,
): OnethingRendererSanitizeResult<TMessage> {
  const contentParts = sanitizeContentParts(message.contentParts)
  if (!contentParts.changed) return { value: message, changed: false }
  return { value: { ...message, contentParts: contentParts.value } as TMessage, changed: true }
}

export function sanitizeOnethingMessagesForRendererResult<TMessage extends OnethingRendererMessageLike>(
  messages: TMessage[] | undefined,
): OnethingRendererSanitizeResult<TMessage[] | undefined> {
  if (!messages?.some(message => message.contentParts?.some(part => part.type === 'provider-data'))) {
    return { value: messages, changed: false }
  }
  return {
    value: messages.map(message => sanitizeOnethingMessageForRendererResult(message).value),
    changed: true,
  }
}

export function sanitizeOnethingSessionForRendererResult<
  TMessage extends OnethingRendererMessageLike,
  TSession extends OnethingRendererSessionLike<TMessage>,
>(session: TSession): OnethingRendererSanitizeResult<TSession> {
  const messages = sanitizeOnethingMessagesForRendererResult(session.messages)
  if (!messages.changed) return { value: session, changed: false }
  return { value: { ...session, messages: messages.value } as TSession, changed: true }
}

export function sanitizeOnethingMessageForRenderer<TMessage extends OnethingRendererMessageLike>(
  message: TMessage,
): TMessage {
  return sanitizeOnethingMessageForRendererResult(message).value
}

export function sanitizeOnethingMessagesForRenderer<TMessage extends OnethingRendererMessageLike>(
  messages: TMessage[] | undefined,
): TMessage[] | undefined {
  return sanitizeOnethingMessagesForRendererResult(messages).value
}

export function sanitizeOnethingSessionForRenderer<
  TMessage extends OnethingRendererMessageLike,
  TSession extends OnethingRendererSessionLike<TMessage>,
>(session: TSession): TSession {
  return sanitizeOnethingSessionForRendererResult(session).value
}
