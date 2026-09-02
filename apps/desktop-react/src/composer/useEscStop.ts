import { useCallback, useEffect, useRef, useState } from 'react'
import { ESC_STOP_WINDOW_MS } from '../components/motion'

/**
 * ── 切线 A:Esc 的两段式停止 ────────────────────────────────────────────────
 *
 * **08-31 拍板:与 Vue 壳同口径,连按两次才停**。第一下只「预备」——占位符换成
 * 「再按一次停止」那句(有草稿时占位符本来不可见,预备就是静默的,与 Vue 同样的
 * 取舍);`ESC_STOP_WINDOW_MS`(2000ms)内第二下才交 abort。
 * 窗口过期、引擎收尾、面板卸载都拆除预备态。
 *
 * 「预备态」与「它什么时候变成一次 abort」是**同一件事的两半**,所以整只住在
 * 这一个文件里 —— 计时器、拆除的三条路、和判据(焦点在这块面板里且引擎在跑)。
 * 把判据留在键盘那一头会让「两段」分成两个文件,那正是这次拆分要治的病。
 *
 * ## 三张表
 *
 * **生命周期**:挂载即闲(`armed=false`,没有计时器);`busy` 落回 false 时
 * 拆预备(那一轮已经停了,残留的「再按一次」是在说谎);卸载清计时器。
 * 它没有宿主形态之分 —— 它不画东西,只有一格布尔交给占位符。
 *
 * **UI 生命状态**:只有 `armed` 一格布尔,没有 loading / error / empty ——
 * abort 交出去之后这只 hook 就不再说话了,那一轮停没停由 `busy` 自己回答。
 *
 * **UI 交互状态**:`armed` 唯一的呈现是占位符换字(`composer.escStopHint`),
 * 不换底、不换键、不禁任何控件 —— 两段式的第一段必须是**静默的**。
 */
export interface EscStop {
  /** 预备中(第二下 Esc 就会交 abort)。唯一消费点是输入框的占位符。 */
  armed: boolean
  /**
   * 全局键那头把 Esc 的第③层交给它。
   *
   * 返回 `true` = 这一下**已经被两段式停止消费掉了**(要么预备、要么真停),
   * 调用方据此 `preventDefault()`;返回 `false` = 条件不成立(没在跑,或者焦点
   * 不在这块面板里),这一下原样放行给外层。
   *
   * 为什么不是它自己挂一个 window 监听:Esc 的三层有**次序**(ask → 抽屉 →
   * 停止),而两个 window 监听的先后取决于 hook 的调用次序 —— 那是一条看不见
   * 的约定。次序是编排的事,所以由编排点显式地最后叫这一口。
   */
  tryStop: () => boolean
}

/**
 * ── 「焦点在这块面板里」这条前提**没了参数,变成了结构**(09-03 R2)──────────
 * R2 之前它是 `panelRef.contains(document.activeElement)` 一句判据(不加的话,
 * 在总览 / 检索面板里按 Esc 退层会顺手把后台那一轮停掉 —— 一次看不见的破坏)。
 * 接进响应链之后那句判据**没有换一种写法,而是没有了**:`tryStop` 的唯一调用点
 * 是输入面板那一格作用域的 `onEscape`,而树只在这块面**在活动路径上**时才问它。
 * 前提于是由结构保证,不再由这只 hook 自己去问一个全局(设计 §7 的第三条:
 * 别再读 `activeElement` 判「我是不是当前」)。
 *
 * 中间还站过一版 `active: boolean`(把 `<FocusScope>` 的 `isActive` 递进来)。
 * 那一版**测不出来**:`isActive` 与「树问不问它」是同一件事,给它传 `true` 也
 * 翻不红任何用例 —— 一条翻不红的守卫就是一条没有守卫的注释,所以删掉。
 *
 * @param busy 引擎在不在跑。
 * @param onAbort 第二下 Esc 交出去的那一停。
 */
export function useEscStop(
  /* ui-consume-allow: async-busy-boolean — 这不是一格手写的忙布尔,是**读来的**:
   * 引擎忙不忙唯一产地在 `data/chat-source.ts` 的 `selectEngineBusy`,编排点
   * (`useComposerBusy()`)订到之后原样递进来。这里既不置它也不清它。 */
  busy: boolean,
  onAbort: () => void,
): EscStop {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const disarm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setArmed(false)
  }, [])

  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setArmed(true)
    timer.current = setTimeout(() => {
      timer.current = null
      setArmed(false)
    }, ESC_STOP_WINDOW_MS)
  }, [])

  // 引擎收尾就拆预备(那一轮已经停了,残留的「再按一次」是在说谎)。
  useEffect(() => {
    if (!busy) disarm()
  }, [busy, disarm])

  // 卸载清计时器。
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const tryStop = useCallback(() => {
    if (!busy) return false
    if (armed) {
      disarm()
      onAbort()
    } else {
      arm()
    }
    return true
  }, [busy, armed, arm, disarm, onAbort])

  return { armed, tryStop }
}
