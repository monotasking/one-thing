/**
 * 「生效 AI 设置」的**合成与拆分**(C2)—— 后端与渲染层共用的那一份。
 *
 * C2 之后 provider 设置有两个住址:
 *
 * - `workspaces/<id>/providers.json` —— **该空间整套** provider 设置。
 * - `settings.json` 的 `ai` 段 —— 只剩两格:温度缺省 + models.dev 目录缓存。
 *
 * 运行期与渲染层拿在手里的是**合成后**的那一份(`AppSettings.ai`,类型
 * `EffectiveAISettings`),所以整棵消费者树一个字没改就变成了 per-space。
 *
 * 放在 `@shared` 而不是装配层:渲染层的设置页要做**同样的**拆分(它编辑的就是
 * 当前空间的那一份),而渲染层进不了 `@onething/backend`。两处各写一份的第一天不会
 * 有人发现,第一百天没人解释得清为什么设置页存下去的东西引擎读不到。
 */

import type {
  CustomProviderConfig,
  EffectiveAISettings,
  ProviderConfig,
  ProviderModelCatalog,
  SpaceProviderSettings,
} from '../ipc/providers.js'

export const DEFAULT_AI_TEMPERATURE = 0.7

/** 空白空间的初值:没有 provider 开着、没有模型选中、没有默认。 */
export function createEmptySpaceProviderSettings(): SpaceProviderSettings {
  return { provider: '', providers: {}, customProviders: [] }
}

/** 永不落进 `providers.json` 的键:凭证(进池)与目录缓存(留全局)。 */
export const SPACE_PROVIDER_STRIPPED_FIELDS = [
  'apiKey',
  'oauthToken',
  'authType',
  'models',
  'modelsLastFetched',
] as const

function catalogOf(
  ai: { modelCatalog?: Record<string, ProviderModelCatalog> } | undefined,
): Record<string, ProviderModelCatalog> {
  const catalog = ai?.modelCatalog
  return catalog && typeof catalog === 'object' ? catalog : {}
}

/**
 * 「这个 provider 在这个空间没有任何表达」。
 *
 * 合成会给目录里认识、但空间没配过的 provider 补一条**全灭壳**(否则设置页拿不到
 * 它的目录缓存,新配一个 provider 时模型列表是空的)。拆分时必须把这些壳再摘掉,
 * 不然「空白空间」第一次保存就会长出一份「所有 provider 都表达过 enabled=false」
 * 的文件 —— 而「没表达过」与「表达成关」在种子预填那里是两回事。
 */
export function isBlankProviderRecord(config: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue
    if (key === 'model') {
      if (value) return false
      continue
    }
    if (key === 'selectedModels') {
      if (Array.isArray(value) && value.length > 0) return false
      continue
    }
    if (key === 'enabled') {
      if (value === true) return false
      continue
    }
    return false
  }
  return true
}

/**
 * 空间设置 + 全局目录缓存 → 生效形状。
 *
 * provider 键 = 空间配过的 ∪ 目录里有缓存的。后者补的是**全灭壳**:`enabled`
 * 缺省 false —— 空白空间不该开出来就所有 provider 全亮(§7 的拍板)。
 */
export function composeEffectiveAISettings(
  global: { temperature?: number; modelCatalog?: Record<string, ProviderModelCatalog> } | undefined,
  space: SpaceProviderSettings | null | undefined,
): EffectiveAISettings {
  const scoped = space ?? createEmptySpaceProviderSettings()
  const catalog = catalogOf(global)
  const providers: Record<string, ProviderConfig> = {}
  const ids = new Set<string>([...Object.keys(scoped.providers ?? {}), ...Object.keys(catalog)])
  for (const id of ids) {
    const spaceConfig = scoped.providers?.[id]
    const base = (spaceConfig ?? { model: '', selectedModels: [], enabled: false }) as ProviderConfig
    providers[id] = { ...base, ...(catalog[id] ?? {}) }
  }
  return {
    provider: scoped.provider ?? '',
    temperature: scoped.temperature ?? global?.temperature ?? DEFAULT_AI_TEMPERATURE,
    providers,
    customProviders: (scoped.customProviders ?? []) as CustomProviderConfig[],
    modelCatalog: catalog,
  }
}

/**
 * 生效形状 → 落盘的两半。
 *
 * 目录缓存的**来源有两处**:合成时挂在 `ai.modelCatalog` 上的那份,以及消费者
 * 直接写进 `ai.providers[pid].models` 的那份(model-registry 刷新目录走的就是
 * 后者)。两处都收,否则刷新一次目录会在下一次保存时消失。
 */
export function splitEffectiveAISettings(ai: EffectiveAISettings): {
  global: { temperature: number; modelCatalog: Record<string, ProviderModelCatalog> }
  space: SpaceProviderSettings
} {
  const catalog: Record<string, ProviderModelCatalog> = {}
  for (const [id, entry] of Object.entries(catalogOf(ai))) {
    if (entry && (entry.models || typeof entry.modelsLastFetched === 'number')) catalog[id] = entry
  }

  const space = createEmptySpaceProviderSettings()
  space.provider = typeof ai?.provider === 'string' ? ai.provider : ''
  if (typeof ai?.temperature === 'number') space.temperature = ai.temperature

  for (const [id, config] of Object.entries(ai?.providers ?? {})) {
    if (!config) continue
    const record = config as unknown as Record<string, unknown>
    const models = record.models
    const modelsLastFetched = record.modelsLastFetched
    if (models || typeof modelsLastFetched === 'number') {
      catalog[id] = {
        ...(models ? { models: models as ProviderModelCatalog['models'] } : {}),
        ...(typeof modelsLastFetched === 'number' ? { modelsLastFetched } : {}),
      }
    }
    const stripped: Record<string, unknown> = { ...record }
    for (const key of SPACE_PROVIDER_STRIPPED_FIELDS) delete stripped[key]
    if (isBlankProviderRecord(stripped)) continue
    space.providers[id] = stripped as unknown as ProviderConfig
  }

  for (const custom of ai?.customProviders ?? []) {
    if (!custom || typeof custom.id !== 'string' || !custom.id.trim()) continue
    const record: Record<string, unknown> = { ...(custom as unknown as Record<string, unknown>) }
    for (const key of SPACE_PROVIDER_STRIPPED_FIELDS) delete record[key]
    record.id = custom.id
    space.customProviders.push(record as unknown as CustomProviderConfig)
  }

  return {
    global: {
      temperature: typeof ai?.temperature === 'number' ? ai.temperature : DEFAULT_AI_TEMPERATURE,
      modelCatalog: catalog,
    },
    space,
  }
}
