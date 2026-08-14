import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}))

import { registerElectronPermissionIpcHandlers } from '../permission.js'

describe('electron permission IPC host', () => {
  /**
   * 主线 T 批 3 之后这个 host 只剩两条：授权账页那四条整只迁到通用 RPC 通道的
   * `permissionGrants` 域（连同 server 侧的归属校验），行为由
   * `src/app/rpc/__tests__/permission-grants-domain.test.ts` 守。
   */
  it('registers the two live-permission handlers against the provided IPC host', async () => {
    const handle = vi.fn()
    const getPending = vi.fn().mockResolvedValue({ success: true, pending: [] })
    const clearSession = vi.fn().mockResolvedValue({ success: true })

    registerElectronPermissionIpcHandlers({
      channels: {
        getPending: 'permission:get-pending',
        clearSession: 'permission:clear-session',
      },
      getPending,
      clearSession,
      ipcMain: { handle },
    })

    expect(handle).toHaveBeenCalledTimes(2)
    expect(handle.mock.calls.map(call => call[0])).toEqual([
      'permission:get-pending',
      'permission:clear-session',
    ])

    await expect(handle.mock.calls[0][1]({}, 'session-1')).resolves.toEqual({ success: true, pending: [] })
    await expect(handle.mock.calls[1][1]({}, 'session-1')).resolves.toEqual({ success: true })

    expect(getPending).toHaveBeenCalledWith('session-1')
    expect(clearSession).toHaveBeenCalledWith('session-1')
  })
})
