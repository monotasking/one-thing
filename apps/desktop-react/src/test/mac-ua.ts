/**
 * **把这台测试机器钉成 mac**(T1-fix,2026-09-12)。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 键位层从 T1-fix 起分得清 ⌘ 与 Ctrl 了:「主修饰键」在 mac 上是 ⌘、在别处是
 * Ctrl,而**另一枚永远不参与绑定**(判词整段在 `keymap/transitions.matchCombo`
 * 上)。从前两枚皆可,所以 jsdom 里按 `metaKey: true` 到处都灵。
 *
 * 这台壳的集成用例是拿 **mac 的词** 写的(⌘S / ⌘L / ⌘F / ⌘W / ⌘I / ⌘E / ⌘⇧P,
 * 连用例名都是),而 jsdom 的 UA 不是 mac —— 不钉住它,那些用例量到的会是
 * 「Win 上按 ⌘ 什么都不该发生」。那句话也对,只是不是它们要说的话。
 *
 * ── 为什么钉 UA,而不是给派发器开一个测试口 ──────────────────────────────
 * 「这是什么机器」是**宿主的事实**(`keymap/store.currentKeymapPlatform` 的原话:
 * 纯函数一行都不许读 navigator,所以在宿主那一层量一次递进去)。这些用例测的正是
 * 「壳上那一个派发器」的端到端行为 —— 换掉事实比换掉被测对象诚实,而且换回
 * `'other'` 就能把 Win / Linux 那一档也走一遍。
 *
 * ── 为什么单独一只文件 ──────────────────────────────────────────────────
 * 九只用例文件要同一句话。抄九遍就是九个产地(i18n 那条纪律的同一条),而
 * `src/test/setup.ts` 此刻是**别批的脏文件**(并行的浏览器批在改它)——
 * 多批并行时别批的脏文件一个字不碰,所以这句话住在它自己这里。
 * 将来真该全局钉的话,把这一句搬进 setup 并把九处 import 删掉,是一次机械改动。
 */

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

/** 在 `beforeEach` 里调一次。幂等;`configurable` 留着,好让别的用例改回去。 */
export function pinMacUserAgent(): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: MAC_UA, configurable: true })
}
