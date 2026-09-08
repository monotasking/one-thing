/**
 * **拖拽三件**(W3):会话(`DragSession`)、浮影(`DragGhost` + `DragLayer`)、
 * 落区高亮(`DropOverlay`)。
 *
 * 消费方只该从这一口进来 —— 与 `ui/` 别的件同一条:件的内部怎么分文件是它自己
 * 的事。这只 barrel 里**没有一个业务名字**(grep `workbench` / `leaf` / `region`
 * 在整个 `ui/drag/` 目录里零命中),那是「它不认识拼贴台」这句话的自证。
 */
export { DRAG_START_PX, DRAG_START_X, ONTO_FROM_PX } from './constants'
export { DragGhost } from './DragGhost'
export { DragLayer } from './DragLayer'
export { DropOverlay } from './DropOverlay'
export {
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
