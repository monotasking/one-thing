import { useEffect } from 'react'
import { useStageStore } from '../stage/store'

/**
 * 全仓**唯一**的「Esc 退一层」宿主。
 *
 * ── 它修的是什么 ─────────────────────────────────────────────────────────
 * 08-31 用户报障、真机复现:Dock 点开会话总览(默认打开档就是浮窗)→ 按 Esc →
 * `placements` 一个字节都不变,窗还在。真因**不是判据写错,而是根本没有人听**:
 * 那时全仓只有 StageOverlay 挂了一条 Esc,而它只在有舞台时才挂载。浮窗层、
 * 架子层各自都没有,于是「进了某种打开态但还没安放好」的那一下 Esc 掉进空里。
 *
 * 修法不是给浮窗也挂一条 —— 那样「谁该先退」就会在三处各写一遍,而这正是
 * 一切退层链最后失序的方式。链本身是 `stage/transitions.escapeTargetOf` 里的
 * 一个纯函数(次序 = z 序:盖 → 舞台 → 最上面那扇浮窗;架子是常驻家具,不在链里),
 * 这里只负责把 window 上那一下按键交给它。
 *
 * ── 让位契约:内层先,判据是相位不是注册序 ───────────────────────────────
 * 面里的内容可能自己有层次(会话总览的 quicklook / list、菜单、对话框),那几层
 * 先退;它们退不动了就不 `preventDefault()`,这一下才轮到收面板。判据是
 * `e.defaultPrevented` 而不是「内容是谁」:外壳不认识住在里面的东西。
 *
 * 「谁先」靠**传播相位**:内容层听捕获(ExposeView),宿主听冒泡(这里,默认相位)。
 * window 上的捕获监听器永远跑在同一个 window 上的冒泡监听器之前,与谁先
 * addEventListener 无关 —— 于是同步读 `defaultPrevented` 就是稳的。
 *
 * 曾经的两版错法留在 StageOverlay 的注释里当判例(同相位+同步读会被 StrictMode
 * 的双挂载翻盘;queueMicrotask 推迟判定会落在下一个监听器**之前**而不是之后)。
 *
 * ── 接住了才拦 ───────────────────────────────────────────────────────────
 * 没有面可退时**不 preventDefault**:这一下 Esc 不属于我们,后面还有别的层
 * (输入法组字、Composer 的两段式停止)在等它。一个「什么都没做却把事件吃掉」
 * 的监听器,是这条链上最难查的一种故障。
 */
export function useEscapeChain(): void {
  const escapeTopmost = useStageStore((st) => st.escapeTopmost)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      if (escapeTopmost()) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [escapeTopmost])
}
