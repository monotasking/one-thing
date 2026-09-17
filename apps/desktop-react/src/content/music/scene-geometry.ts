/**
 * **唱机场景的几何**(宠物 P1,正本 `docs/design/pet-system-2026-09.md` §8)。
 *
 * 纯函数与数据表,不碰 DOM、不碰 React —— 场景、实验台与单测吃同一份。
 *
 * ── 为什么坐标住在这里而不在样式表里 ────────────────────────────────────
 * 场景是一张 640×420 的**设计画布**(样例「黑豆电台」逐格搬来),里面每一件东西的
 * 位置是**画面的几何**,不是界面的间距:唱臂的轴心、唱片的圆心、唱针能落的内外圈
 * 半径是同一套坐标里的几个数,拖唱头时要拿它们反算进度。把它们拆成几十个 token
 * 等于把一张图的坐标抄进两个地方(CSS 摆、TS 算),改一处漏一处。所以:
 *   · 位置与尺寸 = 这里的 `SCENE_LAYOUT` 表,场景把它们写成行内 left/top/width/height;
 *   · 颜色、阴影、圆角、字 = tokens.css「唱机场景」节(与 HeidouRig 里 SVG 路径坐标
 *     写在组件里、颜色进 token 是同一条分工);
 *   · 画布宽高与裁切阈值两边都要(样式表定 `.scene` 的身量,这里算缩放),所以
 *     tokens.css 里各有一格,`scene-geometry.test.ts` 逐条比对。
 *
 * ── 角度的约定 ──────────────────────────────────────────────────────────
 * 唱臂以轴心为原点,**0° = 竖直朝下**(靠在支架上),CSS `rotate()` 的正方向(顺时针)
 * 让唱头往左摆向唱片。唱针位置 = 轴心 + 臂长 ×(−sin, cos)。
 */

/* ── 画布 ──────────────────────────────────────────────────────────────── */

/** 设计画布宽高(px)。与 tokens.css `--music-scene-w` / `--music-scene-h` 同一对数。 */
export const SCENE_W = 640
export const SCENE_H = 420
/** 场景容器比它窄就裁掉左侧的窗与半张封套(§8)。与 `--music-scene-crop-below` 同一个数。 */
export const SCENE_CROP_BELOW = 520
/** 裁切视口:从 x=118 起,宽 522;高度照样例收到 400(底座下沿那 20 格不值得占高)。 */
export const SCENE_CROP = { x: 118, w: 522, h: 400 } as const
/** 放大上限。舞台再宽,唱机也不长到比样例大四分之一以上 —— 多出来的宽度两边留墙。 */
export const SCENE_MAX_SCALE = 1.25

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * 画面里每一件东西的矩形(画布坐标)。逐格取自样例;`record` 的圆心就是唱针
 * 几何里的 `RECORD_CENTER`,`perch` 是黑豆站的那一格(底边正中是锚点)。
 */
export const SCENE_LAYOUT = {
  window: { x: 30, y: 24, w: 150, h: 108 },
  sleeve: { x: 36, y: 150, w: 150, h: 150 },
  plinth: { x: 92, y: 128, w: 488, h: 286 },
  brand: { x: 470, y: 396, w: 90, h: 10 },
  /** ON AIR 灯(宠物 P3,§10.5):底座前沿、唱牌左边,样例那一格。 */
  onAir: { x: 396, y: 390, w: 56, h: 16 },
  platter: { x: 124, y: 154, w: 252, h: 252 },
  record: { x: 132, y: 162, w: 236, h: 236 },
  armBase: { x: 406, y: 151, w: 48, h: 48 },
  cue: { x: 452, y: 208, w: 18, h: 6 },
  fan: { x: 560, y: 252, w: 70, h: 90 },
  perch: { x: 468, y: 246, w: 120, h: 134 },
} as const satisfies Record<string, Rect>

/** 唱臂 SVG 相对轴心的那一格(轴心在 SVG 的 (30, 60))。 */
export const ARM_SVG: Rect = { x: -30, y: -60, w: 60, h: 250 }
/** 唱头上那块可聚焦、可按住的热区(相对轴心)。 */
export const ARM_GRAB: Rect = { x: -23, y: 142, w: 40, h: 40 }

/** 矩形 → 行内样式。 */
export function rectStyle(rect: Rect): { left: string; top: string; width: string; height: string } {
  return { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` }
}

/* ── 唱针 ──────────────────────────────────────────────────────────────── */

export const ARM_PIVOT = { x: 430, y: 175 } as const
export const ARM_LENGTH = 170
export const RECORD_CENTER = {
  x: SCENE_LAYOUT.record.x + SCENE_LAYOUT.record.w / 2,
  y: SCENE_LAYOUT.record.y + SCENE_LAYOUT.record.h / 2,
} as const
/** 唱针在开头(最外一圈纹)离圆心多远。 */
export const NEEDLE_START_R = 112
/** 唱针在结尾(最内一圈纹)离圆心多远。 */
export const NEEDLE_END_R = 60
/** 没有歌时唱臂靠在支架上。 */
export const ARM_REST_DEG = 0
/** 时间提示离轴心多远(比唱头再远 30,不被手指挡住)。 */
export const TIP_RADIUS = ARM_LENGTH + 30

const RAD = Math.PI / 180

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

/** 唱臂转到 `deg` 时唱针离唱片圆心多远。 */
export function needleRadiusAt(deg: number): number {
  const a = deg * RAD
  const x = ARM_PIVOT.x - ARM_LENGTH * Math.sin(a)
  const y = ARM_PIVOT.y + ARM_LENGTH * Math.cos(a)
  return Math.hypot(x - RECORD_CENTER.x, y - RECORD_CENTER.y)
}

/**
 * 唱针要落在半径 `r` 上时唱臂的角度。0–70° 里半径随角度单调变小,二分四十次
 * 足够(误差远小于一个像素)。
 */
export function angleForNeedleRadius(r: number): number {
  let lo = 0
  let hi = 70
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (needleRadiusAt(mid) > r) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** 开头(外圈)与结尾(内圈)两个角度。拖动夹在这两个数之间。 */
export const ARM_START_DEG = angleForNeedleRadius(NEEDLE_START_R)
export const ARM_END_DEG = angleForNeedleRadius(NEEDLE_END_R)

/** 进度(0–1)→ 唱臂角度。 */
export function angleForProgress(progress: number): number {
  return angleForNeedleRadius(NEEDLE_START_R - (NEEDLE_START_R - NEEDLE_END_R) * clamp01(progress))
}

/** 唱臂角度 → 进度(0–1),夹回两头。 */
export function progressForAngle(deg: number): number {
  return clamp01((NEEDLE_START_R - needleRadiusAt(deg)) / (NEEDLE_START_R - NEEDLE_END_R))
}

/** 画布上一点 → 唱臂该指的角度,夹在开头与结尾之间。 */
export function angleAtScenePoint(x: number, y: number): number {
  const deg = Math.atan2(-(x - ARM_PIVOT.x), y - ARM_PIVOT.y) / RAD
  return Math.min(ARM_END_DEG, Math.max(ARM_START_DEG, deg))
}

/** 唱臂在 `deg` 时时间提示该在画布上的哪一点。 */
export function tipScenePoint(deg: number): { x: number; y: number } {
  const a = deg * RAD
  return { x: ARM_PIVOT.x - TIP_RADIUS * Math.sin(a), y: ARM_PIVOT.y + TIP_RADIUS * Math.cos(a) }
}

/* ── 视口 ──────────────────────────────────────────────────────────────── */

export interface SceneViewport {
  /** 画布从哪一格 x 开始露出来(裁切档 118,其余 0)。 */
  viewX: number
  /** 画布 → 屏幕的缩放。 */
  scale: number
  /** 放大到顶之后画布在容器里居中,左边留的那一段(屏幕 px)。 */
  offsetX: number
  /** 容器该有多高(屏幕 px)。 */
  height: number
  cropped: boolean
}

/** 容器宽 → 视口。还没布局(宽 ≤ 0)时答原大,等于「不缩放」。 */
export function sceneViewport(containerWidth: number): SceneViewport {
  if (!(containerWidth > 0)) return { viewX: 0, scale: 1, offsetX: 0, height: SCENE_H, cropped: false }
  if (containerWidth < SCENE_CROP_BELOW) {
    const scale = containerWidth / SCENE_CROP.w
    return { viewX: SCENE_CROP.x, scale, offsetX: 0, height: SCENE_CROP.h * scale, cropped: true }
  }
  const scale = Math.min(SCENE_MAX_SCALE, containerWidth / SCENE_W)
  return { viewX: 0, scale, offsetX: (containerWidth - SCENE_W * scale) / 2, height: SCENE_H * scale, cropped: false }
}

/** 画布坐标 → 容器坐标(屏幕 px,相对容器左上)。 */
export function sceneToContainer(view: SceneViewport, x: number, y: number): { x: number; y: number } {
  return { x: (x - view.viewX) * view.scale + view.offsetX, y: y * view.scale }
}

/** 指针(client 坐标)→ 画布坐标。`box` 是容器此刻的矩形。 */
export function clientToScene(
  view: SceneViewport,
  box: { left: number; top: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  return {
    x: (clientX - box.left - view.offsetX) / view.scale + view.viewX,
    y: (clientY - box.top) / view.scale,
  }
}

/* ── 唱片标签上那一圈字 ────────────────────────────────────────────────── */

/** 标签上印字那一圈的周长(SVG 单位:半径 30)。 */
export const LABEL_ARC_LENGTH = 2 * Math.PI * 30
/** 标签字号与字距(SVG 单位),与场景里 `<text>` 上的两格同一对数。 */
export const LABEL_FONT = 7.2
export const LABEL_TRACKING = 1.2
const LABEL_SUFFIX = ' · 33⅓ RPM · '

/** 一个字大约占几个字号宽:全角 1,其余按等宽拉丁 0.6。 */
function glyphEm(glyph: string): number {
  return /[⺀-鿿가-힯＀-￯]/.test(glyph) ? 1 : 0.6
}

/**
 * 标签那一圈要印的字:`歌名 · 歌手 · 33⅓ RPM · `,绕不下一圈就把歌名 / 歌手收成
 * 省略号(一圈印重了会首尾叠字)。空歌名答空串。
 */
export function arcLabelText(name: string, artist: string): string {
  if (!name) return ''
  const width = (text: string) => Array.from(text).reduce((sum, g) => sum + glyphEm(g) * LABEL_FONT + LABEL_TRACKING, 0)
  const nameGlyphs = Array.from(name)
  const artistGlyphs = Array.from(artist)
  const cut = (glyphs: string[], keep: number) =>
    keep >= glyphs.length ? glyphs.join('') : keep > 0 ? `${glyphs.slice(0, keep).join('')}…` : ''
  let keepName = nameGlyphs.length
  let keepArtist = artistGlyphs.length
  const build = () => {
    const a = cut(artistGlyphs, keepArtist)
    return `${cut(nameGlyphs, keepName)}${a ? ` · ${a}` : ''}${LABEL_SUFFIX}`
  }
  let text = build()
  // 先收长的那一半;歌手收没了再收歌名,歌名至少留一个字。
  while (width(text) > LABEL_ARC_LENGTH && (keepName > 1 || keepArtist > 0)) {
    if (keepArtist > 0 && keepArtist >= keepName) keepArtist -= 1
    else keepName -= 1
    text = build()
  }
  return text
}

/* ── 封套 ──────────────────────────────────────────────────────────────── */

export interface SleeveColors {
  /** 封套底色(暗)。 */
  dark: string
  /** 封面上那枚圆与字(亮)。 */
  light: string
}

/**
 * 歌名 → 封套两色。**没有封面图**(自述里没有这件事实,判词在 MusicPanel.tsx 文件头),
 * 所以封套是从歌名算出来的:FNV-1a 取两个色相,一暗一亮。同一首歌永远同一张封套。
 * 颜色是生成的数据,不是界面色,所以不进 token(与 `--fb-*` 品牌色数据同一条例外)。
 */
export function sleeveColorsFor(title: string): SleeveColors {
  let h = 0x811c9dc5
  for (const ch of title) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const hueDark = h % 360
  const hueLight = (hueDark + 25 + ((h >>> 9) % 110)) % 360
  return { dark: `hsl(${hueDark} 22% 38%)`, light: `hsl(${hueLight} 48% 82%)` }
}
