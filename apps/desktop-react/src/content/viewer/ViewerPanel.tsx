import { useEffect } from 'react'
import { useStageStore } from '../../stage/store'
import { VIEWER_ITEM_ID } from '../../stage/items'
import { useLiveTitleStore } from '../../stage/live-title'
import { useFilesSource } from '../../data/files-source'
import { isDirty, useViewerSource } from '../../data/viewer-source'
import { baseNameOf } from '../../data/files-source'
import { FileViewer } from './FileViewer'
import type { Placement } from '../../stage/types'

/**
 * **查看器那块瓦的内容**(F2)—— 内容表 `content/index.tsx` 里的一行。
 *
 * 它只做一件事:把「这块瓦此刻在哪」翻成查看器的 `placement` 字符串。查看器本体
 * 一个字都不用改 —— F1 就把 `placement` 定义成「只决定外框几何」,状态全在
 * `data/viewer-source` 上。于是「换落点只换外框、状态原地留存」这条定稿约束在
 * F2 是**免费**兑现的,不是又实现了一遍。
 *
 * 面板内那一档不走这里:那时这块瓦收在 Dock 里,画查看器的是 `FilesPanel` 的分栏。
 */
export function ViewerPanel() {
  const placement = useStageStore((st) => st.placements[VIEWER_ITEM_ID])
  const reveal = useFilesSource((st) => st.reveal)

  /*
   * ── 合檐的另一半:**把文件身份交给宿主檐**(09-01 回炉)────────────────
   * 浮窗 / 舞台 / 盖三种宿主自带一条 header,所以查看器那条整条不画(判据在
   * FileViewer 的 HOST_OWNS_CHROME)。文件名与未保存丸不能跟着一起消失 ——
   * 它们改由宿主檐说,而宿主怎么知道?就是这条发布。
   *
   * 发布点在 **ViewerPanel 而不是 FileViewer**:这个组件**只**在瓦被摆进宿主时
   * 才存在(面板内那一档由 FilesPanel 直接画 FileViewer),所以「有没有宿主」
   * 这件事在这里是结构事实,不需要再判一次 placement。
   * 卸载即收回 —— 瓦收回 Dock 之后那条檐该回到「查看器」这个静态名字。
   */
  const file = useViewerSource((st) => st.file)
  const pending = useViewerSource((st) => st.pending)
  const edit = useViewerSource((st) => st.edit)
  const setLiveTitle = useLiveTitleStore((st) => st.setLiveTitle)
  const name = file?.name ?? (pending ? baseNameOf(pending) : '')
  const fullPath = file?.path ?? pending ?? ''
  const dirty = isDirty(file, edit)
  useEffect(() => {
    // 手上一个文件都没有时**不发布**:那时宿主檐该说「查看器」(这块面是什么),
    // 而不是一个空标题 —— 空态那一格由查看器体自己说实话。
    // 提示给**整条路径**:檐上那格窄,而两个目录里的同名文件在屏幕上长得一样。
    setLiveTitle(VIEWER_ITEM_ID, name ? { text: name, dirty, tip: fullPath } : null)
    return () => setLiveTitle(VIEWER_ITEM_ID, null)
  }, [name, fullPath, dirty, setLiveTitle])

  return (
    <FileViewer
      placement={frameOf(placement)}
      onReveal={(path) => void reveal(path)}
    />
  )
}

/**
 * Placement → `.frame-*` 那一族的后缀。缺席(收在 Dock 里,却还是被谁画了出来 ——
 * 比如 Dock 的预览泡)按 `stage` 画:一块占满宿主的方框,那是最不容易出错的一档。
 */
function frameOf(placement: Placement | undefined): string {
  if (!placement) return 'stage'
  return placement.kind === 'edge' ? `edge-${placement.side}` : placement.kind
}
