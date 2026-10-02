import { describe, expect, it, vi } from 'vitest'
import {
  clearOnethingSessionPermissionGrants,
  clearOnethingSessionPermissionGrantsForIpc,
  clearOnethingWorkspacePermissionGrants,
  clearOnethingWorkspacePermissionGrantsForIpc,
  listOnethingPermissionGrants,
  listOnethingPermissionGrantsForIpc,
  revokeOnethingPermissionGrant,
  revokeOnethingPermissionGrantForIpc,
} from '../permission-grants-presentation.js'

describe('permission grants presentation', () => {
  it('returns empty grant lists when no scope is requested', async () => {
    const listSessionGrants = vi.fn()
    const listWorkspaceGrants = vi.fn()

    await expect(listOnethingPermissionGrants({
      listSessionGrants,
      listWorkspaceGrants,
    })).resolves.toEqual({
      success: true,
      sessionGrants: [],
      workspaceGrants: [],
    })

    expect(listSessionGrants).not.toHaveBeenCalled()
    expect(listWorkspaceGrants).not.toHaveBeenCalled()
  })

  it('projects requested session and workspace grants into a host-safe result', async () => {
    const sessionGrant = { id: 'session-grant' }
    const workspaceGrant = { id: 'workspace-grant' }
    const listSessionGrants = vi.fn(async () => [sessionGrant])
    const listWorkspaceGrants = vi.fn(() => [workspaceGrant])

    await expect(listOnethingPermissionGrants({
      sessionId: 's1',
      workspaceRoot: '/repo',
      listSessionGrants,
      listWorkspaceGrants,
    })).resolves.toEqual({
      success: true,
      sessionGrants: [sessionGrant],
      workspaceGrants: [workspaceGrant],
    })

    expect(listSessionGrants).toHaveBeenCalledWith('s1')
    expect(listWorkspaceGrants).toHaveBeenCalledWith('/repo')
  })

  it('passes owner scope to workspace grant adapters when provided', async () => {
    const listSessionGrants = vi.fn(() => [])
    const listWorkspaceGrants = vi.fn(() => [])
    const clearWorkspaceGrants = vi.fn()

    await listOnethingPermissionGrants({
      workspaceRoot: '/repo',
      userId: 'alice',
      workspaceId: 'workspace-a',
      listSessionGrants,
      listWorkspaceGrants,
    })
    await clearOnethingWorkspacePermissionGrants({
      workspaceRoot: '/repo',
      userId: 'alice',
      workspaceId: 'workspace-a',
      clearWorkspaceGrants,
    })

    expect(listWorkspaceGrants).toHaveBeenCalledWith('/repo', {
      userId: 'alice',
      workspaceId: 'workspace-a',
    })
    expect(clearWorkspaceGrants).toHaveBeenCalledWith('/repo', {
      userId: 'alice',
      workspaceId: 'workspace-a',
    })
  })

  it('wraps revoke and clear grant operations in stable runtime results', async () => {
    const revokeGrant = vi.fn(async () => false)
    const clearSessionGrants = vi.fn()
    const clearWorkspaceGrants = vi.fn(async () => undefined)

    await expect(revokeOnethingPermissionGrant({
      id: 'grant-1',
      revokeGrant,
    })).resolves.toEqual({ success: false })

    await expect(clearOnethingSessionPermissionGrants({
      sessionId: 's1',
      clearSessionGrants,
    })).resolves.toEqual({ success: true })

    await expect(clearOnethingWorkspacePermissionGrants({
      workspaceRoot: '/repo',
      clearWorkspaceGrants,
    })).resolves.toEqual({ success: true })

    expect(revokeGrant).toHaveBeenCalledWith('grant-1')
    expect(clearSessionGrants).toHaveBeenCalledWith('s1')
    expect(clearWorkspaceGrants).toHaveBeenCalledWith('/repo')
  })

  it('normalizes grant adapter failures for IPC wrappers', async () => {
    const logger = { error: vi.fn() }

    await expect(listOnethingPermissionGrantsForIpc({
      sessionId: 's1',
      listSessionGrants: () => {
        throw new Error('list failed')
      },
      listWorkspaceGrants: () => [],
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'list failed',
    })

    await expect(revokeOnethingPermissionGrantForIpc({
      id: 'grant-1',
      revokeGrant: () => {
        throw new Error('revoke failed')
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'revoke failed',
    })

    await expect(clearOnethingSessionPermissionGrantsForIpc({
      sessionId: 's1',
      clearSessionGrants: () => {
        throw new Error('clear session failed')
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'clear session failed',
    })

    await expect(clearOnethingWorkspacePermissionGrantsForIpc({
      workspaceRoot: '/repo',
      clearWorkspaceGrants: () => {
        throw new Error('clear workspace failed')
      },
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'clear workspace failed',
    })

    expect(logger.error).toHaveBeenCalledTimes(4)
  })
})
