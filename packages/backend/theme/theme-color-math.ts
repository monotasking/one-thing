// 纯颜色数学(从 `theme-role-mapping.ts` 拆出,拆分批 1,D226):解析 CSS 颜色、叠色、亮度与对比度、混色、
// 按对比度挑可读色。没有任何主题知识,角色推导(`theme-role-mapping.ts`)与主题解析(`theme-resolver.ts` 一家)都在用。
import { converter } from 'culori'
import type { ThemeColorScheme } from './theme-role-mapping.js'

export interface ParsedColor {
  red: number
  green: number
  blue: number
  alpha: number
}

export const toOklch = converter('oklch')

export function firstDefinedColor(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find(color => typeof color === 'string' && color.length > 0)
}

export function parseCssColor(value: string | undefined): ParsedColor | null {
  if (!value) return null

  const trimmed = value.trim()
  if (trimmed === 'transparent') {
    return { red: 0, green: 0, blue: 0, alpha: 0 }
  }

  const shortHexMatch = /^#([0-9a-f]{3})$/i.exec(trimmed)
  if (shortHexMatch) {
    const [, hex] = shortHexMatch
    return {
      red: Number.parseInt(hex[0] + hex[0], 16),
      green: Number.parseInt(hex[1] + hex[1], 16),
      blue: Number.parseInt(hex[2] + hex[2], 16),
      alpha: 1,
    }
  }

  const hexMatch = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(trimmed)
  if (hexMatch) {
    const [, hex, alphaHex] = hexMatch
    const numericValue = Number.parseInt(hex, 16)
    return {
      red: (numericValue >> 16) & 255,
      green: (numericValue >> 8) & 255,
      blue: numericValue & 255,
      alpha: alphaHex ? Number.parseInt(alphaHex, 16) / 255 : 1,
    }
  }

  const rgbMatch = /^rgba?\((.+)\)$/i.exec(trimmed)
  if (rgbMatch) {
    const body = rgbMatch[1].replace(/\s*\/\s*/g, ', ')
    const parts = body.includes(',')
      ? body.split(',').map(part => part.trim())
      : body.split(/\s+/)
    if (parts.length < 3) return null

    return {
      red: Number.parseFloat(parts[0]),
      green: Number.parseFloat(parts[1]),
      blue: Number.parseFloat(parts[2]),
      alpha: parts[3] === undefined ? 1 : Number.parseFloat(parts[3]),
    }
  }

  return null
}

export function compositeColor(foreground: ParsedColor, background: ParsedColor): ParsedColor {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha)
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 }

  return {
    red: ((foreground.red * foreground.alpha) + (background.red * background.alpha * (1 - foreground.alpha))) / alpha,
    green: ((foreground.green * foreground.alpha) + (background.green * background.alpha * (1 - foreground.alpha))) / alpha,
    blue: ((foreground.blue * foreground.alpha) + (background.blue * background.alpha * (1 - foreground.alpha))) / alpha,
    alpha,
  }
}

export function resolveColorOverBackground(value: string | undefined, background: string | undefined): ParsedColor | null {
  const color = parseCssColor(value)
  const backgroundColor = parseCssColor(background)
  if (!color || !backgroundColor) return null
  return color.alpha < 1 ? compositeColor(color, backgroundColor) : color
}

export function colorToRgbString(color: ParsedColor | null): string | undefined {
  if (!color) return undefined
  return `rgb(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)})`
}

export function colorToHex(color: ParsedColor): string {
  return `#${[color.red, color.green, color.blue]
    .map(channel => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
}

export function relativeLuminance(color: ParsedColor): number {
  const [red, green, blue] = [color.red, color.green, color.blue].map(channel => {
    const normalized = channel / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })

  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

export function contrastRatio(foreground: ParsedColor, background: ParsedColor): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

export function colorDistance(first: ParsedColor, second: ParsedColor): number {
  return Math.abs(first.red - second.red)
    + Math.abs(first.green - second.green)
    + Math.abs(first.blue - second.blue)
}

export function colorMeetsContrast(
  foreground: string | undefined,
  background: string | undefined,
  minContrast: number
): foreground is string {
  const foregroundColor = resolveColorOverBackground(foreground, background)
  const backgroundColor = parseCssColor(background)
  return Boolean(foregroundColor && backgroundColor && contrastRatio(foregroundColor, backgroundColor) >= minContrast)
}

export function readableAgainst(
  background: string | undefined,
  candidates: Array<string | undefined>,
  fallback: string | undefined,
  minimumContrast: number
): string | undefined {
  const backgroundColor = parseCssColor(background)
  if (!backgroundColor) {
    return candidates.find(Boolean) || fallback
  }

  let bestValue: string | undefined
  let bestContrast = -1

  for (const candidate of candidates) {
    const candidateColor = resolveColorOverBackground(candidate, background)
    if (!candidate || !candidateColor) continue

    const contrast = contrastRatio(candidateColor, backgroundColor)
    if (contrast >= minimumContrast) return candidate
    if (contrast > bestContrast) {
      bestContrast = contrast
      bestValue = candidate
    }
  }

  return bestValue || fallback || candidates.find(Boolean)
}

export function mixCssColors(
  foreground: string | undefined,
  background: string | undefined,
  foregroundWeight: number
): string | undefined {
  const foregroundColor = parseCssColor(foreground)
  const backgroundColor = parseCssColor(background)
  if (!foregroundColor || !backgroundColor) return undefined

  const weight = Math.min(1, Math.max(0, foregroundWeight))
  return colorToHex({
    red: (foregroundColor.red * weight) + (backgroundColor.red * (1 - weight)),
    green: (foregroundColor.green * weight) + (backgroundColor.green * (1 - weight)),
    blue: (foregroundColor.blue * weight) + (backgroundColor.blue * (1 - weight)),
    alpha: 1,
  })
}

export function guaranteeMinMixOpacity(
  baseColor: string | undefined,
  backgroundColor: string | undefined,
  currentPercent: number,
  minPerceivedDelta = 0.02
): number {
  if (!baseColor || !backgroundColor) return currentPercent

  const baseOklch = toOklch(baseColor)
  const backgroundOklch = toOklch(backgroundColor)
  if (
    !baseOklch
    || !backgroundOklch
    || !isFiniteNumber(baseOklch.l)
    || !isFiniteNumber(backgroundOklch.l)
  ) {
    return currentPercent
  }

  const current = Math.min(100, Math.max(0, currentPercent))
  const fullDelta = Math.abs(baseOklch.l - backgroundOklch.l)
  if (fullDelta === 0 || !Number.isFinite(fullDelta)) return current
  if (fullDelta * (current / 100) >= minPerceivedDelta) return current

  return Math.min(100, Math.max(current, (minPerceivedDelta / fullDelta) * 100))
}

export function rgbaFromCssColor(value: string | undefined, alpha: number, fallbackRgb = '67, 133, 190'): string {
  const color = parseCssColor(value)
  if (!color) return `rgba(${fallbackRgb}, ${alpha})`
  return `rgba(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)}, ${alpha})`
}

export function neutralOverlay(colorScheme: ThemeColorScheme, alpha: number): string {
  return colorScheme === 'dark'
    ? `rgba(255, 255, 255, ${alpha})`
    : `rgba(0, 0, 0, ${alpha})`
}

export function readableColor(
  background: string,
  candidates: Array<string | undefined>,
  fallback: string,
  minContrast = 4.5,
  preferredWeight = 0.72
): string {
  for (const candidate of candidates) {
    if (colorMeetsContrast(candidate, background, minContrast)) return candidate
  }

  const base = firstDefinedColor(...candidates) || fallback
  for (let weight = preferredWeight; weight <= 1; weight += 0.04) {
    const mixed = mixCssColors(base, background, weight)
    if (colorMeetsContrast(mixed, background, minContrast)) return mixed
  }

  return fallback
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
