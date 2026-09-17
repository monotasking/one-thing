import type { CSSProperties } from 'react'
import type { PetRigProps } from '../../types'
import s from './HeidouRig.module.css'

/**
 * **黑豆的形象**(宠物 P0,逐笔搬自样例「黑豆电台」的那只 SVG)。
 *
 * 纯展示:吃 `PetRigProps`,吐画面。**没有计时器、不接手势、不读状态** —— 姿势是
 * 舞台算好递进来的(`pose.ts`),一次性动画由舞台换值重播。形象里的所有「动」
 * 都是 CSS 按 `data-pose` / `data-mouth` / `data-one-shot` 三格属性挑的。
 *
 * 颜色全走 `--pet-*` token(tokens.css「宠物」节);SVG 上只留几何(路径、半径、
 * 描边粗细 —— 那是画本身,不是皮)。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:无状态。换宿主 / 重挂只会让循环动画从头起。
 * ② UI 生命状态:九种姿势(§7.2)× 嘴两态 × 一次性动画五种;没有 loading / error。
 * ③ UI 交互状态:无 —— 对读屏藏起来(`aria-hidden`),可达入口是舞台上那颗宠物按钮。
 */
export function HeidouRig({ pose, beat, mouth, oneShot }: PetRigProps) {
  const style = beat !== undefined ? ({ '--pet-beat': `${beat}s` } as CSSProperties) : undefined
  return (
    <div
      className={s.rig}
      data-pose={pose}
      data-mouth={mouth}
      data-one-shot={oneShot}
      style={style}
      data-testid="pet-rig"
    >
      <svg className={s.svg} viewBox="0 0 120 134" aria-hidden="true">
        <g className={s.tail}>
          <path className={s.tailPath} d="M90 122 C112 120 118 98 108 82 C102 72 108 62 116 64" strokeWidth="7" />
        </g>
        <g className={s.bodyG}>
          <path className={s.body} d="M30 128 C20 104 26 76 60 72 C94 76 100 104 90 128 Z" />
          <ellipse className={s.paw} cx="47" cy="126" rx="9" ry="5" />
          <g className={s.pawR}>
            <ellipse className={s.paw} cx="73" cy="126" rx="9" ry="5" />
          </g>
          <g className={s.purr} strokeWidth="1.4">
            <path d="M18 96 q-5 6 0 12" />
            <path d="M11 93 q-6 9 0 18" />
            <path d="M102 96 q5 6 0 12" />
            <path d="M109 93 q6 9 0 18" />
          </g>
        </g>
        <g className={s.head}>
          <g className={s.headBob}>
            <g className={s.earL}>
              <path className={s.ear} d="M31 42 L27 9 L53 28 Z" />
              <path className={s.earInner} d="M33 35 L31 17 L46 29 Z" />
            </g>
            <g className={s.earR}>
              <path className={s.ear} d="M89 42 L93 9 L67 28 Z" />
              <path className={s.earInner} d="M87 35 L89 17 L74 29 Z" />
            </g>
            <ellipse className={s.skull} cx="60" cy="50" rx="35" ry="29" />
            <g className={s.eyesOpen}>
              <VinylEye x={46} />
              <VinylEye x={74} />
            </g>
            <g className={s.eyesClosed} strokeWidth="1.8">
              <path d="M39 50 Q46 55 53 50" />
              <path d="M67 50 Q74 55 81 50" />
            </g>
            <g className={s.eyesDizzy} strokeWidth="1.4">
              <g className={s.swirl}>
                <path d="M46 49 m-6 0 a6 6 0 1 0 12 0 a4.5 4.5 0 1 0 -9 0 a3 3 0 1 0 6 0" />
              </g>
              <g className={s.swirl}>
                <path d="M74 49 m-6 0 a6 6 0 1 0 12 0 a4.5 4.5 0 1 0 -9 0 a3 3 0 1 0 6 0" />
              </g>
            </g>
            <ellipse className={s.blush} cx="35" cy="60" rx="5.5" ry="2.6" />
            <ellipse className={s.blush} cx="85" cy="60" rx="5.5" ry="2.6" />
            <path className={s.nose} d="M57 59.5 L63 59.5 L60 62.5 Z" />
            <path className={s.mouth} d="M54 64.5 Q57 67.5 60 64.5 Q63 67.5 66 64.5" strokeWidth="1.4" />
            <g className={s.mouthOpen}>
              <ellipse cx="60" cy="67" rx="3.4" ry="3" />
            </g>
            <g className={s.whiskers} strokeWidth=".8">
              <path d="M22 58 L40 60" />
              <path d="M22 64 L40 63" />
              <path d="M98 58 L80 60" />
              <path d="M98 64 L80 63" />
            </g>
            <g className={s.phones}>
              <path className={s.phonesBand} d="M24 50 C24 7 96 7 96 50" strokeWidth="3.2" />
              <rect className={s.phonesCup} x="15.5" y="40" width="11" height="21" rx="4.5" />
              <rect className={s.phonesCup} x="93.5" y="40" width="11" height="21" rx="4.5" />
            </g>
          </g>
        </g>
        <g className={s.zz}>
          <text className={s.z1} x="94" y="20">
            z
          </text>
          <text className={s.z2} x="100" y="12">
            z
          </text>
          <text className={s.z3} x="106" y="4">
            Z
          </text>
        </g>
        <g className={s.hearts}>
          <path className={s.heartA} d="M60 14 c-3-4-9-1-6 4 l6 6 6-6 c3-5-3-8-6-4z" />
          <path className={s.heartB} d="M76 20 c-2-3-7-1-5 3 l5 5 5-5 c2-4-3-6-5-3z" />
          <path className={s.heartC} d="M46 22 c-2-3-7-1-5 3 l5 5 5-5 c2-4-3-6-5-3z" />
        </g>
      </svg>
    </div>
  )
}

/** 唱片眼睛:黑胶 + 两圈纹 + 琥珀标签 + 缺口 + 轴孔,外加一点高光(高光不跟着转)。 */
function VinylEye({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 49)`}>
      <g className={s.vinyl}>
        <circle className={s.vinylDisc} r="8.6" />
        <circle className={s.vinylGroove} r="7.1" strokeWidth=".6" />
        <circle className={s.vinylGroove} r="5.7" strokeWidth=".6" />
        <circle className={s.vinylLabel} r="3.5" />
        <rect className={s.vinylNotch} x="-.45" y="-3.5" width=".9" height="1.8" />
        <circle className={s.vinylDisc} r=".7" />
      </g>
      <ellipse className={s.glint} cx="-3.2" cy="-4.2" rx="2.2" ry="1.2" />
    </g>
  )
}
