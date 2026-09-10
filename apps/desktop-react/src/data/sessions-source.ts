import { useCallback, useRef, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { SessionLifecycleEvent } from '@onething/client/events/session-lifecycle'
import {
  buildProjects,
  toPreviewMessage,
  toSessionChapter,
  toSessionMarker,
  toSessionSummary,
  sessionBelongsToSpace,
} from '../expose/projection'
import { currentSpaceId, subscribeCurrentSpace } from '../workspace/current'
import type {
  ProjectSummary,
  SessionChapter,
  SessionMarker,
  SessionPreviewMessage,
  SessionSummary,
} from '../expose/types'
import { createMutation, createQuery, createQueryFamily, messageOf, useQuery } from './kernel'
import type { Mutation, QuerySnapshot } from './kernel'
import { sessionsPort } from './sessions-port'

/**
 * 会话侧的**真数据源**(D1)。全应用一个:总览 / 检索面板会话侧 / QuickLook /
 * 钢琴键目录都从这里取,不许谁再开第二份。
 *
 * 分工与旧 mock 表逐字相同 —— 换的只是「数据从哪来」:
 *  - 形状与分组:expose/projection.ts(纯函数);
 *  - 形态机:expose/transitions.ts(纯函数);
 *  - 取数与订阅:**这里**;
 *  - 画:components/。
 *
 * ── 三层数据,三种时机 ──────────────────────────────────────────────────
 *  1. **列表**(`sessions.listMeta`):连通后拉一次,之后由 SSE 驱动;
 *  2. **章节**(`sessions.getSegments`):按会话**按需**拉(进 QuickLook / 被检索
 *     面板点名),拉过就缓存;
 *  3. **首页消息**(`sessions.getMessagesPage`):同上。
 * 二三两层从不在列表阶段批量拉 —— 一次开面拉 N 条会话的正文,那是把「按需」写成
 * 了「全量」。
 *
 * ── SSE 的判据(增量 vs 重拉) ────────────────────────────────────────────
 * 能到手的只有 `session:event`(按会话的信封)。`session:created` /
 * `session:deleted` 是**全局事件**,而当时的平台面没有开全局事件的订阅面
 * —— 所以「新建 / 删除」不能直接听见,只能从别的迹象推:
 *
 *  a. 信封的 sessionId **不在当前列表里** → 出现了我们不认识的会话 → 整表重拉
 *     (`listMeta`)。这是新建会话唯一可靠的迹象。
 *  b. `session:renamed` → **增量**:改那一条的 title(事件自带 name,不必回问)。
 *  c. 任何一条会动消息的事件(message:* / messages:replaced / stream:complete)
 *     → **增量**:把那条会话的 updatedAt 抬到信封时间(列表次序立刻跟上),
 *     并**作废**它那份首页消息与用户锚点缓存(下次要看时重拉)。
 *  d. `stream:complete` 额外作废**章节**缓存 —— 章节是一轮跑完之后才推导出来的。
 *  e. 其余事件(工具 / 权限 / 步骤 / 用量 / 账本…)对列表没有影响,一律忽略。
 *
 * 重拉一律经 `scheduleRefresh()` 合并:**≤1 次 / 秒**。一次流里几十条事件不该
 * 变成几十次 listMeta。
 *
 * ── 删除:第二条订阅(H 批,那个缺口补上了) ─────────────────────────────
 * 共享层读侧补齐 E 批给出了 `platform/session-lifecycle` 的 `onSessionLifecycle`
 * —— 同一条 `session:event` 推送面上的一层折叠,把「建 / 删」从流里认出来。
 * 于是删除不再等下一次整表重拉:收到 `deleted` 就**当场**把那批 id
 * (自己 + 级联删掉的子会话,事件自带完整名单)从列表里摘掉,并作废它们的
 * 章节 / 消息 / 锚点三份缓存。
 *
 * 两件事划清:
 *  - `created` 这一半**本批不接**,新建仍走判据 a —— 那条路已经在工作,
 *    再加一条会有两个产地说同一件事。
 *  - 删除事件本身在 `onEvent` 里被**提前挡掉**:它在删除**之前**发射,级联删掉的
 *    子会话又常常不在列表里,落到判据 a 就成了「不认识 = 有人新建了」,
 *    一次删除换来一次毫无意义的整表重拉。
 *
 * 形态机那一侧(Quick Look 正开着被删的那条 / 当前会话被删)不在这里判:
 * 数据源只管数据,摘完之后经 `onSessionsRemoved` 把 id 交出去,
 * expose/store.ts 那层壳再调纯函数 `sessionsRemoved` 夹持形态。
 *
 * ── 工作区:一本全库账,一份屏幕投影(09-01「真切换」批)───────────────────
 * `listMeta` **不带空间参数**(契约上没有这一格),它交下来的是这台机器上的
 * 全部会话。所以这里存两样东西,分工严格:
 *
 *  - **全库账** = `sessionsQuery` 那一格的 `data`:listMeta 那一份的原样,
 *    未经任何投影过滤。SSE 的增量(改名 / 抬时间 / 摘除)全都打在它身上
 *    (7e:从前是模块级 `let ledger`,现在是 query 缓存,见下文「增量落在哪」)。
 *  - **屏幕那一份**(store 里的 `sessions` / `projects`):
 *    全库账 ∩ 可陈列的形态 ∩ **当前工作区**(`visibleOf`)。
 *
 * 分这两层是为了让**切换工作区不发一次请求**:换世界只是拿同一本账重投影一次,
 * 同步完成 —— 于是没有「清空 → 骨架 → 重灌」的那一档,四律第 2 条(重拉期间旧
 * 内容留在屏上)在这里被满足得更彻底:根本没有重拉。账本本身由 SSE 保持新鲜,
 * 别的空间的会话在账上照样跟着动,切回去时次序就是对的。
 *
 * 08-31 那张 `hiddenIds` 名单随之退役:它当初存在是因为「被滤掉的会话不在
 * `state.sessions` 里,于是它们的事件会被判据 a 当成新建」。全库账里什么都有,
 * 「认不认识」直接问账本即可 —— 一个名单少一个会跟真相走散的副本。
 *
 * ── 7e 拍板一:全库账的产地是 `sessionsQuery`,不是第二份表 ──────────────────
 * 模块级那本 `ledger` 退役。它从来就是「listMeta 的答案 + SSE 增量」两件事,
 * 而这正是一格 query 的定义:`data` 是上一次成功答案,增量打在它身上。留着
 * `ledger` 就是把同一件事记两遍,而两遍迟早会漂(hiddenIds 那一案的形状)。
 *
 * 判据 a 的「认不认识这条会话」因此改问 `sessionsQuery.get().data` ——
 * `listMeta` 本来就不过滤,所以它与从前 `ledger.some(id)` **逐字同义**。
 *
 * ── 7e 拍板二:SSE 增量落在 `query.patch()`(甲案)────────────────────────────
 * 两个候选是「打进 query 缓存」与「另起一层按 id 的覆盖表」。选甲,判据是
 * **必须保住的那条性质**:「别的工作区里的会话来一条 delta 刻意不重投影」。
 *
 * 乙案(覆盖表)要新开一张会跟真相走散的副本 —— 正是上面那段刚送走的东西。
 * 甲案不新开表,而那条 `onScreen` 闸换了个更结实的说法:它从前是**手记的一格
 * 布尔**(`state.sessions.some(id)`),现在是**结果的事实** —— `republish()`
 * 先算出屏幕那一份,与上一次交出去的那张逐个比引用,一模一样就当场返回,
 * 一次 `buildProjects` 都不跑、一次 `set` 都不发。
 *
 *  · 别的空间的会话被 patch 换了对象 → 它压根不在 `visibleOf` 的结果里 →
 *    数组逐个同引用 → 不重投影(那条闸原样在);
 *  · 屏上那条被换了 → 它在结果里,引用不同 → 重投影(该重的照重);
 *  · **重拉回来答案没变** → `equals` 让 kernel 留住上一次那个数组 → 结果逐个
 *    同引用 → 整表不重渲。这一档是从前没有的:旧代码每次 `loadList` 都无条件
 *    `set(publish(...))`,于是每秒一次的重拉会把 439 张卡的行身份全换一遍(律④)。
 *
 * 手记的布尔会跟真相走散,算出来的事实不会 —— 这是同一条判例的第三次应用。
 *
 * ── 7e 拍板三:1s 合并窗留在这块面,kernel 不长这个 ──────────────────────────
 * `scheduleRefresh()` 是一层包着 `refetch()` 的**本面裁定**(「一次流里几十条
 * 事件不该变成几十次 listMeta」),它是这块面对 SSE 密度的判断,不是取数的通性。
 * `refresh()` 则保留为一只**薄函数**:它 `await` 的就是 `refetch()` 那发 promise。
 * agents / models 的「切人 / 切模型成功 → `await refresh()` → 再撤乐观牌」那条链
 * 靠的正是这一口真的等得到,所以它不许换成不 await 的 `invalidate()`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:三张表(09-01 用户令,施工纪律第一条)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 7c 动的是**按会话的三张按需缓存**(章节 / 首页消息 / 用户锚点,三族
 * `createQueryFamily`,键 = sessionId);**7e 动的是列表那一路**:`listMeta` 那一发
 * 迁 `createQuery`,`create` / `setWorkingDirectory` 迁一只 `createMutation`。
 * 两批的表分开列 —— 先列表那一路(7e),再三张按需缓存那一路(7c)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 列表那一路的三张表(7e)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 *  · 挂载   —— import 只建一只 query + 一只 mutation,**零往返、零订阅**;
 *  · 首载   —— `start()`(main.tsx 连通之后调一次):等端口 ready →
 *              **先订上三条推送 + 一条 query 订阅,再 `ensure()`**。次序即语义:
 *              拉的那一刻起的事件不能漏;query 那条订阅要在首答落地之前接上,
 *              否则第一份投影没人发布;
 *  · 换宿主 —— 列表是**全应用一份**,不跟会话走。换的只有「哪个工作区」,而那
 *              **不是**换宿主:同一格 query、同一本账,只重投影一次,一发请求都不打;
 *  · 作废   —— 判据 a(账上不认识这条会话)→ `scheduleRefresh()` → 1s 合并窗后
 *              `refetch()`。判据 b/c(改名 / 抬时间)与 lifecycle 的摘除是
 *              `patch()` 就地增量,不重拉;
 *  · 写     —— 一次建会话的寿命:`create` →(可选)`updateWorkingDirectory` →
 *              settle 里 `await refetch()` → 列表里有了它,调用方才拿得到 id。
 *              一次换目录:写 → settle 重拉(工作目录是分组的判据);
 *  · 卸载   —— `reset()`:退订四条订阅、清节流闸、query / mutation / 三族一起归零。
 *              HMR dispose 复用的就是它。
 *
 * ── ② UI 生命状态(消费者:总览 Overview)────────────────────────────────
 *  · empty   —— 拉到手是空表,或者当前工作区里一条都没有 → 「这里还没有会话」。
 *               **不回退 mock**:假数据比空更糟;
 *  · loading —— 只有首载算:`phase === 'initial'`(律①。从前是
 *               `status === 'idle' | 'loading'` 两个值压在一格里,每个消费者都得
 *               自己猜「这次 loading 是首载还是重拉」);
 *  · ready   —— 有过一次列表就永远是它,**重拉保旧**(律②),由 kernel 的
 *               keep-previous 保证,不再依赖「这里恰好没写 sessions: []」;
 *  · error   —— 后端原话落在 `sessionsQuery.get().error`,**与上一份列表并存**。
 *               屏幕上两种画法各有落点(7e 规范修正,勘察偏离 5 结掉):
 *               手上还有列表 → 表头下面一行原话,列表照留在屏上;
 *               手上一条都没有 → 整块「没连上 core」空态。从前只有后者,而它被
 *               「有卡就画卡」那条分支挡在前面 —— 于是有列表时那句错**永远画不出来**;
 *  · 超量    —— 列表是这台机器上的全部会话(几百条量级)。削量在**画**的那一侧
 *               (检索面板的 BULK 削量、总览的网格),不在数据这一层。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 *  · 读那一半不画控件,只交读数(上表);
 *  · **pending** —— 写那一半有控件:总览每个组头上的 `+`(唯一的新建入口)。
 *    它读 `useAsyncPending(sessionMutation, CREATE_KEY)`:在飞时 `aria-busy`,
 *    并且**挡住第二发**(律③要的「反馈长在发起它的那个控件上」+ 逐格,
 *    不是整面禁灰)。**零新像素** —— 这一格今天只上无障碍语义,不换任何颜色;
 *  · `setWorkingDirectory` 的格键是 `workdir:<sessionId>`。它今天的调用点
 *    (文件面「绑定…」)自己画忙态,这一格给的是**逐会话**的读数,备着;
 *  · disabled —— `+` 本身永不禁用(`aria-busy` 说的是「在飞」,不是「不可用」);
 *    连点由那道二次闸吃掉,不靠禁灰。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张按需缓存的三张表(7c)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 *  · 挂载   —— import 只建三只**空**族,零往返、零订阅。族里一格都没有,
 *              第一次 `ensureX(id)` 才建出那一格(键面由数据说了算,不是
 *              「有几条会话就先建几格」);
 *  · 首载   —— `ensureChapters/Messages/Markers(id)` = 那一格的 `ensure()`。
 *              「问过一次且不脏就什么都不做」由原语承担 —— 从前那两张
 *              `loadingChapters` / `loadingMessages` 去重表随之退役,
 *              `ensureMarkers` 从来没有的那道去重也顺手补上(勘察偏离 6);
 *  · 换宿主 —— 三张都是**跟着会话走**的东西。换会话 = 换一格键,不是重拉:
 *              上一条的答案原样留在它自己那一格里,切回去时不再问一遍;
 *  · 作废   —— SSE 说这条会话又动了(判据 c / d)→ 那一格 `invalidate()`。
 *              **这是本批列明的规范修正**:从前是把缓存整格删掉(下次 ensure
 *              重拉,屏幕先退回骨架再长回来),现在是标脏 —— 有人正看着就
 *              后台补拉、旧内容留在屏上(律②),没人看着就等下一次 ensure;
 *  · 丢格   —— 会话被删(onLifecycle deleted)→ `drop(id)`。它与作废是两件事:
 *              作废说的是「答案旧了,再问」,丢格说的是「问谁?那条已经不在了」;
 *  · 卸载   —— `reset()`:退订三条订阅 + 三族一起归零。HMR dispose 复用的就是它。
 *
 * ── ② UI 生命状态(三族共用一张,消费者各取所需)─────────────────────────
 *  · empty   —— 拉到手是空表 = 「这条会话真的没有章 / 没有消息 / 没有锚点」。
 *               目录 rail 整个不在场,Quick Look 说「还没有消息」;
 *  · loading —— **只有首载算**:`phase === 'initial' && inflight`。Quick Look 的
 *               骨架读的就是这一句(再经 `SKELETON_DELAY_MS` 防闪);重拉期间
 *               `phase` 停在 ready,骨架一次都不画;
 *  · ready   —— 有过一次答案就永远是它,重拉保旧(律②);
 *  · error   —— 三只 fetcher 都**不抛**:拉不到 = 这条会话此刻没有目录 / 没有正文
 *               可看,不是整个面的错误(逐字保留迁移前的裁定)。所以这三格的
 *               `error` 恒为 undefined,屏幕上没有它的落点;
 *  · 超量    —— 首页消息由 `PREVIEW_PAGE_SIZE` 封顶;章节 / 锚点是一条会话内部的
 *               量级,不设削量(真长到要削的那天削的是钢琴键,不是这里)。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 * 这一层不画任何控件,交出去的只有读数:
 *  · 三个 `ensureX` 是**幂等的取数**,不是按钮动作 —— 没有 pending 反馈要长在
 *    哪个控件上(律③在这条线上不适用:用户按不到它);
 *  · 唯一与交互挂钩的是 Quick Look 的骨架与目录 rail 的在场与否,判据见上表。
 * ══════════════════════════════════════════════════════════════════════════
 */

/** 重拉的最小间隔。一次流里事件密集,合并窗口就是「最多一秒一次」。 */
export const REFRESH_THROTTLE_MS = 1000

/** QuickLook 首页取多少条。够看清「最近在聊什么」,又不至于把一整条会话拖下来。 */
export const PREVIEW_PAGE_SIZE = 20

/* ── 三张按需缓存 = 三族 query,键 = sessionId ──────────────────────────── */

/**
 * 「拉不到就当作没有」这一条**留在 fetcher 里**,不上交给原语。
 *
 * 它是**这块面的裁定**而不是取数的通性(与 agents-source 那条「失败只重来一次」
 * 同一处判例):一条会话拉不到章节,说的是「它此刻没有目录可看」,不是整个
 * 总览面出了错 —— 从前那三个 `catch { = [] }` 就是这句话,原样搬进来。
 *
 * 所以三格的 `error` 恒为 undefined,而 `data` 恒为一张(可能是空的)表。
 * 哪天要把「后端说不行」与「这条真的没有」分开画,改的是这三个 fetcher 的
 * 一句 `throw`,不是每个消费者各加一条分支。
 */
async function orEmpty<T>(load: () => Promise<T[]>): Promise<T[]> {
  try {
    return await load()
  } catch {
    return []
  }
}

/** 章节(`sessions.getSegments`)。作废的判据只有 `stream:complete` —— 章是一轮跑完才推导出来的。 */
export const chaptersQuery = createQueryFamily<SessionChapter[]>('sessions.chapters', (ctx) =>
  orEmpty(async () => {
    const port = await sessionsPort()
    const response = await port.getSegments(ctx.key)
    return response.success ? (response.segments ?? []).map(toSessionChapter) : []
  }),
)

/** 首页消息(`sessions.getMessagesPage`)。Quick Look 与「进入会话」都吃这一格。 */
export const messagesQuery = createQueryFamily<SessionPreviewMessage[]>('sessions.messages', (ctx) =>
  orEmpty(async () => {
    const port = await sessionsPort()
    const response = await port.getMessagesPage(ctx.key, PREVIEW_PAGE_SIZE)
    return response.success ? (response.messages ?? []).map(toPreviewMessage) : []
  }),
)

/** 用户消息锚点(`sessions.getUserMarkers`)= 钢琴键的键,也是滚动落点的 id。 */
export const markersQuery = createQueryFamily<SessionMarker[]>('sessions.markers', (ctx) =>
  orEmpty(async () => {
    const port = await sessionsPort()
    const response = await port.getUserMarkers(ctx.key)
    return response.success ? (response.markers ?? []).map(toSessionMarker) : []
  }),
)

/* ── 列表 = 一格 query,它就是全库账 ────────────────────────────────────── */

/**
 * 「这两份列表一样吗」。
 *
 * **必须给**,而且这是本批最要紧的一格:`listMeta` 每一发都把整份 `SessionMeta`
 * 重新投影成一批**新对象**,不给 equals 的话 `Object.is` 判每次都变 —— 于是
 * 每秒一次的重拉都推进一次 `dataRev`、换一次 `data` 引用,总览那 439 张卡的行
 * 身份跟着全换一遍(律④当场破)。
 *
 * 比的是**这条会话在屏幕上的全部事实**,逐格列出来而不是写一个通用深比:
 * 哪一格变了该重画,是这块面说了算的事;将来 `SessionSummary` 多一格,这里
 * 编译不会红,所以列表里每一格都得是有人真的读过的那一格 —— 这份清单就是
 * 「屏幕认得出的变化」的定义(卡面 / 分组 / 药丸 / 徽 / 空间过滤各取所需)。
 */
function sameSession(a: SessionSummary, b: SessionSummary): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.kind === b.kind &&
    // projectId 就是归一后的 workingDirectory —— 分组的判据,变了要重分组。
    a.projectId === b.projectId &&
    a.updatedAt === b.updatedAt &&
    a.preview === b.preview &&
    a.digest === b.digest &&
    a.messageCount === b.messageCount &&
    a.model === b.model &&
    a.provider === b.provider &&
    a.agentId === b.agentId &&
    a.workspaceId === b.workspaceId &&
    // 置顶是**分节的第一道判据**(sections.ts):不比它,按下图钉之后重拉回来
    // 的那份列表会被判成「没变」,于是行不搬家,屏幕上什么都不发生。
    a.isPinned === b.isPinned &&
    // 父房间是**层级的唯一判据**(list-model.attachChildren):不比它,一条子
    // 会话被改挂到别的房间之后,树上它还挂在老地方。
    a.roomId === b.roomId
  )
}

/**
 * 列表那一发。**全库账就是它的 `data`** —— 没有第二份表(见文件头拍板一)。
 *
 * `listMeta` 不带空间参数,所以这一格是**全应用一格**(`createQuery` 而不是一族):
 * 换工作区不换格,只换投影。
 *
 * 「后端说 `success:false`」在这里是**失败**而不是空列表:回一张空表会把
 * 「没连上 core」画成「你一条会话都没有」,那是编。抛出去之后 kernel 记进
 * `error` 并**留住上一份列表**(错误与旧数据共存,律②的另一半)。
 */
export const sessionsQuery = createQuery<readonly SessionSummary[]>(
  'sessions.list',
  async () => {
    const port = await sessionsPort()
    const response = await port.listMeta()
    if (!response.success) throw new Error(response.error || 'sessions.listMeta 未成功')
    return (response.sessions ?? []).map(toSessionSummary)
  },
  { equals: (a, b) => a.length === b.length && a.every((s, i) => sameSession(s, b[i])) },
)

/**
 * 建会话的结果。**成败是两种形状**而不是一个可空 id:失败时那句人话必须有地方
 * 放,让调用方原样说给用户听(后端说的错不许被换成一句「操作失败」)。
 */
export type CreateSessionOutcome =
  | {
      ok: true
      sessionId: string
      /**
       * 第二步(落目录)失败时后端的原话。会话本身建成了(ok 仍是 true),
       * 但它没有归进那个项目 —— 调用方要把这句说给用户听,不许无声。
       * 08-31 真机账单:壳走 http 面,沙箱夹持把落目录逐次拒掉,而这里以前
       * 只 catch 异常、不看 `success:false`,错误无声蒸发,会话落成空目录,
       * claude-code-agent 因「未绑定工作目录」拒启。
       */
      workdirError?: string
    }
  | { ok: false; error: string }

export interface SessionsSourceState {
  /*
   * **屏幕那一份**:全库账 ∩ 可陈列的形态 ∩ 当前工作区。三格的形状 7e 一字未改
   * (15 个消费者的选择器原样成立),换的只是产地:从前是模块级 `ledger` 的投影,
   * 现在是 `sessionsQuery.data` 的投影,经 `republish()` 发布。
   */
  sessions: SessionSummary[]
  projects: ProjectSummary[]

  /*
   * 「读到哪一步了」**不在这里** —— 那是 `sessionsQuery` 那一格的四个读数
   * (`phase` / `inflight` / `error` / `data`)。从前压成一个
   * `status: 'idle'|'loading'|'ready'|'error'`,于是「首载」与「重拉」在消费侧
   * 分不开,而分不开正是「重拉时画骨架 = 告诉用户你刚才看的东西没了」那种闪的
   * 病根(kernel/query.ts 文件头)。组件侧的读法是本文件末尾的 `useSessionsList()`。
   *
   * 按会话的三张缓存也不在这里 —— 它们是 `chaptersQuery` / `messagesQuery` /
   * `markersQuery` 三族(键 = sessionId,见文件头三张表)。留一份转发的壳只会
   * 变成第二份真相(kernel 手册「迁移一个 source 的步骤」第 2 条)。
   */

  /** 连通后启动:拉一次列表 + 订上 SSE。幂等。 */
  start: () => Promise<void>
  /**
   * 立刻整表重拉(不经节流)—— 只给「明知列表脏了」的地方用。
   *
   * 它是一只**薄函数**:`await` 的就是 `sessionsQuery.refetch()` 那发 promise。
   * agents / models 的「切人 / 切模型成功 → `await refresh()` → 再撤乐观牌」那条
   * 链靠的正是这一口真的等得到答案落地,所以**不许**换成不 await 的 `invalidate()`。
   */
  refresh: () => Promise<void>
  /**
   * 建一条会话,落在 `projectId` 这个项目下(null = 不属于任何项目)。
   *
   * 三件事,次序即语义:
   *  1. `sessions.create` —— 名字不给,后端落它自己的默认名(见 sessions-port);
   *  2. `sessions.updateWorkingDirectory` —— 只在 projectId 非空时打这一发。
   *     它**失败不回滚**:会话已经真的建出来了,把它删掉换来的是「我按了新建,
   *     什么都没有发生」;落错组比凭空消失轻,所以这一步只把错说出去
   *     (返回成功 + 让列表重拉),分组按后端的事实走;
   *  3. 对账 —— `sessionMutation` 的 `settle` 里 `await sessionsQuery.refetch()`,
   *     而这一口**同步等它**(`await reconcile`),不走节流。调用方紧接着就要
   *     `enterSession`,而那条路要拿新会话去夹持焦点序列;列表还没有它的话,
   *     焦点会退到别处。等 settle 的把手与 agents / models 逐字同形。
   *
   * 这一层不认识形态机,也不弹通知 —— 它只把结果交出去(与 `onSessionsRemoved`
   * 同一条接缝纪律)。
   */
  create: (projectId: string | null) => Promise<CreateSessionOutcome>
  /**
   * 给一条**已经存在**的会话换工作目录(文件面「绑定…」那一条走它)。
   *
   * 与 `create` 里那一步是同一发 RPC,但语义不同,所以是两口:那一步是
   * 「新建的这条落在哪个项目下」(失败不回滚,因为会话已经建出来了),
   * 这一口是「把这条会话挪到这个目录」—— 失败就是失败,原话交给调用方去说。
   *
   * 成功后**同步重拉列表**:工作目录是分组的判据(`expose/projection.ts`),
   * 不重拉的话左栏还挂在老项目下,而文件树的根已经换了 —— 两处说两句话。
   */
  setWorkingDirectory: (
    sessionId: string,
    workingDirectory: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  /**
   * 置顶 / 取消置顶一条会话。
   *
   * 与 `setWorkingDirectory` 同形(一发写 + 一次同步对账),但对账的必要性
   * 更硬:那一口后端好歹会让别处的读重新算,这一口**一条事件都不推**——
   * 不重拉的话按下图钉之后列表一动不动,用户会以为没点上。
   */
  setPinned: (
    sessionId: string,
    isPinned: boolean,
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  /**
   * 三只「确保问过一次」。签名与迁移前逐字相同(调用点一个字不改),内部就是
   * 对应族那一格的 `ensure()` —— 去重、缓存、脏标记全由原语承担。
   */
  ensureChapters: (sessionId: string) => Promise<void>
  ensureMessages: (sessionId: string) => Promise<void>
  ensureMarkers: (sessionId: string) => Promise<void>
  /** 测试用:回到未启动的干净态(并退订)。 */
  reset: () => void
}

/** 会动消息的那批事件 —— 判据 c。 */
const MESSAGE_EVENTS: string[] = [
  SESSION_EVENT_TYPES.MESSAGE_CREATED,
  SESSION_EVENT_TYPES.MESSAGE_USER_CREATED,
  SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED,
  SESSION_EVENT_TYPES.MESSAGE_UPDATED,
  SESSION_EVENT_TYPES.MESSAGE_DELETED,
  SESSION_EVENT_TYPES.MESSAGES_REPLACED,
  SESSION_EVENT_TYPES.STREAM_COMPLETE,
]

/*
 * 屏幕那一份的投影。09-04 P2 之后它只剩两格 —— `groups` 随
 * `projection.buildGroups` 一起退役(分组不再是投影的事,列表模型是
 * `expose/list-model.buildListModel`,项目降级成侧栏的一格范围)。
 */
function project(sessions: SessionSummary[]): Pick<SessionsSourceState, 'sessions' | 'projects'> {
  return { sessions, projects: buildProjects(sessions) }
}

/**
 * **全库账**的读法 —— `listMeta` 交下来那一份的原样(未经形态过滤、未经空间过滤)。
 * 见文件头「一本全库账,一份屏幕投影」与拍板一:它**就是** `sessionsQuery` 的
 * `data`,没有第二份表。还没拉到手时是一张恒等的空表(不是 undefined ——
 * 「还没问过」这件事由 `phase` 说,不该逼每个读账的地方各写一条空判)。
 */
const NO_SESSIONS: readonly SessionSummary[] = []

function ledger(): readonly SessionSummary[] {
  return sessionsQuery.get().data ?? NO_SESSIONS
}

/**
 * 屏幕上那一份的**唯一**判据:当前工作区。
 *
 * 09-04 少了一条 —— 从前还有一道「可陈列的形态」(把群房与执行会话整个滤掉),
 * 那是卡网格铺不下层级时的权宜。方向 A 把层级铺开了(房间与聊天同一条时间轴、
 * work / agent 挂在父房间下),于是**没有一档需要被藏**:这一层交出全部形态,
 * 谁站顶层、谁当子行由 `expose/list-model.ts` 说了算。
 *
 * 空间过滤留着:它不是「藏起来」而是「不属于这个世界」。
 */
function visibleOf(all: readonly SessionSummary[]): SessionSummary[] {
  const spaceId = currentSpaceId()
  return all.filter((s) => sessionBelongsToSpace(s, spaceId))
}

/**
 * 就地打一个增量到全库账上(改名 / 抬时间 / 摘除三处共用这一口)。
 *
 * `next` **没东西可改时必须原样返回那张表** —— 这一句是「不重投影」那条闸的
 * 上半截:引用没换 = 这里连 `patch` 都不发,于是没有 emit、没有 `dataRev` 前进、
 * 没有一次白跑的 `republish`。下半截在 `republish` 里(算出来的屏幕那一份逐个
 * 比引用)。两截合起来才是从前那个手记的 `onScreen` 布尔,而且它们都是**事实**
 * 而不是记账,不会跟真相走散。
 *
 * 账上还没有答案(首载还没落地)时什么都不做:那时候唯一说得准的事是「不认识」,
 * 而不认识走的是判据 a 的整表重拉,不是增量。
 */
function patchLedger(next: (all: readonly SessionSummary[]) => readonly SessionSummary[]): void {
  const current = sessionsQuery.get().data
  if (!current) return
  const updated = next(current)
  if (updated === current) return
  sessionsQuery.patch(updated)
}

/** 模块级的订阅句柄与节流闸 —— 它们是「这一个进程的事实」,不是可渲染状态。 */
let unsubscribe: (() => void) | undefined
let unsubscribeLifecycle: (() => void) | undefined
let unsubscribeSpace: (() => void) | undefined
let started = false
let lastRefreshAt = 0
let refreshTimer: ReturnType<typeof setTimeout> | undefined
/**
 * 最近一次**对账**(`settle` 里那发重拉)的把手。
 *
 * `createMutation` 的 settle **不被 await** —— 对账是后台的事,不该把控件多按住
 * 一拍(理由写在 kernel 的 `mutation.ts` 里)。但 `create` 对调用方是有承诺的:
 * 「回来的那一刻新会话已经在列表与分组里」。所以两件事各归各位:**控件**的忙态
 * 在 settle 之前解除(律③要的那一拍),**action 自己**多等这一口。
 * 与 `agents-source.ts` / `models-source.ts` / `workspace/store.ts` 逐字同形。
 */
let reconcile: Promise<void> | undefined

/**
 * 「有会话被摘掉了」的通知面。
 *
 * 数据源不认识形态机(反向依赖:expose/store.ts 已经在 import 这个文件),所以
 * 这里只把摘掉的 id 交出去,由那层壳自己决定形态怎么夹持 —— 与 `currentSessions()`
 * 是同一条接缝的两个方向。
 */
export type SessionsRemovedListener = (removedIds: readonly string[]) => void

const removedListeners = new Set<SessionsRemovedListener>()

/** 订阅「有会话被摘掉了」。返回退订函数。 */
export function onSessionsRemoved(listener: SessionsRemovedListener): () => void {
  removedListeners.add(listener)
  return () => removedListeners.delete(listener)
}

const deletedListeners = new Set<SessionsRemovedListener>()

/**
 * 订阅「有会话**真的被删了**」(C3)。返回退订函数。
 *
 * ── 它为什么不是 `onSessionsRemoved` 的一个用法 ──────────────────────────
 * 上面那条把「被删」与「离开这个工作区」**说成同一句话**,而且那是对的:对形态机
 * 而言两者一模一样(那张卡不在序列里了)。但对**按工作区各持一份的账**而言它们
 * 是相反的两件事 —— 换工作区那一拍,`bindPerSpace` 正把那本账**收进** `byWorkspace`
 * 留着切回来用,而这条通知如果也到,收进去的那一份会当场被清空:切回去伴随面全没了。
 *
 * 所以这一条只从 `onLifecycle`(`deleted` 那一支)发,`onSpaceChanged` **不发**。
 * 两条通知面各说各的一句话,这正是那句「多一条通知面就多一个会跟它走散的规则」
 * 的反面用法:它们本来就不是一句话,合并才是走散的开始。
 */
export function onSessionsDeleted(listener: SessionsRemovedListener): () => void {
  deletedListeners.add(listener)
  return () => deletedListeners.delete(listener)
}

/**
 * 一条会话的三份按需缓存一起丢掉(`drop` 对没建过的键是恒等变换,
 * 所以级联名单里那些从来没人问过的 id 不会在这里各建一格)。
 */
function dropSessionCaches(sessionId: string): void {
  chaptersQuery.drop(sessionId)
  messagesQuery.drop(sessionId)
  markersQuery.drop(sessionId)
}

/* ── 写:一只 mutation,两口一个联合 ────────────────────────────────────── */

/**
 * 忙态格子的**唯一词表**。发起的控件与这里共用它 —— 两头各拼一次就是两处会漂
 * (与 `agents-source.switchKey` / `models-source.selectKey` 同一条)。
 *
 * 建会话没有 sessionId 可当格键(那正是它要建出来的东西),所以它是**一格常量**:
 * 「此刻正在建一条会话」全应用只有一件事,连点几下也只该有一发。
 */
export const CREATE_KEY = 'create'

export function workdirKey(sessionId: string): string {
  return `workdir:${sessionId}`
}

/**
 * 置顶那一口的忙态格键。与换目录一样**按会话分格** —— 一次只置顶一条,
 * 别的行的图钉不该跟着转(律③:反馈长在发起它的那个控件上)。
 */
export function pinKey(sessionId: string): string {
  return `pin:${sessionId}`
}

/**
 * 一次写要带的全部东西。两口一个联合,`kind` 同时是分派与对账口径的产地:
 *  · `create`  —— 建一条会话(可选落目录)。成功后**同步重拉**;
 *  · `workdir` —— 给一条已存在的会话换工作目录。成功后**同步重拉**
 *                 (工作目录是分组的判据,不重拉左栏就还挂在老项目下)。
 *
 * 两口共一只 mutation 的理由与 `AgentWrite` / `ModelWrite` 逐字相同:同一件事
 * (「写完要不要对账、对账怎么等」)只该有一处产地。
 */
export type SessionWrite =
  | { kind: 'create'; projectId: string | null }
  | { kind: 'workdir'; sessionId: string; workingDirectory: string }
  /**
   * 置顶 / 取消置顶。成功后**同步重拉**,理由比换目录还硬:后端这一口
   * **一条事件都不推**(`updateOnethingSessionPinForIpc` 不叫
   * `notifySessionIndexChanged`),不对账的话屏幕永远不知道自己改成了。
   */
  | { kind: 'pin'; sessionId: string; isPinned: boolean }

/** 换目录那一口的答案。成败两种形状,失败带后端原话。 */
export type WorkdirOutcome = { ok: true } | { ok: false; error: string }

/** 置顶那一口的答案。与换目录同形(同一种「改一条会话的一格」)。 */
export type PinOutcome = { ok: true } | { ok: false; error: string }

/**
 * 这只 mutation 的答案,**带着 `kind` 标签**。
 *
 * 标签不是装饰:两口的成功形状不一样(建会话那一路的成功答案里有 `sessionId`
 * 和可能的 `workdirError`),没有标签就得靠 `'sessionId' in outcome` 这种
 * 结构探测去 narrow —— 那是把「哪一口」这件已知的事**再猜一遍**。
 */
export type SessionWriteResult =
  | { kind: 'create'; outcome: CreateSessionOutcome }
  | { kind: 'workdir'; outcome: WorkdirOutcome }
  | { kind: 'pin'; outcome: PinOutcome }

/**
 * **这只 mutation 的失败通道是返回值,不是抛出** —— 与 agents / models 那两只
 * 刻意不同,理由是这块面的接缝纪律与答案的形状,不是偷懒:
 *
 *  1. 这一层**不弹通知**:失败那句人话要原样交给调用方(`expose/store.newSession`
 *     / 文件面),由它去说。抛出的话 `mutation.run` 会把它吞成 `undefined`
 *     (原语的明文契约:「失败已经在这里处理完了,再抛一遍只会逼每个调用点写
 *     一个空 catch」),那句原话就到不了调用方手里;
 *  2. 建会话那一路的 `workdirError` **长在成功那一条路上** —— 会话建成了、只是
 *     没归进项目。一个只有「成 / 败」两档的异常通道根本表达不了它。
 *
 * 所以这里把「后端说不行」读成**一个答案**而不是一次异常;真正的异常
 * (端口自己抛)在 run 里当场收成同一种答案,与迁移前那两段 try/catch 逐字同效。
 */
export const sessionMutation: Mutation<SessionWrite, SessionWriteResult> = createMutation<
  SessionWrite,
  SessionWriteResult
>('sessions.write', {
  key: (input) => {
    if (input.kind === 'create') return CREATE_KEY
    return input.kind === 'pin' ? pinKey(input.sessionId) : workdirKey(input.sessionId)
  },

  run: async (input) => {
    const port = await sessionsPort()
    if (input.kind === 'workdir') {
      return { kind: 'workdir', outcome: await updateWorkdir(port, input.sessionId, input.workingDirectory) }
    }
    if (input.kind === 'pin') {
      return { kind: 'pin', outcome: await updatePin(port, input.sessionId, input.isPinned) }
    }

    let created
    try {
      // **归属当场落定**:后端不认识「当前空间」(那是 window 级状态),
      // 所以每次建都得显式带上 —— 漏了这一格,新会话会静默落进 default,
      // 而用户明明站在别的工作区里(Vue 壳 `stores/sessions.ts:699` 同一手)。
      created = await port.create({ workspaceId: currentSpaceId() })
    } catch (error) {
      return { kind: 'create', outcome: { ok: false, error: messageOf(error) } }
    }
    if (!created?.success || !created.session?.id) {
      return { kind: 'create', outcome: { ok: false, error: created?.error || 'sessions.create 未成功' } }
    }
    const sessionId = created.session.id
    if (!input.projectId) return { kind: 'create', outcome: { ok: true, sessionId } }

    // 落目录失败不回滚(理由见 `CreateSessionOutcome`):会话已经在了,只是没归
    // 到那个项目。但失败**必须说出去** —— 从前这里吞异常、也不看应答的
    // `success:false`,沙箱拒绝(http 面)就这样无声蒸发过一回。
    const landed = await updateWorkdir(port, sessionId, input.projectId)
    return {
      kind: 'create',
      outcome: landed.ok ? { ok: true, sessionId } : { ok: true, sessionId, workdirError: landed.error },
    }
  },

  /*
   * 对账:三口同一句话 —— **写成了就重拉一次列表**。
   *
   * 建会话那一路即便带着 `workdirError` 也照样重拉(`outcome.ok` 仍是 true):
   * 分组要按**后端的事实**走,而不是按我们以为落成了的那个目录。
   * 写没成(建都没建出来 / 目录被拒)则一发都不发 —— 列表没有任何理由变。
   */
  settle: (result) => {
    if (!result.outcome.ok) return
    reconcile = sessionsQuery.refetch()
  },
})

/**
 * 置顶那一发的两种「没成」收成同一种答案 —— 与换目录逐字同一手。
 *
 * **它必须看 `success`**:后端 `updateOnethingSessionPinForIpc` 连返回值都不看
 * (设计 §7 留账),前端再不看就成了两头都不看 —— 那正是 08-31 沙箱拒绝
 * 无声蒸发的同一种病。
 */
async function updatePin(
  port: Awaited<ReturnType<typeof sessionsPort>>,
  sessionId: string,
  isPinned: boolean,
): Promise<PinOutcome> {
  try {
    const updated = await port.updatePin(sessionId, isPinned)
    if (!updated?.success) {
      return { ok: false, error: updated?.error || 'sessions.updatePin 未成功' }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/** 换目录那一发的两种「没成」收成同一种答案:后端说不行,与端口自己抛。 */
async function updateWorkdir(
  port: Awaited<ReturnType<typeof sessionsPort>>,
  sessionId: string,
  workingDirectory: string,
): Promise<WorkdirOutcome> {
  try {
    const updated = await port.updateWorkingDirectory(sessionId, workingDirectory)
    if (!updated?.success) {
      return { ok: false, error: updated?.error || 'sessions.updateWorkingDirectory 未成功' }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * 把全库账重投影成屏幕那一份并发布。**账变了只经这一口**。
 *
 * 它住在模块级、订在 `sessionsQuery` 上,而**不是**由 `start()` 打开的:
 * 「屏幕那一份是账本的投影」是一句常设的事实,不是某个动作开出来的功能。
 * 挂在 start 上的话,`refresh()`(agents / models 的对账、写完之后的重拉)在
 * 没启动过的进程里就会更新账本却不更新屏幕 —— 那正是「谁负责发布」变成一格
 * 要维护的记账的样子。
 *
 * 那道「不重投影」的闸的下半截就在这里:先算出屏幕那一份,与上一次交出去的
 * 那张**逐个比引用**;一模一样就当场返回 —— 一次 `buildProjects` 都不跑、
 * 一次 `setState` 都不发,于是订着 `sessions` / `projects` 的组件一个都不重渲
 * (律④)。
 *
 * 它同时吃下三种「白重投影」:
 *  · 别的工作区里的会话来一条 delta(它压根不在 `visibleOf` 的结果里);
 *  · 重拉回来答案没变(`equals` 让 kernel 留住上一次那个数组,元素同引用);
 *  · 一发在飞 / 落地的来回(那只动 `inflight`,`data` 一个字没变)。
 *
 * 手记一格 `onScreen` 布尔也能挡掉第一种,但那是**记账**,记账会跟真相走散;
 * 这里挡的判据是**算出来的事实**,没有第二份东西要维护。
 */
function republish(): void {
  const visible = visibleOf(ledger())
  const held = useSessionsSource.getState().sessions
  if (held.length === visible.length && held.every((s, i) => s === visible[i])) return
  useSessionsSource.setState(project(visible))
}

export const useSessionsSource = create<SessionsSourceState>()((set, get) => {
  /** 合并重拉:窗口内的多次请求塌成末尾一次。 */
  function scheduleRefresh(): void {
    if (refreshTimer) return
    const wait = Math.max(0, lastRefreshAt + REFRESH_THROTTLE_MS - Date.now())
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      lastRefreshAt = Date.now()
      void sessionsQuery.refetch()
    }, wait)
  }

  function onEvent(envelope: SessionEventEnvelope): void {
    const { sessionId } = envelope
    const type = envelope.event?.type
    if (!sessionId || typeof type !== 'string') return

    // 删除走另一条订阅(onLifecycle,它还带着级联名单)。这里必须**先挡**:
    // 事件在删除之前发射、级联子会话又常常不在列表里,落到判据 a 就成了
    // 「不认识 = 有人新建了」,一次删除换来一次毫无意义的整表重拉。
    if (type === SESSION_EVENT_TYPES.SESSION_REMOVED) return

    // 判据 a:**全库账**里没有这条 = 有人新建了一条,只能整表重拉。
    // 问账本(`sessionsQuery` 的 data)而不是问屏幕那一份:被形态过滤掉的执行会话、
    // 以及别的工作区里的会话都在账上,它们的事件不该被当成新建(08-31 那张
    // hiddenIds 名单就是干这个的,全库账上线之后它没有存在的理由了)。
    // `listMeta` 本来就不过滤,所以这一问与从前 `ledger.some(id)` 逐字同义。
    const known = ledger().some((s) => s.id === sessionId)
    if (!known) {
      scheduleRefresh()
      return
    }

    // 判据 b:改名自带新名字,一格增量就够。
    if (type === SESSION_EVENT_TYPES.SESSION_RENAMED) {
      const name = (envelope.event as { name?: string }).name
      if (typeof name !== 'string') return
      // 名字没变 = 原样返回那张表 = 连 patch 都不发(见 patchLedger)。
      patchLedger((all) =>
        all.some((s) => s.id === sessionId && s.title !== name)
          ? all.map((s) => (s.id === sessionId ? { ...s, title: name } : s))
          : all,
      )
      return
    }

    // 判据 c / d:消息动了 → 抬时间 + 作废这条会话的按需缓存。
    if (MESSAGE_EVENTS.includes(type)) {
      // 抬不动就不抬(信封比账上还旧):同样是原样返回,一次白重投影都没有。
      patchLedger((all) =>
        all.some((s) => s.id === sessionId && s.updatedAt < envelope.timestamp)
          ? all.map((s) =>
              s.id === sessionId ? { ...s, updatedAt: Math.max(s.updatedAt, envelope.timestamp) } : s,
            )
          : all,
      )
      /*
       * 作废**无条件**:三份按会话缓存与「这条会话此刻在不在屏上」无关,
       * 少作废一次就会在切回那个工作区时拿一份陈的正文出来画。
       *
       * **本批的规范修正**:从前这里是把那一格整个删掉(`delete messages[id]`),
       * 于是正开着 Quick Look 的人会看见「内容消失 → 骨架 → 重新长出来」。
       * 现在是标脏 —— 有人正订着这一格就后台补拉、旧内容留在屏上(律②),
       * 没人订就只留个脏标记,下一次 `ensureX` 才真去问。
       *
       * `invalidate(key)` 对没建过的键什么都不做,所以「一条从来没人看过的会话
       * 在刷屏」不会在这里凭空建出三格。
       */
      messagesQuery.invalidate(sessionId)
      markersQuery.invalidate(sessionId)
      // 判据 d:章是一轮跑完才推导出来的,所以只有 stream:complete 动它。
      if (type === SESSION_EVENT_TYPES.STREAM_COMPLETE) chaptersQuery.invalidate(sessionId)
      /*
       * 重投影不在这里发。`patchLedger` 换了账本引用就会 emit,`republish` 那条
       * 订阅接着跑,而它自己会判「屏幕那一份到底变没变」——
       * **别的工作区里的流不该每条 delta 重排一次本区列表**这条闸原样在,
       * 只是判据从手记的一格布尔换成了算出来的事实(见 `republish` 的注释)。
       */
    }
    // 判据 e:其余一律忽略。
  }

  /**
   * 会话被删:当场摘除 + 作废三份缓存 + 通知形态机。
   *
   * 摘的是**事件自带的整份级联名单**而不只是信封上那一条:删一间房会连着删掉
   * 它的子会话,每条各来一次事件,但每一条都带着完整名单 —— 按名单摘是幂等的,
   * 所以级联的第二、三条事件到达时是恒等变换,不会各摘一次各重投影一次。
   *
   * 缓存**丢格**(不是标脏):一条会话可以不在列表里(级联子会话)却在缓存里
   * 躺着。这里用 `drop` 而不是 `invalidate` —— 「这条会话没了」不是「答案旧了」,
   * 标脏会让还订着它的那一格当场后台补拉一发注定问不着的请求。
   * 正在飞的那两个按需请求不管:它们落地时写进的是一格已经被摘掉的 query,
   * 而半路抽掉在飞的那一发只会换来一次重复请求。
   */
  function onLifecycle(event: SessionLifecycleEvent): void {
    // `created` 不接:新建仍由判据 a 认出,两个产地说同一件事就会打架(见文件头)。
    if (event.type !== 'deleted') return
    const gone = new Set(event.cascadedSessionIds.filter((id) => typeof id === 'string' && id))
    if (gone.size === 0) return

    // 摘的是**全库账**:级联子会话常常既不在屏上、也不在当前工作区里,
    // 只摘屏幕那一份会让它们留在账上,下一条事件又把判据 a 骗成「有人新建」。
    //
    // 「账上一条都没摘掉 = 不重投影」这一句仍然在,只是搬了家:`patchLedger` 的
    // `next` 在没摘掉任何一条时**原样返回那张表**,于是连 patch 都不发。
    // 这一句护的是列表的行身份(律④)。
    for (const id of gone) dropSessionCaches(id)
    patchLedger((all) => {
      const next = all.filter((s) => !gone.has(s.id))
      return next.length === all.length ? all : next
    })

    // 通知在摘除之后:形态机拿到的那份分组事实必须是**摘除之后**的,
    // 否则「焦点退到新序列首」会退到一张马上就要消失的卡上。
    // 哪怕这一条对我们是恒等变换也照发 —— 屏幕上可能正开着它的 Quick Look。
    for (const listener of removedListeners) listener([...gone])
    // 「真的被删」那一条只在这里发(判词在 `onSessionsDeleted` 上)。
    for (const listener of deletedListeners) listener([...gone])
  }

  /**
   * 换了工作区 —— **同一本账重投影一次,一发请求都不打**。
   *
   * 三件事,次序即语义:
   *  1. 先记下换之前屏上有哪些 id(离场名单要拿它算);
   *  2. `republish()` 用新的当前工作区重算屏幕那一份 —— 同步完成,
   *     所以从旧世界到新世界首屏之间**没有一帧空屏**,骨架一次都不画
   *     (四律第 2 条在这里是「根本没有重拉」而不是「重拉期间留旧的」);
   *  3. 把离场的 id 交给 `onSessionsRemoved` 那条既有接缝 —— 形态机据此夹持焦点、
   *     关掉正开着的 Quick Look、清掉 `currentSessionId`。「离场」与「被删」对
   *     形态机是同一件事(那张卡不在序列里了),所以复用那一条而不是新开一条:
   *     多一条通知面就多一个会跟它走散的焦点夹持规则。
   *
   * **账本一个字不动**:别的工作区的会话仍然在账上、仍然收 SSE 增量。切回去时
   * 次序是对的,而且照样不必重拉。
   */
  function onSpaceChanged(): void {
    const before = new Set(get().sessions.map((s) => s.id))
    republish()
    const left = [...before].filter((id) => !get().sessions.some((s) => s.id === id))
    if (left.length === 0) return
    for (const listener of removedListeners) listener(left)
  }

  return {
    sessions: [],
    projects: [],

    start: async () => {
      if (started) return
      started = true
      const port = await sessionsPort()
      await port.ready()
      // 先订上再拉:拉的那一刻起的事件不能漏(与 D0 连通面同一条理由)。
      unsubscribe = port.onSessionEvent(onEvent)
      unsubscribeLifecycle = port.onSessionLifecycle(onLifecycle)
      // 换工作区也一样先订上:工作区列表是异步读的,首次读到时 currentSpaceId()
      // 可能从「persist 槽里那个」解析成别的(那个空间被删了),这一下也要重投影。
      unsubscribeSpace = subscribeCurrentSpace(onSpaceChanged)
      lastRefreshAt = Date.now()
      await sessionsQuery.ensure()
    },

    refresh: async () => {
      lastRefreshAt = Date.now()
      await sessionsQuery.refetch()
    },

    create: async (projectId) => {
      const result = await sessionMutation.run({ kind: 'create', projectId })
      // 对账排在忙态解除之后(kernel 的裁定),但这一口**必须等它**:调用方
      // 紧接着就要拿新会话去夹持焦点序列(见 `create` 的接口注释)。
      await reconcile
      /*
       * `run` 只在 `run` 自己抛出时给 undefined,而这只 mutation 的 run 不抛
       * (失败是返回值,见它头上那段)。这一句因此永远走不到 —— 留着它是因为
       * 它是「原语契约变了」时唯一不会静默的地方:真走到这里,用户看见的是
       * 一句话而不是一次什么都没发生的点击。
       */
      if (result?.kind !== 'create') return { ok: false, error: 'sessions.create 未成功' }
      return result.outcome
    },

    setWorkingDirectory: async (sessionId, workingDirectory) => {
      // 空 id 连一发都不打:它不是一次失败的写,是一句问错了的话。
      if (!sessionId) return { ok: false, error: 'sessionId 为空' }
      const result = await sessionMutation.run({ kind: 'workdir', sessionId, workingDirectory })
      // 成功后**同步重拉**(工作目录是分组的判据):等的就是 settle 那一发,
      // 回来的那一刻左栏与文件树说的是同一句话。
      await reconcile
      // 与 `create` 同一句兜底,理由也同一条(见那里)。
      if (result?.kind !== 'workdir') return { ok: false, error: 'sessions.updateWorkingDirectory 未成功' }
      return result.outcome
    },

    /*
     * ── 置顶:**就地更新**在前,重拉对账在后(交互四律第 1 条)─────────────
     * 从前这里是「打一发 → 等 settle → 等重拉 → 行才搬家」,一次往返里那一行
     * 纹丝不动 —— 而置顶恰恰是**结果全在屏幕上**的动作(行要跳到「置顶」那一节)。
     *
     * 所以先在本地账本上把 `isPinned` 翻掉(与 SESSION_RENAMED 那一格增量补丁
     * 逐字同一手:`patchLedger` 换引用才 emit,值没变连 patch 都不发),
     * 再打那一发;**没成就把补丁翻回去**。后端 pin 不推事件(设计 §7 留账),
     * 所以这条乐观补丁不是「抢在事件前面」,它是这条路上唯一的即时反馈。
     *
     * 注意补丁只翻这一格:`sameSession` 已经比 `isPinned`(P0 补的),
     * 所以翻掉就一定重投影;别的字段照旧等重拉那一份权威覆盖。
     */
    setPinned: async (sessionId, isPinned) => {
      // 空 id 连一发都不打:它不是一次失败的写,是一句问错了的话(同上口)。
      if (!sessionId) return { ok: false, error: 'sessionId 为空' }
      const flip = (want: boolean) =>
        patchLedger((all) =>
          all.some((s) => s.id === sessionId && s.isPinned !== want)
            ? all.map((s) => (s.id === sessionId ? { ...s, isPinned: want } : s))
            : all,
        )
      flip(isPinned)
      const result = await sessionMutation.run({ kind: 'pin', sessionId, isPinned })
      // 成功后**同步重拉**:重拉那一份才是权威,乐观补丁只负责这一个往返里的手感。
      await reconcile
      // 与 `create` / `setWorkingDirectory` 同一句兜底,理由也同一条(见那里)。
      const outcome: PinOutcome =
        result?.kind === 'pin' ? result.outcome : { ok: false, error: 'sessions.updatePin 未成功' }
      // 没成就把乐观那一笔翻回去 —— 屏幕上不许留一条后端并不认的置顶。
      if (!outcome.ok) flip(!isPinned)
      return outcome
    },

    /*
     * 三只 ensure 现在是**薄的**:空 id 挡掉(空串不是一条会话),其余原样交给
     * 那一族的 `ensure()`。三条从前各自手写的东西 —— 「拉过了就别再拉」
     * (`sessionId in table`)、「有一发在飞就别发第二发」(那两张 loading 表)、
     * 「拉不到就缓存成空表」(catch) —— 分别由原语的脏标记、并发折叠与
     * 上面那只 `orEmpty` 接手。`ensureMarkers` 从前**没有**去重表(同帧双发会真的
     * 发两次,勘察偏离 6),现在三条走同一条路,那个偏离自动结掉。
     */
    ensureChapters: async (sessionId) => {
      if (!sessionId) return
      await chaptersQuery.get(sessionId).ensure()
    },

    ensureMessages: async (sessionId) => {
      if (!sessionId) return
      await messagesQuery.get(sessionId).ensure()
    },

    ensureMarkers: async (sessionId) => {
      if (!sessionId) return
      await markersQuery.get(sessionId).ensure()
    },

    reset: () => {
      unsubscribe?.()
      unsubscribe = undefined
      unsubscribeLifecycle?.()
      unsubscribeLifecycle = undefined
      unsubscribeSpace?.()
      unsubscribeSpace = undefined
      started = false
      lastRefreshAt = 0
      reconcile = undefined
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = undefined
      // 全库账、写路、三族一起归零 —— 「回到未启动的干净态」包括它们全部。
      // 账本这一声 emit 会顺带让 `republish` 把屏幕那一份也清成空(它订着账本,
      // 而且**不随 reset 退订** —— 那条投影是常设的,见 republish 的注释);
      // 下面那句 set 因此是幂等的,写出来是为了「干净态」这件事只读一处就看得全。
      sessionsQuery.reset()
      sessionMutation.reset()
      chaptersQuery.reset()
      messagesQuery.reset()
      markersQuery.reset()
      set({
        sessions: [],
        projects: [],
      })
    },
  }
})

/**
 * **屏幕那一份 = 账本的投影**,这条订阅是常设的(见 `republish` 的注释)。
 *
 * 它在 store 建出来**之后**才接上 —— `republish` 第一句就要读 store。
 * `reset()` 不退订它:两头(query 与 store)都是这个模块的东西,寿命一致,
 * 所以它也不需要一份自己的 HMR 退役 —— 旧模块被换掉时,那张监听表跟着它订的
 * 那格 query 一起成了垃圾。真正要退役的是**挂在模块外面**的东西(传输面上那
 * 三条推送订阅),那些在 `reset()` 里。
 */
sessionsQuery.subscribe(republish)

/**
 * **HMR 退役**(09-01 立法,起因是 chat-source 那一案:热更之后旧模块的模块级
 * 副作用没死,两个实例同时活着)。
 *
 * 这个文件的模块级副作用:三条推送订阅(SSE / lifecycle / 工作区)、
 * 节流定时器、启动闸、对账把手,以及列表那一格 query、写路那只 mutation 与
 * 三族按需缓存(各自带一张监听表)。不退役的话,旧模块那条 `onSessionEvent`
 * 订阅还挂在传输面上,两台数据源各投影各的。
 *
 * 退役**复用这个模块已有的那一口拆卸**(`reset()`),不写第二套。它自身幂等;
 * 生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useSessionsSource.getState().reset()
  })
}

/** 非组件上下文的读法(store 壳、纯函数的入参)。 */
export function currentSessions(): SessionSummary[] {
  return useSessionsSource.getState().sessions
}

/* ── 组件侧:列表那一格的读法 ──────────────────────────────────────────── */

/**
 * 列表那一格的**整张快照**(`data` / `phase` / `inflight` / `error` / …)。
 *
 * 交出去的是快照而不是拆好的几个布尔:总览要同时读三样东西(还在首载吗 /
 * 这次没拿到的原话是什么 / 手上还有没有列表),而它们**正交** —— 拆成布尔的那
 * 一刻就又回到了 `status: 'idle'|'loading'|'ready'|'error'` 那种把两件事压成一
 * 个数的形状,而那正是本批要拆掉的东西。
 *
 * 屏幕上那份列表仍然读 store 的 `sessions` / `projects`
 * (它们是这一格 `data` 的投影),不从这里的 `data` 自己再过滤一遍:
 * 「屏幕上是哪一份」只许有一个答案。
 */
export function useSessionsList(): QuerySnapshot<readonly SessionSummary[]> {
  return useQuery(sessionsQuery)
}

/* ── 组件侧:三族的读法 ────────────────────────────────────────────────── */

/**
 * 一条会话的章 / 首页消息 / 锚点。交出去的是**整张快照**而不是 `data` ——
 * Quick Look 的骨架要判 `phase === 'initial' && inflight`,只给数据的话它就得
 * 自己再猜一遍「现在是首载还是重拉」,那正是 kernel 存在的理由。
 *
 * 空 `sessionId` 照常建一格(键就是空串)—— 它永远不会被 ensure,所以恒是
 * 出厂快照。不在这里分岔的理由:hook 不能有条件地调。
 */
export function useSessionChapters(sessionId: string): QuerySnapshot<SessionChapter[]> {
  return useQuery(chaptersQuery.get(sessionId))
}

export function useSessionMessages(sessionId: string): QuerySnapshot<SessionPreviewMessage[]> {
  return useQuery(messagesQuery.get(sessionId))
}

export function useSessionMarkers(sessionId: string): QuerySnapshot<SessionMarker[]> {
  return useQuery(markersQuery.get(sessionId))
}

/** 一条都还没拉到时交出去的那一份 —— 恒等引用,免得每次渲染都换一张新空表(律④)。 */
const EMPTY_CHAPTER_RECORD: Readonly<Record<string, SessionChapter[]>> = {}

/**
 * **已经拉到手的全部章节**,摊成检索面板要的那张 `Record<sessionId, 章[]>`。
 *
 * 为什么不照 `useCatalogRecord(ids)` 那一手逐键订:那只 hook 的键面由**屏幕**
 * 给定(设置面要列这几家),而这里的键面由**数据**给定 —— 检索的判据是
 * 「凡是手上有章的会话,章里也搜一遍」,包括用户从没在这块面里点过、章却
 * 因为别处(进入会话 / 目录 rail)已经拉到手的那些。逐键订要先 `get(key)` 建格,
 * 于是「有几条会话就先建几格空格」(500 条会话 = 500 格 + 500 个订阅),
 * 而且真正新落地的那一格反而没人订。
 *
 * 所以订的是**整族**(`chaptersQuery.subscribe`,O(1)),快照按 `keys()` 逐格记
 * `dataRev`:只有哪一格的内容**真的变了**才换引用 —— 在飞 / 落地这种来回不算,
 * 否则每一次后台补拉都会让整块检索结果重算一遍(律④)。
 */
export function useChapterRecord(): Readonly<Record<string, SessionChapter[]>> {
  const cache = useRef<{ revs: string | null; value: Readonly<Record<string, SessionChapter[]>> }>({
    revs: null,
    value: EMPTY_CHAPTER_RECORD,
  })

  const subscribe = useCallback((listener: () => void) => chaptersQuery.subscribe(listener), [])

  const snapshot = useCallback(() => {
    const ids = chaptersQuery.keys()
    const revs = ids.map((id) => `${id}:${chaptersQuery.get(id).get().dataRev}`).join('\n')
    const held = cache.current
    // 「从来没算过」用 `revs: null` 表达:`join` 的结果可以是空串(一格都没有),
    // 所以空串不能当哨兵 —— null 不在 join 的值域里(models-source 同一处判例)。
    if (held.revs === revs) return held.value
    const value: Record<string, SessionChapter[]> = {}
    for (const id of ids) {
      const chapters = chaptersQuery.get(id).get().data
      if (chapters) value[id] = chapters
    }
    cache.current = { revs, value }
    return value
  }, [])

  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
