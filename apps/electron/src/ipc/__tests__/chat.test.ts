import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}))

import { registerElectronChatIpcHandlers } from '../chat.js'

describe('electron chat IPC host', () => {
  // P4c 第五批之后这只工厂只剩一条:六条数据面已走 chatRouter,证据在
  // `packages/backend/rpc/__tests__/chat-domain.test.ts`。留在这里的这一条
  // 之所以留下,正是这个用例钉的那件事 —— 它要把 `event.sender` 递出去。
  it('registers the one surviving chat handler and hands it the invoke sender', async () => {
    const handle = vi.fn()
    const resumeAfterToolConfirm = vi.fn().mockResolvedValue({ success: true })

    registerElectronChatIpcHandlers({
      channels: {
        resumeAfterToolConfirm: 'chat:resume-after-tool-confirm',
      },
      resumeAfterToolConfirm,
      ipcMain: { handle },
    })

    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle.mock.calls.map(call => call[0])).toEqual([
      'chat:resume-after-tool-confirm',
    ])

    const resumeRequest = { sessionId: 'session-1', messageId: 'm2' }
    const sender = { id: 7 }

    await expect(handle.mock.calls[0][1]({ sender }, resumeRequest)).resolves.toEqual({ success: true })
    expect(resumeAfterToolConfirm).toHaveBeenCalledWith(resumeRequest, sender)
  })
})
