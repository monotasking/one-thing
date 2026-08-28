/**
 * **翻译器守卫**:进消息的 part 种类,事件账本承载得了吗(§13.6 第 9 条)。
 *
 * `appendContentPart` 是五个"无 translator 也无守卫"的命令之一(§13.1 结构行):
 * 它写进 `message.contentParts`,而事件账本那边的正文来源是
 * `assistant/chunks` + `assistant/part-end` —— 两条路各写各的,一个新的 part
 * 种类被引擎写进消息时,**没有任何东西**会告诉你账本上没有它。真机上这类缺口
 * 只会以"某类消息永远不等"的形式出现在影子日志里,而且要等到有人去读。
 *
 * 所以这里立一张表,分三档:
 *
 * | 档 | 种类 | 理由 |
 * |---|---|---|
 * | **承载** | `text` / `reasoning` / `provider-data` / `image` | 事件词表里有对应的 part kind |
 * | **豁免** | `waiting` / `image-loading` / 未结算的 `plugin-status` | **策略表条目**(定律三,`core/session/events/ephemeral-policy.ts` 的 `contentPart.placeholder` / `contentPart.plugin-status.unsettled`):有取代它的持久事件,判据当场丢掉它们 |
 * | **豁免** | `data-steps` | **渲染锚点**(G4),位置算得出来,不是正文 —— 与上一档不同源,理由也不同 |
 * | **承载** | **已结算**的 `plugin-status` | §17.8 前置批起有产地(`plugin/status` 带 `durationMs`,唯一生产者是后台子代理指示器),折叠侧物化在这一轮正文之后 |
 * | **红** | 其余 | 消息上有、账本上没有、判据也不放过 = 一条必然的不等 |
 *
 * 前两档的名单**不在这里抄**:短命那一档从 `isEphemeralContentPart` 读(策略表
 * 是它的唯一产地),渲染锚点那一档只有一种,就地写死。
 *
 * 开关与深冻结**同一个**(`ONETHING_SESSION_FREEZE`,缺省 vitest 下开):
 * 开发/测试期当场抛,生产期每种类一条 warn(记账问题不许打断聊天)。
 * 两个调用点(命令面与 store 面)共用这一个函数 —— 那两条路都通向同一个
 * core reducer,而 core 是零依赖层,拿不到这个开关。
 */

import { isEphemeralContentPart } from '@onething/core/session'

import { isSessionFreezeEnabled } from './freeze.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.events')

/** 事件词表里有对应 part kind 的那几种。 */
const CARRIED_PART_TYPES = new Set(['text', 'reasoning', 'provider-data', 'image'])

const warnedTypes = new Set<string>()

/** 仅测试:忘掉"这种类已经 warn 过了"。 */
export function resetContentPartGuardWarnings(): void {
  warnedTypes.clear()
}

export function describeUncarriableContentPart(part: unknown): string | undefined {
  if (!part || typeof part !== 'object') return 'content part is not an object'
  const record = part as { type?: unknown; durationMs?: unknown }
  const type = typeof record.type === 'string' ? record.type : undefined
  if (!type) return 'content part has no type'
  if (CARRIED_PART_TYPES.has(type)) return undefined
  // 定律三登记在册的短命 part(占位型两种 + **未结算**的插件状态)。
  if (isEphemeralContentPart(record)) return undefined
  // **已结算**的插件/后台状态行:§17.8 前置批起有产地(`plugin/status` 带
  // `durationMs`,写在结算那一刻),折叠侧把它物化在这一轮正文之后。留账 #10 结清。
  if (type === 'plugin-status' && typeof record.durationMs === 'number') return undefined
  // G4 渲染锚点:算得出来,不是正文(与上一档不同源)。
  if (type === 'data-steps') return undefined
  return `content part '${type}' has no session-event landing (see content-part-guard.ts)`
}

export function assertContentPartIsCarriable(sessionId: string, part: unknown): void {
  const problem = describeUncarriableContentPart(part)
  if (!problem) return
  if (isSessionFreezeEnabled()) throw new TypeError(problem)
  const type = (part as { type?: unknown })?.type
  const key = typeof type === 'string' ? type : '(unknown)'
  if (warnedTypes.has(key)) return
  warnedTypes.add(key)
  log.warn('content part has no session-event landing', { sessionId, partType: key })
}
