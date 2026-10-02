export interface OnethingHeadlessSessionLike {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  previewText?: string
  messageCount?: number
  isPinned?: boolean
  isArchived?: boolean
  lastProvider?: string
  lastModel?: string
}

export interface OnethingHeadlessSessionSummary {
  id: string
  name: string
  updatedAt: number
  createdAt: number
  previewText?: string
  messageCount?: number
  isPinned?: boolean
  isArchived?: boolean
  lastProvider?: string
  lastModel?: string
}

export interface OnethingHeadlessProviderConfigLike {
  model?: string
  enabled?: boolean
  selectedModels?: string[]
  models?: Record<string, unknown>
}

export interface OnethingHeadlessSettingsLike<
  TProviderConfig extends OnethingHeadlessProviderConfigLike = OnethingHeadlessProviderConfigLike,
  TPermissionMode extends string = string,
> {
  ai: {
    provider?: string
    providers: Record<string, TProviderConfig>
  }
  tools: {
    permissionMode?: TPermissionMode
    tools: Record<string, OnethingHeadlessToolSetting>
  }
}

export interface OnethingHeadlessProviderSummary {
  id: string
  model?: string
  enabled?: boolean
  selectedModels?: string[]
  isDefault: boolean
}

export interface OnethingHeadlessToolLike {
  id: string
  name: string
  enabled: boolean
  autoExecute: boolean
  category: 'builtin' | 'custom'
}

export interface OnethingHeadlessToolSummary {
  id: string
  name: string
  enabled: boolean
  autoExecute: boolean
  category: 'builtin' | 'custom'
}

export interface OnethingHeadlessToolSetting {
  enabled: boolean
  autoExecute: boolean
}

export interface OnethingHeadlessToolUpdate {
  enabled?: boolean
  autoExecute?: boolean
}

export type OnethingHeadlessProviderUpdate<TProviderConfig extends OnethingHeadlessProviderConfigLike> =
  Partial<TProviderConfig>
  & {
    enabled?: boolean
    model?: string
    selectedModels?: string[]
  }

type ProviderConfigOf<TSettings extends OnethingHeadlessSettingsLike> =
  TSettings['ai']['providers'][string]

export function projectOnethingHeadlessSessionSummary(
  session: OnethingHeadlessSessionLike,
): OnethingHeadlessSessionSummary {
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    previewText: session.previewText,
    messageCount: session.messageCount,
    isPinned: session.isPinned,
    isArchived: session.isArchived,
    lastProvider: session.lastProvider,
    lastModel: session.lastModel,
  }
}

export function listOnethingHeadlessSessionSummaries(
  sessions: OnethingHeadlessSessionLike[],
): OnethingHeadlessSessionSummary[] {
  return sessions.map(projectOnethingHeadlessSessionSummary)
}

export function projectOnethingHeadlessProviderSummary(
  id: string,
  config: OnethingHeadlessProviderConfigLike | undefined,
  defaultProviderId?: string,
): OnethingHeadlessProviderSummary {
  return {
    id,
    model: config?.model,
    enabled: config?.enabled,
    selectedModels: config?.selectedModels,
    isDefault: defaultProviderId === id,
  }
}

export function listOnethingHeadlessProviderSummaries(
  settings: OnethingHeadlessSettingsLike,
): OnethingHeadlessProviderSummary[] {
  return Object.entries(settings.ai.providers || {}).map(([id, config]) =>
    projectOnethingHeadlessProviderSummary(id, config, settings.ai.provider)
  )
}

export function upsertOnethingHeadlessProviderConfig<
  TSettings extends OnethingHeadlessSettingsLike,
>(
  settings: TSettings,
  providerId: string,
  update: OnethingHeadlessProviderUpdate<ProviderConfigOf<TSettings>>,
  createDefaultProvider: () => ProviderConfigOf<TSettings>,
): OnethingHeadlessProviderSummary {
  const existing = settings.ai.providers[providerId] ?? createDefaultProvider()
  const next = {
    ...existing,
    ...update,
    selectedModels: update.selectedModels ?? existing.selectedModels ?? [],
  } as ProviderConfigOf<TSettings>
  settings.ai.providers[providerId] = next
  return projectOnethingHeadlessProviderSummary(providerId, next, settings.ai.provider)
}

export function useOnethingHeadlessProvider<
  TSettings extends OnethingHeadlessSettingsLike,
>(
  settings: TSettings,
  providerId: string,
  model?: string,
): OnethingHeadlessProviderSummary {
  const provider = settings.ai.providers[providerId]
  if (!provider) throw new Error(`Provider not found: ${providerId}`)
  // **目录里认识 ≠ 这个空间配过**。合成(`composeEffectiveAISettings`)会给每个
  // 目录里有缓存的 provider 补一条「全灭壳」`{model:'', selectedModels:[],
  // enabled:false}`,所以 `providers[id]` 在,只说明它有个名字。
  //
  // 此前这里不看 `enabled` 就两件事一起做:(1) 把 `ai.provider` 翻过去、
  // (2) 把 `model` 盖到那条壳上。而 `model` 一非空就骗过 `isBlankProviderRecord`
  // (`@shared/defaults/ai-settings.ts`),于是 `splitEffectiveAISettings` 把这条
  // 本该被摘掉的展示壳连同翻掉的 `ai.provider` 一起写进了
  // `workspaces/<id>/providers.json` —— 真机上表现为「实际用的模型 ≠ 界面显示的
  // 模型」,而且空间的默认 provider 被静默改掉。
  //
  // 选一个没开的 provider 是**错误**,不是一次静默降级:先校验,后改状态。
  if (provider.enabled !== true) {
    throw new Error(
      `Provider is not enabled: ${providerId}. Enable it first (\`provider enable ${providerId}\`).`,
    )
  }
  settings.ai.provider = providerId
  if (model) provider.model = model
  return projectOnethingHeadlessProviderSummary(providerId, provider, settings.ai.provider)
}

export function listOnethingHeadlessProviderModels(
  settings: OnethingHeadlessSettingsLike,
  providerId: string,
): string[] {
  const provider = settings.ai.providers[providerId]
  if (!provider) throw new Error(`Provider not found: ${providerId}`)
  const fromRegistry = Object.keys(provider.models || {})
  return Array.from(new Set([
    ...(provider.selectedModels || []),
    provider.model,
    ...fromRegistry,
  ].filter(Boolean) as string[]))
}

export function projectOnethingHeadlessToolSummary(
  tool: OnethingHeadlessToolLike,
): OnethingHeadlessToolSummary {
  return {
    id: tool.id,
    name: tool.name,
    enabled: tool.enabled,
    autoExecute: tool.autoExecute,
    category: tool.category,
  }
}

export function listOnethingHeadlessToolSummaries(
  tools: OnethingHeadlessToolLike[],
): OnethingHeadlessToolSummary[] {
  return tools.map(projectOnethingHeadlessToolSummary)
}

export function updateOnethingHeadlessToolSetting(
  settings: OnethingHeadlessSettingsLike,
  toolId: string,
  update: OnethingHeadlessToolUpdate,
): void {
  const current = settings.tools.tools[toolId] || { enabled: true, autoExecute: false }
  settings.tools.tools[toolId] = {
    enabled: update.enabled ?? current.enabled,
    autoExecute: update.autoExecute ?? current.autoExecute,
  }
}

export function setOnethingHeadlessPermissionMode<
  TSettings extends OnethingHeadlessSettingsLike<OnethingHeadlessProviderConfigLike, string>,
>(
  settings: TSettings,
  mode: string,
): TSettings {
  settings.tools.permissionMode = mode
  return settings
}
