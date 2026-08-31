import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileToken } from '@shared/prompt-references'
import { SESSION_COMMAND_TYPES } from '@shared/events/session-commands'

/**
 * 出站那道展开(D3 波二)。
 *
 * 这一层验的**不是**一个纯函数(`expandFileTokens` 是 `@shared` 的,那边有自己的
 * 用例),而是**那条缝接对了没有**:一条含 `{{file:…}}` 的草稿交到端口手上,
 * 落到命令总线上的那个信封里必须已经是 `@<路径>`。
 *
 * 所以这里换掉的是 `@renderer/platform` 那几只(而不是端口本身)—— 端口用的是
 * **真实现**,不然验的就是假货。
 */

const emitted: unknown[] = []

vi.mock('@renderer/platform', () => ({
  platformApi: {
    onSessionEvent: () => () => undefined,
    onSessionStream: () => () => undefined,
  },
}))
vi.mock('@renderer/platform/session-events-client', () => ({
  sessionEventsApi: {
    listRaw: async () => ({ events: [] }),
    readBlob: async () => ({}),
  },
}))
vi.mock('@renderer/platform/session-command-client', () => ({
  sessionCommands: {
    emit: async (envelope: unknown) => {
      emitted.push(envelope)
      return { success: true }
    },
  },
}))
vi.mock('../platform/connection', () => ({ whenConnected: async () => undefined }))

const { chatPort, configureChatPort } = await import('./chat-port')

// setup.ts 默认装了一只假端口 —— 这个文件要的是真实现,所以先把它摘掉。
configureChatPort(undefined)

beforeEach(() => {
  emitted.length = 0
})

afterAll(() => {
  // 别把真实现留给同一进程里的别的用例。
  configureChatPort(undefined)
})

describe('sendMessage:交出去之前把文件 token 展开', () => {
  it('`{{file:<绝对路径>}}` 就地变回 `@<绝对路径>`,前后文一个字不动', async () => {
    const port = await chatPort()
    await port.sendMessage('s1', `读一下 ${createFileToken('/repo/src/a.ts')} 这个文件`)

    expect(emitted).toEqual([
      {
        sessionId: 's1',
        command: {
          type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
          content: '读一下 @/repo/src/a.ts 这个文件',
        },
      },
    ])
  })

  it('一句话里几枚就展开几枚', async () => {
    const port = await chatPort()
    await port.sendMessage(
      's1',
      `比 ${createFileToken('/repo/a.ts')} 和 ${createFileToken('/repo/b.ts')}`,
    )
    expect((emitted[0] as { command: { content: string } }).command.content).toBe(
      '比 @/repo/a.ts 和 @/repo/b.ts',
    )
  })

  it('没有 token 的一句话逐字原样过去 —— 展开不是一次「清洗」', async () => {
    const port = await chatPort()
    await port.sendMessage('s1', '把 {{ 这种花括号 }} 原样留着')
    expect((emitted[0] as { command: { content: string } }).command.content).toBe(
      '把 {{ 这种花括号 }} 原样留着',
    )
  })

  it('retryMessage 不涉:那条消息早已落账,重跑的是账本上的原文', async () => {
    const port = await chatPort()
    await port.retryMessage('s1', 'm1')
    expect(emitted).toEqual([
      { sessionId: 's1', command: { type: SESSION_COMMAND_TYPES.RETRY_MESSAGE, messageId: 'm1' } },
    ])
  })
})
