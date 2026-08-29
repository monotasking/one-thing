import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { create } from 'zustand'
import { useT } from '../i18n'
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
 * 焦点:打开时移进面板本身(tabIndex=-1)。这是简版,不做完整 focus trap ——
 * 做一半的 trap 比没有更坏,真需要时整件换,不在这里长一点点。
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

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

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
        aria-label={label}
        tabIndex={-1}
      >
        {title && <h2 className={s.title}>{title}</h2>}
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
