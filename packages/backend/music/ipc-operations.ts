/**
 * Host-free IPC operations for the music radio domain.
 * Mirrors the voice domain's convention: try/catch wrappers returning a
 * `{ success }` discriminated union, with the service injected by the host.
 */

import type { OnethingMusicPlayerBackend, OnethingMusicRuntimeState } from './types.js'
import type { MusicSetupService } from './setup-service.js'

export type OnethingMusicIpcResult<TPayload extends object = {}> =
  | ({ success: true } & TPayload)
  | { success: false; error: string }

export type OnethingMusicSetupRequest =
  | { action: 'check-env' }
  | { action: 'install-tool'; tool: 'ncm-cli' | 'mpv' }
  | { action: 'set-credentials'; appId: string; privateKey: string }
  | { action: 'set-player'; player: OnethingMusicPlayerBackend }
  | { action: 'login-start' }
  | { action: 'login-cancel' }
  | { action: 'login-check' }
  | { action: 'logout' }

function musicIpcError(error: unknown, fallback: string): { success: false; error: string } {
  return {
    success: false,
    error: error instanceof Error && error.message ? error.message : fallback,
  }
}

export function getOnethingMusicStateForIpc(
  options: { getState(): OnethingMusicRuntimeState },
): OnethingMusicIpcResult<{ state: OnethingMusicRuntimeState }> {
  try {
    return { success: true, state: options.getState() }
  } catch (error) {
    return musicIpcError(error, '获取电台状态失败')
  }
}

export async function runOnethingMusicSetupForIpc(
  options: { request: OnethingMusicSetupRequest; service: MusicSetupService },
): Promise<OnethingMusicIpcResult<{ state: OnethingMusicRuntimeState }>> {
  const { request, service } = options
  try {
    switch (request.action) {
      case 'check-env':
        await service.refreshEnv()
        break
      case 'install-tool':
        await service.installTool(request.tool)
        break
      case 'set-credentials': {
        const appId = request.appId?.trim()
        const privateKey = request.privateKey?.trim()
        if (!appId || !privateKey) throw new Error('appId 与 privateKey 不能为空')
        await service.setCredentials(appId, privateKey)
        break
      }
      case 'set-player':
        await service.setPlayerBackend(request.player)
        break
      case 'login-start':
        await service.startLogin()
        break
      case 'login-cancel':
        service.cancelLogin()
        break
      case 'login-check':
        await service.checkLogin()
        break
      case 'logout':
        await service.logout()
        break
      default:
        throw new Error('未知的配置操作')
    }
    return { success: true, state: service.getState() }
  } catch (error) {
    return musicIpcError(error, '配置操作失败')
  }
}
