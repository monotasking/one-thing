import { useStageStore } from '../../stage/store'
import { VIEWER_ITEM_ID } from '../../stage/items'
import { useViewerSource } from '../../data/viewer-source'
import { placementOfFileOpenMode, useFileOpenMode } from '../../data/file-open-mode'
import type { FileOpenMode } from '../../data/file-open-mode'

/**
 * **「打开一个文件」这件事的唯一编排点**(F2)。
 *
 * 它把两件本来各自独立的事按顺序接起来:
 *  ① 读那份文件(`viewer-source`,只管**内容**);
 *  ② 把查看器那块瓦摆到当下这一档说的地方(`stage`,只管**落点**)。
 * 两个 store 谁都不认识对方 —— 这一层就是那条缝。三个入口(树上单击、行菜单
 * 「打开」、详情面「打开查看」)共用它,所以「点开一个文件会发生什么」全仓一份。
 *
 * ── 为什么用 `getState()` 而不是 hook ────────────────────────────────────
 * 这些是**事件处理器里的一次动作**,不是渲染要读的值。订阅它们只会让调用方
 * 白重挂一次 effect(与 `keymap/dispatch.ts` 里「取动作而不是订阅」同一条口径)。
 *
 * ── 「面板内」为什么要把瓦收回 Dock ──────────────────────────────────────
 * 七档是**互斥**的:一份查看器只有一个落点。选回「面板内」时如果不把瓦收回去,
 * 屏幕上会同时有两份同一个文件的查看器(面板里一份、舞台上一份),而它们共用
 * 同一个 store —— 两份会一起动,看着像重影。收回 Dock 不丢任何状态(内容与草稿
 * 都在 store 上),它只是把那块瓦的落点抹掉。
 */

/** 把查看器摆到这一档说的地方。`panel` = 不摆出去,收回 Dock 让面板内那条分栏画它。 */
function placeViewerAt(mode: FileOpenMode): void {
  const placement = placementOfFileOpenMode(mode)
  const stage = useStageStore.getState()
  if (!placement) {
    stage.closeToDock(VIEWER_ITEM_ID)
    return
  }
  stage.openAs(VIEWER_ITEM_ID, placement)
}

/**
 * 打开一份文件 —— 读它,并按当下这一档摆好。
 *
 * 落点**先摆**再等内容:读是异步的,先摆好那块瓦,屏幕上当场就有一个「正在读取…」
 * 的查看器,而不是等一秒钟之后凭空跳出一块面(四律之一:异步动作必有进行中反馈)。
 */
export function openFileInCurrentTarget(path: string): void {
  if (!path) return
  placeViewerAt(useFileOpenMode.getState().mode)
  void useViewerSource.getState().openFile(path)
}

/**
 * 换一档打开方式。**当场生效** —— 09-01 报障「open 位置,调整后也没有生效」的
 * 正面兑现:改了档,开着的那份查看器立刻搬过去,而不是「下次打开才算数」。
 *
 * 手上没开着文件时只记档不搬 —— 那时没有东西可搬,凭空开一块空查看器是多的。
 */
export function setFileOpenMode(mode: FileOpenMode): void {
  useFileOpenMode.getState().setMode(mode)
  const { file, pending } = useViewerSource.getState()
  if (file === null && pending === null) return
  placeViewerAt(mode)
}

/**
 * 关掉查看器。内容清掉 + 那块瓦收回 Dock —— 少了第二步,舞台 / 浮窗 / 钉栏上
 * 会留一个空壳子(「关了却还在」是这一族最讨厌的一种 bug)。
 */
export function closeViewerEverywhere(): void {
  useViewerSource.getState().close()
  useStageStore.getState().closeToDock(VIEWER_ITEM_ID)
}
