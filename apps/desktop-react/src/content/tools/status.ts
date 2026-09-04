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

/**
 * `warn` 不是一档状态,是一层**活性**覆盖(§6.6):这一步的状态仍然是
 * `executing` / `input-streaming`,只是已经很久没收到数据了。它由 `stallLevel`
 * 在渲染那一层叠上来,`toolTone` 永远不会返回它 —— 那张表读的是状态,
 * 而「多久没说话」不在状态里。
 */
export type ToolTone = 'ok' | 'bad' | 'busy' | 'warn' | 'unknown'

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

/**
 * 能拉开抽屉的四档。
 *
 * 三档是**收场了的**:结局已经定下来,`detail` 算得出一份完整的东西。
 * 第四档 `executing` 是 C2-a 加的(拍点 ⑩ 已拍):正在跑的那一步也允许展开 ——
 * 抽屉里是**正在长的输出**,不是半成品的结局。人想看的正是「它现在在干什么」,
 * 而在 §6.2 之前那扇门是关着的,于是执行中这一段除了「执行中」三个字什么都没有。
 *
 * `input-streaming` 仍然不在表里:参数还没定稿,抽屉里连一份参数都摆不出来
 * (行上那截半截 JSON 已经是此刻全部的事实)。
 */
export const EXPANDABLE_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'executing',
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

/**
 * 耗时 —— **委托给读数的唯一产地**(§5.7,`src/format/quantity.ts`)。
 *
 * 从前它自己有一套:一秒以下写毫秒(`339ms`)、一秒以上一位小数(`1.2s`),
 * 两种单位在同一张卡上换来换去,而「339ms → 1.2s」这类换位还会推邻格。
 * 现在只到 0.1s、永不写毫秒,`chat.tool.durationMs` / `durationS` 两个字典键
 * 随之退役 —— 一个数的写法不该是每种语言各说各的(它本来就没有译文)。
 *
 * 名字留在这里是给既有调用方的:它们要的一直是「工具卡上的耗时怎么写」,
 * 而那个问题今天的答案就是那个产地。**不许在这里再写一份进位**。
 */
export { formatDuration } from '../../format/quantity'
