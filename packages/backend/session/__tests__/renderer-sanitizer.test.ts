import { describe, expect, it } from 'vitest'
import {
  sanitizeOnethingMessageForRenderer,
  sanitizeOnethingMessagesForRenderer,
  sanitizeOnethingMessagesForRendererResult,
  sanitizeOnethingSessionForRenderer,
  sanitizeOnethingSessionForRendererResult,
} from '../renderer-sanitizer.js'

describe('renderer sanitizer', () => {
  it('keeps message identity when no provider data is present', () => {
    const message = {
      id: 'message-1',
      contentParts: [{ type: 'text', content: 'hello' }],
    }

    expect(sanitizeOnethingMessageForRenderer(message)).toBe(message)
  })

  it('removes provider data content parts from renderer projections', () => {
    const message = {
      id: 'message-1',
      contentParts: [
        { type: 'text', content: 'visible' },
        { type: 'provider-data', provider: 'codex', encryptedReasoning: 'secret' },
        { type: 'reasoning', content: 'also visible' },
      ],
    }

    expect(sanitizeOnethingMessageForRenderer(message)).toEqual({
      id: 'message-1',
      contentParts: [
        { type: 'text', content: 'visible' },
        { type: 'reasoning', content: 'also visible' },
      ],
    })
  })

  /**
   * F9:"这次到底剥没剥"由函数自己带回来。从前靠 `messages === session.messages`
   * 比引用 —— 命令面 COW 之后上游随时会换数组,身份判断恒为假,于是每次都整份复制。
   */
  it('reports changed explicitly instead of leaving it to reference identity', () => {
    const clean = [{ id: 'm1', contentParts: [{ type: 'text', content: 'visible' }] }]
    const dirty = [{ id: 'm2', contentParts: [{ type: 'provider-data', provider: 'codex' }] }]

    expect(sanitizeOnethingMessagesForRendererResult(clean).changed).toBe(false)
    expect(sanitizeOnethingMessagesForRendererResult(dirty).changed).toBe(true)

    // 同一份内容换一个数组容器(COW 的日常):判据只看内容,不看身份。
    const session = { id: 's1', messages: [...clean] }
    const result = sanitizeOnethingSessionForRendererResult(session)
    expect(result.changed).toBe(false)
    expect(result.value).toBe(session)
  })

  it('sanitizes message arrays and sessions only when needed', () => {
    const cleanMessage = {
      id: 'message-1',
      contentParts: [{ type: 'text', content: 'visible' }],
    }
    const secretMessage = {
      id: 'message-2',
      contentParts: [{ type: 'provider-data', provider: 'codex' }],
    }
    const session = {
      id: 'session-1',
      messages: [cleanMessage, secretMessage],
    }

    expect(sanitizeOnethingMessagesForRenderer([cleanMessage])).toBeDefined()
    expect(sanitizeOnethingSessionForRenderer(session)).toEqual({
      id: 'session-1',
      messages: [
        cleanMessage,
        {
          id: 'message-2',
          contentParts: [],
        },
      ],
    })
  })
})
