/**
 * **投影检查点的编解码**(工单 4 B)。
 *
 * 这一套要钉住的是三句话:
 *
 *  1. **形状门** —— `SessionProjectionState` / `SurfaceIndex` 上多一格状态而没人
 *     管检查点,当场红。这是整份设计里唯一挡得住"静默丢一格"的东西:编解码器
 *     本身是结构性的(不认识字段名),所以只有这两处点名表需要有人看着。
 *  2. **从检查点接着折 ≡ 从头折** —— 两条独立路径折出同一份消息,与 refold 那道
 *     耐久门的哲学逐字相同。
 *  3. **编不出来就抛** —— 类实例 / NaN 这类过不了 JSON 的东西宁可当场失败
 *     (结果只是"这次不写检查点"),也不许被静默编成一格空的。
 */
import { describe, expect, it } from 'vitest'
import {
  canonicalChatMessage,
  createSessionAccountState,
  createSessionProjectionState,
  decodeSessionProjectionCheckpoint,
  encodeSessionProjectionCheckpoint,
  materializeChatMessages,
  PROJECTION_CHECKPOINT_FIELDS,
  reduceSessionAccount,
  reduceSessionProjection,
  SESSION_PROJECTION_CHECKPOINT_VERSION,
  SURFACE_CHECKPOINT_FIELDS,
  SurfaceIndex,
  type SessionLogEventRecord,
  type SessionProjectionState,
} from '../index.js'

const SESSION = 'sess-checkpoint'

/**
 * **编译期的形状门**:`PROJECTION_CHECKPOINT_FIELDS` 与
 * `keyof SessionProjectionState` 必须是同一个集合。
 *
 * 它比运行期那一条严:可选的格(`activeRun` / `lastUserMessageId`)在一份新建的
 * state 上根本不存在,`Object.keys` 数不着它们;而 `keyof` 数得着。往 state 上
 * 加一格忘了管检查点 → `bun run typecheck` 当场红,不必等到跑测试。
 */
type AssertKeysEqual<A extends string, B extends string> =
  [Exclude<A, B> | Exclude<B, A>] extends [never] ? true : { missing: Exclude<A, B>; extra: Exclude<B, A> }
const _projectionFieldsAreExhaustive: AssertKeysEqual<
  keyof SessionProjectionState & string,
  typeof PROJECTION_CHECKPOINT_FIELDS[number]
> = true
void _projectionFieldsAreExhaustive

/** 一轮对话四条事件 —— 与 backend 那套 fixture 同一个形状。 */
function turn(index: number, from: number): SessionLogEventRecord[] {
  const userId = `u${index}`
  const assistantId = `a${index}`
  const runId = `r${index}`
  return [
    { seq: from, time: index * 10, type: 'user/message', surfaceOp: 'append',
      data: { message: { id: userId, role: 'user', content: `ask ${index}`, timestamp: index * 10 } } },
    { seq: from + 1, time: index * 10 + 1, type: 'run/start', surfaceOp: 'append',
      data: { runId, kind: 'send', assistantMessageId: assistantId, timestamp: index * 10 + 1 } },
    { seq: from + 2, time: index * 10 + 2, type: 'assistant/chunks',
      data: { runId, requestIndex: index, messageId: assistantId, partIndex: index * 2, kind: 'text', time0: 1, dt: [0], text: [`reply ${index}`] } },
    { seq: from + 3, time: index * 10 + 3, type: 'run/end', data: { runId, outcome: 'completed' } },
  ] as unknown as SessionLogEventRecord[]
}

function ledger(turns: number): SessionLogEventRecord[] {
  const events: SessionLogEventRecord[] = []
  for (let index = 1; index <= turns; index++) events.push(...turn(index, events.length + 1))
  return events
}

function fold(events: readonly SessionLogEventRecord[]) {
  let state = createSessionProjectionState()
  let account = createSessionAccountState()
  for (const event of events) {
    state = reduceSessionProjection(state, event)
    account = reduceSessionAccount(account, event, { sessionId: SESSION })
  }
  return { state, account }
}

function canonical(state: ReturnType<typeof fold>['state']): unknown[] {
  return materializeChatMessages(state, {}).messages.map(message =>
    canonicalChatMessage(message as unknown as Record<string, unknown>))
}

/** 编码 → JSON 一趟 → 解码,与真的写盘读盘同路。 */
function roundTrip(state: ReturnType<typeof fold>['state'], account: ReturnType<typeof fold>['account']) {
  const payload = JSON.parse(JSON.stringify(encodeSessionProjectionCheckpoint(state, account)))
  return decodeSessionProjectionCheckpoint(payload)
}

describe('projection checkpoint — shape gates', () => {
  it('names every field of SessionProjectionState', () => {
    // 加一格状态而没管检查点 → 这一条红。红了要做的是:让结构性编码覆盖它
    // (它是 Map/Set/数组/朴素对象/原始值之一就自动覆盖),然后把名字加进表里。
    //
    // **真正的门在类型上**(文件末尾那句 `AssertKeysEqual`):可选的格
    // (`activeRun` / `lastUserMessageId`)在一份新建的 state 上压根不存在,
    // 只靠 `Object.keys` 数是数不全的。运行期这一条数的是"折过一轮之后实际
    // 长出来的那些",两道加起来才不漏。
    const exercised = fold(ledger(1)).state
    const observed = new Set([
      ...Object.keys(createSessionProjectionState()),
      ...Object.keys(exercised),
    ])
    expect([...observed].sort()).toEqual([...PROJECTION_CHECKPOINT_FIELDS].sort())
  })

  it('names every field of SurfaceIndex', () => {
    // `SurfaceIndex` 是个类,结构性编码不认得它 —— 它自己 `toCheckpoint()`。
    // 多一格私有状态而没进 `toCheckpoint()` → 这一条红。
    const fresh = new SurfaceIndex()
    expect(Object.keys(fresh).sort()).toEqual([...SURFACE_CHECKPOINT_FIELDS].sort())
    expect(Object.keys(fresh.toCheckpoint()).sort()).toEqual([...SURFACE_CHECKPOINT_FIELDS].sort())
  })

  it('stamps the codec version it can read back', () => {
    const { state, account } = fold(ledger(1))
    expect(encodeSessionProjectionCheckpoint(state, account).version)
      .toBe(SESSION_PROJECTION_CHECKPOINT_VERSION)
  })

  it('refuses a payload from another codec version', () => {
    const { state, account } = fold(ledger(1))
    const payload = encodeSessionProjectionCheckpoint(state, account)
    expect(() => decodeSessionProjectionCheckpoint({ ...payload, version: payload.version + 1 }))
      .toThrow(/version/i)
  })
})

describe('projection checkpoint — round trip', () => {
  it('folds to the same messages after a round trip', () => {
    const { state, account } = fold(ledger(4))
    const before = canonical(state)
    const restored = roundTrip(state, account)
    expect(canonical(restored.state)).toEqual(before)
    expect(restored.account).toEqual(account)
    expect(restored.state.lastSeq).toBe(state.lastSeq)
  })

  it('rebuilds the three derived indexes instead of storing them', () => {
    const { state, account } = fold(ledger(3))
    const payload = encodeSessionProjectionCheckpoint(state, account)
    // 三张派生索引不落盘 —— 落了就是同一份历史存三遍,还原后身份还对不上。
    expect(Object.keys(payload.state)).not.toContain('byEventSeq')
    expect(Object.keys(payload.state)).not.toContain('byMessageId')
    expect(Object.keys(payload.state)).not.toContain('runs')

    const restored = roundTrip(state, account)
    expect(restored.state.byMessageId.get('a2')).toBe(restored.state.nodes.find(node => node.messageId === 'a2'))
    expect(restored.state.byEventSeq.get(9)).toBe(restored.state.nodes.find(node => node.eventSeq === 9))
    expect(restored.state.runs.get('r2')?.messageId).toBe('a2')
  })

  it('restores the surface, shadowing and all', () => {
    const events = ledger(3)
    events.push({
      seq: events.length + 1, time: 999, type: 'message/deleted',
      surfaceOp: { start: 1, end: 2 }, sourceEventSeqs: [1, 2],
      data: { messageId: 'u1' },
    } as unknown as SessionLogEventRecord)
    const { state, account } = fold(events)
    const restored = roundTrip(state, account)
    expect(restored.state.surface.snapshot()).toEqual(state.surface.snapshot())
    expect(restored.state.surface.shadowedCount()).toBe(state.surface.shadowedCount())
  })
})

describe('projection checkpoint — resuming equals folding from scratch', () => {
  it.each([1, 2, 5, 8])('splits a ledger after %i events and lands on the same projection', split => {
    const events = ledger(3)
    // 路径 a:整份从头折。
    const whole = fold(events)
    // 路径 b:前半段折出检查点 → 一趟 JSON → 后半段接着折。
    const head = fold(events.slice(0, split))
    const restored = roundTrip(head.state, head.account)
    let state = restored.state
    let account = restored.account
    for (const event of events.slice(split)) {
      state = reduceSessionProjection(state, event)
      account = reduceSessionAccount(account, event, { sessionId: SESSION })
    }

    expect(canonical(state)).toEqual(canonical(whole.state))
    expect(account).toEqual(whole.account)
    expect(state.surface.snapshot()).toEqual(whole.state.surface.snapshot())
    expect(state.lastSeq).toBe(whole.state.lastSeq)
  })
})

describe('projection checkpoint — refuses what it cannot encode honestly', () => {
  it('throws on a class instance rather than encoding an empty object', () => {
    const { state, account } = fold(ledger(1))
    class Foreign { value = 1 }
    ;(state.nodes[0] as unknown as Record<string, unknown>).foreign = new Foreign()
    expect(() => encodeSessionProjectionCheckpoint(state, account)).toThrow(/class instance/)
  })

  it('throws on a non-finite number rather than letting JSON turn it into null', () => {
    const { state, account } = fold(ledger(1))
    ;(state.nodes[0] as unknown as Record<string, unknown>).drift = Number.NaN
    expect(() => encodeSessionProjectionCheckpoint(state, account)).toThrow(/NaN/)
  })
})
