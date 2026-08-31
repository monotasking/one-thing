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
  /** 最大输出。null 同上。 */
  maxOutput: number | null
  caps: ModelCap[]
  /**
   * 单价(每百万 token 的 输入/输出)。null = 目录没给价 ——
   * 订阅坑由组件换成「订阅内」那句话,这一层不编。
   */
  price: { input: number; output: number } | null
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
