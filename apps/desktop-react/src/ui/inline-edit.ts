import { useCallback, useEffect, useRef } from 'react'
import type { FocusEvent, KeyboardEvent } from 'react'

/**
 * **原地编辑那一格的行为**(09-02 批 11 立件)。
 *
 * 一句话:一格输入框临时长在某一行上,`↵` 落定、`Esc` 收回、一进来就选中全文,
 * 可选**失焦即取消**。它管的全是**手势**,一个像素都不画 —— 形归 `ui/Field`
 * (`layout="inline"`)与 `ui/Input`,这件只回答「什么时候算写完、什么时候算不写了」。
 *
 * ── 为什么立件 ──────────────────────────────────────────────────────────
 * 「基础件先行」那条法的原话是:动手写任何交互行为之前先查 `src/ui/`,没有就
 * **先立件再消费**。原地编辑此刻有两个产地:
 *  · `workspace/components/WorkspaceOverview` 的改名格(09-02 批 10 收编横排层时
 *    仍把 ↵ / Esc / 选中全文留在自己文件里);
 *  · `providers/components/CredentialPool` 的密钥行(本批 —— 用户报障
 *    「key 的编辑 ui 很难看,不是原地编辑」)。
 * 两个产地写的是同一组手势,而漂开的表现是「这块面按 Esc 收得回,那块面收不回」——
 * 没有任何一道门会发现,因为每一份自己都跑得通。所以这一组手势收成一件。
 *
 * ── 失焦是**可选**的,缺省不取消 ────────────────────────────────────────
 * 一格里若还并肩站着一颗「✓」钮,失焦即取消就把那颗钮**变成永远点不到的**:
 * `blur` 在 `click` 之前到,输入框当场卸载,那一下点击落在空气里。所以
 * `cancelOnBlur` 缺省 `false`(改名格那一形保持原样),只有**没有提交钮、
 * 全靠 `↵` 落定**的那一形才打开它(密钥行正是)。这一条不是配置口味,
 * 是「这一格有没有别的落点在抢那一下点击」的事实。
 *
 * ── `preventDefault` 而不 `stopPropagation` ─────────────────────────────
 * 快捷键三层的撞键裁决原话:**局部先接,接住了才 `preventDefault()`**,
 * 全局派发器开头一句 `if (e.defaultPrevented) return`。所以这里只按下 default,
 * 不掐冒泡 —— 掐了就等于给这条链再开一套自己的裁决。
 *
 * ── 三类状态(库件规格)────────────────────────────────────────────────
 *   生命状态:`controlId` 一到手就 focus + select 一次(那一格刚长出来,
 *             光标该在里面而且全选,接着打就是覆盖)。id 由 `ui/Field` 的
 *             `useId` 给、跨渲染稳定,所以这一发**只跑一次**,重渲不会把光标
 *             重新拽回开头。回调走 ref,身份变了不重跑。无订阅、无计时器、
 *             **无模块级副作用 → 不需要 HMR dispose**。卸载不必拆:两个
 *             handler 是 React 自己挂的。
 *   交互状态:这件不是控件,rest/hover/focus/disabled 全归它装着的那件
 *             (`ui/Input`)。它自己只有两条出口:落定 / 收回。**忙态不归它** ——
 *             写在飞的时候是不是要禁掉输入框,由消费方按律③自己决定。
 *   数据状态:草稿归消费方(它才知道初值从哪来、空串算不算合法)。
 *             这件不碰值,所以没有 empty / error 之分。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 * ```tsx
 * function KeyCell() {
 *   const field = useFieldControlProps()
 *   const edit = useInlineEdit({ controlId: field.id, onCommit, onCancel, cancelOnBlur: true })
 *   return <Input {...field} {...edit} value={draft} onValueChange={setDraft} />
 * }
 * ```
 * `useFieldControlProps()` 只在 `<Field>` 的 context **之内**拿得到东西,所以
 * 这一段总是长在一个单独的小件里 —— 与 `WorkspaceOverview.RenameInput` 同一条理由。
 */
export interface InlineEditOptions {
  /**
   * 这一格控件的 id(`ui/Field` 交出来的那个)。用它取元素做「一进来就选中全文」。
   * 缺席 = 不自动聚焦(这件不替消费方去猜「壳里第一个 input」是哪一个)。
   */
  controlId?: string
  /** `↵`。 */
  onCommit: () => void
  /** `Esc`,以及(打开时)失焦。 */
  onCancel: () => void
  /** 失焦即取消。缺省 `false` —— 理由见文件头。 */
  cancelOnBlur?: boolean
}

/** 摊到那件控件上的两格。**摊在自己的 props 之后**,免得被同名的覆盖掉。 */
export interface InlineEditProps {
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  onBlur?: (event: FocusEvent<HTMLElement>) => void
}

export function useInlineEdit({
  controlId,
  onCommit,
  onCancel,
  cancelOnBlur = false,
}: InlineEditOptions): InlineEditProps {
  // 回调走 ref:消费方几乎一定是现写的箭头函数,进依赖就等于每次重渲都把
  // 光标重新拽回开头(而那正是「打到一半跳走了」那一类报障)。
  const commitRef = useRef(onCommit)
  const cancelRef = useRef(onCancel)
  commitRef.current = onCommit
  cancelRef.current = onCancel

  useEffect(() => {
    if (!controlId) return
    const el = document.getElementById(controlId)
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return
    el.focus()
    el.select()
  }, [controlId])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitRef.current()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelRef.current()
    }
  }, [])

  const onBlur = useCallback(() => {
    cancelRef.current()
  }, [])

  return cancelOnBlur ? { onKeyDown, onBlur } : { onKeyDown }
}
