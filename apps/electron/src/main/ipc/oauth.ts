/**
 * OAuth IPC Handlers
 *
 * Thin IPC boundary over the main auth subsystem. Provider-specific OAuth
 * behavior lives in src/main/auth/.
 */

import { openElectronExternal } from '@onething/electron-host/shell/operations'
import {
  broadcastElectronOAuthTokenExpired,
  broadcastElectronOAuthTokenRefreshed,
} from '@onething/electron-host/oauth/events'
import {
  registerElectronOAuthIpcHandlers,
  type ElectronOAuthCallbackRequest,
  type ElectronOAuthDevicePollRequest,
  type ElectronOAuthProviderRequest,
} from '@onething/electron-host/ipc/oauth'
import { normalizeCredentialTarget } from '@onething/runtime/auth'
import {
  completeOnethingOAuthCallbackForIpc,
  getOnethingOAuthStatusForIpc,
  logoutOnethingOAuthForIpc,
  pollOnethingOAuthDeviceFlowForIpc,
  refreshOnethingOAuthForIpc,
  startOnethingOAuthForIpc,
} from '@onething/runtime/auth'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type {
  OAuthCallbackRequest,
  OAuthCallbackResponse,
  OAuthDevicePollRequest,
  OAuthDevicePollResponse,
  OAuthLogoutRequest,
  OAuthLogoutResponse,
  OAuthStartRequest,
  OAuthStartResponse,
  OAuthStatusRequest,
  OAuthStatusResponse,
} from '@shared/ipc.js'
import { authService } from '@onething/app/auth/auth-service.js'

/**
 * 请求里的目标字段 → 归一后的写回目标(批 B6)。缺席/非法/默认空间一律 settings,
 * 即这个参数出现之前的行为。
 */
function targetOf(request: ElectronOAuthProviderRequest) {
  return normalizeCredentialTarget({
    spaceId: request.spaceId,
    entryId: request.entryId,
    label: request.label,
  })
}

function notifyTokenRefreshed(providerId: string): void {
  broadcastElectronOAuthTokenRefreshed({
    channel: IPC_CHANNELS.OAUTH_TOKEN_REFRESHED,
    providerId,
  })
}

function notifyTokenExpired(providerId: string, error?: string): void {
  broadcastElectronOAuthTokenExpired({
    channel: IPC_CHANNELS.OAUTH_TOKEN_EXPIRED,
    providerId,
    error,
  })
}

let listenersRegistered = false

function registerAuthServiceListeners(): void {
  if (listenersRegistered) return
  listenersRegistered = true

  authService.on('token-refreshed', (data: { providerId: string }) => {
    notifyTokenRefreshed(data.providerId)
  })
  authService.on('token-expired', (data: { providerId: string; error?: string }) => {
    notifyTokenExpired(data.providerId, data.error)
  })
}

export function registerOAuthHandlers(): void {
  registerAuthServiceListeners()

  registerElectronOAuthIpcHandlers({
    channels: {
      start: IPC_CHANNELS.OAUTH_START,
      callback: IPC_CHANNELS.OAUTH_CALLBACK,
      devicePoll: IPC_CHANNELS.OAUTH_DEVICE_POLL,
      refresh: IPC_CHANNELS.OAUTH_REFRESH,
      status: IPC_CHANNELS.OAUTH_STATUS,
      logout: IPC_CHANNELS.OAUTH_LOGOUT,
    },
    start: async (request: ElectronOAuthProviderRequest): Promise<OAuthStartResponse> => {
      const typedRequest = request as OAuthStartRequest
      return startOnethingOAuthForIpc({
        providerId: typedRequest.providerId,
        start: providerId => authService.start(providerId, targetOf(typedRequest)),
        openExternal: url => openElectronExternal(url).then(() => undefined),
        logger: console,
      })
    },
    callback: async (request: ElectronOAuthCallbackRequest): Promise<OAuthCallbackResponse> => {
      const typedRequest = request as OAuthCallbackRequest
      return completeOnethingOAuthCallbackForIpc({
        providerId: typedRequest.providerId,
        code: typedRequest.code,
        state: typedRequest.state,
        completeManualCode: (providerId, code, state) =>
          authService.completeManualCode(providerId, code, state, targetOf(typedRequest)),
        logger: console,
      })
    },
    devicePoll: async (request: ElectronOAuthDevicePollRequest): Promise<OAuthDevicePollResponse> => {
      const typedRequest = request as OAuthDevicePollRequest
      return pollOnethingOAuthDeviceFlowForIpc({
        providerId: typedRequest.providerId,
        flowId: typedRequest.flowId,
        deviceCode: typedRequest.deviceCode,
        pollDeviceFlow: (providerId, flowId) =>
          authService.pollDeviceFlow(providerId, flowId, targetOf(typedRequest)),
        logger: console,
      })
    },
    refresh: async (request: ElectronOAuthProviderRequest): Promise<{ success: boolean; error?: string }> => {
      return refreshOnethingOAuthForIpc({
        providerId: request.providerId,
        refreshToken: providerId => authService.refreshToken(providerId, targetOf(request)),
        notifyTokenExpired,
        logger: console,
      })
    },
    status: async (request: ElectronOAuthProviderRequest): Promise<OAuthStatusResponse> => {
      const typedRequest = request as OAuthStatusRequest
      return getOnethingOAuthStatusForIpc({
        providerId: typedRequest.providerId,
        getStatus: providerId => authService.getStatus(providerId, targetOf(typedRequest)),
        logger: console,
      })
    },
    logout: async (request: ElectronOAuthProviderRequest): Promise<OAuthLogoutResponse> => {
      const typedRequest = request as OAuthLogoutRequest
      return logoutOnethingOAuthForIpc({
        providerId: typedRequest.providerId,
        deleteToken: providerId => authService.deleteToken(providerId, targetOf(typedRequest)),
        logger: console,
      })
    },
  })
}

export function cleanupOAuth(): void {
  authService.cleanup()
}
