import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { commandFor, keymapById } from './registry'
import { SEARCH_SIGIL } from './navigators'

/**
 * **查看器的键位派发**(09-02 批 9b 从 `FileViewer` 拆出)。
 *
 * 档由 store 说了算(`view.keymap`),映射由注册表说了算(`registry` 那张
 * `ViewerKeymap` 表)—— 这件只负责**执行**:接住 → 判一次「这一档下这一下
 * 有没有意义」→ 交给落点给的那个动作。
 *
 * ── 它挂在根元素上、用 addEventListener,不是 JSX 的 `onKeyDown` ──────────
 * 一个 `<section>` 不是控件,给它挂键盘监听会被 jsx-a11y 抓(那条规则拦得对 ——
 * 它防的是「把 div 当按钮使」)。这里要的是**捕获这块面里发生的按键**,
 * 语义上是容器级快捷键,不是这个元素自己的交互,所以走 DOM 这一路。
 *
 * 这也正是快捷键三层里的**第 2 层「面域局部键」**(CLAUDE.md):声明在
 * `keymap/scopes.ts` 的 `SCOPED_KEYS`,落点就是这里。撞键裁决只有一条机制 ——
 * 局部监听挂在面域根上(先于 window 收到),**接住了才 `preventDefault()`**;
 * 全局派发器开头一句 `if (e.defaultPrevented) return` 让开。所以下面每一格
 * 「这一下这一档接不接得住」的判据都必须在 `preventDefault()` **之前**:
 * 判早了会吞掉一个本该冒上去的键,判晚了就是替别人做了主。
 *
 * ── 六条命令 → 五个动作 ────────────────────────────────────────────────
 * `jump` 与 `find` 开的是**同一条跳转条**,只差一个前缀(`⌘F` 先把检索标打上),
 * 所以它们合成一个动作 `onJump(query)`。剩下四个各是一件事。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:一个 effect,依赖只有 `rootRef` —— 监听**挂一次**,
 *     直到卸载。语境(档 / 折行 / 编辑态 / 行数 / 可编辑)与那五个动作走一个
 *     ref,每次渲染刷新,所以监听里读到的永远是这一帧的事实。
 *     从前它把这九格全列进 deps,于是**每次改行号都要摘一次监听再挂一次**;
 *     行为一模一样,少的只是那些无谓的 add/removeEventListener。
 *     无模块级副作用 → 不需要 HMR dispose(寿命是调用它的组件,不是模块)。
 *  ② UI 生命状态:无自有状态,不画东西。
 *  ③ UI 交互状态:无。它是键盘那条路,鼠标那条口在状态栏上(`ViewerStatusBar`
 *     的「⌘L 行 n」与「⌘F」两颗 —— 组件消费义务:只有快捷键能做到的事,
 *     对不知道那个键的人等于不存在)。
 */
export interface ViewerKeymapContext {
  /** 键位档(registry 那张表的键)。 */
  keymap: string
  /** 折行现在开着没有 —— `toggleWrap` 要的是**下一个**值,得先知道这一个。 */
  wrap: boolean
  /** 编辑态。`⌘S` 只在编辑态里有意义(不在编辑态就让它冒上去)。 */
  editing: boolean
  /** 这一型按不按行寻址。`undefined` = 不按(图 / 播放条 / 诚实态)→ 跳转条整条不接。 */
  lineCount: number | undefined
  /** 这一型能不能编辑。不能就不接 `toggleEdit`。 */
  editable: boolean
  onSave: () => void
  /** 开跳转条,带上这串前缀(`''` = 行号跳,`SEARCH_SIGIL` = 检索)。 */
  onJump: (query: string) => void
  onWrap: (next: boolean) => void
  onEdit: (next: boolean) => void
  onClose: () => void
}

export function useViewerKeymap(
  rootRef: RefObject<HTMLElement | null>,
  ctx: ViewerKeymapContext,
): void {
  // 语境走 ref:监听只挂一次,读到的却永远是这一帧的事实(理由见文件头①)。
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onKey = (event: KeyboardEvent) => {
      const c = ctxRef.current
      const command = commandFor(keymapById(c.keymap), event)
      if (!command) return
      // 只有真的接住了才 preventDefault:**消费掉的键才有资格挡住别人**。
      switch (command) {
        case 'save':
          if (!c.editing) return
          event.preventDefault()
          c.onSave()
          return
        case 'jump':
          if (c.lineCount === undefined) return
          event.preventDefault()
          c.onJump('')
          return
        case 'find':
          // ⌘F = 同一条跳转条,前缀先打上。这一型不按行寻址(图 / 播放条 /
          // 诚实态)时**不接**这一下 —— 让它原样冒上去,别处也许还用得着。
          if (c.lineCount === undefined) return
          event.preventDefault()
          c.onJump(SEARCH_SIGIL)
          return
        case 'toggleWrap':
          event.preventDefault()
          c.onWrap(!c.wrap)
          return
        case 'toggleEdit':
          if (!c.editable) return
          event.preventDefault()
          c.onEdit(!c.editing)
          return
        case 'close':
          event.preventDefault()
          c.onClose()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [rootRef])
}
