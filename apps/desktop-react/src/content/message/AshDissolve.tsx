import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ashMs, currentMotionTier } from '../../components/motion'
import { systemPrefersReducedMotion } from '../../reading/apply'
import { AshField } from './ash-field'
import s from './AshDissolve.module.css'

/**
 * 让一块已经在屏上的气泡灰飞烟灭。
 *
 * 它不另画一条消息。调用方把自己的气泡放进 children,到点了把 `active` 拨上,
 * 播完回调 `onDone`(现成的 dismiss 就挂在那里)。
 *
 * ── 三张状态表 ────────────────────────────────────────────────────────────
 * ① 生命周期:挂上就什么都不做。`active` 变成真的那一拍量字面、撒灰、起计时;
 *    到时 `onDone` 一次。卸下时清掉计时与动画帧,不在清理里再调 `onDone`
 *    (StrictMode 会先卸再挂,清理里删掉会把消息当场摘走)。
 *    只有一种宿主:一条消息气泡。不进浮窗。
 * ② UI 生命状态:`off`(原样) / `particles`(灰场 + 淡出) / `fade`(只淡出)。
 *    后两态由动效档与 `prefers-reduced-motion` 决定,不由调用方传。
 *    没有 empty / loading / error。超量:灰粒有上限,不跟字数线性炸开。
 * ③ UI 交互状态:播的时候 `pointer-events: none`,重试和「不发了」都不再接。
 *    画布 `aria-hidden`,不进 Tab 序。
 */
export function AshDissolve({
  active,
  onDone,
  className,
  children,
  ...rest
}: {
  active: boolean
  onDone: () => void
  className?: string
  children: ReactNode
} & Omit<ComponentProps<'div'>, 'className' | 'children'>) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const mode = !active
    ? 'off'
    : AshField.skipsParticles(currentMotionTier(), systemPrefersReducedMotion())
      ? 'fade'
      : 'particles'

  useEffect(() => {
    if (mode === 'off') return
    const ms = ashMs()
    const timer = window.setTimeout(() => onDoneRef.current(), ms)
    let frame = 0
    if (mode === 'particles') {
      const host = hostRef.current
      const canvas = canvasRef.current
      let context: CanvasRenderingContext2D | null = null
      try {
        context = canvas?.getContext('2d') ?? null
      } catch {
        // 有的宿主 getContext 直接抛。没有画布就只淡出,计时已经排上了。
        context = null
      }
      if (host && canvas && context) {
        const motes = AshField.motes(AshField.localBoxes(host))
        const rise = AshField.risePx(host)
        const tones = AshField.readTones(host)
        const started = performance.now()
        const draw = (now: number) => {
          const t = ms <= 0 ? 1 : Math.min(1, (now - started) / ms)
          AshField.paint(context, canvas, host, motes, t, rise, tones)
          if (t < 1) frame = requestAnimationFrame(draw)
        }
        frame = requestAnimationFrame(draw)
      }
    }
    return () => {
      window.clearTimeout(timer)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [mode])

  return (
    <div
      {...rest}
      ref={hostRef}
      className={[className, mode !== 'off' && s.ink].filter(Boolean).join(' ')}
      data-ash={mode === 'off' ? undefined : mode}
    >
      {children}
      {mode === 'particles'
        ? createPortal(
            <canvas
              ref={canvasRef}
              className={s.field}
              data-testid="ash-particles"
              aria-hidden="true"
            />,
            document.body,
          )
        : null}
    </div>
  )
}
