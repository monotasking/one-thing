/**
 * Provider 自述表 —— 批 M(`docs/design/provider-settings-rework-2026-09.md` §5)。
 *
 * 从前「这是不是 codex / copilot / custom-*」散在十几个文件里各判一次,每加一家、
 * 每多一种能力就得回去改一串 `if (providerId === …)`。现在反过来:**每家自己说**
 * 它用哪份方言、怎么登录、模型从哪来、按什么计费、同家的另一半是谁;别人只读字段。
 *
 *  - 内置各家 = `vendors/<id>/manifest.ts` 里各自的字面量,名册 `vendors/manifests.ts`,
 *    经 `builtin-manifests.ts` 补上家族格后在模块加载时登记进注册表;
 *  - 自定义服务商 = 设置里的 `CustomProviderConfig`,经 `manifestOfCustomProvider`
 *    映射成同一个形状,由装配层逐个 `register` 并 `own()` 卸载函数。
 *
 * 本文件是**纯**模块:不碰 node / electron / `process`,壳也能 import。
 */
import type { OnethingModelRule } from './model-capability.js'
import type { OnethingModelsDevModel } from './model-registry.js'
import type { DialSpec } from './dials.js'
import type { CustomAdapterSpec } from '@shared/contracts/adapter-spec'
import type { ProviderFamilyRole } from '@shared/provider-families.js'
import { configureProviderErrorCodeDescriber } from '../agent-loop/index.js'
import { BUILTIN_PROVIDER_MANIFESTS, EXTERNAL_AGENT_DIALECT_ID } from './builtin-manifests.js'
import { ONETHING_PROTOCOL_DEFAULT_MODEL_RULES } from './model-families/index.js'

export { EXTERNAL_AGENT_DIALECT_ID }

export type { DialSpec } from './dials.js'

/** 登录方式。`oauth.flow` 与 `auth/registry.ts` 各家的 `flowKind` 同一套词。 */
export type ProviderAuthSpec =
  | { kind: 'apiKey' }
  | { kind: 'oauth'; flow: 'pkce-callback' | 'manual-pkce' | 'device-code' }
  | { kind: 'none' }

/**
 * 模型目录从哪来。
 *  - `models.dev`:读 models.dev 那本目录的 `key`;`keyOf` 给档位/地区决定目录的家
 *    (千问 / Kimi)按配置算;`include` 是型号 id 子串白名单(Claude Code 只列 Claude)。
 *  - `endpoint`:服务商自己的模型列表接口(Codex / Copilot)。`catalogKey` 是「能力事实
 *    仍从 models.dev 哪本目录补」—— Copilot 的列表口不报上下文长度,那一半靠目录。
 *  - `roster`:名册(ACP agent 表),条目是 agent 不是模型。
 *  - `none`:没有目录来源,只有用户手填的。
 */
export type ProviderModelsSource =
  | {
      kind: 'models.dev'
      key: string
      keyOf?(config: Record<string, unknown> | undefined): string
      include?: readonly string[]
    }
  | { kind: 'endpoint'; path?: string; catalogKey?: string }
  | { kind: 'roster' }
  | { kind: 'none' }

export type ProviderBilling = 'api' | 'subscription'

/**
 * 不属于线协议、但确实是「这一家」才有的行为事实。每一格缺席 = 通用行为。
 * 加一格 = 这里一行 + 读它的那一处;**不许**在读的那一处写 provider 名。
 */
export interface ProviderBehaviors {
  /** 系统提示词拆成多条 developer 消息发(Codex 后端的要求)。 */
  separateDeveloperMessages?: boolean
  /** 服务商回报的 input tokens 与本地估算对不上时,跳过这一次自动压缩(Codex 的 usage 口径)。 */
  skipCompactOnUsageMismatch?: boolean
  /** 出图只经原生工具,不走「回合内出图」那条判定(Codex 的 `image_generation`)。 */
  imageOutputViaNativeToolOnly?: boolean
}

/**
 * 「档位 / 地区 → 地址」这一组(有档位的家才有;`docs/design/architecture-direction-2026-10.md`
 * §4 P1)。从前是 `provider-options.ts` / `zhipu.ts` / `credentials/credentials-provider-rules.ts` 里各一串
 * 按 id 的分支,现在每家把自己的那一半写在自己的 `vendors/<id>/`,通用代码只问这几格。
 * 每一格缺席 = 通用行为(没有专属格子、地址就是配置里的 `baseUrl`)。
 */
export interface ProviderEndpointSpec {
  /** 存档配置 → 这家要带进 `providerOptions` 的专属格子;`undefined` = 不带。 */
  pickOptions?(stored: Record<string, unknown>): Record<string, unknown> | undefined
  /** 生效配置(`baseUrl` + 专属格子)→ 实际请求的地址。 */
  resolveBaseUrl?(config: Record<string, unknown> | undefined): string
  /** 空间凭证条目里的档位 / 地区落在配置的哪两格。 */
  entryFields?: { apiMode?: string; region?: string }
  /** 地址由档位派生,所以空间条目说了算:抹档位时连 `baseUrl` 一起抹。 */
  ownsBaseUrl?: boolean
}

/** models.dev 上这一家的模型以什么品牌名、在哪几本目录里出现(模型认亲用)。 */
export interface ProviderModelIdentity {
  /** 型号 id 前缀里这家厂牌的写法(小写)。聚合站没有自己的厂牌,写空表。 */
  brands: readonly string[]
  /** 这家在 models.dev 里的目录键,按偏好排;在这里的键就是「第一方」。聚合站写空表。 */
  keys: readonly string[]
  /**
   * 这家的 models.dev 目录(`models.key`)是聚合站的「厂牌/型号」总表:带厂牌前缀的 id 在厂牌那家
   * 查不到时,拿整串来这本目录里精确匹配(`model-identity.ts` 的第 ① 级)。
   */
  aggregator?: boolean
}

/**
 * 出厂种子:这一家在出厂设置里的那一条 provider 配置(服务商自述试点 P3)。从前是
 * `@shared/defaults/settings.ts` 里一张按家点名的大表,现在每家自己带,装配层
 * (`packages/backend/runtime/settings/settings-defaults.ts`)按名册拼回来交给 `@shared` 的
 * `createDefaultSettings` / `mergeWithDefaults`;空白空间加第一把 key 时的模型预填也读它。
 *
 * **值是逐字照搬旧表的**,与上面的 `defaultModel` 不是一回事(两边今天本来就不一样,
 * 拿一边去「统一」另一边就是改行为)。键序也照搬:设置文件里的键序就是它。
 *
 * 契约层的 `ProviderConfig` 这里用不上(产品层不许依赖 IPC 契约),所以只列
 * 通用的几格;档位格(`zhipuApiMode` …)的键名由这家 `dials.apiModeKey` / `regionKey` 声明,
 * 走索引签名。
 */
export interface ProviderSeed {
  readonly model: string
  readonly selectedModels: readonly string[]
  readonly enabled: boolean
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly authType?: 'apiKey' | 'oauth'
  /** 各家档位格:键名由 manifest 的 `dials` 声明。 */
  readonly [dialKey: string]: unknown
}

/** 一家在家族里的声明(见 `ProviderManifest.family`)。 */
export interface ProviderFamilyDeclaration {
  role: ProviderFamilyRole
  /** 订阅那一半在合并卡片上的小标签(「Codex」)。由订阅那一半声明。 */
  tag?: string
}

export interface ProviderManifest {
  id: string
  /** 内置的写在代码里;自定义的从设置映射来。替掉从前的 `startsWith('custom-')`。 */
  origin: 'builtin' | 'custom'
  /** 显示名。内置家今天是字面(不走字典),自定义是用户起的名字。 */
  name: string
  /** 内置家 = 字典键 `providers.desc.<id>`;自定义 = 用户写的原文(可空串)。 */
  description: string
  icon: string
  /**
   * 已登记方言 id(`providers/dialects`)。外部执行体(ACP / Claude Code
   * Agent)没有线协议,写 `external-agent` —— 它们的 provider 由执行器注册表建,不查方言。
   */
  dialect: string
  auth: ProviderAuthSpec
  models: ProviderModelsSource
  billing: ProviderBilling
  /** 批 5 配额源注册表里的 id。 */
  quotaSource?: string
  /**
   * 这家是家族里的哪一半(服务商自述试点 P4:家族事实的产地,替代了 `@shared` 里那张写死的
   * 家族表)。各家只说自己:API 那一半 `{ role: 'api' }`,订阅那一半再带合并卡片上的 `tag`。
   * **哪两半是一家**登记在名册 `vendors/manifests.ts` 的 `VENDOR_FAMILIES`(每个家族一行)——
   * 不写在半边的字面量里,因为那样订阅那一半就得点 API 那一家的名(`provider:gate` 不许
   * 一家的家里认识别家)。家族键 = API 那一半的 id,家名 = API 那一半的 `name`;
   * `sibling` / `familyTag` 由 `builtin-manifests.ts` 算出,壳经 `ProviderInfo.family` 拿到。
   */
  family?: ProviderFamilyDeclaration
  /**
   * 同家的另一半(由 `builtin-manifests.ts` 按两半的 `family` 声明算出,不写在字面量里)。
   */
  sibling?: string
  /** 订阅那一半在合并卡片上的小标签(「Codex」「Claude Code」)。只在 `billing: 'subscription'` 且有 `sibling` 时读。 */
  familyTag?: string
  /** 计费档位(千问 / Kimi / 智谱)。 */
  dials?: DialSpec
  /** 这家的模型按 `model-capability.ts` 哪一张型号规则表判(表 id,由带表的那家 `modelRuleTable` 给出)。 */
  modelRules: string
  behaviors?: ProviderBehaviors
  defaultBaseUrl: string
  supportsCustomBaseUrl: boolean
  defaultModel: string
  /** 读密钥的环境变量(按优先级)。缺席 = 只认 `<ID>_API_KEY`。 */
  envVars?: readonly string[]
  /** 模型认亲(`model-identity.ts`)。 */
  modelIdentity?: ProviderModelIdentity
  /** 这些 models.dev 目录键反查到这一家(`models-dev-catalog.ts` 的映射表)。 */
  catalogAliases?: readonly string[]
  /** 这家接口的错误码 → 人话说明。经 core 的查询口接进错误详情。 */
  errorDescriptions?: Readonly<Record<string, string>>
  endpoint?: ProviderEndpointSpec
  /**
   * `modelRules` 那张型号规则表由这一家自己带(表名 = 这家的 `modelRules`)。
   * 同一张表可以被别家借用(claude-code 借 claude 的),但只由一家带。
   */
  modelRuleTable?: readonly OnethingModelRule[]
  /**
   * 目录补缺(只对 `models.kind === 'models.dev'` 的家有意义):这家在 models.dev 的目录滞后时,
   * 按配置补上目录里还没有的几行 —— 只补缺,目录里真有的一律让位。千问的按量目录缺旗舰就靠它;
   * 缺席 = 不补。
   */
  catalogBackfill?(config: Record<string, unknown> | undefined): readonly OnethingModelsDevModel[]
  /** 出厂设置里的那一条(见 `ProviderSeed`)。缺席 = 出厂设置里没有这一家。 */
  seed?: ProviderSeed
  /**
   * 名字点了这一家的思考线型 id 里,用户能在思考覆盖(`reasoningProfile.wire`)里点名的那几条。
   * 合法取值是各家这一格与协议层名单(`providers/thinking/protocol-wire-ids.ts`)的
   * 并集,不分是哪一家的覆盖(从前那张手写名单就是全局的)。
   */
  reasoningWires?: readonly string[]
}

/**
 * 自定义服务商在设置里的样子(契约层的 `CustomProviderConfig`,产品层不认识那份
 * 契约,所以这里只列映射要读的几格)。
 */
export interface CustomProviderManifestSource {
  id: string
  name?: string
  description?: string
  apiType?: 'openai' | 'anthropic'
  /** 批 M:直接点名一份已登记方言;有值则优先于 `apiType`。 */
  dialect?: string
  baseUrl?: string
  model?: string
  /** 批 4:「自动识别」产出、用户应用过的适配表。有它 = manifest 的方言指向它编译出来的那一份。 */
  adapter?: CustomAdapterSpec
}

export const CUSTOM_OPENAI_DIALECT_ID = 'custom-openai'

/**
 * 适配表编译出来的方言 id(批 4 §7.2)。装配层按这个 id 登记 `dialectFromSpec` 的产物,
 * manifest 指它,工厂认它 —— 三处读同一个函数,约定只写一次。
 */
export function customAdapterDialectId(providerId: string): string {
  return `custom:${providerId}`
}

export function isCustomAdapterDialectOf(providerId: string, dialectId: string | undefined): boolean {
  return dialectId === customAdapterDialectId(providerId)
}
export const CUSTOM_ANTHROPIC_DIALECT_ID = 'custom-anthropic'

/**
 * 自定义服务商 → manifest。读时映射,盘上的形状一格没动(旧数据不迁移)。
 *
 * `modelRules`:点名了方言且那份方言是某个内置家的,就借那一家的型号规则表(转发站
 * 选了 `openrouter` 方言,型号规则也该是 openrouter 那张);否则按接口类型查协议缺省表
 * (`model-families` 的 `ONETHING_PROTOCOL_DEFAULT_MODEL_RULES`)。
 */
export function manifestOfCustomProvider(custom: CustomProviderManifestSource): ProviderManifest {
  const baseDialect =
    custom.dialect ||
    (custom.apiType === 'anthropic' ? CUSTOM_ANTHROPIC_DIALECT_ID : CUSTOM_OPENAI_DIALECT_ID)
  const dialect = custom.adapter ? customAdapterDialectId(custom.id) : baseDialect
  const borrowed = custom.dialect
    ? BUILTIN_PROVIDER_MANIFESTS.find((manifest) => manifest.dialect === custom.dialect)?.modelRules
    : undefined
  return {
    id: custom.id,
    origin: 'custom',
    name: custom.name || custom.id,
    description: custom.description ?? '',
    icon: 'custom',
    dialect,
    auth: { kind: 'apiKey' },
    models: { kind: 'endpoint' },
    billing: 'api',
    modelRules:
      borrowed ??
      ONETHING_PROTOCOL_DEFAULT_MODEL_RULES[baseDialect === CUSTOM_ANTHROPIC_DIALECT_ID ? 'anthropic' : 'openai'],
    defaultBaseUrl: custom.baseUrl ?? '',
    supportsCustomBaseUrl: true,
    defaultModel: custom.model ?? '',
  }
}

/**
 * 进程级注册表。`register` 返回卸载函数(带身份守卫:同 id 后来又登记了别的,旧的
 * 卸载函数不会把新的抹掉)。同 id 重复登记是**明确错误** —— 自定义服务商要换内容,
 * 先卸再登。
 */
export class ProviderManifestRegistry {
  private readonly byId = new Map<string, ProviderManifest>()

  register(manifest: ProviderManifest): () => void {
    if (this.byId.has(manifest.id)) {
      throw new Error(`Provider manifest already registered: ${manifest.id}`)
    }
    this.byId.set(manifest.id, manifest)
    return () => {
      if (this.byId.get(manifest.id) === manifest) this.byId.delete(manifest.id)
    }
  }

  get(id: string | undefined | null): ProviderManifest | undefined {
    return id ? this.byId.get(id) : undefined
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  list(): ProviderManifest[] {
    return [...this.byId.values()]
  }

  /** 测试用:清掉一切,重登内置 16 家。 */
  resetForTests(): void {
    this.byId.clear()
    for (const manifest of BUILTIN_PROVIDER_MANIFESTS) this.byId.set(manifest.id, manifest)
  }
}

const registry = new ProviderManifestRegistry()
registry.resetForTests()

/**
 * 错误码说明:问遍已登记的家,第一家认得这个码的给说明。core 不认识任何一家,
 * 只认这个查询口(`configureProviderErrorCodeDescriber`)。
 *
 * 口径与搬家前逐字相同:说明**不分是哪家返回的**错误 —— 从前 core 里那张智谱表对
 * 任何一家的同号错误码都会配上说明,这里照旧(`vendor-facts.snapshot` 钉着)。
 */
configureProviderErrorCodeDescriber((code) => {
  for (const manifest of registry.list()) {
    const description = manifest.errorDescriptions?.[code]
    if (description) return description
  }
  return undefined
})

export function getProviderManifestRegistry(): ProviderManifestRegistry {
  return registry
}

/** 最常用的那一问。未登记 = `undefined`,读的人按「通用行为」处理。 */
export function getProviderManifest(id: string | undefined | null): ProviderManifest | undefined {
  return registry.get(id)
}

export function registerProviderManifest(manifest: ProviderManifest): () => void {
  return registry.register(manifest)
}

export function isCustomProvider(id: string | undefined | null): boolean {
  return registry.get(id)?.origin === 'custom'
}

export function isSubscriptionProvider(id: string | undefined | null): boolean {
  return registry.get(id)?.billing === 'subscription'
}

export function resetProviderManifestRegistryForTests(): void {
  registry.resetForTests()
}
