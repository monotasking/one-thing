import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@onething/core/logging'
import {
  TelegramChannel,
  telegramUpdateToInboundMessage,
} from '../index.js'

function createFetchMock() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ ok: true, result: {} }),
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

describe('TelegramChannel', () => {
  it('maps Telegram text updates to gateway inbound messages', () => {
    expect(telegramUpdateToInboundMessage('telegram', {
      update_id: 1,
      message: {
        message_id: 10,
        date: 123,
        from: {
          id: 7,
          first_name: 'Alice',
          last_name: 'Chen',
          username: 'alice_c',
        },
        chat: { id: 42, type: 'private' },
        text: 'hello',
      },
    })).toEqual({
      channelId: 'telegram',
      userId: '7',
      conversationId: '42',
      text: 'hello',
      raw: {
        message_id: 10,
        date: 123,
        from: {
          id: 7,
          first_name: 'Alice',
          last_name: 'Chen',
          username: 'alice_c',
        },
        chat: { id: 42, type: 'private' },
        text: 'hello',
      },
      actor: {
        displayName: 'Alice Chen',
        handle: 'alice_c',
      },
    })

    expect(telegramUpdateToInboundMessage('telegram', {
      update_id: 2,
      message: {
        message_id: 11,
        date: 124,
        chat: { id: 42, type: 'private' },
      },
    })).toBeNull()
  })

  it('keeps group members as distinct users while replies route to the chat', () => {
    const inbound = telegramUpdateToInboundMessage('telegram', {
      update_id: 3,
      message: {
        message_id: 12,
        date: 125,
        from: { id: 7, first_name: 'Alice' },
        chat: { id: -100123, type: 'supergroup', title: 'Team' },
        text: 'hi from group',
      },
    })
    expect(inbound?.userId).toBe('7')
    expect(inbound?.conversationId).toBe('-100123')
  })

  it('sends text and typing through Telegram Bot API calls', async () => {
    const fetchMock = createFetchMock()
    const channel = new TelegramChannel({
      botToken: 'telegram-token',
      apiBaseUrl: 'https://telegram.example',
      fetch: fetchMock,
      logger: silentLogger(),
    })

    await channel.send({
      conversationId: '42',
      userId: '7',
      text: 'hello',
      raw: {},
    })
    await channel.typing({
      conversationId: '42',
      userId: '7',
      raw: {},
    })
    await channel.typing({
      conversationId: '42',
      userId: '7',
      raw: {},
      status: 'cancel',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('https://telegram.example/bottelegram-token/sendMessage')
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      chat_id: '42',
      text: 'hello',
    })
    expect(fetchMock.mock.calls[1][0]).toBe('https://telegram.example/bottelegram-token/sendChatAction')
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      chat_id: '42',
      action: 'typing',
    })
  })
})

/** L2:通道收的是结构化 `Logger`,不再是 console 形状。 */
function silentLogger(): Logger {
  const logger = {
    ns: 'gateway.telegram',
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    isLevelEnabled: () => true,
    child: () => logger,
  } as unknown as Logger
  return logger
}
