import type { CSSProperties, ReactNode } from 'react'
import {
  isRigColor,
  type DeclarativeRigSpec,
  type RigMotion,
  type RigOneShot,
  type RigOrigin,
  type RigPart,
  type RigPartPose,
  type RigTransform,
} from '@onething/runtime/pets/rig-spec'
import type { PetRigProps } from '../types'
import s from './DeclarativeRig.module.css'

/**
 * **声明式形象的解释器**(宠物 P5,正本 `docs/design/pet-system-2026-09.md` §12.2)。
 *
 * 吃一份 `DeclarativeRigSpec`(纯数据,产品层 `@onething/runtime/pets/rig-spec`)+ 与
 * `HeidouRig` 同一套 `PetRigProps`,吐 SVG。它**不执行数据里的任何字符串**:没有
 * `dangerouslySetInnerHTML`、没有拼出来的样式串;元素全是按结构化字段 `createElement`
 * 出来的,颜色过一遍白名单(`isRigColor`)才落到 `fill` / `stroke` 上,变换是数字拼成的
 * `translate/rotate/scale`,动作只从词表 → 类名那张表里查。
 *
 * **不认识的东西一律不画、不抛**:形状不在表里的部件、`parent` 指着不存在的组的部件、
 * 姿势里点名一个不存在的部件、不在词表里的动作名、不在调色板里的颜色名 —— 各自悄悄跳过。
 * 数据交到这里之前已经过了后端的 `validateRigSpec`(有问题的宠物不进名册),这一层的宽容
 * 只是第二道。
 *
 * ── 每个部件三层 `<g>` ─────────────────────────────────────────────────────
 *   外层 —— 姿势的 `transform`(内联,带 450ms 过渡)与显隐;
 *   中层 —— 只有被某个一次性动画点名的部件才有:放那一下的动画;
 *   内层 —— 姿势的 `motion`(循环动画)。
 * 分三层是因为三者都写 `transform`:同一个元素上动画会盖掉姿势摆好的位置。
 *
 * ── 显隐的判据,从弱到强 ────────────────────────────────────────────────────
 *   部件自己的 `hidden` → 嘴(`mouth.talking` 张嘴时出现、`mouth.closed` 闭嘴时出现)→
 *   这个姿势对它的 `hidden` → 一次性动画点名它(那一下期间强制出现)。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:无状态。spec 换了身份但内容相同 → 同一棵树(key 是部件 id),不重挂。
 * ② UI 生命状态:九种姿势 × 嘴两态 × 一次性动画五种;没有 loading / error;
 *    spec 里什么都画不出来 = 一张空 SVG(舞台上那颗宠物按钮照样在)。
 * ③ UI 交互状态:无 —— 对读屏藏起来(`aria-hidden`),可达入口是舞台上那颗宠物按钮。
 */

const SHAPES = new Set(['path', 'ellipse', 'circle', 'rect', 'group'])

const MOTION_CLASS: Readonly<Record<RigMotion, string | undefined>> = {
  bob: s.motionBob,
  tap: s.motionTap,
  sway: s.motionSway,
  swayFast: s.motionSwayFast,
  breathe: s.motionBreathe,
  spin: s.motionSpin,
  wobble: s.motionWobble,
  twitch: s.motionTwitch,
  purr: s.motionPurr,
  floatUp: s.motionFloatUp,
}

const SHOT_CLASS: Readonly<Record<RigOneShot, string | undefined>> = {
  squish: s.shotSquish,
  startle: s.shotStartle,
  wake: s.shotWake,
  love: s.shotLove,
  twitch: s.shotTwitch,
}

function motionClassOf(motion: unknown): string | undefined {
  return typeof motion === 'string' && Object.prototype.hasOwnProperty.call(MOTION_CLASS, motion)
    ? MOTION_CLASS[motion as RigMotion]
    : undefined
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 结构化变换 → CSS `transform`。只认数字;缺的、不是数的格跳过。 */
export function transformOf(transform: RigTransform | undefined): string | undefined {
  if (!transform) return undefined
  const steps: string[] = []
  const t = transform.translate
  if (Array.isArray(t) && finite(t[0]) && finite(t[1])) steps.push(`translate(${t[0]}px, ${t[1]}px)`)
  if (finite(transform.rotate)) steps.push(`rotate(${transform.rotate}deg)`)
  const sc = transform.scale
  if (finite(sc)) steps.push(`scale(${sc})`)
  else if (Array.isArray(sc) && finite(sc[0]) && finite(sc[1])) steps.push(`scale(${sc[0]}, ${sc[1]})`)
  return steps.length ? steps.join(' ') : undefined
}

function originOf(origin: RigOrigin | undefined): string {
  if (Array.isArray(origin) && finite(origin[0]) && finite(origin[1])) return `${origin[0]}% ${origin[1]}%`
  return '50% 50%'
}

/** 这一种一次性动画落到哪个部件;没点名 / 点名了不存在的部件 = 落到整只。 */
function shotTargets(spec: DeclarativeRigSpec, ids: ReadonlySet<string>): Map<string, RigOneShot[]> {
  const byPart = new Map<string, RigOneShot[]>()
  for (const [shot, target] of Object.entries(spec.oneShots ?? {})) {
    if (typeof target !== 'string' || !ids.has(target) || !(shot in SHOT_CLASS)) continue
    byPart.set(target, [...(byPart.get(target) ?? []), shot as RigOneShot])
  }
  return byPart
}

export function DeclarativeRig({ spec, pose, beat, mouth, oneShot }: PetRigProps & { spec: DeclarativeRigSpec }) {
  const parts = Array.isArray(spec.parts) ? spec.parts : []
  const drawable = parts.filter((part) => part && typeof part.id === 'string' && SHAPES.has(part.shape))
  const groups = new Set(drawable.filter((part) => part.shape === 'group').map((part) => part.id))
  const ids = new Set(drawable.map((part) => part.id))
  const children = new Map<string | undefined, RigPart[]>()
  for (const part of drawable) {
    // 指着不存在的组 → 整个部件不画(挂不上去的东西没有位置)。
    if (part.parent !== undefined && !groups.has(part.parent)) continue
    const key = part.parent
    children.set(key, [...(children.get(key) ?? []), part])
  }

  const posed: Readonly<Record<string, RigPartPose>> = spec.poses?.[pose]?.parts ?? {}
  const talking = new Set(Array.isArray(spec.mouth?.talking) ? spec.mouth.talking : [])
  const closed = new Set(Array.isArray(spec.mouth?.closed) ? spec.mouth.closed : [])
  const targets = shotTargets(spec, ids)
  const targeted = oneShot !== undefined && [...targets.values()].some((shots) => shots.includes(oneShot))
  // 没点名部件的一次性动画落到整只;「爱心上浮」落到整只会让整只飘走,换成压扁弹回。
  const rootShot = oneShot === undefined || targeted ? undefined : oneShot === 'love' ? 'squish' : oneShot

  const palette = spec.palette ?? {}
  const colorOf = (name: string | undefined): string | undefined => {
    if (name === undefined || !Object.prototype.hasOwnProperty.call(palette, name)) return undefined
    const color = palette[name]
    return isRigColor(color) ? color : undefined
  }

  const visibleOf = (part: RigPart): boolean => {
    const own = posed[part.id]
    if (oneShot !== undefined && targets.get(part.id)?.includes(oneShot)) return true
    if (typeof own?.hidden === 'boolean') return !own.hidden
    if (talking.has(part.id)) return mouth === 'talking'
    if (closed.has(part.id)) return mouth === 'closed'
    return part.hidden !== true
  }

  const render = (part: RigPart): ReactNode => {
    const own = posed[part.id]
    const origin = originOf(part.origin)
    const visible = visibleOf(part)
    const outerStyle: CSSProperties = { transformOrigin: origin }
    const transform = transformOf(own?.transform)
    if (transform) outerStyle.transform = transform

    const motion = motionClassOf(own?.motion)
    const talkClass = talking.has(part.id) && mouth === 'talking' ? s.talk : undefined
    const innerClass = [s.layer, motion, talkClass].filter(Boolean).join(' ')

    const body = part.shape === 'group' ? (children.get(part.id) ?? []).map(render) : shapeOf(part, colorOf)
    const inner = (
      <g className={innerClass} style={{ transformOrigin: origin }} data-motion={motion ? own?.motion : undefined}>
        {body}
      </g>
    )
    const shots = targets.get(part.id)
    const shotClass = oneShot !== undefined && shots?.includes(oneShot) ? SHOT_CLASS[oneShot] : undefined
    return (
      <g
        key={part.id}
        className={visible ? s.part : `${s.part} ${s.hidden}`}
        style={outerStyle}
        data-part={part.id}
        data-hidden={visible ? undefined : 'true'}
      >
        {shots ? (
          <g className={[s.layer, shotClass].filter(Boolean).join(' ')} style={{ transformOrigin: origin }}>
            {inner}
          </g>
        ) : (
          inner
        )}
      </g>
    )
  }

  const viewBox = Array.isArray(spec.viewBox) && spec.viewBox.length === 4 && spec.viewBox.every(finite)
    ? spec.viewBox.join(' ')
    : undefined
  const style = beat !== undefined ? ({ '--pet-beat': `${beat}s` } as CSSProperties) : undefined

  return (
    <div
      className={s.rig}
      data-pose={pose}
      data-mouth={mouth}
      data-one-shot={rootShot}
      style={style}
      data-testid="pet-rig"
    >
      <svg className={s.svg} viewBox={viewBox} aria-hidden="true">
        {(children.get(undefined) ?? []).map(render)}
      </svg>
    </div>
  )
}

function shapeOf(part: RigPart, colorOf: (name: string | undefined) => string | undefined): ReactNode {
  const paint = {
    fill: colorOf(part.fill) ?? 'none',
    stroke: colorOf(part.stroke),
    strokeWidth: finite(part.strokeWidth) ? part.strokeWidth : undefined,
    strokeLinecap: part.linecap === 'round' || part.linecap === 'butt' || part.linecap === 'square' ? part.linecap : undefined,
    strokeLinejoin: part.linecap === 'round' ? ('round' as const) : undefined,
  }
  switch (part.shape) {
    case 'path':
      return typeof part.d === 'string' ? <path d={part.d} {...paint} /> : null
    case 'ellipse':
      return <ellipse cx={num(part.cx)} cy={num(part.cy)} rx={num(part.rx)} ry={num(part.ry)} {...paint} />
    case 'circle':
      return <circle cx={num(part.cx)} cy={num(part.cy)} r={num(part.r)} {...paint} />
    case 'rect':
      return (
        <rect
          x={num(part.x)}
          y={num(part.y)}
          width={num(part.width)}
          height={num(part.height)}
          rx={finite(part.rx) ? part.rx : undefined}
          {...paint}
        />
      )
    default:
      return null
  }
}

function num(value: unknown): number {
  return finite(value) ? value : 0
}
