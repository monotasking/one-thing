import { useEffect } from 'react'
import { useTocStore } from '../toc/store'
import { useStageStore } from '../stage/store'
import { useAgentMenu } from '../components/agent-menu'
import { useExposeStore } from '../expose/store'
import { useKeymapStore } from './store'
import { useWorkspacePalette } from '../workspace/components/palette-hub'
import { useWorkspaceStore } from '../workspace/store'
import { projectWorkspaces, workspaceAtSlot } from '../workspace/projection'
import {
  TOGGLE_COMMAND_PREFIX,
  WORKSPACE_SLOT_COMMAND_PREFIX,
  hasModifier,
  lookupCommand,
  shelfSideOfCommand,
} from './transitions'
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
  const toggleWorkspacePalette = useWorkspacePalette((st) => st.toggle)

  useEffect(() => {
    const run = (id: CommandId) => {
      if (id.startsWith(TOGGLE_COMMAND_PREFIX)) {
        toggleItem(id.slice(TOGGLE_COMMAND_PREFIX.length))
        return
      }
      /*
       * 工作区序号直达。**取动作而不是订阅**(同 session.new 那条的口径):
       * 序号 → 哪个工作区由投影当场算,派发器不缓存一份表 —— 缓存了就会在
       * 建 / 删之后指错人。第 n 个不存在时什么都不做:一个按不响的键好过
       * 一个偷偷切到别处的键。
       */
      if (id.startsWith(WORKSPACE_SLOT_COMMAND_PREFIX)) {
        const slot = Number(id.slice(WORKSPACE_SLOT_COMMAND_PREFIX.length))
        const { spaces, currentId, switchTo } = useWorkspaceStore.getState()
        const target = workspaceAtSlot(projectWorkspaces(spaces, currentId), slot)
        if (target) switchTo(target.id)
        return
      }
      /*
       * 四条架子各一条(09-01)。**反解落在 transitions 那一处** ——
       * 派发器不认识 `shelf.<side>.toggle` 的拼法,那个字符串只有一个产地;
       * 认不出的 id 一律放行给后面的分支,不去猜是哪一侧。
       */
      const shelfSide = shelfSideOfCommand(id)
      if (shelfSide) {
        toggleShelfCollapsed(shelfSide)
        return
      }
      if (id === 'toc.toggle') {
        toggleToc()
        return
      }
      // 只开菜单,不替用户选人 —— 理由写在 keymap/types.ts 的命令族那一段。
      if (id === 'agent.menu') {
        toggleAgentMenu()
        return
      }
      // 同上:只开面板,切到哪个工作区是面板里那一下 ↵。
      if (id === 'workspace.palette') {
        toggleWorkspacePalette()
        return
      }
      /*
       * 新建会话。**取动作而不是订阅** —— 它是个 async action,订阅它只会让
       * 这条 effect 白重挂一次;`getState()` 的引用是稳的(与 Overview 里
       * 事件处理器一律走 getState 同一口径)。
       * 落在哪个项目下由那条 action 自己判(当前会话的项目),派发器不判。
       */
      if (id === 'session.new') {
        void useExposeStore.getState().newSessionInCurrentProject()
      }
    }

    const onKey = (e: KeyboardEvent) => {
      /*
       * **局部先接,没接住才轮到全局**(09-01 三层立法,见 keymap/scopes.ts)。
       *
       * 面域局部键(查看器的 ⌘S/⌘L/⌘F、文件行的 ⌘I)挂在各自那块面的**根元素**上,
       * 于是它们先于这个 window 监听收到同一下按键;接住的那一下会 `preventDefault()`。
       * 这一句是裁决的全部实现 —— 修前没有它,「用户把某条命令改绑到 ⌘I」会让
       * 文件行的详情键和那条全局命令**同时响**(F1 那条留账说的正是这件事)。
       *
       * 它只认 `defaultPrevented`,不认「是谁接的」:任何一层真正消费掉了这一下,
       * 全局就该让开。反过来,没消费的一律放行 —— 查看器里按 ⌘P 照样开检索。
       */
      if (e.defaultPrevented) return
      // 输入框里带修饰键的组合照常派发(⌘P 在写字时也该好使),无修饰的单键让给输入。
      if (isTypingTarget(e.target) && !hasModifier(e)) return
      const id = lookupCommand({ overrides }, e)
      if (!id) return
      e.preventDefault()
      run(id)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overrides, toggleItem, toggleShelfCollapsed, toggleToc, toggleAgentMenu, toggleWorkspacePalette])
}
