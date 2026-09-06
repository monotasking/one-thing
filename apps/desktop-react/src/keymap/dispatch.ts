import { useCallback } from 'react'
import { useTocStore } from '../toc/store'
import { useStageStore } from '../stage/store'
import { summonStageItem } from '../stage/open-item'
import { useAgentMenu } from '../components/agent-menu'
import { useExposeStore } from '../expose/store'
import { useWorkspacePalette } from '../workspace/components/palette-hub'
import { useWorkspaceStore } from '../workspace/store'
import { focusLeafOf, useWorkbenchStore } from '../workbench/store'
import { CENTER_REGION } from '../workbench/regions'
import { reorderTab } from '../workbench/drop-commit'
import { projectWorkspaces, workspaceAtSlot } from '../workspace/projection'
import { notify } from '../services/notify'
import { t } from '../i18n'
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
  const toggleShelfCollapsed = useStageStore((st) => st.toggleShelfCollapsed)
  const toggleToc = useTocStore((st) => st.togglePanel)
  const toggleAgentMenu = useAgentMenu((st) => st.toggle)
  const toggleWorkspacePalette = useWorkspacePalette((st) => st.toggle)

  return useCallback(
    (id: CommandId) => {
      if (id.startsWith(TOGGLE_COMMAND_PREFIX)) {
        /*
         * ── `toggle:<面>` 的语义 = **召唤**,不是开关(S1,设计 §14;09-03 用户
         *    提出并拍定第四格「回去」)────────────────────────────────────────
         * 一个键按下去,先把这块面弄到眼前(没开就开、被挡着就露出来),再把键盘
         * 交给它;已经在它里面了就把键盘**还回去**。**关面不在这条键上** ——
         * 关面是 Esc 的活(退层链),一个「聚焦键」顺手关掉一块面是从前那条
         * 旧那条纯开关与业界(VS Code ⌘⇧E 一族)分歧最大的一格。
         *
         * 命令 id 一个字没改(改了会作废用户已存的改绑),换的只有落点与文案。
         * **鼠标点 Dock 瓦与这条键盘命令是同一台机器**(W7-p 裁定 6,09-05 更正):
         * 两个入口都落在 `stage/open-item.summonStageItem`,只差寻址
         * (`itemSummonTarget` / `refSummonTarget`)。这段注释从前写着「指针那条路
         * 走 `clickDockIcon`、不 activate」—— 那台第二机器在 W7-p 里删掉了,
         * 而注释留在原地,成了一句**过时的假话**(审计 A 的留账,W7-c 结清)。
         * 旧那口纯开关 `toggleItem` 已随 S2(09-04)删掉。
         *
         * 四态判据、点名(`requestFocusOnOpen`)与分流全在 store 的 `summonItem`
         * 里,这里只剩「哪条命令走哪个动作」这一句 —— 这张表本来就只该有这一句。
         */
        /* 启动瓦(「目录」)自述它自己那一下 —— 判词在 `stage/open-item.ts`。 */
        summonStageItem(id.slice(TOGGLE_COMMAND_PREFIX.length))
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
        /*
         * 目录的展开态按会话记(W5-a),所以这条全局键得说清楚是**哪一条**的目录。
         * **取动作而不是订阅**(同 `session.new` 那条的口径):当前会话由投影当场读,
         * 派发器不缓存一份 —— 缓存了就会在换会话之后开错那一条的目录。
         */
        toggleToc(useExposeStore.getState().currentSessionId)
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
        return
      }
      /*
       * 真全屏(W2)。**取动作而不是订阅**(同上两条的口径)。
       *
       * 拒绝那一档要**说出来**:一个按下去什么都不发生的键,用户读不出是「坏了」
       * 还是「这里不支持」。今天唯一说 false 的是聊天(`ContentKind.fullable`,
       * 判词写在那格上),所以这一句文案就是那一句;将来第二种拒绝进来时,
       * 这里要按种类取话,不是再加一条 if。
       */
      if (id === 'workbench.toggleFull') {
        if (useWorkbenchStore.getState().toggleFull() === 'refused') {
          notify({ level: 'info', source: 'workbench.full', title: t('full.refuseChat') })
        }
        return
      }
      /*
       * **标签换序**(W7-c 裁定 3)。它是「左移一位 / 右移一位」从标签动作表里
       * 升上来的那条键盘路 —— 落定走的仍是**拖拽落定同一只** `reorderTab`
       * (播报「已移到第 n 位」在它里面),所以键盘、菜单(已删)、拖拽三条路
       * 从来只有一个动作。
       *
       * `at` 是对着**本来那张表**的下标:往左 = 插到前一格之前(`active - 1`);
       * 往右 = 插到后一格**之后**,也就是 `active + 2` —— 落点说的是「第 at 格
       * 之前」,而 `active + 1` 指的正是自己后面那一格的**前面**(= 原地不动)。
       * 那个 +2 不是魔法数,是这个坐标系的定义;两端到头时 `reorderTab` 自己
       * 判成空动作(它挡 `at === from` 与 `at === from + 1`)。
       *
       * 目标是**焦点叶的活动 tab**,与 `workbench.toggleFull` 同一句问法。
       */
      const step = id === 'workbench.moveTabLeft' ? -1 : id === 'workbench.moveTabRight' ? 2 : 0
      if (step !== 0) {
        const st = useWorkbenchStore.getState()
        const tree = st.regions[CENTER_REGION]
        if (!tree) return
        const leaf = focusLeafOf(tree, st.focusLeafId)
        reorderTab(leaf.id, leaf.active, leaf.active + step)
      }
    },
    [toggleShelfCollapsed, toggleToc, toggleAgentMenu, toggleWorkspacePalette],
  )
}
