import type { InteractionQuestionAnswer, InteractionRequest } from '@shared/ipc/interaction'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { ComposerStoreApi } from '../composer/store'
import type { AskAnswer, AskSpec } from '../composer/types'
import { t } from '../i18n'
import { notify } from '../services/notify'
import type { InteractionPort } from './interaction-port'

/** Answer keys are question IDs, never display headers (which can collide). */
export function interactionAnswers(request: InteractionRequest, answers: readonly AskAnswer[]): Record<string, InteractionQuestionAnswer> {
  return Object.fromEntries(request.questions.map((q, i) => {
    const answer = answers[i]
    if (Array.isArray(answer)) return [q.id, { selected: answer.map(index => q.options[index]?.label).filter((label): label is string => label !== undefined) }]
    if (typeof answer === 'string' && q.options.some(option => option.label === answer)) return [q.id, { selected: [answer] }]
    return [q.id, { selected: [], ...(typeof answer === 'string' && q.allowFreeText !== false ? { freeText: answer } : {}) }]
  }))
}

/** One mounted session composer owns one queue. Subscribe before fetching so a
 * late snapshot cannot resurrect settled requests or erase newly arrived ones. */
export function bindComposerInteractions(sessionId: string, store: ComposerStoreApi, port: InteractionPort): () => void {
  let disposed = false
  let pending = new Map<string, InteractionRequest>()
  const settled = new Set<string>()
  let fetching = false
  let refetch = false
  let duringFetch = new Map<string, InteractionRequest>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const remove = (id: string) => {
    settled.add(id)
    pending.delete(id)
    duringFetch.delete(id)
    store.getState().closeAsk(id)
    publish()
  }

  const specFor = (request: InteractionRequest): AskSpec => {
    const respond = async (answers?: readonly AskAnswer[]) => {
      const result = await port.respond({
        sessionId, interactionId: request.id,
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        ...(answers ? { answers: interactionAnswers(request, answers) } : { decline: true }),
      })
      if (!result.success) {
        // A timeout or a response from another window may have won the race.
        void refresh()
        throw new Error(result.error || t('ask.failed'))
      }
      if (!disposed) remove(request.id)
    }
    return {
      questions: request.questions.map(q => ({ tag: q.header ?? q.id, q: q.question,
        multi: q.multiSelect ?? false, allowFreeText: q.allowFreeText,
        opts: q.options.map(option => ({ l: option.label, d: option.description ?? '' })),
      })),
      interaction: { id: request.id, submit: answers => respond(answers), decline: () => respond() },
    }
  }

  function publish() {
    if (disposed) return
    clearTimeout(timer)
    const now = Date.now()
    for (const [id, request] of pending) {
      if (request.deadlineAt <= now) { pending.delete(id); settled.add(id) }
    }
    const requests = [...pending.values()].sort((a, b) => a.createdAt - b.createdAt)
    const current = store.getState().askSpec?.interaction?.id
    const request = requests.find(item => item.id === current) ?? requests[0]
    if (request) store.getState().openAsk(specFor(request))
    else if (current) store.getState().closeAsk(current)
    if (requests.length) {
      const deadline = Math.min(...requests.map(item => item.deadlineAt))
      timer = setTimeout(publish, Math.min(2_147_483_647, Math.max(1, deadline - now)))
    }
  }

  async function refresh() {
    if (disposed) return
    if (fetching) { refetch = true; return }
    fetching = true
    duringFetch = new Map()
    try {
      const result = await port.getPending(sessionId)
      if (disposed) return
      if (!result.success) throw new Error(result.error || t('ask.loadFailed'))
      pending = new Map((result.pending ?? []).filter(request => request.sessionId === sessionId && !settled.has(request.id)).map(request => [request.id, request]))
      for (const [id, request] of duringFetch) if (!settled.has(id)) pending.set(id, request)
      publish()
    } catch (error) {
      // Failed reads are not evidence that a question disappeared. Retry on reconnect.
      if (!disposed) notify({ level: 'warn', source: 'chat.interaction', title: t('ask.loadFailed'),
        ...(error instanceof Error ? { body: error.message } : {}),
      })
    } finally {
      fetching = false
      if (refetch && !disposed) { refetch = false; void refresh() }
    }
  }

  const offEvent = port.onEvent(envelope => {
    if (disposed || envelope.sessionId !== sessionId) return
    const event = envelope.event
    if (event.type === SESSION_EVENT_TYPES.INTERACTION_REQUESTED) {
      const request = event.request
      if (request.sessionId !== sessionId || settled.has(request.id)) return
      pending.set(request.id, request)
      if (fetching) duringFetch.set(request.id, request)
      publish()
    } else if (event.type === SESSION_EVENT_TYPES.INTERACTION_SETTLED) remove(event.answer.id)
  })
  const offReconnect = port.onReconnect(() => { void refresh() })
  void refresh()
  return () => { disposed = true; clearTimeout(timer); offEvent(); offReconnect() }
}
