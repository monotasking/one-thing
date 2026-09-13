/**
 * **拖拽三件**(W3):会话(`DragSession`)、浮影(`DragGhost` + `DragLayer`)、
 * 落区高亮(`DropOverlay`)。
 *
 * 消费方只该从这一口进来 —— 与 `ui/` 别的件同一条:件的内部怎么分文件是它自己
 * 的事。这只 barrel 里**没有一个业务名字**(grep `workbench` / `leaf` / `region`
 * 在整个 `ui/drag/` 目录里零命中),那是「它不认识拼贴台」这句话的自证。
 */
export { DRAG_START_PX, DRAG_START_X } from './constants'
export { DragGhost } from './DragGhost'
export { DragLayer } from './DragLayer'
export { DropOverlay } from './DropOverlay'
/**
 * 「按下即拖」那一族的指针跟踪(U5)。它与 `DragSession` 是同一条纪律下的两件:
 * 这一件管「指针在不在、这一下要不要作废」,那一件管「算不算一次拖、浮影画什么」
 * —— 分工与「为什么 DragSession 不吃它」的判词整段写在 `pointer-track.ts` 文件头。
 */
export { PointerTrack } from './pointer-track'
export type { PointerTrackCancelReason, PointerTrackRun } from './pointer-track'
export {
  isDragActive,
  resetDragSession,
  setDragPresentation,
  setDropFeedback,
  useDragSource,
  useDragState,
} from './DragSession'
export type {
  DragBandState,
  DragGhostSpec,
  DragPresentation,
  DragRect,
  DragSessionState,
  DragSourceSpec,
  DropFeedback,
  DropShape,
} from './DragSession'
