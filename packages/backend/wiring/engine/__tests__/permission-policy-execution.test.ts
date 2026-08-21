import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '@shared/json.js'
import { Permission } from '../../permission/index.js'
import { enforcePermissionPolicy } from '../../tools/core/permission-policy.js'
import type { ToolEffect } from '@onething/core/tools'

vi.mock('../../permission/index.js', () => {
  class RejectedError extends Error {
    constructor(
      public readonly sessionId: string,
      public readonly permissionId: string,
      public readonly toolCallId?: string,
      public readonly metadata?: JsonObject,
      public readonly reason?: string,
    ) {
      super(reason ? `The user rejected permission for this tool. Reason: ${reason}` : 'The user rejected permission for this tool.')
      this.name = 'PermissionRejectedError'
    }
  }
  return {
    Permission: {
      ask: vi.fn().mockResolvedValue(undefined),
      getMode: vi.fn(() => 'normal'),
      RejectedError,
    },
  }
})

function baseInput(effects: ToolEffect[], toolName = 'bash') {
  return {
    sessionId: 'session-1',
    messageId: 'message-1',
    toolCallId: 'tool-call-1',
    toolName,
    workspaceRoot: process.cwd(),
    effects,
  }
}

describe('central PermissionPolicy execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(Permission.getMode).mockReturnValue('normal')
  })

  it('routes bash permission through PermissionPolicy', async () => {
    await enforcePermissionPolicy(baseInput([{
      kind: 'bash',
      resources: ['rm *'],
      barrier: true,
      metadata: { command: 'rm -f definitely-not-created' },
    }]))

    expect(Permission.ask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'bash',
      pattern: ['rm *'],
      sessionId: 'session-1',
      messageId: 'message-1',
      callId: 'tool-call-1',
      metadata: expect.objectContaining({
        effectKind: 'bash',
        command: 'rm -f definitely-not-created',
      }),
    }))
  })

  it('routes MCP permission through PermissionPolicy', async () => {
    await enforcePermissionPolicy(baseInput([{
      kind: 'mcp',
      resources: ['mcp:server:tool'],
      barrier: true,
      metadata: { toolName: 'mcp:server:tool' },
    }], 'mcp:server:tool'))

    expect(Permission.ask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'mcp',
      pattern: ['mcp:server:tool'],
      metadata: expect.objectContaining({
        effectKind: 'mcp',
        toolName: 'mcp:server:tool',
      }),
    }))
  })
})
