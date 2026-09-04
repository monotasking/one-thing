import { useViewerSource } from '../../data/viewer-source'
import { regionOfFileOpenMode, isWiredFileOpenMode, useFileOpenMode } from '../../data/file-open-mode'
import { useWorkbenchStore } from '../../workbench/store'
import { CENTER_REGION } from '../../workbench/regions'
import { refId } from '../../workbench/kinds'
import { leavesOf } from '../../workbench/tree'
import type { FileOpenMode } from '../../data/file-open-mode'
import type { ContentRef } from '../../workbench/kinds'
import type { RegionId } from '../../workbench/regions'

/**
 * **「打开一个文件」这件事的唯一编排点**(F2;W1 换成树)。
 *
 * 它把两件本来各自独立的事按顺序接起来:
 *  ① 读那份文件(`viewer-source`,只管**内容**);
 *  ② 把这个 ref 插进当下这一档说的**区域**(`workbench/store`,只管**摆法**)。
 * 两个 store 谁都不认识对方 —— 这一层就是那条缝。三个入口(树上单击、行菜单
 * 「打开」、详情面「打开查看」)共用它,所以「点开一个文件会发生什么」全仓一份。
 *
 * ── 为什么用 `getState()` 而不是 hook ────────────────────────────────────
 * 这些是**事件处理器里的一次动作**,不是渲染要读的值。订阅它们只会让调用方
 * 白重挂一次 effect。
 *
 * ── 「面板内」为什么不进树 ────────────────────────────────────────────────
 * 设计 §2.1 明写保留:它是 `FilesPanel` 自己那条分栏,语义不变。所以它走
 * `workbench.openInPanel(path)` 那一格瞬态字段,不插进任何一棵树。
 * 两档**互斥**:选中央区就把分栏收起来,选面板内就不往树里插 —— 一份内容
 * 同时画在两处会看着像重影。
 */

/** 文件那一种内容的 ref。种类名只在这一处出现 —— 它是文件这件事的产地。 */
export const fileRef = (path: string): ContentRef => ({ kind: 'file', key: path })

/**
 * 当下这一档要把新标签开在哪个区域。
 *
 * **没接上的那五档回落中央区**(W1-a 的临时退化,见 `file-open-mode` 那段):
 * 判据在这里定一次 —— 菜单那边照 `isWiredFileOpenMode` 禁灰,而档值本身
 * 可能来自存量档案(用户在 F2 时代选过「浮窗」),那时得有一个诚实的落点。
 */
function regionForMode(mode: FileOpenMode): RegionId | 'panel' {
  if (!isWiredFileOpenMode(mode)) return CENTER_REGION
  return regionOfFileOpenMode(mode)
}

/**
 * 打开一份文件 —— 读它,并按当下这一档摆好。
 *
 * `preview` = 这一下是**浏览**(树行单击),开出来的是预览 tab(§2.1 拍点 ①);
 * 缺省是固定 tab(↵ / 菜单「打开」/ 详情面那条路)。
 *
 * 落点**先摆**再等内容:读是异步的,先插好那一格,屏幕上当场就有一个
 * 「正在读取…」的查看器,而不是等一秒钟之后凭空跳出一块面(四律之一)。
 */
export function openFileInCurrentTarget(path: string, opts: { preview?: boolean } = {}): void {
  if (!path) return
  const region = regionForMode(useFileOpenMode.getState().mode)
  const workbench = useWorkbenchStore.getState()
  if (region === 'panel') {
    workbench.openInPanel(path)
  } else {
    // 两档互斥:开进树里就把分栏收起来(一份内容只该有一个落点)。
    workbench.closePanel()
    workbench.openRef(fileRef(path), { region, preview: opts.preview === true })
  }
  void useViewerSource.getState().openFile(path)
}

/**
 * 换一档打开方式。**当场生效** —— 09-01 报障「open 位置,调整后也没有生效」的
 * 正面兑现:改了档,手上开着的那些文件立刻搬过去。
 *
 * 「手上开着的」在 W1 是**多份**,所以搬的是**焦点叶里那一格**(以及分栏里那一份)——
 * 把十个 tab 一起搬过去不是任何人要的东西。手上一个都没开时只记档不搬。
 */
export function setFileOpenMode(mode: FileOpenMode): void {
  useFileOpenMode.getState().setMode(mode)
  const region = regionForMode(mode)
  const workbench = useWorkbenchStore.getState()
  const moving = focusedFilePath(workbench) ?? workbench.panelPath
  if (!moving) return
  if (region === 'panel') {
    // 树里那一格摘掉(实例留着 —— 它马上要在分栏里继续用),再交给分栏。
    closeFileEverywhere(moving, { keepInstance: true })
    workbench.openInPanel(moving)
    return
  }
  workbench.closePanel()
  workbench.openRef(fileRef(moving), { region })
}

/** 焦点叶里那一格如果是个文件,回它的路径。 */
function focusedFilePath(state: ReturnType<typeof useWorkbenchStore.getState>): string | null {
  const leaves = Object.values(state.regions).flatMap((tree) => leavesOf(tree))
  const leaf = leaves.find((l) => l.id === state.focusLeafId) ?? leaves[0]
  const ref = leaf?.tabs[leaf.active]
  return ref?.kind === 'file' ? ref.key : null
}

/**
 * 把一份文件从**所有**落点上摘掉。
 *
 * `keepInstance` = 只摘落点、不丢实例(换打开方式时那一步:它马上要在别处继续用)。
 * 缺省丢实例 —— 那才是「关闭」的语义(设计 §2.3)。
 */
export function closeFileEverywhere(path: string, opts: { keepInstance?: boolean } = {}): void {
  const state = useWorkbenchStore.getState()
  const id = refId(fileRef(path))
  for (const [region, tree] of Object.entries(state.regions)) {
    for (const leaf of leavesOf(tree)) {
      const at = leaf.tabs.findIndex((tab) => refId(tab) === id)
      if (at < 0) continue
      if (opts.keepInstance) {
        // 摘落点但不 dispose:走隐藏那条路再把隐藏记录清掉,实例原样留着。
        useWorkbenchStore.getState().hideTab(leaf.id, at)
        useWorkbenchStore.setState((s) => ({
          hidden: s.hidden.filter((entry) => refId(entry.ref) !== id),
        }))
      } else {
        useWorkbenchStore.getState().closeTab(leaf.id, at)
      }
      void region
    }
  }
  if (state.panelPath === path) useWorkbenchStore.getState().closePanel()
  /*
   * **藏着的那一份也要一起收掉**。「关闭」问的是「这份内容还在不在」,而隐藏表
   * 正是「打开着但不显示」——不收它,树行上那颗空心点会在关掉之后继续亮着,
   * 而点它请回来的是一份已经被 dispose 的实例。`dropHidden` 自带 dispose,
   * 所以这一支走完就不必再 dispose 一次(下面那句按 `keepInstance` 判)。
   */
  const hiddenNow = useWorkbenchStore.getState().hidden.some((entry) => refId(entry.ref) === id)
  if (hiddenNow && !opts.keepInstance) {
    useWorkbenchStore.getState().dropHidden(id)
    return
  }
  if (!opts.keepInstance) useViewerSource.getState().dispose(path)
}
