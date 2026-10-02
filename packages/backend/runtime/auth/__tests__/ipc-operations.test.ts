import { describe, expect, it, vi } from 'vitest'
import {
  completeOnethingOAuthCallbackForIpc,
  getOnethingOAuthStatusForIpc,
  logoutOnethingOAuthForIpc,
  pollOnethingOAuthDeviceFlowForIpc,
  refreshOnethingOAuthForIpc,
  startOnethingOAuthForIpc,
} from '../ipc-operations.js'

describe('OAuth IPC operations', () => {
  it('starts OAuth and opens the returned browser URL through a host adapter', async () => {
    const openExternal = vi.fn()

    await expect(startOnethingOAuthForIpc({
      providerId: 'codex',
      start: vi.fn(async () => ({
        success: true,
        authUrl: 'https://auth.example/start',
        flowId: 'flow-1',
      })),
      openExternal,
    })).resolves.toEqual({
      success: true,
      authUrl: 'https://auth.example/start',
      flowId: 'flow-1',
    })

    expect(openExternal).toHaveBeenCalledWith('https://auth.example/start')
  })

  it('wraps start and callback failures', async () => {
    await expect(startOnethingOAuthForIpc({
      providerId: 'codex',
      start: () => { throw new Error('start boom') },
    })).resolves.toEqual({
      success: false,
      error: 'start boom',
    })

    await expect(completeOnethingOAuthCallbackForIpc({
      providerId: 'codex',
      code: 'code',
      state: 'state',
      completeManualCode: () => { throw new Error('callback boom') },
    })).resolves.toEqual({
      success: false,
      error: 'callback boom',
    })
  })

  it('polls device flow with flow id fallback and normalizes poll errors', async () => {
    const pollDeviceFlow = vi.fn(async () => ({ success: true, completed: false, pollStatus: 'authorization_pending' }))

    await expect(pollOnethingOAuthDeviceFlowForIpc({
      providerId: 'codex',
      deviceCode: 'device-code',
      pollDeviceFlow,
    })).resolves.toEqual({
      success: true,
      completed: false,
      pollStatus: 'authorization_pending',
    })
    expect(pollDeviceFlow).toHaveBeenCalledWith('codex', 'device-code')

    await expect(pollOnethingOAuthDeviceFlowForIpc({
      providerId: 'codex',
      flowId: 'flow-id',
      deviceCode: 'device-code',
      pollDeviceFlow: () => { throw new Error('poll boom') },
    })).resolves.toEqual({
      success: false,
      completed: false,
      error: 'poll boom',
    })
  })

  it('notifies token expiry when refresh fails', async () => {
    const notifyTokenExpired = vi.fn()

    await expect(refreshOnethingOAuthForIpc({
      providerId: 'codex',
      refreshToken: () => { throw new Error('refresh boom') },
      notifyTokenExpired,
    })).resolves.toEqual({
      success: false,
      error: 'refresh boom',
    })

    expect(notifyTokenExpired).toHaveBeenCalledWith('codex', 'refresh boom')
  })

  it('wraps status and logout operations', async () => {
    await expect(getOnethingOAuthStatusForIpc({
      providerId: 'codex',
      getStatus: async () => ({
        success: true,
        providerId: 'codex',
        isLoggedIn: true,
      }),
    })).resolves.toEqual({
      success: true,
      providerId: 'codex',
      isLoggedIn: true,
    })

    await expect(getOnethingOAuthStatusForIpc({
      providerId: 'codex',
      getStatus: () => { throw new Error('status boom') },
    })).resolves.toEqual({
      success: false,
      providerId: 'codex',
      isLoggedIn: false,
      isExpired: false,
      error: 'status boom',
    })

    await expect(logoutOnethingOAuthForIpc({
      providerId: 'codex',
      deleteToken: async () => undefined,
    })).resolves.toEqual({ success: true })

    await expect(logoutOnethingOAuthForIpc({
      providerId: 'codex',
      deleteToken: () => { throw new Error('logout boom') },
    })).resolves.toEqual({
      success: false,
      error: 'logout boom',
    })
  })
})
