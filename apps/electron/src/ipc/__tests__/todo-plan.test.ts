import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}))

import { registerElectronTodoPlanIpcHandlers } from '../todo-plan.js'

/**
 * 数据面已迁到通用 RPC 通道(todoPlanRouter),这个工厂只剩窗口动作。
 * 这条测试同时是那条分界线的守卫:再往这里加非窗口通道就是在走回头路。
 */
describe('electron todo-plan IPC host', () => {
  it('registers only the window-facing todo-plan handlers', async () => {
    const handle = vi.fn()
    const openWindow = vi.fn().mockResolvedValue({ success: true })
    const hideWindow = vi.fn().mockResolvedValue({ success: true })
    const toggleWindow = vi.fn().mockResolvedValue({ success: true })
    const setWindowPinned = vi.fn().mockResolvedValue({ success: true, pinned: true })
    const minimizeWindow = vi.fn().mockResolvedValue({ success: true })
    const zoomWindow = vi.fn().mockResolvedValue({ success: true })
    const dragWindow = vi.fn().mockResolvedValue({ success: true })

    registerElectronTodoPlanIpcHandlers({
      channels: {
        openWindow: 'todo-plan:open-window',
        hideWindow: 'todo-plan:hide-window',
        toggleWindow: 'todo-plan:toggle-window',
        setWindowPinned: 'todo-plan:set-window-pinned',
        minimizeWindow: 'todo-plan:minimize-window',
        zoomWindow: 'todo-plan:zoom-window',
        dragWindow: 'todo-plan:drag-window',
      },
      openWindow,
      hideWindow,
      toggleWindow,
      setWindowPinned,
      minimizeWindow,
      zoomWindow,
      dragWindow,
      ipcMain: { handle },
    })

    expect(handle).toHaveBeenCalledTimes(7)
    expect(handle.mock.calls.map(call => call[0])).toEqual([
      'todo-plan:open-window',
      'todo-plan:hide-window',
      'todo-plan:toggle-window',
      'todo-plan:set-window-pinned',
      'todo-plan:minimize-window',
      'todo-plan:zoom-window',
      'todo-plan:drag-window',
    ])

    const windowRequest = { activation: 'preserve-current-app' }
    const pinnedRequest = { pinned: true }

    await expect(handle.mock.calls[0][1]({}, windowRequest)).resolves.toEqual({ success: true })
    await expect(handle.mock.calls[1][1]({}, windowRequest)).resolves.toEqual({ success: true })
    await expect(handle.mock.calls[2][1]({}, windowRequest)).resolves.toEqual({ success: true })
    await expect(handle.mock.calls[3][1]({}, pinnedRequest)).resolves.toEqual({ success: true, pinned: true })

    const dragRequest = { phase: 'move', dx: 12, dy: -4 }
    await expect(handle.mock.calls[4][1]({})).resolves.toEqual({ success: true })
    await expect(handle.mock.calls[5][1]({})).resolves.toEqual({ success: true })
    await expect(handle.mock.calls[6][1]({}, dragRequest)).resolves.toEqual({ success: true })

    expect(openWindow).toHaveBeenCalledWith(windowRequest)
    expect(hideWindow).toHaveBeenCalledWith(windowRequest)
    expect(toggleWindow).toHaveBeenCalledWith(windowRequest)
    expect(setWindowPinned).toHaveBeenCalledWith(pinnedRequest)
    expect(dragWindow).toHaveBeenCalledWith(dragRequest)
  })
})
