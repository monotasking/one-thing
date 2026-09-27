/**
 * **气泡的节拍与几何**(宠物 P0,正本 §7.4)。纯函数,舞台与测试调同一份。
 *
 * 这里的时长全是**读认窗口**(字多快出、出完停多久),不是动画时长 —— 动效档「无」
 * 不清零它们(与 `components/motion.ts` 里 COPY_FEEDBACK_MS 同一族),所以它们没有
 * CSS token,也不进 motion-tokens 的逐条比对。
 */

/** 开口:每个字之间的停顿。 */
export const TYPE_CHAR_MS = 95
/** 开口:中文标点之后的停顿(一句话里换气的地方)。 */
export const TYPE_PUNCT_MS = 260
/** 开口:气泡出现到第一个字出来之间(样例的数,等气泡弹出来再说话)。 */
export const TYPE_LEAD_MS = 260
/** 开口:字出完之后停留多久(声波变灰)。 */
export const SPEAK_HOLD_MS = 1_500
/** 嘀咕:台词表没指定时,停留时长在这两个数之间随机。 */
export const MUTTER_HOLD_MIN_MS = 1_400
export const MUTTER_HOLD_MAX_MS = 1_800

/** 气泡左右夹在栖位内侧多少。与 tokens.css `--pet-bubble-inset` 同一个数(JS 要算,读不了 var)。 */
export const BUBBLE_INSET_PX = 12
/** 气泡底边离宠物头顶多远(尾巴在这段空里)。与 `--pet-bubble-gap` 同一个数。 */
export const BUBBLE_GAP_PX = 8
/** 尾巴离气泡左右边缘至少多远(圆角里放不下尾巴)。 */
export const BUBBLE_TAIL_EDGE_PX = 18

const PAUSE_AFTER = /[，。？！、；：…,.?!;:]/

/** 打出 `prev` 这个字之后,等多久出下一个。 */
export function typeDelayAfter(prev: string | undefined): number {
  return prev !== undefined && PAUSE_AFTER.test(prev) ? TYPE_PUNCT_MS : TYPE_CHAR_MS
}

/**
 * 会出声的一句,等声音开始最多等多久(合成没命中缓存时要一两秒;再久就当 `voiced` 丢了,照
 * 固定字速打,别让字卡在空气泡上)。
 */
export const VOICE_WAIT_MS = 6_000

/**
 * 按声音长度出字的**字速倍数**:固定字速打完这句要的时长(每个字后的停顿,标点照样停得长些,
 * 外加最后一个字自己的一拍)摊到 `durationMs` 上。夹在 0.25–6 之间:读错的长度不会让字一闪
 * 而过或爬好几分钟 —— 声音说完的 `hushed` 反正会把剩下的字一次补齐。
 */
export function voicePace(glyphs: readonly string[], durationMs: number): number {
  if (glyphs.length === 0 || !(durationMs > 0)) return 1
  let total = TYPE_CHAR_MS
  for (let i = 0; i < glyphs.length - 1; i += 1) total += typeDelayAfter(glyphs[i])
  return Math.min(6, Math.max(0.25, durationMs / total))
}

/** 按字切(不按 UTF-16 码元 —— emoji 不许被劈成两半)。 */
export function splitGlyphs(text: string): string[] {
  return Array.from(text)
}

/** 嘀咕的停留:台词表指定了就用它,否则在 1.4–1.8s 之间取一个。`random` 可注入以便测试。 */
export function mutterHoldMs(specified: number | undefined, random: () => number = Math.random): number {
  if (specified !== undefined) return specified
  return Math.round(MUTTER_HOLD_MIN_MS + (MUTTER_HOLD_MAX_MS - MUTTER_HOLD_MIN_MS) * random())
}

export interface BubbleGeometryInput {
  /** 栖位宽。 */
  perchW: number
  /** 宠物头顶那一点(相对栖位左上角)。 */
  anchorX: number
  anchorY: number
  bubbleW: number
  bubbleH: number
}

export interface BubbleGeometry {
  left: number
  top: number
  /** 尾巴尖的横坐标(相对气泡左边)。 */
  tailX: number
}

/**
 * §7.4 定位列:尾巴指向头顶;左右夹在栖位内侧 12px;上边不出栖位,放不下时贴栖位顶。
 * 气泡比栖位还宽(不该发生 —— CSS 已经把最大宽钳在栖位内)时贴左边的内侧线。
 */
export function placeBubble(input: BubbleGeometryInput): BubbleGeometry {
  const { perchW, anchorX, anchorY, bubbleW, bubbleH } = input
  const maxLeft = Math.max(BUBBLE_INSET_PX, perchW - bubbleW - BUBBLE_INSET_PX)
  const left = clamp(anchorX - bubbleW / 2, BUBBLE_INSET_PX, maxLeft)
  const top = Math.max(0, anchorY - bubbleH - BUBBLE_GAP_PX)
  const tailX = clamp(anchorX - left, BUBBLE_TAIL_EDGE_PX, Math.max(BUBBLE_TAIL_EDGE_PX, bubbleW - BUBBLE_TAIL_EDGE_PX))
  return { left, top, tailX }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
