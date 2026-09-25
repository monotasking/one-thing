/**
 * Provider 自述表 —— 批 M(`docs/design/provider-settings-rework-2026-09.md` §5)。
 *
 * 从前「这是不是 codex / copilot / custom-*」散在十几个文件里各判一次,每加一家、
 * 每多一种能力就得回去改一串 `if (providerId === …)`。现在反过来:**每家自己说**
 * 它用哪份方言、怎么登录、模型从哪来、按什么计费、同家的另一半是谁;别人只读字段。
 *
 *  - 内置 16 家 = `builtin-manifests.ts` 里 16 个字面量(模块加载时登记进注册表);
 *  - 自定义服务商 = 设置里的 `CustomProviderConfig`,经 `manifestOfCustomProvider`
 *    映射成同一个形状,由装配层逐个 `register` 并 `own()` 卸载函数。
 *
 * 本文件是**纯**模块:不碰 node / electron / `process`,壳也能 import。
 */
import type { OnethingProviderKind } from './model-capability.js'
import type { DialSpec } from './dials.js'
import type { CustomAdapterSpec } from '@shared/contracts/adapter-spec'
import { BUILTIN_PROVIDER_MANIFESTS, EXTERNAL_AGENT_DIALECT_ID } from './builtin-manifests.js'

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
   * 已登记方言 id(`agent-loop/providers/dialects`)。外部执行体(ACP / Claude Code
   * Agent)没有线协议,写 `external-agent` —— 它们的 provider 由执行器注册表建,不查方言。
   */
  dialect: string
  auth: ProviderAuthSpec
  models: ProviderModelsSource
  billing: ProviderBilling
  /** 批 5 配额源注册表里的 id。 */
  quotaSource?: string
  /**
   * 同家的另一半:codex↔openai、claude-code↔claude、kimi-code↔kimi、grok-oauth↔grok。
   * 内置家这一格由 `builtin-manifests.ts` 读 `@shared/provider-families` 补上(那张表是
   * 家族事实的产地 —— `@onething/client` 只吃 `@shared`,而 `@shared` 不许依赖 runtime)。
   */
  sibling?: string
  /** 订阅那一半在合并卡片上的小标签(「Codex」「Claude Code」)。只在 `billing: 'subscription'` 且有 `sibling` 时读。 */
  familyTag?: string
  /** 计费档位(千问 / Kimi / 智谱)。 */
  dials?: DialSpec
  /** 这家的模型按 `model-capability.ts` 哪一张型号规则表判。 */
  modelRules: OnethingProviderKind
  behaviors?: ProviderBehaviors
  defaultBaseUrl: string
  supportsCustomBaseUrl: boolean
  defaultModel: string
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
 * 选了 `openrouter` 方言,型号规则也该是 openrouter 那张);否则按 `apiType`。
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
    modelRules: borrowed ?? (baseDialect === CUSTOM_ANTHROPIC_DIALECT_ID ? 'claude' : 'openai'),
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
