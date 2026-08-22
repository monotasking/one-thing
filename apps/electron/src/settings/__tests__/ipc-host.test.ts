import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  allWindows: [] as any[],
  focusedWindow: null as any,
  showOpenDialog: vi.fn(),
  nativeThemeUpdated: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => mocks.allWindows),
    getFocusedWindow: vi.fn(() => mocks.focusedWindow),
  },
  dialog: {
    showOpenDialog: mocks.showOpenDialog,
  },
  ipcMain: {
    handle: vi.fn(),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
    on: mocks.nativeThemeUpdated,
  },
}))

import {
  broadcastElectronSettingsChanged,
  broadcastElectronSystemThemeChanged,
  registerElectronSystemThemeChangedBroadcast,
  showElectronOpenDialog,
} from '../ipc-host.js'

function windowMock(id: number, destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    webContents: {
      id,
      send: vi.fn(),
    },
  }
}

describe('electron settings IPC host', () => {
  it('broadcasts system theme changes to live windows', () => {
    const first = windowMock(1)
    const destroyed = windowMock(2, true)

    broadcastElectronSystemThemeChanged({
      channel: 'system-theme-changed',
      getShouldUseDarkColors: () => true,
      getAllWindows: () => [first, destroyed],
    })

    expect(first.webContents.send).toHaveBeenCalledWith('system-theme-changed', 'dark')
    expect(destroyed.webContents.send).not.toHaveBeenCalled()
  })

  it('registers a native theme update callback', () => {
    const onUpdated = vi.fn()

    registerElectronSystemThemeChangedBroadcast({
      channel: 'system-theme-changed',
      onUpdated,
    })

    expect(onUpdated).toHaveBeenCalledWith(expect.any(Function))
  })

  // P4c 第十一批:发射点搬到装配层的域处理者之后,「谁在问」由宿主铸进
  // `RpcDispatchContext.callerId` 再递回来 —— 排除发起窗这件事一字未丢。
  it('broadcasts settings changes except to the sender webContents', () => {
    const sender = windowMock(1)
    const other = windowMock(2)
    const settings = { theme: 'dark' }

    broadcastElectronSettingsChanged({
      channel: 'settings-changed',
      settings,
      exceptWebContentsId: 1,
      getAllWindows: () => [sender, other],
    })

    expect(sender.webContents.send).not.toHaveBeenCalled()
    expect(other.webContents.send).toHaveBeenCalledWith('settings-changed', settings)
  })

  it('shows an open dialog attached to the focused window when available', async () => {
    const focusedWindow = {}
    const showOpenDialog = vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp'] })

    await showElectronOpenDialog(
      { properties: ['openDirectory'] },
      {
        getFocusedWindow: () => focusedWindow as any,
        showOpenDialog: showOpenDialog as any,
      },
    )

    expect(showOpenDialog).toHaveBeenCalledWith(focusedWindow, { properties: ['openDirectory'] })
  })

  it('shows an unattached open dialog when there is no focused window', async () => {
    const showOpenDialog = vi.fn().mockResolvedValue({ canceled: true, filePaths: [] })

    await showElectronOpenDialog(
      { title: 'Pick a file' },
      {
        getFocusedWindow: () => null,
        showOpenDialog: showOpenDialog as any,
      },
    )

    expect(showOpenDialog).toHaveBeenCalledWith({ title: 'Pick a file' })
  })

  // 「开设置窗」与「原生对话框」两条的**注册**于 A1-a 搬到宿主壳路由
  // (`ipc/shell/settings-window.ts` / `ipc/shell/dialog.ts`,由
  // `apps/electron/src/ipc/__tests__/shell-domains.test.ts` 钉);本文件只留
  // 它们的实现与两条广播。
})
