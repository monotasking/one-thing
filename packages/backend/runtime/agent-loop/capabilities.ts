import type {
  AgentCapability,
  AgentInputModality,
  AgentMessage,
  AgentMessageContent,
  AgentModelCapabilities,
  AgentOutputModality,
  AgentExecutableProvider,
  AgentProvider,
  AgentRunnableProvider,
  AgentStreamingProvider,
} from './types.js'

export const TEXT_ONLY_AGENT_CAPABILITIES: AgentModelCapabilities = {
  capabilities: ['text-input', 'text-output'],
  inputModalities: ['text'],
  outputModalities: ['text'],
}

export async function resolveAgentModelCapabilities(
  provider: AgentProvider,
  model: string,
): Promise<AgentModelCapabilities> {
  return provider.getModelCapabilities?.(model)
    ?? provider.capabilities
    ?? TEXT_ONLY_AGENT_CAPABILITIES
}

export function agentSupportsCapability(
  capabilities: AgentModelCapabilities,
  capability: AgentCapability,
): boolean {
  return capabilities.capabilities.includes(capability)
}

export function agentSupportsInputModality(
  capabilities: AgentModelCapabilities,
  modality: AgentInputModality,
): boolean {
  if (capabilities.inputModalities.includes(modality)) return true

  switch (modality) {
    case 'text':
      return agentSupportsCapability(capabilities, 'text-input')
    case 'image':
      return agentSupportsCapability(capabilities, 'vision-input')
    case 'file':
      return agentSupportsCapability(capabilities, 'file-input')
    case 'audio':
      return agentSupportsCapability(capabilities, 'audio-input')
    case 'video':
      return agentSupportsCapability(capabilities, 'video-input')
    default:
      return false
  }
}

export function agentSupportsOutputModality(
  capabilities: AgentModelCapabilities,
  modality: AgentOutputModality,
): boolean {
  if (capabilities.outputModalities.includes(modality)) return true

  switch (modality) {
    case 'text':
      return agentSupportsCapability(capabilities, 'text-output')
    case 'image':
      return agentSupportsCapability(capabilities, 'image-output')
    case 'file':
      return agentSupportsCapability(capabilities, 'file-output')
    case 'audio':
      return agentSupportsCapability(capabilities, 'audio-output')
    case 'video':
      return agentSupportsCapability(capabilities, 'video-output')
    default:
      return false
  }
}

export function agentSupportsTools(capabilities: AgentModelCapabilities): boolean {
  return capabilities.supportsTools === true || agentSupportsCapability(capabilities, 'tool-calls')
}

/**
 * May the loop force a tool call on this model (`toolChoice: 'required'`)?
 *
 * Strict opt-in, unlike the other capability probes: an unknown endpoint that
 * does not understand the parameter answers with a 400, which would break a
 * turn that works fine today. Silence therefore means "no", and the caller's
 * forced choice is dropped rather than attempted.
 */
export function agentSupportsForcedToolUse(capabilities: AgentModelCapabilities): boolean {
  return capabilities.supportsForcedToolUse === true
}

export function agentSupportsStructuredToolResults(capabilities: AgentModelCapabilities): boolean {
  return capabilities.supportsStructuredToolResults === true ||
    agentSupportsCapability(capabilities, 'structured-tool-results')
}

export function agentSupportsToolResultModality(
  capabilities: AgentModelCapabilities,
  modality: AgentInputModality,
): boolean {
  if (modality === 'text') return true
  if (!agentSupportsStructuredToolResults(capabilities)) return false
  return capabilities.toolResultModalities?.includes(modality) === true
}

export function isAgentStreamingProvider(provider: AgentProvider): provider is AgentStreamingProvider {
  return typeof provider.streamTurn === 'function'
}

export function isAgentRunnableProvider(provider: AgentProvider): provider is AgentRunnableProvider {
  return typeof provider.runTurn === 'function'
}

export function agentProviderCanRunTurn(provider: AgentProvider): provider is AgentExecutableProvider {
  return typeof provider.streamTurn === 'function' || typeof provider.runTurn === 'function'
}

export function assertAgentProviderCanRunTurn(provider: AgentProvider): void {
  if (!agentProviderCanRunTurn(provider)) {
    throw new Error(`Agent provider ${provider.id} does not implement streamTurn or runTurn`)
  }
}

export function inputModalitiesFromAgentContent(content: AgentMessageContent | undefined): AgentInputModality[] {
  if (content == null || content === '') return []
  if (typeof content === 'string') return ['text']

  const modalities = new Set<AgentInputModality>()
  for (const part of content) {
    switch (part.type) {
      case 'text':
        if (part.text) modalities.add('text')
        break
      case 'image':
        modalities.add('image')
        break
      case 'file':
        modalities.add('file')
        break
      case 'audio':
        modalities.add('audio')
        break
      case 'video':
        modalities.add('video')
        break
      default:
        break
    }
  }
  return [...modalities]
}

export function assertAgentMessagesSupportedByCapabilities(
  messages: AgentMessage[],
  capabilities: AgentModelCapabilities,
): void {
  for (const message of messages) {
    for (const modality of inputModalitiesFromAgentContent(message.content)) {
      if (message.role === 'tool') {
        if (!agentSupportsToolResultModality(capabilities, modality)) {
          throw new Error(`Agent provider does not support ${modality} tool-result input`)
        }
        continue
      }
      if (!agentSupportsInputModality(capabilities, modality)) {
        throw new Error(`Agent provider does not support ${modality} input for role "${message.role}"`)
      }
    }
  }
}

export function assertAgentOutputModalitiesSupportedByCapabilities(
  modalities: AgentOutputModality[] | undefined,
  capabilities: AgentModelCapabilities,
): void {
  for (const modality of modalities ?? []) {
    if (!agentSupportsOutputModality(capabilities, modality)) {
      throw new Error(`Agent provider does not support ${modality} output`)
    }
  }
}

export async function providerSupportsCapability(
  provider: AgentProvider,
  model: string,
  capability: AgentCapability,
): Promise<boolean> {
  return agentSupportsCapability(
    await resolveAgentModelCapabilities(provider, model),
    capability,
  )
}

export async function providerSupportsInputModality(
  provider: AgentProvider,
  model: string,
  modality: AgentInputModality,
): Promise<boolean> {
  return agentSupportsInputModality(
    await resolveAgentModelCapabilities(provider, model),
    modality,
  )
}

export async function providerSupportsToolResultModality(
  provider: AgentProvider,
  model: string,
  modality: AgentInputModality,
): Promise<boolean> {
  return agentSupportsToolResultModality(
    await resolveAgentModelCapabilities(provider, model),
    modality,
  )
}

export async function providerSupportsOutputModality(
  provider: AgentProvider,
  model: string,
  modality: AgentOutputModality,
): Promise<boolean> {
  return agentSupportsOutputModality(
    await resolveAgentModelCapabilities(provider, model),
    modality,
  )
}
