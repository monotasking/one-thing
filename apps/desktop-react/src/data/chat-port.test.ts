import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileToken } from '@shared/prompt-references'
import { SESSION_COMMAND_TYPES } from '@shared/events/session-commands'
import { createMemoryTransport, createOnethingClient } from '@onething/client'
import type { RpcRequest } from '@shared/ipc/rpc'

/**
 * 出站那道展开(D3 波二)。
 *
 * 这一层验的**不是**一个纯函数(`expandFileTokens` 是 `@shared` 的,那边有自己的
 * 用例),而是**那条缝接对了没有**:一条含 `{{file:…}}` 的草稿交到端口手上,
 * 落到命令总线上的那个信封里必须已经是 `@<路径>`。
 *
 * 所以这里换掉的是**传输**(而不是端口本身)—— 端口用的是**真实现**,不然验的
 * 就是假货。C1 起换传输就是 `@onething/client` 的内存替身:同一个
 * `createOnethingClient`、同一条 `client.api(router)`,只是底下没有网 ——
 * 于是这份用例顺带成了「换传输不改上层」的一个活证据。
 */

const transport = createMemoryTransport({
  handlers: {
    'sessionEvents.listRaw': () => ({ events: [] }),
    'sessionEvents.readBlob': () => ({}),
    'session-command.emit': () => ({ success: true }),
  },
})
const client = createOnethingClient({ transport })

vi.mock('../platform/connection', () => ({
  whenConnected: async () => undefined,
  onethingClient: async () => client,
}))

const { chatPort, configureChatPort } = await import('./chat-port')

// setup.ts 默认装了一只假端口 —— 这个文件要的是真实现,所以先把它摘掉。
configureChatPort(undefined)

/**
 * 这一条用例里打到命令总线上的那些信封。
 *
 * `transport.calls` 是整份进程级流水(它就是「换传输不改上层」的证据本身),
 * 所以每条用例记一次水位再切片 —— 比清空一张只读表干净。
 */
let watermark = 0
function callsSince(): readonly RpcRequest[] {
  return transport.calls.slice(watermark)
}
function emittedEnvelopes(): unknown[] {
  return callsSince()
    .filter(call => call.domain === 'session-command' && call.method === 'emit')
    .map(call => call.payload)
}

beforeEach(() => {
  watermark = transport.calls.length
})

afterAll(() => {
  // 别把真实现留给同一进程里的别的用例。
  configureChatPort(undefined)
})

describe('sendMessage:交出去之前把文件 token 展开', () => {
  it('`{{file:<绝对路径>}}` 就地变回 `@<绝对路径>`,前后文一个字不动', async () => {
    const port = await chatPort()
    await port.sendMessage('s1', `读一下 ${createFileToken('/repo/src/a.ts')} 这个文件`)

    expect(emittedEnvelopes()).toEqual([
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
    expect((emittedEnvelopes()[0] as { command: { content: string } }).command.content).toBe(
      '比 @/repo/a.ts 和 @/repo/b.ts',
    )
  })

  it('没有 token 的一句话逐字原样过去 —— 展开不是一次「清洗」', async () => {
    const port = await chatPort()
    await port.sendMessage('s1', '把 {{ 这种花括号 }} 原样留着')
    expect((emittedEnvelopes()[0] as { command: { content: string } }).command.content).toBe(
      '把 {{ 这种花括号 }} 原样留着',
    )
  })

  it('retryMessage 不涉:那条消息早已落账,重跑的是账本上的原文', async () => {
    const port = await chatPort()
    await port.retryMessage('s1', 'm1')
    expect(emittedEnvelopes()).toEqual([
      { sessionId: 's1', command: { type: SESSION_COMMAND_TYPES.RETRY_MESSAGE, messageId: 'm1' } },
    ])
  })
})

describe('C1:域客户端由 router 泛型取用,信封上写的是契约里的名字', () => {
  it('sendMessage 打的是 `session-command.emit`,listRaw 打的是 `sessionEvents.listRaw`', async () => {
    const port = await chatPort()
    await port.sendMessage('s1', 'hi')
    await port.listRaw('s1')
    const signatures = callsSince().map(call => `${call.domain}.${call.method}`)
    expect(signatures).toEqual(['session-command.emit', 'sessionEvents.listRaw'])
  })

  it('推送面上两条名字各分各的:session:event 与 session:stream 不串台', async () => {
    const port = await chatPort()
    const events: string[] = []
    const offEvent = port.onSessionEvent(() => events.push('event'))
    const offStream = port.onSessionStream(() => events.push('stream'))

    transport.emit({ name: 'session:stream', data: {} })
    transport.emit({ name: 'session:event', data: {} })
    // 内存传输的队列是异步取的 —— 让出一拍再看。
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(events).toEqual(['stream', 'event'])
    offEvent()
    offStream()
  })
})
