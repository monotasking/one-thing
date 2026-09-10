/**
 * **投影检查点的编解码**(工单 4 B,`docs/design/session-event-sourcing-2026-08.md`
 * §17 三定律的第二条:账本是唯一真相,投影是派生物)。
 *
 * ## 它是什么,不是什么
 *
 * 检查点是一句**可以扔掉的备忘**:「这条会话的账本折到第 N 条时,投影长这样」。
 * 冷启动第一次碰这条会话时,先读它、再把 N 之后的事件折上去,于是不必从
 * 55MB 的 `events.jsonl` 从头折一遍。它**永远不是真相** ——
 *
 *  - 对不上就丢掉从头折(判据在 `backend/session/checkpoint-file.ts`,不在这里);
 *  - 删掉它,下一次自己重建;
 *  - **绝不反过来改账本**。这一条没有例外:检查点里读出来的东西一个字节都不会
 *    被写回 `events.jsonl`,这只文件里连一个写账本的口都没有。
 *
 * ## 为什么编解码是**结构性**的,不点字段的名
 *
 * `SessionProjectionState` 与它下面的节点有几十格,而且每个月都在长(§13/§16 的
 * 每一条判例几乎都往节点上加过一格)。一份"按字段名抄"的编解码器,在下一个人
 * 加一格的那天就开始**静默丢**那一格 —— 而丢掉的后果是「有检查点的会话与没有
 * 检查点的会话折出两份不同的历史」,最难查的那一类。
 *
 * 所以这里的 `encodeValue` / `decodeValue` 不认识任何字段名:它只认得
 * `Map` / `Set` / 数组 / 朴素对象 / 原始值这五样,遇到什么抄什么。新加一格
 * 只要是这五样之一,它自动就在检查点里。
 *
 * 需要点名的只剩**两处**,而两处各有一道门守着:
 *
 *  1. **三张派生索引**(`byEventSeq` / `byMessageId` / `runs`)—— 不落盘,还原时
 *     由归约器自己的 `rebuildSessionProjectionIndexes` 重建(法只有一本)。
 *     落盘它们等于同一份历史存三遍,且还原后对象身份必然对不上。
 *  2. **`surface`** —— 它是一个类,五样里没有它。由 `SurfaceIndex` 自己
 *     `toCheckpoint()` / `fromCheckpoint()`,配一张 `SURFACE_CHECKPOINT_FIELDS`
 *     点名表当形状门。
 *
 * 两处点名合起来就是 `PROJECTION_CHECKPOINT_FIELDS`:那张表与
 * `createSessionProjectionState()` 的键集不逐格相等,`__tests__` 当场红 —— 于是
 * "加一格状态忘了管检查点"这件事在写代码的那一天就被拦下,而不是三个月后
 * 在真机上表现成一段消失的历史。
 *
 * ## 版本
 *
 * `SESSION_PROJECTION_CHECKPOINT_VERSION` 是**编码格式**的版本,不是投影语义的
 * 版本。语义变了(归约器改了折法)不必动它:那种变化由字节数 + 末行指纹那道门
 * 挡不住,也不该由这里挡 —— 真正的挡法是「折法变了就把旧检查点作废」,做法是
 * 把这个数 +1。这句话写在这里,是为了让下一个改归约器的人知道该动哪一格。
 */

import {
  createSessionAccountState,
  type SessionAccountState,
} from '../account.js'
import {
  createSessionProjectionState,
  rebuildSessionProjectionIndexes,
  type SessionProjectionState,
} from './reducer.js'
import { SurfaceIndex, type SurfaceCheckpoint } from './surface.js'

/**
 * 编码格式版本。**折法变了也要 +1**(见文件头最后一节)。
 *
 * 1 —— 首版(2026-09-10):结构性编码 + 三张派生索引重建 + surface 自述。
 */
export const SESSION_PROJECTION_CHECKPOINT_VERSION = 1

/**
 * `SessionProjectionState` 的键集 —— **形状门的判据**(见文件头)。
 *
 * 不是编解码器的输入:它一格都不读这张表。它只是一份"我们数过,就这些"的
 * 声明,好让下一个往 state 上加格的人立刻收到一次红。
 */
export const PROJECTION_CHECKPOINT_FIELDS = [
  'activeRun',
  'awaitingPermissionCallIds',
  'byEventSeq',
  'byMessageId',
  'lastSeq',
  'lastUserMessageId',
  'nodes',
  'permissionCallIdByRequestId',
  'rejectionReasonByCallId',
  'runs',
  'sessionMeta',
  'surface',
  'toolResultSeqByCallId',
] as const

/**
 * 由 `nodes` 重建、因此**不进检查点**的三张表。
 *
 * 单独列成一张表而不是写死在编码函数里,是因为形状门要拿它做减法:
 * 「state 的键集 − 这三张 − surface = 结构性编码要覆盖的那些」。
 */
export const PROJECTION_DERIVED_INDEX_FIELDS = ['byEventSeq', 'byMessageId', 'runs'] as const

const DERIVED = new Set<string>(PROJECTION_DERIVED_INDEX_FIELDS)

// ============ 结构性编解码(不认识任何字段名) ============

const MAP_TAG = '@map'
const SET_TAG = '@set'

/**
 * 值 → 可 JSON 化的形状。
 *
 * `Map` / `Set` 折成带标记的对象,其余原样递归。**不认识的东西一律抛** ——
 * 一个函数 / 一个类实例悄悄被编成 `{}`,还原之后就是一格静默失效的状态;
 * 抛出来的结果只是"这次不写检查点"(调用方自吞),代价小得多。
 */
function encodeValue(value: unknown, at: string): unknown {
  if (value === null || value === undefined) return value ?? null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    // NaN / Infinity 过一趟 JSON 会变成 null —— 那是一次静默改值,不许发生。
    if (!Number.isFinite(value as number)) throw new TypeError(`Checkpoint cannot encode ${String(value)} at ${at}`)
    return value
  }
  if (type !== 'object') throw new TypeError(`Checkpoint cannot encode ${type} at ${at}`)
  if (Array.isArray(value)) return value.map((entry, index) => encodeValue(entry, `${at}[${index}]`))
  if (value instanceof Map) {
    return { [MAP_TAG]: [...value].map(([key, entry], index) => [encodeValue(key, `${at}<key ${index}>`), encodeValue(entry, `${at}<${String(key)}>`)]) }
  }
  if (value instanceof Set) {
    return { [SET_TAG]: [...value].map((entry, index) => encodeValue(entry, `${at}<${index}>`)) }
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Checkpoint cannot encode a class instance at ${at}`)
  }
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // `undefined` 的格与"没有这一格"在投影里同义(全是可选字段),不写。
    if (entry === undefined) continue
    out[key] = encodeValue(entry, at ? `${at}.${key}` : key)
  }
  return out
}

/** `encodeValue` 的逆。标记对象换回 `Map`/`Set`,其余原样。 */
function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decodeValue)
  const record = value as Record<string, unknown>
  const mapEntries = record[MAP_TAG]
  if (Array.isArray(mapEntries)) {
    return new Map(mapEntries.map(entry => {
      const pair = entry as unknown[]
      return [decodeValue(pair[0]), decodeValue(pair[1])] as [unknown, unknown]
    }))
  }
  const setEntries = record[SET_TAG]
  if (Array.isArray(setEntries)) return new Set(setEntries.map(decodeValue))
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) out[key] = decodeValue(entry)
  return out
}

// ============ 投影 / 会话账 ============

/** 检查点里那一份投影载荷(不含文件级的元数据,那是装配层的事)。 */
export interface SessionProjectionCheckpointPayload {
  version: number
  state: Record<string, unknown>
  surface: SurfaceCheckpoint
  account: Record<string, unknown>
}

/**
 * 活投影 + 会话账 → 检查点载荷。编不出来就抛(调用方自吞:不写检查点而已)。
 *
 * 两者一起编,理由与它们在 `LiveProjection` 上并排放着的理由逐字相同:同一份
 * 事件、同一个刷新点。只存投影不存账,还原之后账就停在初值,而它是**折叠产物**
 * —— 下一次截断算出来的补丁会以一份错的历史为底。
 */
export function encodeSessionProjectionCheckpoint(
  state: SessionProjectionState,
  account: SessionAccountState,
): SessionProjectionCheckpointPayload {
  const encodedState: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(state as unknown as Record<string, unknown>)) {
    if (DERIVED.has(key)) continue
    if (key === 'surface') continue
    if (value === undefined) continue
    encodedState[key] = encodeValue(value, key)
  }
  return {
    version: SESSION_PROJECTION_CHECKPOINT_VERSION,
    state: encodedState,
    surface: state.surface.toCheckpoint(),
    account: encodeValue(account, 'account') as Record<string, unknown>,
  }
}

/**
 * 检查点载荷 → 活投影 + 会话账。**形状不对就抛** —— 上层据此丢掉它从头折。
 *
 * 还原出来的 state 是一份货真价实的活投影:三张派生索引由归约器自己重建,
 * `surface` 由它自己还原,于是后续的增量折叠(`reduceSessionProjection`)对它
 * 与对一份从文件折出来的没有任何差别。
 */
export function decodeSessionProjectionCheckpoint(
  payload: SessionProjectionCheckpointPayload,
): { state: SessionProjectionState; account: SessionAccountState } {
  if (payload?.version !== SESSION_PROJECTION_CHECKPOINT_VERSION) {
    throw new TypeError(`Unsupported session projection checkpoint version: ${String(payload?.version)}`)
  }
  const state = createSessionProjectionState()
  for (const [key, value] of Object.entries(payload.state ?? {})) {
    if (DERIVED.has(key) || key === 'surface') continue
    ;(state as unknown as Record<string, unknown>)[key] = decodeValue(value)
  }
  state.surface = SurfaceIndex.fromCheckpoint(payload.surface)
  if (!Array.isArray(state.nodes)) throw new TypeError('Session projection checkpoint has no nodes')
  if (typeof state.lastSeq !== 'number') throw new TypeError('Session projection checkpoint has no lastSeq')
  rebuildSessionProjectionIndexes(state)
  const account = { ...createSessionAccountState(), ...(decodeValue(payload.account ?? {}) as SessionAccountState) }
  return { state, account }
}
