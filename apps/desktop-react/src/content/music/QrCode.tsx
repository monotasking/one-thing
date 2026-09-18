import { useMemo } from 'react'
import { qrMatrix } from './qr'
import s from '../MusicPanel.module.css'

/**
 * **一张能扫的码**(2026-09-18,接入向导第 ③ 步;矩阵怎么算在 `./qr.ts`)。
 *
 * ── 深色主题下**不反色** ─────────────────────────────────────────────────
 * 二维码不是一张可以跟着主题走的图:取景框认的是「深块 + 浅底」这个方向,反过来
 * 的码有相当一部分读码器直接不认。所以它的两格颜色(`--qr-ink` / `--qr-paper`)
 * 在 tokens.css 里**只声明一次**,深色块里不重定义 —— 这不是漏了那一格,是这一格
 * 不该跟着主题变。深色界面上它会是一块亮着的白方片,那正是手机扫码时想要的样子。
 *
 * ── 无障碍:它是图,但地址不能只剩图 ─────────────────────────────────────
 * `role="img"` + 一句 `aria-label`,读屏软件念得出这儿有一张码;而**地址自己仍然
 * 以文字形态留在旁边**(可读、可选、可复制)—— 一个读屏用户扫不了码,他要的是
 * 那条地址本身。这两件事在向导那一步是并列的,不是二选一。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:无订阅、无计时器、无模块级副作用 → 不需要 HMR dispose。矩阵按
 *    `value` 记忆:同一条地址重渲不重编(一次编码几毫秒,白跑没道理)。
 * ② UI 生命状态:这件不取数。`value` 是空串时**什么都不画** —— 一张编码了空串的
 *    码扫出来是空,比不画更坏。别的状态(还没拿到地址 / 失败)由调用方画,它们
 *    不是「这张码的状态」。
 * ③ UI 交互状态:没有 —— 它不是控件,不可聚焦、不响应指针。
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const matrix = useMemo(() => (value ? qrMatrix(value) : null), [value])
  if (!matrix) return null
  return (
    <svg
      className={s.qr}
      role="img"
      aria-label={label}
      data-testid="music-login-qr"
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      /* `shape-rendering` 让相邻的方块之间不抗锯齿 —— 缝里那一线半透明会在缩放到
       * 非整数倍时糊掉模块边界,而模块边界正是读码器要找的东西。 */
      shapeRendering="crispEdges"
    >
      <rect width={matrix.size} height={matrix.size} fill="var(--qr-paper)" />
      <path d={matrix.path} fill="var(--qr-ink)" />
    </svg>
  )
}
