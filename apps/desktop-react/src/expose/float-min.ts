import type { FloatMinSize } from '../stage/types'

/**
 * **侧栏那道阈值,在 JS 这一侧的名字**(W7-d 裁定 1)。
 *
 * `@container` 的条件里不能写 `var()`,所以这个数在 CSS 那一侧本来就有两份
 * (`styles/tokens.css` 的 `--expose-rail-bp: 760px` 与 `components/Rail.module.css`
 * / `components/Toolbar.module.css` 的字面量,那条判例写在 tokens 里)。这里是
 * **第三处**,而它有独立的理由:开窗身量是纯 JS 算术,那只纯函数读不了 CSS。
 * 三处同源由 `float-min.test.ts` 逐字对账 —— 它把真的 CSS 文本读进来比,
 * 所以改 token 而忘了这里会当场红,不靠人记。
 */
export const EXPOSE_RAIL_BP = 760

/**
 * **会话总览摆成浮窗时至少要多宽**(W7-d 裁定 1)。
 *
 * ── 病历 ──────────────────────────────────────────────────────────────────
 * W7-p 裁定 5 把新窗默认身量改成 640×480。总览这块面的宽档阈值是
 * `@container expose (min-width: 761px)`(= 上面那格 +1):过了它侧栏才在场、
 * 顶栏那格项目选择器才隐藏。640 < 761,于是**浮窗形的总览一开出来就是窄档** ——
 * 侧栏没了、Tab 序里多一格 combobox,`gate:a11y` [8/10] 两条红。
 *
 * ── 这个数怎么来的 ────────────────────────────────────────────────────────
 * 阈值 760 说的是**容器**(`.view` 的 inline-size),而 `floatMin` 说的是**窗**:
 * 两者之间隔着窗的 1px 边框各一道。取 800 而不是 762,判词与 `gate:squeeze` 的
 * `CONTAINER_BANDS` 逐字同一条:「阈值上骑着的那一像素量的是舍入,不是形」——
 * 留一档余量,窗的表面将来长出内衬也不至于当场掉回窄档。
 *
 * 它是**这块面自述的**(`stage/items.ts` 那一行只是把它挂上去),因为
 * 「我在多窄的时候会换一种形」这件事只有这块面自己知道。
 */
export const EXPOSE_FLOAT_MIN: FloatMinSize = { w: 800 }
