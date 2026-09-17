import { interactionRouter, type InteractionGetPendingResponse, type InteractionRespondRequest, type InteractionRespondResponse } from '@shared/ipc/interaction'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import { chatPort } from './chat-port'

export interface InteractionPort {
  getPending(sessionId: string): Promise<InteractionGetPendingResponse>
  respond(request: InteractionRespondRequest): Promise<InteractionRespondResponse>
  onEvent(callback: (event: SessionEventEnvelope) => void): () => void
  onReconnect(callback: () => void): () => void
}

let override: InteractionPort | undefined
export function configureInteractionPort(port?: InteractionPort): void { override = port }

export async function interactionPort(): Promise<InteractionPort> {
  if (override) return override
  const { onethingClient } = await import('../platform/connection')
  const client = await onethingClient()
  const chat = await chatPort()
  const api = client.api(interactionRouter)
  return {
    getPending: sessionId => api.getPending({ sessionId }),
    respond: request => api.respond(request),
    onEvent: callback => chat.onSessionEvent(callback),
    onReconnect: callback => chat.onReconnect?.(callback) ?? (() => {}),
  }
}
