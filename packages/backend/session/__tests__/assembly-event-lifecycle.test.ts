import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '@shared/ipc.js'
import { materializeChatMessages } from '@onething/core/session'
import { flushSessionEventLog, readSessionLogEventsSync } from '../event-log.js'
import { installSessionLayerForTest } from '../testing/session-layer.js'
import { writeSessionEvent } from '../event-writer.js'
import { getLiveSessionProjection } from '../projection-cache.js'

describe('session event assembly lifecycle', () => {
  it('releases history recipes and rejects retained read and command handles before touching stores', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-session-handles-'))
    const previousPath = process.env.ONETHING_STORE_PATH
    process.env.ONETHING_STORE_PATH = root
    const session: ChatSession = {
      id: 'history-session', name: 'History', createdAt: 1, updatedAt: 1,
      messages: [{ id: 'user-1', role: 'user', content: 'hello', timestamp: 1 }],
    }
    const patchSession = vi.fn(() => true)
    const ports = {
      store: {
        getSession: () => session,
        getSessionMessages: () => session.messages,
        getSessionMessagesPage: () => ({ success: true, messages: [] }),
        getSessionRaw: () => session,
        getSessionUserMessageMarkers: () => [],
        getSessions: () => [session],
        readSessionTranscriptFile: () => undefined,
      },
      commandPorts: {
        getSession: () => session,
        saveSession: () => {},
        updateSessionsIndexMeta: () => true,
        flushSessionSave: async () => {},
        patchSession,
      },
    }
    const first = installSessionLayerForTest(ports)
    let second: ReturnType<typeof installSessionLayerForTest> | undefined
    try {
      const oldReads = first.sessionLayer.reads
      const oldCommands = first.sessionLayer.commands
      const history = vi.fn(() => ['first-owner-history'])
      oldReads.configureHistoryBuilder({ fromMessages: history, recipe: () => ({}) })
      expect(oldReads.sliceForHistory(session.id, { upToMessageId: 'user-1' })).toEqual(['first-owner-history'])
      await first.dispose()
      second = installSessionLayerForTest(ports)
      expect(second.sessionLayer.reads.sliceForHistory(session.id, { upToMessageId: 'user-1' })).toEqual(session.messages)
      expect(history).toHaveBeenCalledTimes(1)
      expect(() => oldReads.getSession(session.id)).toThrow('disposed')
      expect(() => oldCommands.patchSession(session.id, { patch: { name: 'stale mutation' } })).toThrow('disposed')
      expect(patchSession).not.toHaveBeenCalled()
    } finally {
      await second?.dispose()
      await first.dispose()
      if (previousPath === undefined) delete process.env.ONETHING_STORE_PATH
      else process.env.ONETHING_STORE_PATH = previousPath
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('recovers, writes and reassembles without retaining the previous projections or observers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-session-owner-'))
    const previousPath = process.env.ONETHING_STORE_PATH
    process.env.ONETHING_STORE_PATH = root
    const id = `lifecycle-${path.basename(root)}`
    const first = installSessionLayerForTest()
    let second: ReturnType<typeof installSessionLayerForTest> | undefined
    try {
      const oldNotifications: number[] = []
      first.sessionLayer.events.writer.observe((_id, event) => oldNotifications.push(event.seq))
      writeSessionEvent(id, 'session/created', { sessionId: id })
      writeSessionEvent(id, 'user/message', {
        message: { id: 'user-1', role: 'user', content: 'before restart', timestamp: 1 },
      }, { surfaceOp: 'append' })
      const oldProjection = getLiveSessionProjection(id)
      writeSessionEvent(id, 'run/start', {
        runId: 'interrupted-run', kind: 'send', assistantMessageId: 'assistant-1', timestamp: 2,
      }, { surfaceOp: 'append' })
      writeSessionEvent(id, 'tool/call', {
        runId: 'interrupted-run', callId: 'tool-1', name: 'bash', argumentsRaw: '{}', messageId: 'assistant-1',
      })
      await flushSessionEventLog(id)
      const oldSnapshot = structuredClone(oldProjection)
      const oldCount = oldNotifications.length
      await first.dispose()

      // No reset helper: disposal itself must release every real observer and map.
      second = installSessionLayerForTest()
      const notifications: string[] = []
      second.sessionLayer.events.writer.observe((_id, event) => notifications.push(event.type))
      const restored = getLiveSessionProjection(id)
      expect(restored).not.toBe(oldProjection)
      expect(notifications).toEqual(['tool/result', 'run/end'])
      const recoveredAssistant = materializeChatMessages(restored).messages.find(message => message.id === 'assistant-1')
      expect(recoveredAssistant).toBeDefined()
      expect(recoveredAssistant?.isStreaming).not.toBe(true)

      writeSessionEvent(id, 'user/message', {
        message: { id: 'user-2', role: 'user', content: 'after restart', timestamp: 3 },
      }, { surfaceOp: 'append' })
      expect(notifications).toEqual(['tool/result', 'run/end', 'user/message'])
      expect(second.sessionLayer.events.surface.view(id).seqOf('user-2')).toBeDefined()
      expect(getLiveSessionProjection(id).byMessageId.has('user-2')).toBe(true)
      expect(oldProjection).toEqual(oldSnapshot)
      expect(oldNotifications).toHaveLength(oldCount)
      expect(() => first.sessionLayer.events.writer.write(id, 'session/created', { sessionId: id }))
        .toThrow('disposed')

      await flushSessionEventLog(id)
      expect(readSessionLogEventsSync(id).filter(event => event.type === 'run/end'))
        .toMatchObject([{ data: { runId: 'interrupted-run', outcome: 'interrupted' } }])
      await second.dispose()
      second = undefined
      expect(() => writeSessionEvent(id, 'session/created', { sessionId: id })).toThrow('sessionLayer')
    } finally {
      await second?.dispose()
      await first.dispose()
      if (previousPath === undefined) delete process.env.ONETHING_STORE_PATH
      else process.env.ONETHING_STORE_PATH = previousPath
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
