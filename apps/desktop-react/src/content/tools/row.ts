import { formatBytes } from '../../format/quantity'
import type { ProjectedToolCall, ToolRowModel } from '../model/segments'
import { parsePartialJson, partialString, type PartialJson } from './partial-json'
import { toolResultReference } from './result'

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
    // 正文还没取的那一格,右端说的是**它有多大**(工单 5 ②)。摆在这里而不是
    // 每个 presenter 里:引用是**页这一层**的形状,与「这是哪个工具」无关 ——
    // 逐个 presenter 加一句就是按能力枚举,而且第七个一定会忘。排在失败原因与
    // presenter 补丁**之前**,所以谁说得出更具体的话谁盖掉它。
    ...(deferredOutcome(call) ?? {}),
    // 失败时右端默认摆**后端说的那句原话**。presenter 可以覆盖,但覆盖不掉的是
    // 「失败必须说出理由」这条:成功的行没有话说可以空着,失败的不行。
    ...(failureOutcome(call) ?? {}),
    ...patch,
  }
}

/**
 * 「结果 N KB,展开时取」—— 页里那一格还是引用时右端那句话(工单 5 ②)。
 *
 * 字节数走 `formatBytes`(与文件面板、查看器同一只)—— 全壳只许有一个把字节念成
 * 人话的地方,第二个迟早在 1024 那一格上分叉。
 */
function deferredOutcome(call: ProjectedToolCall): Pick<ToolRowModel, 'outcome'> | undefined {
  const ref = toolResultReference(call)
  return ref ? { outcome: { key: 'chat.tool.resultDeferred', vars: { size: formatBytes(ref.bytes) } } } : undefined
}

/**
 * 失败原因:后端原话的第一行,长了截断 —— 全文在抽屉里,行上只放一句。
 *
 * ── 抬头那一行要带上下文(09-01 自查:「Invalid read parameters:」冒号收尾没下文)──
 * 后端那几个内建工具的 `formatError` 都是**两段式**:第一行是抬头(以冒号收尾),
 * 逐条理由在第二行往后(`Invalid read parameters:\n- path: Required\n\nUsage: …`)。
 * 只取第一行,屏幕上就永远是一个冒号顶着一片空白 —— 一句半截话比不说更费人。
 *
 * 所以判据是**这一行说完了没有**:以冒号收尾 = 它是抬头,把第一条理由并上来(理由
 * 前那个 `- ` 是列表记号,并进一句话里就该去掉);后面**真的没有下文**时,连那个
 * 冒号一起去掉 —— 不留一个指向空处的标点。
 *
 * 中英两种冒号都认:后端的原话是英文的,而插件与 MCP 工具的报错常常是中文的。
 */
function failureOutcome(call: ProjectedToolCall): Pick<ToolRowModel, 'outcome'> | undefined {
  const reason = call.error ?? call.rejectionReason
  if (!reason) return undefined
  const lines = reason.split('\n').map((piece) => piece.trim()).filter(Boolean)
  if (lines.length === 0) return undefined
  let line = lines[0]
  if (/[:：]$/.test(line)) {
    const detail = lines[1]?.replace(/^[-*•]\s*/, '')
    line = detail ? `${line} ${detail}` : line.replace(/[:：]$/, '')
  }
  return { outcome: { text: truncate(line, 72) } }
}

/** 一行放得下的长度。截断加省略号 —— 被截过这件事本身要看得出来。 */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * 参数流那半截 JSON,解析过一遍(§6.2)。
 *
 * 每个 presenter 的 `partial()` 都从这一格取字,所以「半截参数从哪来」只有这一个
 * 产地 —— 哪天流的形状换了(比如带上偏移),改这一处。
 */
export function partialToolArgs(call: ProjectedToolCall): PartialJson {
  return parsePartialJson((call as { streamingArgs?: string }).streamingArgs ?? '')
}

/** `partialToolArgs` + 取一格字符串:presenter 里最常见的那一步,省得各写一遍。 */
export function partialArgString(call: ProjectedToolCall, ...keys: string[]): string | undefined {
  return partialString(partialToolArgs(call), ...keys)
}
