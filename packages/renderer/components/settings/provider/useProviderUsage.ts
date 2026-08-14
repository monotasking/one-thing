import { computed, ref, watch, type Ref } from 'vue'
import type { ProviderUsageResponse } from '@/types'
import type { OAuthStatus } from './useProviderAuth'
import { providersApi } from '@/platform/providers-client'

const CACHE_TTL_MS = 60_000

interface CachedProviderUsage {
  expiresAt: number
  response: ProviderUsageResponse
}

export function useProviderUsage(
  providerId: Ref<string>,
  oauthStatus: Ref<OAuthStatus>,
) {
  const cache = new Map<string, CachedProviderUsage>()
  const response = ref<ProviderUsageResponse | null>(null)
  const isLoading = ref(false)
  const error = ref('')
  let requestSeq = 0

  const shouldShow = computed(() => providerId.value === 'codex' && oauthStatus.value.isLoggedIn)

  function reset() {
    requestSeq += 1
    response.value = null
    error.value = ''
    isLoading.value = false
  }

  async function refresh(force = false) {
    const id = providerId.value
    if (id !== 'codex' || !oauthStatus.value.isLoggedIn) {
      reset()
      return
    }

    const cached = cache.get(id)
    if (!force && cached && cached.expiresAt > Date.now()) {
      response.value = cached.response
      error.value = ''
      return
    }

    const seq = ++requestSeq
    isLoading.value = true
    error.value = ''

    try {
      const next = await providersApi.getProviderUsage(id)
      if (seq !== requestSeq) return
      if (!next.success) {
        throw new Error(next.error || 'Failed to fetch provider usage')
      }
      if (next.unsupported) {
        response.value = null
        return
      }
      response.value = next
      cache.set(id, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        response: next,
      })
    } catch (err: any) {
      if (seq !== requestSeq) return
      response.value = null
      error.value = err?.message || 'Failed to fetch provider usage'
    } finally {
      if (seq === requestSeq) {
        isLoading.value = false
      }
    }
  }

  watch(
    () => [
      providerId.value,
      oauthStatus.value.isLoggedIn,
      oauthStatus.value.expiresAt,
      oauthStatus.value.account?.id,
    ] as const,
    () => {
      if (!shouldShow.value) {
        reset()
        return
      }
      void refresh(false)
    },
    { immediate: true },
  )

  return {
    shouldShow,
    response,
    isLoading,
    error,
    refresh,
    reset,
  }
}
