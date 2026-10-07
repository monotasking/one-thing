/**
 * CLI 给人看的几种投影:会话 / 服务商 / 工具的摘要行,以及「改哪一格设置」的三只纯函数。
 *
 * 第④步批 3 从 `packages/backend/headless/headless-cli-projections.ts` 原样搬来(CLI 守护进程退役,只有 CLI 用它们;
 * 施工单 §1.3「三只投影函数搬到 CLI 侧」)。名字里的 `OnethingHeadless` 换成了 `Cli`,函数体一行没改。
 * 设置那三只吃的是 `settings.getSettings` 拿回来的那一份,改完经 `settings.saveSettings` 交回去(见 `backend-requests.ts`)。
 */
export interface CliSessionLike {
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

export interface CliSessionSummary {
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

export interface CliProviderConfigLike {
  model?: string
  enabled?: boolean
  selectedModels?: string[]
  models?: Record<string, unknown>
}

export interface CliSettingsLike<
  TProviderConfig extends CliProviderConfigLike = CliProviderConfigLike,
  TPermissionMode extends string = string,
> {
  ai: {
    provider?: string
    providers: Record<string, TProviderConfig>
  }
  tools: {
    permissionMode?: TPermissionMode
    tools: Record<string, CliToolSetting>
  }
}

export interface CliProviderSummary {
  id: string
  model?: string
  enabled?: boolean
  selectedModels?: string[]
  isDefault: boolean
}

export interface CliToolLike {
  id: string
  name: string
  enabled: boolean
  autoExecute: boolean
  category: 'builtin' | 'custom'
}

export interface CliToolSummary {
  id: string
  name: string
  enabled: boolean
  autoExecute: boolean
  category: 'builtin' | 'custom'
}

export interface CliToolSetting {
  enabled: boolean
  autoExecute: boolean
}

export interface CliToolUpdate {
  enabled?: boolean
  autoExecute?: boolean
}

export type CliProviderUpdate<TProviderConfig extends CliProviderConfigLike> =
  Partial<TProviderConfig>
  & {
    enabled?: boolean
    model?: string
    selectedModels?: string[]
  }

type ProviderConfigOf<TSettings extends CliSettingsLike> =
  TSettings['ai']['providers'][string]

export function projectCliSessionSummary(
  session: CliSessionLike,
): CliSessionSummary {
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

export function listCliSessionSummaries(
  sessions: CliSessionLike[],
): CliSessionSummary[] {
  return sessions.map(projectCliSessionSummary)
}

export function projectCliProviderSummary(
  id: string,
  config: CliProviderConfigLike | undefined,
  defaultProviderId?: string,
): CliProviderSummary {
  return {
    id,
    model: config?.model,
    enabled: config?.enabled,
    selectedModels: config?.selectedModels,
    isDefault: defaultProviderId === id,
  }
}

export function listCliProviderSummaries(
  settings: CliSettingsLike,
): CliProviderSummary[] {
  return Object.entries(settings.ai.providers || {}).map(([id, config]) =>
    projectCliProviderSummary(id, config, settings.ai.provider)
  )
}

export function upsertCliProviderConfig<
  TSettings extends CliSettingsLike,
>(
  settings: TSettings,
  providerId: string,
  update: CliProviderUpdate<ProviderConfigOf<TSettings>>,
  createDefaultProvider: () => ProviderConfigOf<TSettings>,
): CliProviderSummary {
  const existing = settings.ai.providers[providerId] ?? createDefaultProvider()
  const next = {
    ...existing,
    ...update,
    selectedModels: update.selectedModels ?? existing.selectedModels ?? [],
  } as ProviderConfigOf<TSettings>
  settings.ai.providers[providerId] = next
  return projectCliProviderSummary(providerId, next, settings.ai.provider)
}

export function useCliProvider<
  TSettings extends CliSettingsLike,
>(
  settings: TSettings,
  providerId: string,
  model?: string,
): CliProviderSummary {
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
  return projectCliProviderSummary(providerId, provider, settings.ai.provider)
}

export function listCliProviderModels(
  settings: CliSettingsLike,
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

export function projectCliToolSummary(
  tool: CliToolLike,
): CliToolSummary {
  return {
    id: tool.id,
    name: tool.name,
    enabled: tool.enabled,
    autoExecute: tool.autoExecute,
    category: tool.category,
  }
}

export function listCliToolSummaries(
  tools: CliToolLike[],
): CliToolSummary[] {
  return tools.map(projectCliToolSummary)
}

export function updateCliToolSetting(
  settings: CliSettingsLike,
  toolId: string,
  update: CliToolUpdate,
): void {
  const current = settings.tools.tools[toolId] || { enabled: true, autoExecute: false }
  settings.tools.tools[toolId] = {
    enabled: update.enabled ?? current.enabled,
    autoExecute: update.autoExecute ?? current.autoExecute,
  }
}

export function setCliPermissionMode<
  TSettings extends CliSettingsLike<CliProviderConfigLike, string>,
>(
  settings: TSettings,
  mode: string,
): TSettings {
  settings.tools.permissionMode = mode
  return settings
}
