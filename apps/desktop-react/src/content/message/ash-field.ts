import type { MotionTier } from '../../reading/types'

/** 一块已经排好的字面,坐标相对气泡左上角。 */
export interface AshBox {
  x: number
  y: number
  width: number
  height: number
}

/** 一粒灰。出生点在字面上,之后只由 `place` 往上送。 */
export interface AshMote {
  x: number
  y: number
  /** 上升路程占 rise 的比例,0.55–1。 */
  lift: number
  sway: number
  phase: number
  radius: number
  /** 0–1,挑烟色还是灰芯。 */
  tone: number
  /** 0–1,晚一点才开始动,让灰不是同一帧炸开。 */
  born: number
  alpha: number
}

export interface AshPlace {
  x: number
  y: number
  alpha: number
  radius: number
}

export interface AshTones {
  text: string
  ash: string
  smoke: string
}

/**
 * 把一块已经画在屏上的气泡拆成灰。
 *
 * 坐标、寿命、要不要撒粒子,都是这只类的静态方法。组件只负责挂画布和计时,
 * 不另写一堆模块级函数。
 */
export class AshField {
  static readonly moteCap = 96
  static readonly moteFloor = 18
  static readonly areaPerMote = 42
  /**
   * `--ash-rise` 读不到时的上升距离,与 `--sp-8` 同值。
   * 浏览器里以计算后的自定义属性为准,这一格只给还没排版的环境。
   */
  static readonly fallbackRise = 48
  static readonly fallbackWidth = 160
  static readonly fallbackHeight = 36

  /** 减弱动态,或者动效档「无」:不撒粒子,只淡出。 */
  static skipsParticles(tier: MotionTier, reducedMotion: boolean): boolean {
    return reducedMotion || tier === 'none'
  }

  /**
   * 气泡里已经排出来的字块。没有字、也量不到盒子时给一块兜底,
   * 这样未排版的环境里灰场仍然有东西可走。
   */
  static localBoxes(host: HTMLElement): AshBox[] {
    const hostRect = host.getBoundingClientRect()
    const found: AshBox[] = []
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const text = node.textContent ?? ''
      if (text.trim()) {
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width <= 0 || rect.height <= 0) continue
          found.push({
            x: rect.left - hostRect.left,
            y: rect.top - hostRect.top,
            width: rect.width,
            height: rect.height,
          })
        }
      }
      node = walker.nextNode()
    }
    if (found.length > 0) return found
    if (hostRect.width > 0 && hostRect.height > 0) {
      return [{ x: 0, y: 0, width: hostRect.width, height: hostRect.height }]
    }
    return [{ x: 0, y: 0, width: AshField.fallbackWidth, height: AshField.fallbackHeight }]
  }

  /** 按字块面积撒灰。空列表就是不撒。同一组盒子每次撒出来的位置相同。 */
  static motes(boxes: readonly AshBox[]): AshMote[] {
    if (boxes.length === 0) return []
    const area = boxes.reduce((sum, box) => sum + Math.max(0, box.width) * Math.max(0, box.height), 0)
    const count = Math.min(
      AshField.moteCap,
      Math.max(AshField.moteFloor, Math.round(area / AshField.areaPerMote)),
    )
    let seed = AshField.seedOf(boxes)
    const out: AshMote[] = []
    for (let i = 0; i < count; i++) {
      const boxRoll = AshField.next(seed)
      seed = boxRoll.seed
      const box = boxes[Math.floor(boxRoll.value * boxes.length) % boxes.length]!
      const xRoll = AshField.next(seed)
      seed = xRoll.seed
      const yRoll = AshField.next(seed)
      seed = yRoll.seed
      const liftRoll = AshField.next(seed)
      seed = liftRoll.seed
      const swayRoll = AshField.next(seed)
      seed = swayRoll.seed
      const phaseRoll = AshField.next(seed)
      seed = phaseRoll.seed
      const radiusRoll = AshField.next(seed)
      seed = radiusRoll.seed
      const toneRoll = AshField.next(seed)
      seed = toneRoll.seed
      const bornRoll = AshField.next(seed)
      seed = bornRoll.seed
      out.push({
        x: box.x + xRoll.value * box.width,
        y: box.y + yRoll.value * box.height,
        lift: 0.55 + liftRoll.value * 0.45,
        sway: (swayRoll.value - 0.5) * 8,
        phase: phaseRoll.value * Math.PI * 2,
        radius: 0.7 + radiusRoll.value * 1.5,
        tone: toneRoll.value,
        born: bornRoll.value * 0.18,
        alpha: 0.42 + toneRoll.value * 0.4,
      })
    }
    return out
  }

  /**
   * `t` 从 0 走到 1。y 变小(往上),透明度走到 0。
   * `rise` 是这段上升的全程,单位与盒子坐标相同。
   */
  static place(mote: AshMote, t: number, rise: number): AshPlace {
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t
    const span = 1 - mote.born
    const life = span <= 0 ? 1 : Math.max(0, (clamped - mote.born) / span)
    const eased = 1 - (1 - life) * (1 - life)
    const appear = Math.min(1, life / 0.12)
    const fade = (1 - life) ** 1.35
    return {
      x: mote.x + Math.sin(mote.phase + life * Math.PI * 2) * mote.sway * life,
      y: mote.y - mote.lift * rise * eased,
      alpha: mote.alpha * appear * fade,
      radius: Math.max(0, mote.radius * (1 - life * 0.4)),
    }
  }

  /** 上升距离。读气泡上的 `--ash-rise`(计算后是像素)。 */
  static risePx(host: HTMLElement): number {
    const raw = getComputedStyle(host).getPropertyValue('--ash-rise')
    const n = Number.parseFloat(raw)
    return Number.isFinite(n) && n > 0 ? n : AshField.fallbackRise
  }

  /** 字色、灰、烟。自定义属性挂进树里再读,才能拿到算完的 rgb。 */
  static readTones(host: HTMLElement): AshTones {
    const text = getComputedStyle(host).color
    const ash = AshField.resolved(host, '--text-4', text)
    const smoke = AshField.resolved(host, '--text-3', ash)
    return { text, ash, smoke }
  }

  static paint(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    host: HTMLElement,
    motes: readonly AshMote[],
    t: number,
    rise: number,
    tones: AshTones,
  ): void {
    const rect = host.getBoundingClientRect()
    const width = Math.max(rect.width, 1)
    const height = Math.max(rect.height + rise, 1)
    const dpr = window.devicePixelRatio || 1
    canvas.style.left = `${rect.left}px`
    canvas.style.top = `${rect.top - rise}px`
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const bitmapWidth = Math.max(1, Math.round(width * dpr))
    const bitmapHeight = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
      canvas.width = bitmapWidth
      canvas.height = bitmapHeight
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const text = AshField.parseRgb(tones.text)
    const ash = AshField.parseRgb(tones.ash)
    const smoke = AshField.parseRgb(tones.smoke)
    const mixT = Math.min(1, Math.max(0, t) * 1.4)
    for (const mote of motes) {
      const placed = AshField.place(mote, t, rise)
      if (placed.alpha <= 0.01 || placed.radius <= 0) continue
      const y = placed.y + rise
      const core = text && ash ? AshField.mix(text, ash, mixT) : tones.ash || tones.text
      const puff = smoke && ash ? AshField.mix(smoke, ash, mixT) : core
      ctx.beginPath()
      ctx.fillStyle = puff
      ctx.globalAlpha = placed.alpha * (mote.tone > 0.72 ? 0.34 : 0.2)
      ctx.arc(placed.x, y, placed.radius * (mote.tone > 0.72 ? 4.2 : 3.1), 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.fillStyle = core
      ctx.globalAlpha = placed.alpha
      ctx.arc(placed.x, y, placed.radius, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  static parseRgb(input: string): [number, number, number] | null {
    const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(input)
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
    const hex = /^#([\da-f]{6})$/i.exec(input.trim())
    if (!hex?.[1]) return null
    const n = Number.parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }

  static mix(a: [number, number, number], b: [number, number, number], t: number): string {
    const u = t < 0 ? 0 : t > 1 ? 1 : t
    const red = Math.round(a[0] + (b[0] - a[0]) * u)
    const green = Math.round(a[1] + (b[1] - a[1]) * u)
    const blue = Math.round(a[2] + (b[2] - a[2]) * u)
    return `rgb(${red}, ${green}, ${blue})`
  }

  private static resolved(host: HTMLElement, name: string, fallback: string): string {
    const probe = document.createElement('span')
    probe.style.color = `var(${name})`
    probe.style.position = 'absolute'
    probe.style.inlineSize = '0'
    probe.style.blockSize = '0'
    host.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    if (!color || color === 'rgba(0, 0, 0, 0)') return fallback
    return color
  }

  private static seedOf(boxes: readonly AshBox[]): number {
    let seed = 1
    for (const box of boxes) {
      seed = (seed + Math.round(box.x + box.y + box.width + box.height)) % 4294967296
    }
    return seed || 1
  }

  private static next(seed: number): { value: number; seed: number } {
    const next = (seed * 1664525 + 1013904223) % 4294967296
    return { value: next / 4294967296, seed: next }
  }
}
