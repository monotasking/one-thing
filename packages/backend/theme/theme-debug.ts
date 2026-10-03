import { converter } from 'culori'
import type { ResolvedUIStyle } from './resolver.js'
import type { SemanticUIToken } from './types.js'

const toOklch = converter('oklch')

export interface ThemeDebugData {
  themeId: string
  mode: 'dark' | 'light'
  resolvedUI: Record<SemanticUIToken, ResolvedUIStyle>
}

const ELEVATION_PAIRS: Array<{
  from: SemanticUIToken
  to: SemanticUIToken
  min: number
  label: string
}> = [
  { from: 'ui.surface.chat',      to: 'ui.surface.panel',      min: 0.04, label: 'chat → panel' },
  { from: 'ui.surface.chat',      to: 'ui.surface.codeBlock',  min: 0.04, label: 'chat → codeBlock' },
  { from: 'ui.surface.codeBlock', to: 'ui.surface.codeHeader', min: 0.05, label: 'codeBlock → codeHeader' },
  { from: 'ui.surface.panel',     to: 'ui.surface.elevated',   min: 0.03, label: 'panel → elevated' },
  { from: 'ui.surface.elevated',  to: 'ui.surface.floating',   min: 0.03, label: 'elevated → floating' },
  { from: 'ui.surface.chat',      to: 'ui.surface.menu',       min: 0.04, label: 'chat → menu' },
]

function getL(color: string | undefined): number | undefined {
  if (!color) return undefined
  const c = toOklch(color)
  if (!c || typeof c.l !== 'number' || !isFinite(c.l)) return undefined
  return Math.round(c.l * 1000) / 1000
}

export function buildThemeDebugReport(data: ThemeDebugData): object {
  const { themeId, mode, resolvedUI } = data
  const direction = mode === 'dark' ? 1 : -1

  // surfaces: bg-having tokens with OKLCH lightness
  const surfaces: Record<string, object> = {}
  for (const [token, style] of Object.entries(resolvedUI) as [SemanticUIToken, ResolvedUIStyle][]) {
    if (!style.bg) continue
    const entry: Record<string, unknown> = { bg: style.bg }
    const l = getL(style.bg)
    if (l !== undefined) entry.l = l
    surfaces[token] = entry
  }

  // elevation audit: key surface pairs with ΔL and pass/fail
  const elevationAudit = ELEVATION_PAIRS.map(({ from, to, min, label }) => {
    const fromL = getL(resolvedUI[from]?.bg)
    const toL = getL(resolvedUI[to]?.bg)
    const deltaL = fromL !== undefined && toL !== undefined
      ? Math.round(Math.abs(toL - fromL) * 1000) / 1000
      : null
    const ok = deltaL !== null
      ? direction * ((toL ?? 0) - (fromL ?? 0)) >= min
      : null

    const entry: Record<string, unknown> = {
      pair: label,
      from: resolvedUI[from]?.bg ?? null,
      to: resolvedUI[to]?.bg ?? null,
      ΔL: deltaL,
      ok,
      minRequired: min,
    }
    if (ok === false) entry['⚠'] = `ΔL ${deltaL} < required ${min}`
    return entry
  })

  // allTokens: complete resolved values, no computed fields
  const allTokens: Record<string, object> = {}
  for (const [token, style] of Object.entries(resolvedUI)) {
    const entry: Record<string, string> = {}
    if (style.fg) entry.fg = style.fg
    if (style.bg) entry.bg = style.bg
    if (style.border) entry.border = style.border
    if (style.ring) entry.ring = style.ring
    if (style.shadow) entry.shadow = style.shadow
    allTokens[token] = entry
  }

  return {
    meta: {
      themeId,
      mode,
      generatedAt: new Date().toISOString(),
    },
    surfaces,
    elevationAudit,
    allTokens,
  }
}
