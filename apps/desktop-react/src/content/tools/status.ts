import type { MessageKey, TFn } from '../../i18n'

/**
 * 工具状态的**读法**(§5.2 那张表),从 `ToolRow.tsx` 抬出来单独成文件。
 *
 * ── 为什么抬出来 ────────────────────────────────────────────────────────
 * P4 的检索段要在**纯模型层**回答同一个问题(「这段检索还在跑吗」),而模型层不许
 * import React。留在 ToolRow.tsx 里的话,纯模型只能自己再抄一张 busy 表 —— 那就是
 * 第二个产地:后端哪天加一档新的运行中状态,两张表里改一张、忘一张,屏幕上就会
 * 出现「工具行在转圈、检索段却说做完了」。
 *
 * 抬出来之后 ToolRow 原样再导出这几个名字(它的对外形状一个字没变),所以这不是
 * 一次接口改动,只是把表挪到了两个消费者都够得着的地方。
 *
 * 三张表**仍然各是各的**:tone 回答「画什么色」,可展开回答「能不能拉开抽屉」,
 * 字典键回答「说哪句话」。今天答案一一对应不代表它们是同一个问题(与 present.ts 的
 * `FAILED_STATUSES` 同一条理由)。
 */

export type ToolTone = 'ok' | 'bad' | 'busy' | 'unknown'

/**
 * **后端八态 → 图标三态**。认不出的枚举落 `unknown` —— 不猜是哪一态。
 */
const TOOL_TONES: Record<string, ToolTone> = {
  pending: 'busy',
  queued: 'busy',
  received: 'busy',
  executing: 'busy',
  'input-streaming': 'busy',
  completed: 'ok',
  failed: 'bad',
  cancelled: 'bad',
}

export function toolTone(status: string): ToolTone {
  return TOOL_TONES[status] ?? 'unknown'
}

/** 能拉开抽屉的三档:结局已经定下来了,detail 才算得出一份完整的东西。 */
export const EXPANDABLE_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
])

/**
 * 工具状态:**后端枚举 → 字典键**的一张明表。
 *
 * 不用 `` `chat.tool.${status}` as MessageKey `` 拼键 —— 那个断言会骗过类型检查,
 * 后端哪天加一档新状态就在运行时炸(`format` 拿到 undefined)。列成表之后,
 * 认不出来的状态**原样显示那个英文枚举**:那是事实,而编一句中文是猜。
 */
const TOOL_STATUS_KEYS: Record<string, MessageKey> = {
  pending: 'chat.tool.pending',
  queued: 'chat.tool.queued',
  received: 'chat.tool.received',
  executing: 'chat.tool.executing',
  completed: 'chat.tool.completed',
  failed: 'chat.tool.failed',
  cancelled: 'chat.tool.cancelled',
  'input-streaming': 'chat.tool.inputStreaming',
}

export function toolStatusLabel(t: TFn, status: string): string {
  const key = TOOL_STATUS_KEYS[status]
  return key ? t(key) : status
}

/** 耗时:秒以上按秒说,秒以下按毫秒说 —— 「1234ms」没人读得快。 */
export function formatDuration(t: TFn, ms: number): string {
  if (ms >= 1000) return t('chat.tool.durationS', { n: (ms / 1000).toFixed(1) })
  return t('chat.tool.durationMs', { n: Math.round(ms) })
}
