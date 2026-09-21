/**
 * **座位的几何**(正本 `docs/send-flow-2026-09.md` §3)—— 纯函数,零 DOM、零 React。
 *
 * 判据与 `content/follow.ts` 同一条纪律:**能算清楚的部分住在纯函数里**,
 * 量几何与写样式是调用方的活。于是「座位该多高」这句话有且只有这一个答案,
 * 不会在 `ChatStream` 那只 ResizeObserver 与发送那一拍里各写一遍、各写歪一点。
 *
 * ── 座位是什么 ────────────────────────────────────────────────────────────
 * 发送那一帧自己的话滚到置顶线,**下面整个视口留给回复**。那块空白就是座位:
 * 列尾一块让位给内容的垫块 —— 回复长一截它缩一截,`scrollHeight` 不变,
 * 于是「跟底」在座位长满之前什么都不用做,视口一像素不动。
 *
 * ```
 * 视口上缘 ─────────────────────────────  y = 0
 *         ── 置顶线 ──────────────────  y = sendLine
 *         [自己那条气泡]                 ← userHeight
 *         [折痕 / 思考 / 正文 / 工具卡 / 外缘那一行]
 *         ├──────── tailHeight(气泡上缘 → 这一轮最后一件内容的下缘)
 *         [座位垫块]                      ← 本文件算的就是它
 *         [给输入框留的那一格内衬]        ← reserveBelow
 * 视口下缘 ─────────────────────────────  y = viewportHeight
 * ```
 *
 * 座位写对了的意思是:**贴到底时自己那条气泡的上缘正好落在置顶线上**。
 * 把上图从下往上加一遍就是那句话的算式 ——
 * `tailHeight + seat + reserveBelow = viewportHeight − sendLine`。
 *
 * ── 为什么 `reserveBelow` 是一格独立的入参 ────────────────────────────────
 * 输入框是**浮在**滚动区上面的玻璃,让位由滚动容器自己那格 `padding-block-end`
 * (`--composer-h + --composer-gap`)给(判词在 `ChatStream.module.css` 的 `.scroll`)。
 * 它跟着输入框长高变来变去,而且它**不是**座位:座位是「留给回复的地」,
 * 那一格是「不许压到玻璃上」的气口。两件事各占一格,不许并成一个数 ——
 * 并了之后「视口太矮」那一支就分不清是窗子矮还是输入框打了十行字。
 */

/**
 * 座位的**下限**:三行正文。
 *
 * 它是一个**行数**不是一段长度,所以既不进 `styles/tokens.css` 也不进
 * `components/motion.ts`(与 `ChatStream.tsx` 的 `ANCHOR_RESETTLE_ROUNDS` /
 * `CHAT_NEAR_TOP_SCREENS` 同一族)。三行是「一眼看得出下面是空的、回复要从这儿起」
 * 的最小量:两行会被一句话的换行吃掉,四行在矮窗子上就等于不留座位。
 * 一行有多高由调用方量(`--pr-fs × --pr-lh`,阅读轴三档各不相同)。
 */
export const SEAT_MIN_LINES = 3

/**
 * 座位的**起手高**:六行正文(2026-09-21 用户裁定,正本
 * `docs/stream-geometry-2026-09.md` §8 裁定 A)。
 *
 * 用户原话:「发送回车后,**留出合适的空间就可以,不需要一个很大的空间**」。
 * 09-15 立座位时起手是「气泡让开之后视口**剩下的全部**」—— 那是把整块屏幕都让给
 * 这一轮,发送完屏幕上就是一大片空白,人要往下看很久才看得到自己刚说的话下面
 * 还有什么。今天改成**固定的几行**:够一眼看出「回复要从这儿起」,不多留。
 *
 * 六行:比下限三行多一倍(三行是「一眼看得出下面是空的」的最小量,起手就取最小量
 * 会让第一块内容一上来就把座位吃光、当场退回普通跟底),又远小于一屏 ——
 * 1280×800 上阅读轴常规档一行 ≈ 22px,六行 ≈ 132px,约一屏的六分之一。
 *
 * 它是一个**行数**不是一段长度,与 `SEAT_MIN_LINES` 同一族,所以既不进
 * `styles/tokens.css` 也不进 `components/motion.ts`。
 *
 * **后果**(想清楚了才改的,三表在正本 §8):自己那条气泡**到不了置顶线**了 ——
 * 总高不够,`sendLineTarget` 那个目标会被 `maxScroll` 钳住,落点自然变成
 * 「贴底,气泡下面留六行 + 尾槽」。「发送只滚一次」不受影响:目标**在算的时候**
 * 就已经夹进 `[0, maxScroll]`,插值的每一帧都 ≤ 目标,单调、无反向
 * (判词在 `ChatStream` 的 `sendLineTarget` 与 `slideScrollTo` 上)。
 */
export const SEAT_LINES = 6

export interface SeatGeometry {
  /** 滚动容器的可视高(`clientHeight`)。 */
  viewportHeight: number
  /** 置顶线:视口上缘到自己那条气泡上缘(token `--send-line`)。 */
  sendLine: number
  /** 底下已经被别人占掉的那一截(滚动容器给悬浮输入框留的内衬)。 */
  reserveBelow: number
  /** 自己那条气泡有多高。 */
  userHeight: number
  /** 从自己那条气泡**上缘**到这一轮最后一件内容的**下缘**(不含座位本身)。 */
  tailHeight: number
  /** 一行正文有多高(`--pr-fs × --pr-lh`);下限按它乘 `SEAT_MIN_LINES`。 */
  lineHeight: number
}

/** 拿不到读数时当 0 —— 量不到就不留座位,那正是「退化为今天的落底」。 */
function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/**
 * 这一刻座位该多高。**0 = 没有座位**,调用方照旧跟底。
 *
 * 五支,每一支都在 `__tests__/seat.test.ts` 里有一条:
 *
 *  ① **常态** —— `座位 = 起手那一格 − 这一轮已经长了多高`。回复长一截它缩一截,
 *     长满就是 0,之后退役为普通的 pinned 跟底(正本 §5 表 1)。
 *  ② **起手六行封顶**(2026-09-21 用户裁定,判词在 `SEAT_LINES` 上)—— 起手不再是
 *     「能用的地减掉气泡」那一整块,而是**至多六行**。屏幕矮、或者气泡高得把地
 *     占得差不多时,`room − userHeight` 比六行还小,那就按它(取两者的小的)。
 *  ③ **三行下限** —— 上面那个小的再小也不许小过三行:气泡高得快把地占满时,
 *     仍要看得见「回复要从这儿起」。下限管的是**起手**,不是终身:回复照样把它吃掉,
 *     所以座位最终仍会归 0,不会留一块永远跟不了底的死白。
 *  ④ **视口太矮** —— 能用的地连三行都不到(窄窗子 / 输入框打了十行字),
 *     留座位只会把自己那条顶出屏外,所以**退化为今天的落底 + 跟随**:答 0。
 *  ⑤ **自己那条比视口还高** —— 座位取下限(③ 的同一条式子:`room − userHeight`
 *     这时是负的,`Math.max` 兜到下限)。
 */
export function seatHeight(geometry: SeatGeometry): number {
  const viewportHeight = finite(geometry.viewportHeight)
  const sendLine = finite(geometry.sendLine)
  const reserveBelow = finite(geometry.reserveBelow)
  const userHeight = finite(geometry.userHeight)
  const tailHeight = finite(geometry.tailHeight)
  const minSeat = finite(geometry.lineHeight) * SEAT_MIN_LINES

  /** 置顶线与输入框之间,这一轮真正能用的那块地。 */
  const room = viewportHeight - sendLine - reserveBelow
  // ④ 视口太矮(或者根本没量到几何:停靠中 / jsdom,那时 viewportHeight 是 0)。
  if (!(minSeat > 0) || room < minSeat) return 0

  /*
   * 起手那一格(②③⑤ 三支合在这两行里):**六行封顶**,气泡让开之后剩下的地要是
   * 更小就按它,再小也不许小过三行。09-21 之前这里只有后半句 —— 那时起手是
   * 「剩下的全部」,发送完屏幕上是一大片空白,用户原话「不需要一个很大的空间」。
   */
  const initial = Math.min(
    finite(geometry.lineHeight) * SEAT_LINES,
    Math.max(minSeat, room - userHeight),
  )
  // 气泡之后已经长出来的那些(折痕 / 思考 / 正文 / 工具卡 / 外缘那一行)。
  const grown = Math.max(0, tailHeight - userHeight)
  // ① 长一截缩一截,吃完为止。
  return Math.max(0, initial - grown)
}
