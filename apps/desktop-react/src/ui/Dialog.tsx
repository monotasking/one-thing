import { useCallback, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { create } from 'zustand'
import { useT } from '../i18n'
import { useFocusTrap } from './a11y/focus-trap'
import { useFloatDismiss } from './float'
import { Button } from './Button'
import s from './Dialog.module.css'

/**
 * 规范画布「层级 · 浮层三件套」板的对话框:r-3 · sh-3 · 遮罩 = 墨 40% 无模糊 ·
 * 入场 scale .98→1 / 140ms · 宽 400(板上三档里的最小档,本批只落这一档)。
 * 板上还有一条硬规矩:**必有逃生口** —— 取消 + Esc 可关,禁止只有「确定」的死胡同。
 *
 * 三处配方逐字对齐既有的 StageOverlay(它是这条规矩在业务层的先例):
 * 遮罩点击判 mousedown 且 target === currentTarget(按下和松开都在遮罩上才算点遮罩,
 * 从面板里拖出去松手不该关窗)、入场用同一组关键帧、层级 --z-overlay / --z-modal。
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   Tab / Shift+Tab   在面板内循环,**出不去**(ui/a11y/focus-trap)
 *   Esc               关闭 → 焦点还给开它的那个元素
 *   Enter / Space     落在哪个按钮上就触发哪个(原生 <button>,不自造)
 * 打开时焦点落在面板本身(tabIndex=-1)—— APG 对话框模式允许的落点,
 * 也是这件组件从前的行为,本批不改;换的只是「出不去、回得来」这两条。
 * 语义:role="dialog" + aria-modal + aria-labelledby 指向可见标题
 * (没有可见标题时退回 aria-label,由调用方经 i18n 给)。
 *
 * ── 宽档为什么**仍然只有一档**(09-02 批 8a 记档)────────────────────────
 * 规范画布上有三档宽,这件只落了最小的 400。批 8a 逐处点过全仓的对话框落点:
 * **没有一处在要更宽的那一档** —— 没有人在外面手写宽度覆盖,也没有一处内容
 * 被 400 挤到换形。所以「补两档 size」这一格是凭空造需求(YAGNI),本批不做。
 * 它与同批补掉的四个口子的区别正在这里:那四个各有**产地证据**
 * (三处各画一份 Card 檐 / 钉边钮包了一格贴身 span 去量 / Field 里的 htmlFor
 * 指了个空 / 两颗檐上的丸画的是 5px 而 StatusDot 当时只认 6px),这一格没有。
 * 真出现第一个要更宽的落点时再补,那时也才知道该按板上哪一档补。
 *
 * 上面那句括号里的第四条已经**结清**(09-02 批 8c 记档,留在这里是因为它是
 * 「产地证据」这条判据的例子,不是现状):批 8a 给 `ui/StatusDot` 补上 `sm`
 * 5px 档之后,那两颗丸各自的去向是 —— 宿主檐那颗(`components/HostTitle`)
 * 批 8b 已迁;查看器自己那颗(`content/viewer/FileViewer.module.css` 的
 * `.dirtyDot` = 5px 圆 + `--warn`)**现在迁得进去了**,但那是消费面收编,
 * 归文件面那一批,不在 ui/ 的本批就地动。
 * 顺带记一条容易看串的:文件树那颗 `.openDot`(`content/FilesPanel.module.css`)
 * 迁不进去,而且不是几何的事 —— 它画的是 `--accent`,不在这件的六档语义色里,
 * 说的也不是「什么状态」而是「这个文件正开着」。
 * ──────────────────────────────────────────────────────────────────────
 */
interface DialogProps {
  open: boolean
  onClose: () => void
  /** 标题。走 i18n,组件里不落字面。 */
  title?: ReactNode
  /** 正文。 */
  children?: ReactNode
  /** 底部动作区:一排兄弟节点的按钮(禁止把按钮嵌进按钮)。 */
  footer?: ReactNode
  /** 没有可见标题时的无障碍名。 */
  label?: string
}

export function Dialog({ open, onClose, title, children, footer, label }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // 圈禁 + 还锚点。开启时把焦点移进面板这一步也归它 —— 从前那行 panel.focus()
  // 就是它的 initialFocus: 'container' 默认档,行为逐字不变。
  useFocusTrap(panel, open)

  /*
   * Esc 关(09-01 批 4:从手写迁进 `ui/float` 的 `useFloatDismiss`)。
   * 退得动就把这一下吃掉,否则同一下 Esc 会顺手把对话框底下那块面也收掉 ——
   * 契约与判例见 components/useEscapeChain(Menu / Popover 同款)。
   *
   * 从前这里自己在 window 捕获相位挂一条,与 Menu / Popover 逐字相同,
   * 而**同相位之间按注册序**:对话框先开、菜单后开,一下 Esc 先被对话框接走,
   * 两层齐关。现在由原语那只浮层栈判「谁是栈顶」,内层先退。
   *
   * `outside: false` —— 这件的「点外面」是遮罩自己的 mousedown
   * (按下与松开都要落在遮罩上才算,从面板里拖出去松手不关),
   * 不是一条 window 上的 pointerdown;开着那条会把这条规矩绕过去。
   */
  useFloatDismiss(panel, onClose, open, { outside: false })

  if (!open) return null

  return createPortal(
/* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
     * 遮罩点击关闭是**鼠标的顺手路**,不是唯一出口:Esc 已经能关(键盘监听见本文件 /
     * ExposeView 的 escape 分支),关闭按钮也在。规则看不见那条键盘路径,所以它在这里
     * 是误报。刻意不给它 role="button":遮罩不是按钮,报成按钮会让读屏软件念出一个
     * 不存在的控件。 */
    <div
      className={s.scrim}
      data-testid="dialog-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        className={s.panel}
        role="dialog"
        aria-modal="true"
        /* 有可见标题就指过去(读屏软件念的是屏幕上那句,不是另一份说法);
         * 没有才退回调用方给的 aria-label。两者只该有一个生效。 */
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : label}
        tabIndex={-1}
      >
        {title && (
          <h2 className={s.title} id={titleId}>
            {title}
          </h2>
        )}
        {children && <div className={s.body}>{children}</div>}
        {footer && <div className={s.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/* ── useConfirm ────────────────────────────────────────────────────────────
 * 「问一句 yes/no」在代码里想写成一行 await,但对话框得有人渲染。
 * 所以拆成两半:一个进程级单槽 hub(同一时刻只有一个待答的问题),
 * 和一个挂一次的 <ConfirmHost />。hub 用 zustand,与 stage/expose 两个 store 同一种写法。
 * ────────────────────────────────────────────────────────────────────────── */
export interface ConfirmOptions {
  /** 标题与正文都由调用方经 i18n 给;组件只给「确定 / 取消」两句兜底文案。 */
  title?: ReactNode
  description?: ReactNode
  confirmLabel?: ReactNode
  cancelLabel?: ReactNode
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (v: boolean) => void
}

interface ConfirmHub {
  request: ConfirmRequest | null
  ask: (o: ConfirmOptions) => Promise<boolean>
  settle: (v: boolean) => void
}

export const useConfirmHub = create<ConfirmHub>()((set, get) => ({
  request: null,
  ask: (o) =>
    new Promise<boolean>((resolve) => {
      // 单槽:上一个问题还挂着就先按「取消」结掉它,永远不留悬空的 promise。
      get().request?.resolve(false)
      set({ request: { ...o, resolve } })
    }),
  settle: (v) => {
    const r = get().request
    if (!r) return
    set({ request: null })
    r.resolve(v)
  },
}))

/** promise 化的 confirm。返回的函数是 store 上那一个,引用稳定,可以直接进依赖数组。 */
export function useConfirm(): (o: ConfirmOptions) => Promise<boolean> {
  return useConfirmHub((st) => st.ask)
}

/** 挂一次(壳的根上),useConfirm 才有地方渲染。 */
export function ConfirmHost() {
  const t = useT()
  const request = useConfirmHub((st) => st.request)
  const settle = useConfirmHub((st) => st.settle)
  const cancel = useCallback(() => settle(false), [settle])

  return (
    <Dialog
      open={request !== null}
      onClose={cancel}
      title={request?.title}
      label={request?.title ? undefined : t('common.confirm')}
      footer={
        <>
          <Button onClick={cancel}>{request?.cancelLabel ?? t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => settle(true)}>
            {request?.confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      {request?.description}
    </Dialog>
  )
}
