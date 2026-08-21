import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock uuid - returns incrementing IDs
let uuidCounter = 0
vi.mock('uuid', () => ({
  v4: vi.fn(() => `test-uuid-${++uuidCounter}`),
}))

import { Permission } from '../index'

describe('Permission', () => {
  beforeEach(async () => {
    // Reset UUID counter
    uuidCounter = 0
    // Safely clear session state - no leftover pending from previous tests
    // since each test is responsible for its own cleanup
    vi.clearAllMocks()
  })

  // ─── getPending ────────────────────────────────────────────────────

  describe('getPending()', () => {
    it('should return empty array for new session', () => {
      const pending = Permission.getPending('new-session')
      expect(pending).toEqual([])
    })

    it('should return pending requests', async () => {
      const askPromise = Permission.ask({
        type: 'bash',
        title: 'Run command',
        sessionId: 'get-pending-session',
        messageId: 'msg-1',
        metadata: {},
      })

      const pending = Permission.getPending('get-pending-session')
      expect(pending).toHaveLength(1)
      expect(pending[0].type).toBe('bash')
      expect(pending[0].title).toBe('Run command')

      // Clean up
      Permission.respond({
        sessionId: 'get-pending-session',
        permissionId: pending[0].id,
        response: 'once',
      })
      await askPromise
    })
  })

  // ─── ask() ─────────────────────────────────────────────────────────

  describe('ask()', () => {
    it('should emit asks even with a working directory; scoped grants are handled by PermissionGrants', async () => {
      const askPromise = Permission.ask({
        type: 'bash',
        title: 'Run command',
        pattern: 'bash:run',
        sessionId: 'ws-auto-session',
        messageId: 'msg-1',
        metadata: {},
        workingDirectory: '/workspace',
      })

      const pending = Permission.getPending('ws-auto-session')
      expect(pending).toHaveLength(1)
      Permission.respond({
        sessionId: 'ws-auto-session',
        permissionId: pending[0].id,
        response: 'once',
      })
      await askPromise
    })

    it('should leave new grant matching to PermissionPolicy', async () => {
      const askPromise1 = Permission.ask({
        type: 'bash',
        title: 'Run command',
        pattern: 'bash:run',
        sessionId: 'session-auto',
        messageId: 'msg-1',
        metadata: {},
      })

      const pending = Permission.getPending('session-auto')
      Permission.respond({
        sessionId: 'session-auto',
        permissionId: pending[0].id,
        response: 'session',
      })
      await askPromise1

      const askPromise2 = Permission.ask({
        type: 'bash',
        title: 'Run command again',
        pattern: 'bash:run',
        sessionId: 'session-auto',
        messageId: 'msg-2',
        metadata: {},
      })
      const secondPending = Permission.getPending('session-auto')
      expect(secondPending).toHaveLength(1)
      Permission.respond({
        sessionId: 'session-auto',
        permissionId: secondPending[0].id,
        response: 'once',
      })
      await askPromise2
    })

    it('should emit permission:request event via EventBus when initialized', async () => {
      // Create a mock EventBus
      const mockEmit = vi.fn().mockResolvedValue(undefined)
      const mockOnAnySession = vi.fn().mockReturnValue(() => {})
      const mockBus = {
        emit: mockEmit,
        onAnySession: mockOnAnySession,
        onAnySessionAny: vi.fn(),
        shutdown: vi.fn(),
      } as any

      Permission.initialize(mockBus, () => 'ipc')

      const askPromise = Permission.ask({
        type: 'bash',
        title: 'Run command',
        sessionId: 'eventbus-session',
        messageId: 'msg-1',
        metadata: {},
      })

      expect(mockEmit).toHaveBeenCalledWith('eventbus-session', expect.objectContaining({
        type: 'permission:request',
        permissionType: 'bash',
        title: 'Run command',
        targetChannel: 'ipc',
      }))

      // Clean up
      const pending = Permission.getPending('eventbus-session')
      Permission.respond({
        sessionId: 'eventbus-session',
        permissionId: pending[0].id,
        response: 'once',
      })
      await askPromise
      Permission.shutdown()
    })

    it('should expose auto-accept-edits mode to PermissionPolicy', () => {
      const mockBus = {
        emit: vi.fn().mockResolvedValue(undefined),
        onAnySession: vi.fn().mockReturnValue(() => {}),
      } as any

      Permission.initialize(mockBus, () => 'ipc', () => 'auto-accept-edits')
      expect(Permission.getMode('auto-edit-session')).toBe('auto-accept-edits')
      Permission.shutdown()
    })

    it('should still ask for bash in auto-accept-edits mode', async () => {
      const mockEmit = vi.fn().mockResolvedValue(undefined)
      const mockBus = {
        emit: mockEmit,
        onAnySession: vi.fn().mockReturnValue(() => {}),
      } as any

      Permission.initialize(mockBus, () => 'ipc', () => 'auto-accept-edits')

      const askPromise = Permission.ask({
        type: 'bash',
        title: 'Run command',
        sessionId: 'auto-edit-bash-session',
        messageId: 'msg-1',
        metadata: {},
      })

      expect(mockEmit).toHaveBeenCalledWith('auto-edit-bash-session', expect.objectContaining({
        type: 'permission:request',
        permissionType: 'bash',
      }))

      const pending = Permission.getPending('auto-edit-bash-session')
      Permission.respond({
        sessionId: 'auto-edit-bash-session',
        permissionId: pending[0].id,
        response: 'once',
      })
      await askPromise
      Permission.shutdown()
    })

    it('should expose dangerously-allow-all mode to PermissionPolicy', () => {
      const mockBus = {
        emit: vi.fn().mockResolvedValue(undefined),
        onAnySession: vi.fn().mockReturnValue(() => {}),
      } as any

      Permission.initialize(mockBus, () => 'ipc', () => 'dangerously-allow-all')
      expect(Permission.getMode('danger-session')).toBe('dangerously-allow-all')
      Permission.shutdown()
    })

    it('should set targetChannel from channelResolver', async () => {
      const mockEmit = vi.fn().mockResolvedValue(undefined)
      const mockBus = {
        emit: mockEmit,
        onAnySession: vi.fn().mockReturnValue(() => {}),
      } as any

      Permission.initialize(mockBus, () => 'telegram')

      const askPromise = Permission.ask({
        type: 'bash',
        title: 'Run command',
        sessionId: 'channel-test-session',
        messageId: 'msg-1',
        metadata: {},
      })

      expect(mockEmit).toHaveBeenCalledWith('channel-test-session', expect.objectContaining({
        targetChannel: 'telegram',
      }))

      // Clean up
      const pending = Permission.getPending('channel-test-session')
      Permission.respond({
        sessionId: 'channel-test-session',
        permissionId: pending[0].id,
        response: 'once',
      })
      await askPromise
      Permission.shutdown()
    })

    it('should create info with correct fields', async () => {
      const askPromise = Permission.ask({
        type: 'bash',
        title: 'Test title',
        pattern: 'test-pattern',
        callId: 'call-1',
        sessionId: 'fields-session',
        messageId: 'msg-1',
        metadata: { key: 'value' },
        workingDirectory: '/workspace',
      })

      const pending = Permission.getPending('fields-session')
      expect(pending[0]).toMatchObject({
        type: 'bash',
        pattern: 'test-pattern',
        callId: 'call-1',
        sessionId: 'fields-session',
        messageId: 'msg-1',
        title: 'Test title',
        metadata: { key: 'value' },
        workingDirectory: '/workspace',
      })
      expect(pending[0].id).toBeTypeOf('string')
      expect(pending[0].createdAt).toBeTypeOf('number')

      // Clean up
      Permission.respond({
        sessionId: 'fields-session',
        permissionId: pending[0].id,
        response: 'once',
      })
      await askPromise
    })
  })

  // ─── respond() ─────────────────────────────────────────────────────

  describe('respond()', () => {
    it('should return false for non-existent permission', () => {
      const result = Permission.respond({
        sessionId: 'respond-session',
        permissionId: 'non-existent',
        response: 'once',
      })
      expect(result).toBe(false)
    })

    it('should resolve promise on "once" response', async () => {
      const askPromise = Permission.ask({
        type: 'bash',
        title: 'Run command',
        sessionId: 'once-session',
        messageId: 'msg-1',
        metadata: {},
      })

      const pending = Permission.getPending('once-session')
      const result = Permission.respond({
        sessionId: 'once-session',
        permissionId: pending[0].id,
        response: 'once',
      })

      expect(result).toBe(true)
      await askPromise
      expect(Permission.getPending('once-session')).toHaveLength(0)
    })

    it('should reject promise on "reject" response', async () => {
      const askPromise = Permission.ask({
        type: 'bash',
        title: 'Run command',
        sessionId: 'reject-session',
        messageId: 'msg-1',
        metadata: {},
      })

      const pending = Permission.getPending('reject-session')
      Permission.respond({
        sessionId: 'reject-session',
        permissionId: pending[0].id,
        response: 'reject',
        rejectReason: 'Not allowed',
      })

      await expect(askPromise).rejects.toThrow('The user rejected permission for this tool. Reason: Not allowed')
    })

    it('should reject with default message when no reason given', async () => {
      const askPromise = Permission.ask({
        type: 'bash',
        title: 'Run command',
        sessionId: 'reject-default-session',
        messageId: 'msg-1',
        metadata: {},
      })

      const pending = Permission.getPending('reject-default-session')
      Permission.respond({
        sessionId: 'reject-default-session',
        permissionId: pending[0].id,
        response: 'reject',
      })

      await expect(askPromise).rejects.toThrow('The user rejected permission for this tool.')
    })

    it('should store session-level permission and auto-approve matching requests', async () => {
      // Create two requests with the same pattern
      const ask1 = Permission.ask({
        type: 'bash',
        title: 'Run command 1',
        pattern: 'bash:run',
        sessionId: 'session-level-session',
        messageId: 'msg-1',
        metadata: {},
      })

      const ask2 = Permission.ask({
        type: 'bash',
        title: 'Run command 2',
        pattern: 'bash:run',
        sessionId: 'session-level-session',
        messageId: 'msg-2',
        metadata: {},
      })

      // Equivalent concurrent asks coalesce into a single visible prompt.
      const pending = Permission.getPending('session-level-session')
      expect(pending).toHaveLength(1)

      // Approve the first one with 'session' scope
      Permission.respond({
        sessionId: 'session-level-session',
        permissionId: pending[0].id,
        response: 'session',
      })

      // Both should resolve
      await ask1
      await ask2

      expect(Permission.getPending('session-level-session')).toHaveLength(0)
    })

    it('should store workspace scoped grants and auto-approve matching pending asks', async () => {
      const ask1 = Permission.ask({
        type: 'bash',
        title: 'Run command 1',
        pattern: 'bash:run',
        sessionId: 'ws-level-session',
        messageId: 'msg-1',
        metadata: {},
        workingDirectory: '/workspace',
      })

      const ask2 = Permission.ask({
        type: 'bash',
        title: 'Run command 2',
        pattern: 'bash:run',
        sessionId: 'ws-level-session',
        messageId: 'msg-2',
        metadata: {},
        workingDirectory: '/workspace',
      })

      // Equivalent concurrent asks coalesce into a single visible prompt.
      const pending = Permission.getPending('ws-level-session')
      expect(pending).toHaveLength(1)

      Permission.respond({
        sessionId: 'ws-level-session',
        permissionId: pending[0].id,
        response: 'workdir',
      })

      await ask1
      await ask2

      expect(Permission.getPending('ws-level-session')).toHaveLength(0)
    })

  })

  // ─── Channel Affinity ─────────────────────────────────────────────

  describe('channel affinity', () => {
    it('should store targetChannel on permission info', async () => {
      const mockBus = {
        emit: vi.fn().mockResolvedValue(undefined),
        onAnySession: vi.fn().mockReturnValue(() => {}),
      } as any

      Permission.initialize(mockBus, () => 'telegram')

      const askPromise = Permission.ask({
        type: 'bash',
        title: 'Run command',
        sessionId: 'affinity-session',
        messageId: 'msg-1',
        metadata: {},
      })

      const pending = Permission.getPending('affinity-session')
      expect(pending[0].targetChannel).toBe('telegram')

      // Clean up
      Permission.respond({
        sessionId: 'affinity-session',
        permissionId: pending[0].id,
        response: 'once',
      })
      await askPromise
      Permission.shutdown()
    })

    it('should reject permission response from wrong channel via EventBus subscription', async () => {
      // Capture the onAnySession callback so we can simulate EventBus events
      let capturedHandler: ((envelope: any) => void) | null = null
      const mockBus = {
        emit: vi.fn().mockResolvedValue(undefined),
        onAnySession: vi.fn((eventType: string, handler: any) => {
          if (eventType === 'command:permission-respond') {
            capturedHandler = handler
          }
          return () => {}
        }),
      } as any

      // Session is bound to 'telegram' channel
      Permission.initialize(mockBus, () => 'telegram')

      const askPromise = Permission.ask({
        type: 'bash',
        title: 'Run command',
        sessionId: 'wrong-channel-session',
        messageId: 'msg-1',
        metadata: {},
      })

      const pending = Permission.getPending('wrong-channel-session')
      expect(pending).toHaveLength(1)

      // Simulate a response from 'ipc' channel (wrong — should be 'telegram')
      expect(capturedHandler).not.toBeNull()
      capturedHandler!({
        sessionId: 'wrong-channel-session',
        event: {
          type: 'command:permission-respond',
          channel: 'ipc',
          requestId: pending[0].id,
          decision: 'once',
        },
      })

      // The request should still be pending (response from wrong channel was rejected)
      expect(Permission.getPending('wrong-channel-session')).toHaveLength(1)

      // Now respond from the correct channel
      capturedHandler!({
        sessionId: 'wrong-channel-session',
        event: {
          type: 'command:permission-respond',
          channel: 'telegram',
          requestId: pending[0].id,
          decision: 'once',
        },
      })

      // Now it should be resolved
      await askPromise
      expect(Permission.getPending('wrong-channel-session')).toHaveLength(0)

      Permission.shutdown()
    })

    it('should default targetChannel to "ipc" when no resolver', async () => {
      // Ensure no initialize has been called (shutdown first)
      Permission.shutdown()

      const askPromise = Permission.ask({
        type: 'bash',
        title: 'Run command',
        sessionId: 'default-channel-session',
        messageId: 'msg-1',
        metadata: {},
      })

      const pending = Permission.getPending('default-channel-session')
      expect(pending[0].targetChannel).toBe('ipc')

      // Clean up
      Permission.respond({
        sessionId: 'default-channel-session',
        permissionId: pending[0].id,
        response: 'once',
      })
      await askPromise
    })
  })

  // ─── clearSession() ────────────────────────────────────────────────

  describe('clearSession()', () => {
    it('should reject all pending requests', async () => {
      const ask1 = Permission.ask({
        type: 'bash',
        title: 'Command 1',
        sessionId: 'clear-session-test',
        messageId: 'msg-1',
        metadata: {},
      })

      const ask2 = Permission.ask({
        type: 'write',
        title: 'Write file',
        sessionId: 'clear-session-test',
        messageId: 'msg-2',
        metadata: {},
      })

      // Catch the rejections BEFORE clearSession to avoid unhandled rejection
      const catchedAsk1 = ask1.catch(e => e)
      const catchedAsk2 = ask2.catch(e => e)

      Permission.clearSession('clear-session-test')

      const err1 = await catchedAsk1
      const err2 = await catchedAsk2

      expect(err1).toBeInstanceOf(Permission.RejectedError)
      expect(err1.message).toContain('Session cleared')
      expect(err2).toBeInstanceOf(Permission.RejectedError)
      expect(err2.message).toContain('Session cleared')
    })

    it('should be safe to clear non-existent session', () => {
      expect(() => Permission.clearSession('non-existent')).not.toThrow()
    })
  })

  // ─── RejectedError ────────────────────────────────────────────────

  describe('RejectedError', () => {
    it('should have correct properties', () => {
      const error = new Permission.RejectedError(
        'session-1',
        'perm-1',
        'call-1',
        { key: 'value' },
        'Custom reason'
      )

      expect(error.name).toBe('PermissionRejectedError')
      expect(error.sessionId).toBe('session-1')
      expect(error.permissionId).toBe('perm-1')
      expect(error.toolCallId).toBe('call-1')
      expect(error.metadata).toEqual({ key: 'value' })
      expect(error.message).toContain('Custom reason')
    })

    it('should use default message when no reason', () => {
      const error = new Permission.RejectedError('s1', 'p1')
      expect(error.message).toBe('The user rejected permission for this tool.')
    })

    it('should be an instance of Error', () => {
      const error = new Permission.RejectedError('s1', 'p1')
      expect(error).toBeInstanceOf(Error)
    })
  })

  // ─── Wildcard matching (via session approval) ─────────────────────

  describe('wildcard matching', () => {
    it('should match wildcards in session-approved patterns', async () => {
      const ask1 = Permission.ask({
        type: 'bash',
        title: 'Run command',
        pattern: 'bash:*',
        sessionId: 'wildcard-session',
        messageId: 'msg-1',
        metadata: {},
      })

      const pending = Permission.getPending('wildcard-session')
      Permission.respond({
        sessionId: 'wildcard-session',
        permissionId: pending[0].id,
        response: 'session',
      })
      await ask1

      const ask2 = Permission.ask({
        type: 'bash',
        title: 'Run specific command',
        pattern: 'bash:run',
        sessionId: 'wildcard-session',
        messageId: 'msg-2',
        metadata: {},
      })
      const pending2 = Permission.getPending('wildcard-session')
      expect(pending2).toHaveLength(1)
      Permission.respond({
        sessionId: 'wildcard-session',
        permissionId: pending2[0].id,
        response: 'once',
      })
      await ask2
    })
  })

  // ─── Multi-session isolation ──────────────────────────────────────

  describe('session isolation', () => {
    it('should not share session-level permissions across sessions', async () => {
      // Approve in session-1
      const ask1 = Permission.ask({
        type: 'bash',
        title: 'Run',
        pattern: 'bash:run',
        sessionId: 'iso-session-1',
        messageId: 'msg-1',
        metadata: {},
      })

      const pending1 = Permission.getPending('iso-session-1')
      Permission.respond({
        sessionId: 'iso-session-1',
        permissionId: pending1[0].id,
        response: 'session',
      })
      await ask1

      // session-2 should still require permission
      const ask2 = Permission.ask({
        type: 'bash',
        title: 'Run',
        pattern: 'bash:run',
        sessionId: 'iso-session-2',
        messageId: 'msg-1',
        metadata: {},
      })

      const pending2 = Permission.getPending('iso-session-2')
      expect(pending2).toHaveLength(1)

      // Clean up properly
      Permission.respond({
        sessionId: 'iso-session-2',
        permissionId: pending2[0].id,
        response: 'once',
      })
      await ask2
    })
  })
})
