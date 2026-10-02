export interface OnethingOAuthProviderToken {
  accessToken: string
}

export interface OnethingOAuthProviderBaseConfig {
  baseUrl?: string
}

export interface OnethingResolvedOAuthProviderConfig {
  apiKey: string
  baseUrl?: string
}

export interface ResolveOnethingOAuthProviderConfigOptions<
  TBaseConfig extends OnethingOAuthProviderBaseConfig = OnethingOAuthProviderBaseConfig,
> {
  providerId: string
  baseConfig: TBaseConfig
  requiresOAuth(providerId: string): boolean
  refreshTokenIfNeeded(providerId: string): Promise<OnethingOAuthProviderToken | null | undefined>
  logger?: {
    error?(...args: unknown[]): void
  }
}

export async function resolveOnethingOAuthProviderConfig<
  TBaseConfig extends OnethingOAuthProviderBaseConfig = OnethingOAuthProviderBaseConfig,
>(
  options: ResolveOnethingOAuthProviderConfigOptions<TBaseConfig>,
): Promise<OnethingResolvedOAuthProviderConfig | null> {
  if (!options.requiresOAuth(options.providerId)) {
    return null
  }

  try {
    const token = await options.refreshTokenIfNeeded(options.providerId)
    if (!token) return null

    return {
      apiKey: token.accessToken,
      baseUrl: options.baseConfig.baseUrl,
    }
  } catch (error) {
    options.logger?.error?.(`Failed to get OAuth config for ${options.providerId}:`, error)
    return null
  }
}
