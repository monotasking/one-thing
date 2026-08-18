/**
 * §3 内核 —— `Result`:一次成功调用的产物。
 *
 * 形状与 `core/tools/tool-result.ts` 的 `CanonicalToolResult` **逐字相同**,这是
 * 故意的:R2 的 IpcProjector 因此是恒等映射,渲染器一行不用改(§9)。
 *
 * 这里没有 `title` / `metadata` —— 那些是过程中的观察,属于 `ToolEvent.annotate`,
 * 不属于结果。把它们塞进 Result 正是今天渲染私货渗进协议的那条路。
 */

import type { JsonObject } from '../json.js'

export interface ResultPart {
  type: 'text' | 'image' | 'file'
  text?: string
  /** base64 载荷(image)。 */
  data?: string
  mimeType?: string
  path?: string
}

export interface Result<Details = JsonObject | undefined> {
  content: ResultPart[]
  /** 渲染器/审计用的结构化载荷。对内核不透明。 */
  details?: Details
  /** 工具要求本回合就此收束(ask_user 这类)。 */
  terminate?: boolean
}

export function textResult(text: string, details?: JsonObject): Result {
  return { content: [{ type: 'text', text }], details }
}

export function emptyResult(): Result {
  return { content: [] }
}

/** 投影成给模型看的纯文本。非文本 part 只留一行占位,和 canonical 版一致。 */
export function resultToText(result: Result): string {
  return result.content
    .map(part => {
      if (part.type === 'text') return part.text ?? ''
      if (part.type === 'file') return part.path ? `[File: ${part.path}]` : ''
      if (part.type === 'image') return part.path ? `[Image: ${part.path}]` : '[Image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}
