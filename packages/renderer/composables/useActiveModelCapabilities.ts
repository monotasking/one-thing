import { computed } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useSessionsStore } from '@/stores/sessions'
import { useAgentsStore } from '@/stores/agents'
import { resolveProviderModelSelection } from '@/stores/helpers/provider-model'
import { useSpaceProviderView } from '@/composables/useSpaceProviderView'
import { createCustomModel, hasVision } from '@/components/settings/provider/model-capabilities'
import type { OpenRouterModel } from '@/types'

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
   * 文档类原生附件没有独立的账本档位 —— 能看图的模型通常也收文件,这是
   * `useAttachments` 一直以来的代理判据,原样保留(不在这里发明新结论)。
   */
  const supportsFiles = computed(() => supportsVision.value)

  return {
    providerId,
    modelId,
    model,
    supportsVision,
    supportsFiles,
  }
}
