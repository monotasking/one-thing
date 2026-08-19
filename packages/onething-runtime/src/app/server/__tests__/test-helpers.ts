/**
 * Test-only server backend: a self-contained echo engine on the core
 * AgentEngine. HTTP-layer tests exercise routing/identity/SSE against this
 * stub so they never boot real providers or touch the user's store — the
 * real path (createOnethingBackend) is covered by host smokes instead.
 */
import { AgentEngine, EventBus, StreamChannel } from '@onething/core'
import type {
  OnethingServerBackend,
  OnethingServerRuntime,
  OnethingServerRuntimeOptions,
} from '../runtime.js'
import { createDevelopmentOnethingServerRuntime } from '../runtime.js'

type AnyEvent = { type?: string } & Record<string, unknown>

export async function createEchoServerBackend(): Promise<OnethingServerBackend> {
  const eventBus = new EventBus()
  const streamChannel = new StreamChannel()
  const engine = new AgentEngine({
    eventBus: eventBus as never,
    streamChannel: streamChannel as never,
  })
  const controllers = new Map<string, AbortController>()

  const send = (sessionId: string, content: string): void => {
    controllers.get(sessionId)?.abort()
    const controller = new AbortController()
    controllers.set(sessionId, controller)
    void engine
      .sendMessage({ sessionId, content, signal: controller.signal })
      .catch(() => {
        // AgentEngine already emits stream:error.
      })
      .finally(() => {
        if (controllers.get(sessionId) === controller) controllers.delete(sessionId)
      })
  }

  // Truncate this session's context from the given predicate and rerun the
  // surviving user prompt — the echo stand-in for StreamEngine edit/retry.
  const replaceFrom = async (
    sessionId: string,
    findIndex: (messages: Array<{ id: string; role: string; content?: string }>) => number,
    contentOverride?: string,
  ): Promise<void> => {
    const messages = engine.contextManager.getMessages(sessionId) as Array<{
      id: string
      role: string
      content?: string
    }>
    const index = findIndex(messages)
    if (index < 0) return
    const survivor = messages[index]
    const remaining = messages.slice(0, index)
    engine.contextManager.replaceMessages(sessionId, remaining as never[])
    await eventBus.emit(sessionId, {
      type: 'messages:replaced',
      messages: remaining.map(message => ({ ...message })),
    } as never)
    send(sessionId, contentOverride ?? survivor?.content ?? '')
  }

  eventBus.onAnySessionAny(envelope => {
    const event = envelope.event as AnyEvent
    const sessionId = envelope.sessionId
    switch (event.type) {
      case 'command:send-message':
        send(sessionId, String(event.content ?? ''))
        break
      case 'command:retry-message': {
        void replaceFrom(sessionId, messages => {
          const target = messages.findIndex(message => message.id === event.messageId)
          if (target < 0) return -1
          for (let index = target; index >= 0; index--) {
            if (messages[index].role === 'user') return index
          }
          return -1
        })
        break
      }
      case 'command:edit-and-resend': {
        void replaceFrom(
          sessionId,
          messages => messages.findIndex(
            message => message.id === event.messageId && message.role === 'user',
          ),
          String(event.newContent ?? ''),
        )
        break
      }
      default:
        break
    }
  }, 'EchoServerBackend')

  return {
    eventBus: eventBus as unknown as OnethingServerBackend['eventBus'],
    streamChannel: streamChannel as unknown as OnethingServerBackend['streamChannel'],
    persistsMessages: false,
    abortSession(sessionId) {
      controllers.get(sessionId)?.abort()
      controllers.delete(sessionId)
    },
    async shutdown() {
      engine.shutdown()
    },
  }
}

/** Dev-runtime factory for tests: always rides the echo backend. */
export function createTestServerRuntime(
  options: OnethingServerRuntimeOptions = {},
): Promise<OnethingServerRuntime> {
  return createDevelopmentOnethingServerRuntime({
    createBackend: createEchoServerBackend,
    ...options,
  })
}
