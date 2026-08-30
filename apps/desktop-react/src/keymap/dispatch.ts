import { useEffect } from 'react'
import { useTocStore } from '../toc/store'
import { useStageStore } from '../stage/store'
import { useAgentMenu } from '../components/agent-menu'
import { useKeymapStore } from './store'
import { TOGGLE_COMMAND_PREFIX, hasModifier, lookupCommand } from './transitions'
import type { CommandId } from './types'

/** 焦点在输入面里:无修饰的单键属于输入框,不属于快捷键。 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

/**
 * 全局唯一的键盘派发器 —— 外壳挂一次,别处不许再挂第二个 window keydown。
 *
 * 它只认识注册表:一次按键先问「这落在哪条命令上」,命中才动手。
 * 所以「⌘P 开检索」这件事在代码里已经没有落点了 —— 那是注册表里的一行数据,
 * 用户改绑之后老组合当场失效,新组合当场生效,派发器一个字都不用改。
 *
 * 结构导航键(Esc / 方向键 / Enter / Space)不经过这里,理由见 types.ts 顶部。
 */
export function useKeymapDispatch(): void {
  const overrides = useKeymapStore((st) => st.overrides)
  const toggleItem = useStageStore((st) => st.toggleItem)
  const toggleShelfCollapsed = useStageStore((st) => st.toggleShelfCollapsed)
  const toggleToc = useTocStore((st) => st.togglePanel)
  const toggleAgentMenu = useAgentMenu((st) => st.toggle)

  useEffect(() => {
    const run = (id: CommandId) => {
      if (id.startsWith(TOGGLE_COMMAND_PREFIX)) {
        toggleItem(id.slice(TOGGLE_COMMAND_PREFIX.length))
        return
      }
      if (id === 'shelf.right.toggle') {
        toggleShelfCollapsed('right')
        return
      }
      if (id === 'toc.toggle') {
        toggleToc()
        return
      }
      // 只开菜单,不替用户选人 —— 理由写在 keymap/types.ts 的命令族那一段。
      if (id === 'agent.menu') toggleAgentMenu()
    }

    const onKey = (e: KeyboardEvent) => {
      // 输入框里带修饰键的组合照常派发(⌘P 在写字时也该好使),无修饰的单键让给输入。
      if (isTypingTarget(e.target) && !hasModifier(e)) return
      const id = lookupCommand({ overrides }, e)
      if (!id) return
      e.preventDefault()
      run(id)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overrides, toggleItem, toggleShelfCollapsed, toggleToc, toggleAgentMenu])
}
