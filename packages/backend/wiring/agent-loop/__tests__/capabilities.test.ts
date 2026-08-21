import { describe, expect, it } from 'vitest'
import {
  agentProviderCanRunTurn,
  agentSupportsInputModality,
  agentSupportsOutputModality,
  agentSupportsStructuredToolResults,
  agentSupportsToolResultModality,
  assertAgentProviderCanRunTurn,
  assertAgentMessagesSupportedByCapabilities,
  assertAgentOutputModalitiesSupportedByCapabilities,
  inputModalitiesFromAgentContent,
  isAgentRunnableProvider,
  isAgentStreamingProvider,
  providerSupportsInputModality,
  providerSupportsOutputModality,
  providerSupportsToolResultModality,
} from '@onething/core/agent-loop'
import type { AgentModelCapabilities, AgentProvider } from '@onething/core/agent-loop'

describe('agent loop capabilities', () => {
  it('detects audio and video input modalities from content parts', () => {
    expect(inputModalitiesFromAgentContent([
      { type: 'text', text: 'watch this' },
      { type: 'audio', audio: 'data:audio/wav;base64,abc', mediaType: 'audio/wav' },
      { type: 'video', video: 'data:video/mp4;base64,abc', mediaType: 'video/mp4' },
    ])).toEqual(['text', 'audio', 'video'])
  })

  it('maps modality support through explicit input lists or capability flags', () => {
    expect(agentSupportsInputModality({
      capabilities: ['text-input', 'text-output', 'video-input'],
      inputModalities: ['text'],
      outputModalities: ['text'],
    }, 'video')).toBe(true)

    expect(() => assertAgentMessagesSupportedByCapabilities([
      {
        role: 'user',
        content: [{ type: 'audio', audio: 'data:audio/wav;base64,abc', mediaType: 'audio/wav' }],
      },
    ], {
      capabilities: ['text-input', 'text-output'],
      inputModalities: ['text'],
      outputModalities: ['text'],
    })).toThrow('Agent provider does not support audio input for role "user"')
  })

  it('maps output modality support through explicit output lists or capability flags', () => {
    expect(agentSupportsOutputModality({
      capabilities: ['text-input', 'text-output', 'image-output', 'file-output'],
      inputModalities: ['text'],
      outputModalities: ['text'],
    }, 'image')).toBe(true)
    expect(agentSupportsOutputModality({
      capabilities: ['text-input', 'text-output', 'image-output', 'file-output'],
      inputModalities: ['text'],
      outputModalities: ['text'],
    }, 'file')).toBe(true)
    expect(agentSupportsOutputModality({
      capabilities: ['text-input', 'text-output'],
      inputModalities: ['text'],
      outputModalities: ['text', 'audio'],
    }, 'audio')).toBe(true)
    expect(agentSupportsOutputModality({
      capabilities: ['text-input', 'text-output'],
      inputModalities: ['text'],
      outputModalities: ['text'],
    }, 'video')).toBe(false)
  })

  it('asserts requested output modalities against provider capabilities', () => {
    const capabilities: AgentModelCapabilities = {
      capabilities: ['text-input', 'text-output', 'image-output'],
      inputModalities: ['text'],
      outputModalities: ['text'],
    }

    expect(() => assertAgentOutputModalitiesSupportedByCapabilities(['text', 'image'], capabilities))
      .not.toThrow()
    expect(() => assertAgentOutputModalitiesSupportedByCapabilities(['audio'], capabilities))
      .toThrow('Agent provider does not support audio output')
  })

  it('exposes provider-level modality checks for provider factories and callers', async () => {
    const provider: AgentProvider = {
      id: 'multi-provider',
      getModelCapabilities: async () => ({
        capabilities: ['text-input', 'text-output', 'audio-output'],
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      }),
    }

    await expect(providerSupportsInputModality(provider, 'multi-model', 'image')).resolves.toBe(true)
    await expect(providerSupportsOutputModality(provider, 'multi-model', 'audio')).resolves.toBe(true)
    await expect(providerSupportsOutputModality(provider, 'multi-model', 'video')).resolves.toBe(false)
  })

  it('separates tool-result media support from normal input modality support', async () => {
    const capabilities: AgentModelCapabilities = {
      capabilities: ['text-input', 'text-output', 'tool-calls', 'structured-tool-results'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      toolResultModalities: ['text', 'image'],
      supportsTools: true,
    }

    expect(agentSupportsStructuredToolResults(capabilities)).toBe(true)
    expect(agentSupportsToolResultModality(capabilities, 'image')).toBe(true)
    expect(agentSupportsToolResultModality(capabilities, 'file')).toBe(false)
    expect(() => assertAgentMessagesSupportedByCapabilities([
      {
        role: 'tool',
        toolCallId: 'call_1',
        content: [{ type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' }],
      },
    ], capabilities)).not.toThrow()
    expect(() => assertAgentMessagesSupportedByCapabilities([
      {
        role: 'tool',
        toolCallId: 'call_1',
        content: [{ type: 'file', data: 'pdfbase64', mediaType: 'application/pdf' }],
      },
    ], capabilities)).toThrow('Agent provider does not support file tool-result input')

    const provider: AgentProvider = { id: 'rich-tool-result-provider', capabilities }
    await expect(providerSupportsToolResultModality(provider, 'rich-model', 'image')).resolves.toBe(true)
    await expect(providerSupportsToolResultModality(provider, 'rich-model', 'audio')).resolves.toBe(false)
  })

  it('exposes a provider execution-interface guard for runtime builders', () => {
    const streamProvider: AgentProvider = {
      id: 'stream-provider',
      async *streamTurn() {
        yield { type: 'finish', turn: 1, finishReason: 'stop' }
      },
    }
    const runProvider: AgentProvider = {
      id: 'run-provider',
      runTurn: async () => ({
        message: { role: 'assistant', content: 'ok' },
        finishReason: 'stop',
      }),
    }

    expect(isAgentStreamingProvider(streamProvider)).toBe(true)
    expect(isAgentRunnableProvider(streamProvider)).toBe(false)
    expect(isAgentRunnableProvider(runProvider)).toBe(true)
    expect(isAgentStreamingProvider(runProvider)).toBe(false)
    expect(agentProviderCanRunTurn(streamProvider)).toBe(true)
    expect(agentProviderCanRunTurn(runProvider)).toBe(true)

    const incompleteProvider: AgentProvider = { id: 'incomplete-provider' }
    expect(agentProviderCanRunTurn(incompleteProvider)).toBe(false)
    expect(() => assertAgentProviderCanRunTurn(incompleteProvider))
      .toThrow('Agent provider incomplete-provider does not implement streamTurn or runTurn')
  })
})
