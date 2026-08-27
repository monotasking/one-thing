/**
 * **会话账对拍**(§17.7.1 批 2 / #8b-i;裁定 4 的口径)。
 *
 * 老 reducer 剩下的唯一身份是**会话级派生的算法**。批 2 让同一本账多出一个
 * **折叠版**(`core/session/account.ts`),两边并排跑、逐格比,**一格都不接管**。
 *
 * ## 比的是什么(裁定 4:比"容器上此刻的值",不是"reducer 算的值")
 *
 * 两类断言,合起来正好盖住老 reducer 在会话级的全部产出:
 *
 * 1. **绝对值**(每条命令写路收尾时,一次):`updatedAt` / `lastProvider` /
 *    `lastModel`。这三格在桌面侧的容器写者只有 reducer 一个(实测:
 *    `backend/stores/sessions.ts` 与 `sessions/session-repository.ts` 上零赋值点),
 *    所以"容器此刻的值"就是这次命令刚盖的那个数,可以直接与折叠值逐字比。
 * 2. **增量**(只在 `truncateFrom` 上,一次):usage 三件的扣减 +
 *    `computeSessionTimelineMetadataRepair` 的 `contextSize`/`lastInputTokens` 改写
 *    与 summary 三件的删除。这一组比的是**容器的前后差**,而不是绝对值 ——
 *    因为它们的**正向**产地不在事件流上(§17.7.1 批 2 勘察第五节:usage 累加在
 *    `applySessionTokenUsage`、`contextSize` 另有两个写者),拿绝对值比就是在比
 *    两套不同的累加算法,而不是在比这次截断算得对不对。批 3 要接管的恰恰只有
 *    这个增量。
 *
 * 折叠侧那几格的**绝对值**同样在折(`SessionAccountState` 是完整的一本账),
 * 只是影子期不拿它去对无关写者的账 —— 那几个写者的翻转是 F 线后面的事。
 *
 * ## 三条纪律(与 `shadow.ts` / `refold.ts` 同款)
 *
 * 1. **永不抛进引擎**。出口 try/catch 自吞:门算错了最坏是账记歪,不能是聊天挂掉。
 * 2. **不建表**。没有活投影就不比(`peekSessionAccount` 交回 `undefined`)——
 *    为一次对拍付一次全文件同步 IO 是本末倒置,与 F1 观察者的边界同源。
 * 3. **不许调绿**,不留容差窗。`updatedAt` 两侧必须是**同一个数**:命令取一次刻,
 *    既盖事件又递 reducer(时钟同源,裁定 1)。比出不等就是真不等。
 *
 * ## 两条具名例外(裁定 3,批 2 不动它们)
 *
 * - `replaceAll{reason:'normalize'}` —— reducer 盖 `updatedAt`,而判例明写**不产
 *   事件**(`command-events.ts` 的 `replaceAll`)。今天生产零调用点;批 3 勘察
 *   "补产地还是随死码删"。这里按 reason 跳过。
 * - `repairOnLoad` —— 它根本不在命令写路上(生产入口是冷加载的
 *   `sanitizeSessionOnStartup` 直调 reducer),而且不产事件。批 3 把修复搬到读路
 *   出口。这里不挂对拍点。
 *
 * 关闸:`ONETHING_SESSION_SHADOW=0`(与影子总闸同一个)。
 */

import type { ChatSession } from '@shared/ipc.js'
import type { SessionAccountState } from '@onething/core/session'
import { bumpSessionShadowStats, isSessionShadowEnabled } from './event-stats.js'
import { peekSessionAccount } from './projection-cache.js'
import { appendSessionShadowLine, deepEqual, summarizeShadowDiff } from './shadow.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.account-shadow')

/** 绝对值那一组:桌面侧容器写者只有 reducer 的三格。 */
interface AccountIdentityCells {
  updatedAt?: number
  lastProvider?: string
  lastModel?: string
}

/** 增量那一组:一次截断在会话级留下的全部改写。 */
export interface AccountTruncationCells {
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  contextSize?: number
  lastInputTokens?: number
  summary?: string
  summaryUpToMessageId?: string
  summaryCreatedAt?: number
}

export function snapshotTruncationCells(
  session: ChatSession | undefined,
): AccountTruncationCells | undefined {
  if (!session) return undefined
  const source = session as unknown as Record<string, unknown>
  const num = (key: string): number => (typeof source[key] === 'number' ? source[key] as number : 0)
  const opt = (key: string): unknown => source[key]
  return {
    totalInputTokens: num('totalInputTokens'),
    totalOutputTokens: num('totalOutputTokens'),
    totalTokens: num('totalTokens'),
    ...(opt('contextSize') !== undefined ? { contextSize: opt('contextSize') as number } : {}),
    ...(opt('lastInputTokens') !== undefined
      ? { lastInputTokens: opt('lastInputTokens') as number }
      : {}),
    ...(opt('summary') !== undefined ? { summary: opt('summary') as string } : {}),
    ...(opt('summaryUpToMessageId') !== undefined
      ? { summaryUpToMessageId: opt('summaryUpToMessageId') as string }
      : {}),
    ...(opt('summaryCreatedAt') !== undefined
      ? { summaryCreatedAt: opt('summaryCreatedAt') as number }
      : {}),
  }
}

function identityCellsOfAccount(account: SessionAccountState): AccountIdentityCells {
  return {
    ...(account.updatedAt !== undefined ? { updatedAt: account.updatedAt } : {}),
    ...(account.lastProvider !== undefined ? { lastProvider: account.lastProvider } : {}),
    ...(account.lastModel !== undefined ? { lastModel: account.lastModel } : {}),
  }
}

function identityCellsOfSession(session: ChatSession): AccountIdentityCells {
  const source = session as unknown as Record<string, unknown>
  return {
    ...(typeof source.updatedAt === 'number' ? { updatedAt: source.updatedAt } : {}),
    ...(typeof source.lastProvider === 'string' && source.lastProvider
      ? { lastProvider: source.lastProvider }
      : {}),
    ...(typeof source.lastModel === 'string' && source.lastModel
      ? { lastModel: source.lastModel }
      : {}),
  }
}

function record(sessionId: string, a: unknown, b: unknown): void {
  const { diff, truncated } = summarizeShadowDiff(a, b)
  appendSessionShadowLine({
    time: Date.now(),
    sessionId,
    kind: 'account',
    diff,
    ...(truncated ? { truncated } : {}),
  })
  bumpSessionShadowStats({ accountMismatches: 1 })
}

/**
 * 命令写路收尾时的那一次绝对值对拍。
 *
 * **排在微任务里**,不在命令的同步段里:流式助手占位那一路的账目事件是
 * `run/start`,而它由 `openAssistantRun` 在 `store.addMessage` **返回之后**的
 * 下一行落账(c4-d 的同一同步段)。同步段里比就是在比一份"事件还没写"的折叠 ——
 * 那不是不等,那是采样时机(与 refold 的游标守卫同一条道理)。
 *
 * 每条会话同一时刻只排一次:一个同步段里连着几条命令(收尾链)只比最后那一次的
 * 结果,比的次数少一点,比错的次数一次都不会少。
 */
const scheduled = new Set<string>()

export function scheduleSessionAccountCheck(
  sessionId: string,
  getSession: (sessionId: string) => ChatSession | undefined,
): void {
  if (!isSessionShadowEnabled()) return
  if (scheduled.has(sessionId)) return
  scheduled.add(sessionId)
  queueMicrotask(() => {
    scheduled.delete(sessionId)
    try {
      const account = peekSessionAccount(sessionId)
      if (!account) return
      const session = getSession(sessionId)
      if (!session) return
      const a = identityCellsOfAccount(account)
      const b = identityCellsOfSession(session)
      bumpSessionShadowStats({ accountChecks: 1 })
      if (deepEqual(a, b)) return
      record(sessionId, a, b)
    } catch (error) {
      log.warn('session account assertion failed', { sessionId }, error)
    }
  })
}

/**
 * 截断那一次的增量对拍(同步,就在命令收尾处)。
 *
 * `before` / `after` 是**容器**上那几格的前后快照;折叠侧交出来的是
 * `account.lastTruncation` —— 同一次截断算出来的扣减与 timeline 修复。
 * 两边不比绝对值,比"这次截断改了什么"。
 */
export function checkSessionTruncationAccount(
  sessionId: string,
  before: AccountTruncationCells | undefined,
  after: AccountTruncationCells | undefined,
): void {
  if (!isSessionShadowEnabled()) return
  try {
    if (!before || !after) return
    const account = peekSessionAccount(sessionId)
    const effect = account?.lastTruncation
    if (!effect) return

    // a = 折叠侧算的这次截断
    const a = {
      subtracted: effect.subtracted,
      contextSize: effect.patch.contextSize,
      lastInputTokens: effect.patch.lastInputTokens,
      summaryCleared: effect.deletes.includes('summary'),
    }
    // b = 容器上真的发生了什么
    const b = {
      subtracted: {
        inputTokens: Math.max(0, before.totalInputTokens - after.totalInputTokens),
        outputTokens: Math.max(0, before.totalOutputTokens - after.totalOutputTokens),
        totalTokens: Math.max(0, before.totalTokens - after.totalTokens),
      },
      contextSize: before.contextSize !== after.contextSize ? after.contextSize : undefined,
      lastInputTokens: before.lastInputTokens !== after.lastInputTokens
        ? after.lastInputTokens
        : undefined,
      summaryCleared: before.summary !== undefined && after.summary === undefined,
    }
    bumpSessionShadowStats({ accountChecks: 1 })
    if (deepEqual(a, b)) return
    record(sessionId, a, b)
  } catch (error) {
    log.warn('session account truncation assertion failed', { sessionId }, error)
  }
}

/** 仅测试:忘掉排队中的对拍。 */
export function resetSessionAccountShadow(): void {
  scheduled.clear()
}
