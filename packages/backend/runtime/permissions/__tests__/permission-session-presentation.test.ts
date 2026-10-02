import { describe, expect, it, vi } from 'vitest'
import {
  clearOnethingPermissionSession,
  clearOnethingPermissionSessionForIpc,
  getOnethingPendingPermissions,
  getOnethingPendingPermissionsForIpc,
} from '../permission-session-presentation.js'

describe('permission session presentation', () => {
  it('wraps pending permissions for a session in a stable result shape', async () => {
    const pending = [{ id: 'p1' }, { id: 'p2' }]
    const getPending = vi.fn(() => pending)

    await expect(getOnethingPendingPermissions({
      sessionId: 's1',
      getPending,
    })).resolves.toEqual({
      success: true,
      pending,
    })

    expect(getPending).toHaveBeenCalledWith('s1')
  })

  it('clears all session permission state through the provided adapter', async () => {
    const clearSession = vi.fn(async () => undefined)

    await expect(clearOnethingPermissionSession({
      sessionId: 's1',
      clearSession,
    })).resolves.toEqual({ success: true })

    expect(clearSession).toHaveBeenCalledWith('s1')
  })

  it('normalizes session adapter failures for IPC wrappers', async () => {
    const logger = { error: vi.fn() }

    await expect(getOnethingPendingPermissionsForIpc({
      sessionId: 's1',
      getPending: () => {
        throw new Error('pending failed')
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'pending failed',
    })

    await expect(clearOnethingPermissionSessionForIpc({
      sessionId: 's1',
      clearSession: () => {
        throw new Error('clear failed')
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'clear failed',
    })

    expect(logger.error).toHaveBeenCalledTimes(2)
  })
})
