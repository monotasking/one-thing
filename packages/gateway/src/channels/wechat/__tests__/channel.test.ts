import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@onething/core/logging'
import { DEFAULT_ILINK_BASE_URL, type WechatAuthState } from '../ilink/auth.js'
import { WechatChannel } from '../index.js'
import type { WeixinMessage } from '../ilink/types.js'

describe('WechatChannel', () => {
  it('follows QR login IDC redirects and saves the redirected base URL', async () => {
    const savedStates: WechatAuthState[] = []
    const pollQRCodeStatus = vi.fn()
      .mockResolvedValueOnce({
        status: 'scaned_but_redirect',
        redirect_host: 'redirect.weixin.qq.com',
      })
      .mockResolvedValueOnce({
        status: 'confirmed',
        bot_token: 'bot-token',
        ilink_user_id: 'user-id',
        ilink_bot_id: 'bot-id',
      })

    const channel = new WechatChannel({
      loadAuthState: vi.fn(async () => null),
      saveAuthState: vi.fn(async state => {
        savedStates.push(state)
      }),
      getQRCode: vi.fn(async () => ({
        qrcode: 'qr-token',
        qrcode_img_content: 'https://liteapp.weixin.qq.com/q/mock',
      })),
      pollQRCodeStatus,
      delay: vi.fn(async () => {}),
      logger: silentLogger(),
    })

    const auth = await (channel as unknown as {
      resolveAuthState(): Promise<WechatAuthState>
    }).resolveAuthState()

    expect(auth).toEqual({
      botToken: 'bot-token',
      baseUrl: 'https://redirect.weixin.qq.com',
      ilinkUserId: 'user-id',
      ilinkBotId: 'bot-id',
    })
    expect(savedStates).toEqual([auth])
    expect(pollQRCodeStatus).toHaveBeenNthCalledWith(1, 'qr-token', DEFAULT_ILINK_BASE_URL)
    expect(pollQRCodeStatus).toHaveBeenNthCalledWith(2, 'qr-token', 'https://redirect.weixin.qq.com')
  })

  it('fails QR login with a clear message when pair-code verification is required', async () => {
    const channel = new WechatChannel({
      loadAuthState: vi.fn(async () => null),
      saveAuthState: vi.fn(),
      getQRCode: vi.fn(async () => ({
        qrcode: 'qr-token',
        qrcode_img_content: 'https://liteapp.weixin.qq.com/q/mock',
      })),
      pollQRCodeStatus: vi.fn(async () => ({ status: 'need_verifycode' })),
      delay: vi.fn(async () => {}),
      logger: silentLogger(),
    })

    await expect((channel as unknown as {
      resolveAuthState(): Promise<WechatAuthState>
    }).resolveAuthState()).rejects.toThrow('pair-code verification')
  })

  it('starts the poller with the saved auth base URL and maps inbound text messages', async () => {
    let inboundHandler: ((msg: WeixinMessage) => Promise<void>) | undefined
    const start = vi.fn(async () => {})
    const channel = new WechatChannel({
      loadAuthState: vi.fn(async () => ({
        botToken: 'saved-token',
        baseUrl: 'https://saved.weixin.example',
      })),
      createPoller: vi.fn((auth, onMessage) => {
        expect(auth).toMatchObject({
          botToken: 'saved-token',
          baseUrl: 'https://saved.weixin.example',
        })
        inboundHandler = onMessage
        return {
          start,
          stop: vi.fn(async () => {}),
        }
      }),
      logger: silentLogger(),
    })
    const onMessage = vi.fn(async () => {})
    channel.onMessage(onMessage)

    await channel.start()
    await inboundHandler?.({
      from_user_id: 'wechat-user',
      context_token: 'context-token',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    })

    expect(start).toHaveBeenCalled()
    expect(onMessage).toHaveBeenCalledWith({
      channelId: 'wechat:default',
      userId: 'wechat-user',
      conversationId: 'wechat-user',
      text: 'hello',
      raw: expect.objectContaining({
        from_user_id: 'wechat-user',
        context_token: 'context-token',
      }),
    })
  })

  it('maps inbound WeChat identity metadata when iLink includes it', async () => {
    let inboundHandler: ((msg: WeixinMessage) => Promise<void>) | undefined
    const logger = silentLogger()
    const channel = new WechatChannel({
      loadAuthState: vi.fn(async () => ({
        botToken: 'saved-token',
        baseUrl: 'https://saved.weixin.example',
      })),
      createPoller: vi.fn((_auth, onMessage) => {
        inboundHandler = onMessage
        return {
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
        }
      }),
      logger,
    })
    const onMessage = vi.fn(async () => {})
    channel.onMessage(onMessage)

    await channel.start()
    await inboundHandler?.({
      from_user_id: 'wechat-user',
      from_user_name: 'alice_wechat',
      remark_name: 'Alice Chen',
      avatar_url: 'https://wechat.example/avatar.png',
      context_token: 'context-token',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    })

    expect(onMessage).toHaveBeenCalledWith({
      channelId: 'wechat:default',
      userId: 'wechat-user',
      conversationId: 'wechat-user',
      text: 'hello',
      raw: expect.objectContaining({
        from_user_id: 'wechat-user',
        remark_name: 'Alice Chen',
      }),
      actor: {
        displayName: 'Alice Chen',
        handle: 'alice_wechat',
        avatarUrl: 'https://wechat.example/avatar.png',
      },
    })
    expect(logger.debug).toHaveBeenCalledWith('inbound identity metadata', expect.objectContaining({
      fromUserId: 'wechat-user',
      matchedIdentityFields: expect.arrayContaining(['remark_name', 'from_user_name', 'avatar_url']),
      identityFields: expect.objectContaining({
        remark_name: 'Alice Chen',
        from_user_name: 'alice_wechat',
        avatar_url: 'https://wechat.example/avatar.png',
      }),
      rawKeys: expect.arrayContaining(['from_user_id', 'from_user_name', 'remark_name']),
    }))
  })

  it('uses the local account id in the channel id for multi-account routing', async () => {
    let inboundHandler: ((msg: WeixinMessage) => Promise<void>) | undefined
    const channel = new WechatChannel({
      accountId: 'work',
      loadAuthState: vi.fn(async () => ({
        botToken: 'saved-token',
        baseUrl: 'https://saved.weixin.example',
      })),
      createPoller: vi.fn((_auth, onMessage) => {
        inboundHandler = onMessage
        return {
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
        }
      }),
      logger: silentLogger(),
    })
    const onMessage = vi.fn(async () => {})
    channel.onMessage(onMessage)

    await channel.start()
    await inboundHandler?.({
      from_user_id: 'wechat-user',
      context_token: 'context-token',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    })

    expect(channel.id).toBe('wechat:work')
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'wechat:work',
      userId: 'wechat-user',
      conversationId: 'wechat-user',
      text: 'hello',
    }))
  })

  it('maps typing cancel signals to iLink sendtyping status 2', async () => {
    const sendTyping = vi.fn(async () => {})
    const channel = new WechatChannel({
      loadAuthState: vi.fn(async () => ({
        botToken: 'saved-token',
        baseUrl: 'https://saved.weixin.example',
      })),
      createPoller: vi.fn(() => ({
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      })),
      sendTyping,
      logger: silentLogger(),
    })
    await channel.start()

    const raw: WeixinMessage = {
      from_user_id: 'wechat-user',
      context_token: 'context-token',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    }

    await channel.typing({ conversationId: 'wechat-user', userId: 'wechat-user', raw })
    await channel.typing({ conversationId: 'wechat-user', userId: 'wechat-user', raw, status: 'cancel' })

    expect(sendTyping).toHaveBeenNthCalledWith(
      1,
      { botToken: 'saved-token', baseUrl: 'https://saved.weixin.example' },
      'wechat-user',
      'context-token',
      1,
    )
    expect(sendTyping).toHaveBeenNthCalledWith(
      2,
      { botToken: 'saved-token', baseUrl: 'https://saved.weixin.example' },
      'wechat-user',
      'context-token',
      2,
    )
  })
})

/**
 * L2:通道现在收的是结构化 `Logger`(不再是 console 形状)。`child()` 返回自身,
 * 断言才能落在同一组 spy 上 —— 通道构造时会 `.child({ accountId })`。
 */
function silentLogger(): Logger {
  const logger = {
    ns: 'gateway.wechat',
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
