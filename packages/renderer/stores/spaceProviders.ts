/**
 * 「当前空间的 provider 面」—— 批 B7 的统一读写层(C2 换源)。
 *
 * ## 为什么有这个 store
 *
 * B3 把凭证解析做成了 per-space(后端已经正确),但**渲染层的编辑面与展示面
 * 还盯着全局 `settings.ai`**:切到空间 B 打开设置,看见的是默认空间的 key;
 * 模型选择器列的也是全局选中的模型。用户 08-15 的原话是
 * 「多空间的认证不是一个多余的新表单让你填,而是我切换 workspace 的时候,
 * 它就自动切换过去了」—— 所以 B3 那块**独立面板**(`SpaceCredentialsPanel`)
 * 被推翻,能力折进本 store,由既有的 provider 设置 UI 直接消费。
 *
 * ## 一条数据路
 *
 * | 落盘 | 装什么 |
 * | --- | --- |
 * | `workspaces/<id>/credentials.json` | 凭证池(密钥/token,严格隔离不回落) |
 * | `workspaces/<id>/providers.json` | **整套** provider 设置(C2) |
 *
 * C2 之前是 B7/B9 的散装 overlay 三格(`selectedModels` / `defaultSelection` /
 * `providerEnabled`)+ 其余回落全局;用户 08-18 原话:「不同的空间,provider
 * 设置应该是完整的、独立的两套。对齐。」于是整份搬进 `providers.json`,
 * **无回落** —— 这个空间没表达过的,就是没有。
 *
 * ## 与 settings store 的分工
 *
 * 本 store 持有**盘上那一份**(已保存态),settings store 的 `settings.ai` 是
 * 「本 store 这份 + 全局目录缓存」合成出来的生效形状。设置页编辑的是 settings
 * store 那份的草稿;而模型选择器/ThinkToggle 这些**立即落盘**的写操作走本 store
 * (它们本来就不是草稿语义)。两边读同一份文件、同一条 `spaces:changed` 事件
 * 刷新 —— 没有第二份真相,只有两个读者。
 */

import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type {
  ProviderConfig,
  SpaceCredentialsSummary,
  SpaceProviderCredentialSummary,
  SpaceProviderSettings,
  SpacesChangedEvent,
} from '@shared/ipc'
import { createEmptySpaceProviderSettings } from '@shared/defaults/ai-settings'
import { platformApi } from '@/platform'
import { DEFAULT_SPACE_ID, useSpacesStore } from './spaces'

const EMPTY_CREDENTIALS: SpaceCredentialsSummary = { providers: {} }

/** 「默认用哪个 provider 的哪个模型」——C2 起它就是 providers.json 的两格投影。 */
export interface SpaceDefaultSelection {
  provider: string
  model?: string
}

export const useSpaceProvidersStore = defineStore('spaceProviders', () => {
  const spacesStore = useSpacesStore()

  const credentials = ref<SpaceCredentialsSummary>(EMPTY_CREDENTIALS)
  /**
   * 这个空间盘上那份 provider 设置(C2)。
   *
   * `null` = **后端答不上话**(web 降级、这条路由不存在),读取方据此落回
   * `settings.ai`;`{provider:'',providers:{}}` = 后端答了,这个空间就是空的。
   * 两者必须分得开 —— 合并等于让「浏览器里打开」和「新建的空白空间」长成同一副样子。
   */
  const providerSettings = ref<SpaceProviderSettings | null>(null)
  const loading = ref(false)
  /** 已经为**当前这个** spaceId 拉过一次。切空间会重置。 */
  const loadedSpaceId = ref<string | null>(null)
  const lastError = ref<string | null>(null)

  const spaceId = computed(() => spacesStore.currentSpaceId || DEFAULT_SPACE_ID)
  const isDefaultSpace = computed(() => spaceId.value === DEFAULT_SPACE_ID)
  /** 后端答上话了才谈得上空间维度;web 端降级时恒为 false,整条支路等于不存在。 */
  const spaceAvailable = computed(() => spacesStore.available)

  function reset(): void {
    credentials.value = EMPTY_CREDENTIALS
    providerSettings.value = null
    loadedSpaceId.value = null
    lastError.value = null
  }

  /**
   * 拉当前空间的凭证摘要 + provider 设置。
   *
   * C1 之前这里给 default 空间开了一条短路(「它的东西都在 settings 里,发过去
   * 后端只会回一句 `DEFAULT_SPACE`」)。迁移之后 default 也有自己的池和
   * providers.json,短路一撤,整个视图层的 `isDefaultSpace ? A : B` 就没有数据源了。
   */
  async function refresh(): Promise<void> {
    const id = spaceId.value
    loading.value = true
    try {
      const [pools, ai] = await Promise.all([
        spacesStore.getCredentials(id),
        spacesStore.getProviderSettings(id),
      ])
      // 拉的过程中用户又切了空间:这份结果已经不是「当前空间的」,丢掉。
      if (spaceId.value !== id) return
      credentials.value = pools
      providerSettings.value = ai
      loadedSpaceId.value = id
      lastError.value = null
    } catch (error) {
      if (spaceId.value !== id) return
      credentials.value = EMPTY_CREDENTIALS
      providerSettings.value = null
      loadedSpaceId.value = id
      lastError.value = error instanceof Error ? error.message : 'Failed to load space providers'
    } finally {
      loading.value = false
    }
  }

  /** 幂等入口:组件挂载时叫它,不必各自判断有没有拉过。 */
  async function ensureLoaded(): Promise<void> {
    if (loadedSpaceId.value === spaceId.value) return
    await refresh()
  }

  function poolOf(providerId: string): SpaceProviderCredentialSummary | undefined {
    return credentials.value.providers[providerId]
  }

  /**
   * 批 E:当前注册着的插件凭证策略(注册表实时快照)。
   *
   * 与 `poolOf().policy` 是两回事:后者是**用户存下的选择**(插件不在了也留着),
   * 这里是**此刻装着什么**。两者的差就是面板要画的灰态。
   */
  const strategies = computed(() => credentials.value.strategies ?? [])

  /**
   * 收下一次写操作回传的整份摘要。凭证的每条写通道(set / set-pool / clear)
   * 都会把**写完之后的**摘要带回来 —— 收下它比再拉一次便宜,也没有中间态。
   */
  function applyCredentials(next: SpaceCredentialsSummary): void {
    credentials.value = next
    loadedSpaceId.value = spaceId.value
  }

  /**
   * 这个空间盘上那份设置的**只读快照**(缺席时给一份空的,读取方不必各自判 null)。
   */
  function currentSettings(): SpaceProviderSettings {
    return providerSettings.value ?? createEmptySpaceProviderSettings()
  }

  /** 这个 provider 在这个空间的配置(没配过 = `undefined`)。 */
  function configOf(providerId: string): ProviderConfig | undefined {
    return providerSettings.value?.providers?.[providerId]
  }

  /**
   * 整层写回 `providers.json`。**乐观更新 + 失败回滚** —— 勾选一个模型要等一次
   * 磁盘往返才打勾,手感是坏的;而写失败必须回滚,不能留下一个界面上勾着、
   * 盘上没有的模型。
   */
  async function writeProviderSettings(
    next: SpaceProviderSettings,
    failureMessage: string,
  ): Promise<boolean> {
    const previous = providerSettings.value
    providerSettings.value = next
    const result = await spacesStore.setProviderSettings(spaceId.value, next)
    if (!result) {
      providerSettings.value = previous
      lastError.value = spacesStore.lastError || failureMessage
      return false
    }
    providerSettings.value = result
    lastError.value = null
    return true
  }

  /**
   * 逐 provider 打补丁。**先读后并**:整层写的通道上「漏传 = 清空」,而这几个
   * 入口只关心一格 —— 合并放在这里,调用方就不必各自记得。
   */
  function patchProviders(
    patch: Record<string, Partial<ProviderConfig>>,
    base?: SpaceProviderSettings,
  ): SpaceProviderSettings {
    const current = base ?? currentSettings()
    // 逐键复制成 plain 值:current 是 reactive 树,浅展开会把 Proxy 一路带到 IPC
    // (见 spaces.setProviderSettings 的头注)。
    const next = JSON.parse(JSON.stringify(current)) as SpaceProviderSettings
    next.providers = { ...(next.providers ?? {}) }
    for (const [providerId, values] of Object.entries(patch)) {
      next.providers[providerId] = { ...(next.providers[providerId] ?? {}), ...values } as ProviderConfig
    }
    return next
  }

  /** 写 per-space 模型选择。 */
  async function writeSelectedModels(providerId: string, ids: string[]): Promise<boolean> {
    return writeProviderSettings(
      patchProviders({ [providerId]: { selectedModels: [...ids] } }),
      '保存模型选择失败',
    )
  }

  /**
   * 写 per-space 默认 provider/model。provider 与 model 是**一对**:一个 model id
   * 只在它自己的 provider 下有意义,拆成两次写的第一天就能出现
   * 「provider=deepseek / model=glm-5」这种谁也解释不清的组合。
   */
  async function writeDefaultSelection(provider: string, model: string): Promise<boolean> {
    const next = model
      ? patchProviders({ [provider]: { model } })
      : (JSON.parse(JSON.stringify(currentSettings())) as SpaceProviderSettings)
    next.provider = provider
    return writeProviderSettings(next, '保存默认模型失败')
  }

  /**
   * 写 per-space provider 开关。一次可以写多个 id —— 家族卡(API + 订阅)是
   * **一个**开关单元,两个成员必须在同一次写里落盘,否则第二次写会拿着还没更新的
   * 那份去覆盖第一次。
   */
  async function writeProvidersEnabled(providerIds: string[], enabled: boolean): Promise<boolean> {
    const patch: Record<string, Partial<ProviderConfig>> = {}
    for (const id of providerIds) patch[id] = { enabled }
    return writeProviderSettings(patchProviders(patch), '保存 provider 开关失败')
  }

  // 切空间 = 换一整套凭证与 provider 设置。这里是**唯一**的刷新点:主窗切换、
  // 设置窗跟随(storage 事件)、删空间弹回 default 都汇流到 currentSpaceId 上。
  watch(spaceId, () => {
    reset()
    void refresh()
  })

  /**
   * 跨窗口刷新(批 B9-0)。
   *
   * 用户 08-17 真机:在**设置窗**给 DeepSeek 配了 key、登录了 Kimi Code,**主窗**
   * 的模型选择器里两个都不出现 —— 两个 BrowserWindow 两份 Pinia,主窗这份早就
   * `loadedSpaceId === spaceId`,`ensureLoaded` 直接返回,缓存里没有那条 entry,
   * `isConfigured` 全 false,选择器第三道闸把 provider 藏了。切走再切回就好,
   * 正是缓存过期的指纹。
   *
   * 订阅放在 store 里而不是组件里:上面那条 watch 已经立了规矩 —— **这个 store 是
   * 唯一的刷新点**。挂在组件上会随组件卸载而失效,而设置窗改东西时主窗的选择器
   * 未必挂着。
   */
  function subscribeCrossWindowRefresh(): void {
    const api = platformApi as { onSpacesChanged?: (cb: (event: SpacesChangedEvent) => void) => () => void }
    if (typeof api.onSpacesChanged !== 'function') return
    api.onSpacesChanged(event => {
      // 别的空间的变更与我无关。C1 起 default 也在这条支路上 —— 它的凭证、
      // overlay 与(C2)providers.json 同样会发 `spaces:changed`。
      if (!event || event.spaceId !== spaceId.value) return
      void refresh()
    })
  }
  subscribeCrossWindowRefresh()

  return {
    credentials,
    providerSettings,
    loading,
    loadedSpaceId,
    lastError,
    spaceId,
    isDefaultSpace,
    spaceAvailable,
    reset,
    refresh,
    ensureLoaded,
    poolOf,
    configOf,
    currentSettings,
    strategies,
    applyCredentials,
    writeProviderSettings,
    writeSelectedModels,
    writeDefaultSelection,
    writeProvidersEnabled,
  }
})
