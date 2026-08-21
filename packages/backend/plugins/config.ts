/**
 * 插件自有配置的宿主侧(R3)。
 *
 * schema 的唯一事实源是 manifest 的 `contributes.settings.schema` —— 存储、校验、
 * 默认值填充、变更推送全由宿主做,**不执行一行插件代码**。直接的红利:
 * 未启用(甚至从没加载过)的插件也能在设置页配置。
 */
import { pluginScope } from '@onething/core/plugins'
import {
  CORE_PLUGIN_SETTINGS_HOOK_TIMEOUT_MS,
  runWithPluginTimeout,
} from '@onething/core/plugins'
import {
  coercePluginConfig,
  deepFreezePluginConfig,
  describePluginConfigSchema,
  stripPluginConfigDefaults,
  type PluginConfigError,
  type PluginConfigField,
  type PluginConfigSchemaDescription,
} from '@onething/runtime/plugins'
import {
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
} from './health.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('plugins')


export interface PluginConfigHost {
  /** manifest 的 contributes.settings(schema 单源)。 */
  getSettingsContribution(pluginId: string): {
    title?: string
    schema?: Record<string, unknown>
    ui?: Record<string, { label?: string; hint?: string; control?: string }>
  } | undefined
  readConfig(pluginId: string): Record<string, unknown>
  writeConfig(pluginId: string, config: Record<string, unknown> | null): void
}

let host: PluginConfigHost | null = null

export function configurePluginConfigHost(next: PluginConfigHost | null): void {
  host = next
  invalidatePluginConfigCache()
}

const listeners = new Map<string, Set<(config: Record<string, unknown>) => void>>()
/** 已经就"读到坏值"吼过的插件,免得每次读都刷屏。 */
const warnedPlugins = new Set<string>()

/**
 * 归约与有效值的缓存。
 *
 * log-monitor 的取值器把 `api.settings.get()` 接到了 1Hz 的事件热路径上 ——
 * 不缓存的话每一次都是"同步读盘 + 全量 schema 归约"。写路径已经收口在本模块,
 * 所以失效点是可枚举的(set / host 重配)。
 */
const schemaCache = new WeakMap<object, PluginConfigSchemaDescription>()
const effectiveCache = new Map<string, Record<string, unknown>>()

export function invalidatePluginConfigCache(pluginId?: string): void {
  if (pluginId) effectiveCache.delete(pluginId)
  else effectiveCache.clear()
}

export function describePluginConfig(pluginId: string): PluginConfigSchemaDescription | null {
  const contribution = host?.getSettingsContribution(pluginId)
  if (!contribution?.schema) return null

  // 按 manifest 里那个 schema 对象的**引用**记忆化:manifest 不变就不重算,
  // 换了插件版本(新对象)自然是新条目。
  const cached = schemaCache.get(contribution.schema)
  if (cached) return cached

  const described = describePluginConfigSchema(contribution.schema, {
    title: contribution.title,
    ui: contribution.ui,
  })
  schemaCache.set(contribution.schema, described)
  return described
}

function fieldsOf(pluginId: string): PluginConfigField[] | null {
  const described = describePluginConfig(pluginId)
  return described && described.supported ? described.fields : null
}

/**
 * 已校验、已填默认值的有效配置。
 *
 * 返回的是**深冻结**的快照:浅冻结只挡住顶层赋值,`get().tags.push('x')` 照样
 * 能写穿共享的数组。
 *
 * schema 缺失或不受支持 → 返回盘上原样(没有 schema 就没有契约可执行),
 * 让调用方自己决定怎么呈现。
 */
export function getEffectivePluginConfig(pluginId: string): Record<string, unknown> {
  const cached = effectiveCache.get(pluginId)
  if (cached) return cached

  const stored = host?.readConfig(pluginId) ?? {}
  const fields = fieldsOf(pluginId)
  if (!fields) {
    const passthrough = deepFreezePluginConfig({ ...stored })
    effectiveCache.set(pluginId, passthrough)
    return passthrough
  }

  const result = coercePluginConfig(fields, stored)
  if (result.warnings.length > 0 && !warnedPlugins.has(pluginId)) {
    warnedPlugins.add(pluginId)
    log.warn('stored plugin config has invalid values, using defaults', {
      pluginId,
      warnings: result.warnings,
    })
  }
  const frozen = deepFreezePluginConfig(result.config)
  effectiveCache.set(pluginId, frozen)
  return frozen
}

/**
 * F1 第二根:这个插件当前指到哪个用户目录。
 *
 * **寻址靠 schema 而不是一个约定的键名。** 让宿主认一个魔法键(`externalRoot`)
 * 会逼每个插件都去猜那个名字,猜错就静默没有外部根;而 `format: 'directory-pick'`
 * 本来就是这条声明的唯一正门,顺着它找是零约定的。
 *
 * 只认**第一条**:一个插件一个外部根(见 `storage:external-root` 的裁决 ——
 * 多根会立刻引出"哪个是默认""跨根移动怎么算"这些没有用例支撑的问题)。
 * 声明了两条 = 第二条不生效,而不是报错:这不值得让插件加载失败。
 *
 * 每次调用现取(`getEffectivePluginConfig` 自带缓存,改配置会 invalidate):
 * 缓存一份路径等于让用户改完设置之后的写还落在旧目录,而界面显示的是新目录。
 */
export function getPluginExternalRoot(pluginId: string): string | undefined {
  const fields = fieldsOf(pluginId)
  const field = fields?.find(item => item.directoryPick)
  if (!field) return undefined
  const value = getEffectivePluginConfig(pluginId)[field.key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 这个插件声明过 `format: 'directory-pick'` 吗(设置页要不要画那个按钮)。 */
export function pluginDeclaresExternalRootField(pluginId: string): boolean {
  return Boolean(fieldsOf(pluginId)?.some(item => item.directoryPick))
}

export interface SetPluginConfigResult {
  success: boolean
  config?: Record<string, unknown>
  errors?: PluginConfigError[]
}

/**
 * 写入配置。
 *
 * 顺序是 **校验 → 持久化 → 通知**:通知是插件代码,它挂了不能把已经通过校验的
 * 配置写丢(软隔离的字面要求)。
 *
 * 落盘的是"偏离默认的部分",不是物化后的全字段 —— 见 stripPluginConfigDefaults。
 */
export function setPluginConfig(pluginId: string, input: unknown): SetPluginConfigResult {
  if (!host) return { success: false, errors: [{ message: 'Plugin config host is not configured' }] }

  const described = describePluginConfig(pluginId)
  if (!described) {
    return {
      success: false,
      errors: [{ message: `Plugin "${pluginId}" does not declare contributes.settings.schema` }],
    }
  }
  if (!described.supported) {
    return { success: false, errors: described.reasons.map(message => ({ message })) }
  }

  const result = coercePluginConfig(described.fields, input)
  if (result.errors.length > 0) {
    return { success: false, errors: result.errors }
  }

  const persisted = stripPluginConfigDefaults(described.fields, result.config)
  host.writeConfig(pluginId, Object.keys(persisted).length > 0 ? persisted : null)
  warnedPlugins.delete(pluginId)
  invalidatePluginConfigCache(pluginId)

  const effective = getEffectivePluginConfig(pluginId)
  void notifyPluginConfigChange(pluginId, effective)

  return { success: true, config: effective }
}

/** 插件侧 api.settings.onChange 的登记口。 */
export function subscribePluginConfigChange(
  pluginId: string,
  callback: (config: Record<string, unknown>) => void,
): () => void {
  const set = listeners.get(pluginId) ?? new Set()
  set.add(callback)
  listeners.set(pluginId, set)
  return () => {
    set.delete(callback)
    if (set.size === 0) listeners.delete(pluginId)
  }
}

/**
 * 每插件一条通知链 + 待推配置。
 *
 * fire-and-forget 地并发推送会乱序:连写两次时 cfg2 的回调先跑完、cfg1 后跑完,
 * 插件的最终认知就停在 cfg1,而盘上是 cfg2。排队保证"最后送达的就是最新的";
 * 排队期间又来新配置则**只留最新那份**(中间态没人需要看见)。
 */
const notifyChains = new Map<string, Promise<void>>()
const pendingConfigs = new Map<string, Record<string, unknown>>()

export function notifyPluginConfigChange(
  pluginId: string,
  config: Record<string, unknown>,
): Promise<void> {
  const set = listeners.get(pluginId)
  if (!set || set.size === 0) return Promise.resolve()

  const alreadyQueued = pendingConfigs.has(pluginId)
  pendingConfigs.set(pluginId, config)
  if (alreadyQueued) {
    // 已经有一轮在排队:它出队时会读到我们刚写进去的最新值,不必再排一轮。
    return notifyChains.get(pluginId) ?? Promise.resolve()
  }

  const previous = notifyChains.get(pluginId) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => deliverPluginConfigChange(pluginId))
    .finally(() => {
      if (notifyChains.get(pluginId) === next) notifyChains.delete(pluginId)
    })
  notifyChains.set(pluginId, next)
  return next
}

/**
 * 推送 —— onChange 回调是**插件代码**,纳入软隔离。
 *
 * 每个回调各带超时预算,失败/超时进 R1 的熔断账(scope `settings:onChange`),
 * 而且一律不影响配置保存本身:保存早就在这之前完成了。
 */
async function deliverPluginConfigChange(pluginId: string): Promise<void> {
  const config = pendingConfigs.get(pluginId)
  pendingConfigs.delete(pluginId)
  if (!config) return

  const set = listeners.get(pluginId)
  if (!set || set.size === 0) return

  const snapshot = deepFreezePluginConfig({ ...config })
  for (const callback of [...set]) {
    try {
      await runWithPluginTimeout(
        `settings.onChange:${pluginId}`,
        CORE_PLUGIN_SETTINGS_HOOK_TIMEOUT_MS,
        () => callback(snapshot),
      )
      reportPluginRuntimeSuccess(pluginId, pluginScope.settingsChange())
    } catch (error) {
      log.error('plugin settings onChange failed', { pluginId }, error)
      reportPluginRuntimeFailure(pluginId, pluginScope.settingsChange(), error)
    }
  }
}

export function resetPluginConfigListenersForTests(): void {
  listeners.clear()
  warnedPlugins.clear()
  notifyChains.clear()
  pendingConfigs.clear()
  invalidatePluginConfigCache()
}
