import { MenuItem, MenuSection } from '../ui/Menu'
import { t } from '../i18n'
import { baseNameOf } from '../data/files-source'
import { notify } from '../services/notify'
import { findItem } from '../stage/items'
import { registerStageLauncher } from '../stage/launchers'
import { nextFloatId } from '../stage/placement'
import { useStageStore } from '../stage/store'
import { CENTER_REGION, edgeRegion, floatRegion } from '../workbench/regions'
import { refId } from '../workbench/kinds'
import { regionOfRefIn, useWorkbenchStore } from '../workbench/store'
import { sessionDirOf } from './dir-open'
import { DIFF_KIND, diffRef } from './kinds/diff-ref'
import type { PlacementMemory } from '../stage/types'
import type { ContentRef } from '../workbench/kinds'
import type { RegionId } from '../workbench/regions'

/**
 * **Dock 上那块「改动」瓦降格成启动瓦**(正本
 * `apps/desktop-react/docs/changes-panel-2026-09.md` §3.2;照 `files-launcher` /
 * `terminal-launcher` 的形)。
 *
 * 从前它是「一块面」(`panel:diff` → 一份写死五行代码的 `DiffMock`)。改动不是
 * 一块面,它是**一族**:一个工作目录一份 `diff:<workdir>`。所以那块瓦要做的事
 * 变成了「开哪一份」:
 *  · 点它    = 开**当前会话的工作目录**那一份;
 *  · 右键    = 最近打开过的那几个目录各一行(**复用同一本账**,不另起一本);
 *  · 拖它    = 拖出 `diff:<那个目录>`。
 *
 * 它不是 Dock 里的一句 `if` —— 判词整段在 `stage/launchers.ts` 的文件头上
 * (「瓦自述,Dock 读表」)。
 *
 * ── 会话没绑工作目录时**不开**,而这不是省事 ────────────────────────────
 * 目录那块瓦在这一档退到 `~`;这一块**不退**。理由与 `diff.companion.seed` 那句
 * 判词同源:主目录多半不是一个 git 仓库,给人开一格「这里不是 git 仓库」是一次
 * 没人要过的打开。退路只有一条 —— 屏幕上已经开着**别的**改动面就激活它
 * (`residentKind`);连那也没有才弹一条 info(「先给这条会话绑一个工作目录」)。
 *
 * ── 落点:记忆 > 天生,天生 = **中央区** ────────────────────────────────
 * 瓦表那一行**不加 `defaultPlacement`**:一块改动面要的宽度与一段对话一样(左边
 * 一列路径、右边一块不折行的 diff),塞进架子只看得见三行 —— 与浏览器瓦同一句
 * 判词。而「中央」在 `OpenPlacement` 里**没有这一档**(它是启动瓦问完记忆与天生
 * 之后的兜底,`regionForLauncher` 的最后一句),所以它是**缺席**而不是一行声明。
 * **存量记忆压过它**(用户自己摆过的算数)。
 */

/** 「改动」那块启动瓦的 id(它就是从前那块「改动」面板瓦 —— id 不改)。 */
export const DIFF_ITEM_ID = 'diff'

/**
 * 这块瓦此刻该把内容开到哪个区域。**记忆 > 天生**(见文件头)。
 *
 * 这一段与 `files-launcher` / `terminal-launcher` / `browser-launcher` 各自那一份
 * **逐字相同**,只有读的那一格瓦 id 不同。**照抄是有意的**:把它抽成一只公共函数
 * 是另一单的事(四处一起改、一起测),而在这一单里顺手抽公共函数会让「这块瓦的
 * 落点」这句话多一个此刻没人审过的产地。
 */
function regionForLauncher(ref: ContentRef): RegionId {
  const stage = useStageStore.getState()
  const memory: PlacementMemory | undefined = stage.memory[DIFF_ITEM_ID]
  const wanted = memory ?? findItem(DIFF_ITEM_ID)?.defaultPlacement
  if (wanted?.kind === 'edge') return edgeRegion(wanted.side)
  if (wanted?.kind === 'float') {
    // 同一格内容已经有一扇自己的窗就交回那一扇(与 files-launcher 同一句)。
    const already = regionOfRefIn(useWorkbenchStore.getState().regions, refId(ref))
    if (already?.startsWith('float:')) return already
    const winId = nextFloatId()
    useStageStore.getState().ensureFloatRect(winId)
    return floatRegion(winId)
  }
  return CENTER_REGION
}

/**
 * **开一份改动面并摆出来**(点瓦与右键最近目录两处共用的唯一一只)。
 *
 * 与 `openDirectoryPanel` 的差别只有一处:**不记一笔最近目录**。那本账是「我最近
 * 打开过哪几个目录」,而这一下打开的是关于那个目录的一块面 —— 往那本账里记一笔,
 * 下一次目录瓦的右键菜单里就会多出一行没人从目录瓦打开过的目录。
 */
export function openChangesPanel(workdir: string): void {
  if (!workdir) return
  const ref = diffRef(workdir)
  useStageStore.getState().placeRef(ref, regionForLauncher(ref))
}

/** 点那块瓦:开当前会话那个工作目录的改动面。答不出目录时交给退路(见文件头)。 */
export function openSessionChanges(): void {
  const cwd = sessionDirOf()
  if (cwd) {
    openChangesPanel(cwd)
    return
  }
  /*
   * 走到这里说明 `residentKind` 那条退路也没接住(屏幕上一份改动面都没开着 ——
   * 判词在 `stage/open-item.residentRefOf`:它排在 `launcher.open()` **之前**)。
   * 弹一条 info 而不是什么都不做:点了一块瓦却毫无反应是最难自证的一种坏。
   */
  notify({
    level: 'info',
    title: t('diff.noWorkdir'),
    source: 'diff-launcher',
    dedupeMs: 3000,
  })
}

/** 最近目录那几行。**复用目录那一本账**(`recentRoots`),不另起一本。 */
function DiffLauncherMenuRows({ onDone }: { onDone: () => void }) {
  const recent = useWorkbenchStore((st) => st.recentRoots)
  if (recent.length === 0) return null
  return (
    <>
      <MenuSection>{t('files.recentDirs')}</MenuSection>
      {recent.map((path) => (
        <MenuItem
          key={path}
          onClick={() => {
            openChangesPanel(path)
            onDone()
          }}
        >
          {/* 屏幕上写目录名 —— 菜单行没有 Tooltip 的位置(同 files-launcher)。 */}
          {baseNameOf(path) || path}
        </MenuItem>
      ))}
    </>
  )
}

/*
 * **没有「打开目录…」那一行**:挑一个目录来看是**目录瓦**的事,点开之后从那块面
 * 的檐上跳过来。本单不做那条跳转(正本 §7 拍点 5,留账)—— 在这里塞一个第二个
 * 目录选择器,等于把「挑目录」这件事变成两个产地。
 */
registerStageLauncher(
  DIFF_ITEM_ID,
  {
    open: openSessionChanges,
    /*
     * 拖它拖出去的是**当前会话那个目录**的改动面。会话没绑目录时答 `null` =
     * 此刻拖不出来 —— 拒绝比拖出一格画不出东西的假 tab 诚实(`files-launcher`
     * 那条判例逐字适用),而点一下那条路照旧会走退路。
     */
    dragRef: () => {
      const cwd = sessionDirOf()
      return cwd ? diffRef(cwd) : null
    },
    /*
     * **答不出 `dragRef` 时的退一步**(W7-c 裁定 6)。会话没绑目录时屏幕上可能
     * 正开着**别的**改动面 —— 点这块瓦要的是「让我看见改动」。交出去的是一个
     * **种类名**,查找归 `workbench/tree.firstRefOfKindIn`。
     */
    residentKind: DIFF_KIND,
    MenuRows: DiffLauncherMenuRows,
  },
  import.meta.hot,
)
