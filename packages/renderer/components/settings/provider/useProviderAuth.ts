import { ref, type ComputedRef, type Ref } from 'vue'
import { platformApi } from '@/platform'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.provider-auth')

export interface OAuthStatus {
  isLoggedIn: boolean
  isExpired?: boolean
  canRefresh?: boolean
  expiresAt?: number
  account?: {
    id?: string
    email?: string
    planType?: string
    isFedramp?: boolean
  }
  lastError?: string
}

export interface DeviceFlowInfo {
  flowId?: string
  userCode: string
  verificationUri: string
  pollIntervalMs?: number
}

export interface CodeEntryInfo {
  flowId?: string
  state: string
  instructions: string
}

export function useProviderAuth(
  providerId: Ref<string>,
  isOAuthProvider: ComputedRef<boolean>,
  onAuthTokenRefreshed?: (providerId: string) => void | Promise<void>,
) {
  const authRefreshDebounceMs = 5000
  const isOAuthLoading = ref(false)
  const oauthStatus = ref<OAuthStatus>({ isLoggedIn: false })
  const deviceFlowInfo = ref<DeviceFlowInfo | null>(null)
  const codeEntryInfo = ref<CodeEntryInfo | null>(null)
  const manualCode = ref('')
  const isSubmittingCode = ref(false)
  const codeEntryError = ref('')

  let oauthTokenRefreshedCleanup: (() => void) | null = null
  let oauthTokenExpiredCleanup: (() => void) | null = null
  let lastAuthRefreshHandledAt = 0

  function resetOAuthState() {
    isOAuthLoading.value = false
    oauthStatus.value = { isLoggedIn: false }
    deviceFlowInfo.value = null
    codeEntryInfo.value = null
    manualCode.value = ''
    isSubmittingCode.value = false
    codeEntryError.value = ''
  }

  async function checkOAuthStatus() {
    if (!isOAuthProvider.value) return

    try {
      const response = await platformApi.oauthGetStatus(providerId.value)
      if (response.success) {
        oauthStatus.value = {
          isLoggedIn: response.isLoggedIn,
          isExpired: response.isExpired,
          canRefresh: response.canRefresh,
          expiresAt: response.expiresAt,
          account: response.account,
          lastError: response.lastError,
        }
      }
    } catch (err) {
      log.error('oauth status check failed', { providerId: providerId.value }, err)
      oauthStatus.value = { isLoggedIn: false }
    }
  }

  async function handleAuthTokenRefreshed() {
    const now = Date.now()
    if (now - lastAuthRefreshHandledAt < authRefreshDebounceMs) return
    lastAuthRefreshHandledAt = now
    await onAuthTokenRefreshed?.(providerId.value)
  }

  async function startOAuthLogin() {
    isOAuthLoading.value = true
    deviceFlowInfo.value = null
    codeEntryInfo.value = null
    manualCode.value = ''
    codeEntryError.value = ''

    try {
      const response = await platformApi.oauthStart(providerId.value)

      if (!response.success) {
        oauthStatus.value = {
          isLoggedIn: false,
          lastError: response.error || 'OAuth start failed',
        }
        isOAuthLoading.value = false
        return
      }

      if (response.userCode && response.verificationUri) {
        deviceFlowInfo.value = {
          flowId: response.flowId,
          userCode: response.userCode,
          verificationUri: response.verificationUri,
          pollIntervalMs: response.pollIntervalMs,
        }
        await pollDeviceFlow(response.flowId, response.pollIntervalMs)
      } else if (response.requiresCodeEntry) {
        codeEntryInfo.value = {
          flowId: response.flowId,
          state: response.state || '',
          instructions: response.instructions || 'After authorizing, copy the code from the page and paste it here.',
        }
        isOAuthLoading.value = false
      } else {
        await pollBrowserCallback(response.pollIntervalMs)
      }
    } catch (err: any) {
      log.error('oauth login failed', { providerId: providerId.value }, err)
      oauthStatus.value = {
        isLoggedIn: false,
        lastError: err?.message || 'OAuth login failed',
      }
      isOAuthLoading.value = false
    }
  }

  async function submitManualCode() {
    if (!manualCode.value.trim() || !codeEntryInfo.value) return

    isSubmittingCode.value = true
    codeEntryError.value = ''

    try {
      const response = await platformApi.oauthCallback(
        providerId.value,
        manualCode.value.trim(),
        codeEntryInfo.value.state,
      )

      if (response.success) {
        codeEntryInfo.value = null
        manualCode.value = ''
        await checkOAuthStatus()
        await handleAuthTokenRefreshed()
      } else {
        codeEntryError.value = response.error || 'Failed to verify code'
      }
    } catch (err: any) {
      codeEntryError.value = err.message || 'Failed to verify code'
    } finally {
      isSubmittingCode.value = false
    }
  }

  async function pollDeviceFlow(flowId?: string, pollIntervalMs = 5000) {
    const maxAttempts = 60

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await platformApi.oauthDevicePoll(providerId.value, flowId)

        if (response.success && response.completed) {
          await checkOAuthStatus()
          await handleAuthTokenRefreshed()
          deviceFlowInfo.value = null
          isOAuthLoading.value = false
          return
        }

        if (response.pollStatus === 'authorization_pending' || response.error === 'authorization_pending') {
          await wait(pollIntervalMs)
          continue
        }

        if (response.pollStatus === 'slow_down' || response.error === 'slow_down') {
          pollIntervalMs += 5000
          await wait(pollIntervalMs)
          continue
        }

        if (!response.success || response.error === 'expired_token' || response.error === 'access_denied') {
          oauthStatus.value = {
            isLoggedIn: false,
            lastError: response.error || 'Authorization was not completed',
          }
          deviceFlowInfo.value = null
          isOAuthLoading.value = false
          return
        }
      } catch (err) {
        log.error('device flow poll failed', { providerId: providerId.value }, err)
      }

      await wait(pollIntervalMs)
    }

    deviceFlowInfo.value = null
    isOAuthLoading.value = false
  }

  async function pollBrowserCallback(pollIntervalMs = 2000) {
    const startTime = Date.now()
    const timeout = 5 * 60 * 1000

    while (Date.now() - startTime <= timeout) {
      await wait(pollIntervalMs)
      await checkOAuthStatus()
      if (oauthStatus.value.isLoggedIn) {
        await handleAuthTokenRefreshed()
        isOAuthLoading.value = false
        return
      }
    }

    oauthStatus.value = {
      isLoggedIn: false,
      lastError: 'Authorization timed out',
    }
    isOAuthLoading.value = false
  }

  async function logoutOAuth() {
    try {
      await platformApi.oauthLogout(providerId.value)
      resetOAuthState()
    } catch (err) {
      log.error('oauth logout failed', { providerId: providerId.value }, err)
    }
  }

  function initializeOAuthListeners() {
    oauthTokenRefreshedCleanup = platformApi.onOAuthTokenRefreshed(async (data) => {
      if (data.providerId === providerId.value) {
        await checkOAuthStatus()
        await handleAuthTokenRefreshed()
      }
    })

    oauthTokenExpiredCleanup = platformApi.onOAuthTokenExpired((data) => {
      if (data.providerId === providerId.value) {
        oauthStatus.value = {
          isLoggedIn: false,
          isExpired: true,
          lastError: data.error || 'OAuth token expired',
        }
      }
    })
  }

  function cleanupOAuthListeners() {
    oauthTokenRefreshedCleanup?.()
    oauthTokenExpiredCleanup?.()
    oauthTokenRefreshedCleanup = null
    oauthTokenExpiredCleanup = null
  }

  return {
    isOAuthLoading,
    oauthStatus,
    deviceFlowInfo,
    codeEntryInfo,
    manualCode,
    isSubmittingCode,
    codeEntryError,
    resetOAuthState,
    checkOAuthStatus,
    startOAuthLogin,
    submitManualCode,
    logoutOAuth,
    initializeOAuthListeners,
    cleanupOAuthListeners,
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
