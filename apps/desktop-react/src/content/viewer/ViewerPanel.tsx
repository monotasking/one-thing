import { useStageStore } from '../../stage/store'
import { VIEWER_ITEM_ID } from '../../stage/items'
import { useFilesSource } from '../../data/files-source'
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
