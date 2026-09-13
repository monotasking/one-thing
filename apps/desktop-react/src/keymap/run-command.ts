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
 * **一条全局命令怎么落地** —— 命令 id → 真正的那个动作。**模块级纯函数,不是 hook**。
 *
 * ── 它为什么从 hook 里降下来(K2b-1)────────────────────────────────────────
 * 从前这张表长在 `dispatch.ts` 的 `useKeymapCommandRunner()` 里,订阅着四个 store。
 * 于是「跑一条壳命令」这件事**只有 React 树里的人做得到**:SSE 推来一条
 * `do(window:…, 'focus')`(原子方案 §5「资源的家在哪就去哪跑」,`home: 'shell'` 那一路)
 * 的接收点不在组件里,它调不到这张表。降成模块级函数之后,**键盘、鼠标、将来的
 * `app:command` 消费者共用同一台机器** —— 而这正是那张表当初从 `dispatch` 里提出来
 * 共用的同一条理由(抄一份 = 两个产地 = 迟早分叉,分叉那天没有一条测试会红)。
 *
 * ── 「取动作而不是订阅」在这里从口径变成了结构 ────────────────────────────
 * 原来那张表里已经有五条写着「取动作而不是订阅」(`session.new` / 工作区序号 /
 * `toc.toggle` / 全屏 / 换序),另外四条(`shelf.*` / `toc.toggle` 的开关本体 /
 * `agent.menu` / `workspace.palette`)是订阅来的 —— 而它们订阅的**全都是普通
 * zustand store 上的 action**(`useStageStore` / `useTocStore` / `useAgentMenu` /
 * `useWorkspacePalette`,后两只各是一个布尔的家)。`getState()` 一样拿得到,而且
 * 拿到的引用是稳的。所以**这一批一条都没有留在 hook 里**:
 *
 *   `HOOK_ONLY_COMMANDS` = 空。
 *
 * 这一格不是注释里的一句话而是**导出的常量**,因为它是被测的契约:
 * `__tests__/run-command.test.ts` 拿它对表 —— 表上的回 `false`(hook 才跑得动),
 * 不在表上的每一条都必须回 `true`。哪天真有一条只能靠 React context 才拿得到的动作
 * (今天没有),它进这张表 + 留在 hook 里,用例自己跟着走。
 *
 * 结构导航键(Esc / 方向键 / Enter / Space)不进这张表,理由见 `types.ts` 顶部。
 */

/**
 * **还留在 `useKeymapCommandRunner` 里跑的命令**(拿不到脱离 React 的动作口)。
 *
 * 今天是空的 —— 四条曾经靠订阅拿动作的命令(`shelf.*` / `toc.toggle` /
 * `agent.menu` / `workspace.palette`)背后都是普通 zustand store,`getState()`
 * 一样拿得到。留着这一格是为了**让「有例外」这件事有个说得出名字的地方**:
 * 空表和「没有这回事」在测试里不是一件事。
 */
export const HOOK_ONLY_COMMANDS: readonly CommandId[] = []

/**
 * 跑一条壳命令。**认得就跑并回 `true`,认不出就回 `false` —— 不猜**。
 *
 * 「认得」说的是「这条命令归这张表管」,不是「它这一下真的改了什么」:第 n 个工作区
 * 不存在、中央区还没有树、换序到头了,都是**认得且跑过了**的空动作(一个按不响的键
 * 好过一个偷偷切到别处的键)。调用方要区分的话得自己问状态,而不是读这个布尔。
 *
 * ── 入参是 `string` 而不是 `CommandId`(与派工令的字面写法有出入,理由在此)──
 * `CommandId`(`./types.ts`)是一个近乎封闭的联合;收它就等于在类型上宣称
 * 「进来的一定是一条真命令」,而这只函数存在的**全部理由**是那句「认不出回
 * `false`」—— 那一档在 `CommandId` 下压根表达不出来。而它将来的调用方(SSE 送来的
 * `app:command` / `do(<shell 资源>, …)`)手里只有一个**没校验过的字符串**:收
 * `CommandId` 会逼每个入口写一次 `as`,而「满仓库的 `as` 等于把守卫关掉,还看不出
 * 哪一处是真校验过」正是 `packages/core/resource/ref.ts` 文件头点名的那种病。
 *
 * 编译期那道闸没有丢,它只是站在**该站的地方**:壳内唯一的调用方
 * `useKeymapCommandRunner` 收的仍是 `CommandId`,所以壳里写错一条命令名照旧当场红。
 */
export function runShellCommand(id: string): boolean {
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
     * (`itemSummonTarget` / `refSummonTarget`)。
     *
     * 四态判据、点名(`requestFocusOnOpen`)与分流全在 store 的 `summonItem`
     * 里,这里只剩「哪条命令走哪个动作」这一句 —— 这张表本来就只该有这一句。
     */
    /* 启动瓦(「目录」)自述它自己那一下 —— 判词在 `stage/open-item.ts`。 */
    summonStageItem(id.slice(TOGGLE_COMMAND_PREFIX.length))
    return true
  }
  /*
   * 工作区序号直达。**取动作而不是订阅**:序号 → 哪个工作区由投影当场算,
   * 派发器不缓存一份表 —— 缓存了就会在建 / 删之后指错人。第 n 个不存在时什么都
   * 不做:一个按不响的键好过一个偷偷切到别处的键。
   */
  if (id.startsWith(WORKSPACE_SLOT_COMMAND_PREFIX)) {
    const slot = Number(id.slice(WORKSPACE_SLOT_COMMAND_PREFIX.length))
    const { spaces, currentId, switchTo } = useWorkspaceStore.getState()
    const target = workspaceAtSlot(projectWorkspaces(spaces, currentId), slot)
    if (target) switchTo(target.id)
    return true
  }
  /*
   * 四条架子各一条(09-01)。**反解落在 transitions 那一处** ——
   * 这里不认识 `shelf.<side>.toggle` 的拼法,那个字符串只有一个产地;
   * 认不出的 id 一律放行给后面的分支,不去猜是哪一侧。
   */
  const shelfSide = shelfSideOfCommand(id)
  if (shelfSide) {
    useStageStore.getState().toggleShelfCollapsed(shelfSide)
    return true
  }
  if (id === 'toc.toggle') {
    /*
     * 目录的展开态按会话记(W5-a),所以这条全局键得说清楚是**哪一条**的目录。
     * 当前会话由投影当场读,不缓存一份 —— 缓存了就会在换会话之后开错那一条的目录。
     */
    useTocStore.getState().togglePanel(useExposeStore.getState().currentSessionId)
    return true
  }
  // 只开菜单,不替用户选人 —— 理由写在 keymap/types.ts 的命令族那一段。
  if (id === 'agent.menu') {
    useAgentMenu.getState().toggle()
    return true
  }
  // 同上:只开面板,切到哪个工作区是面板里那一下 ↵。
  if (id === 'workspace.palette') {
    useWorkspacePalette.getState().toggle()
    return true
  }
  /*
   * ── `session.new` 那一段 **K2 删掉**(09-12 用户裁定 1)────────────────────
   * 「新建」不再有应用层兜底:⌘N 是 `content.new`,由**响应者**答 —— 会话叶 /
   * 会话总览 / composer 答「新会话」,浏览器叶答「新标签」,终端叶答「新终端」;
   * 焦点不在任何一种内容里就不响。`useExposeStore.newSessionInCurrentProject`
   * 一个字没改,只是它的调用点从这张表搬到了那几格响应者上。
   */
  /*
   * 真全屏(W2)。
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
    return true
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
    // 树还没播种 = 认得这条命令、这一下没得动。**仍旧是 `true`**(见函数头)。
    if (tree) {
      const leaf = focusLeafOf(tree, st.focusLeafId)
      reorderTab(leaf.id, leaf.active, leaf.active + step)
    }
    return true
  }
  return false
}
