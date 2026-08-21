import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/ipc.js'
import {
  encodeMessagePageCursor,
  getMessagesPageFromArray,
  getUserMessageMarkersFromArray,
} from '../pagination.js'
import {
  getMessagesPageFromJson,
  resolveSessionMessagesPage,
  resolveSessionUserMessageMarkers,
} from '@onething/core/session'

function message(index: number, role: ChatMessage['role'] = 'assistant'): ChatMessage {
  return {
    id: `msg-${index}`,
    role,
    content: `message ${index}`,
    timestamp: index,
  }
}

describe('session message pagination', () => {
  const messages = Array.from({ length: 10 }, (_, index) =>
    message(index + 1, (index + 1) % 3 === 0 ? 'user' : 'assistant')
  )

  it('returns the tail page in chronological order', () => {
    const page = getMessagesPageFromArray(messages, {
      sessionId: 's1',
      anchor: 'tail',
      limit: 4,
    })

    expect(page.success).toBe(true)
    expect(page.messages?.map(m => m.id)).toEqual(['msg-7', 'msg-8', 'msg-9', 'msg-10'])
    expect(page.hasMoreBefore).toBe(true)
    expect(page.hasMoreAfter).toBe(false)
  })

  it('returns older messages before a cursor in chronological order', () => {
    const cursor = encodeMessagePageCursor({
      sessionId: 's1',
      seq: 7,
      includeAnchor: false,
    })

    const page = getMessagesPageFromArray(messages, {
      sessionId: 's1',
      cursor,
      direction: 'older',
      limit: 3,
    })

    expect(page.success).toBe(true)
    expect(page.messages?.map(m => m.id)).toEqual(['msg-4', 'msg-5', 'msg-6'])
    expect(page.hasMoreBefore).toBe(true)
    expect(page.hasMoreAfter).toBe(true)
  })

  it('returns newer messages after a cursor in chronological order', () => {
    const cursor = encodeMessagePageCursor({
      sessionId: 's1',
      seq: 4,
      includeAnchor: false,
    })

    const page = getMessagesPageFromArray(messages, {
      sessionId: 's1',
      cursor,
      direction: 'newer',
      limit: 3,
    })

    expect(page.success).toBe(true)
    expect(page.messages?.map(m => m.id)).toEqual(['msg-5', 'msg-6', 'msg-7'])
    expect(page.hasMoreBefore).toBe(true)
    expect(page.hasMoreAfter).toBe(true)
  })

  it('returns an empty successful page for empty sessions', () => {
    const page = getMessagesPageFromArray([], {
      sessionId: 's1',
      anchor: 'tail',
    })

    expect(page.success).toBe(true)
    expect(page.messages).toEqual([])
    expect(page.nextCursor).toBeNull()
    expect(page.backwardsCursor).toBeNull()
    expect(page.totalCount).toBe(0)
  })

  it('returns a window around an anchor message', () => {
    const page = getMessagesPageFromArray(messages, {
      sessionId: 's1',
      anchor: {
        messageId: 'msg-5',
        before: 2,
        after: 1,
      },
    })

    expect(page.success).toBe(true)
    expect(page.messages?.map(m => m.id)).toEqual(['msg-3', 'msg-4', 'msg-5', 'msg-6'])
  })

  it('rejects cursors from another session', () => {
    const cursor = encodeMessagePageCursor({
      sessionId: 'other',
      seq: 7,
      includeAnchor: false,
    })

    const page = getMessagesPageFromArray(messages, {
      sessionId: 's1',
      cursor,
      limit: 3,
    })

    expect(page.success).toBe(false)
  })

  it('builds user message markers without full message bodies', () => {
    const markers = getUserMessageMarkersFromArray(messages)

    expect(markers.map(marker => [marker.id, marker.seq])).toEqual([
      ['msg-3', 3],
      ['msg-6', 6],
      ['msg-9', 9],
    ])
  })

  it('byte-scans tail pages when message content contains escaped quotes and braces', () => {
    const trickyMessages = [
      message(1, 'user'),
      {
        ...message(2),
        content: 'plain middle message',
      },
      {
        ...message(3),
        content: 'tool result contains "json": {"closing":"}","nested":{"value":"ok"}}',
      },
      {
        ...message(4),
        content: 'tail content with escaped "quotes" before {"a":"b"} and a lone } brace',
      },
      message(5),
    ]

    const page = getMessagesPageFromJson<ChatMessage>({
      sessionId: 's1',
      anchor: 'tail',
      limit: 2,
    }, JSON.stringify({ id: 's1', messages: trickyMessages }, null, 2))

    expect(page?.success).toBe(true)
    expect(page?.messages?.map(item => item.id)).toEqual(['msg-4', 'msg-5'])
    expect(page?.messages?.[0]?.content).toContain('escaped "quotes"')
  })

  it('resolves page sources and migration scheduling in core', () => {
    const request = { sessionId: 's1', limit: 2 }
    const sqlite = resolveSessionMessagesPage<ChatMessage>({
      request,
      getSqlitePage: () => ({
        success: true,
        messages: [message(1)],
      }),
      getJsonByteScanPage: () => {
        throw new Error('json byte-scan should be lazy')
      },
    })
    expect(sqlite).toMatchObject({
      source: 'sqlite',
      shouldScheduleMigration: false,
      response: { success: true },
    })

    const byteScan = resolveSessionMessagesPage<ChatMessage>({
      request,
      getJsonByteScanPage: () => ({
        success: true,
        messages: [message(2)],
      }),
    })
    expect(byteScan).toMatchObject({
      source: 'json-byte-scan',
      shouldScheduleMigration: true,
    })

    const fullFallback = resolveSessionMessagesPage<ChatMessage>({
      request,
      getSessionMessages: () => messages,
    })
    expect(fullFallback).toMatchObject({
      source: 'json-full-fallback',
      shouldScheduleMigration: true,
      response: { success: true, totalCount: 10 },
    })
    expect(fullFallback.response.messages?.map(item => item.id)).toEqual(['msg-9', 'msg-10'])

    expect(resolveSessionMessagesPage<ChatMessage>({
      request,
      getSessionMessages: () => undefined,
    })).toMatchObject({
      source: 'missing',
      shouldScheduleMigration: false,
      response: { success: false, error: 'Session not found' },
    })
  })

  it('resolves user message marker sources and migration scheduling in core', () => {
    const sqliteMarkers = resolveSessionUserMessageMarkers<ChatMessage>({
      getSqliteMarkers: () => [{ id: 'msg-3', seq: 3, timestamp: 3, preview: 'message 3' }],
      getSessionMessages: () => {
        throw new Error('session messages should be lazy')
      },
    })
    expect(sqliteMarkers).toEqual({
      markers: [{ id: 'msg-3', seq: 3, timestamp: 3, preview: 'message 3' }],
      source: 'sqlite',
      shouldScheduleMigration: false,
    })

    const fallback = resolveSessionUserMessageMarkers<ChatMessage>({
      getSessionMessages: () => messages,
    })
    expect(fallback).toMatchObject({
      source: 'json-full-fallback',
      shouldScheduleMigration: true,
    })
    expect(fallback.markers?.map(marker => marker.id)).toEqual(['msg-3', 'msg-6', 'msg-9'])

    expect(resolveSessionUserMessageMarkers<ChatMessage>({
      getSessionMessages: () => undefined,
    })).toEqual({
      source: 'missing',
      shouldScheduleMigration: false,
    })
  })
})
