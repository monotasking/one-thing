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
  /**
   * 当前空间(C1 接批 B10 移交)。用量按**这个空间的 codex 账号**查 ——
   * 凭证迁进空间池之后,后端没有「settings 里那一把 token」可用了。
   */
  space?: { id: Ref<string>; loggedIn: Ref<boolean> },
) {
  const cache = new Map<string, CachedProviderUsage>()
  const response = ref<ProviderUsageResponse | null>(null)
  const isLoading = ref(false)
  const error = ref('')
  let requestSeq = 0

  /**
   * 「登没登」的判据有两个来源:AuthCard 那条(settings 目标)与**本空间池里
   * 有没有一条带 token 的 codex entry**。C1 之后真相在后者,前者留着是为了让
   * 还没接空间视图的调用方不变哑。
   */
  const isLoggedIn = computed(
    () => oauthStatus.value.isLoggedIn || space?.loggedIn.value === true,
  )
  const shouldShow = computed(() => providerId.value === 'codex' && isLoggedIn.value)

  function reset() {
    requestSeq += 1
    response.value = null
    error.value = ''
    isLoading.value = false
  }

  async function refresh(force = false) {
    const id = providerId.value
    if (id !== 'codex' || !isLoggedIn.value) {
      reset()
      return
    }

    // 缓存按 (provider, space) 分格 —— 两个空间是两个 codex 账号,共用一格
    // 会把 A 空间的额度画在 B 空间的卡上。
    const cacheKey = `${id}@${space?.id.value ?? ''}`
    const cached = cache.get(cacheKey)
    if (!force && cached && cached.expiresAt > Date.now()) {
      response.value = cached.response
      error.value = ''
      return
    }

    const seq = ++requestSeq
    isLoading.value = true
    error.value = ''

    try {
      const next = await providersApi.getProviderUsage(id, space?.id.value)
      if (seq !== requestSeq) return
      if (!next.success) {
        throw new Error(next.error || 'Failed to fetch provider usage')
      }
      if (next.unsupported) {
        response.value = null
        return
      }
      response.value = next
      cache.set(cacheKey, {
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
