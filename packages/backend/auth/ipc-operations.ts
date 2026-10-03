import type {
  OnethingOAuthCallbackResponse,
  OnethingOAuthDevicePollResponse,
  OnethingOAuthStartResponse,
  OnethingOAuthStatusResponse,
} from './types.js'

type MaybePromise<T> = T | Promise<T>

export interface OnethingOAuthIpcLogger {
  error?: (...args: unknown[]) => void
}

export interface StartOnethingOAuthForIpcOptions {
  providerId: string
  start(providerId: string): MaybePromise<OnethingOAuthStartResponse>
  openExternal?(url: string): MaybePromise<unknown>
  logger?: OnethingOAuthIpcLogger
}

export async function startOnethingOAuthForIpc(
  options: StartOnethingOAuthForIpcOptions,
): Promise<OnethingOAuthStartResponse> {
  try {
    const response = await options.start(options.providerId)
    if (response.success) {
      const url = response.authUrl || response.verificationUri
      if (url && options.openExternal) {
        void Promise.resolve(options.openExternal(url))
          .catch(error => options.logger?.error?.('[OAuth] Open external URL failed:', error))
      }
    }
    return response
  } catch (error) {
    options.logger?.error?.('[OAuth] Start failed:', error)
    return {
      success: false,
      error: errorMessage(error, 'OAuth start failed'),
    }
  }
}

export interface CompleteOnethingOAuthCallbackForIpcOptions {
  providerId: string
  code: string
  state: string
  completeManualCode(providerId: string, code: string, state: string): MaybePromise<OnethingOAuthCallbackResponse>
  logger?: OnethingOAuthIpcLogger
}

export async function completeOnethingOAuthCallbackForIpc(
  options: CompleteOnethingOAuthCallbackForIpcOptions,
): Promise<OnethingOAuthCallbackResponse> {
  try {
    return await options.completeManualCode(options.providerId, options.code, options.state)
  } catch (error) {
    options.logger?.error?.('[OAuth] Callback failed:', error)
    return {
      success: false,
      error: errorMessage(error, 'OAuth callback failed'),
    }
  }
}

export interface PollOnethingOAuthDeviceFlowForIpcOptions {
  providerId: string
  flowId?: string
  deviceCode?: string
  pollDeviceFlow(providerId: string, flowId?: string): MaybePromise<OnethingOAuthDevicePollResponse>
  logger?: OnethingOAuthIpcLogger
}

export async function pollOnethingOAuthDeviceFlowForIpc(
  options: PollOnethingOAuthDeviceFlowForIpcOptions,
): Promise<OnethingOAuthDevicePollResponse> {
  try {
    return await options.pollDeviceFlow(options.providerId, options.flowId || options.deviceCode)
  } catch (error) {
    options.logger?.error?.('[OAuth] Device poll failed:', error)
    return {
      success: false,
      completed: false,
      error: errorMessage(error, 'Poll failed'),
    }
  }
}

export interface RefreshOnethingOAuthForIpcOptions {
  providerId: string
  refreshToken(providerId: string): MaybePromise<unknown>
  notifyTokenExpired(providerId: string, error: string): MaybePromise<unknown>
  logger?: OnethingOAuthIpcLogger
}

export type RefreshOnethingOAuthForIpcResponse =
  | { success: true }
  | { success: false; error: string }

export async function refreshOnethingOAuthForIpc(
  options: RefreshOnethingOAuthForIpcOptions,
): Promise<RefreshOnethingOAuthForIpcResponse> {
  try {
    await options.refreshToken(options.providerId)
    return { success: true }
  } catch (error) {
    const message = errorMessage(error, 'Refresh failed')
    options.logger?.error?.('[OAuth] Refresh failed:', error)
    await options.notifyTokenExpired(options.providerId, message)
    return { success: false, error: message }
  }
}

export interface GetOnethingOAuthStatusForIpcOptions {
  providerId: string
  getStatus(providerId: string): MaybePromise<OnethingOAuthStatusResponse>
  logger?: OnethingOAuthIpcLogger
}

export async function getOnethingOAuthStatusForIpc(
  options: GetOnethingOAuthStatusForIpcOptions,
): Promise<OnethingOAuthStatusResponse> {
  try {
    return await options.getStatus(options.providerId)
  } catch (error) {
    options.logger?.error?.('[OAuth] Status check failed:', error)
    return {
      success: false,
      providerId: options.providerId,
      isLoggedIn: false,
      isExpired: false,
      error: errorMessage(error, 'Status check failed'),
    }
  }
}

export interface LogoutOnethingOAuthForIpcOptions {
  providerId: string
  deleteToken(providerId: string): MaybePromise<unknown>
  logger?: OnethingOAuthIpcLogger
}

export type LogoutOnethingOAuthForIpcResponse =
  | { success: true }
  | { success: false; error: string }

export async function logoutOnethingOAuthForIpc(
  options: LogoutOnethingOAuthForIpcOptions,
): Promise<LogoutOnethingOAuthForIpcResponse> {
  try {
    await options.deleteToken(options.providerId)
    return { success: true }
  } catch (error) {
    options.logger?.error?.('[OAuth] Logout failed:', error)
    return {
      success: false,
      error: errorMessage(error, 'Logout failed'),
    }
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
