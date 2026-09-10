import { SESSION_PREFETCH_HOVER_MS } from '../components/motion'
import { chatSources } from './chat-source'

/**
 * **会话预取** —— 第 6 单,正本 `docs/session-continuity-2026-09.md`。
 *
 * ── 它是什么(一句话)──────────────────────────────────────────────────────
 * 前五单把「切回来那一下」从几秒压到几十毫秒,靠的是**已经有一台机器活着**
 * (停靠池 · C1)。这一单补的是它的上游:**让那台机器在点击之前就活着**。
 * 手段只有一件 —— 提前调一次 `chatSources.acquire(id)`(= `retain` + 那条既有的
 * 尾页读),然后立刻 `release`,于是它落进停靠池那 8 格,等着被点。
 *
 * ── 一条产地,一张预算 ────────────────────────────────────────────────────
 * **悬停**:指针在会话行上停满一个读认窗口(`SESSION_PREFETCH_HOVER_MS`),
 * 那一条就去捂热。速率预算(`SESSION_PREFETCH_RATE`,滑动 1 秒窗)是**给 core 的**
 * 不是给某一条产地的 —— 将来再多一条产地也共用这一张,分成两张就等于把上限翻倍。
 *
 * ── 「开机空闲预热最近 3 条」为什么**不在这里**(09-10 实测掉头,数字在下面)──
 * 第 6 单原本要做两条产地,第二条是「启动后一发 `requestIdleCallback`,把当前
 * 空间最近 3 条捂热」。它写完了、测过了、在真机上量过了 —— **量出来当场毙掉**:
 *
 *   `gate:chat-layout` ①(点下去第一帧列表高亮就换了,第五轴预算 16ms)
 *     · 干净树:dev 五次里最慢 37–42ms,prod **14ms**(prod 绿);
 *     · 接上开机预热:dev **192ms**;把触发时机改成「当前那条自己站稳之后」
 *       之后 dev **177ms**、prod **41ms** —— **两档都红**。
 *
 * 病根不是时机没挑好,改两次时机只是把撞车从 `cold-A` 挪到了 `B#1`:**折一页
 * 尾页是一段几十到一百多毫秒、中途不可打断的主线程任务**(24 条消息 / 135KB),
 * 而 `requestIdleCallback` 只管得住「什么时候发请求」,管不住「响应什么时候回来」
 * —— 那一折落在哪一帧是随机的,落在一次点击上就是第五轴第一条铁律说的那种
 * 「一次交互对应一个长任务」。prod 那一档原本只剩 2ms 余量(14/16),任何一件
 * 背景活都放不下。
 *
 * 于是判据成文,**两种预取的分界线就是这一句**:
 *   **悬停预取把「反正要发生的活」提前干了;开机预热是「可能永远用不上的活」
 *   插在最要紧的那一刻。** 前者最坏情况与不预取一样(那一折本来就要折),
 *   后者是净增。所以前者留,后者退。
 *
 * 它要回来得先有一件事:**折叠可打断**(分片折 / 让出主线程),或者一条真的
 * 「壳静下来了」的判据。那是一次拍板,不是这一单顺手加个开关 —— 所以这里
 * 一行不留(留着不接线就是死码,留个开关就是第二条永远没人跑的路)。
 *
 * ── 四条不许(每条都有判例)────────────────────────────────────────────────
 *  · **不改 active,不改焦点**。预取是一次**读**,而 hover 在这台壳上是纯视觉、
 *    不进 JS 的那一半(壳 CLAUDE.md「hover ≠ active」两态纪律)。这个模块里
 *    一处 `.focus()`、一处 `activeElement`、一处写选择下标都没有,也不该有:
 *    「鼠标停在哪一行」永远不许决定「↵ 落在哪一行」。
 *  · **不起底 UI**。它只碰数据那一层(`chat-source` 的注册表),不摆叶、不换
 *    当前会话、不动 `session-park` 的视图池 3 格 —— 那三格是**画出来的树**,
 *    预取一条会话不该在屏幕上多挂一棵。
 *  · **只在人真的看着某一行时发**。理由见上面那段掉头:没有人指着的预取,
 *    就是往一次说不准什么时候到来的点击上压一段长任务。
 *  · **已在册 / 在池就不发**。判据是 `chatSources.get(id)`(它一句话同时答了
 *    这两头,见 `find` 上的注),不是自己再记一张「预取过谁」的表 —— 那张表
 *    与注册表迟早对不上,而注册表本来就是这件事的唯一真相。
 *
 * ── 离开不撤单 ────────────────────────────────────────────────────────────
 * 指针离开只**掐掉还没到点的那只表**,已经发出去的请求一律不撤:它已经在 core
 * 那边排上了,撤单省不下那台机器的活,却会把一份马上就有用的结果扔掉(用户
 * 常常是「扫过去 → 折回来点它」)。所以 `leaveSessionRow()` 只是 `clearTimeout`。
 */

/* ── 预算 ────────────────────────────────────────────────────────────────── */

/** 速率窗口:一秒。滑动窗不是固定桶 —— 固定桶在窗边界上会放两倍的量过去。 */
export const SESSION_PREFETCH_WINDOW_MS = 1000

/**
 * 一个窗口里最多发几发。**3**:人一秒里能有意停满读认窗口的行数远不到 3 ——
 * 这个数不是为了拦正常使用,是为了让「列表被程序化地扫一遍」(合成事件、
 * 惯性滚动带着指针扫过整屏)这类异常一秒最多花掉 3 次尾页读。
 */
export const SESSION_PREFETCH_RATE = 3

/* ── 速率闸 ──────────────────────────────────────────────────────────────── */

/** 窗口内已发出的时刻。只存**真发出去的那几发**,被别的判据挡掉的不记账。 */
let spent: number[] = []

function affordable(now: number): boolean {
  while (spent.length > 0 && now - spent[0] >= SESSION_PREFETCH_WINDOW_MS) spent.shift()
  return spent.length < SESSION_PREFETCH_RATE
}

/* ── 一发预取 ────────────────────────────────────────────────────────────── */

/**
 * 预取一条会话:**让它的机器活起来并停进池里**,屏幕上一个像素都不动。
 *
 * `acquire` 之后当场 `release` 是**故意**的,不是忘了配对:`release` 归零之后
 * 排的那一拍是**停靠**不是拆卸(见 `chat-source.release`),于是这台机器带着
 * 它刚拉回来的尾页停在池里等着被点;而它此刻**没有人持有**,所以池满时它照
 * LRU 被挤掉 —— 预取不该比用户真的看过的会话更有资格占着内存。
 *
 * @returns 真发出去了没有。`false` 的三种理由:没有 id / 已经活着 / 预算用完。
 */
export function prefetchSession(sessionId: string, now = Date.now()): boolean {
  if (!sessionId) return false
  // 在册的、停靠着的,在这里是同一件事:两者都已经有一台活机器,再发就是白发。
  if (chatSources.get(sessionId)) return false
  if (!affordable(now)) return false
  spent.push(now)
  // 起底那一下由 `acquire` 发(`open()` → `runLoad` → 尾页读),这里不另开一条路。
  chatSources.acquire(sessionId)
  chatSources.release(sessionId)
  return true
}

/* ── ① 悬停 ─────────────────────────────────────────────────────────────── */

let hoverId = ''
let hoverTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 指针进了某一条会话行。**同一条会话重复报到是恒等** —— 行里有图标、有按钮、
 * 有 chip,指针在它们之间走会连报好几次 `pointerover`,重新起表就等于永远
 * 停不满那个窗口。
 */
export function hoverSessionRow(sessionId: string): void {
  if (!sessionId || sessionId === hoverId) return
  leaveSessionRow()
  hoverId = sessionId
  hoverTimer = setTimeout(() => {
    hoverTimer = undefined
    hoverId = ''
    prefetchSession(sessionId)
  }, SESSION_PREFETCH_HOVER_MS)
}

/** 指针离开(或走到了行与行之间的空当)。只掐表,不撤已经发出去的请求。 */
export function leaveSessionRow(): void {
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = undefined
  hoverId = ''
}

/* ── 退役 ────────────────────────────────────────────────────────────────── */

/**
 * 整个模块回到未启动的干净态(用例与 HMR 共用这**一口**拆卸 —— 两套迟早漏一格,
 * 壳 CLAUDE.md「模块级副作用必须配 HMR dispose」)。它幂等。
 */
export function resetChatPrefetch(): void {
  leaveSessionRow()
  spent = []
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetChatPrefetch()
  })
}
