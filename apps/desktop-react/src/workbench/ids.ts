/**
 * 叶 id / split id 的产地。
 *
 * ── 为什么不用 `crypto.randomUUID()` ──────────────────────────────────────
 * 这些 id **要落盘**(树按 Workspace 记),而 vitest 的 jsdom 环境里 `crypto` 那一口
 * 时有时无;更要紧的是**可读**:真机排障时 `leaf-7` 比一串 36 位的十六进制好用得多。
 * 单调计数器加上一段启动戳就够了 —— 这些 id 只需要在**一台机器的一份档案里**不撞,
 * 不需要全球唯一(它们不跨机器同步)。
 *
 * 启动戳那一段是为了**跨启动不撞**:上一次跑到 `leaf-7`,这一次从 0 重新数,
 * 存量档案里的 `leaf-3` 就会和新造的 `leaf-3` 撞成同一片叶(`findLeaf` 按 id 找)。
 */
let seq = 0
const boot = Date.now().toString(36).slice(-5)

export function nextLeafId(): string {
  seq += 1
  return `leaf-${boot}-${seq}`
}

export function nextSplitId(): string {
  seq += 1
  return `split-${boot}-${seq}`
}
