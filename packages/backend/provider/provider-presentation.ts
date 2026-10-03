type MaybePromise<T> = T | Promise<T>

export interface OnethingProviderPresentationIpcLogger {
  error?: (...args: unknown[]) => void
}

export interface ListOnethingProvidersOptions<TProvider = unknown> {
  getAvailableProviders(): MaybePromise<TProvider[]>
}

export interface ListOnethingProvidersResult<TProvider = unknown> {
  success: true
  providers: TProvider[]
}

export async function listOnethingProviders<TProvider = unknown>(
  options: ListOnethingProvidersOptions<TProvider>,
): Promise<ListOnethingProvidersResult<TProvider>> {
  return {
    success: true,
    providers: await options.getAvailableProviders(),
  }
}

export async function listOnethingProvidersForIpc<TProvider = unknown>(
  options: ListOnethingProvidersOptions<TProvider> & { logger?: OnethingProviderPresentationIpcLogger },
): Promise<ListOnethingProvidersResult<TProvider> | { success: false; error: string }> {
  try {
    return await listOnethingProviders(options)
  } catch (error) {
    return providerPresentationIpcError(options.logger, 'get providers', error, 'Failed to get providers')
  }
}

export interface InspectOnethingProviderEnvStatusOptions<TStatus = unknown> {
  providerId: string
  getProviderEnvStatus(providerId: string): MaybePromise<TStatus>
}

export interface InspectOnethingProviderEnvStatusResult<TStatus = unknown> {
  success: true
  status: TStatus
}

export async function inspectOnethingProviderEnvStatus<TStatus = unknown>(
  options: InspectOnethingProviderEnvStatusOptions<TStatus>,
): Promise<InspectOnethingProviderEnvStatusResult<TStatus>> {
  return {
    success: true,
    status: await options.getProviderEnvStatus(options.providerId),
  }
}

export async function inspectOnethingProviderEnvStatusForIpc<TStatus = unknown>(
  options: InspectOnethingProviderEnvStatusOptions<TStatus> & { logger?: OnethingProviderPresentationIpcLogger },
): Promise<InspectOnethingProviderEnvStatusResult<TStatus> | { success: false; error: string }> {
  try {
    return await inspectOnethingProviderEnvStatus(options)
  } catch (error) {
    return providerPresentationIpcError(
      options.logger,
      'inspect provider environment variables',
      error,
      'Failed to inspect provider environment variables',
    )
  }
}

function providerPresentationIpcError(
  logger: OnethingProviderPresentationIpcLogger | undefined,
  label: string,
  error: unknown,
  fallback: string,
): { success: false; error: string } {
  logger?.error?.(`[Providers] Failed to ${label}:`, error)
  return {
    success: false,
    error: error instanceof Error && error.message ? error.message : fallback,
  }
}
