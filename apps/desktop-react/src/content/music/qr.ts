import qrcode from 'qrcode-generator'

/**
 * **一条地址 → 一张二维码的形状**(2026-09-18,接入向导第 ③ 步)。
 *
 * ── 为什么是纯函数 + 内联 SVG,不是 canvas、也不是库自带的 `createImgTag` ──────
 * 库带的那只答的是 `<img src="data:image/gif;…">`:一张位图,主题换了它不跟着换、
 * 放大了糊、而且 `image-rendering` 之外没有第二个旋钮。canvas 则要一个 ref、一个
 * effect、一次重画,还要自己处理 DPR —— 画一张**纯黑白的方格图**,那些都是白付的。
 * 内联 SVG 是这三条路里唯一能让颜色走 token、让缩放不糊、让读屏软件念得出的那一条。
 *
 * ── 纠错级别 M、`typeNumber` 0 ─────────────────────────────────────────────
 * `0` = 让库按内容长短自己挑最小的版本(登录地址长短不定,钉死一个版本要么装不下
 * 要么白留一大片空)。`M`(约 15% 冗余)是扫码场景的通用档:屏幕上的码不会被折、
 * 被印花,L 之上的余量花在这里没有回报,而 Q / H 会把模块数推上去、格子变小。
 *
 * ── 静区 ────────────────────────────────────────────────────────────────
 * 规范要求码四周留 **≥4 个模块**的空白,否则取景框分不出码从哪里开始。它是**码的
 * 一部分**,不是留白样式,所以由这只函数算进 `size` 里 —— 交给 CSS padding 的话,
 * 换一处消费方就可能少留一圈,而那种码在光线差的时候扫不出来。
 */

/** 静区:四边各留这么多个模块。规范的下限就是 4,不多留。 */
export const QR_QUIET_ZONE = 4

export interface QrMatrix {
  /** 含静区的边长,单位是**模块**(viewBox 就用它,一个模块 = 一个用户单位)。 */
  size: number
  /** 不含静区的边长,单位是模块。测试拿它当「版本对不对」的读数。 */
  moduleCount: number
  /** 黑块总数。一条固定地址的这个数是稳定的 —— 快照钉的就是它。 */
  darkCount: number
  /** 所有黑块合成的一条 path。每块一个 `M x y h1 v1 h-1 z` 子路径。 */
  path: string
}

/**
 * 把一条地址编成模块矩阵。**同一条地址永远编出同一张码**(库里没有随机掩码选择,
 * 掩码是按规范的罚分规则算出来的),所以它快照得住。
 */
export function qrMatrix(value: string): QrMatrix {
  // typeNumber 0 = 自适应;'M' = 纠错级别(理由在文件头)。
  const code = qrcode(0, 'M')
  code.addData(value)
  code.make()

  const moduleCount = code.getModuleCount()
  const size = moduleCount + QR_QUIET_ZONE * 2
  let darkCount = 0
  const parts: string[] = []
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (!code.isDark(row, column)) continue
      darkCount += 1
      parts.push(`M${column + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h1v1h-1z`)
    }
  }
  return { size, moduleCount, darkCount, path: parts.join('') }
}
