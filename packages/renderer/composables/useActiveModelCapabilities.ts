import { computed, ref, watch } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useSessionsStore } from '@/stores/sessions'
import { useAgentsStore } from '@/stores/agents'
import { resolveProviderModelSelection } from '@/stores/helpers/provider-model'
import { useSpaceProviderView } from '@/composables/useSpaceProviderView'
import { createCustomModel, hasVision } from '@/components/settings/provider/model-capabilities'
import { modelsApi } from '@/platform/models-client'
import type { RendererModelCapabilities } from '@shared/ipc/providers'
import type { OpenRouterModel } from '@/types'

/**
 * P4-7 的那条通道的答案缓存,**模块级**:一个会话里 InputBox / useAttachments /
 * scratchpad 各挂一份这个 composable,同一条 (provider, model) 不该问三遍。
 * 判定是纯本地的(账本 ∧ 传输声明),换模型才会变,所以缓存没有过期一说 ——
 * 唯一会变的输入是设置里的 per-model override,那一支改完会重挂。
 */
const probeCache = new Map<string, RendererModelCapabilities | null>()
const probeInFlight = new Map<string, Promise<void>>()

function probeKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

/**
 * 问一次后端「这条线上的这个模型接不接文件」。
 *
 * 失败(未登录的 provider 构造不出来、通道不通、跑在没有 rpc 的测试壳里)一律
 * 记成 `null` = 没答案,调用方退回今天的 vision 别名 —— 宁可保持旧行为,
 * 也不要凭一次失败就告诉用户"不能传文件"。
 */
function probeModelCapabilities(providerId: string, modelId: string): void {
  const key = probeKey(providerId, modelId)
  if (probeCache.has(key) || probeInFlight.has(key)) return
  const task = (async () => {
    try {
      const response = await modelsApi.getModelCapabilities(providerId, modelId)
      probeCache.set(key, response?.success && response.capabilities ? response.capabilities : null)
    } catch {
      probeCache.set(key, null)
    } finally {
      probeInFlight.delete(key)
    }
  })()
  probeInFlight.set(key, task)
}

/**
 * 这一发请求**真的**会用哪个 provider / model,以及它认不认图。
 *
 * 为什么要单开一个:composer 里原本各写各的判定 —— `useAttachments` 读的是
 * 全局 `settings.ai.provider` 的那一档,而实际发送走的是
 * `resolveSendProviderOverride`(会话置顶 → agent 绑定 → 会话上次 → 全局)。
 * 两条链在"会话钉了别的模型"时就会分叉:模型选择器写着 A、附件按 B 的能力
 * 降级。这里把判定收到与发送同源的那一条链上。
 *
 * 能力判定走共享账本(`resolveOnethingModelCapabilities`,即 `hasVision`),
 * 不在这里自写第二份模式表。
 */
export function useActiveModelCapabilities(sessionId: () => string | undefined) {
  const settingsStore = useSettingsStore()
  const sessionsStore = useSessionsStore()
  const agentsStore = useAgentsStore()
  // 批 B9:空间默认也在这条链上 —— 判定与发送必须同源,少一格就又分叉一次。
  const spaceView = useSpaceProviderView({
    settings: () => settingsStore.settings,
    autoLoad: false,
  })

  const selection = computed(() => {
    const session = sessionsStore.getSessionItem(sessionId() || '') || null
    // 功能兜底,不是署名:引擎侧同一条 `findAgent ?? defaultAgent` 规则决定
    // 这一发请求用谁的绑定 —— agents 还没装载好时退回 null(与 chat store 的
    // 异步版同解,只是不为了一个能力判定去 await 一次装载)。
    const agentModel = typeof agentsStore.getAgent === 'function'
      ? (agentsStore.getAgent(session?.agentId)?.model ?? null)
      : null
    return resolveProviderModelSelection({
      settings: settingsStore.settings,
      session,
      agentModel,
      spaceDefault: spaceView.spaceDefault.value,
    })
  })

  const providerId = computed(() => selection.value.providerId || '')
  const modelId = computed(() => selection.value.model || '')

  /** 目录里查得到就用目录里的元数据;查不到用一个只有 id 的壳,让账本按规则判。 */
  const model = computed<OpenRouterModel>(() => {
    const cached = settingsStore.getCachedModels?.(providerId.value) ?? []
    return cached.find(entry => entry.id === modelId.value) ?? createCustomModel(modelId.value)
  })

  const supportsVision = computed(() => {
    if (!modelId.value) return false
    return hasVision(model.value, providerId.value)
  })

  /**
   * 「这条线接不接文件」(P4-7)。
   *
   * 从前这里写的是 `supportsFiles = supportsVision` —— 一个代理判据,而它是错
   * 的:`deepseek-*-vision-exp` 读图不吃 PDF,而 chat-completions 那几家压根
   * 没有可移植的文件块。真话是**账本 fileInput ∧ 这条线的传输声明**,后半句
   * 只有后端知道,所以去问一次(`models.getModelCapabilities`)。
   *
   * 没答案时(还在飞、构造不出 provider、跑在没有 rpc 的壳里)退回旧的 vision
   * 别名:保持今天的行为,不因为一次问不到就把用户的文件口关掉。
   */
  const probeTick = ref(0)
  const probed = computed<RendererModelCapabilities | null>(() => {
    // 读一下 tick,让 probe 落地后这个 computed 会重算(Map 不是响应式的)。
    void probeTick.value
    if (!providerId.value || !modelId.value) return null
    return probeCache.get(probeKey(providerId.value, modelId.value)) ?? null
  })

  watch(
    [providerId, modelId],
    ([nextProviderId, nextModelId]) => {
      if (!nextProviderId || !nextModelId) return
      const key = probeKey(nextProviderId, nextModelId)
      if (probeCache.has(key)) {
        probeTick.value += 1
        return
      }
      probeModelCapabilities(nextProviderId, nextModelId)
      probeInFlight.get(key)?.then(() => { probeTick.value += 1 })
    },
    { immediate: true },
  )

  const supportsFiles = computed(() => probed.value?.supportsFiles ?? supportsVision.value)

  return {
    providerId,
    modelId,
    model,
    supportsVision,
    supportsFiles,
  }
}
