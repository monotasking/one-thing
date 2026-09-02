import type { DockAlign } from '../stage/types'

/**
 * Dock 磁性放大的**纯几何** —— 一个 DOM 都不碰、一次都不量,给同样的输入永远给
 * 同样的答案。它的宿主半边(rAF 环、锚点、静止坐标系何时作废)在 `useMagnify.ts`。
 *
 * ── 曲线是拍定的,不许动 ────────────────────────────────────────────────────
 * 08-29 用户在试衣间(artifact 活 demo 页)三参数全取推荐:半径 96、幅度 1.35×、
 * 余弦钟形 `k = (1+cos(πd/R))/2`(峰圆、半径边缘平滑接 0,替换线性的尖峰折角;
 * macOS 那股"波浪感"来自这条)。这三个数是**行为常量**不是样式字面量,所以住在
 * 这里而不是 token 文件 —— 改它们要重新过试衣间。
 *
 * ── 为什么是「布局尺寸」不是 transform ─────────────────────────────────────
 * 瓷砖宽高真的变大,flex 自动把邻居推开、条随之变宽 —— 天然无重叠、无 z 序问题。
 * (曾用 transform: scale 实现过一版:布局位置不变,放大的瓷砖压住左邻、又被右邻
 * 盖住,08-28 用户录屏里"鼓包挤成一坨"就是它。)
 *
 * ── 静止坐标系:算出来的,不是量出来的 ─────────────────────────────────────
 * 布局驱动意味着「边测边算」会自激振荡 —— 瓷砖长大推着邻居的中心跑,中心一跑
 * 放大量就变,放大量一变中心又跑。09-02 之前的解法是「进条那一刻把各瓷砖的活矩形
 * 冻一份」,它有三个洞:冻的是**活**矩形(在收缩动画里重新进条会冻下中间态)、
 * 只在 mouseleave 解冻(瓦数 / 档位 / 停靠边 / 对齐 / 视口变了都不作废)、而且
 * 一冻就是 13 份坐标。现在改成:**一个锚点 + 一串常量**。锚点是条在静止态的主轴
 * 起点(条内容盒的前缘),其余(瓦宽 / 缝宽 / 分隔线宽 / 瓦数 / 对齐)都是布局
 * 本来就说得出的数,中心由它们**算**出来。
 * (坑史第一层:offsetLeft 曾量出「瓷砖在 position:relative 的 wrap 里的偏移」
 * = 全 0,六个中心叠在同一点,整条 Dock 同胀同缩。)
 *
 * ── 轴向 ───────────────────────────────────────────────────────────────────
 * Dock 停在竖边时条排成一列,「沿条的方向」就从 x 变成 y。变的只有**量哪个坐标**
 * —— 几何一模一样,所以这里一个字都不用分叉(算的是一维距离,不是横向距离)。
 */

/** 尺寸最多长大 35%(试衣间拍定 Smax = 1.35)。 */
export const MAX_GROW = 0.35
/** 影响半径,px(试衣间拍定 R = 96)。 */
export const RADIUS = 96
/** 静止系数:1 = 原尺寸。 */
export const REST_FACTOR = 1

/**
 * 条长大时,主轴起点朝前退多少 —— 由**沿边对齐档**决定,因为退让是 CSS 定位的
 * 后果而不是这里的选择:
 *   start(`left: --sp-3`)          前缘钉死,整条朝后长          → 0
 *   center(`left:50%` + `-50%`)    中心钉死,前后各退一半        → 0.5
 *   end(`right: --sp-3`)           后缘钉死,整条朝前长          → 1
 * 这张表与 AppShell.module.css 的 `.alignXStart/.alignXCenter/.alignXEnd`
 * (以及竖排的 Y 三档)是同一件事的两面,`dock-magnify.test.ts` 逐条钉着。
 */
export const GROWTH_BIAS: Record<DockAlign, number> = {
  start: 0,
  center: 0.5,
  end: 1,
}

/**
 * 静止坐标系**量出来的那半边**。
 *
 * 四个数全都只能问 CSS:锚点要问条现在画在哪,另外三个是 tokens.css 里的量
 * (在 JS 里抄一份就是第二处会分叉的地方)。它们的共同点是「**换了大小档就变**」,
 * 所以同批量、同批作废。
 */
export interface DockRestMetrics {
  /** 主轴起点:条内容盒的前缘(静止态量的,全表唯一一个测量值)。 */
  anchor: number
  /** 一块瓦的静止边长。 */
  tileSize: number
  /** 瓦与瓦之间的缝。 */
  gap: number
  /** 分隔线在**主轴**上占多宽(横排是它的 width,竖排是它的 height,同一个 token)。 */
  sepSize: number
}

/**
 * 完整的静止坐标系 = 量出来的那半边 + **声明出来的那半边**。
 *
 * 后三个不必量:摆几块瓦、分隔线插在哪、沿边怎么对齐,都是宿主此刻手里就有的
 * 事实。分清这两半是有代价背书的:合成一份「进条那一刻冻下来的快照」时,瓦数 /
 * 分隔线 / 对齐档在**悬停期间**变了就会一直按旧的算(手不离开就永远不刷新)。
 * 分开之后,声明的那半边永远是新的,只有量出来的那半边会因为「此刻不是静止态」
 * 而暂时沿用上一次(见 useMagnify 的生命周期表)。
 */
export interface DockRestLayout extends DockRestMetrics {
  /** 条上摆了几块瓦(分隔线不算)。 */
  count: number
  /** 分隔线插在第几块之后;-1 = 这一刻没有分隔线可画。 */
  sepAfter: number
  /** 见 GROWTH_BIAS。 */
  growthBias: number
}

/** 各瓦静止时的中心(主轴坐标)。分隔线不占格,但占主轴上的一段长度。 */
export function dockRestCenters(rest: DockRestLayout): number[] {
  const out: number[] = []
  let cursor = rest.anchor
  for (let i = 0; i < rest.count; i += 1) {
    out.push(cursor + rest.tileSize / 2)
    cursor += rest.tileSize + rest.gap
    if (i === rest.sepAfter) cursor += rest.sepSize + rest.gap
  }
  return out
}

/** 纯函数,给定指针位置与各瓷砖静止中心(同一坐标系),算每块的尺寸系数。 */
export function magnifyAt(pointer: number, centers: number[]): number[] {
  return centers.map((c) => {
    const d = Math.abs(pointer - c)
    const k = d >= RADIUS ? 0 : (1 + Math.cos((Math.PI * d) / RADIUS)) / 2
    return 1 + MAX_GROW * k
  })
}

/**
 * 指针左侧**已经长出来的那些长度**之和(在静止坐标系里量)。
 *
 * 指针落在某块瓦身上时,那块瓦只算它左边那一截:瓦是绕自己的中心长的,所以
 * 「长在指针左边的部分」按指针在这块瓦里的位置线性分。这一条是整个钉住式修法
 * 连续的原因 —— 它在瓦与瓦的交界处天然接得上(左边那块算满、右边那块算 0)。
 */
function grownBefore(pointer: number, rest: DockRestLayout, factors: readonly number[]): number {
  let cursor = rest.anchor
  let acc = 0
  for (let i = 0; i < rest.count; i += 1) {
    const grown = rest.tileSize * ((factors[i] ?? REST_FACTOR) - REST_FACTOR)
    if (pointer >= cursor + rest.tileSize) acc += grown
    else if (pointer > cursor) acc += (grown * (pointer - cursor)) / rest.tileSize
    cursor += rest.tileSize + rest.gap
    if (i === rest.sepAfter) cursor += rest.sepSize + rest.gap
  }
  return acc
}

/**
 * 一次放大的完整答案:各瓦的尺寸系数,以及条要平移多少才能**把指针脚下那一点
 * 钉住**。
 *
 * ── shift 的式子与它的来历 ─────────────────────────────────────────────────
 * 记 `g_i` = 第 i 块瓦长出来的长度,`ΔW = Σ g_i` = 整条长出来的总长,
 * `G(x₀)` = 指针左侧已长出的长度(上面那个函数),`bias` = 对齐档给的退让比例。
 * 条自己会朝前退 `bias·ΔW`,而指针左边的东西把指针脚下那一点朝后推了 `G(x₀)`,
 * 于是那一点净移动 `G(x₀) − bias·ΔW`。要它不动,条就得再平移
 *
 *     **shift = bias·ΔW − G(x₀)**
 *
 * 居中档(bias = ½)代进去就是编排令里那句「(左侧累计 − 右侧累计)/2」的另一种
 * 写法:`½ΔW − G = ((ΔW − G) − G)/2 = (右 − 左)/2`(正号 = 朝主轴正方向挪)。
 *
 * ── 为什么钉「指针脚下那一点」而不是钉「脚下那块瓦的中心」 ──────────────────
 * 钉瓦心做不到:指针从一块瓦交到下一块的那一刻,要求的 shift 会跳
 * `(g_p + g_{p+1})/2`(两块都在峰值附近时十来个像素),条会当场瞬移。
 * 钉那一点则是连续的,而且**恰好把病治了**:指针停在第 p 块的静止中心上时,
 * `G = L_p + g_p/2`,于是那块瓦的中心位移正好是 0 —— 每一块都是,包括两端。
 * 真机读数印证:改前 13 块的中心位移是 `[-3.22, 0, 0, 1.19, -1.19, 0 … 0, 3.22]`
 * (中段靠左右对称天然为 0,两端被余弦核截断而失衡,分隔线那两块被那 1px 破了
 * 对称),改后全 0。
 */
export function magnifyLayout(
  pointer: number,
  rest: DockRestLayout,
  displayed?: readonly number[],
): { factors: number[]; shift: number } {
  const factors = magnifyAt(pointer, dockRestCenters(rest))
  const live = displayed ?? factors
  let total = 0
  for (let i = 0; i < rest.count; i += 1) {
    total += rest.tileSize * ((live[i] ?? REST_FACTOR) - REST_FACTOR)
  }
  return { factors, shift: rest.growthBias * total - grownBefore(pointer, rest, live) }
}

/**
 * 插值的一步:**临界阻尼**(不是指数逼近)。
 *
 * 编排令给的是指数逼近 `f += (target−f)(1−e^{−dt/τ})`。真机上它过不了自己的验收:
 * 指数解的最大一步永远在**第一帧**(`Δ·(1−e^{−h/τ})`),而收敛快慢也由同一个 τ 定,
 * 两者朝相反方向拉。要「单帧涨幅 ≤ 0.08」得 τ ≥ 64ms,要「≤ 6 帧到位」得 τ ≤ 51ms
 * —— 无解(h=16.7ms,Δ=0.35,到位判据 0.05)。而且 τ=35ms 的首帧是 0.133,比改前
 * 那条 CSS ease-out 的 0.072 还大:那不是修好,是在同一个指标上倒退。
 *
 * 临界阻尼从**零速度**起步,第一帧几乎不动、随后加速、末段自己收住 —— 正是
 * 「三四帧的鼓起,不是一跳」这句话的形。τ=25ms 时首帧 0.051、到位 5.4 帧、
 * 收回 157ms(≈ 一个 --dur-release),三条同时成立。
 *
 * 用的是**解析解**不是欧拉积分:`ẍ = −2ωẋ − ω²(x−target)` 的解
 * `x(t) = target + (A + Bt)e^{−ωt}`(`A = x₀−target`,`B = v₀ + ωA`),
 * 任何 dt 都稳、不会因为掉一帧就炸。
 *
 * **两个 0 是两件事,不许合并**(09-02 真机抓到的:合并了整条入场当场退回一帧到位):
 *   `dt = 0` —— 没有时间流逝,那就**什么都不该变**。这不是罕见分支:rAF 回调拿到的
 *     时间戳是**这一帧开始的时刻**,它可能早于你调用 requestAnimationFrame 的那一刻,
 *     所以入场第一发的 dt 经常是 0 甚至负数。把它当成"瞬到"就等于每次进条都直接
 *     蹦到目标 —— 真机上表现为 44 → 59.4 一帧完成,比改前还糙。
 *   `τ = 0` —— 逼近时间常数为零,**当帧到位**(reduced-motion / 动效档「无」)。
 */
export function damperStep(
  value: number,
  velocity: number,
  target: number,
  tauMs: number,
  dtMs: number,
): { value: number; velocity: number } {
  if (dtMs <= 0) return { value, velocity }
  if (tauMs <= 0) return { value: target, velocity: 0 }
  const omega = 1 / tauMs
  const offset = value - target
  const b = velocity + omega * offset
  const decay = Math.exp(-omega * dtMs)
  return {
    value: target + (offset + b * dtMs) * decay,
    velocity: (velocity - omega * b * dtMs) * decay,
  }
}
