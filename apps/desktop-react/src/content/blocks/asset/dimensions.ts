/**
 * 内在尺寸表 —— **一张图加载过一次就记住它多大**(正本 §2)。
 *
 * 它兑现的是 `stream-render-2026-09.md` §五 4「元数据先行」在**没有元数据产地**时
 * 那一半:markdown 的 `![alt](url)` 里没有宽高,账本那一路(P2)才可能带。于是
 * 第一次加载仍有一次位移(占位只能按固定最小高),**第二次起零位移** —— 重折、
 * 切回会话、冷载、同一张图在正文与查看器里各出现一次,读的都是这一张表。
 *
 * 键是**解析之后的 src** 而不是作者写的地址:同一张图可能被两份文档用不同的相对
 * 路径写到(`../x.png` 与 `./img/x.png`),它们指的是同一个文件,按 src 记才合得上。
 *
 * 上限满了整张清掉,不做 LRU:这张表的每一格只有两个数,256 张图的规模下淘汰算法
 * 的复杂度远大于它省下的东西;清空最坏的后果是「下一次加载又有一次位移」,
 * 而那正是这张表没有时的常态。
 */
const MAX_ENTRIES = 256

const sizes = new Map<string, { w: number; h: number }>()

/** 记一格。零 / 负数不记 —— 那是「还没量出来」,不是一个尺寸(除以它会得到 NaN)。 */
export function rememberSize(src: string, w: number, h: number): void {
  if (!src || !(w > 0) || !(h > 0)) return
  if (sizes.size >= MAX_ENTRIES && !sizes.has(src)) sizes.clear()
  sizes.set(src, { w, h })
}

export function knownSize(src: string): { w: number; h: number } | undefined {
  return sizes.get(src)
}

/** 清空。用例与热更退役共用这一口,幂等。 */
export function resetAssetDimensionsForTest(): void {
  sizes.clear()
}

// 模块级可变状态 → 配退役(同 remote-policy.ts 文末那条)。
if (import.meta.hot) {
  import.meta.hot.dispose(() => resetAssetDimensionsForTest())
}
