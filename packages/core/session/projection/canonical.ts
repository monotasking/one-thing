/**
 * `canonicalChatMessage(m)` —— 比较两条消息"是不是同一条"的**唯一**判据(§9.4)。
 *
 * 两个消费者:S0 的合同测试(命令线 vs 事件线),S1 的影子断言
 * (`project(events) ≡ messages`,§8 的 `runs ≥ 200 ∧ mismatch = 0` 按它数)。
 * 审查 B7 点名的问题正是"mismatch 没有定义" —— 直接深比较必然恒假
 * (isStreaming / thinkingTime / timestamp / usage 累计 / steps 顺序都不等),
 * 于是那道门要么永远红要么被人调成永远绿。这个函数把"不等但不算数"的那部分
 * 一次性写死。
 *
 * ## 丢掉什么,为什么
 *
 * | 字段 | 处置 | 理由 |
 * |---|---|---|
 * | `seq` | 丢 | 位置,不是身份。删一条前面的消息它全平移(§3.2 它在 S2 退役) |
 * | `eventSeq` | 丢 | 投影独有的事件坐标,命令线没有它 |
 * | `sessionId` | 丢 | 上下文字段,同一条消息在不同读法下有无都算对 |
 * | `isThinking` / `thinkingStartTime` | 丢 | 纯 UI 活跃态(渲染侧自己走秒) |
 * | `isStreaming` | 只保留 `true` | `false` 与缺席是同一件事 |
 * | 瞬态 part | 丢 | `waiting` / `image-loading` / 未结算的 `plugin-status`:追加即撤,append-only 表达不了(§7.2 M3) |
 * | `undefined` 值的键 | 丢 | `{a: undefined}` 与 `{}` 是同一条消息 |
 * | 空数组 | 丢 | `toolCalls: []` 与没有 toolCalls 是同一件事 |
 * | `steps` / `toolCalls` 顺序 | 按 id 排序 | 数组序是派生物(到达序 vs 落盘序),身份是 id |
 *
 * **不丢**的:`contentParts` 的顺序(那是正文本身)、`timestamp`、`usage`、
 * `thinkingTime`、`errorDetails`。它们不等就是真的不等。
 */

export interface CanonicalizeOptions {
  /** 额外忽略的顶层字段(S1 影子期用来临时豁免还没接上的采集点)。 */
  ignoreKeys?: readonly string[]
}

const ALWAYS_DROPPED_KEYS = new Set(['seq', 'eventSeq', 'sessionId', 'isThinking', 'thinkingStartTime'])

/** 与 shared 层契约里的 `isTransientPart` 同口径(core 不引 shared,判据抄在这里)。 */
function isTransientPart(part: unknown): boolean {
  if (!part || typeof part !== 'object') return false
  const record = part as { type?: unknown; durationMs?: unknown }
  if (record.type === 'waiting' || record.type === 'image-loading') return true
  return record.type === 'plugin-status' && record.durationMs === undefined
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key]
    if (entry === undefined) continue
    out[key] = canonicalValue(entry)
  }
  return out
}

function sortByKey(items: readonly unknown[], key: 'id' | 'toolCallId'): unknown[] {
  return [...items].sort((a, b) => {
    const left = String((a as Record<string, unknown>)?.[key] ?? (a as { id?: unknown })?.id ?? '')
    const right = String((b as Record<string, unknown>)?.[key] ?? (b as { id?: unknown })?.id ?? '')
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/**
 * G1(§10.1):**step 的 `id` 不参与比较**。事件里从来没有 stepId ——
 * 引擎实时那一份是 `createCoreId()` 随机生成的,投影那一份是
 * `step-${callId}` 派生的,两者永远不等而这不说明任何事。身份是
 * `toolCallId`:排序按它,比较也不看 id。`childSteps` 递归同款。
 */
function canonicalStep(step: unknown): unknown {
  if (!step || typeof step !== 'object') return canonicalValue(step)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(step as Record<string, unknown>).sort()) {
    if (key === 'id') continue
    const value = (step as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (key === 'childSteps') {
      if (!Array.isArray(value) || value.length === 0) continue
      out.childSteps = sortByKey(value, 'toolCallId').map(canonicalStep)
      continue
    }
    if (Array.isArray(value) && value.length === 0) continue
    out[key] = canonicalValue(value)
  }
  return out
}

export function canonicalChatMessage(
  message: Record<string, unknown>,
  options: CanonicalizeOptions = {},
): Record<string, unknown> {
  const ignored = new Set([...ALWAYS_DROPPED_KEYS, ...(options.ignoreKeys ?? [])])
  const out: Record<string, unknown> = {}

  for (const key of Object.keys(message).sort()) {
    if (ignored.has(key)) continue
    const value = message[key]
    if (value === undefined) continue

    if (key === 'isStreaming') {
      if (value === true) out.isStreaming = true
      continue
    }

    if (key === 'contentParts') {
      if (!Array.isArray(value)) continue
      const parts = value.filter(part => !isTransientPart(part)).map(canonicalValue)
      if (parts.length > 0) out.contentParts = parts
      continue
    }

    if (key === 'steps') {
      if (!Array.isArray(value) || value.length === 0) continue
      out.steps = sortByKey(value, 'toolCallId').map(canonicalStep)
      continue
    }

    if (key === 'toolCalls') {
      if (!Array.isArray(value) || value.length === 0) continue
      out.toolCalls = sortByKey(value, 'id').map(canonicalValue)
      continue
    }

    if (Array.isArray(value) && value.length === 0) continue

    out[key] = canonicalValue(value)
  }

  return out
}

export function canonicalChatMessages(
  messages: readonly Record<string, unknown>[],
  options: CanonicalizeOptions = {},
): Record<string, unknown>[] {
  return messages.map(message => canonicalChatMessage(message, options))
}
