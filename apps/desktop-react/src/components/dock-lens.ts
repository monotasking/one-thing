import type { DockAlign } from '../stage/types'

/**
 * Dock 磁性放大的**纯几何**(09-02 第二轮重做)。一个 DOM 都不碰、一次都不量、
 * 一格状态都不留:给同样的输入永远给同样的答案。宿主半边在 `useDockLens.ts`。
 *
 * ── 一句话:镜头是一个函数,不是一个动画 ──────────────────────────────────
 * 指针在条上的位置 x 唯一决定这一刻每块瓦多大、挪到哪、条长出多少。**没有速度、
 * 没有阻尼、没有时间常数、没有上一帧**。手停着,函数的值就不变,屏幕就是死的;
 * 手匀速走,函数的值就匀速变,每块瓦就匀速走。这是 macOS 那块坞的做法,也是
 * 09-02 用户报「有抖动感」那一版最缺的东西 —— 上一版把「放大量」交给了一条
 * rAF 环上的临界阻尼,又让条按指针位置反向平移(shift),两条量各有各的相位,
 * 于是匀速扫一遍每块瓦要来回 154 次(`npm run gate:dock` 的 ②a 改前读数),
 * 8 帧之内能来回 2.37px。这里把那两个自由度**一起删掉**。
 *
 * ── 进 / 出是**另一件事**,而且只有一个标量 ────────────────────────────────
 * 手从条外落进来时不能当场满格(那是一跳),但那属于「镜头开合」,不属于跟手。
 * 所以开合是 CSS 里一格 `--dock-amount: 0 → 1` 的过渡(见 styles/motion.css 的
 * `@property` 与 Dock.module.css),几何一律按满格算,由 CSS 乘上去。跟手期
 * amount 恒为 1,几何每次 pointermove 直接写、**不插值**。
 *
 * ── 钟形:余弦,以及一条不能乱选的半径 ────────────────────────────────────
 * `bell(t) = (1+cos(πt))/2`,t = 到瓦心的距离 / 半径,t ≥ 1 时为 0。峰圆、边缘
 * 平滑接 0,没有折角 —— macOS 那股「波浪感」来自这条曲线。
 *
 * **半径必须是瓦距的整数倍**(≥ 2 倍),这不是审美是算术:余弦钟形就是 Hann 窗,
 * 一串 Hann 窗以 hop = R/k(k 为 ≥2 的整数)重叠相加**恒等于常数** —— 信号处理里
 * 的 COLA 条件。落到这里就是:各瓦放大量之和恒定 ⇒ **整条 Dock 的总长恒定** ⇒
 * 条不呼吸、每块瓦不跟着一伸一缩。半径不是整数倍时那条和会随指针起伏:
 * 上一版的 R=96px 对 md 档的瓦距 53px 是 1.81 倍,纯几何数值模型里每块瓦就有
 * 15–19 次方向反转 —— 那部分抖动**与阻尼无关**,光把阻尼删掉治不好。
 * 所以半径以「几倍瓦距」声明(token `--dock-lens-reach`),不以像素声明。
 *
 * ── 位移:推开邻居,不是平移整条 ───────────────────────────────────────────
 * 第 i 块长出 `g_i = w(s_i − 1)`。它绕自己的中心长,所以左邻右舍各被推开一半:
 *
 *     dx_i = Σ_{j<i} g_j + g_i/2 − growth·bias        growth = Σ g_j
 *
 * 前两项是「我左边那些人一共长出多少,加上我自己长出的一半」;`growth·bias` 是
 * **条自己朝前退的那一截**,退多少由沿边对齐档说了算(见 GROWTH_BIAS)。
 *
 * 这个式子有一条漂亮的恒等式:相邻两块放大后的缝
 *     (c_{i+1}+dx_{i+1} − w·s_{i+1}/2) − (c_i+dx_i + w·s_i/2) = c_{i+1} − c_i − w
 * —— **恒等于静止时的那道缝**,与放大量无关。所以「零重叠」不是靠余量守住的,
 * 是式子本身保证的;`gate:dock` 的 ⑤ 就是它的守卫。
 *
 * 指针脚下那块瓦允许有一两个像素的位移(两端因钟形被条端截断而失衡),**不做
 * 锚定修正**:上一版为了把它按到 0 引入了「条按指针位置反向平移」,那一格平移
 * 与逐瓦的放大量各有各的相位,正是抖的另一半来源。macOS 也不修这一两像素。
 *
 * ── 轴向 ───────────────────────────────────────────────────────────────────
 * 条竖排时「沿条的方向」从 x 变成 y。算的是一维距离,所以这里一个字都不分叉 ——
 * 变的只是宿主量哪个坐标。
 */

/** 静止系数:1 = 原尺寸。 */
export const REST_FACTOR = 1

/**
 * 条长大时,主轴起点朝前退多少 —— 由**沿边对齐档**决定,因为退让是 CSS 定位的
 * 后果而不是这里的选择:
 *   start(`left: --sp-3`)          前缘钉死,整条朝后长          → 0
 *   center(`left:50%` + `-50%`)    中心钉死,前后各退一半        → 0.5
 *   end(`right: --sp-3`)           后缘钉死,整条朝前长          → 1
 * 这张表与 AppShell.module.css 的 `.alignXStart/.alignXCenter/.alignXEnd`
 * (以及竖排的 Y 三档)是同一件事的两面,`dock-lens.test.ts` 逐条钉着。
 */
export const GROWTH_BIAS: Record<DockAlign, number> = {
  start: 0,
  center: 0.5,
  end: 1,
}

/** 余弦钟形(Hann 窗的右半形式):t ∈ [0,1] 从 1 平滑落到 0,t ≥ 1 恒 0。 */
export function bell(t: number): number {
  if (!(t < 1)) return 0
  return (1 + Math.cos(Math.PI * t)) / 2
}

/** 镜头的静止坐标系 —— 全是**这一刻的布局事实**,一格都不需要缓存。 */
export interface DockLensRest {
  /** 各瓦静止时的中心(沿条主轴,与 pointer 同一坐标系)。 */
  centers: readonly number[]
  /** 一块瓦静止时的主轴边长。 */
  size: number
  /** 峰值缩放(token `--dock-lens-max`)。 */
  max: number
  /** 影响半径,px(宿主按 `--dock-lens-reach` × 瓦距算好递进来 —— 见文件头的 COLA)。 */
  reach: number
  /** 条长大时朝前退的比例(GROWTH_BIAS)。 */
  bias: number
}

/** 一次放大的完整答案。三个数组同序,`growth` 是条一共长出来的主轴长度。 */
export interface DockLensFrame {
  scale: number[]
  dx: number[]
  growth: number
}

/**
 * 指针在 `pointer` 处时,每块瓦多大、挪到哪、条一共长出多少。
 *
 * 纯函数:不读时钟、不读 DOM、不留状态。同样的入参永远同样的出参 ——
 * `gate:dock` 的 ⑥(同一个 x 进两次几何逐字相同)是这句话的真机版。
 */
export function dockLens(pointer: number, rest: DockLensRest): DockLensFrame {
  const scale = rest.centers.map(
    (c) => REST_FACTOR + (rest.max - REST_FACTOR) * bell(Math.abs(pointer - c) / rest.reach),
  )
  const grown = scale.map((s) => rest.size * (s - REST_FACTOR))
  const growth = grown.reduce((sum, g) => sum + g, 0)
  let before = 0
  const dx = grown.map((g) => {
    const at = before + g / 2 - growth * rest.bias
    before += g
    return at
  })
  return { scale, dx, growth }
}

/**
 * 一串中心之间最小的那段距离 = 瓦距(pitch)。
 *
 * 取**最小**而不是平均:分隔线让它右边那一格宽出一截,平均会把半径拉长一点点,
 * 而 COLA 要的是「常规那一格」的间距。少于两块瓦时没有瓦距可言,退回瓦身量
 * (那时候条上就一块瓦,半径多大都只影响它自己)。
 */
export function dockPitch(centers: readonly number[], size: number): number {
  let pitch = Number.POSITIVE_INFINITY
  for (let i = 1; i < centers.length; i += 1) pitch = Math.min(pitch, centers[i] - centers[i - 1])
  return Number.isFinite(pitch) && pitch > 0 ? pitch : size
}
