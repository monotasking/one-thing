import { useMemo, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import type { CommandId } from '../../keymap/types'
import { useListSelection } from '../../ui/a11y/list-selection'
import { searchIntentOf } from '../keys'
import { indexOfItem } from '../sequence'
import type { SearchItem } from '../sequence'
import { useSearchStore } from '../store'

/**
 * **这块面的键盘**(检索面终稿 附录 B §1「useSearchKeys」那一行 + §4 交互表)。
 *
 * 三条纪律,一条都不在这里重新发明:
 *  · **走位算术只有一处** —— `ui/a11y/list-selection` 的 `handleKey`(全壳唯一那份
 *    「加一减一夹范围」)。这里连方向键的名字都不列,交给 `keys.ts` 的意图表答;
 *  · **落点只有一处** —— ⏎ 落在活动项上,干什么由 `items/registry` 那张表说
 *    (面板不再 `switch (kind)`);
 *  · **焦点恒在输入框** —— 所以 `scrollBlock: null`(原语那条按下标滚的 effect
 *    不跑,滚动归 `SearchList` 那一条依赖 `[selection]` 的 effect)。
 *
 * ── 为什么 `commands` 必须身份稳定 ──────────────────────────────────────
 * 作用域实例每拿到一份新的 `commands` 就要往树上重写一次,而这块面每敲一个
 * 字母都在重渲染。处理器本身不变,变的只是它闭包里的那份历史 —— 那正是 ref 的
 * 用处(手法逐字照旧,从前写在 `SearchPanel.tsx` 里)。
 */

export interface SearchKeysPorts {
  /** ↑↓ 走得到的那一串项。 */
  sequence: readonly SearchItem[]
  /** ⏎ / 落在活动项上时干什么(由面板转交 `items` 注册表)。 */
  activate(item: SearchItem): void
  /** Tab / ⇧Tab = 换搜索范围(这块面里 Tab 不是「把焦点交出去」)。 */
  stepScope(step: 1 | -1): void
  /** ↑ 那一下轮不轮得到历史:输入框空着 ∧ 活动项是序列首项 ∧ 走得动。 */
  canRecallHistory: boolean
}

export interface SearchKeys {
  /** 挂在作用域根上的事件委托(真正拿焦点的是那格输入框)。 */
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void
  /** 命令的落点(`nav.back` / `nav.forward`,出厂 ⌘[ / ⌘]);**身份稳定**。 */
  commands: Readonly<Partial<Record<CommandId, () => void>>>
}

export function useSearchKeys(ports: SearchKeysPorts): SearchKeys {
  const selectionState = useSearchStore(st => st.selection)
  const setActive = useSearchStore(st => st.setActive)
  const stepHistory = useSearchStore(st => st.stepHistory)

  const { sequence } = ports
  const at = indexOfItem(sequence, selectionState.id)

  const selection = useListSelection({
    count: sequence.length,
    active: at,
    onActiveChange: (index) => {
      const item = sequence[index]
      if (item !== undefined) setActive(item.id, 'keyboard', index)
    },
    loop: false,
    homeEnd: false,
    scrollBlock: null,
  })

  /*
   * 处理器闭包里读的东西每渲染都在变(序列 / 历史 / 活动项),而**表的身份不许变**。
   * 一格 ref 装当下那一份,表本身 `useMemo([])` 建一次。
   */
  const liveRef = useRef({ ports, selection, stepHistory })
  liveRef.current = { ports, selection, stepHistory }

  const commands = useMemo(() => ({
    'nav.back': () => { liveRef.current.stepHistory('back') },
    'nav.forward': () => { liveRef.current.stepHistory('forward') },
  }), [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    /*
     * **IME 组字期间一个键都不接**(R10)。
     *
     * 中文输入法选字用的正是 ↑↓ 与 ⏎ —— 组字那一段里把它们当成「走行 / 打开」,
     * 用户就打不出字(而且屏幕上看不出为什么)。`isComposing` 是这件事的**唯一**
     * 判据;`keyCode === 229` 是它在老引擎上的同一句话(Safari / 部分 IME 在
     * `compositionstart` 之前那一下只给得出 229),两条一起收。
     *
     * **不 `preventDefault`**:这一下要原样交给输入法,吞掉它比接错更糟。
     */
    const native = event.nativeEvent
    if (native.isComposing || event.keyCode === 229) return
    const intent = searchIntentOf(event.key, event.shiftKey)
    // 认不出的键**不吞**(与 `exposeIntentOf` / `useRoving` 同一条纪律)。
    if (intent === null) return
    if (intent === 'space') return

    if (intent === 'tab-next' || intent === 'tab-prev') {
      event.preventDefault()
      ports.stepScope(intent === 'tab-next' ? 1 : -1)
      return
    }

    if (intent === 'enter') {
      const item = sequence[at]
      if (item === undefined) return
      event.preventDefault()
      ports.activate(item)
      return
    }

    if (intent === 'history-recall-or-up') {
      /*
       * ↑ 的两种时候。判据是**三句关于此刻屏幕的话**合取(输入框空着 / 已经走到
       * 第一项 / 历史走得动),与从前那三条逐字相同;走不动时**什么都不做**,
       * 而不是掉回走行 —— 那会让同一下键在两种时候干两件事。
       */
      if (ports.canRecallHistory && at <= 0) {
        event.preventDefault()
        stepHistory('back')
        return
      }
      event.preventDefault()
      selection.handleKey(event.key)
      return
    }

    // 剩下的那一格(↓)原样交回原语。
    event.preventDefault()
    selection.handleKey(event.key)
  }

  return { onKeyDown, commands }
}
