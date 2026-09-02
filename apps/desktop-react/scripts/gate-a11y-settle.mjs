/**
 * 「这一屏可以量了」的**判据**(gate-a11y 的抖动根治,09-02)。
 *
 * ── 病 ────────────────────────────────────────────────────────────────
 * `gate:a11y` 约 1/4 概率红,两种形态,同一构建重跑就绿:
 *   ① axe 报 `color-contrast` —— 前景是文字 token、底是 accent,或 `#9d9b94`
 *      压在 `#3c3b39` 上,两个都不是设计里存在的配色;
 *   ② 外壳屏「Tab 走 38 站(应 40)」、「两个 input 只有光标没有环」。
 *
 * ── 根因(09-02 探针实测,三趟两中)────────────────────────────────────
 * 门今天开扫的判据只有两条:`window.__d0.rpcOk`(一次 RPC 往返通了)与
 * 「Dock 瓦在 DOM 里」。**这两条都不管颜色**。而这台壳的颜色是异步来的:
 * `src/main.tsx` 里 `startThemeSource()` 是个 fire-and-forget,它要再走一趟
 * `themes.apply` RPC 才把 654 个变量贴上 `:root`(`src/theme/theme-source.ts`)。
 *
 * 探针在门开扫的**那一刻**读到的原始读数(三趟里两趟如此):
 *
 *   {"d2":{"applied":false,"count":0},"bridge":false,
 *    "accent":"#7c6fa0","ring":"rgba(124, 111, 160, .18)","bg":"","running":1}
 *   → 146ms 后:
 *   {"d2":{"applied":true,"count":654,"themeId":"flexoki","mode":"dark"},
 *    "bridge":true,"accent":"#4385BE","ring":"rgba(67, 133, 190, .18)",
 *    "bg":"#282726","running":21}
 *
 * 三件事同时在那 146ms 里发生,每一件都够单独把门弄红:
 *   · accent 从 palette.css 的静态紫 `#7c6fa0` 跳到主题的蓝 `#4385BE`;
 *   · **`--bg` 在桥落地之前根本不存在**(读出来是空串)—— 于是那一刻
 *     `background: var(--bg)` 是透明的,axe 只好拿底下透出来的东西算对比度,
 *     `#9d9b94 on #3c3b39` 这种设计里没有的配色就是这么来的;
 *   · 桥一落地当场**起 21~22 条过渡**,过渡中途的每一帧,前景与背景都还在
 *     混色 —— 这正是 `settleAnimations` 那段注释早就写过的那件事,只是那个
 *     函数从来只挂在第 5、6 两屏上,外壳 / 模型服务面 / 规格页三屏一直裸扫。
 *
 * 形态 ② 同源:那两个 input 的环画在**看得见的外框**上
 * (`.panel:has(.input:focus)`,色是 `--accent-ring`),桥没落地或过渡没播完时,
 * 画出来的色与此刻读到的 token 值对不上,门就判它「只有光标没有环」;
 * 「38 站(应 40)」则是壳还没挂满,可聚焦的元素本来就少两个。
 *
 * ── 治 ────────────────────────────────────────────────────────────────
 * **不加更长的 sleep** —— 睡多久都是猜,而且它教人重跑不教人修。等的是真信号:
 *
 *   ① **主题落定**:`window.__d2.applied === true` 且 `<html>` 上有
 *      `data-theme-bridge`。这两个不是启发式,是 `theme/theme-source.ts` 自己
 *      为验收留的探针与激活标记 —— 问的是主题本人。
 *   ② **色值与壳一起连续 N 帧不变**:每一帧取一次指纹(四个色 token + body 的
 *      前景背景 + 可聚焦元素计数),连续 3 帧逐字相同才算数。颜色在指纹里 =
 *      「主题不再变」;可聚焦计数在指纹里 = 「壳挂满了」。两件事一个循环。
 *   ③ **没有还在播的过渡**:`document.getAnimations()` 里有终点的那些各自
 *      `finished`(无限循环的 spinner 永远不 finished,只等有终点的)。
 *      排空之后还可能有新的起来(桥落地就是这么起 21 条的),所以是
 *      「排空 → 看稳没稳 → 没稳就再排空」的循环,不是排一次就走。
 *
 * 超时**抛**而不是默默放行:一个悄悄放弃等待的门,等于没有门。
 *
 * ── 读数(同一构建连跑 5 次)──────────────────────────────────────────
 * 见 `gate-a11y.mjs` 文件头的判例节。
 */

/** Tab 走得到的那一族。计数只做「壳挂满没有」的指纹,不求与 Tab 序逐字相等。 */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),'
  + 'select:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'

/**
 * 指针的停车位 —— 窗口左上角那一格。
 *
 * ── 第三种抖动形态(09-02 修后 5 跑抓到 1 次)──────────────────────────
 * 外壳屏 axe 报 `[moderate] region —— All page content should be contained by
 * landmarks`,命中节点 `._label_m3on4_104`,也就是 **Dock 瓦的悬停名字条**
 * (`components/DockTile.module.css` 的 `.label`;那个 hash 下还有 `_tile_`
 * `_dot_` `_badgeAt_`,是同一份 CSS Module)。
 *
 * 它是真话不是误报:`AppShell.tsx` 里 Dock 挂在**壳的根上、`<main>` 外面**,
 * 所以名字条一旦长出来就是一块「不在任何地标里」的页面内容。但它是
 * `DockTile.tsx` 里 `onMouseEnter` 起的 300ms 计时器画的 —— 而这道门**从不用
 * 指针**(它一律 `el.click()`,理由写在 `clickSelector` 那里)。会长出来只有
 * 一个来路:窗口正好开在**人的物理光标底下**,Chromium 于是给底下那块瓦补一次
 * mouseenter。也就是说,那一条红量的是「跑门的人当时把鼠标放在哪儿」。
 *
 * 所以每屏扫描之前把指针停到 (2, 2) —— 窗口左上角红绿灯让位的那块空带。
 * 09-02 探针实测两条,都是原始读数:
 *   · 一趟里「不动指针」时 `:hover` 链是
 *     `… > div._center > div._chatArea > div._scroll` —— **人的物理光标真的在窗口里**,
 *     渲染层的悬停态跟着它;
 *   · 同一趟 `page.mouse.move(2, 2)` 之后链变成
 *     `… > header._bar > div._traffic` —— 一次注入的移动**盖得过物理光标**,
 *     而且落点不含任何可交互件。
 * 悬停目标既然测得出是移开了,浏览器随之派的边界事件(mouseout/mouseover)也就
 * 会走到瓦的 `onMouseLeave` 上,那个 300ms 计时器于是清掉。
 *
 * **诚实说明**:名字条本身没能在探针里复现 —— `page.mouse.move` 到瓦上时 CSS 的
 * `:hover` 确实走到了 `button._tile`,但 React 的 `onMouseEnter` 没被这种「瞬移」
 * 式的注入移动触发,200/350/450/550/700/900ms 六次采样名字条恒为 0。所以上面这条
 * 链路是**读代码 + 读 axe 报告的命中节点**得来的,不是端到端复现出来的。
 *
 * **留账(非本次修改范围,请编排者过目)**:Dock 在 `<main>` 外面这件事本身还在。
 * 这道门此后不会再撞上它 —— 但对**真的用鼠标的人**,那条名字条确实落在所有地标
 * 之外。要不要给 Dock 一个 `role="navigation"` / 一段 `<nav>`,是产品侧的一次拍板,
 * 不该由一道门顺手改掉。
 * ──────────────────────────────────────────────────────────────────────
 */
const PARK = { x: 2, y: 2 }

/** 主题落定 = 桥自己的探针说贴上了 + `<html>` 上有激活标记。 */
async function waitThemeLanded(page, label, deadline) {
  let last
  while (Date.now() < deadline) {
    last = await page
      .evaluate(() => ({
        applied: Boolean(window.__d2?.applied),
        count: window.__d2?.count ?? 0,
        themeId: window.__d2?.themeId,
        mode: window.__d2?.mode,
        bridge: document.documentElement.hasAttribute('data-theme-bridge'),
        error: window.__d2?.error,
      }))
      .catch((error) => ({ pending: String(error?.message ?? error) }))
    if (last && !last.pending && last.applied && last.bridge) return last
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(
    `[settle] ${label}:等主题落定超时 —— window.__d2 最后一次读数 ${JSON.stringify(last)}`,
  )
}

/**
 * 等到这一屏「可以量了」。每一屏扫描之前调一次。
 *
 * @param {import('playwright').Page} page
 * @param {string} label 出错时说得清是哪一屏
 * @param {{ stableFrames?: number, timeoutMs?: number, theme?: boolean }} [opts]
 *   `theme: false` 给「主题早就落定、只是刚开了一块面」的屏用 —— 那时再问一次
 *   `__d2` 只是白问,但**默认是问**:开面本身可能带来新的变量重贴。
 */
export async function waitForScreenSettled(page, label, opts = {}) {
  const { stableFrames = 3, timeoutMs = 15_000, theme = true } = opts
  const deadline = Date.now() + timeoutMs
  const themeState = theme ? await waitThemeLanded(page, label, deadline) : undefined
  // ⓪ 先把指针停到一个惰性点上,见 PARK 的注释。
  await page.mouse.move(PARK.x, PARK.y)

  const report = await page.evaluate(
    async ({ focusable, stableFrames: want, budgetMs }) => {
      const end = performance.now() + budgetMs
      const nextFrame = () => new Promise((r) => requestAnimationFrame(r))
      /** 有终点的动画/过渡。无限循环的(spinner)不算 —— 它永远不会结束。 */
      const ending = () =>
        document.getAnimations().filter((a) => {
          const timing = a.effect?.getComputedTiming?.()
          return timing ? timing.iterations !== Infinity : true
        })
      const drain = async () => {
        await Promise.all(ending().map((a) => a.finished.catch(() => undefined)))
      }
      const fingerprint = () => {
        const root = getComputedStyle(document.documentElement)
        const body = getComputedStyle(document.body)
        return [
          root.getPropertyValue('--accent').trim(),
          root.getPropertyValue('--accent-ring').trim(),
          root.getPropertyValue('--bg').trim(),
          root.getPropertyValue('--text-1').trim(),
          body.backgroundColor,
          body.color,
          String(document.querySelectorAll(focusable).length),
          // 元素总数 + 悬停链长度:悬停驱动的那些**不可聚焦**的临时件
          // (Dock 名字条就是一个)只有靠这两个数才进得了指纹。
          String(document.getElementsByTagName('*').length),
          String(document.querySelectorAll(':hover').length),
        ].join('|')
      }

      await drain()
      let last = null
      let same = 0
      let frames = 0
      while (performance.now() < end) {
        await nextFrame()
        frames += 1
        const running = ending().filter((a) => a.playState === 'running').length
        const now = fingerprint()
        if (running === 0 && now === last) {
          same += 1
          if (same >= want) {
            const [accent, ring, bg, , , , focusables] = now.split('|')
            return { ok: true, frames, accent, ring, bg, focusables: Number(focusables) }
          }
        } else {
          same = 0
          // 桥一落地会当场起一批新过渡 —— 排空一次是不够的,得跟着它再排一次。
          if (running > 0) await drain()
        }
        last = now
      }
      return { ok: false, frames, last }
    },
    { focusable: FOCUSABLE, stableFrames, budgetMs: Math.max(500, deadline - Date.now()) },
  )

  if (!report.ok) {
    throw new Error(
      `[settle] ${label}:等这一屏稳下来超时(走了 ${report.frames} 帧)`
        + `\n最后一次指纹:${report.last}`,
    )
  }
  return { ...report, theme: themeState }
}
