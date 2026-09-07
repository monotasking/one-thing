import { describe, expect, it, vi } from 'vitest'
import {
  runOnethingSchedulerAgentTask,
  type OnethingSchedulerAgentTaskEventEnvelope,
  type OnethingSchedulerAgentTaskEventBus,
  type OnethingSchedulerAgentTaskSession,
  type OnethingSchedulerAgentTaskSessionStore,
  type OnethingSchedulerAgentTaskStreamHost,
} from '../agent-task-runner.js'
import type { OnethingSchedulerRunDetail } from '../run-detail.js'
import type { SchedulerTaskContext } from '../types.js'
import type { OnethingSchedulerUserTask } from '../user-tasks.js'

function createContext(signal = new AbortController().signal): SchedulerTaskContext {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    reason: 'manual',
    scheduledFor: 100,
    startedAt: 100,
    signal,
  }
}

function createTask(): OnethingSchedulerUserTask {
  return {
    id: 'task-1',
    name: 'Morning task',
    prompt: 'Summarize the inbox',
    agentId: 'agent-1',
    enabled: true,
    schedule: { kind: 'interval', everyMs: 60_000 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function createSessions(session: OnethingSchedulerAgentTaskSession): OnethingSchedulerAgentTaskSessionStore {
  return {
    getCurrentSessionId: () => 'previous-session',
    createSession: (sessionId) => {
      session.id = sessionId
      return session
    },
    updateSessionAgent: vi.fn(),
    updateSessionWorkingDirectory: vi.fn(),
    updateSessionArchived: vi.fn(),
    setCurrentSessionId: vi.fn(),
    getSession: () => session,
  }
}

describe('runOnethingSchedulerAgentTask', () => {
  it('does not subscribe or start execution when the host cannot persist the new session owner', async () => {
    const emit = vi.fn()
    const onAny = vi.fn()
    await expect(runOnethingSchedulerAgentTask('task-1', createContext(), {
      getTask: () => createTask(),
      getStreamHost: () => ({ hasBoundSender: () => true, abort: vi.fn() }),
      eventBus: { emit, onAny },
      sessions: { ...createSessions({ id: '', messages: [] }), createSession: () => { throw new Error('owner save failed') } },
      saveRunDetail: detail => detail,
    })).rejects.toThrow('owner save failed')
    expect(onAny).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })
  it('saves a skipped run when no stream host is available', async () => {
    const saved: OnethingSchedulerRunDetail[] = []
    const streamHost: OnethingSchedulerAgentTaskStreamHost = {
      hasBoundSender: () => false,
      abort: vi.fn(),
    }

    const result = await runOnethingSchedulerAgentTask('task-1', createContext(), {
      getTask: () => createTask(),
      getStreamHost: () => streamHost,
      eventBus: {
        onAny: vi.fn(),
        emit: vi.fn(),
      },
      sessions: createSessions({ id: '', messages: [] }),
      saveRunDetail: detail => {
        saved.push(detail)
        return detail
      },
      createId: () => `id-${saved.length}`,
      now: () => 100,
    })

    expect(result).toMatchObject({
      status: 'skipped',
      runId: 'run-1',
      skippedReason: 'main-window-unavailable',
    })
    expect(saved[0]).toMatchObject({
      status: 'skipped',
      ok: true,
      error: 'Scheduled task skipped because no app window is available to host the stream.',
    })
    expect(streamHost.abort).not.toHaveBeenCalled()
  })

  it('runs a scheduler task through injected session, event, and stream adapters', async () => {
    let ownerInitialized = false
    let eventHandler: ((envelope: OnethingSchedulerAgentTaskEventEnvelope) => void) | undefined
    let id = 0
    let now = 100
    const saved: OnethingSchedulerRunDetail[] = []
    const session: OnethingSchedulerAgentTaskSession = { id: '', messages: [] }
    const streamHost: OnethingSchedulerAgentTaskStreamHost = {
      hasBoundSender: () => true,
      abort: vi.fn(),
    }
    const eventBus: OnethingSchedulerAgentTaskEventBus = {
      onAny: (_sessionId, handler) => {
        expect(ownerInitialized).toBe(true)
        eventHandler = handler
        return vi.fn()
      },
      emit: async (_sessionId, event) => {
        if (event.type === 'command:send-message') {
          eventHandler?.({
            timestamp: 110,
            event: { type: 'stream:start', assistantMessageId: 'assistant-1', model: 'test-model' },
          })
          session.messages = [{
            id: 'assistant-1',
            role: 'assistant',
            content: 'All done',
            steps: [{
              id: 'step-1',
              title: 'Think',
              status: 'done',
              timestamp: 112,
              result: 'ok',
            }],
            toolCalls: [{
              id: 'tool-1',
              toolName: 'read',
              status: 'succeeded',
              arguments: { file: 'README.md' },
              result: 'done',
            }],
          }]
          now = 130
          eventHandler?.({
            timestamp: 130,
            event: { type: 'stream:complete', data: { usage: { totalTokens: 10 } } },
          })
        }
      },
    }

    const result = await runOnethingSchedulerAgentTask('task-1', createContext(), {
      getTask: () => createTask(),
      getStreamHost: () => streamHost,
      eventBus,
      initialOwner: { userId: 'alice', workspaceId: 'tenant-1' },
      sessions: {
        ...createSessions(session),
        createSession: (sessionId, _name, options) => {
          expect(options?.initialOwner).toEqual({ userId: 'alice', workspaceId: 'tenant-1' })
          ownerInitialized = true
          session.id = sessionId
          return session
        },
      },
      saveRunDetail: detail => {
        saved.push(detail)
        return detail
      },
      createId: () => `id-${++id}`,
      now: () => now,
    })

    expect(result).toMatchObject({
      status: 'succeeded',
      sessionId: 'id-2',
      runId: 'run-1',
      resultPreview: 'All done',
    })
    expect(saved[0]).toMatchObject({
      status: 'succeeded',
      ok: true,
      sessionId: 'id-2',
      assistantMessageId: 'assistant-1',
      resultPreview: 'All done',
      steps: [{ id: 'step-1', resultPreview: 'ok' }],
      toolCalls: [{ id: 'tool-1', argumentsPreview: '{"file":"README.md"}' }],
    })
    expect(eventHandler).toBeDefined()
    expect(streamHost.abort).not.toHaveBeenCalled()
  })
})
