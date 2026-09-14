import { useViewerSource } from '../../data/viewer-source'
import { NEW_FLOAT_REGION, regionOfFileOpenMode, useFileOpenMode } from '../../data/file-open-mode'
import { useWorkbenchStore, regionOfRefIn } from '../../workbench/store'
import { floatRegion } from '../../workbench/regions'
import { refId } from '../../workbench/kinds'
import { leavesOf } from '../../workbench/tree'
import { useStageStore } from '../../stage/store'
import { nextFloatId } from '../../stage/placement'
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
 * 当下这一档要把新标签开在哪个区域。**七档全通**(W4;W1-a 那次「五档回落
 * 中央区」的临时退化到此结清 —— 架子与浮窗的身子都是树了)。
 *
 * 「浮窗」那一档多一步:那张表交回的是哨位 `float:new`,这里把它翻成一扇
 * **真窗**。翻法有两档,判据是「这份内容此刻有没有一扇自己的窗」:
 *  · 有 —— 交回那一扇(同一档连点两次不该开出两扇装着同一个文件的窗);
 *  · 没有 —— 铸一个新窗号,并给它一份默认矩形(不给的话 `FloatWindow` 那句
 *    `if (!rect) return null` 会让这扇窗一帧都不画,而树已经建好了 —— 屏幕上
 *    的表现是「点了没反应」)。
 */
function regionForMode(mode: FileOpenMode, ref: ContentRef): RegionId | 'panel' {
  const region = regionOfFileOpenMode(mode)
  if (region !== NEW_FLOAT_REGION) return region
  const already = regionOfRefIn(useWorkbenchStore.getState().regions, refId(ref))
  if (already?.startsWith('float:')) return already
  const winId = nextFloatId()
  // 身量归形态机补(默认档 + 视口钳制两件事的产地都在那儿);不补的话
  // `FloatWindow` 那句 `if (!rect) return null` 会让这扇窗一帧都不画。
  useStageStore.getState().ensureFloatRect(winId)
  return floatRegion(winId)
}

/**
 * **按当下这一档,把任意一格内容开出去**(批⑤;从 `openFileInCurrentTarget` 里
 * 抽出来的那两行)。
 *
 * ── 为什么是一只泛化的口,而不是改动面自己抄一份 ──────────────────────────
 * 用户 09-14 的裁定原话是「查看文件的 diff 走默认的文件的 tab 行为」——**同一档
 * 偏好、同一条落点翻译**。抄一份的下场是七档里哪一档哪天改了判据(浮窗那一档
 * 「同一份内容已经有一扇窗就交回那一扇」正是这种判据),两条路只会修好一条。
 * 所以这只函数只认 `ContentRef`,**一个种类名都不出现**:`file` 与 `change` 两处
 * 消费它,第三种内容要走同一档时不必再动这只文件。
 *
 * 回 `'panel'` = 这一档**不进树**(「面板内」),落点归调用方自己那条分栏 ——
 * 文件那一路是 `workbench.openInPanel`(拼贴台那一格瞬态字段),改动面那一路是
 * 它自己的本地瞬态(那条分栏画的是哪个文件不落盘)。这一层不替它们选,因为
 * 「面板内」这四个字在两块面里指的本来就是两条不同的分栏。
 */
export function openRefByFileMode(ref: ContentRef): RegionId | 'panel' {
  const region = regionForMode(useFileOpenMode.getState().mode, ref)
  if (region !== 'panel') {
    useWorkbenchStore.getState().openRef(ref, { region })
    /*
     * **落完让那个区域露脸**(2026-09-14 报障「点击文件打不开了,选择的是 Pinned
     * right」)。真机读数:右架子收着且把手藏着(宽 0px),树里已经躺着 8 个文件
     * tab —— 每一次单击都开进去了,只是没人展开架子,屏幕上就是「点了没反应」。
     * 瓦钉到边与拖拽落定两条路早就各写了一遍「顺手展开」,这条路漏了;现在三条路
     * 同一句 `revealRegion`(判词在 `stage/placement.revealRegionIn`)。
     */
    useStageStore.getState().revealRegion(region)
  }
  return region
}

/**
 * 打开一份文件 —— 读它,并按当下这一档摆好。
 *
 * ── 单击与 ↵ 是**同一条路**(W6-a,设计 `workbench-tabs-2026-09.md` §3)────
 * W1 这里收一格 `preview`:树行单击开的是**预览 tab**(下一次单击就地顶替它),
 * ↵ 才固定。用户 09-05 在真机上明确要的是多个标签,预览整档退役 —— 于是这一口
 * 不再有第二种打开法,`viaKeyboard` 那一格在调用方那里也只剩它本来的用处
 * (**焦点送不送进查看器**)。
 *
 * 落点**先摆**再等内容:读是异步的,先插好那一格,屏幕上当场就有一个
 * 「正在读取…」的查看器,而不是等一秒钟之后凭空跳出一块面(四律之一)。
 */
export function openFileInCurrentTarget(path: string): void {
  if (!path) return
  // 落点那两行归上面那只泛化口(批⑤:改动面走的是同一档)。这里只剩「文件」
  // 自己那两件:面板内那一档的落点,与那一发读。
  if (openRefByFileMode(fileRef(path)) === 'panel') {
    useWorkbenchStore.getState().openInPanel(path)
  } else {
    // 两档互斥:开进树里就把分栏收起来(一份内容只该有一个落点)。
    useWorkbenchStore.getState().closePanel()
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
  const workbench = useWorkbenchStore.getState()
  const moving = focusedFilePath(workbench) ?? workbench.panelPath
  if (!moving) return
  const region = regionForMode(mode, fileRef(moving))
  if (region === 'panel') {
    // 树里那一格摘掉(实例留着 —— 它马上要在分栏里继续用),再交给分栏。
    closeFileEverywhere(moving, { keepInstance: true })
    workbench.openInPanel(moving)
    return
  }
  workbench.closePanel()
  /*
   * **搬**,不是再开一份(W4)。`openRef` 只往目标区域里插一格 —— 文件不是单例
   * (同一份文件可以在两片叶里各开一个,那正是 W3「拖一份到旁边对照着看」要的),
   * 所以它插完之后原来那一格还在:屏幕上就是「换了档,旧的那一份没走」。
   * 而这一口说的是**换落点**,所以走 `moveRef`(从每棵树里摘干净再插进去,
   * 实例一路留着)。
   */
  workbench.moveRef(fileRef(moving), region)
  // 搬完同样要露脸:换到「右侧钉」而右架子正收着,搬过去等于搬没了。
  useStageStore.getState().revealRegion(region)
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
