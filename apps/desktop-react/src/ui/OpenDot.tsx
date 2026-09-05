import { ButtonBase } from './ButtonBase'
import s from './OpenDot.module.css'

/**
 * **「这一份此刻开着没有」的三态标记**(设计 §2.3;W1 立在文件树行上,
 * W5-b 入库并被会话行消费)。
 *
 * ── 为什么入库(09-01「基础件先行」)────────────────────────────────────
 * W1 时它只有一个消费者(文件树行),就地写在 `FilesPanel.module.css` 里;
 * W5-b 会话行要画**同一句话**的同一颗点(裁定 7:「一套判据两处消费」)。
 * 两处各画一遍的下场是它们迟早分叉,而分叉的第一处必然是空心那一档的
 * 命中区与焦点环 —— 那正是 `ui:consume` 的 `shared-vocab-css` 盯的东西。
 * 所以先立件入库再消费:样式从原件**逐字搬**,一个像素没改。
 *
 * ── 三态(判据不在这儿)──────────────────────────────────────────────────
 *   `'shown'`   实心 —— 打开着并显示。**纯装饰**,一枚 `<span>`:
 *               「显示中的东西再点一下」没有语义,而一颗按下去什么都不发生的钮
 *               正是「按了没反应」那一族;
 *   `'hidden'`  空心 —— 打开着但隐藏。**可点**(把它请回它藏起来时那个位置),
 *               所以它是一颗 `ui/ButtonBase`(③ 类结构性交互件:视觉本该定制,
 *               只清 UA、焦点环仍走全局);
 *   `null`      不画。
 *
 * 判据整件是纯函数 `workbench/store.openStateOf` —— 两个消费面读的是同一句话,
 * 这只件只负责画。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:随行挂载 / 卸载;没有异步、没有模块级副作用;
 *  ② UI 生命状态:上面那三格就是全部(没有 loading / error —— 它画的是一句
 *     已经算好的事实);
 *  ③ UI 交互状态:实心档无交互;空心档 rest / hover(`cursor: pointer`)/
 *     focus(全局 `:focus-visible` 环)/ active(`ButtonBase` 的配方)。
 *     disabled 不存在:不该点的那一档根本不是钮。
 */
export function OpenDot({
  state,
  label,
  testId,
  onRestore,
}: {
  state: 'shown' | 'hidden' | null
  /** 空心那一档的 accname(「已打开·隐藏,点一下请回来」)。实心档不需要。 */
  label: string
  testId?: string
  /** 点空心那一颗。缺席 = 空心档也只是装饰(不该发生,但不许崩)。 */
  onRestore?: () => void
}) {
  if (state === null) return null
  if (state === 'shown') {
    return <span className={s.dot} data-testid={testId} data-open-state="shown" aria-hidden="true" />
  }
  return (
    <ButtonBase
      className={`${s.dot} ${s.hidden}`}
      data-testid={testId}
      data-open-state="hidden"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onRestore?.()
      }}
    />
  )
}
