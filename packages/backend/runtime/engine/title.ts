export interface StreamEngineProviderConfigLike {
  model?: string
  selectedModels?: string[]
}

export interface StreamEngineToolCallModelSettings {
  providerId?: string
  model?: string
}

export interface StreamEngineSettingsWithProviders<TProviderConfig extends StreamEngineProviderConfigLike> {
  ai: {
    provider?: string
    providers: Record<string, TProviderConfig | undefined>
  }
  tools?: {
    toolCallModel?: StreamEngineToolCallModelSettings
  }
}

export function generateTitleFromMessage(content: string, maxLength: number = 30): string {
  const cleaned = content.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return cleaned.slice(0, maxLength).trim() + '...'
}

export function resolveToolCallModel<TProviderConfig extends StreamEngineProviderConfigLike>(
  settings: StreamEngineSettingsWithProviders<TProviderConfig>,
): {
  providerId: string
  providerConfig: TProviderConfig | undefined
  model: string
} {
  const configuredProviderId = settings.tools?.toolCallModel?.providerId?.trim()
  const configuredModel = settings.tools?.toolCallModel?.model?.trim()
  const fallbackProviderId = settings.ai.provider ||
    Object.entries(settings.ai.providers).find(([, config]) => Boolean(config?.model || config?.selectedModels?.[0]))?.[0] ||
    ''
  const providerId = configuredProviderId && settings.ai.providers[configuredProviderId]
    ? configuredProviderId
    : fallbackProviderId
  const providerConfig = providerId ? settings.ai.providers[providerId] : undefined
  const model = providerId === configuredProviderId && configuredModel
    ? configuredModel
    : providerConfig?.model || providerConfig?.selectedModels?.[0] || ''

  return { providerId, providerConfig, model }
}

export function normalizeSessionTitle(title: string): string {
  const cleaned = title
    .replace(/\s+/g, ' ')
    .replace(/^[`"'\u201c\u201d\u2018\u2019#:\-\s]+/, '')
    .replace(/[`"'\u201c\u201d\u2018\u2019\s]+$/, '')
    .replace(/^title\s*:\s*/i, '')
    .trim()
  return Array.from(cleaned).slice(0, 60).join('').trim()
}

export function canApplyGeneratedSessionTitle(currentName: string | undefined, expectedName: string): boolean {
  const current = (currentName || '').trim()
  const expected = (expectedName || '').trim()
  if (current === expected) return true
  return (current === '' || current === 'New Chat') && (expected === '' || expected === 'New Chat')
}
