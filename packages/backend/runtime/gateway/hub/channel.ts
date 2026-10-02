export interface InboundActor {
  displayName?: string
  handle?: string
  avatarUrl?: string
  locale?: string
  timezone?: string
}

export interface InboundMessage {
  channelId: string
  /** Identity of the person who sent the message (e.g. Telegram from.id). */
  userId: string
  /** Where replies are routed (e.g. Telegram chat.id). Equals userId in DMs. */
  conversationId: string
  text: string
  raw: unknown
  actor?: InboundActor
}

export interface OutboundMessage {
  conversationId: string
  userId: string
  text: string
  raw: unknown
}

export interface TypingMessage {
  conversationId: string
  userId: string
  raw: unknown
  status?: 'typing' | 'cancel'
}

export interface Channel {
  readonly id: string
  start(): Promise<void>
  stop(): Promise<void>
  send(msg: OutboundMessage): Promise<void>
  typing?(msg: TypingMessage): Promise<void>
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void
}
