import { describe, expect, it } from 'vitest'
import { EventBus } from '../event-bus.js'
import { emitCoreSessionCommandForIpc } from '../ipc-operations.js'
import { SESSION_COMMAND_TYPES } from '../session-command-types.js'
import { CoreStreamEngine, type CoreExecutionOptions, type CoreStreamEngineRuntime } from '../../engine/core-stream-engine.js'

describe('trusted command delivery context', () => {
  it('passes the separate host context to an execution while excluding it from JSON and ignoring payload claims', async () => {
    const calls: CoreExecutionOptions[] = []
    class Engine extends CoreStreamEngine {
      override handleSendMessage(_id: string, _command: { content: string }, _sender: unknown, options: CoreExecutionOptions = {}): Promise<void> {
        calls.push(options)
        return Promise.resolve()
      }
    }
    const bus = new EventBus()
    const engine = new Engine({} as CoreStreamEngineRuntime)
    engine.setEventBus(bus)
    engine.bindCommandTarget({})
    const owner = Object.freeze({ userId: 'alice', workspaceId: 'tenant-a' })
    const command = { type: SESSION_COMMAND_TYPES.SEND_MESSAGE, content: 'Work', executionContext: { userId: 'spoof' } }
    const result = await emitCoreSessionCommandForIpc({ sessionId: 's', command, eventBus: bus, executionContext: owner })
    expect(calls[0]?.executionContext).toBe(owner)
    if (!result.success) throw new Error(result.error)
    const envelope = result.result.envelope!
    expect(envelope.executionContext).toBe(owner)
    expect(JSON.parse(JSON.stringify(envelope))).not.toHaveProperty('executionContext')
    await bus.emit('s', command)
    expect(calls[1]?.executionContext).toBeUndefined()
  })
})
