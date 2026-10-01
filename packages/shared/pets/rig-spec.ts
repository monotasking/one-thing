/**
 * **声明式形象** `DeclarativeRigSpec`(宠物 P5,正本 `docs/design/pet-system-2026-09.md` §12.2)。
 *
 * 一只宠物「长什么样、九个姿势各怎么摆」写成**纯数据**:壳侧 `DeclarativeRig` 解释它,
 * 不执行任何代码。这只文件只有类型、两张固定词表与一个纯校验函数 —— 壳与未来的插件
 * 安装页共用同一份(§12.1:格式按「插件也能交」定形)。
 *
 * ── 为什么每一格都是结构化的,而不是字符串 ──────────────────────────────
 * 变换写成 `{ translate, rotate, scale }` 而不是 `"translate(…) rotate(…)"`,颜色只进调色板、
 * 部件只引用调色板里的名字,动作只许挑词表里的名字 —— 于是这份数据里**没有一处**会被
 * 当作 CSS / SVG 源文本拼进页面。`path.d` 是唯一的自由文本,它按路径字符集逐字校验。
 *
 * ── 与 §12.2 那张表相比多了什么 ──────────────────────────────────────────
 *   · 每个部件的几何格(`d` / `cx` / `cy` / `rx` / `ry` / `r` / `x` / `y` / `width` / `height`):
 *     表里写「shape 只许 path(d)/ ellipse / circle / rect / group」,几何格按 SVG 原名;
 *   · 部件的 `hidden`(缺省显隐)与 `linecap`:没有它,「闭着的眼睛只在睡觉时出现」要在
 *     九个姿势里各写一遍 `hidden: true`;
 *   · 颜色白名单取 §12.2 原文那四种(`#rgb` / `#rrggbb` / `rgb()` / `rgba()`),比主题覆盖的
 *     白名单窄 —— 窄的那一边永远安全。
 */

/** §7.2 那张优先级表的九行。与壳侧 `PoseState` 逐字相同(壳侧有类型测试钉住)。 */
export const RIG_POSES = [
  'petted',
  'dizzy',
  'sleeping',
  'speaking',
  'busy',
  'listening',
  'dozing',
  'grooving',
  'sitting',
] as const

export type RigPose = (typeof RIG_POSES)[number]

/**
 * **动作词表**(§12.2)。壳里 `motion.css` 已有的关键帧,形象只能挑,不能造:
 *   bob       随拍点头(时长 = 拍)        tap      随拍打拍子(时长 = 拍)
 *   sway      慢摆                         swayFast 快摆(有拍时一拍一摆)
 *   breathe   呼吸起伏                     spin     慢转(眼睛类部件)
 *   wobble    晕                           twitch   抖一下,持续
 *   purr      细抖                         floatUp  z / 爱心上浮
 */
export const RIG_MOTIONS = [
  'bob',
  'tap',
  'sway',
  'swayFast',
  'breathe',
  'spin',
  'wobble',
  'twitch',
  'purr',
  'floatUp',
] as const

export type RigMotion = (typeof RIG_MOTIONS)[number]

export const RIG_ONE_SHOTS = ['squish', 'startle', 'wake', 'love', 'twitch'] as const
export type RigOneShot = (typeof RIG_ONE_SHOTS)[number]

export const RIG_SHAPES = ['path', 'ellipse', 'circle', 'rect', 'group'] as const
export type RigShape = (typeof RIG_SHAPES)[number]

/** 部件数上限(§12.2)。 */
export const RIG_MAX_PARTS = 80
/** `parent` 最多嵌几层(§12.2):顶层部件深 0,`group` 里的部件深 1 …… 深 4 为止。 */
export const RIG_MAX_DEPTH = 4

/** 结构化变换。先平移、再旋转、再缩放(与 CSS `transform` 书写顺序一致)。 */
export interface RigTransform {
  readonly translate?: readonly [number, number]
  /** 角度。 */
  readonly rotate?: number
  /** 等比;给两格是 `[sx, sy]`。 */
  readonly scale?: number | readonly [number, number]
}

/** 变换原点:`'center'` 或 `[x%, y%]`(相对部件自己的外框)。缺省 `'center'`。 */
export type RigOrigin = 'center' | readonly [number, number]

export interface RigPart {
  readonly id: string
  readonly shape: RigShape
  /** 调色板里的名字;缺席 = 不填。 */
  readonly fill?: string
  /** 调色板里的名字;缺席 = 不描边。 */
  readonly stroke?: string
  readonly strokeWidth?: number
  readonly linecap?: 'round' | 'butt' | 'square'
  readonly origin?: RigOrigin
  /** 指向另一个 `group` 部件的 `id`,且那个部件必须排在它**前面**。 */
  readonly parent?: string
  /** 缺省显隐:`true` = 只有某个姿势 / 嘴 / 一次性动画点名时才出现。 */
  readonly hidden?: boolean
  /* 几何:按 shape 取用,SVG 原名 */
  readonly d?: string
  readonly cx?: number
  readonly cy?: number
  readonly rx?: number
  readonly ry?: number
  readonly r?: number
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
}

export interface RigPartPose {
  readonly hidden?: boolean
  readonly transform?: RigTransform
  readonly motion?: RigMotion
}

export interface RigPoseSpec {
  readonly parts: Readonly<Record<string, RigPartPose>>
}

export interface DeclarativeRigSpec {
  readonly viewBox: readonly [number, number, number, number]
  readonly palette: Readonly<Record<string, string>>
  readonly parts: readonly RigPart[]
  /** 九个姿势。缺的姿势 = 全部部件按缺省画。 */
  readonly poses: Readonly<Partial<Record<RigPose, RigPoseSpec>>>
  /** 说话时显示哪些、藏哪些:`talking` 那一组张嘴时出现,`closed` 那一组闭嘴时出现。 */
  readonly mouth: { readonly closed: readonly string[]; readonly talking: readonly string[] }
  /** 各一次性动画落到哪个部件;缺席落到整只。 */
  readonly oneShots?: Readonly<Partial<Record<RigOneShot, string>>>
}

/** 一条问题。`path` 是 JSON 路径式的定位(`parts[3].fill`),给人看的。 */
export interface RigSpecProblem {
  readonly path: string
  readonly message: string
}

/* ── 校验 ─────────────────────────────────────────────────────────────────── */

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
/** 括号内只许数字、小数点、逗号、百分号、空白 —— 放不进 `var(` / `url(`。 */
const RGB_COLOR = /^rgba?\([0-9.,% ]*\)$/i
/** SVG 路径数据的字符集:命令字母、数字、符号、小数点、逗号、空白。 */
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\- \n]*$/
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
const PATH_MAX_LENGTH = 4_000

const SPEC_KEYS = new Set(['viewBox', 'palette', 'parts', 'poses', 'mouth', 'oneShots'])
const PART_KEYS = new Set([
  'id', 'shape', 'fill', 'stroke', 'strokeWidth', 'linecap', 'origin', 'parent', 'hidden',
  'd', 'cx', 'cy', 'rx', 'ry', 'r', 'x', 'y', 'width', 'height',
])
const GEOMETRY: Record<RigShape, readonly string[]> = {
  path: ['d'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  rect: ['x', 'y', 'width', 'height', 'rx'],
  group: [],
}
const REQUIRED_GEOMETRY: Record<RigShape, readonly string[]> = {
  path: ['d'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  rect: ['x', 'y', 'width', 'height'],
  group: [],
}
const PART_POSE_KEYS = new Set(['hidden', 'transform', 'motion'])
const TRANSFORM_KEYS = new Set(['translate', 'rotate', 'scale'])
const MOTIONS: ReadonlySet<string> = new Set(RIG_MOTIONS)
const POSES: ReadonlySet<string> = new Set(RIG_POSES)
const ONE_SHOTS: ReadonlySet<string> = new Set(RIG_ONE_SHOTS)
const SHAPES: ReadonlySet<string> = new Set(RIG_SHAPES)

/** 颜色字面量是否在白名单里(§12.2)。 */
export function isRigColor(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return HEX_COLOR.test(value) || RGB_COLOR.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNumberPair(value: unknown): value is readonly [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber)
}

/**
 * 校验一份声明式形象。**纯函数**,不抛:返回问题清单,空 = 合格。
 * 有任何问题 → 这只宠物不进宠物列表(内置宠物有问题 → 单测红)。
 */
export function validateRigSpec(spec: unknown): RigSpecProblem[] {
  const problems: RigSpecProblem[] = []
  const report = (path: string, message: string) => problems.push({ path, message })

  if (!isRecord(spec)) {
    report('', 'rig spec must be an object')
    return problems
  }
  for (const key of Object.keys(spec)) {
    if (!SPEC_KEYS.has(key)) report(key, `unknown field "${key}"`)
  }

  const viewBox = spec.viewBox
  if (!Array.isArray(viewBox) || viewBox.length !== 4 || !viewBox.every(isFiniteNumber)) {
    report('viewBox', 'viewBox must be four numbers [x, y, w, h]')
  } else if (!((viewBox[2] as number) > 0) || !((viewBox[3] as number) > 0)) {
    report('viewBox', 'viewBox width and height must be positive')
  }

  const palette = isRecord(spec.palette) ? spec.palette : null
  if (!palette) report('palette', 'palette must be an object of name → color')
  else {
    for (const [name, color] of Object.entries(palette)) {
      if (!ID.test(name)) report(`palette.${name}`, `invalid palette name "${name}"`)
      if (!isRigColor(color)) report(`palette.${name}`, 'color must be #rgb, #rrggbb, rgb() or rgba()')
    }
  }

  const partIds = new Map<string, { shape: string; depth: number }>()
  if (!Array.isArray(spec.parts)) {
    report('parts', 'parts must be an array')
  } else {
    if (spec.parts.length > RIG_MAX_PARTS) report('parts', `at most ${RIG_MAX_PARTS} parts (got ${spec.parts.length})`)
    spec.parts.forEach((raw, index) => validatePart(raw, `parts[${index}]`, palette, partIds, report))
  }

  const knownPart = (id: unknown, path: string) => {
    if (typeof id !== 'string' || !partIds.has(id)) report(path, `unknown part "${String(id)}"`)
  }

  if (!isRecord(spec.poses)) report('poses', 'poses must be an object')
  else {
    for (const [poseName, pose] of Object.entries(spec.poses)) {
      const base = `poses.${poseName}`
      if (!POSES.has(poseName)) report(base, `unknown pose "${poseName}"`)
      if (!isRecord(pose)) {
        report(base, 'pose must be an object')
        continue
      }
      for (const key of Object.keys(pose)) if (key !== 'parts') report(`${base}.${key}`, `unknown field "${key}"`)
      if (!isRecord(pose.parts)) {
        report(`${base}.parts`, 'pose parts must be an object')
        continue
      }
      for (const [partId, partPose] of Object.entries(pose.parts)) {
        validatePartPose(partPose, `${base}.parts.${partId}`, report)
        knownPart(partId, `${base}.parts.${partId}`)
      }
    }
  }

  const mouth = spec.mouth
  if (!isRecord(mouth)) report('mouth', 'mouth must be { closed, talking }')
  else {
    for (const key of Object.keys(mouth)) {
      if (key !== 'closed' && key !== 'talking') report(`mouth.${key}`, `unknown field "${key}"`)
    }
    for (const key of ['closed', 'talking'] as const) {
      const ids = mouth[key]
      if (!Array.isArray(ids)) report(`mouth.${key}`, `mouth.${key} must be an array of part ids`)
      else ids.forEach((id, index) => knownPart(id, `mouth.${key}[${index}]`))
    }
  }

  if (spec.oneShots !== undefined) {
    if (!isRecord(spec.oneShots)) report('oneShots', 'oneShots must be an object')
    else {
      for (const [name, target] of Object.entries(spec.oneShots)) {
        if (!ONE_SHOTS.has(name)) report(`oneShots.${name}`, `unknown one-shot "${name}"`)
        knownPart(target, `oneShots.${name}`)
      }
    }
  }

  return problems
}

function validatePart(
  raw: unknown,
  base: string,
  palette: Record<string, unknown> | null,
  seen: Map<string, { shape: string; depth: number }>,
  report: (path: string, message: string) => void,
): void {
  if (!isRecord(raw)) {
    report(base, 'part must be an object')
    return
  }
  for (const key of Object.keys(raw)) {
    if (!PART_KEYS.has(key)) report(`${base}.${key}`, `unknown field "${key}"`)
  }
  const id = raw.id
  const idOk = typeof id === 'string' && ID.test(id)
  if (!idOk) report(`${base}.id`, 'part id must be a short identifier')
  else if (seen.has(id)) report(`${base}.id`, `duplicate part id "${id}"`)

  const shape = raw.shape
  if (typeof shape !== 'string' || !SHAPES.has(shape)) {
    report(`${base}.shape`, `unknown shape "${String(shape)}"`)
    return
  }
  const rigShape = shape as RigShape
  const allowed = new Set(GEOMETRY[rigShape])
  for (const key of ['d', 'cx', 'cy', 'rx', 'ry', 'r', 'x', 'y', 'width', 'height']) {
    if (raw[key] !== undefined && !allowed.has(key)) report(`${base}.${key}`, `"${key}" does not apply to a ${rigShape}`)
  }
  for (const key of REQUIRED_GEOMETRY[rigShape]) {
    if (raw[key] === undefined) report(`${base}.${key}`, `a ${rigShape} needs "${key}"`)
  }
  for (const key of GEOMETRY[rigShape]) {
    if (key === 'd' || raw[key] === undefined) continue
    if (!isFiniteNumber(raw[key])) report(`${base}.${key}`, `"${key}" must be a number`)
  }
  if (raw.d !== undefined) {
    if (typeof raw.d !== 'string' || raw.d.length > PATH_MAX_LENGTH || !PATH_DATA.test(raw.d)) {
      report(`${base}.d`, 'path data may only contain path commands, numbers and separators')
    }
  }

  for (const key of ['fill', 'stroke'] as const) {
    const name = raw[key]
    if (name === undefined) continue
    if (typeof name !== 'string' || !palette || !Object.prototype.hasOwnProperty.call(palette, name)) {
      report(`${base}.${key}`, `"${String(name)}" is not in the palette`)
    }
  }
  if (raw.strokeWidth !== undefined && !(isFiniteNumber(raw.strokeWidth) && raw.strokeWidth >= 0)) {
    report(`${base}.strokeWidth`, 'strokeWidth must be a non-negative number')
  }
  if (raw.linecap !== undefined && raw.linecap !== 'round' && raw.linecap !== 'butt' && raw.linecap !== 'square') {
    report(`${base}.linecap`, 'linecap must be round, butt or square')
  }
  if (raw.hidden !== undefined && typeof raw.hidden !== 'boolean') report(`${base}.hidden`, 'hidden must be a boolean')
  if (raw.origin !== undefined && raw.origin !== 'center' && !isNumberPair(raw.origin)) {
    report(`${base}.origin`, 'origin must be "center" or [x%, y%]')
  }

  let depth = 0
  if (raw.parent !== undefined) {
    const parent = typeof raw.parent === 'string' ? seen.get(raw.parent) : undefined
    if (!parent) report(`${base}.parent`, `unknown part "${String(raw.parent)}" (a parent must come earlier)`)
    else if (parent.shape !== 'group') report(`${base}.parent`, `parent "${String(raw.parent)}" is not a group`)
    else {
      depth = parent.depth + 1
      if (depth > RIG_MAX_DEPTH) report(`${base}.parent`, `nesting deeper than ${RIG_MAX_DEPTH} levels`)
    }
  }
  if (idOk && !seen.has(id)) seen.set(id, { shape: rigShape, depth })
}

function validatePartPose(raw: unknown, base: string, report: (path: string, message: string) => void): void {
  if (!isRecord(raw)) {
    report(base, 'a part pose must be an object')
    return
  }
  for (const key of Object.keys(raw)) {
    if (!PART_POSE_KEYS.has(key)) report(`${base}.${key}`, `unknown field "${key}"`)
  }
  if (raw.hidden !== undefined && typeof raw.hidden !== 'boolean') report(`${base}.hidden`, 'hidden must be a boolean')
  if (raw.motion !== undefined && (typeof raw.motion !== 'string' || !MOTIONS.has(raw.motion))) {
    report(`${base}.motion`, `unknown motion "${String(raw.motion)}"`)
  }
  if (raw.transform !== undefined) {
    const transform = raw.transform
    if (!isRecord(transform)) {
      report(`${base}.transform`, 'transform must be { translate?, rotate?, scale? }')
      return
    }
    for (const key of Object.keys(transform)) {
      if (!TRANSFORM_KEYS.has(key)) report(`${base}.transform.${key}`, `unknown field "${key}"`)
    }
    if (transform.translate !== undefined && !isNumberPair(transform.translate)) {
      report(`${base}.transform.translate`, 'translate must be [x, y]')
    }
    if (transform.rotate !== undefined && !isFiniteNumber(transform.rotate)) {
      report(`${base}.transform.rotate`, 'rotate must be a number of degrees')
    }
    if (transform.scale !== undefined && !(isFiniteNumber(transform.scale) || isNumberPair(transform.scale))) {
      report(`${base}.transform.scale`, 'scale must be a number or [sx, sy]')
    }
  }
}
