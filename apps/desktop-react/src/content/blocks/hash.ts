/**
 * 32 位 FNV-1a —— **渲染缓存的键**用的那一个。
 *
 * 从 `kinds/figure/registry.ts` 提上来:图的渲染缓存(源码 → SVG)与公式的渲染缓存
 * (TeX → HTML)要的是同一件事 ——「同一段源码给同一个键」,不是密码学。抄第二份
 * 就会有两种撞法,而撞了的后果是屏幕上出现另一段源码渲出来的东西。
 *
 * 够用的依据:调用方都把**源码长度**也掺进键里(见各自的 `cacheKey`),那是给 32 位
 * 哈希加的一道廉价防撞。真要防碰撞得存整段源码当键,而这张表是**每一帧**被查的
 * (檐上的动作声明、本体、浮层),上千字符的键不该每帧比一遍。
 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}
