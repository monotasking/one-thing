/**
 * **尾巴落在设备像素格上**(2026-09-15,用户报「尾部的正在生成在有内容时还是有
 * 抖动」)—— 纯函数,零 DOM、零 React,与 `content/seat.ts` 同一条纪律。
 *
 * ── 真因(真机量出来的,不是推出来的)──────────────────────────────────────
 * 贴底那一句 `scrollTop = scrollHeight` 落在**最大滚动位**上,而最大滚动位是
 * `内容真高 + 内衬 − 视口高` —— 一个**分数**。`scrollTop` 却只能取**整数个设备
 * 像素**(dpr 2 上就是 0.5 的倍数;真机 1991 帧里一个例外都没有)。于是每长一截,
 * 内容底与视口底之间就剩下一个**不同的**亚像素残值:
 *
 *   实测(60,000 字、16ms 一帧流一遍):`(容器内容盒下缘 − 内容列下缘)` 在
 *   **[−0.242, +0.250]** 之间游走 —— 正好一个设备像素宽。而**读数行的位置
 *   恒等于 `606 − 那个残值`**(1993 帧逐帧核对,差 0.000);行内几何一格没动
 *   (`内容列下缘 − 读数行上缘` 恒为 26.000)。人看见的抖,就是这半个设备像素
 *   在每一帧换一个值,文字跟着反复重采样。
 *
 * ── 为什么不能靠改落点治(一条被实测枪毙的修法)────────────────────────────
 * 直觉是「别拿取整过的 `scrollHeight` 当落点,改成按分数几何落位、每帧自校正」。
 * 真机试过了:每一帧算出残值再 `scrollTop -= 残值`,**1865 帧里 `scrollTop` 一次
 * 都没变**,残值分布逐字不变([−0.242, +0.250])。因为 Chromium **本来就**把
 * 落点钳到离真最大位最近的那个设备像素 —— 它已经是最优的,亚像素的修正写进去
 * 当场被吸回同一个整数。**滚动这一侧没有余地可争**:任何基于 `scrollTop` 的修法,
 * 地板都是一个设备像素。
 *
 * ── 所以治在**画**这一侧 ──────────────────────────────────────────────────
 * 既然落点只能落在格子上,就把**尾巴自己**推回格子上:量它此刻的下缘,认下一个
 * 设备像素格上的落点,之后每一帧把「它自然会在哪」与「它该在哪」之差写成一格
 * `translate`。三条理由说明这一格为什么是安全的:
 *
 *  ① **`translate` 不是布局**。它不改任何盒子的尺寸,所以写在 ResizeObserver
 *     回调里不会把观察器再叫醒一次(`project_resize_observer_loop_2026_09` 那条
 *     「观察器回调只读不写」说的是**布局**写;`scrollTop` 与它同类,正本 §7
 *     已经把 `scrollTop` 划进允许的那一格)。
 *  ② **推的是尾巴那一行,不是内容列**。推内容列是白推:列的盒子就是滚动范围的
 *     下界,把它往上推一截,最大滚动位跟着少一截,贴底再落一次正好抵消 —— 增益
 *     恰为 1,等于什么都没做。而尾巴那一行是列的孩子,列自己的盒子(布局量,
 *     不随孩子的 `translate` 变)仍然撑着滚动范围,所以推它不改任何滚动几何。
 *  ③ **只许往上推**(`nudge ≤ 0`,认落点时先让出一个设备像素的余量)。往下推会
 *     让那一行的变换后盒子探到列的下缘之外、把滚动范围撑大一丁点,于是贴底位跟着
 *     变 —— 一条会自激的路。往上推没有这个出口。
 *
 * 那一行本来就是 `content-visibility: auto`(= 常驻 `contain: layout style paint`),
 * **早就是**绝对 / 固定定位子孙的包含块,所以多一格 `translate` 在结构上什么都没改
 * (图片放大那一件是 `createPortal` 出去的,不在这条链上)。
 */

/** 一个设备像素在 CSS 像素里有多长(dpr 2 → 0.5;dpr 1 → 1)。 */
export function devicePixelSize(devicePixelRatio: number): number {
  return devicePixelRatio > 0 ? 1 / devicePixelRatio : 1
}

/**
 * **认下的那个落点什么时候作废**,以设备像素计。
 *
 * 认落点时先让出一个设备像素的余量(见上面 ③),加上抖动本身最多半个设备像素,
 * 「自然位置」与「认下的落点」之间的距离最大就是 `2.5` 个设备像素 —— 所以这个数
 * 必须**大于** 2.5(抖动永远重认不了)、又要尽量小(真的挪了窝要立刻跟上)。
 * 3 是这两句话之间唯一的整数。dpr 2 上它是 1.5px:比这更小的真实位移会被这一格
 * 吃掉(一次,不累积 —— 落点是绝对值不是增量),而 1.5px 的静态偏移人看不见;
 * 比它大的(输入框长一行、窗子变高、换一条消息)当场重认。
 */
export const TAIL_SNAP_REACQUIRE_DEVICE_PX = 3

export interface TailSnapInput {
  /** 尾巴那一件此刻的 `rect.bottom` —— **含**我们上一次推的那一格。 */
  bottom: number
  /** 我们上一次推了多少(≤ 0;没推过就是 0)。 */
  applied: number
  /** 上一次认下的落点;`undefined` = 这一件还没认过。 */
  held: number | undefined
  /** 一个设备像素,取自 `devicePixelSize`。 */
  devicePx: number
}

export interface TailSnap {
  /** 这一帧认下的落点(下一帧原样传回来)。 */
  held: number
  /** 这一帧该推多少(≤ 0,写成 `translate: 0 <nudge>px`)。 */
  nudge: number
  /** 这一帧是不是重新认了一个落点(单测与门的读数口)。 */
  reacquired: boolean
}

/**
 * 「尾巴自然会在哪」→「它该在哪」→「那就推这么多」。
 *
 * 落点认的是 `floor(自然位置)` 再往上让一个设备像素:`floor` 保证落点不高于
 * 自然位置,让出的那一格保证接下来的抖动怎么摆都不会把 `nudge` 摆成正数。
 */
export function resolveTailSnap({ bottom, applied, held, devicePx }: TailSnapInput): TailSnap {
  const natural = bottom - applied
  const keep =
    held !== undefined && Math.abs(natural - held) <= TAIL_SNAP_REACQUIRE_DEVICE_PX * devicePx
  const next = keep ? held : Math.floor(natural / devicePx) * devicePx - devicePx
  return { held: next, nudge: next - natural, reacquired: !keep }
}
