/**
 * **首屏让路**(工单 6 ①,壳 CLAUDE.md 第 5 轴)—— 一条会话冷开时,谁先出门。
 *
 * ── 病 ────────────────────────────────────────────────────────────────────
 * core 是**单线程**的:一次 `POST /api/rpc` 折到一半,后面排队的每一发都在等。
 * 冷开一条真店规模的会话(50.9MB / 400 条 / 900 卡)壳会发 6 类读,而它们
 * 各自的价钱差三个数量级 —— 真机实测(临时 store + `dist/server/main.js`,
 * 每一发之前重起 core):
 *
 *   `resources.read(page)`    55ms   135KB   ← **这一发就是第一屏**
 *   `permission.getPending`   18ms    48B
 *   `sessions.getSegments`     7ms    49B
 *   `usage.getSession`         4ms   213B
 *   `sessions.getTokenUsage`  835ms  159B    ← 已在后端治掉(工单 6 ②a)
 *   `sessions.getUserMarkers` 798ms  30KB    ← 要把整份账本折一遍才数得出锚点
 *
 * 把这六发**一起**扔给一台冷 core,量出来的是:每一发都 820ms,页那一发 863ms。
 * 首屏那 55ms 的活排在两笔几百毫秒的账后面 —— ③「冷载首屏 ≤ 300ms」偶发 989ms
 * 的那一下就是这么来的,而**九成不是首屏自己的活**。
 *
 * ── 判据(一句话,可反证)──────────────────────────────────────────────
 * **凡「按数据规模计价、而且不是这一屏要的」的读,排在首屏那一页之后。**
 *
 * 三格各答各的,判据都写在调用点上:
 *  · **页**(`chat-source` 的 `runPageLoad`)—— 它就是第一屏,永远第一个出门;
 *  · **审批车道**(`permission.getPending`)—— 它是**活流上的事实**(此刻挂着
 *    一张卡等人答),不是面板素材;而且它由 `runPageLoad` 自己在折完之后发,
 *    结构上已经排在页后面。**不进这道闸**;
 *  · **面板素材**(读数两口 / 目录两口)—— 屏幕上是缺席态起步的东西,晚一拍
 *    出现看不出来,而它们插在前面就是把首屏推后几百毫秒。进这道闸。
 *
 * 这与 `TocPanel` 那条「排进空闲」是**两件事,缺一不可**:`requestIdleCallback`
 * 管得住「什么时候发」却管不住「core 那边排在谁后面」—— 页那一发在飞的时候
 * 主线程正好是空的,于是空闲回调准时开火,两发一起挤在 core 的队列里。要让出
 * 那一拍,得等的是**页回来了**,不是**这一帧闲了**。
 *
 * ── 两条边,不是一条 ──────────────────────────────────────────────────────
 * 只记「落地了」是不够的:那样一条**从来没有人打开过**的会话会让面板一直等到
 * 天花板。所以记的是**在飞**(`markFirstScreenPending`)与**落地**
 * (`markFirstScreenLanded`)两条边 —— 没人宣布在飞 = 这条会话此刻没有首屏要让,
 * 当场放行。「在飞」同时**把落地那一格抹掉**:同一条会话再冷开一次(被挤出停靠池
 * 之后)仍然是一次真的冷开,不该因为上辈子落过地就不让路了。
 *
 * 「在飞」有**两个时刻**(不是两个产地 —— 同一个陈述,`markFirstScreenPending`
 * 幂等):`content/session-open.ts` 的 `enterSessionInWorkbench`(点一条会话,同步
 * 跑在点击那一刻)与 `chat-source` 的 `load()` 开头(那台机器自己起底:开机复原、
 * 预取)。**早的那一个不能省** —— 内容切换标了 transition(第五轴铁律①),摆首屏
 * 的那片叶的 effect 排在 Composer 的 effect 之后几拍,只在 `load()` 里宣布的话读数
 * 那两口会在「还没有人说要开首屏」的窗口里出门,让路当场落空(实测过)。
 * 「落地」只有一个产地:`load()` 的收尾。
 *
 * ── 为什么先让一个微任务 ──────────────────────────────────────────────────
 * 摆首屏的那片叶与摆面板的那几件在**同一次提交**里跑 effect,而 React 不保证
 * 谁先跑。同步就判「有没有人在飞」会把答案压在 effect 次序上 —— 那是最典型的
 * 「今天恰好对」。所以除了「已经落地」这条快路(池命中,一格都不该多等),
 * 一律先让过一个微任务再判:同一次提交里的 effect 到那时全都跑完了。
 *
 * ── 为什么有天花板 ────────────────────────────────────────────────────────
 * 页那一发可能永远不落地(读不到 / 会话没了 / 切走了)。让路是**礼让**不是
 * **依赖**:等到 `FIRST_SCREEN_YIELD_MS` 还没等到就自己走 —— 面板空着比面板
 * 永远空着好,而且这条超时把「首屏坏了」与「面板坏了」两件事解耦。
 *
 * ── 四条不许 ──────────────────────────────────────────────────────────────
 *  · **不记「谁在飞 / 谁落了地 / 谁在等」以外的任何状态**。会话表、引用计数是
 *    `chat-source` 注册表的活,再记一份迟早对不上;
 *  · **不替调用方决定发不发**。这道闸只答「现在可以了」,发不发由调用点自己说
 *    (它才知道自己是不是还在这条会话上);
 *  · **落地只由页那条路宣布**(`chat-source` 的 `load()` 收尾),不许第二个产地;
 *    「在飞」的两个时刻见上一节 —— 它们是同一个陈述的两次说出口,不是两个真相;
 *  · **不进渲染**。它不是 store,零订阅、零重渲。
 */

/** 等页的天花板。等不到就自己走 —— 见文件头「为什么有天花板」。 */
export const FIRST_SCREEN_YIELD_MS = 1500

/** 正在起底的会话(`load()` 开头 → 收尾)。空 = 此刻没有首屏要让。 */
const pending = new Set<string>()

/** 已经落地的会话。再宣布一次「在飞」就从这里摘掉 —— 那是又一次冷开。 */
const landed = new Set<string>()

/** 还在等的那些人,按会话分。落地那一刻整格取走。 */
const waiting = new Map<string, Set<() => void>>()

/**
 * **首屏那一页出发了**(点开那一刻 / `chat-source` 的 `load()` 开头,见文件头)。
 * 在这之后、落地之前问路的人要等；没人宣布过这一句,`whenFirstScreen` 当场放行。
 */
export function markFirstScreenPending(sessionId: string): void {
  if (!sessionId) return
  landed.delete(sessionId)
  pending.add(sessionId)
}

/**
 * **首屏那一页落地了**(成、败、或者压根没有会话都算)。
 *
 * 「落地」的口径故意宽:这道闸让的是**次序**不是**正确性** —— 页读失败退回整份
 * 那条老路时,首屏那棵树同样已经画完了,面板再等下去就是白等。
 */
export function markFirstScreenLanded(sessionId: string): void {
  if (!sessionId) return
  pending.delete(sessionId)
  landed.add(sessionId)
  const waiters = waiting.get(sessionId)
  if (!waiters) return
  waiting.delete(sessionId)
  for (const wake of waiters) wake()
}

/**
 * 首屏那一页之后再走。
 *
 * 已经落地 = **当场**就走,连一个微任务都不排:池命中那条路上多排一拍就是白白
 * 多一帧。其余情形先让过一个微任务再判(见文件头「为什么先让一个微任务」)。
 */
export function whenFirstScreen(sessionId: string, timeoutMs = FIRST_SCREEN_YIELD_MS): Promise<void> {
  if (!sessionId || landed.has(sessionId)) return Promise.resolve()
  return Promise.resolve().then(() => {
    if (landed.has(sessionId) || !pending.has(sessionId)) return undefined
    return new Promise<void>((resolve) => {
      let done = false
      const wake = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        waiting.get(sessionId)?.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, timeoutMs)
      const waiters = waiting.get(sessionId) ?? new Set<() => void>()
      waiters.add(wake)
      waiting.set(sessionId, waiters)
    })
  })
}

/** 测试用:回到「谁都没开过」的干净态(在等的人一律放行,不留悬着的 promise)。 */
export function resetFirstScreen(): void {
  pending.clear()
  landed.clear()
  for (const waiters of [...waiting.values()]) for (const wake of waiters) wake()
  waiting.clear()
}
