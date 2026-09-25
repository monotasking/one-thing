import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { DEFAULT_PANEL_VISIBILITY, PanelVisibilityContext } from './visibility'
import type { PanelVisibility } from './visibility'
import { SettingsMock } from './SettingsMock'
import { SearchPanel } from '../search/components/SearchPanel'
import { NotificationsPanel } from './NotificationsPanel'
import { ExposeView } from '../expose/components/ExposeView'
import { WorkspaceOverview } from '../workspace/components/WorkspaceOverview'
import { AppsPanel } from './AppsPanel'
import { MusicPanel } from './MusicPanel'
import { MemoryPanel } from './memory/MemoryPanel'
import { TodoPanel } from './todo/TodoPanel'
import { TodoStripHeader } from './todo/TodoHeader'
import type { ComponentType } from 'react'
import type { StripHeaderProps } from '../workbench/kinds'
import {
  APPS_ITEM_ID,
  NOTIFICATIONS_ITEM_ID,
  SESSIONS_ITEM_ID,
  SETTINGS_ITEM_ID,
  WORKSPACE_ITEM_ID,
} from '../stage/items'

/**
 * 内容按 id 查表 —— 舞台和钉栏共用同一张表,
 * 所以「同一个东西在浮层里和在右栏里长得一样」是结构保证,不靠自觉。
 *
 * **`ChatStream` 不在这张表里**:它是外壳中央那条恒在的聊天区(住在 AppShell 的
 * `.chatArea` 里),不是一块可以被钉进架子或抬上舞台的面板。它跟这些面板同住
 * `src/content/` 只是因为它们都是「内容」,不是因为它们同一种东西。
 */
const RENDERERS: Record<string, () => ReactNode> = {
  /*
   * **`files` 那一行撤了**(W6-a,设计 `workbench-tabs-2026-09.md` §3)。
   * 文件面板不再是「一块面」,而是**一族**面:一个目录一份
   * `dir:<绝对路径>`(`content/kinds/dir.tsx`)。Dock 上那块瓦
   * 因此从「一块面」降格成**启动瓦**(`stage/launchers.ts` + `content/files-launcher.tsx`):
   * 点它 = 开当前会话那个目录,右键 = 最近开过的那几个 + 「打开目录…」。
   */
  /*
   * **`diff` 那一行撤了**(「改动」面,正本
   * `apps/desktop-react/docs/changes-panel-2026-09.md` §3.2)。改动不再是「一块面」
   * (那一份写死五行代码的 `DiffMock` 连同它在 `mocks.module.css` 里的五条类一起
   * 删了),它是**一族**面:一个工作目录一份 `diff:<workdir>`
   * (`content/kinds/diff.tsx`)。Dock 上那块瓦因此从「一块面」降格成**启动瓦**
   * (`content/diff-launcher.tsx`):点它 = 开当前会话那个目录的改动面,右键 =
   * 最近开过的那几个目录。判例与 `files` / `terminal` 两行逐字相同。
   */
  /*
   * **`terminal` 那一行撤了**(T1,方案 `apps/desktop-react/docs/terminal-browser-2026-09.md`
   * §2.1)。终端不再是「一块面」,它是**一族**面:一格 PTY 一份
   * `terminal:<id>`(`content/kinds/terminal.tsx`)。Dock 上那块瓦因此从「一块面」
   * 降格成**启动瓦**(`content/terminal-launcher.tsx`):点它 = 在当前会话那个
   * 目录开一格,右键 = 活着的那几格 + 新建两条。判例与 `files` 那一行逐字相同。
   */
  [SETTINGS_ITEM_ID]: SettingsMock,
  search: SearchPanel,
  /*
   * 音乐(音乐收尾 · 壳半边)。它是一块**普通的瓦**:面里每一颗按钮走的都是
   * `resources.do`(与模型调的同一条)。为什么它走 `panel` 这条路而不是自己
   * 登记一种内容,判词写在 `stage/items.ts` 那一行上(refId 会与 core 的
   * `music:` 资源地址撞名)。
   */
  music: MusicPanel,
  // 我的清单(待办 T3)。与音乐同理走 `panel` 这条路:refId 若自成一种内容会与 core 的 `todo:` 地址撞名。
  todo: TodoPanel,
  // 内存面板:按进程与缓存显示内存占用。
  memory: MemoryPanel,
  [NOTIFICATIONS_ITEM_ID]: NotificationsPanel,
  [SESSIONS_ITEM_ID]: ExposeView,
  /*
   * **`providers` 那一行撤了**(2026-09-13,用户裁定「把模型设置移到设置中去」)。
   * 模型服务不再是一块瓦,它是**设置页里的一页**(`content/settings/pages.tsx` 的
   * `models` 那一行,`layout: 'fill'`)。于是 Dock 上那块瓦、这张表里那一行两样
   * 一起退役 —— 与 W1 「查看器」那一段逐字同一条处置;存量档案里残留的
   * `panel:providers` 由 stage persist v11 与 `ContentKind.exists` 两头清。
   */
  // 工作区总览 = 切换器那块瓦的内容。它挂在这张表里而不是自成一个浮层,
  // 正是「切换器 = 一块普通 Dock 瓦,零新原语」这条裁定的字面落地。
  [WORKSPACE_ITEM_ID]: WorkspaceOverview,
  // 「所有应用」也在这张表里,理由与上面那条逐字相同:它是一块普通的瓦,
  // 不是 Dock 自己长出来的一个管理浮层。所以它能被钉、能上舞台、能盖满内容栏。
  [APPS_ITEM_ID]: AppsPanel,
  /*
   * **查看器不在这张表里了**(W1)。它从「一块瓦」降格为 `file` 这一种内容
   * (`content/kinds/file.tsx`):一个文件一个实例、一个 tab,住在拼贴树的叶里。
   * 于是 Dock 上那块 Viewer 瓦、这张表里那一行、`ViewerPanel` 那件壳,三样一起退役。
   */
}

/**
 * **瓦自带的头**(待办 B 形,正本 `docs/todo-app-b-2026-09.md` §3)。与上面那张表并排、一行一瓦:
 * 这块瓦独占一片叶时,叶的标签条不画标签、改画这里交出来的头;查不到 = 不自带头。
 * `panel` 这一种的 `stripHeader` 读的就是这张表(`content/kinds/panel.tsx`)。
 */
export const PANEL_HEADERS: Readonly<Record<string, ComponentType<StripHeaderProps>>> = {
  todo: TodoStripHeader,
}

/**
 * 内容的**唯一出口**,所以错误边界包在这一层而不是每块面板自己包 ——
 * 一块面板炸了只塌它自己(舞台上的、钉栏里的、浮窗里的都一样),
 * 外壳和别的面板照常活着。
 *
 * 边界的 `where` 就是这块内容的 id:错误卡上显示的、崩溃日志里记的,
 * 与查表用的是同一个字符串,不另起一套人话名字。
 *
 * `visibility` 是**宿主对这一份实例的声明**(见 ./visibility.ts):同一块内容可能
 * 同时挂着好几份(架子 keep-alive 的后台 tab、Dock 预览泡),谁算数由摆它的人说。
 * 不传 = 又看得见又算数 —— 舞台 / 浮窗那种「只有一份」的宿主不必操心。
 */
export function renderContent(
  id: string | null,
  visibility: PanelVisibility = DEFAULT_PANEL_VISIBILITY,
): ReactNode {
  if (!id) return null
  if (!RENDERERS[id]) return null
  return <PanelInstance id={id} visible={visibility.visible} interactive={visibility.interactive} headerInStrip={visibility.headerInStrip === true} />
}

/**
 * 一份内容实例 = 「稳定的内容树」×「宿主随时在改的可见性声明」,两者在这里分家。
 *
 * 分家不是风格,是这套 keep-alive 的性能前提(08-30 真机 CDP 画像钉的):宿主
 * (架子层 / 浮窗 / 舞台)每重渲染一次都会重新调 renderContent。若在那里现造
 * Provider/边界/面板的元素,元素引用每次都是新的,React 就把面板子树整棵重渲 ——
 * 会话总览那 439 张卡重造一遍 JSX,dev 下 ~300ms,正是「切 tab 卡」的主项。
 * 这里把内容树 useMemo 在 [id] 上:宿主再怎么重渲染、可见性再怎么翻,
 * 子树元素引用不变,React 直接短路;翻转只到达真正消费 usePanelVisibility 的叶子。
 *
 * 可见性以两个布尔量进 props(不收对象):宿主侧无需为引用稳定操心,
 * 对象在这里按值重组。
 */
function PanelInstance({ id, visible, interactive, headerInStrip }: { id: string; visible: boolean; interactive: boolean; headerInStrip: boolean }) {
  const visibility = useMemo<PanelVisibility>(() => ({ visible, interactive, headerInStrip }), [visible, interactive, headerInStrip])
  // 可见性挂在**边界外面**:错误卡也是这一份实例的一部分,后台那一份的错误卡
  // 同样不该抢键盘。边界在里面,所以「重试」重挂的仍然只有面板自己。
  /*
   * memo 的 key 是这块内容的 **refId**(W1):瓦这一种的 refId 就是 `panel:<瓦 id>`
   * (`workbench/kinds.ts` 的 `refId`)。值上与从前那个裸 id 一一对应,所以这一格
   * 的行为一个字没变;换成 refId 是为了让「memo 按 refId」这句话在**两只**渲染
   * 出口上是同一句(另一只是 `workbench/render.tsx`),而不是两套各说各的。
   */
  const tree = useMemo(() => {
    const R = RENDERERS[id]
    return (
      <ErrorBoundary where={id}>
        <R />
      </ErrorBoundary>
    )
  }, [id])
  return <PanelVisibilityContext.Provider value={visibility}>{tree}</PanelVisibilityContext.Provider>
}
