/**
 * **会话列表投影的两格**(共享层读侧补齐 E 批):`lastMessagePreview` 与
 * `messageCount`。
 *
 * 这里只测**纯函数那一层**(`core/session/store-helpers.ts`)—— 写侧那批维护点
 * 落在 `backend/session/__tests__/commands.test.ts`,读侧的形状落在
 * `packages/backend/rpc/__tests__/`。三层分开是故意的:规则改了该红的是这只文件,
 * 而不是十个接线测试一起变黄。
 */
import { describe, expect, it } from 'vitest'
import {
  SESSION_LAST_MESSAGE_PREVIEW_LENGTH,
  applySessionListProjectionToMeta,
  deriveSessionLastMessagePreview,
  extractSessionMeta,
  findLastPreviewableMessage,
} from '@onething/core/session'

describe('deriveSessionLastMessagePreview —— 预览文本的唯一产地', () => {
  it('取 user / assistant 的正文', () => {
    expect(deriveSessionLastMessagePreview({ role: 'user', content: '帮我看下这个 bug' }))
      .toBe('帮我看下这个 bug')
    expect(deriveSessionLastMessagePreview({ role: 'assistant', content: '好的,我看看' }))
      .toBe('好的,我看看')
  })

  it('工具结果 / 系统标记不算"说过的话"', () => {
    expect(deriveSessionLastMessagePreview({ role: 'tool', content: '{"ok":true}' })).toBeUndefined()
    expect(deriveSessionLastMessagePreview({ role: 'system', content: 'Files changed' })).toBeUndefined()
  })

  it('多模态只取 text 那些格,图片 / 推理 / 工具调用一律不进', () => {
    const preview = deriveSessionLastMessagePreview({
      role: 'user',
      content: '',
      contentParts: [
        { type: 'image', url: 'data:image/png;base64,AAAA' },
        { type: 'text', content: '这张图里' },
        { type: 'reasoning', content: '我在想什么' },
        { type: 'tool-call', toolCalls: [] },
        { type: 'text', content: '有什么' },
      ],
    })
    expect(preview).toBe('这张图里 有什么')
  })

  it('content 是字符串时优先它 —— contentParts 不再看一遍', () => {
    expect(deriveSessionLastMessagePreview({
      role: 'assistant',
      content: '正文',
      contentParts: [{ type: 'text', content: '另一份' }],
    })).toBe('正文')
  })

  it('空白折成单个空格再 trim', () => {
    expect(deriveSessionLastMessagePreview({ role: 'user', content: '  第一行\n\n\t第二行   ' }))
      .toBe('第一行 第二行')
  })

  it('全空白 / 空正文 → undefined(调用方据此保留上一格,不洗成空串)', () => {
    expect(deriveSessionLastMessagePreview({ role: 'assistant', content: '' })).toBeUndefined()
    expect(deriveSessionLastMessagePreview({ role: 'assistant', content: '   \n ' })).toBeUndefined()
    expect(deriveSessionLastMessagePreview({ role: 'assistant', contentParts: [] })).toBeUndefined()
    expect(deriveSessionLastMessagePreview(undefined)).toBeUndefined()
  })

  it('默认截到 120 个字符', () => {
    const preview = deriveSessionLastMessagePreview({ role: 'user', content: '啊'.repeat(500) })
    expect(preview).toHaveLength(SESSION_LAST_MESSAGE_PREVIEW_LENGTH)
    expect(SESSION_LAST_MESSAGE_PREVIEW_LENGTH).toBe(120)
  })

  it('截断按**码点**边界 —— emoji 不会被劈成半个代理对', () => {
    // '👩‍💻' 之类的组合序列先不谈;这里钉的是单个非 BMP 码点(UTF-16 占两格)。
    const preview = deriveSessionLastMessagePreview({ role: 'user', content: '🐛'.repeat(10) }, 3)
    expect(preview).toBe('🐛🐛🐛')
    expect([...(preview ?? '')]).toHaveLength(3)
    expect(preview).not.toContain('�')
    // 朴素的 `.slice(0, 3)` 会切出半个代理对 —— 这一行是反证。
    expect('🐛'.repeat(10).slice(0, 3)).not.toBe(preview)
  })

  it('不足长度时原样返回,不补省略号', () => {
    expect(deriveSessionLastMessagePreview({ role: 'user', content: 'hi' }, 120)).toBe('hi')
  })
})

describe('findLastPreviewableMessage', () => {
  it('倒着找第一条 user / assistant', () => {
    const messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'tool', content: 'c' },
      { role: 'system', content: 'd' },
    ]
    expect(findLastPreviewableMessage(messages)).toBe(messages[1])
  })

  it('一条都没有时回 undefined', () => {
    expect(findLastPreviewableMessage([{ role: 'tool', content: 'x' }])).toBeUndefined()
    expect(findLastPreviewableMessage([])).toBeUndefined()
  })
})

describe('applySessionListProjectionToMeta', () => {
  it('两格一起落', () => {
    const meta: Record<string, unknown> = { id: 's', updatedAt: 1 }
    applySessionListProjectionToMeta(meta as never, {
      messageCount: 3,
      lastMessage: { role: 'user', content: '最近说到这儿' },
    })
    expect(meta.messageCount).toBe(3)
    expect(meta.lastMessagePreview).toBe('最近说到这儿')
  })

  it('给不出预览时**保留上一格** —— 流式助手占位不许把用户那句话洗掉', () => {
    const meta: Record<string, unknown> = { lastMessagePreview: '用户上一句', messageCount: 2 }
    applySessionListProjectionToMeta(meta as never, {
      messageCount: 3,
      // 刚开出来的流式助手占位:正文还是空的。
      lastMessage: { role: 'assistant', content: '' },
    })
    expect(meta.lastMessagePreview).toBe('用户上一句')
    expect(meta.messageCount).toBe(3)
  })

  it('messageCount === 0 是唯一会清掉预览的情形(会话被清空)', () => {
    const meta: Record<string, unknown> = { lastMessagePreview: '旧的一句', messageCount: 9 }
    applySessionListProjectionToMeta(meta as never, { messageCount: 0, lastMessage: undefined })
    expect(meta.messageCount).toBe(0)
    expect('lastMessagePreview' in meta).toBe(false)
  })

  it('不给 messageCount 就不动那一格', () => {
    const meta: Record<string, unknown> = { messageCount: 7 }
    applySessionListProjectionToMeta(meta as never, {
      lastMessage: { role: 'user', content: '只更预览' },
    })
    expect(meta.messageCount).toBe(7)
    expect(meta.lastMessagePreview).toBe('只更预览')
  })
})

describe('extractSessionMeta 也带上这一格', () => {
  const session = { id: 's1', name: 'n', createdAt: 1, updatedAt: 2 }

  it('全量重算时预览 = 最后一条 user/assistant', () => {
    const meta = extractSessionMeta(session, [
      { id: 'm1', role: 'user', content: '第一句' },
      { id: 'm2', role: 'assistant', content: '最后一句' },
      { id: 'm3', role: 'tool', content: '工具结果不算' },
    ])
    // previewText 仍然是**第一条用户消息** —— 两格是并列的两件事,不是新旧版本。
    expect(meta.previewText).toBe('第一句')
    expect(meta.lastMessagePreview).toBe('最后一句')
    expect(meta.messageCount).toBe(3)
  })

  it('一条能预览的都没有时,那一格干脆缺席(不写 undefined)', () => {
    const meta = extractSessionMeta(session, [{ id: 'm1', role: 'system', content: 'x' }])
    expect('lastMessagePreview' in meta).toBe(false)
  })
})
