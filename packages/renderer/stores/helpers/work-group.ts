/**
 * Work group 的合成(2026-08-19)。
 *
 * 一次 assistant 回合在**最后一轮工具**处一刀两断:
 *   · WORK GROUP —— 顶部思考、行间思考、每一轮工具调用,以及它们之间的过渡
 *     叙述,统统收进一个 "Working · 12s" / "Worked · 41s" 头(ProcessRail);
 *   · TAIL —— 最后一轮工具之后的那段回答,全音量呈现,组一折叠它就是页面上
 *     唯一剩下的东西。
 *
 * 这里是纯函数:进去的是「已排好序的 part 条目 + 两个查 step 的回调」,出来的是
 * 「哪条 entry 渲染哪些 step 行 / 统计 / 分界」。MessageBubble 只剩一个 computed
 * 包装。抽出来是为了能直接测这套判定,而不必挂载整个气泡。
 */
import type { ContentPart, Step } from '@/types'
import { stepFromToolCall } from './tool-step-view'

/** 一条待渲染的 part 及其渲染 key(key 由调用方按锚点位置生成)。 */
export interface WorkPartEntry {
  part: ContentPart
  key: string
}

export interface WorkStats {
  reasoningCount: number
  toolCount: number
  failedCount: number
  toolCounts: Map<string, number>
  /** Latest tool end timestamp seen (ms epoch), for the settled duration. */
  lastToolEnd: number
}

export interface BuildWorkRenderInput {
  /** 已过滤、已排序、已配好 key 的 part 条目。 */
  entries: readonly WorkPartEntry[]
  role: 'user' | 'assistant'
  /** 消息自带顶部思考(`message.reasoning`),计一步「思考」。 */
  hasThinking?: boolean
  /** 按 toolCallId 找真实 step;没有就是「引擎还没发出来」。 */
  findStep: (toolCallId: string) => Step | undefined
  /** 某一轮的全部 step(`turnIndex` 为 undefined 时给全部)。 */
  stepsForTurn: (turnIndex: number | undefined) => Step[]
}

export interface WorkRender {
  /** entry key → 该 entry 负责渲染的 step 行。 */
  stepsByEntry: Map<string, Step[]>
  stats: WorkStats
  hasWorkGroup: boolean
  workEntries: WorkPartEntry[]
  tailEntries: WorkPartEntry[]
}

/**
 * The single place that decides WHICH entry renders WHICH tool rows.
 *
 * A tool call is delivered twice: first as a `tool-call` part (streaming
 * input, no real step yet), then as a `data-steps` placeholder once the engine
 * emits the step. Rendering both parts independently made the row "move house"
 * mid-flight — two StepsPanels, two NestedCollapseGroups, so the row remounted
 * exactly when it became interesting. Here the `tool-call` part keeps
 * ownership of every call it introduced (rendering the real step as soon as
 * one exists, a synthesized one before that) and the `data-steps` part renders
 * only what the tool-call parts did not already claim — historical messages,
 * where no tool-call part was ever built, therefore still render normally.
 *
 * Synthesized steps inherit the turnIndex of whichever sibling already has a
 * real step (falling back to a per-part negative pseudo-turn) so that a
 * parallel batch stays ONE StepsPanel group from the first frame to the last;
 * mixing `undefined` with a real turnIndex would split and re-merge the batch
 * mid-stream and remount its rows.
 */
export function buildWorkRender(input: BuildWorkRenderInput): WorkRender {
  const { entries, role, findStep, stepsForTurn } = input
  const claimed = new Set<string>()
  let pseudoTurn = -1
  const stepsByEntry = new Map<string, Step[]>()
  const stats: WorkStats = {
    reasoningCount: input.hasThinking ? 1 : 0,
    toolCount: 0,
    failedCount: 0,
    toolCounts: new Map<string, number>(),
    lastToolEnd: 0,
  }

  const countStep = (step: Step) => {
    const name = step.toolCall?.toolName || step.title || 'tool'
    stats.toolCount++
    stats.toolCounts.set(name, (stats.toolCounts.get(name) ?? 0) + 1)
    if (step.status === 'failed') stats.failedCount++
    const call = step.toolCall
    const end = call?.endTime
      ?? (call?.startTime !== undefined && call?.durationMs !== undefined ? call.startTime + call.durationMs : undefined)
      ?? (call?.durationMs !== undefined ? call.timestamp + call.durationMs : undefined)
    if (end !== undefined && end > stats.lastToolEnd) stats.lastToolEnd = end
  }

  // Index of the last entry that belongs to the process (thought or tool
  // round). Everything up to it is the work group; `waiting` renders nothing
  // and never moves the boundary.
  let lastProcessIndex = -1
  entries.forEach(({ part, key }, index) => {
    if (part.type === 'reasoning') {
      stats.reasoningCount++
      lastProcessIndex = index
      return
    }
    let rows: Step[] = []
    if (part.type === 'tool-call') {
      pseudoTurn -= 1
      const batchTurn = part.toolCalls
        .map(tc => findStep(tc.id)?.turnIndex)
        .find(turnIndex => turnIndex !== undefined) ?? pseudoTurn
      rows = part.toolCalls
        .filter(toolCall => !claimed.has(toolCall.id))
        .map((toolCall) => {
          claimed.add(toolCall.id)
          const real = findStep(toolCall.id)
          if (real) return real
          return { ...stepFromToolCall(toolCall), turnIndex: batchTurn }
        })
    } else if (part.type === 'data-steps') {
      rows = stepsForTurn(part.turnIndex).filter(step => !step.toolCallId || !claimed.has(step.toolCallId))
      for (const step of rows) {
        if (step.toolCallId) claimed.add(step.toolCallId)
      }
    } else {
      return
    }
    if (rows.length > 0) {
      stepsByEntry.set(key, rows)
      rows.forEach(countStep)
      lastProcessIndex = index
    }
  })

  // A work group exists only once the turn has called a tool. Thoughts alone
  // keep their own rows (top thought / inline thought), no header around them.
  const hasWorkGroup = role === 'assistant' && stats.toolCount > 0
  return {
    stepsByEntry,
    stats,
    hasWorkGroup,
    workEntries: hasWorkGroup ? entries.slice(0, lastProcessIndex + 1) : [],
    tailEntries: hasWorkGroup ? entries.slice(lastProcessIndex + 1) : [...entries],
  }
}

/** Header detail: what the work consisted of. "思考 3 步 · bash ×5 · read". */
export function buildWorkSummary(stats: WorkStats): string {
  const bits: string[] = []
  if (stats.reasoningCount > 0) bits.push(`思考 ${stats.reasoningCount} 步`)
  const toolBits = [...stats.toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
  if (toolBits.length > 4) {
    const extra = toolBits.length - 4
    toolBits.length = 4
    toolBits.push(`+${extra}`)
  }
  bits.push(...toolBits)
  return bits.join(' · ')
}
