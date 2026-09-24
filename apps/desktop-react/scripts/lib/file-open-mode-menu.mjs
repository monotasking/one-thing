/**
 * **点开文件行菜单里的「打开方式 ▸」**(09-24)—— 真机门共用的那一步。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────
 * 报障「文件的菜单,打开之后把文件列表都挡住了」(真机 1200×800、目录面板 399 宽,
 * 右键一行开出来 206×452、盖住 17 行)之后,`content/FileActionsMenu.tsx` 把「打开方式」
 * 那一节(小节头 + 六枚 `menuitemradio`)折进了 `ui/Menu` 的 `Submenu`。于是六道门里
 * 那句「右键 → 在 `[role="menuitemradio"]` 里找『主区域 / 面板内』」在一级菜单里一枚
 * 单选都找不到了 —— 它们得先走用户真走的那一步:点开那一行 ▸。
 *
 * 那一步只写在这里一次:子菜单那一行的认法(`aria-haspopup="menu"` + 文案前缀,
 * 行尾还跟着当下那一档的名字,所以按前缀认)一旦再变,改一处就够。
 *
 * `page.evaluate` 送进去的是一只**自足**的函数(零闭包),所以这里可以是一只普通的
 * import 进来的 node 函数 —— 与 `composer-dock.mjs` 那种「注进页面的全局」不同,
 * 这一步不需要在页面里常驻。
 *
 * 答 `true` = 找到了那一行并点了;`false` = 一级菜单里没有它(目录行 / 菜单没开),
 * 调用方照它原来那条「找不到就 skip / 报错」的路走,这里不替它判。
 */
export async function openFileOpenModeSubmenu(page, settleMs = 200) {
  const hit = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')).find((el) =>
      /^(打开方式|Open in)/.test((el.textContent ?? '').trim()),
    )
    if (!(row instanceof HTMLElement)) return false
    if (row.getAttribute('aria-expanded') !== 'true') row.click()
    return true
  })
  await new Promise((resolve) => setTimeout(resolve, settleMs))
  return hit
}
