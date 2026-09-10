import { sessionCwdOf } from '../data/files-source'
import { currentSessions, onSessionsDeleted } from '../data/sessions-source'
import { useWorkbenchStore } from '../workbench/store'
import type { CompanionEnv } from '../workbench/kinds'

/**
 * **伴随面在内容层这一侧的接线**(C3,正本
 * `apps/desktop-react/docs/session-continuity-2026-09.md` §3)。
 *
 * 算法整件是纯函数(`workbench/companions.ts`)、动作整件是一只 store action
 * (`workbench.swapCompanions`)。这只文件只答两句拼贴台自己答不出的话:
 *
 *  ① **进场那条会话的工作目录是什么** —— 那本账住在会话名册上(`sessionCwdOf`
 *    是这条判据的唯一写法,面板与检索面调的也是它);
 *  ② **什么时候换** —— 环境会话变了那一拍,由 `session-projection` 叫。
 *
 * ── 为什么排在微任务里 ────────────────────────────────────────────────────
 * 与 `sweepDeadSessions` 逐字同一条:换会话那一拍会同时惊动好几台机器(树、名册、
 * 投影),而它们的先后不由这只文件决定;微任务一定排在同一次通知的全部同步反应
 * 之后,于是这一遍读到的名册与树是同一个世界的。
 *
 * ── 为什么只留「最后一次」 ────────────────────────────────────────────────
 * 一拍里连着换两条会话(列表上快速点两行)时,中间那条**没人看见过** ——
 * 给它收一次再放一次只会把甲的伴随面记到它头上。所以队里只留一条:
 * **起点是这一批的第一个 from,终点是最后一个 to**。
 *
 * ── 接线不在模块作用域 ────────────────────────────────────────────────────
 * 与 `session-projection.ts` 头上那条判例同源(这台壳里那条存量 import 环会让
 * 模块作用域里的接线读到 TDZ),所以模块只导出动作,由 `startSessionProjection`
 * 显式调一次。模块级订阅的寿命 = 这个模块实例 → 配一段 HMR 退役,复用已有那口拆卸。
 */

/** 这条会话的坐标。名册上没有它(刚删 / 还没到)= 没有 workdir,于是什么都不继承。 */
export function companionEnvOf(sessionId: string): CompanionEnv {
  return { sessionId, workdir: sessionCwdOf(currentSessions(), sessionId) }
}

/** 队里那一条待办(`null` = 队是空的)。它不是可渲染状态,是「这一拍还欠一次换」。 */
let queued: { from: string; to: string } | null = null

/**
 * 环境会话从 `from` 换到了 `to` —— 排一次伴随面收放。
 *
 * 幂等:同一对 from/to 排两次只跑一遍;`from === to` 压根不排(store 那一头也
 * 会当空动作挡掉,两处都挡是因为「不排」比「排了再空转」少惊动一次微任务队列)。
 */
export function scheduleCompanionSwap(from: string, to: string): void {
  if (from === to) return
  if (queued) {
    // 一拍里换了两次:起点仍是这一批的第一个 —— 中间那条会话没人看见过。
    queued = { from: queued.from, to }
    return
  }
  queued = { from, to }
  queueMicrotask(() => {
    const now = queued
    queued = null
    if (!now || now.from === now.to) return
    useWorkbenchStore.getState().swapCompanions(now.from, now.to, companionEnvOf(now.to))
  })
}

/** 名册那条接缝的退订口。 */
let stopDeleted: (() => void) | null = null

/**
 * 接上「会话被删 → 记录一起删」。**幂等**:重复调用先把上一次退役掉。
 *
 * 订的是 `onSessionsDeleted` 而不是 `onSessionsRemoved` —— 后者把「离开这个工作区」
 * 也说成同一句话,而伴随面的账是 per-space 家具:换工作区那一拍它正被收进
 * `byWorkspace` 留着切回来用,清掉就等于「切回去伴随面全没了」。判词在
 * `data/sessions-source.onSessionsDeleted` 上。
 */
export function startCompanionUpkeep(): () => void {
  stopCompanionUpkeep()
  stopDeleted = onSessionsDeleted((ids) => {
    useWorkbenchStore.getState().forgetCompanions(ids)
  })
  return stopCompanionUpkeep
}

/** 退役 + 把队清空。幂等。 */
export function stopCompanionUpkeep(): void {
  stopDeleted?.()
  stopDeleted = null
  queued = null
}

/*
 * 模块级可变状态(那格队 + 名册订阅)的 HMR 退役(09-01 立法)。
 * 复用已有那口拆卸,不写第二套;生产构建里 `import.meta.hot` 是 undefined。
 */
if (import.meta.hot) import.meta.hot.dispose(stopCompanionUpkeep)
