import { useCallback } from 'react'
import { useTocStore } from '../toc/store'
import { useStageStore } from '../stage/store'
import { requestFocusOnOpen } from '../stage/focus-follow'
import { useAgentMenu } from '../components/agent-menu'
import { useExposeStore } from '../expose/store'
import { useWorkspacePalette } from '../workspace/components/palette-hub'
import { useWorkspaceStore } from '../workspace/store'
import { projectWorkspaces, workspaceAtSlot } from '../workspace/projection'
import {
  TOGGLE_COMMAND_PREFIX,
  WORKSPACE_SLOT_COMMAND_PREFIX,
  shelfSideOfCommand,
} from './transitions'
import type { CommandId } from './types'

/**
 * **一条全局命令怎么落地** —— 命令 id → 真正的那个动作。
 *
 * ── 它从前是派发器,现在只是派发器的一半(09-02 R1)────────────────────────
 * 这只文件从前叫 `useKeymapDispatch`:一条 window keydown 监听 + 一张动作表。
 * R1 把**监听**收进了全壳唯一的那一个(`focus/dispatch.ts` 的 `useFocusDispatch`),
 * 留在这里的是**动作表**,提成 `useKeymapCommandRunner()` 由那边消费。
 *
 * 为什么是提出来共用、而不是抄一份过去(R0 留账 4 的结清):这张表订阅着五个
 * store,抄一份就等于「⌘P 开检索」这件事有了两个产地 —— 它们迟早分叉,而分叉
 * 的那一天没有任何一条测试会红,只有用户按下去发现响的是上一版。
 *
 * 表本身一个字没改:命令 id 的形状与反解仍然只有 `keymap/transitions` 一个产地,
 * 这里认不出的 id 一律放行给后面的分支,不去猜。
 *
 * 结构导航键(Esc / 方向键 / Enter / Space)不进这张表,理由见 types.ts 顶部。
 */
export function useKeymapCommandRunner(): (id: CommandId) => void {
  const toggleItem = useStageStore((st) => st.toggleItem)
  const toggleShelfCollapsed = useStageStore((st) => st.toggleShelfCollapsed)
  const toggleToc = useTocStore((st) => st.togglePanel)
  const toggleAgentMenu = useAgentMenu((st) => st.toggle)
  const toggleWorkspacePalette = useWorkspacePalette((st) => st.toggle)

  return useCallback(
    (id: CommandId) => {
      if (id.startsWith(TOGGLE_COMMAND_PREFIX)) {
        const item = id.slice(TOGGLE_COMMAND_PREFIX.length)
        /*
         * ── §3.5 规则 2:**用键盘打开一块面,焦点进那块面** ────────────────
         * 「从 Dock 开一块面」有两条路,答案不一样:指针点那块瓦时焦点已经落在
         * 瓦上了(点击自己落焦),再送会把焦点从瓦上拽走 —— 连着按两下同一块瓦
         * 就不再是「开、关」。所以那条路维持今天,**这条路**(键盘)才送:
         * 按下 ⌘ 数字的人手在键盘上,他要的正是接着用键盘。
         *
         * 这里**点名**而不是当场 `activate`:落定那一刻装着它的宿主层还没挂上来
         * (React 要到下一次提交才渲染那一层),当场叫一律落空 —— 单测证伪过一版。
         * 点完名之后由那唯一的接线处(`stage/focus-follow` 的 hook)在提交之后送。
         * 收回 Dock 的那一下点名会被同一只纯函数当场丢掉(那时没有可送的面)。
         */
        requestFocusOnOpen(item)
        toggleItem(item)
        /*
         * ── §3.5 规则 2:**用键盘打开一块面,焦点进那块面** ────────────────
         * 「从 Dock 开一块面」有两条路,而它们的答案不一样:指针点那块瓦时
         * 焦点已经落在瓦上了(点击自己落焦),再 `activate` 会把焦点从瓦上拽走 ——
         * 连着按两下同一块瓦就不再是「开、关」。所以那条路维持今天,**这条路**
         * (键盘)才送:按下 ⌘ 数字的人手在键盘上,他要的正是接着用键盘。
         *
         * 这里是键盘这条路**唯一**的入口,所以这一句只此一处;形态之间的挪动
         * (拼舞台 / 钉边 / 撕浮窗)是另一回事,收在 `stage/focus-follow` 那一处。
         *
         * 收回 Dock 的那一下不送(`toggleItem` 是开关语义):那时没有可送的面,
         * 焦点该回哪儿是结构归还的事。
         */
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
       * 这里不认识 `shelf.<side>.toggle` 的拼法,那个字符串只有一个产地;
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
       * 落在哪个项目下由那条 action 自己判(当前会话的项目),这里不判。
       */
      if (id === 'session.new') {
        void useExposeStore.getState().newSessionInCurrentProject()
      }
    },
    [toggleItem, toggleShelfCollapsed, toggleToc, toggleAgentMenu, toggleWorkspacePalette],
  )
}
