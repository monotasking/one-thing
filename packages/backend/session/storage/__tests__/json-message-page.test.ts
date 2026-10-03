import { describe, it, expect } from 'vitest'
import { getMessagesPageFromJson } from '../json-message-page.js'
import type { GetSessionMessagesPageRequest, StoredChatMessage } from '../types.js'

const SESSION_ID = 'sess-json-page'

function buildLegacySessionJson(count: number): string {
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i + 1}`,
    timestamp: 1000 + i,
  }))
  // 兼容 legacy 整文件 JSON:messages 前后各放一些字段,确保字节扫描定位正确。
  return JSON.stringify({ id: SESSION_ID, name: 'demo', messages, updatedAt: 123 })
}

interface SuccessPage {
  success: true
  messages: Array<StoredChatMessage & { seq?: number }>
  nextCursor: string | null
  backwardsCursor: string | null
  hasMoreBefore?: boolean
  hasMoreAfter?: boolean
  totalCount?: number
}

function page(json: string, request: Partial<GetSessionMessagesPageRequest>): SuccessPage {
  const res = getMessagesPageFromJson<StoredChatMessage>({
    sessionId: SESSION_ID,
    ...request,
  } as GetSessionMessagesPageRequest, json)
  if (!res || res.success === false) {
    throw new Error(`page failed: ${res ? res.error : 'null'}`)
  }
  return res as SuccessPage
}

describe('getMessagesPageFromJson global seq', () => {
  it('fast tail page assigns global ascending seq, not local descending', () => {
    const json = buildLegacySessionJson(20)
    const tail = page(json, { limit: 5 })
    // 最后 5 条,seq 应为全局 16..20 升序
    expect(tail.messages.map(m => m.id)).toEqual(['m16', 'm17', 'm18', 'm19', 'm20'])
    expect(tail.messages.map(m => (m as { seq: number }).seq)).toEqual([16, 17, 18, 19, 20])
    expect(tail.hasMoreBefore).toBe(true)
    expect(tail.hasMoreAfter ?? false).toBe(false)
  })

  it('fast older page seq matches what the slow anchor path reports', () => {
    const json = buildLegacySessionJson(20)
    const tail = page(json, { limit: 5 })
    const older = page(json, { cursor: tail.nextCursor!, direction: 'older', limit: 5 })
    // tail 是 16..20,older 应是 11..15
    expect(older.messages.map(m => m.id)).toEqual(['m11', 'm12', 'm13', 'm14', 'm15'])
    expect(older.messages.map(m => (m as { seq: number }).seq)).toEqual([11, 12, 13, 14, 15])
  })

  it('backwardsCursor + direction:newer returns newer messages, not the session start', () => {
    const json = buildLegacySessionJson(20)
    // 先跳到中间的历史窗口(older 两次),再用 backwardsCursor 往新翻。
    const tail = page(json, { limit: 5 })
    const older = page(json, { cursor: tail.nextCursor!, direction: 'older', limit: 5 })
    // older 覆盖 11..15;它的 backwardsCursor 指向 seq=15(includeAnchor)。
    const newer = page(json, { cursor: older.backwardsCursor!, direction: 'newer', limit: 5 })
    // 关键回归:必须返回 15 及其之后,而不是会话开头的 m1..m5。
    expect(newer.messages[0].id).not.toBe('m1')
    expect(newer.messages.map(m => m.id)).toEqual(['m15', 'm16', 'm17', 'm18', 'm19'])
  })
})
