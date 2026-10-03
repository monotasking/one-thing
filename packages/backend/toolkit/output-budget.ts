/**
 * §3 内核 —— `OutputBudget`:截断与落盘的**全部**规则,一处。
 *
 * 尺子①的一个具体后果:工具里不该出现"截断"这个词。今天每个会输出大块文本的
 * 工具各自写一套 head/tail 裁剪,阈值互不相同,溢出内容直接丢掉 —— 模型看到
 * "... (output truncated)"之后没有任何办法拿回剩下的。
 *
 * 这里:行/字节双阈值,超了就在文本尾部追加一段 `<truncation>` 说明;完整文本
 * 交给 `spill` 端口落盘,路径写进说明里,模型可以再去读。**内核不碰 fs** ——
 * 落盘是注入进来的一个函数,单测里它就是个数组。
 */

import type { Result, ResultPart } from './result.js'
import type { ToolSpec } from './spec.js'

export interface OutputBudgetLimits {
  readonly maxLines: number
  readonly maxBytes: number
}

/**
 * 默认阈值。工具可在 `spec.budget` 里放宽/收紧,绝大多数工具不必关心。
 *
 * R2a 决定⑦(设计文档 §11.1):这把尺子是**兜底**,不是同侪。
 *
 * R1 之前的默认行数是 2000 —— 恰好等于 read 与 bash **自己**的截断行数,于是内核
 * 这一刀正好切在工具刚加完尾注(`[Showing lines a-b of N. Use offset=… ]` /
 * `<bash_metadata>`)的位置上,把"怎么把剩下的拿回来"那句话剪掉了。R1 只能逐工具
 * 开天窗(`budget: { maxLines: 2000 + 48 }`),那是把内核的错误摊派给每个工具。
 *
 * 4000 行 = 现有最大工具级上限的 2 倍:对行为良好的(自己会截断的)工具永不触发,
 * 但仍然拦得住一个失控的工具。字节侧 256 KB 已是最大工具级上限(read 的 50 KB)的
 * 5 倍,不动。
 *
 * **工具自己的头/尾截断暂时保留**(§11.1 第 3 条):它们的尾注措辞是模型认的,
 * 现在删掉会立刻破坏零 diff。等全部工具移植完,截断才收归 `OutputBudget` 独占,
 * 默认值那时才真正从"兜底"变成"限制"。
 */
export const DEFAULT_OUTPUT_BUDGET: OutputBudgetLimits = { maxLines: 4000, maxBytes: 256 * 1024 }

export interface SpillRequest {
  readonly toolId?: string
  readonly callId?: string
  readonly reason: 'lines' | 'bytes'
  /** 完整原文。端口负责落盘并返回一个可读回来的位置。 */
  readonly text: string
}

export type SpillPort = (request: SpillRequest) => string | undefined | Promise<string | undefined>

export interface OutputBudgetOptions {
  readonly spill?: SpillPort
  readonly toolId?: string
  readonly callId?: string
}

const encoder = new TextEncoder()

export function byteLength(text: string): number {
  return encoder.encode(text).length
}

function sliceToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  let slice = text.slice(0, maxBytes)
  while (slice.length > 0 && byteLength(slice) > maxBytes) {
    const over = byteLength(slice) - maxBytes
    slice = slice.slice(0, Math.max(0, slice.length - Math.max(1, Math.ceil(over / 3))))
  }
  const lastCode = slice.charCodeAt(slice.length - 1)
  // 别把一个代理对切成半个字符。
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) slice = slice.slice(0, -1)
  return slice
}

interface TruncationOutcome {
  readonly text: string
  readonly reason?: 'lines' | 'bytes'
  readonly keptLines: number
  readonly totalLines: number
  readonly totalBytes: number
}

function truncate(text: string, limits: OutputBudgetLimits): TruncationOutcome {
  const lines = text.split('\n')
  const totalLines = lines.length
  const totalBytes = byteLength(text)

  let reason: 'lines' | 'bytes' | undefined
  let kept = text
  if (totalLines > limits.maxLines) {
    kept = lines.slice(0, limits.maxLines).join('\n')
    reason = 'lines'
  }
  if (byteLength(kept) > limits.maxBytes) {
    kept = sliceToBytes(kept, limits.maxBytes)
    reason = 'bytes'
  }

  return { text: kept, reason, keptLines: reason ? kept.split('\n').length : totalLines, totalLines, totalBytes }
}

function truncationNote(outcome: TruncationOutcome, spillPath?: string): string {
  const attrs = [
    `reason="${outcome.reason}"`,
    `kept-lines="${outcome.keptLines}"`,
    `total-lines="${outcome.totalLines}"`,
    `total-bytes="${outcome.totalBytes}"`,
    ...(spillPath ? [`spill="${spillPath}"`] : []),
  ].join(' ')
  const body = spillPath
    ? `Output was truncated. The full output was saved to ${spillPath} — read that file if you need the rest.`
    : 'Output was truncated and the remainder was discarded.'
  return `\n<truncation ${attrs}>${body}</truncation>`
}

export class OutputBudget {
  readonly limits: OutputBudgetLimits
  private readonly options: OutputBudgetOptions
  private truncatedFlag = false

  constructor(limits: Partial<OutputBudgetLimits> = {}, options: OutputBudgetOptions = {}) {
    this.limits = {
      maxLines: limits.maxLines ?? DEFAULT_OUTPUT_BUDGET.maxLines,
      maxBytes: limits.maxBytes ?? DEFAULT_OUTPUT_BUDGET.maxBytes,
    }
    this.options = options
  }

  static for(spec: ToolSpec, options: OutputBudgetOptions = {}): OutputBudget {
    return new OutputBudget(spec.budget ?? {}, { toolId: spec.id, ...options })
  }

  get truncated(): boolean {
    return this.truncatedFlag
  }

  /**
   * 对每个 text part 生效。异步是因为 spill 要落盘 —— §3 伪码把 `finalize` 写成
   * 同步,那份伪码没有考虑落盘端口;这里让 Runner 多一个 await,换来"溢出内容
   * 不丢"。
   */
  async finalize(result: Result): Promise<Result> {
    const content: ResultPart[] = []
    for (const part of result.content) {
      if (part.type !== 'text' || typeof part.text !== 'string') {
        content.push(part)
        continue
      }
      const outcome = truncate(part.text, this.limits)
      if (!outcome.reason) {
        content.push(part)
        continue
      }
      this.truncatedFlag = true
      const spillPath = await this.spill(outcome.reason, part.text)
      content.push({ ...part, text: outcome.text + truncationNote(outcome, spillPath) })
    }
    return { ...result, content }
  }

  private async spill(reason: 'lines' | 'bytes', text: string): Promise<string | undefined> {
    if (!this.options.spill) return undefined
    try {
      return (await this.options.spill({ reason, text, toolId: this.options.toolId, callId: this.options.callId })) ?? undefined
    } catch {
      // 落盘失败不该把一次成功的调用变成失败 —— 说明里就不提溢出文件而已。
      return undefined
    }
  }
}
