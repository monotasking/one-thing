export type AgentLoopStreamEnabledBy = 'env' | 'settings' | 'default'

export interface AgentLoopStreamSettingsLike {
  chat?: {
    agentLoopStream?: boolean
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface AgentLoopStreamSelectionContext {
  providerId: string
  settings?: AgentLoopStreamSettingsLike
  env?: Record<string, string | undefined>
  envFlagName?: string
  supportedProviderIds?: readonly string[]
  isProviderSupported?: (providerId: string) => boolean
}

export interface AgentLoopStreamRoute {
  enabled: boolean
  enabledBy: AgentLoopStreamEnabledBy
  providerSupported: boolean
  active: boolean
  supportedProviderIds: string[]
}

function getDefaultEnv(): Record<string, string | undefined> {
  if (typeof process === 'undefined') return {}
  return process.env
}

function isEnabled(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

function isProviderSupported(ctx: AgentLoopStreamSelectionContext): boolean {
  if (ctx.isProviderSupported) {
    return ctx.isProviderSupported(ctx.providerId)
  }
  return ctx.supportedProviderIds?.includes(ctx.providerId) ?? false
}

export function resolveAgentLoopStreamRoute(ctx: AgentLoopStreamSelectionContext): AgentLoopStreamRoute {
  const env = ctx.env ?? getDefaultEnv()
  const envEnabled = typeof ctx.envFlagName === 'string' && isEnabled(env[ctx.envFlagName])
  const configured = ctx.settings?.chat?.agentLoopStream
  const settingsEnabled = configured === true
  const enabledBy: AgentLoopStreamEnabledBy = envEnabled
    ? 'env'
    : settingsEnabled
      ? 'settings'
      : 'default'
  const providerSupported = isProviderSupported(ctx)

  return {
    enabled: true,
    enabledBy,
    providerSupported,
    active: providerSupported,
    supportedProviderIds: [...(ctx.supportedProviderIds ?? [])],
  }
}

export function shouldUseAgentLoopStream(ctx: AgentLoopStreamSelectionContext): boolean {
  return resolveAgentLoopStreamRoute(ctx).active
}
