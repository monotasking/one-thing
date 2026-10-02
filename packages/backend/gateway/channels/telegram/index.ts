import type { Channel, InboundMessage, OutboundMessage, TypingMessage } from '../../core/channel.js'
import { resolveGatewayLogger, type Logger } from '../../core/logging.js'
import type { TelegramApiResponse, TelegramMessage, TelegramUpdate } from './types.js'

export const DEFAULT_TELEGRAM_API_BASE_URL = 'https://api.telegram.org'

const POLL_TIMEOUT_SECONDS = 35
const POLL_ABORT_PADDING_MS = 5_000
const ERROR_RETRY_MS = 3_000
const MAX_TEXT_LENGTH = 4096

type FetchLike = typeof fetch

export interface TelegramChannelOptions {
  botToken: string
  apiBaseUrl?: string
  pollTimeoutSeconds?: number
  fetch?: FetchLike
  /** 构造时注入(L2):不给 = 进程级工厂给的 `gateway.telegram`。 */
  logger?: Logger
}

export class TelegramChannel implements Channel {
  readonly id = 'telegram'
  private readonly apiBaseUrl: string
  private readonly pollTimeoutSeconds: number
  private readonly fetchImpl: FetchLike
  private readonly logger: Logger
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null
  private running = false
  private offset = 0
  private abortController: AbortController | null = null
  private loopPromise: Promise<void> | null = null

  constructor(private readonly options: TelegramChannelOptions) {
    if (!options.botToken.trim()) {
      throw new Error('TelegramChannel requires TELEGRAM_BOT_TOKEN or GATEWAY_TELEGRAM_BOT_TOKEN')
    }
    this.apiBaseUrl = (options.apiBaseUrl || DEFAULT_TELEGRAM_API_BASE_URL).replace(/\/$/, '')
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? POLL_TIMEOUT_SECONDS
    this.fetchImpl = options.fetch ?? fetch
    this.logger = resolveGatewayLogger(options.logger, 'telegram')
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.loopPromise = this.loop()
  }

  async stop(): Promise<void> {
    this.running = false
    this.abortController?.abort()
    await this.loopPromise
    this.loopPromise = null
  }

  async send(msg: OutboundMessage): Promise<void> {
    const text = msg.text.trim()
    if (!text) return

    for (const segment of splitText(text, MAX_TEXT_LENGTH)) {
      await this.callTelegram('sendMessage', {
        chat_id: msg.conversationId,
        text: segment,
      })
    }
  }

  async typing(msg: TypingMessage): Promise<void> {
    if (msg.status === 'cancel') return

    await this.callTelegram('sendChatAction', {
      chat_id: msg.conversationId,
      action: 'typing',
    }).catch(error => {
      this.logger.warn('send typing failed', { conversationId: msg.conversationId }, error)
    })
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.getUpdates()
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1)
          const inbound = telegramUpdateToInboundMessage(this.id, update)
          if (!inbound) continue

          try {
            await this.handler?.(inbound)
          } catch (error) {
            this.logger.error('message handler failed', {}, error)
          }
        }
      } catch (error) {
        if (!this.running) return
        if (isAbortError(error)) continue

        this.logger.error('poll failed', {}, error)
        await delay(ERROR_RETRY_MS)
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, this.pollTimeoutSeconds * 1000 + POLL_ABORT_PADDING_MS)
    this.abortController = controller

    try {
      const response = await this.callTelegram<TelegramUpdate[]>('getUpdates', {
        offset: this.offset || undefined,
        timeout: this.pollTimeoutSeconds,
        allowed_updates: ['message'],
      }, controller.signal)
      return response
    } finally {
      clearTimeout(timeout)
      if (this.abortController === controller) {
        this.abortController = null
      }
    }
  }

  private async callTelegram<T = unknown>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}/bot${this.options.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const data = await response.json().catch(() => ({})) as TelegramApiResponse<T>
    if (!response.ok || data.ok !== true) {
      throw new Error(`Telegram ${method} failed: ${data.description || response.statusText || response.status}`)
    }
    return data.result as T
  }
}

export function telegramUpdateToInboundMessage(
  channelId: string,
  update: TelegramUpdate,
): InboundMessage | null {
  const message = update.message
  if (!message?.text?.trim()) return null

  const actor = telegramMessageActor(message)
  return {
    channelId,
    userId: String(message.from?.id ?? message.chat.id),
    conversationId: String(message.chat.id),
    text: message.text,
    raw: message,
    ...(actor ? { actor } : {}),
  }
}

function telegramMessageActor(message: TelegramMessage): InboundMessage['actor'] | undefined {
  const displayName = joinName(message.from?.first_name, message.from?.last_name)
    || joinName(message.chat.first_name, message.chat.last_name)
    || message.chat.title?.trim()
  const handle = message.from?.username?.trim() || message.chat.username?.trim()
  const actor: NonNullable<InboundMessage['actor']> = {}
  if (displayName) actor.displayName = displayName
  if (handle) actor.handle = handle
  return Object.keys(actor).length ? actor : undefined
}

function joinName(first?: string, last?: string): string | undefined {
  const value = [first, last]
    .map(part => part?.trim())
    .filter(Boolean)
    .join(' ')
  return value || undefined
}

function splitText(text: string, maxLength: number): string[] {
  const segments: string[] = []
  for (let index = 0; index < text.length; index += maxLength) {
    segments.push(text.slice(index, index + maxLength))
  }
  return segments.length ? segments : ['']
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
