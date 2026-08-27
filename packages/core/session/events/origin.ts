/**
 * **账本的产地印章**(§17.7 #2+#1,2026-08-28)。
 *
 * `sessions:verify` 从前把"这本账是谁写的"当成一个不存在的问题:一条外部进程
 * (跑错 store 的测试、拷进来的夹具)留下的账本,与引擎真的写坏了一段历史,
 * 在报告里**同色**。判据只能靠会话 id 名单静音 —— 名单要维护,新夹具再漏再加。
 *
 * 方案 B 把判据从**名单**换成**事实**:`session/created` 是每本账的第一条事件,
 * 让它带上"写这条的时候,这个进程认为自己的 store 在哪儿"的指纹。verify 读第一条
 * 事件就知道账本主人。
 *
 * ## 形状与它为什么是这个形状
 *
 * - **指纹,不是路径**。账本会被拷来拷去、会被贴进 issue,写进绝对路径等于把
 *   用户的家目录名字散出去。这里存的是路径的 64 位指纹(24 位十六进制里取 12 位)。
 * - **不是密码学哈希**。它要回答的问题只有一个:"和本机这个 store 是同一个吗"。
 *   FNV-1a 双轮足够,而且**零依赖** —— core 是零依赖层,为一个身份标签把 `node:crypto`
 *   拖进来不划算。文档口径也因此写清楚:它是**指纹不是秘密**。
 * - **`host` 只在能零成本知道时才带**。今天唯一零接线可知的一格是"这是不是
 *   vitest 进程"(`process.env.VITEST`)—— 而那正是夹具沉积最大的来源。其余宿主
 *   (desktop / server / daemon)要认出来得新开一个 `configure*Host` 口,那是另一次
 *   接线;store 指纹本身已经足以回答 verify 要问的那个问题(**跑错 store 的进程
 *   写下的账本,指纹与本机对不上**),所以不为它加接线。
 *
 * ## 成对交付(纪律 9)
 *
 * append-only 的可选格。**老账本没有这一格 → 归"无印章存量账",不猜**:
 * 它可能是本机正常产物(印章之前写的),也可能是外来的,而账本自己说不出来。
 */

/** 一条事件账本的产地印章。 */
export interface SessionOriginStamp {
  /** 写这条事件时进程认为自己的 store 在哪儿(路径指纹,见文件头)。 */
  store: string
  /** 零接线可知的宿主标记;今天只有 `'test'`(vitest 进程)。 */
  host?: 'test'
}

/**
 * 路径 → 12 位十六进制指纹(FNV-1a,双轮不同偏移拼接)。
 *
 * 纯函数、零依赖、跨进程稳定 —— 写侧与 `sessions:verify` 必须算出同一个数,
 * 所以它不许依赖任何运行期状态。
 */
export function sessionOriginFingerprint(storePath: string): string {
  const round = (seed: number): number => {
    let hash = seed
    for (let index = 0; index < storePath.length; index++) {
      hash ^= storePath.charCodeAt(index)
      // FNV-1a 的 32 位质数乘法,用移位写以避开浮点精度。
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
    }
    return hash >>> 0
  }
  const low = round(0x811c9dc5)
  const high = round(0x01000193)
  return `${low.toString(16).padStart(8, '0')}${high.toString(16).padStart(8, '0')}`.slice(0, 12)
}

/** 这本账是谁写的 —— `sessions:verify` 的分栏判据。 */
export type SessionOriginVerdict =
  /** 印章与本机这个 store 对得上 = 本机正常产物,全规则照旧。 */
  | 'local'
  /** 印章在,但指向别的 store = 跑错 store 的进程 / 拷进来的夹具。 */
  | 'foreign'
  /** 没有印章 = 印章之前写的存量账,**不猜**它是谁的。 */
  | 'unstamped'

/**
 * 判定一本账的产地。
 *
 * `stamp` 取的是这本账**第一条** `session/created` 上那一格(没有就是 `undefined`)。
 */
export function classifySessionOrigin(
  stamp: SessionOriginStamp | undefined,
  localFingerprint: string,
): SessionOriginVerdict {
  if (!stamp || typeof stamp.store !== 'string' || stamp.store.length === 0) return 'unstamped'
  return stamp.store === localFingerprint ? 'local' : 'foreign'
}
