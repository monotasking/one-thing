import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetWechatSenderRateLimitForTests, sendText, sendTyping } from '../sender.js'
import type { WechatAuthState } from '../auth.js'

const originalFetch = globalThis.fetch

describe('Wechat sender', () => {
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      writable: true,
      configurable: true,
    })
    resetWechatSenderRateLimitForTests()
    vi.restoreAllMocks()
  })

  it('splits long fenced code into independently valid markdown messages', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 }))
    stubFetch(fetchMock)
    const body = Array.from({ length: 180 }, (_, index) => `console.log(${index})\n`).join('')

    await sendText(auth(), 'wechat-user', 'context-token', `Before\n\`\`\`ts\n${body}\`\`\`\nAfter`, {
      minSendIntervalMs: 0,
    })

    const segments = sentTextSegments(fetchMock)
    expect(segments.length).toBeGreaterThan(1)
    expect(segments.every(segment => segment.length <= 2000)).toBe(true)
    expect(segments.filter(segment => segment.includes('```')).every(hasBalancedFenceMarkers)).toBe(true)
    expect(segments.some(segment => segment.startsWith('```ts\n'))).toBe(true)
  })

  it('does not split inline links across messages', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 }))
    stubFetch(fetchMock)
    const text = `${'前缀 '.repeat(450)}[link](https://example.com/${'a'.repeat(120)}) 结束。`

    await sendText(auth(), 'wechat-user', 'context-token', text, {
      minSendIntervalMs: 0,
    })

    const segments = sentTextSegments(fetchMock)
    expect(segments.join('')).toBe(text)
    for (const segment of segments) {
      if (segment.includes('[link](')) {
        expect(segment).toContain(')')
      }
    }
  })

  it('retries sendmessage ret=-2 after a backoff delay', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ret: -2, errmsg: 'rate limited' }))
      .mockResolvedValueOnce(jsonResponse({ ret: 0 }))
    stubFetch(fetchMock)

    const sendPromise = sendText(auth(), 'wechat-user', 'context-token', 'hello', {
      minSendIntervalMs: 0,
    })
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await sendPromise

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('spaces adjacent sendmessage requests', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const callTimes: number[] = []
    const fetchMock = vi.fn(async () => {
      callTimes.push(Date.now())
      return jsonResponse({ ret: 0 })
    })
    stubFetch(fetchMock)
    const text = '词 '.repeat(1_100)

    const sendPromise = sendText(auth(), 'wechat-user', 'context-token', text)
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await sendPromise

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(1_000)
  })

  it('throws rich diagnostics when ret=-2 retries are exhausted', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn(async () => jsonResponse({ ret: -2, errmsg: '' }))
    stubFetch(fetchMock)

    const sendPromise = sendText(auth(), 'wechat-user', 'context-token', 'hello', {
      minSendIntervalMs: 0,
      maxRateLimitAttempts: 2,
      rateLimitRetryBaseMs: 1_000,
    })
    const assertion = expect(sendPromise).rejects.toThrow(
      /sendmessage ret=-2 errmsg= http=200 segment=1\/1 chars=5 response=\{"ret":-2,"errmsg":""\}/,
    )

    await vi.runAllTimersAsync()
    await assertion

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('sends typing cancel as iLink status 2', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ret: 0, typing_ticket: 'typing-ticket' }))
      .mockResolvedValueOnce(jsonResponse({ ret: 0 }))
    stubFetch(fetchMock)

    await sendTyping(auth(), 'wechat-user', 'context-token', 2)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://ilink.example.test/ilink/bot/sendtyping')
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      ilink_user_id: 'wechat-user',
      typing_ticket: 'typing-ticket',
      status: 2,
      base_info: {
        channel_version: '2.4.6',
        bot_agent: 'onething-gateway/0.0.0',
      },
    })
  })
})

function auth(): WechatAuthState {
  return {
    botToken: 'bot-token',
    baseUrl: 'https://ilink.example.test',
  }
}

function sentTextSegments(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(call => {
    const init = call[1] as RequestInit
    const body = JSON.parse(String(init.body)) as {
      msg: { item_list: Array<{ text_item?: { text?: string } }> }
    }
    return String(body.msg.item_list[0]?.text_item?.text ?? '')
  })
}

function stubFetch(fetchMock: typeof fetch): void {
  Object.defineProperty(globalThis, 'fetch', {
    value: fetchMock,
    writable: true,
    configurable: true,
  })
}

function hasBalancedFenceMarkers(text: string): boolean {
  const matches = text.match(/^```/gm) ?? []
  return matches.length % 2 === 0
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 })
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}
