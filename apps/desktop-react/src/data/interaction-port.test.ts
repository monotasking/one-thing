import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryTransport, createOnethingClient } from '@onething/client'
import { Interaction } from '@onething/core/interaction'
import { getPendingInteractionsForIpc, respondInteractionForIpc } from '@onething/runtime/interaction/ipc-operations.wiring'
import type { InteractionRespondRequest } from '@shared/ipc/interaction'
import { composerStoreFor, resetComposerStore } from '../composer/store'
import { bindComposerInteractions } from './composer-interactions'
import { configureChatPort } from './chat-port'

const transport = createMemoryTransport({ handlers: {
  'interaction.getPending': payload => getPendingInteractionsForIpc((payload as { sessionId: string }).sessionId),
  'interaction.respond': payload => respondInteractionForIpc(payload as InteractionRespondRequest),
} })
const client = createOnethingClient({ transport })
vi.mock('../platform/connection', () => ({ onethingClient: async () => client, whenConnected: async () => undefined }))
const { interactionPort } = await import('./interaction-port')
let dispose: (() => void) | undefined
let sequence = 0
beforeEach(() => {
  configureChatPort(undefined)
  Interaction.initialize({
    onAnySession: () => () => {},
    emit: async (sessionId, event) => { transport.emit({ name: 'session:event', data: { sessionId, event, sequence: ++sequence, timestamp: Date.now() } }) },
  }, () => 'ipc')
})
afterEach(() => { dispose?.(); Interaction.clearSession('port-test'); Interaction.shutdown(); resetComposerStore() })

const ask = () => Interaction.ask({ sessionId: 'port-test', toolCallId: 'ask-tool', origin: 'host-tool', timeoutMs: 5000,
  questions: [{ id: 'choice-id', header: '选择', question: '下一步？', options: [{ label: '继续' }] }],
})

it('真实客户端路由 + 交互内核:冷载提交与实时拒绝都结束原工具等待', async () => {
  const toolResult = ask()
  const store = composerStoreFor('port-test')
  dispose = bindComposerInteractions('port-test', store, await interactionPort())
  await vi.waitFor(() => expect(store.getState().mode).toBe('ask'))
  store.getState().answerAsk(0)
  await store.getState().submitAsk([])
  expect(await toolResult).toMatchObject({ outcome: 'answered', answers: { 'choice-id': { selected: ['继续'] } } })
  expect(Interaction.getPending('port-test')).toEqual([])
  expect(store.getState().mode).toBe('write')
  expect(transport.calls.some(call => call.domain === 'session-command')).toBe(false)
  const secondResult = ask()
  await vi.waitFor(() => expect(store.getState().mode).toBe('ask'))
  await store.getState().rejectAsk()
  expect(await secondResult).toMatchObject({ outcome: 'declined', answers: {} })
  expect(store.getState().mode).toBe('write')
})
