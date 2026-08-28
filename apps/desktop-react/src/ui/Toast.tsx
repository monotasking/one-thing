import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { create } from 'zustand'
import { CircleAlert, CircleCheck, Info } from '../components/icons'
import { TOAST_LIFE_MS } from '../components/motion'
import s from './Toast.module.css'

/**
 * 规范画布「层级 · 浮层三件套」板的 Toast:r-2 · sh-2 · **状态色只上左侧图标,不换底**
 * (状态色不上底是全系统总律,在 Feedback 板的行内错误条那里也成立)。
 * 板上写的是底部居中停 2.6s;本批按拍板改**右上角堆叠、4s** —— 位置和时长换了,
 * 配方一格没换。入场位移沿用板上的 8px:这是全系统唯一允许位移的入场,
 * 「无位移原则」约束的是 hover / active / 选中的**反馈**,不是浮层进出。
 *
 * hub 用 zustand,与 stage / expose 两个 store 同一种写法:状态在 store 里,
 * 计时在每条自己身上(hover 暂停走的是「记剩余时间」,不是重新计时)。
 * <ToastHost /> 挂一次即可,portal 到 body(与 Menu / Dialog 同一条判例)。
 *
 * 文案由调用方经 i18n 给。关闭按钮的 aria-label 也由调用方给 —— 组件里不落字面。
 */
export type ToastVariant = 'info' | 'success' | 'danger'

export interface ToastSpec {
  id: number
  message: ReactNode
  variant: ToastVariant
}

interface ToastHub {
  toasts: ToastSpec[]
  push: (message: ReactNode, variant?: ToastVariant) => number
  dismiss: (id: number) => void
}

let seq = 0

export const useToastHub = create<ToastHub>()((set) => ({
  toasts: [],
  push: (message, variant = 'info') => {
    const id = ++seq
    set((st) => ({ toasts: [...st.toasts, { id, message, variant }] }))
    return id
  },
  dismiss: (id) => set((st) => ({ toasts: st.toasts.filter((x) => x.id !== id) })),
}))

/** 入队一条 toast。返回的函数引用稳定,可以直接进依赖数组。 */
export function useToast(): (message: ReactNode, variant?: ToastVariant) => number {
  return useToastHub((st) => st.push)
}

const ICONS = { info: Info, success: CircleCheck, danger: CircleAlert } as const

function ToastRow({ spec }: { spec: ToastSpec }) {
  const dismiss = useToastHub((st) => st.dismiss)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const left = useRef(TOAST_LIFE_MS)
  const startedAt = useRef(Date.now())

  const start = useCallback(() => {
    startedAt.current = Date.now()
    timer.current = setTimeout(() => dismiss(spec.id), left.current)
  }, [dismiss, spec.id])

  // 真暂停,不是重来:把已经烧掉的那一段从剩余里扣掉,离开时接着烧。
  const pause = useCallback(() => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    left.current = Math.max(0, left.current - (Date.now() - startedAt.current))
  }, [])

  useEffect(() => {
    start()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [start])

  const Icon = ICONS[spec.variant]
  return (
    <div
      className={`${s.toast} ${s[spec.variant]}`}
      role="status"
      onMouseEnter={pause}
      onMouseLeave={start}
    >
      <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />
      <span className={s.message}>{spec.message}</span>
    </div>
  )
}

/** 挂一次(壳的根上),useToast 才有地方渲染。 */
export function ToastHost() {
  const toasts = useToastHub((st) => st.toasts)
  if (toasts.length === 0) return null
  return createPortal(
    <div className={s.stack}>
      {toasts.map((x) => (
        <ToastRow key={x.id} spec={x} />
      ))}
    </div>,
    document.body,
  )
}
