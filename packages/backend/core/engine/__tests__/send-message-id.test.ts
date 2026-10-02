/**
 * 用户消息的 id 由**发送方预铸**(`SendMessageCommand.messageId`,2026-09-13)。
 *
 * 病:引擎在**落库之前**就把正文换掉了 —— `@/abs/x.lua` 展成一整份 34KB 的
 * `<file>` 块(`expandFileMentions`),`/skill:x` 展成整份 SKILL.md。发送方那一格
 * 乐观气泡从前靠「正文逐字相同」认领自己那条消息,于是在这两条路上**永远认不上**,
 * 屏幕上留下第二条用户气泡,而且 AI 回完它还在。
 *
 * 治法是认领靠身份:发送方铸 id、随命令带过来,引擎照用。这只文件钉的是引擎
 * 这一半的三条 —— 照用 / 形不对就当没给 / 撞上已有消息就当没给,**三条都不抛**。
 *
 * 全部用 `persistOnly`:这一单只关心「那条用户消息拿到了哪个 id」,不关心
 * 后面开不开流(开流要一整套 provider 解析,与这条判据无关)。
 */
import { describe, expect, it, vi } from 'vitest'
import { CoreStreamEngine } from '../core-stream-engine.js'

function createEngine(seed: Array<{ id: string; role: string; content: string }> = []) {
  const messages: unknown[] = [...seed]
  let n = 0
  const runtime = {
    store: {
      getSession: () => ({ id: 's1', messages, workingDirectory: '/repo' }),
      listMessages: () => messages,
      getMessage: (_sessionId: string, messageId: string) =>
        messages.find((message) => (message as { id?: string }).id === messageId),
      getSettings: () => ({}),
      addMessage: vi.fn((_sessionId: string, message: unknown) => { messages.push(message) }),
    },
    // 引擎自己铸出来的 id 一眼认得出来,免得用例靠「不等于那个」间接判。
    ids: { createId: () => `engine-${++n}` },
    clock: { now: () => 1000 },
    skills: { getForSession: () => [] },
    media: { ingestMessageAttachments: () => {} },
    prompts: {
      resolveReferences: (raw: string) => ({ modelContent: raw, displayContent: raw, contentParts: undefined }),
    },
  }
  const engine = new CoreStreamEngine(runtime as never)
  engine.setEventBus({
    emit: async () => {},
    onAnySession: () => () => {},
  } as never)
  return { engine, messages }
}

const lastId = (messages: unknown[]) => (messages[messages.length - 1] as { id: string }).id

describe('SendMessageCommand.messageId', () => {
  it('带一个成形的 id → 用户消息就是那个 id', async () => {
    const { engine, messages } = createEngine()

    await engine.handleSendMessage(
      's1',
      { content: '@/abs/x.lua', messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', persistOnly: true },
      {} as never,
    )

    expect(messages).toHaveLength(1)
    expect(lastId(messages)).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  })

  it('不带 → 引擎自己铸(今天的行为一个字没变)', async () => {
    const { engine, messages } = createEngine()

    await engine.handleSendMessage('s1', { content: '一句话', persistOnly: true }, {} as never)

    expect(lastId(messages)).toBe('engine-1')
  })

  it.each([
    ['太短', 'abc'],
    ['太长', 'x'.repeat(65)],
    ['带空格', 'aaaaaaaa bbbb'],
    ['带斜杠(它会进路径 / DOM 属性)', '../../etc/passwd'],
    ['带点', 'aaaaaaaa.bbbb'],
    ['空串', ''],
    ['不是字符串', 12345678 as unknown as string],
  ])('形不对(%s)→ 当作没给,引擎自己铸,**不抛**', async (_label, bad) => {
    const { engine, messages } = createEngine()

    await expect(
      engine.handleSendMessage('s1', { content: '一句话', messageId: bad, persistOnly: true }, {} as never),
    ).resolves.toBeUndefined()

    expect(messages).toHaveLength(1)
    expect(lastId(messages)).toBe('engine-1')
  })

  it('撞上会话里已有的消息 → 当作没给,那条真消息一个字不动', async () => {
    const taken = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', role: 'user', content: '早就说过的话' }
    const { engine, messages } = createEngine([taken])

    await engine.handleSendMessage(
      's1',
      { content: '新的一句', messageId: taken.id, persistOnly: true },
      {} as never,
    )

    expect(messages).toHaveLength(2)
    expect(messages[0]).toBe(taken)
    expect(lastId(messages)).toBe('engine-1')
  })

  it('连发两条各带各的 id,两条都照用', async () => {
    const { engine, messages } = createEngine()

    await engine.handleSendMessage('s1', { content: '一', messageId: 'id-one-aaaa', persistOnly: true }, {} as never)
    await engine.handleSendMessage('s1', { content: '二', messageId: 'id-two-bbbb', persistOnly: true }, {} as never)

    expect(messages.map((m) => (m as { id: string }).id)).toEqual(['id-one-aaaa', 'id-two-bbbb'])
  })
})
