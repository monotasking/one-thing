/**
 * 型号家族文件共用的几个类型(纯类型模块,`docs/design/architecture-direction-2026-10.md` §4 P2)。
 */
/** 「id 里含这几个片段之一 ⇒ 上下文长度是这个数」的一行(先到先得,汇总次序见 `index.ts`)。 */
export interface OnethingModelContextLengthHint {
  readonly includes: readonly string[]
  readonly contextLength: number
}
