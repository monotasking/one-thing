import { describe, expect, it, vi } from 'vitest'
import {
  buildTextStreamContext,
  executeCoreMessageStream,
  resolveStreamExecutionRoute,
  specialStreamExecutionResult,
  streamExecutionErrorResult,
  textStreamExecutionResult,
} from '@onething/core/engine'
import type { CoreInitialToolChoice } from '@onething/core/engine'

describe('core stream executor helpers', () => {
  it('routes special-stream-capable models to the special path', () => {
    expect(resolveStreamExecutionRoute({ supportsSpecialStream: true })).toEqual({ kind: 'special' })
    expect(resolveStreamExecutionRoute({ supportsSpecialStream: false })).toEqual({ kind: 'text' })
  })

  it('normalizes stream execution results and controller cleanup decisions', () => {
    expect(specialStreamExecutionResult(true)).toEqual({
      handled: true,
      usedSpecialStream: true,
      pausedForConfirmation: false,
      shouldRemoveController: true,
    })

    expect(textStreamExecutionResult({ pausedForConfirmation: true })).toEqual({
      handled: true,
      usedSpecialStream: false,
      pausedForConfirmation: true,
      shouldRemoveController: false,
    })

    expect(textStreamExecutionResult({ pausedForConfirmation: false })).toMatchObject({
      shouldRemoveController: true,
    })
    expect(streamExecutionErrorResult()).toEqual({ shouldRemoveController: true })
  })

  it('builds text stream context with voice speak-mode fallback', () => {
    expect(buildTextStreamContext({
      base: { sessionId: 's1' },
      steeringQueue: { kind: 'steering' },
      followUpQueue: { kind: 'follow-up' },
      voiceConversation: true,
    })).toEqual({
      sessionId: 's1',
      steeringQueue: { kind: 'steering' },
      followUpQueue: { kind: 'follow-up' },
      voiceConversation: true,
      speakMode: true,
    })
  })

  it('executes text streams through injected headless adapters and removes completed controllers', async () => {
    const controller = { signal: { aborted: false } }
    const calls: string[] = []
    const registry = {
      registerController: vi.fn((sessionId: string) => calls.push(`register:${sessionId}`)),
      removeController: vi.fn((sessionId: string) => calls.push(`remove:${sessionId}`)),
      getSteeringQueue: vi.fn(() => ({ kind: 'steering' })),
      getFollowUpQueue: vi.fn(() => ({ kind: 'follow-up' })),
    }

    const result = await executeCoreMessageStream({
      params: {
        sender: { id: 'sender' },
        sessionId: 's1',
        assistantMessageId: 'a1',
        messageContent: 'hello',
        historyMessages: [{ role: 'user', content: 'hello' }],
        configWithApiKey: { apiKey: 'key', model: 'text-model' },
        providerId: 'test',
        requestedOutputModalities: ['text'],
        settings: { theme: 'dark' },
        toolSettings: { enabled: true },
        voiceConversation: true,
      },
      controller,
      createController: () => {
        throw new Error('provided controller should be used')
      },
      registry,
      supportsSpecialStream: vi.fn(async () => false),
      processSpecialStream: vi.fn(async () => {
        throw new Error('special stream path should not run')
      }),
      executeTextStream: vi.fn(async (ctx, historyMessages, sessionName) => {
        expect(ctx).toMatchObject({
          sessionId: 's1',
          assistantMessageId: 'a1',
          abortSignal: controller.signal,
          providerConfig: { model: 'text-model' },
          steeringQueue: { kind: 'steering' },
          followUpQueue: { kind: 'follow-up' },
          voiceConversation: true,
          speakMode: true,
        })
        expect(historyMessages).toEqual([{ role: 'user', content: 'hello' }])
        expect(sessionName).toBeUndefined()
        return {}
      }),
      logger: { log: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({
      handled: true,
      usedSpecialStream: false,
      pausedForConfirmation: undefined,
      shouldRemoveController: true,
    })
    expect(calls).toEqual(['register:s1', 'remove:s1'])
  })

  it('carries initialToolChoice from the command onto the text stream context (W18b/W22)', async () => {
    // The middle link of the 透传链: the room drive sets the field on the
    // send-message command, and the agent loop reads it off the stream context.
    // A destructure that forgets it here breaks the chain silently — nothing
    // throws, the drive simply stops being forced.
    // W22 carries a NAMED choice rather than the bare 'required', so the object
    // form is the one that has to survive the passthrough.
    const registry = {
      registerController: vi.fn(),
      removeController: vi.fn(),
      getSteeringQueue: vi.fn(),
      getFollowUpQueue: vi.fn(),
    }
    let seenContext: { initialToolChoice?: CoreInitialToolChoice } | undefined

    await executeCoreMessageStream({
      params: {
        sender: {},
        sessionId: 's1',
        assistantMessageId: 'a1',
        messageContent: 'drive',
        historyMessages: [],
        configWithApiKey: { apiKey: 'key', model: 'text-model' },
        providerId: 'test',
        settings: {},
        initialToolChoice: { type: 'function', function: { name: 'say' } },
      },
      createController: () => ({ signal: { aborted: false } }),
      registry,
      supportsSpecialStream: vi.fn(async () => false),
      processSpecialStream: vi.fn(async () => false),
      executeTextStream: vi.fn(async (ctx: { initialToolChoice?: CoreInitialToolChoice }) => {
        seenContext = ctx
        return {}
      }),
      logger: { log: vi.fn(), error: vi.fn() },
    })

    expect(seenContext).toMatchObject({
      initialToolChoice: { type: 'function', function: { name: 'say' } },
    })
  })

  it('leaves initialToolChoice unset for ordinary turns', async () => {
    const registry = {
      registerController: vi.fn(),
      removeController: vi.fn(),
      getSteeringQueue: vi.fn(),
      getFollowUpQueue: vi.fn(),
    }
    let seenContext: { initialToolChoice?: CoreInitialToolChoice } | undefined

    await executeCoreMessageStream({
      params: {
        sender: {},
        sessionId: 's1',
        assistantMessageId: 'a1',
        messageContent: 'hello',
        historyMessages: [],
        configWithApiKey: { apiKey: 'key', model: 'text-model' },
        providerId: 'test',
        settings: {},
      },
      createController: () => ({ signal: { aborted: false } }),
      registry,
      supportsSpecialStream: vi.fn(async () => false),
      processSpecialStream: vi.fn(async () => false),
      executeTextStream: vi.fn(async (ctx: { initialToolChoice?: CoreInitialToolChoice }) => {
        seenContext = ctx
        return {}
      }),
      logger: { log: vi.fn(), error: vi.fn() },
    })

    expect(seenContext?.initialToolChoice).toBeUndefined()
  })

  it('keeps text stream controllers when paused for confirmation', async () => {
    const registry = {
      registerController: vi.fn(),
      removeController: vi.fn(),
      getSteeringQueue: vi.fn(),
      getFollowUpQueue: vi.fn(),
    }

    const result = await executeCoreMessageStream({
      params: {
        sender: {},
        sessionId: 's1',
        assistantMessageId: 'a1',
        messageContent: 'hello',
        historyMessages: [],
        configWithApiKey: { apiKey: 'key', model: 'text-model' },
        providerId: 'test',
        settings: {},
      },
      createController: () => ({ signal: { aborted: false } }),
      registry,
      supportsSpecialStream: vi.fn(async () => false),
      processSpecialStream: vi.fn(async () => false),
      executeTextStream: vi.fn(async () => ({ pausedForConfirmation: true })),
      logger: { log: vi.fn(), error: vi.fn() },
    })

    expect(result.pausedForConfirmation).toBe(true)
    expect(result.shouldRemoveController).toBe(false)
    expect(registry.removeController).not.toHaveBeenCalled()
  })

  it('executes special streams through injected adapters and skips text generation', async () => {
    const processSpecialStream = vi.fn(async () => true)
    const executeTextStream = vi.fn(async () => ({}))
    const registry = {
      registerController: vi.fn(),
      removeController: vi.fn(),
      getSteeringQueue: vi.fn(),
      getFollowUpQueue: vi.fn(),
    }

    const result = await executeCoreMessageStream({
      params: {
        sender: { id: 'sender' },
        sessionId: 's1',
        assistantMessageId: 'a1',
        messageContent: 'draw this',
        historyMessages: [],
        configWithApiKey: { apiKey: 'key', model: 'special-model', baseUrl: 'https://example.test' },
        providerId: 'special-provider',
        settings: {},
        sessionName: 'Sketch',
      },
      createController: () => ({ signal: { aborted: false } }),
      registry,
      supportsSpecialStream: vi.fn(async () => true),
      processSpecialStream,
      executeTextStream,
      logger: { log: vi.fn(), error: vi.fn() },
    })

    expect(processSpecialStream).toHaveBeenCalledWith({
      sender: { id: 'sender' },
      sessionId: 's1',
      assistantMessageId: 'a1',
      prompt: 'draw this',
      providerId: 'special-provider',
      apiKey: 'key',
      model: 'special-model',
      baseUrl: 'https://example.test',
      sessionName: 'Sketch',
    })
    expect(executeTextStream).not.toHaveBeenCalled()
    expect(registry.removeController).toHaveBeenCalledWith('s1')
    expect(result).toMatchObject({
      handled: true,
      usedSpecialStream: true,
      shouldRemoveController: true,
    })
  })
})
