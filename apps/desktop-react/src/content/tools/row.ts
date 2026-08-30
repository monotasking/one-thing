import type { ProjectedToolCall, ToolRowModel } from '../model/segments'

/**
 * 每个 presenter 都要的那几格,算一次。
 *
 * 耗时、失败原因、身份这三件与**工具是哪一个无关** —— 它们是「一次调用」这个概念
 * 自带的事实。让每个 presenter 各抄一遍的话,第七个 presenter 一定会忘记一格,
 * 而那一格的缺席在屏幕上看不出是 bug(只是「这行没有耗时」)。
 *
 * 用法是 `baseToolRow(call, { name, summary, outcome })` —— 后给的盖前面的,
 * 所以 presenter 想改哪一格就改哪一格,不想管的自然继承。
 */
export function baseToolRow(
  call: ProjectedToolCall,
  patch: Partial<ToolRowModel> = {},
): ToolRowModel {
  return {
    callId: call.id,
    icon: 'Wrench',
    // 拿不到 toolName 就用 toolId —— 那是事实,编一个名字是猜。
    name: call.toolName || call.toolId,
    status: call.status,
    ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
    // 失败时右端默认摆**后端说的那句原话**。presenter 可以覆盖,但覆盖不掉的是
    // 「失败必须说出理由」这条:成功的行没有话说可以空着,失败的不行。
    ...(failureOutcome(call) ?? {}),
    ...patch,
  }
}

/** 失败原因:后端原话的第一行,长了截断 —— 全文在抽屉里,行上只放一句。 */
function failureOutcome(call: ProjectedToolCall): Pick<ToolRowModel, 'outcome'> | undefined {
  const reason = call.error ?? call.rejectionReason
  if (!reason) return undefined
  const line = reason.split('\n').find((piece) => piece.trim()) ?? reason
  return { outcome: { text: truncate(line.trim(), 72) } }
}

/** 一行放得下的长度。截断加省略号 —— 被截过这件事本身要看得出来。 */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
