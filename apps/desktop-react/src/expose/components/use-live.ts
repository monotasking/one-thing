import { SESSIONS_ITEM_ID } from '../../stage/items'
import { useStageStore } from '../../stage/store'
import { formOf } from '../../stage/transitions'
import { usePanelVisibility } from '../../content/visibility'

/**
 * 「这一份总览实例现在算不算数」= placed × interactive,两件事实各有产地:
 *
 *  · placed —— 「这块面被摆出来了吗」,stage store 里的全局事实。归位的时机是它
 *    翻真的那一刻,而不是组件挂载那一刻(出场动画会让内容在收回后多活一帧;
 *    舞台 ⇄ 浮窗 ⇄ 架子搬家不算重开)。架子上被切到后台那一层里它照样为真 ——
 *    所以它一个人不够。
 *  · interactive —— 「宿主认不认我这一份」,PanelVisibilityContext 里宿主的声明。
 *    架子后台 keep-alive 层是 false:照样渲染,但不许占用全局输入。
 *    (09-02 之前 Dock 悬停预览泡是第三个 false 的宿主;泡退役,判据不变。)
 *
 * 这个 hook 是**叶子专用**的:谁调它,谁就会在可见性翻转时重渲染。所以只有
 * 渲染 null 的绑定组件(ExposeBindings / AutoFocusSearch)可以调 —— 画卡网格的
 * 组件调了它,切 tab 就会重造整棵卡树,那正是 08-30 修掉的卡顿。
 */
export function useExposeLive(): boolean {
  const placed = useStageStore((st) => formOf(st, SESSIONS_ITEM_ID) !== 'dock')
  const { interactive } = usePanelVisibility()
  return placed && interactive
}
