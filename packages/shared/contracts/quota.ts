/**
 * 服务商配额与余额 —— 批 5(`docs/design/provider-settings-rework-2026-09.md` §8.1)。
 *
 * **纯类型**:产品层(配额源、方言的被动源)、装配层(`QuotaService`、RPC、全局事件)与
 * 壳(composer 读数卡、设置页)三方共读这一份形状。住在 `@shared/contracts` 是因为
 * 三方都够得着它、又不反向依赖谁(与 `contracts/acp.ts` 同一条理由)。
 *
 * 一条纪律:**拿不到的数是缺席,不是 0**。窗口没给重置时刻就没有 `resetsAt`;
 * 服务商根本没有配额接口就是 `unsupported`,不是一张全是 0 的表。
 */

/**
 * 币种。`USD` / `CNY` 是钱;`credits` 是 ChatGPT 订阅里那种「点数」—— 它能买,
 * 但不是任何一国的钱,画成「$12.50」就是在编一个汇率。
 */
export type ProviderQuotaCurrency = 'USD' | 'CNY' | 'credits'

/**
 * 一个限额窗口。**按时长归类**,不按接口里的 primary/secondary 位置(Codex 各套餐
 * 两窗顺序不同):`id` 是归类后的键 —— 主窗口是 `5h` / `7d` / `{n}d`;带 `label` 的
 * 附加窗口(Claude 的「Sonnet 本周」、Codex 的按功能计的附加限额)是
 * `<labelKey>:<归类键>`,保证一张表里不重名。
 */
export interface ProviderQuotaWindow {
  id: string
  /** 窗口长度(秒)。归类与显示都从它算。 */
  seconds: number
  /** 已用百分比,0–100(可能略超 100:服务商允许透支一点)。 */
  usedPercent: number
  /** 重置时刻(epoch ms)。服务商没给就缺席。 */
  resetsAt?: number
  /** 附加窗口的名字(型号族 / 功能名)。主窗口没有这一格。 */
  label?: string
}

export interface ProviderQuotaBalance {
  currency: ProviderQuotaCurrency
  available: number
  /** 充值 / 赠送的总额(有的家报)。 */
  granted?: number
}

export type ProviderQuota =
  | ({ kind: 'balance'; fetchedAt: number } & ProviderQuotaBalance)
  | {
      kind: 'windows'
      windows: ProviderQuotaWindow[]
      plan?: string
      /**
       * 同一份响应里还带着余额(Codex 的 credits)。§8.4 表「有余额也有窗口」那一行:
       * 两种都出。§8.1 的原形状只有窗口一支,这一格是为那一行加的。
       */
      balance?: ProviderQuotaBalance
      fetchedAt: number
    }
  | { kind: 'unsupported' }
  | {
      kind: 'error'
      /**
       * `rate-limited` 是**静默**的一种失败(拍点 5):Claude 那条非公开接口动不动 429,
       * 卡片上不为它出「获取失败」那一行,后端 10 分钟内也不再问。
       */
      reason: 'auth' | 'network' | 'rate-limited' | 'unknown'
      message: string
      fetchedAt: number
    }

export type ProviderQuotaErrorReason = Extract<ProviderQuota, { kind: 'error' }>['reason']

/** `provider:quota` 全局事件的载荷(除 `type` 之外)。**没有令牌、没有密钥**。 */
export interface ProviderQuotaPushPayload {
  providerId: string
  /** 这份配额属于池里哪一条凭证。env 兜底 / 无池时缺席。 */
  credentialId?: string
  quota: ProviderQuota
}
