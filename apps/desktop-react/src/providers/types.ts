import type { OAuthFlowType } from '@shared/ipc/providers'
import type { MessageKey, MessageVars } from '../i18n'

/**
 * 「模型服务」面的领域模型。四层(设计交接稿 §1),批一只落前两层:
 *
 *   家(family)      一个服务商。左栏一行 = 一家。
 *    └ 模式(mode)   同一家的一种接入:API 密钥 / 订阅 OAuth / 本地 CLI / ACP / 自定义。
 *       └ 凭证       批一只做「有没有」与「换一把 key」;多钥列表 / 轮换 / 登录流归批二。
 *       └ 模型目录   跟着**模式**走 —— 订阅坑与 API 坑是两份独立目录,不合并。
 *
 * 「家」不是后端的概念,后端只有 provider。家是**呈现**上的合并,判据是
 * `@shared/provider-families` 那张表(claude+claude-code / grok+grok-oauth /
 * openai+codex / kimi+kimi-code)—— 这里不另写一张,免得两处漂开。
 *
 * ── 与交接稿 §2 的一处出入,以代码为准 ────────────────────────────────────
 * 交接稿说「Codex/Copilot 独立成家」,而仓里 `PROVIDER_FAMILIES` 把
 * openai+codex 编在一家(设计稿第 8 帧的 `openaiModes` 也正是这么画的)。
 * 家族表是**生产代码**里已经在用的判据(聊天的模型选择器、启用开关的家族派生都吃它),
 * 所以这里听它的;github-copilot 确实独立成家 —— 它不在那张表里。
 */

/**
 * 一种接入模式。它决定右面「模式内容区」画什么:
 *  - `api`          密钥区 + API 坑目录;
 *  - `subscription` 登录区 + 订阅坑目录(未登录时目录不可得,如实说);
 *  - `localCli`     本机 CLI(claude-code-agent),零凭证;
 *  - `acp`          本地 Agent 进程(acp);
 *  - `custom`       用户自建端点。
 */
export type ProviderModeKind = 'api' | 'subscription' | 'localCli' | 'acp' | 'custom'

/** 左栏的三组。判据是模式:云端凭证 → cloud,本机进程 → local,用户自建 → custom。 */
export type RailGroup = 'cloud' | 'local' | 'custom'

/**
 * 状态点的五档 tone(ProviderRail 结构摘录里定的表):
 * ok 正常 / bad 有错 / warn 要注意 / idle 还没配 / off 停用。
 */
export type StatusTone = 'ok' | 'bad' | 'warn' | 'idle' | 'off'

/** 一家的一种模式。`providerId` 是**真** provider id —— 凭证与目录都挂在它上面。 */
export interface ProviderMode {
  providerId: string
  kind: ProviderModeKind
  /** 名册给的显示名。分段器那一格的读数由 projection 现算,不存这里。 */
  name: string
  requiresApiKey: boolean
  requiresOAuth: boolean
  oauthFlow?: OAuthFlowType
  /** 名册给的默认端点。API 坑的「高级 · Base URL」那一行读它。 */
  defaultBaseUrl: string
}

/**
 * 一家。`id` 是家键 —— 有家族时等于家族键(= API 那位成员的 id),
 * 独立成家时就是它自己的 provider id。左栏选中的是它,不是某个模式。
 */
export interface ProviderFamilyView {
  id: string
  label: string
  group: RailGroup
  /** 至少一条。顺序即分段器上的顺序。 */
  modes: ProviderMode[]
  /** 名册给的一句话。头部副语用它;空串 = 名册没给,那一行就不画。 */
  description: string
  /** 自定义家的图标是虚线边(设计稿左栏的自定义组)。 */
  custom: boolean
}

/**
 * 一句**待翻译**的事实。projection 是纯函数,它不许自己翻译 ——
 * 翻译要订阅当下的语言,而订阅只有组件做得到(i18n/index.ts 顶部的第二条规矩)。
 * 所以判据这一层交出的是「说哪句话、带哪些数」,组件用 useT 把它变成字。
 */
export interface Fact {
  key: MessageKey
  vars?: MessageVars
}

/** 左栏一行。全部是**算好的事实**,组件不再推导。 */
export interface RailRow {
  familyId: string
  label: string
  /** 22px 方图标里那个 mono 首字母。 */
  initial: string
  /** 副行:若干条事实,组件用 ' · ' 串起来。空数组 = 没有可说的,那一行不画。 */
  facts: Fact[]
  tone: StatusTone
  group: RailGroup
  custom: boolean
}

/** 分段器上的一格:名字 + 一句现状读数(如「2 条」「未登录」)。 */
export interface ModeTab {
  providerId: string
  kind: ProviderModeKind
  label: Fact
  state: Fact
}

/** 能力五格。字面缩写在字典里,不在这里。 */
export type ModelCap = 'vision' | 'tools' | 'reasoning' | 'imageOut' | 'audioIn'

/** 顺序固定:视 工 推 出 音 —— 每一行的能力串都从同一条竖线起笔,列表才扫得动。 */
export const MODEL_CAPS: readonly ModelCap[] = [
  'vision',
  'tools',
  'reasoning',
  'imageOut',
  'audioIn',
]

/** 模型行。能力五格是**判据的结果**,不是原始字段。 */
export interface CatalogRow {
  id: string
  name: string
  /** 勾选 = 出现在聊天的模型选择器里(`settings.ai.providers[pid].selectedModels`)。 */
  selected: boolean
  /** 这一家的「当前模型」(`settings.ai.providers[pid].model`)。 */
  current: boolean
  /** 上下文窗口。null = 目录没填 = **不知道**,那一格留空,不写 0。 */
  contextLength: number | null
  /** 最大输出。null 同上;有覆盖时交的是**生效值**(与上一格同一条读法)。 */
  maxOutput: number | null
  caps: ModelCap[]
  /**
   * 单价(每百万 token 的 输入/输出)。null = 目录没给价 ——
   * 订阅坑由组件换成「订阅内」那句话,这一层不编。
   */
  price: { input: number; output: number } | null
  /**
   * 手填的:在 `selectedModels` 里、但**目录里没有**。判据与 Vue 壳的
   * `model-list-entry.ts:18`(isCustom)逐字相同 —— 手填不是另一份存储,
   * 它就是「勾了但目录不认识」这一个事实的名字。
   */
  manual: boolean
  /**
   * 用户覆盖(settings 那三张按模型的表:`contextLengthByModel[id]`、
   * `maxOutputByModel[id]` 与 `modelCapabilitiesByModel[id].tools`)。
   * **缺席 = 没覆盖**;行上按它画虚线下划与划掉的扳手。
   *
   * 它与上面几格的关系是「**谁说的**」而不是「值是多少」:`contextLength` /
   * `caps` 交出去的一律是**生效值**(覆盖优先,与引擎
   * `model-registry.ts:895/949` 同一条读法),这一格只回答「这个数是人填的吗」。
   * 两件事合成一格的话,屏幕就没法把「目录说 1M」和「我说 1M」画成两样。
   *
   * **判据只读 settings 这三张表**(单产地):后端交出来的目录条目
   * (`onethingCapabilityEntryToOpenRouterModel`)读的是注册表 entry,压根没有
   * 把覆盖折进 `supported_parameters` / `context_length` —— 就算哪天折了,
   * 从目录条目反推「有没有被覆盖」也是猜,不是事实。
   */
  override: ModelOverride
  /**
   * **目录自己说的那一份**(未经覆盖)。上面几格交的是生效值,覆盖一旦在场,
   * 目录原本给的数就再也读不回来了 —— 而屏幕上恰恰要说「自定 200k(目录 1.0M)」。
   *
   * `null` 一律读作**目录没填这一型**:手填行压根没有目录条目,而一条目录条目
   * 里没写 `context_length` 与「写了 0」在 `contextOf` 那把尺下同义。
   * `tools` 的 `null` 同理(手填行),`false` 是目录条目里**没列** `tools`
   * —— 那就是目录在说「不支持」,与今天这张表不画扳手是同一句话。
   */
  catalog: CatalogFacts
}

/** 目录对这一型说过的那三句。`null` = 没说过。 */
export interface CatalogFacts {
  contextLength: number | null
  /** 最大输出。目录条目里的 `top_provider.max_completion_tokens`。 */
  maxOutput: number | null
  tools: boolean | null
}

/** 目录什么都没说(手填行)。共享冻结对象,理由同 `NO_MODEL_OVERRIDE`。 */
export const NO_CATALOG_FACTS: CatalogFacts = Object.freeze({
  contextLength: null,
  maxOutput: null,
  tools: null,
})

/** 一个模型上的三格覆盖。三格都缺席 = 这一型没被动过。 */
export interface ModelOverride {
  /** 上下文窗口。正数才算数(0 / 负数 / 非数按「没覆盖」处理)。 */
  contextLength?: number
  /** 最大输出。同一把尺(正数才算数)。 */
  maxOutput?: number
  /** 工具调用。`false` 是**一句话**(「人说不支持」),不是「不知道」。 */
  tools?: boolean
}

/** 覆盖的写补丁。`null` = 删掉这一格;缺席 = 这一格不动。 */
export interface ModelOverridePatch {
  contextLength?: number | null
  maxOutput?: number | null
  tools?: boolean | null
}

/** 没覆盖。共享同一个冻结对象 —— 每行现造一个空对象会让行的引用每帧都变。 */
export const NO_MODEL_OVERRIDE: ModelOverride = Object.freeze({})

/**
 * 目录没填上下文窗口时,引擎实际按多少算。
 *
 * **来源是 `packages/onething-runtime/src/providers/model-registry.ts:914`**
 * (`getOnethingModelContextLength` 的最后一行 `|| 128000`)——壳上要把这个数
 * 说给用户听(占位符「128k(默认)」与提示行「不填按 128k 算,压缩阈值也按
 * 它算」),所以它在这里立一个有名字的常量,而不是在两处各写一遍字面量。
 * 后端改了那一格,这里跟着改一处。
 */
export const CATALOG_CONTEXT_FALLBACK = 128_000

/*
 * 这里**没有**「目录没填最大输出时的兜底数」这个常量(2026-09-09 删)。
 *
 * 它曾经是 `CATALOG_MAX_OUTPUT_FALLBACK = 4_096`,抄的是
 * `getOnethingModelMaxOutputTokens` 末尾那句 `|| 4096`。那句连同它的函数一起
 * 在同日被删掉:**输出上限不知道就是不知道**,引擎不再编一个数出来。所以壳上
 * 也不该有一个「默认 4,096」可以说 —— 说了就是把一个不存在的数画在屏幕上,
 * 而这正是那次事故的形状(用户把最大输出填成 10000,屏幕说默认 4,096,
 * 请求真被 `min(10000, 4096)` 夹成 4096)。
 *
 * 今天目录没填这一型时,屏幕只说一句(见 `ModelOverridePopover` 的
 * `maxOutputHint`):**请求里根本不带上限**、由服务商用它自己的默认值。
 * (09-09 晚:全局 `chat.maxTokens` 整格退役 —— 两个设置管一个值,只留按模型
 * 这一格 —— 所以这一档的第二句连同它的判据一起没了。)
 */

/**
 * 没有覆盖时,**今天这一发请求实际会要多长**。**只给目录有上限的那一档用** ——
 * 目录没填时无数可半,那一档根本不带 `max_tokens`,没有数可画。
 *
 * 引擎 `packages/core/engine/agent-loop-runtime.ts` 的
 * `resolveAgentLoopContextBudgetValues`:`perModelOverride ?? halfDefault`
 * (**只有这两个来源**)。注册上限在场时 `halfDefault = max(1, floor(注册上限 / 2))`,
 * 而 `maxOutputByModel[m]` 一旦填了就**直接当请求的 max_tokens**
 * (只再受模型物理上限夹一次)。
 * 壳只**复述**这条算术 —— 屏幕上要把「不填会发多少」说给用户听,不然
 * 「注册上限 16,384」这个数会被读成「一次能吐 16,384」,而实际只有 8,192。
 * 规则改了这里跟着改一处。
 */
export function requestedMaxOutputOf(registered: number): number {
  return Math.max(1, Math.floor(registered / 2))
}

/**
 * 一个厂牌组。OpenRouter 那种 300+ 行的目录不平铺 —— 按 id 的 `vendor/` 前缀
 * 折叠,默认收起,收起时**不渲染行**(收起还渲染就等于没折叠)。
 */
export interface CatalogGroup {
  /** `'anthropic/'` 这样的前缀;杂项组是 `OTHER_GROUP`。 */
  prefix: string
  rows: CatalogRow[]
  /** 杂项组里有几个厂牌 —— 「其他 · 125 型 · 45 个厂牌」的后半句。 */
  vendors: number
}

/** 杂项组的键。它不是一个真前缀,所以给它一个不可能与前缀撞的名字。 */
export const OTHER_GROUP = '\u0000other'

/** 折叠后的目录。`grouped: false` = 这份目录没到该折叠的量,平铺。 */
export interface GroupedCatalog {
  /** 已选的那些行。**始终置顶、始终展开**,不属于任何组。 */
  picked: CatalogRow[]
  groups: CatalogGroup[]
  grouped: boolean
  /** 被截掉多少行没画。0 = 没截。截了就得如实报,不能默默少画。 */
  truncated: number
}

/** 一家的凭证现状(批一只要「有没有」这个量级;多钥列表归批二)。 */
export interface CredentialFacts {
  /** 这一条口本身可不可得。false = 不知道,一律降级成「不知道」,不说「未配置」。 */
  known: boolean
  hasApiKey: boolean
  /** 尾号预览(后端给的,原文永远不出后端)。 */
  apiKeyPreview?: string
  hasOAuth: boolean
  oauthAccount?: string
  /** 条目数(多钥时 > 1)。 */
  entries: number
  /** 有任何一条在冷却里 = 这一家现在是坏的。 */
  cooling: boolean
}

export const UNKNOWN_CREDENTIALS: CredentialFacts = {
  known: false,
  hasApiKey: false,
  hasOAuth: false,
  entries: 0,
  cooling: false,
}
