/**
 * 拍点辛 a 的**判据产地** —— 「当前空间里的非协作会话 + 自己是成员的协作房」。
 *
 * 设计:docs/design/search-index-2026-09.md §0 拍点辛 / §6.4b / §14.2。
 *
 * 端口的形在 `@onething/runtime/search/capabilities`(那一侧只知道「范围按
 * sessionId 收」);这里是唯一认识「空间」与「协作」的地方,而两条判据都**不是这个
 * 文件自己写的**:
 *
 *  - 「是不是协作」= `resolveCollabVenue(kind) !== 'chat'` —— 协作域那张唯一的门
 *    (`collab/tool-surface.ts` 的文件头记着:四个工具各手写一遍这句 if,漏一份
 *    就是一个静默的授权洞)。这里读它,不重写它。
 *  - 「我是不是这间房的成员」= `collabRoomVisibleUntil(room, agentId)` —— 协作
 *    `history` 工具今天用的同一个纯函数(§6.4b 末句要的正是「翻译成 messages 能力
 *    visibility 里的一支,不另写一套」)。
 *
 * ## 一处**刻意比 `history` 严**的地方
 *
 * `collabRoomVisibleUntil` 有三态:`+∞`(当前成员)、一个时间戳(**曾经**在场,只
 * 看得到移出之前)、`undefined`(从不可见)。而 `VisibilityScope` 的形是
 * `Record<facetKey, FacetFilter>` —— 一个**逐键的合取**,表达不了「这间房只到
 * 那一刻为止」(那要的是 sessionId 与 time 两格的**联合**约束,而合取会把这个时间
 * 窗施加到所有别的会话上)。
 *
 * 两条出路里选严的那条:**只收当前成员的房**(`+∞`)。于是被移出的房在 `search`
 * 里整间不可见,而 `history` 仍然照旧给到移出那一刻 —— 两个工具在这一形上口径
 * 不同,是**已知且写在这里**的取舍,不是漏。放宽它要等 facet 上能表达联合约束
 * (设计 §13 留账)。拍点辛 a 的原话是「自己是**成员**的协作房」,严的那条正是它
 * 的字面意思。
 *
 * ## 上限与截断
 *
 * 允许清单是一串 sessionId,落到 SqliteIndex 是 `df.value IN (?, ?, …)` 的绑定参数。
 * SQLite 的 `SQLITE_MAX_VARIABLE_NUMBER` 缺省 32766,而真库今天是 469 条会话 ——
 * 上限钉 `VISIBLE_SESSIONS_CAP` 在两者之间留足余量。**超了就按 `updatedAt` 倒序截断
 * 并记一条 warn**:截掉的是最冷的那些(命中概率最低),而 warn 是「这台机器上
 * 授权清单已经到顶了」的证据 —— 不是静默丢。
 */

import {
  collabRoomVisibleUntil,
  resolveCollabVenue,
} from '@onething/runtime/collab'
import type {
  SearchVisibilityPort,
} from '@onething/runtime/search/capabilities'
import type { SearchPrincipal } from '@onething/core/search'
import type { SessionMeta } from '@shared/ipc.js'
import * as store from '../../store.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('search.visibility')

/**
 * 一份允许清单最多几条。见文件头「上限与截断」。
 *
 * 这个数不是性能上限,是**诚实上限**:超过它之后这份清单就不再是「这个 agent 能看
 * 见的全部」,所以越过它的那一刻要留下痕迹。
 */
export const VISIBLE_SESSIONS_CAP = 2000

/**
 * 「这条会话属于哪个空间」。缺席 = 空串,与投影器写进 `spaceId` facet 的那一格
 * 逐字同源(`search/index/projector.ts`:`input.meta?.workspaceId ?? ''`)——
 * 两侧必须用同一个缺省,否则「没有空间的会话」在授权与索引里是两个不同的东西。
 */
function spaceOf(meta: SessionMeta): string {
  return typeof meta.workspaceId === 'string' ? meta.workspaceId : ''
}

/** 这条会话是协作场子吗。判据只有协作域那一处(见文件头)。 */
function isCollabSession(meta: SessionMeta): boolean {
  return resolveCollabVenue(meta.kind) !== 'chat'
}

/** 我此刻是这间房的成员吗(**当前**成员;曾经在场的那一态见文件头)。 */
function isCurrentMember(meta: SessionMeta, agentId: string): boolean {
  return collabRoomVisibleUntil(meta.room, agentId) === Number.POSITIVE_INFINITY
}

/**
 * 这个主体能看见哪些会话。
 *
 * `principal.sessionId` 是**这一次调用所在的那条会话**(工具从
 * `Invocation.sessionId` 带下来)。当前空间由它推出来 —— 不从别处猜:一个 agent
 * 的「当前空间」就是它此刻正在说话的那条会话所属的空间。会话表里找不到它(刚建、
 * 或是一次没有会话语境的调用)时按空串算,与 `spaceOf` 的缺省一致。
 */
export function visibleSessionIdsFor(
  principal: SearchPrincipal,
  sessions: readonly SessionMeta[],
  /**
   * 到顶时报警的口。**注入而不是直接调 `log`**:这样这只函数是纯的,用例不必为了
   * 看一句 warn 去 mock 整个日志模块(那一 mock 会把 `store.ts` 的整条 import 闭包
   * 一起换掉)。成品那一份在 `createAppSearchVisibilityPort` 里接真 logger。
   */
  onTruncate?: (detail: { agentId: string; allowed: number; cap: number }) => void,
): string[] {
  const agentId = principal.id
  const here = sessions.find(meta => meta.id === principal.sessionId)
  const space = here === undefined ? '' : spaceOf(here)

  const allowed = sessions.filter(meta => (
    isCollabSession(meta)
      // 协作房:成员判据说了算,**不问空间** —— 拍点辛 a 的第二半没有空间限定词,
      // 而房的归属本来就可能与说话人此刻所在的空间不同。
      ? isCurrentMember(meta, agentId)
      // 非协作会话:同一个空间才看得见(拍点辛 a 的第一半)。
      : spaceOf(meta) === space
  ))

  if (allowed.length <= VISIBLE_SESSIONS_CAP) return allowed.map(meta => meta.id)

  // 截断:最近活动过的留下(命中概率最高的那些),并说出来。
  const kept = [...allowed]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, VISIBLE_SESSIONS_CAP)
  onTruncate?.({ agentId, allowed: allowed.length, cap: VISIBLE_SESSIONS_CAP })
  return kept.map(meta => meta.id)
}

/**
 * 成品端口:取材是会话列表投影(**元数据**,不 load 任何会话)—— 与
 * `collab/history-tool.ts` 的 `candidateRooms` 同一条纪律:一次授权判断不该把
 * 会话仓的 LRU 顶掉。
 */
export function createAppSearchVisibilityPort(): SearchVisibilityPort {
  return {
    visibleSessionIds: principal => visibleSessionIdsFor(
      principal,
      store.getSessionsList(),
      detail => log.warn('search visibility allowlist truncated', { fields: detail }),
    ),
  }
}
