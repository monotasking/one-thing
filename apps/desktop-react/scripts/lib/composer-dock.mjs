/**
 * **「焦点叶里的那一块输入框」** —— 真机门共用的那一句查询(W5-c-3,正本
 * `apps/desktop-react/docs/composer-in-leaf-2026-09.md` §5)。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────
 * W5-c 之前输入框是外壳挂在中央区底部的**一块**浮层,所以三道门里那句
 * `document.querySelector('[data-testid="composer-dock"]')` 说得清是谁。路线 A
 * 之后它是**会话叶自己的器官** —— 屏幕上有几片会话叶就有几块,`querySelector`
 * 取的是**文档序第一块**,而门要量的是**人此刻在用的那一块**。分屏「A | B」时
 * 两者不是一件事,于是门会安安静静地量错一半(几何还对得上,对的是别人)。
 *
 * ── 判据:先问焦点,答不上来才退文档序 ──────────────────────────────────
 *  ① `document.activeElement` 最近的那一格 `[data-pane-body]` = 人此刻在用的叶;
 *     它里面那一块就是答案(叶里恰好一块,判词在 `content/kinds/session.tsx`);
 *  ② 焦点不在任何叶里(刚起窗、焦点在檐上 / Dock 上)→ 退回文档序第一块,
 *     也就是 W5-c 之前那一句的逐字行为。**退路要明写**:门在没有焦点时也得量得
 *     到东西,否则它会从「量错一半」变成「什么都量不到」,而后者更难发现。
 *
 * ── 为什么是一段注进去的源码,不是一只 import 进来的函数 ────────────────
 * `page.evaluate(fn)` 把 `fn` **序列化**送进浏览器,node 这一侧的闭包一个都带不
 * 过去 —— 所以「共用一份」只能是「在页面里装一次、大家都调那一个全局」。
 * `installComposerDockProbe` 两件一起做:`addInitScript` 管这一页后面每一次导航
 * (`gate-layout` 有一处 `page.reload()`),`evaluate` 管**此刻**这一份文档。
 */

/** 装进页面的那一段。挂在 `window.__composerDock` 上,幂等。 */
export const COMPOSER_DOCK_PROBE = `
window.__composerDock = function () {
  var all = Array.prototype.slice.call(
    document.querySelectorAll('[data-testid="composer-dock"]'),
  )
  if (all.length <= 1) return all[0] || null
  var active = document.activeElement
  var leaf = active && active.closest ? active.closest('[data-pane-body]') : null
  if (leaf) {
    for (var i = 0; i < all.length; i += 1) if (leaf.contains(all[i])) return all[i]
  }
  return all[0] || null
}
`

/**
 * 把那一段装进这一页。**每次拿到 page 之后叫一次**;它幂等,重复叫无害。
 * @param {import('playwright').Page} page
 */
export async function installComposerDockProbe(page) {
  await page.addInitScript(COMPOSER_DOCK_PROBE)
  await page.evaluate(COMPOSER_DOCK_PROBE)
}
