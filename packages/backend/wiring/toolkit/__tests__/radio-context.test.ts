import { describe, expect, it, vi } from 'vitest'
import { ToolRunner } from '@onething/core/toolkit'
import { createRadioTool, ZodValidator } from '@onething/runtime/toolkit'
import { allowAuthorizer, RecordingObserver } from '../../../../core/toolkit/__tests__/fakes.js'

const radio = vi.hoisted(() => ({
  radioToolOpen: vi.fn(async () => ({ active: true, intent: 'quiet', programmeLength: 1 })),
  radioToolClose: vi.fn(async () => ({ active: false, intent: '', programmeLength: 0 })),
  radioToolStatus: vi.fn(() => ({ active: true, intent: 'quiet', programmeLength: 1 })),
  requestSong: vi.fn(async () => ({ success: true, title: 'song' })),
}))
vi.mock('../../music/radio.js', () => radio)

describe('radio tool trusted execution context', () => {
  it.each(['open', 'retune', 'close', 'status', 'request'])('carries the host context through %s before touching the player', async action => {
    vi.clearAllMocks()
    const { radioAdapters } = await import('../adapters.js')
    const tool = createRadioTool(radioAdapters())
    const runner = new ToolRunner({
      authorizer: allowAuthorizer,
      observer: new RecordingObserver(),
      validator: new ZodValidator(),
      session: () => ({ id: 'alice-session' }),
    })
    const outcome = await runner.run(tool, {
      callId: `radio-${action}`, toolId: 'radio', sessionId: 'alice-session', messageId: 'message',
      principal: { kind: 'user', userId: 'local-user' },
      executionContext: { userId: 'alice', workspaceId: 'default' },
      input: { action, intent: 'quiet music', song: 'song', executionContext: { userId: 'local-user', workspaceId: 'default' } },
    })
    expect(outcome.kind).not.toBe('ok')
    expect(radio.radioToolOpen).not.toHaveBeenCalled()
    expect(radio.radioToolClose).not.toHaveBeenCalled()
    expect(radio.radioToolStatus).not.toHaveBeenCalled()
    expect(radio.requestSong).not.toHaveBeenCalled()
  })
})
