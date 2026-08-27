/**
 * refold 的**协作式分片**(S3w-2 后续,`docs/design/session-event-sourcing-2026-08.md`
 * §15.14)。
 *
 * ## 它治的是什么
 *
 * `checkSessionRefold` 在 `await readFile` 之后是**一整块同步代码**:整份日志
 * parse → 全量 fold → 重折侧物化 → 逐字段深比。真机那本 16.2MB / 7604 行的账本
 * 上实测 ≈142ms(35.6 + 16 + 34.4 + 56.6),跑在 run 收尾后的 `setTimeout(0)` 宏
 * 任务里 —— 主进程那一刻**什么都干不了**,用户感知就是"答完顿一下"。
 *
 * 治法不是 worker(`dist/server` 是单文件包,装不下第二个入口脚本,见 CLAUDE.md
 * 的单文件/TDZ 判例),而是**把那一整块切开**:每跑够半帧就 `setImmediate` 让出
 * 一次事件环,排在后面的 IPC/SSE 回调、timer、IO 完成都能插进来。总耗时略增
 * (让出的往返开销),但**最长一次连续阻塞**从 142ms 降到一帧以内。
 *
 * ## 为什么这些函数住在这里(而不是 refold.ts 里)
 *
 * 它们只依赖 `@onething/core/session`,不碰后端脊柱 —— 于是:
 *  1. 合同测试可以直接跑它们(不用把整只 app store 拉起来);
 *  2. 离线探针可以在**真机账本**上跑**生产同一份代码**量阻塞分布,而不是量一份
 *     抄写版。
 *
 * ## 逐字等价是硬约束
 *
 * 每个分片版都必须与它替下来的那个写法**同结果**(不是"差不多"):
 *  - `parseSessionLogEventLogSliced` ≡ `parseSessionLogEventLog`(同一份行切分、
 *    同一个稳定排序);
 *  - `foldSessionProjectionSliced` ≡ 顺序 `reduceSessionProjection` 全折;
 *  - `canonicalProjectionMessagesSliced` ≡ `visible.map(canonical∘materialize)`;
 *  - `deepEqualPairsSliced` ≡ `deepEqual(a, b)`(两侧都是数组时)。
 * 合同断言在 `__tests__/refold-slices.test.ts`。
 */

import {
  canonicalChatMessage,
  createSessionAccountState,
  createSessionProjectionState,
  decodeSessionLogEventLine,
  materializeNode,
  reduceSessionAccount,
  reduceSessionProjection,
  type CoreTimelineMessage,
  type ProjectionMaterializeOptions,
  type SessionAccountState,
  type SessionLogEventRecord,
  type SessionProjectionState,
} from '@onething/core/session'

/**
 * 一片连续同步工作的预算。
 *
 * 8ms = 半帧。四个循环都是**每一步问一次表**(每行 / 每事件 / 每节点 / 每对
 * 消息):问表是一次 `Date.now()`(几十纳秒),7915 行的真机账本上总共不到
 * 0.3ms —— 比"隔 64 次问一次"省下的那点开销值钱得多。真机上有一本 50MB 却
 * 只有 258 行的账本(单行 200KB),隔 64 行问一次意味着一片里塞了 64 个
 * 200KB 的 `JSON.parse`,直接 29ms 破帧。
 *
 * 问到的时候手里那一步已经在跑了,所以实际那一片 = 预算 + 最后那一步。留半帧
 * 余量之后,只要**单步**不超过半帧,整片就在一帧以内。单步超过半帧的情形有且
 * 只有一种:一条 200KB 级的巨行 / 巨消息(见 §15.14 的诚实交代)——它是
 * "逐条"这个粒度的地板,再往下切就得改 `JSON.parse` / `deepEqual` 本身了。
 */
export const REFOLD_SLICE_BUDGET_MS = 8

export interface RefoldSliceGate {
  /** 这一片跑够久了吗。**同步、便宜** —— 只有它说够了才去 await。 */
  spent(): boolean
  /** 让出一次事件环(宏任务:排在前面的 IO / timer 回调都能先跑)。 */
  yield(): Promise<void>
  /** 迄今为止**最长一次连续同步块**(ms)—— 探针与测试据此判据验收。 */
  longestBlockMs(): number
}

/**
 * 造一个分片闸。
 *
 * `setImmediate` 而不是 `queueMicrotask`:微任务仍然在同一个宏任务里排队,让出
 * 去的还是自己 —— 那样切了等于没切(与 `shadow.ts` 选 `setTimeout(0)` 同一个
 * 理由)。
 */
export function createRefoldSliceGate(budgetMs: number = REFOLD_SLICE_BUDGET_MS): RefoldSliceGate {
  let since = Date.now()
  let longest = 0
  const close = (): void => {
    const block = Date.now() - since
    if (block > longest) longest = block
  }
  return {
    spent: () => Date.now() - since >= budgetMs,
    yield: () => new Promise<void>(resolve => {
      close()
      setImmediate(() => {
        since = Date.now()
        resolve()
      })
    }),
    longestBlockMs: () => {
      close()
      return longest
    },
  }
}

/**
 * 整份日志的分片解析 —— 与 `parseSessionLogEventLog` **同结果**。
 *
 * 两处必须与原函数逐字对齐:
 *  1. **行切分**:原函数是 `text.split('\n')`,即"最后一个 \n 之后还有一段"
 *     (文件以 \n 结尾时那一段是空串)。这里用 `indexOf` 逐段扫 —— 省掉一次
 *     16MB 的整体切分(那本身就是几十毫秒里的一块),但段的集合一模一样。
 *  2. **排序**:同一个比较器(seq 升序,同 seq 保持文件里的先后)。排序是一次
 *     性的同步块,7604 条量级 ≈1ms,不值得再切。
 */
export async function parseSessionLogEventLogSliced(
  text: string,
  gate: RefoldSliceGate,
): Promise<SessionLogEventRecord[]> {
  const records: Array<{ record: SessionLogEventRecord; order: number }> = []
  let order = 0
  let from = 0
  for (;;) {
    const newline = text.indexOf('\n', from)
    const line = newline === -1 ? text.slice(from) : text.slice(from, newline)
    const record = decodeSessionLogEventLine(line)
    if (record) records.push({ record, order: order++ })
    if (newline === -1) break
    from = newline + 1
    if (gate.spent()) await gate.yield()
  }
  records.sort((a, b) => (a.record.seq - b.record.seq) || (a.order - b.order))
  return records.map(entry => entry.record)
}

/**
 * 全量 fold 的分片版 —— 与顺序折**同结果**。
 *
 * 折的是一份**私有** state(`createSessionProjectionState` 现造的),让出去期间
 * 谁也碰不到它;`reduceSessionProjection` 的移动语义(S0 §9.7 判例 9)在这里
 * 照旧成立,因为始终只持有它返回的那一份。
 */
export async function foldSessionProjectionSliced(
  events: readonly SessionLogEventRecord[],
  gate: RefoldSliceGate,
): Promise<SessionProjectionState> {
  let state = createSessionProjectionState()
  for (const event of events) {
    state = reduceSessionProjection(state, event)
    if (gate.spent()) await gate.yield()
  }
  return state
}

/**
 * **消息投影 + 会话账一起折**的分片版(§17.7.1 批 3:refold 门扩栏)。
 *
 * 两件事必须在**同一遍**里折:会话账的截断分支要问"这条事件折进去之后还剩哪些
 * 消息",而那是**当时**那一份投影,不是整份折完的最终态。分两遍折出来的账会在
 * 每一次截断上算错 —— 而那正是这道门要守的那一格。
 *
 * 与活路径逐字同构:`projection-cache.ts` 的 `foldRecord` 也是"先折投影,再拿
 * 折完的投影当上下文折账"。
 */
export async function foldSessionProjectionAndAccountSliced(
  sessionId: string,
  events: readonly SessionLogEventRecord[],
  options: ProjectionMaterializeOptions,
  gate: RefoldSliceGate,
): Promise<{ state: SessionProjectionState; account: SessionAccountState }> {
  let state = createSessionProjectionState()
  let account = createSessionAccountState()
  const context = {
    sessionId,
    messagesAfter: (): CoreTimelineMessage[] =>
      state.nodes
        .filter(node => !node.hidden)
        .map(node => materializeNode(node, options) as unknown as CoreTimelineMessage),
  }
  for (const event of events) {
    state = reduceSessionProjection(state, event)
    account = reduceSessionAccount(account, event, context)
    if (gate.spent()) await gate.yield()
  }
  return { state, account }
}

/**
 * 可见节点的物化 + canonical 的分片版 —— 与 `visible.map(...)` **同结果**
 * (同一份物化选项、同一个顺序、同一把尺)。
 *
 * 每个节点问一次表:一个节点的物化是"这一步"的粒度,再细就得改 core 的物化
 * 本身了。真机那本账上单节点 ≈0.1ms,粒度够。
 */
export async function canonicalProjectionMessagesSliced(
  state: SessionProjectionState,
  options: ProjectionMaterializeOptions,
  gate: RefoldSliceGate,
): Promise<unknown[]> {
  const out: unknown[] = []
  for (const node of state.nodes) {
    if (node.hidden) continue
    out.push(canonicalChatMessage(materializeNode(node, options) as unknown as Record<string, unknown>))
    if (gate.spent()) await gate.yield()
  }
  return out
}

/**
 * 两份 canonical 消息数组的分片深比 —— 与 `deepEqual(a, b)` **同结果**。
 *
 * 逐条比、首个不等就短路(与 `deepEqual` 的 `every` 同语义)。短路之后调用方
 * 才去算差异摘要 —— 那一段仍然是同步的,理由是它只在**已经不等**的时候跑
 * (罕见,而且那时候的当务之急是把证据记下来,不是流畅度)。
 */
export async function deepEqualPairsSliced(
  a: readonly unknown[],
  b: readonly unknown[],
  isEqual: (left: unknown, right: unknown) => boolean,
  gate: RefoldSliceGate,
): Promise<boolean> {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (!isEqual(a[index], b[index])) return false
    if (gate.spent()) await gate.yield()
  }
  return true
}
