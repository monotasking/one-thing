import type {
  AgentMessageContent,
  AgentProviderData,
  AgentProvider,
  AgentStreamEvent,
  AgentTurn,
  AgentTurnRequest,
  AgentTurnStreamEvent,
} from './types.js'
import type { AgentExecutionLifetime } from './execution-lifetime.js'
import {
  isAgentRunnableProvider,
  isAgentStreamingProvider,
} from './capabilities.js'

function errorFromThrown(error: Error | string | number | boolean | null | undefined): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

export interface AgentTurnEventSynthesisState {
  textDelta: string
  reasoningDelta: string
  finish: boolean
  providerData: boolean
  toolCalls: Map<string, {
    start: boolean
    argumentsDelta: string
    done: boolean
  }>
}

export class AgentEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private closed = false
  private error: Error | undefined
  private notify: (() => void) | undefined

  push(event: T): void {
    if (this.closed) return
    this.values.push(event)
    this.notify?.()
    this.notify = undefined
  }

  close(): void {
    this.closed = true
    this.notify?.()
    this.notify = undefined
  }

  fail(error: Error): void {
    this.error = error
    this.closed = true
    this.notify?.()
    this.notify = undefined
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const next = this.values.shift()
      if (next) {
        yield next
        continue
      }
      if (this.error) throw this.error
      if (this.closed) return
      await new Promise<void>(resolve => {
        this.notify = resolve
      })
    }
  }
}

export function createAgentAbortError(reason = 'Agent operation aborted'): Error {
  const error = new Error(reason)
  error.name = 'AbortError'
  return error
}

export function throwIfAgentAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAgentAbortError()
  }
}

export async function runWithAgentAbort<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T> | T,
  lifetime?: AgentExecutionLifetime,
): Promise<T> {
  throwIfAgentAborted(signal)
  const start = () => {
    throwIfAgentAborted(signal)
    return operation()
  }
  if (!signal) return lifetime ? lifetime.track(start) : start()

  let removeAbortListener = () => {}
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(createAgentAbortError())
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([
      lifetime ? lifetime.track(start) : Promise.resolve().then(start),
      abortPromise,
    ])
  } finally {
    removeAbortListener()
  }
}

export async function* abortableAgentEvents<T>(
  events: AsyncIterable<T>,
  signal: AbortSignal | undefined,
  lifetime?: AgentExecutionLifetime,
): AsyncGenerator<T, void, void> {
  throwIfAgentAborted(signal)
  const iterator = events[Symbol.asyncIterator]()

  try {
    while (true) {
      const next = await runWithAgentAbort(signal, () => iterator.next(), lifetime)
      if (next.done) return
      yield next.value
    }
  } finally {
    if (lifetime) await lifetime.track(() => iterator.return?.())
    else await iterator.return?.()
  }
}

export function agentContentToText(content: AgentMessageContent | undefined): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}

export function createAgentTurnEventSynthesisState(): AgentTurnEventSynthesisState {
  return {
    textDelta: '',
    reasoningDelta: '',
    finish: false,
    providerData: false,
    toolCalls: new Map(),
  }
}

function toolCallState(
  state: AgentTurnEventSynthesisState,
  toolCallId: string,
): { start: boolean; argumentsDelta: string; done: boolean } {
  let entry = state.toolCalls.get(toolCallId)
  if (!entry) {
    entry = { start: false, argumentsDelta: '', done: false }
    state.toolCalls.set(toolCallId, entry)
  }
  return entry
}

function missingSuffix(fullText: string, emittedText: string): string {
  if (!emittedText) return fullText
  return fullText.startsWith(emittedText) ? fullText.slice(emittedText.length) : ''
}

export function recordAgentTurnStreamEvent(
  state: AgentTurnEventSynthesisState,
  event: AgentStreamEvent,
): void {
  switch (event.type) {
    case 'text-delta':
      state.textDelta += event.delta
      break
    case 'reasoning-delta':
      state.reasoningDelta += event.delta
      break
    case 'finish':
      state.finish = true
      break
    case 'provider-data':
      state.providerData = true
      break
    case 'tool-call-start':
      toolCallState(state, event.toolCallId).start = true
      break
    case 'tool-call-delta':
      toolCallState(state, event.toolCallId).argumentsDelta += event.argumentsDelta
      break
    case 'tool-call-done':
      toolCallState(state, event.toolCall.id).done = true
      break
    default:
      break
  }
}

function isAgentTurnStreamEvent(event: AgentStreamEvent): event is AgentTurnStreamEvent {
  switch (event.type) {
    case 'reasoning-delta':
    case 'text-delta':
    case 'tool-call-start':
    case 'tool-call-delta':
    case 'tool-call-done':
    case 'tool-metadata':
    case 'tool-partial-result':
    case 'tool-result':
    case 'provider-data':
    case 'finish':
      return true
    default:
      return false
  }
}

export function emitMissingAgentTurnStreamEvents(
  turn: AgentTurn,
  turnNumber: number,
  onEvent: ((event: AgentStreamEvent) => void) | undefined,
  state: AgentTurnEventSynthesisState = createAgentTurnEventSynthesisState(),
): void {
  if (!onEvent) return

  const reasoningDelta = turn.message.reasoningContent
    ? missingSuffix(turn.message.reasoningContent, state.reasoningDelta)
    : ''
  if (reasoningDelta) {
    onEvent({
      type: 'reasoning-delta',
      turn: turnNumber,
      delta: reasoningDelta,
    })
  }

  const text = agentContentToText(turn.message.content)
  const textDelta = missingSuffix(text, state.textDelta)
  if (textDelta) {
    onEvent({ type: 'text-delta', turn: turnNumber, delta: textDelta })
  }

  if (turn.message.providerData?.length && !state.providerData) {
    for (const providerData of turn.message.providerData) {
      onEvent({ type: 'provider-data', turn: turnNumber, providerData })
    }
  }

  for (const toolCall of turn.message.toolCalls ?? []) {
    const emitted = state.toolCalls.get(toolCall.id)

    if (!emitted?.start && !emitted?.argumentsDelta && !emitted?.done) {
      onEvent({
        type: 'tool-call-start',
        turn: turnNumber,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      })
    }

    const argumentsDelta = emitted?.done
      ? ''
      : missingSuffix(toolCall.arguments, emitted?.argumentsDelta ?? '')
    if (argumentsDelta) {
      onEvent({
        type: 'tool-call-delta',
        turn: turnNumber,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        argumentsDelta,
      })
    }

    if (!emitted?.done) {
      onEvent({ type: 'tool-call-done', turn: turnNumber, toolCall })
    }
  }

  if (!state.finish) {
    onEvent({
      type: 'finish',
      turn: turnNumber,
      finishReason: turn.finishReason,
      usage: turn.usage,
    })
  }
}

export async function collectAgentTurnFromStream(
  events: AsyncIterable<AgentTurnStreamEvent>,
  onEvent?: (event: AgentStreamEvent) => void,
): Promise<AgentTurn> {
  let content = ''
  let reasoningContent = ''
  let finishReason: AgentTurn['finishReason'] = 'unknown'
  let usage: AgentTurn['usage']
  const toolCalls: AgentTurn['message']['toolCalls'] = []
  const providerData: AgentProviderData[] = []

  for await (const event of events) {
    onEvent?.(event)

    switch (event.type) {
      case 'text-delta':
        content += event.delta
        break
      case 'reasoning-delta':
        reasoningContent += event.delta
        break
      case 'tool-call-done':
        toolCalls.push(event.toolCall)
        break
      case 'provider-data':
        providerData.push(event.providerData)
        break
      case 'finish':
        finishReason = event.finishReason
        usage = event.usage
        break
      default:
        break
    }
  }

  return {
    message: {
      role: 'assistant',
      content,
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(providerData.length ? { providerData } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    },
    finishReason,
    usage,
  }
}

export async function* streamAgentProviderTurnEvents(
  provider: AgentProvider,
  request: AgentTurnRequest,
): AsyncGenerator<AgentTurnStreamEvent, void, void> {
  if (isAgentStreamingProvider(provider)) {
    yield* abortableAgentEvents(provider.streamTurn(request), request.abortSignal, request.executionLifetime)
    return
  }

  if (!isAgentRunnableProvider(provider)) return

  const eventState = createAgentTurnEventSynthesisState()
  const queue = new AgentEventQueue<AgentTurnStreamEvent>()
  const run = (async () => {
    try {
      const turn = await runWithAgentAbort(request.abortSignal, () => provider.runTurn({
        ...request,
        onEvent(event) {
          if (event.turn === request.turn) {
            recordAgentTurnStreamEvent(eventState, event)
          }
          if (isAgentTurnStreamEvent(event)) {
            queue.push(event)
          }
        },
      }), request.executionLifetime)
      emitMissingAgentTurnStreamEvents(
        turn,
        request.turn,
        (event) => {
          if (isAgentTurnStreamEvent(event)) {
            queue.push(event)
          }
        },
        eventState,
      )
      queue.close()
    } catch (error) {
      queue.fail(errorFromThrown(error instanceof Error ? error : String(error)))
    }
  })()

  for await (const event of queue) {
    yield event
  }
  await run
}
