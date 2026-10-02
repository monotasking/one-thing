import { describe, expect, it, vi } from 'vitest'
import {
  updateOnethingSessionAgent,
  updateOnethingSessionModel,
  updateOnethingSessionPermissionMode,
} from '../session-updates.js'

describe('session update flows', () => {
  it('updates the session model and reports missing sessions', async () => {
    await expect(updateOnethingSessionModel({
      sessionId: 'session-1',
      provider: 'openai',
      model: 'gpt-test',
      updateSessionModel: vi.fn(() => true),
    })).resolves.toEqual({ success: true })

    await expect(updateOnethingSessionModel({
      sessionId: 'missing',
      provider: 'openai',
      model: 'gpt-test',
      updateSessionModel: vi.fn(() => false),
    })).resolves.toEqual({ success: false, error: 'Session not found' })
  })

  it('falls back to the default agent, validates existence, and updates the session', async () => {
    const updateSessionAgent = vi.fn(() => true)

    await expect(updateOnethingSessionAgent({
      sessionId: 'session-1',
      agentId: '',
      defaultAgentId: 'default-agent',
      agentExists: id => id === 'default-agent',
      updateSessionAgent,
    })).resolves.toEqual({ success: true })

    expect(updateSessionAgent).toHaveBeenCalledWith('session-1', 'default-agent')
  })

  it('rejects missing agents before touching the session store', async () => {
    const updateSessionAgent = vi.fn()

    await expect(updateOnethingSessionAgent({
      sessionId: 'session-1',
      agentId: 'missing-agent',
      defaultAgentId: 'default-agent',
      agentExists: () => false,
      updateSessionAgent,
    })).resolves.toEqual({ success: false, error: 'Agent not found' })

    expect(updateSessionAgent).not.toHaveBeenCalled()
  })

  it('validates permission modes before updating the session', async () => {
    const updateSessionPermissionMode = vi.fn(() => true)

    await expect(updateOnethingSessionPermissionMode({
      sessionId: 'session-1',
      permissionMode: 'auto',
      allowedPermissionModes: ['normal', 'auto'],
      updateSessionPermissionMode,
    })).resolves.toEqual({ success: true })

    expect(updateSessionPermissionMode).toHaveBeenCalledWith('session-1', 'auto')

    await expect(updateOnethingSessionPermissionMode({
      sessionId: 'session-1',
      permissionMode: 'invalid',
      allowedPermissionModes: ['normal', 'auto'],
      updateSessionPermissionMode,
    })).resolves.toEqual({ success: false, error: 'Invalid permission mode' })
  })
})
