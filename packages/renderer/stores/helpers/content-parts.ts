/**
 * Pure helpers for evolving a message's `contentParts` array as stream
 * chunks arrive. Each helper mutates the `parts` array in place; the caller is
 * responsible for re-assigning `message.contentParts = [...parts]` (or
 * equivalent) to trigger Vue reactivity downstream.
 *
 * 末尾另有**加载路径**那一份(`rebuildLoadedContentParts`):它不是流式的,
 * 一次性把一条历史消息重建成 parts,与上面的增量函数互不调用。
 */

import type { ContentPart, Step, ToolCall } from '@/types'
import { isPlaceholderTransientPart, isTransientPart } from '@shared/ipc/chat'
import { synthesizeCoreToolAnchors } from '@onething/core/session/render-anchors'
import { mergeToolCall } from './tool-calls'

type TurnTextPart = Extract<ContentPart, { type: 'text' | 'reasoning' }>

// 判据直接用 shared 契约那一份 —— 这里曾经是一份**手抄镜像**,而 shared 那份
// 当时零消费者,于是"两份必须同改"的守卫其实是在给死代码对账。现在只有一份。

/** Pop the trailing placeholder indicator (waiting / image-loading) if any. */
export function popTrailingTransient(parts: ContentPart[]): void {
  const last = parts[parts.length - 1]
  // **只弹占位型**。流内型(plugin-status)要活到流结束:插件还在干活时,
  // 模型吐一个 token 不该把它的状态抹掉。
  if (last && isPlaceholderTransientPart(last)) {
    parts.pop()
  }
}

/** Remove every transient indicator when a stream ends or is aborted. */
export function removeTransientIndicators(parts: ContentPart[]): boolean {
  const originalLength = parts.length
  for (let i = parts.length - 1; i >= 0; i--) {
    if (isTransientPart(parts[i])) {
      parts.splice(i, 1)
    }
  }
  return parts.length !== originalLength
}

function isTurnTextPart(part: ContentPart): part is TurnTextPart {
  return part.type === 'text' || part.type === 'reasoning'
}

function sameTurn(a: { turnIndex?: number }, b: { turnIndex?: number }): boolean {
  return a.turnIndex === b.turnIndex
}

function appendOrMergeTurnTextPart(parts: ContentPart[], part: TurnTextPart): void {
  popTrailingTransient(parts)

  const last = parts[parts.length - 1]
  if (last && last.type === part.type && sameTurn(last, part)) {
    parts[parts.length - 1] = {
      ...last,
      content: last.content + part.content,
    }
  } else {
    parts.push(part)
  }
}

/** Append text, merging into the trailing text part if one exists. */
export function appendOrMergeText(parts: ContentPart[], content: string, turnIndex?: number): void {
  appendOrMergeTurnTextPart(parts, {
    type: 'text',
    content,
    ...(turnIndex !== undefined ? { turnIndex } : {}),
  })
}

/** Append reasoning, merging into the trailing reasoning part if one exists. */
export function appendOrMergeReasoning(parts: ContentPart[], content: string, turnIndex?: number): void {
  appendOrMergeTurnTextPart(parts, {
    type: 'reasoning',
    content,
    ...(turnIndex !== undefined ? { turnIndex } : {}),
  })
}

/** Append a finalized reasoning part only if the same block is not already present. */
export function appendReasoningIfMissing(parts: ContentPart[], content: string): boolean {
  if (!content) return false
  if (parts.some(part => part.type === 'reasoning' && part.content === content)) {
    popTrailingTransient(parts)
    return false
  }
  appendOrMergeReasoning(parts, content)
  return true
}

/**
 * Upsert a tool call into an existing tool-call part, or start a new one.
 * On id collision, fields are merged in place — preserving the array slot
 * identity that may be shared with `step.toolCall` references.
 *
 * A later data-steps part may already be trailing when the finalized
 * `tool_call` chunk arrives, so search the full parts list before appending.
 */
export function upsertToolCall(parts: ContentPart[], toolCall: ToolCall): void {
  popTrailingTransient(parts)
  for (const part of parts) {
    if (part.type !== 'tool-call') continue
    const idx = part.toolCalls.findIndex(tc => tc.id === toolCall.id)
    if (idx >= 0) {
      mergeToolCall(part.toolCalls[idx], toolCall)
      return
    }
  }

  const last = parts[parts.length - 1]
  if (last && last.type === 'tool-call') {
    last.toolCalls.push(toolCall)
  } else {
    parts.push({ type: 'tool-call', toolCalls: [toolCall] })
  }
}

/**
 * Add a tool call placeholder (for `tool_input_start`). When merging into an
 * existing tool-call part, replaces the part object with a clone so deep
 * reactivity sees the array identity change — this matters for the streaming
 * input flow where multiple tool calls accumulate before any of them complete.
 */
export function appendToolCallPlaceholder(parts: ContentPart[], toolCall: ToolCall): void {
  popTrailingTransient(parts)
  if (parts.some(part =>
    part.type === 'tool-call' && part.toolCalls.some(tc => tc.id === toolCall.id)
  )) {
    return
  }

  const last = parts[parts.length - 1]
  if (last && last.type === 'tool-call') {
    parts[parts.length - 1] = {
      ...last,
      toolCalls: [...last.toolCalls, toolCall],
    }
  } else {
    parts.push({ type: 'tool-call', toolCalls: [toolCall] })
  }
}

/**
 * Insert a data-steps placeholder for a given turn if absent.
 * Returns true if a new placeholder was added.
 */
export function pushDataStepsIfMissing(parts: ContentPart[], turnIndex: number): boolean {
  if (parts.some(p => p.type === 'data-steps' && p.turnIndex === turnIndex)) {
    return false
  }
  popTrailingTransient(parts)
  parts.push({ type: 'data-steps', turnIndex })
  return true
}

/** Push a waiting indicator (signals AI continuation after a tool call). */
export function pushWaiting(parts: ContentPart[], turnIndex?: number): void {
  if (parts.some(part => part.type === 'waiting' && part.turnIndex === turnIndex)) {
    return
  }
  popTrailingTransient(parts)
  parts.push({
    type: 'waiting',
    ...(turnIndex !== undefined ? { turnIndex } : {}),
  })
}

/**
 * Upsert / remove a plugin status cell (R6).
 *
 * 插件状态是一个按 `(pluginId, id)` 寻址的**格子**,不是一条追加的消息:
 * 同一个 id 再来一次是改 label。少了这条规则,一个每秒汇报进度的插件会在气泡里
 * 堆出几百行。
 *
 * 返回是否真的改动了 —— 调用方据此决定要不要重新赋值 contentParts。
 *
 * `startedAt` / `durationMs` 是计时的两个可选位(2026-08-11):前者是起始墙钟,
 * 渲染侧据此自算走秒;后者一出现就表示这一格已结算,定格该总数。它们**必须逐字
 * 带过**这个格子 —— 早先这里是原地重建一个字面量对象,新字段会在更新那一支被
 * 静静吃掉,于是状态条只在第一次投递时会走秒,之后再也不动。
 */
export function applyPluginStatus(
  parts: ContentPart[],
  status: {
    pluginId: string
    id: string
    label: string
    cleared?: boolean
    startedAt?: number
    durationMs?: number
  },
): boolean {
  const index = parts.findIndex(part =>
    part.type === 'plugin-status' && part.pluginId === status.pluginId && part.id === status.id)

  if (status.cleared) {
    if (index < 0) return false
    const existing = parts[index]
    if (existing.type !== 'plugin-status' || existing.cleared) return false
    // **不 splice**:流式期间 contentParts 是只追加的,渲染层的 key 依赖
    // sourceIndex 稳定(MessageBubble.getOtherPartKey 明文写着这个前提)。
    // 中途摘一项会让它后面所有正文的 key 整体平移 —— Vue 把它们全部重挂,
    // 展开的思考块闭合、滚动位置跳。改成原地标记,渲染层跳过,
    // 流结束时由 removeTransientIndicators 统一收走。
    parts[index] = { ...existing, cleared: true }
    return true
  }

  if (index >= 0) {
    const existing = parts[index]
    // 去重看的是**整条呈现**,不只是 label:一次 running → settled 的收场往往
    // 只改 durationMs(文案也改,但不能指望它),只比 label 会把定格那一条丢掉。
    if (
      existing.type === 'plugin-status'
      && existing.label === status.label
      && existing.startedAt === status.startedAt
      && existing.durationMs === status.durationMs
      && !existing.cleared
    ) return false
    parts[index] = buildPluginStatusPart(status)
    return true
  }

  // 新状态挂在末尾。**不** popTrailingTransient:那会让一个插件状态顶掉正在显示的
  // waiting 指示器,而两者说的是不同的事(等模型 vs 插件在忙)。
  parts.push(buildPluginStatusPart(status))
  return true
}

/**
 * 一处构造,两个调用点共用 —— 新增一个可选位只需要改这里。
 * 可选位用条件展开而不是直接赋 `undefined`:后者会让 `'startedAt' in part` 为真,
 * 而快照测试与结构相等比较都看得见那个多出来的键。
 */
function buildPluginStatusPart(status: {
  pluginId: string
  id: string
  label: string
  startedAt?: number
  durationMs?: number
}): ContentPart {
  return {
    type: 'plugin-status',
    pluginId: status.pluginId,
    id: status.id,
    label: status.label,
    ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
    ...(status.durationMs === undefined ? {} : { durationMs: status.durationMs }),
  }
}

/** Push an image-generation skeleton, avoiding duplicate adjacent skeletons. */
export function pushImageLoading(parts: ContentPart[], turnIndex?: number, label?: string): void {
  const last = parts[parts.length - 1]
  if (last?.type === 'image-loading') return
  popTrailingTransient(parts)
  parts.push({
    type: 'image-loading',
    ...(turnIndex !== undefined ? { turnIndex } : {}),
    ...(label ? { label } : {}),
  })
}

// ---------------------------------------------------------------------------
// 加载路径(非流式)
// ---------------------------------------------------------------------------

/**
 * 历史消息重建 parts。
 *
 * 老消息从存储读回来时没有 `contentParts`(那时还没有这个字段,或者是被脱水
 * 掉了),渲染层却按 part 走位。这里按消息**自己**的内容补一份:正文在前,
 * 工具在后。
 *
 * 工具占位统一走 `data-steps`:一条 `data-steps` 就是「这一轮的 step 行画在
 * 这里」,渲染时由 `buildWorkRender` 用 `stepsForTurn` 取真 step。多轮消息
 * 因此拿到多个占位(按 `turnIndex` 升序、去重),而不是一个把所有工具糊在一
 * 起的 `tool-call` 块 —— 后者只在**没有任何 step**(更老的、只存了
 * `toolCalls` 的消息)时才作为兜底出现。流式路径不受影响,它仍然先发
 * `tool-call` 再发 `data-steps`,`buildWorkRender` 的 `claimed` 去重照旧。
 */
export function rebuildLoadedContentParts(message: {
  content?: string
  steps?: Step[]
  toolCalls?: ToolCall[]
}): ContentPart[] {
  const parts: ContentPart[] = []

  if (message.content) {
    parts.push({ type: 'text', content: message.content })
  }

  const steps = message.steps ?? []
  if (steps.length > 0) {
    // `turnIndex` 缺省视为第 0 轮 —— 单轮老消息就是这个形状。
    const turns = [...new Set(steps.map(step => step.turnIndex ?? 0))].sort((a, b) => a - b)
    for (const turnIndex of turns) {
      parts.push({ type: 'data-steps', turnIndex })
    }
    return parts
  }

  const toolCalls = message.toolCalls ?? []
  if (toolCalls.length > 0) {
    parts.push({ type: 'tool-call', toolCalls: [...toolCalls] })
  }

  return parts
}

/**
 * 加载路径的**锚点自合成**(S3w-0 立法;F4-c c4-b 上收为共享纯件)。
 *
 * 实现搬去了 `@onething/core/session/render-anchors` —— 主进程的 settle 推送
 * 必须与这里**逐字同算**(§16.25 钥匙①:锚点由折叠产物现算,不再由活 run 的
 * 写手对象保管)。两个宿主 import 同一份,谁都不许再抄第二份。
 *
 * 返回补好锚点的新 parts;无需改动时返回 `null`。
 */
export function synthesizeToolAnchors(
  parts: readonly ContentPart[],
  message: { steps?: Step[]; toolCalls?: ToolCall[] },
): ContentPart[] | null {
  return synthesizeCoreToolAnchors<ContentPart>(parts, message)
}
