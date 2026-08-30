/**
 * 「同一个东西永远同一张脸」—— 代位圆片挑第几对渐变。
 *
 * 两个消费者:agent 头像(名册没给 color 时)与检索来源的 favicon 代位圆片
 * (站点图标取不到时)。它们是**同一种脸**,不是两套语言,所以哈希只有一份、
 * 六对渐变的色值也只有一份(`styles/palette.css` 的 `--face-g0-a`…)。
 *
 * FNV-1a 的一小截:要的只是稳定,不是散列质量。喂进去的必须是那个东西的**身份**
 * (agent id / 域名),不是它的显示名 —— 改个名字不该换一张脸。
 */

/** 渐变对的条数。与 palette.css 的 `--face-g0…5` 一一对应,改一处必须改两处。 */
export const GRADIENT_COUNT = 6

export function gradientIndexOf(id: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % GRADIENT_COUNT
}
