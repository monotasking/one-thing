// 主题的界面样式推导(从 `theme-resolver.ts` 拆出,拆分批 1,D226):表面角色、选中 / 悬停的状态覆盖、分类色、
// 输入框与用户气泡的底色,以及每个界面 token 的配方表 `fallbackUIStyle`。那张表 600 多行是一个 token 一条配方,
// 是数据表,原样留着不再往下拆(判据见 `docs/design/oversized-files-2026-10.md` §1.2 第 3 条)。
import type { SemanticUIToken, Theme } from './theme-types.js'
import type { ThemeSurfaceRoles } from './theme-role-mapping.js'
import { type CategoryColor, deriveCategoryColors, deriveStateOverlays, deriveSurfaceRoles, guaranteeMinAbsDeltaL, guaranteeMinDeltaL } from './theme-role-mapping.js'
import { colorToRgbString, contrastRatio, mixCssColors, parseCssColor, readableAgainst, resolveColorOverBackground, rgbaFromCssColor } from './theme-color-math.js'
import { getResolvedThemeValue, resolveTheme, resolveThemeDefinitionColors } from './theme-resolver.js'
import { NEUTRAL_COLOR_DEFAULTS, type ResolvedUIStyle, SEMANTIC_UI_TOKENS } from './theme-semantic-tokens.js'

export function deriveLightSurface(base: string, primaryText: string | undefined, strength: number): string {
  return mixCssColors(primaryText, base, strength) || base
}

function contrastForColor(
  foreground: string | undefined,
  background: string | undefined
): number {
  const foregroundColor = resolveColorOverBackground(foreground, background)
  const backgroundColor = parseCssColor(background)
  if (!foregroundColor || !backgroundColor) return -1
  return contrastRatio(foregroundColor, backgroundColor)
}

function onSolidColor(
  resolvedTheme: Record<string, string>,
  background: string | undefined,
  ...fallbackPaths: string[]
): string | undefined {
  const fallback = getResolvedThemeValue(resolvedTheme, ...fallbackPaths)
  const candidates = [
    getResolvedThemeValue(resolvedTheme, 'neutral.basicWhite') || NEUTRAL_COLOR_DEFAULTS.basicWhite,
    getResolvedThemeValue(resolvedTheme, 'neutral.basicBlack') || NEUTRAL_COLOR_DEFAULTS.basicBlack,
  ]
    .map(color => ({ color, contrast: contrastForColor(color, background) }))
    .sort((a, b) => b.contrast - a.contrast)

  const readable = candidates.find(candidate => candidate.contrast >= 4.5)
  return readable?.color || fallback
}

/**
 * Minimum OKLCH lightness separation between a surface and the chat canvas it
 * sits on. Shared with the guardrail tests so resolver policy and test
 * expectations cannot drift apart.
 */
export const SURFACE_GUARD_MIN_DELTA_L = {
  input: 0.03,
  inputFocus: 0.05,
  userBubble: 0.03,
  systemMessage: 0.03,
} as const

const SURFACE_ROLE_STASH_KEYS: Record<keyof ThemeSurfaceRoles, string> = {
  appBg: 'role.surface.appBg',
  sidebarBg: 'role.surface.sidebarBg',
  chatBg: 'role.surface.chatBg',
  panelBg: 'role.surface.panelBg',
  tabBarBg: 'role.surface.tabBarBg',
  elevatedBg: 'role.surface.elevatedBg',
  floatingBg: 'role.surface.floatingBg',
}

function readStashedSurfaceRoles(
  resolvedTheme: Record<string, string>
): ThemeSurfaceRoles | null {
  const roles: Partial<Record<keyof ThemeSurfaceRoles, string>> = {}
  for (const [role, stashKey] of Object.entries(SURFACE_ROLE_STASH_KEYS) as Array<[keyof ThemeSurfaceRoles, string]>) {
    const value = resolvedTheme[stashKey]
    if (!value) return null
    roles[role] = value
  }
  return roles as ThemeSurfaceRoles
}

export function deriveSemanticSurfaceRoles(
  resolvedTheme: Record<string, string>,
  mode: 'dark' | 'light'
): ThemeSurfaceRoles {
  // Once the neutral ramp has been anchored onto the derived roles, re-deriving
  // from those anchored values would feed the promoted surfaces back through
  // the promotion logic and shift the whole ladder up a step. Return the
  // stashed roles instead so derivation is idempotent.
  const stashed = readStashedSurfaceRoles(resolvedTheme)
  if (stashed) return stashed

  const get = (...paths: string[]) => getResolvedThemeValue(resolvedTheme, ...paths)

  return deriveSurfaceRoles({
    colorScheme: mode,
    app: get('neutral.pageBackground', 'bg.app'),
    // Sidebar has its own visual role, so keep explicit sidebar before neutral fallbacks.
    sidebar: get('bg.sidebar', 'neutral.baseFill', 'neutral.pageBackground'),
    chat: get('neutral.baseBackground', 'bg.chat'),
    panel: get('neutral.baseFill', 'bg.panel'),
    elevated: get('neutral.darkFill', 'bg.elevated'),
    floating: get('neutral.darkerFill', 'bg.floating'),
    primaryText: get('neutral.primaryText', 'text.primary'),
  })
}

function selectedStateBorderColor(
  resolvedTheme: Record<string, string>,
  mode: 'dark' | 'light'
): string | undefined {
  return mode === 'dark'
    ? getResolvedThemeValue(
      resolvedTheme,
      'primaryHover',
      'primary',
      'accentMain',
      'accent',
      'primaryBorder',
      'border.accent',
    )
    : getResolvedThemeValue(
      resolvedTheme,
      'primaryBorder',
      'primary',
      'accentMain',
      'accent',
      'border.accent',
    )
}

function deriveStateOverlaysForSurface(
  resolvedTheme: Record<string, string>,
  surface: string | undefined,
  mode: 'dark' | 'light'
) {
  return deriveStateOverlays(surface, selectedStateBorderColor(resolvedTheme, mode), mode)
}

function categoryUIStyle(token: SemanticUIToken, categoryColors: CategoryColor[]): ResolvedUIStyle | undefined {
  const match = /^ui\.category\.(\d+)\.(icon|badgeBg|badgeText)$/.exec(token)
  if (!match) return undefined

  const category = categoryColors[Number(match[1]) - 1]
  if (!category) return {}

  switch (match[2]) {
    case 'icon':
      return { fg: category.icon }
    case 'badgeBg':
      return { bg: category.badgeBg }
    case 'badgeText':
      return { fg: category.badgeText }
    default:
      return undefined
  }
}

function firstSolidColor(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find(candidate => candidate !== undefined && parseCssColor(candidate) !== null)
}

/**
 * Composer/input surface visibly raised from the chat surface. Raw theme fills
 * can land exactly on the derived chat surface (the surface roles may promote
 * chat above bg.chat), so every token that paints the input must share this
 * guarded value or --bg-input consumers drift apart.
 */
function resolveComposerInputBg(
  resolvedTheme: Record<string, string>,
  surfaceRoles: ThemeSurfaceRoles,
  mode: 'dark' | 'light'
): string {
  // Always raised in the mode's direction (lighter in dark, darker in light):
  // the composer paints as a card on the chat canvas next to a darker sidebar,
  // so honoring a theme's recessed bg.input reads as a hole, not an input.
  const isDark = mode === 'dark'
  const rawInputBg = getResolvedThemeValue(resolvedTheme, 'neutral.lighterFill', 'bg.input')
    || surfaceRoles.panelBg
  const guardedRaw = guaranteeMinDeltaL(surfaceRoles.chatBg, rawInputBg, SURFACE_GUARD_MIN_DELTA_L.input, isDark)
  if (guardedRaw === rawInputBg) return rawInputBg

  // The raw input color is unusable (recessed or colliding). Don't lightness-
  // shift it — that keeps its stale chroma and reads as an off-family grey
  // slab on tinted canvases. Reuse the derived panel surface instead: it is
  // already in the canvas's tonal family and guaranteed distinct from chat.
  const panelBg = surfaceRoles.panelBg
  return guaranteeMinDeltaL(surfaceRoles.chatBg, panelBg, SURFACE_GUARD_MIN_DELTA_L.input, isDark)
    ?? guardedRaw
    ?? panelBg
}

/**
 * Rewrites the neutral fill ramp onto the derived surface roles so every
 * consumer — UI tokens reading `neutral.*`, the emitted `--color-neutral-*`
 * CSS variables, highlight fallbacks — sees one consistent surface system.
 *
 * Why: `deriveSurfaceRoles` may promote surfaces away from the raw theme
 * values (dark mode prefers the panel color for the chat canvas). Tokens that
 * keep reading raw `neutral.*`/`bg.*` values then collide with the promoted
 * surfaces — the class of bug where the composer sat exactly on the chat
 * background. Anchoring once here removes the need for per-token collision
 * guards on every neutral consumer.
 *
 * Also stashes the roles onto the record so later derivations return the same
 * values (see deriveSemanticSurfaceRoles).
 */
function anchorNeutralFillsToSurfaceRoles(
  resolvedTheme: Record<string, string>,
  surfaceRoles: ThemeSurfaceRoles,
  mode: 'dark' | 'light'
): void {
  // Compute before overwriting neutral.lighterFill, which it reads.
  const inputBg = resolveComposerInputBg(resolvedTheme, surfaceRoles, mode)

  for (const [role, stashKey] of Object.entries(SURFACE_ROLE_STASH_KEYS) as Array<[keyof ThemeSurfaceRoles, string]>) {
    resolvedTheme[stashKey] = surfaceRoles[role]
  }

  resolvedTheme['neutral.pageBackground'] = surfaceRoles.appBg
  resolvedTheme['neutral.baseBackground'] = surfaceRoles.chatBg
  resolvedTheme['neutral.extraLightFill'] = surfaceRoles.appBg
  resolvedTheme['neutral.lightFill'] = surfaceRoles.chatBg
  resolvedTheme['neutral.baseFill'] = surfaceRoles.panelBg
  resolvedTheme['neutral.darkFill'] = surfaceRoles.elevatedBg
  resolvedTheme['neutral.darkerFill'] = surfaceRoles.floatingBg
  resolvedTheme['neutral.lighterFill'] = inputBg
}

/**
 * User-bubble surface that is always a solid, parseable color visibly raised
 * from the chat surface. `bg.message.user` may be a gradient, which components
 * cannot feed into color-mix(), so the solid variant must never inherit it.
 */
function resolveUserBubbleSolidBg(
  resolvedTheme: Record<string, string>,
  surfaceRoles: ThemeSurfaceRoles,
  mode: 'dark' | 'light'
): string {
  const rawSolid = firstSolidColor(
    getResolvedThemeValue(resolvedTheme, 'bg.message.userSolid'),
    getResolvedThemeValue(resolvedTheme, 'bg.message.user'),
  ) || surfaceRoles.elevatedBg

  return guaranteeMinAbsDeltaL(surfaceRoles.chatBg, rawSolid, SURFACE_GUARD_MIN_DELTA_L.userBubble, mode === 'dark')
    ?? rawSolid
}

function fallbackUIStyle(
  resolvedTheme: Record<string, string>,
  token: SemanticUIToken,
  surfaceRoles: ThemeSurfaceRoles,
  mode: 'dark' | 'light',
  categoryColors: CategoryColor[] = []
): ResolvedUIStyle {
  const categoryStyle = categoryUIStyle(token, categoryColors)
  if (categoryStyle) return categoryStyle

  const get = (...paths: string[]) => getResolvedThemeValue(resolvedTheme, ...paths)

  switch (token) {
    case 'ui.accent.primary':
      return { fg: get('primary', 'accentMain', 'accent') }
    case 'ui.accent.subtle':
      return { fg: get('primaryHover', 'accentSub', 'accentLight', 'primaryText', 'primary', 'accent') }
    case 'ui.surface.app':
      return { bg: surfaceRoles.appBg }
    case 'ui.surface.sidebar':
      return { bg: surfaceRoles.sidebarBg }
    case 'ui.surface.chat':
      return { bg: surfaceRoles.chatBg }
    case 'ui.surface.panel':
      return { bg: surfaceRoles.panelBg }
    case 'ui.surface.elevated':
      return {
        bg: surfaceRoles.elevatedBg,
        shadow: get('shadow.elevated', 'shadow.md', 'shadow.sm'),
      }
    case 'ui.surface.floating':
      return {
        bg: surfaceRoles.floatingBg,
        shadow: get('shadow.floating', 'shadow.lg', 'shadow.md'),
      }
    case 'ui.surface.overlay':
      return { bg: get('neutral.overlayBackground', 'bg.modalOverlay', 'effects.overlayActive') }
    case 'ui.surface.menu':
      return { bg: get('bg.menu', 'neutral.darkerFill') || surfaceRoles.floatingBg }
    case 'ui.surface.menuHover':
      return {
        bg: mode === 'light'
          ? rgbaFromCssColor(get('primary', 'accentMain', 'accent'), 0.12)
          : get('neutral.darkFill', 'bg.menuItemHover', 'bg.hover'),
      }
    case 'ui.surface.input':
      return {
        bg: resolveComposerInputBg(resolvedTheme, surfaceRoles, mode),
        border: get('neutral.baseBorder', 'border.input', 'border.default'),
      }
    case 'ui.surface.inputFocus': {
      const rawFocusBg = get('neutral.darkFill', 'bg.inputFocus', 'bg.input') || surfaceRoles.elevatedBg
      return {
        bg: guaranteeMinDeltaL(surfaceRoles.chatBg, rawFocusBg, SURFACE_GUARD_MIN_DELTA_L.inputFocus, mode === 'dark') ?? rawFocusBg,
        border: get('primaryBorder', 'primary', 'border.inputFocus', 'border.accent', 'accent'),
        ring: get('primaryBorder', 'primary', 'border.inputFocus', 'border.accent', 'accent'),
      }
    }
    case 'ui.surface.codeInline':
      return {
        bg: get('neutral.darkFill', 'bg.code.inline') || (surfaceRoles.elevatedBg),
        fg: get('neutral.primaryText', 'text.code.inline', 'text.primary'),
        border: get('neutral.baseBorder', 'border.code', 'border.subtle'),
      }
    case 'ui.surface.codeBlock': {
      const rawBlockBg = get('neutral.baseFill', 'bg.code.block') || surfaceRoles.panelBg
      return {
        bg: mode === 'light'
          ? deriveLightSurface(surfaceRoles.chatBg, get('neutral.primaryText', 'text.primary'), 0.035)
          : (guaranteeMinDeltaL(surfaceRoles.chatBg, rawBlockBg, 0.04, true) ?? rawBlockBg),
        fg: get('neutral.primaryText', 'text.code.block', 'text.primary'),
        border: get('neutral.baseBorder', 'border.code', 'border.subtle'),
      }
    }
    case 'ui.surface.codeHeader': {
      const rawBlockBg = get('neutral.baseFill', 'bg.code.block') || surfaceRoles.panelBg
      const guardedBlockBg = guaranteeMinDeltaL(surfaceRoles.chatBg, rawBlockBg, 0.04, true) ?? rawBlockBg
      const rawHeaderBg = get('neutral.darkFill', 'bg.code.header') || surfaceRoles.elevatedBg
      return {
        bg: mode === 'light'
          ? deriveLightSurface(surfaceRoles.chatBg, get('neutral.primaryText', 'text.primary'), 0.055)
          : (guaranteeMinDeltaL(guardedBlockBg, rawHeaderBg, 0.05, true) ?? rawHeaderBg),
      }
    }
    case 'ui.surface.tooltip':
      {
        const bg = get('bg.tooltip') || surfaceRoles.floatingBg
        return {
          bg,
          fg: readableAgainst(bg, [
            get('text.tooltip'),
            get('text.btn.primary'),
            surfaceRoles.appBg,
            surfaceRoles.panelBg,
            get('neutral.primaryText', 'text.primary'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
          border: get('neutral.darkBorder', 'border.strong', 'border.default'),
          shadow: get('shadow.floating', 'shadow.lg', 'shadow.md'),
        }
      }
    case 'ui.surface.modal':
      return {
        bg: get('neutral.darkerFill', 'bg.modal') || surfaceRoles.floatingBg,
        fg: get('neutral.regularText', 'text.modalBody', 'text.primary'),
        border: get('neutral.baseBorder', 'border.default'),
        shadow: get('shadow.floating', 'shadow.xl', 'shadow.lg'),
      }
    case 'ui.surface.note':
      return {
        bg: get('color.warningBg', 'color.warningLight') || surfaceRoles.elevatedBg,
        fg: get('neutral.primaryText', 'text.primary'),
        border: get('color.warningBorder', 'color.warning', 'border.warning', 'border.subtle', 'border.default'),
      }
    case 'ui.surface.previewLight':
      return { bg: '#ffffff', fg: '#111827', border: '#e5e7eb' }
    case 'ui.surface.previewDark':
      return { bg: '#0f1117', fg: '#f9fafb', border: '#1f2937' }
    case 'ui.text.primary':
      return { fg: get('neutral.primaryText', 'text.primary') }
    case 'ui.text.secondary':
      return { fg: get('neutral.regularText', 'text.secondary', 'text.primary') }
    case 'ui.text.muted':
      return { fg: get('neutral.secondaryText', 'text.muted', 'text.secondary', 'text.primary') }
    case 'ui.text.faint':
      return { fg: get('neutral.disabledText', 'text.faint', 'text.muted', 'text.secondary') }
    case 'ui.text.inverse':
      return { fg: get('neutral.pageBackground', 'bg.app', 'text.btn.primary', 'neutral.primaryText', 'text.primary') }
    case 'ui.text.placeholder':
      return { fg: get('neutral.placeholderText', 'text.inputPlaceholder', 'text.muted') }
    case 'ui.text.disabled':
      return { fg: get('neutral.disabledText', 'text.inputDisabled', 'text.btn.disabled', 'text.faint', 'text.muted') }
    case 'ui.text.link':
      return { fg: get('color.info', 'text.link', 'primary', 'accent') }
    case 'ui.text.linkHover':
      return { fg: get('color.infoText', 'text.linkHover', 'text.link', 'color.info', 'primary', 'accent') }
    case 'ui.border.default':
      return { border: get('neutral.baseBorder', 'border.default') }
    case 'ui.border.subtle':
      return { border: get('neutral.lightBorder', 'border.subtle', 'border.default') }
    case 'ui.border.strong':
      return { border: get('neutral.darkBorder', 'border.strong', 'border.default') }
    case 'ui.border.divider':
      return { border: get('neutral.lighterBorder', 'border.divider', 'border.subtle', 'border.default') }
    case 'ui.border.focus':
      return { border: get('primaryBorder', 'primary', 'border.inputFocus', 'border.accent', 'accent'), ring: get('primaryBorder', 'primary', 'border.inputFocus', 'accent') }
    case 'ui.border.selected':
      return { border: get('primaryBorder', 'primary', 'border.accent', 'border.inputFocus', 'accent') }
    case 'ui.table.headerBg':
      {
        const rawBg = get('bg.tableHeader', 'bg.table.header', 'neutral.darkFill') || surfaceRoles.elevatedBg
        return {
          bg: guaranteeMinDeltaL(surfaceRoles.panelBg, rawBg, 0.04, mode === 'dark') ?? rawBg,
        }
      }
    case 'ui.table.rowBg':
      return { bg: 'transparent' }
    case 'ui.table.border':
      {
        const rawHeaderBg = get('bg.tableHeader', 'bg.table.header', 'neutral.darkFill') || surfaceRoles.elevatedBg
        const headerBg = guaranteeMinDeltaL(surfaceRoles.panelBg, rawHeaderBg, 0.04, mode === 'dark') ?? rawHeaderBg
        const rawBorder = get('border.table', 'neutral.baseBorder', 'border.default') || headerBg
        return {
          border: guaranteeMinDeltaL(headerBg, rawBorder, 0.06, mode === 'dark') ?? rawBorder,
        }
      }
    case 'ui.action.primary':
      {
        const bg = get('primary', 'bg.btn.primary', 'accent')
        return {
          bg,
          fg: onSolidColor(resolvedTheme, bg, 'text.btn.primary', 'neutral.pageBackground', 'bg.app'),
          border: get('primary', 'primaryBorder', 'border.accent', 'accent'),
        }
      }
    case 'ui.action.primaryHover':
      {
        const bg = get('primaryHover', 'bg.btn.primaryHover', 'accentLight', 'accentSub', 'bg.btn.primary', 'primary', 'accent')
        return {
          bg,
          fg: onSolidColor(resolvedTheme, bg, 'text.btn.primary', 'neutral.pageBackground', 'bg.app'),
          border: get('primary', 'primaryBorder', 'border.accent', 'accent'),
        }
      }
    case 'ui.action.secondary':
      return {
        bg: get('neutral.darkFill', 'bg.btn.secondary') || surfaceRoles.elevatedBg,
        fg: get('neutral.primaryText', 'text.btn.secondary', 'text.primary'),
        border: get('neutral.lightBorder', 'border.subtle', 'border.default'),
      }
    case 'ui.action.secondaryHover':
      return {
        bg: get('neutral.darkerFill', 'bg.btn.secondaryHover', 'bg.btn.secondary', 'bg.hover'),
        fg: get('neutral.primaryText', 'text.btn.secondary', 'text.primary'),
        border: get('neutral.baseBorder', 'border.default', 'border.subtle'),
      }
    case 'ui.action.ghost':
      return {
        bg: get('bg.btn.ghost') || 'transparent',
        fg: get('neutral.regularText', 'text.btn.ghost', 'text.primary'),
        border: 'transparent',
      }
    case 'ui.action.ghostHover':
      return {
        bg: get('neutral.darkFill', 'bg.btn.ghostHover', 'bg.hover'),
        fg: get('neutral.primaryText', 'text.btn.ghost', 'text.primary'),
        border: 'transparent',
      }
    case 'ui.action.danger':
      {
        const bg = get('color.danger', 'bg.btn.danger')
        return {
          bg,
          fg: onSolidColor(resolvedTheme, bg, 'text.btn.danger', 'neutral.pageBackground', 'bg.app'),
          border: get('color.dangerBorder', 'color.danger', 'border.error'),
        }
      }
    case 'ui.action.dangerHover':
      {
        const bg = get('color.dangerBgHover', 'bg.btn.dangerHover', 'bg.btn.danger', 'color.danger')
        return {
          bg,
          fg: onSolidColor(resolvedTheme, bg, 'text.btn.danger', 'neutral.pageBackground', 'bg.app'),
          border: get('color.dangerBorder', 'color.danger', 'border.error'),
        }
      }
    case 'ui.action.disabled':
      return {
        bg: get('neutral.lighterFill', 'bg.inputDisabled', 'effects.overlayDisabled', 'bg.hover'),
        fg: get('neutral.disabledText', 'text.btn.disabled', 'text.inputDisabled', 'text.faint'),
        border: get('neutral.lightBorder', 'border.subtle', 'border.default'),
      }
    case 'ui.state.hover':
      {
        const state = deriveStateOverlaysForSurface(resolvedTheme, surfaceRoles.panelBg, mode)
        return { bg: state?.hover || get('bg.hover', 'effects.overlayHover', 'neutral.darkFill') || surfaceRoles.elevatedBg }
      }
    case 'ui.state.active':
      {
        const state = deriveStateOverlaysForSurface(resolvedTheme, surfaceRoles.panelBg, mode)
        return { bg: state?.active || get('bg.active', 'effects.overlayActive', 'neutral.darkerFill') || surfaceRoles.floatingBg }
      }
    case 'ui.state.selected':
      {
        const state = deriveStateOverlaysForSurface(resolvedTheme, surfaceRoles.panelBg, mode)
        return {
          bg: state?.selected.bg || get('bg.selected', 'primaryBg'),
          fg: get('neutral.primaryText', 'text.primary'),
          border: state?.selected.border || get('primaryBorder', 'primary', 'border.accent', 'accent'),
        }
      }
    case 'ui.state.selectedHover':
      {
        const state = deriveStateOverlaysForSurface(resolvedTheme, surfaceRoles.panelBg, mode)
        return {
          bg: state?.selectedHover || get('bg.selectedHover', 'primaryBgHover', 'bg.selected', 'primaryBg'),
          fg: get('neutral.primaryText', 'text.primary'),
          border: state?.selected.border || get('primaryBorder', 'primary', 'border.accent', 'accent'),
        }
      }
    case 'ui.state.highlight':
      return { bg: get('color.warningBg', 'color.warningLight', 'bg.highlight', 'accentSub') }
    case 'ui.state.focus':
      return {
        border: get('primaryBorder', 'primary', 'border.inputFocus', 'border.accent', 'accent'),
        ring: get('primaryBorder', 'primary', 'border.inputFocus', 'border.accent', 'accent'),
      }
    case 'ui.state.disabled':
      return {
        bg: get('bg.inputDisabled', 'neutral.lighterFill', 'effects.overlayDisabled'),
        fg: get('neutral.disabledText', 'text.inputDisabled', 'text.btn.disabled', 'text.faint'),
        border: get('neutral.lightBorder', 'border.subtle', 'border.default'),
      }
    case 'ui.sidebar.surface':
      {
        const bg = surfaceRoles.sidebarBg
        return {
          bg,
          fg: readableAgainst(bg, [
            get('text.sidebar.item'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
          border: get('neutral.lighterBorder', 'border.divider', 'border.subtle', 'border.default'),
        }
      }
    case 'ui.sidebar.item':
      {
        const bg = surfaceRoles.sidebarBg
        return {
          fg: readableAgainst(bg, [
            get('text.sidebar.item'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
        }
      }
    case 'ui.sidebar.itemHover':
      {
        const bg = surfaceRoles.sidebarBg
        const state = deriveStateOverlaysForSurface(resolvedTheme, bg, mode)
        const hoverBg = state?.hover || get('bg.hover', 'effects.overlayHover')
        const hoverSurface = colorToRgbString(resolveColorOverBackground(hoverBg, bg)) || hoverBg || bg
        return {
          bg: hoverBg,
          fg: readableAgainst(hoverSurface, [
            get('text.sidebar.itemHover'),
            get('neutral.primaryText', 'text.primary'),
            get('text.sidebar.item'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
        }
      }
    case 'ui.sidebar.itemActive':
      {
        const bg = surfaceRoles.sidebarBg
        const state = deriveStateOverlaysForSurface(resolvedTheme, bg, mode)
        const activeBg = state?.selected.bg || get('bg.selected', 'primaryBg')
        const activeSurface = colorToRgbString(resolveColorOverBackground(activeBg, bg)) || activeBg || bg
        return {
          bg: activeBg,
          fg: readableAgainst(activeSurface, [
            get('neutral.primaryText', 'text.primary'),
            get('text.sidebar.itemActive'),
            get('text.sidebar.itemHover'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
          border: state?.selected.border || get('primaryBorder', 'primary', 'border.accent', 'accent'),
        }
      }
    case 'ui.sidebar.itemMuted':
      {
        const bg = surfaceRoles.sidebarBg
        return {
          fg: readableAgainst(bg, [
            get('text.sidebar.muted'),
            get('text.sidebar.count'),
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
        }
      }
    case 'ui.sidebar.header':
      {
        const bg = surfaceRoles.sidebarBg
        return {
          fg: readableAgainst(bg, [
            get('text.sidebar.title'),
            get('neutral.disabledText', 'text.faint'),
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
        }
      }
    case 'ui.sidebar.action':
      {
        const bg = surfaceRoles.sidebarBg
        return {
          fg: readableAgainst(bg, [
            get('text.sidebar.item'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
          bg: 'transparent',
        }
      }
    case 'ui.sidebar.actionHover':
      {
        const bg = surfaceRoles.sidebarBg
        const state = deriveStateOverlaysForSurface(resolvedTheme, bg, mode)
        const hoverBg = state?.hover || get('bg.hover', 'effects.overlayHover')
        const hoverSurface = colorToRgbString(resolveColorOverBackground(hoverBg, bg)) || hoverBg || bg
        return {
          bg: hoverBg,
          fg: readableAgainst(hoverSurface, [
            get('text.sidebar.itemHover'),
            get('neutral.primaryText', 'text.primary'),
            get('text.sidebar.item'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
        }
      }
    case 'ui.sidebar.border':
      return { border: get('neutral.lighterBorder', 'border.divider', 'border.subtle', 'border.default') }
    case 'ui.tabBar.surface':
      return {
        bg: surfaceRoles.tabBarBg,
        border: get('neutral.lighterBorder', 'border.divider', 'border.subtle', 'border.default'),
        shadow: 'none',
      }
    case 'ui.tabBar.divider':
      return { border: 'color-mix(in srgb, var(--ui-border-subtle-border, var(--border-subtle, var(--border))) 70%, var(--ui-text-muted-fg, var(--muted)))' }
    case 'ui.tabBar.item':
      {
        const bg = surfaceRoles.tabBarBg
        return {
          fg: readableAgainst(bg, [
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
        }
      }
    case 'ui.tabBar.itemHover':
      {
        const bg = surfaceRoles.tabBarBg
        const state = deriveStateOverlaysForSurface(resolvedTheme, bg, mode)
        const hoverBg = state?.hover || get('bg.hover', 'effects.overlayHover')
        const hoverSurface = colorToRgbString(resolveColorOverBackground(hoverBg, bg)) || hoverBg || bg
        return {
          bg: hoverBg,
          fg: readableAgainst(hoverSurface, [
            get('neutral.primaryText', 'text.primary'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
        }
      }
    case 'ui.tabBar.itemActive':
      {
        const state = deriveStateOverlaysForSurface(resolvedTheme, surfaceRoles.tabBarBg, mode)
        const activeBg = state?.selected.bg || get('bg.selected', 'primaryBg') || surfaceRoles.elevatedBg
        return {
          bg: activeBg,
          fg: readableAgainst(colorToRgbString(resolveColorOverBackground(activeBg, surfaceRoles.tabBarBg)) || activeBg, [
            get('neutral.primaryText', 'text.primary'),
            get('text.sidebar.itemActive'),
            get('neutral.regularText', 'text.secondary'),
            get('text.btn.secondary'),
            '#F9FAFB',
            '#111827',
          ], get('neutral.primaryText', 'text.primary'), 4.5),
          border: 'transparent',
        }
      }
    case 'ui.tabBar.action':
      {
        const bg = surfaceRoles.tabBarBg
        return {
          fg: readableAgainst(bg, [
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
        }
      }
    case 'ui.tabBar.actionHover':
      {
        const bg = surfaceRoles.elevatedBg
        return {
          bg,
          fg: readableAgainst(bg, [
            get('neutral.primaryText', 'text.primary'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
          border: get('neutral.lightBorder', 'border.subtle', 'border.default'),
        }
      }
    case 'ui.tabBar.danger':
      return {
        bg: get('color.dangerBg', 'color.dangerLight', 'bg.message.error'),
        fg: get('color.dangerText', 'color.danger', 'text.error'),
      }
    case 'ui.status.danger':
      return {
        fg: get('color.dangerText', 'color.danger', 'text.error'),
        bg: get('color.dangerBg', 'color.dangerLight', 'bg.message.error'),
        border: get('color.dangerBorder', 'color.danger', 'border.error'),
      }
    case 'ui.status.warning':
      return {
        fg: get('color.warningText', 'color.warning', 'text.warning'),
        bg: get('color.warningBg', 'color.warningLight'),
        border: get('color.warningBorder', 'color.warning', 'border.warning'),
      }
    case 'ui.status.success':
      return {
        fg: get('color.successText', 'color.success', 'text.success'),
        bg: get('color.successBg', 'color.successLight'),
        border: get('color.successBorder', 'color.success', 'border.success'),
      }
    case 'ui.status.info':
      return {
        fg: get('color.infoText', 'color.info', 'text.info'),
        bg: get('color.infoBg', 'color.infoLight'),
        border: get('color.infoBorder', 'color.info', 'border.accent', 'primary', 'accent'),
      }
    case 'ui.message.user':
      return {
        // May be a gradient; components must only use it as a direct background.
        bg: get('bg.message.user') || resolveUserBubbleSolidBg(resolvedTheme, surfaceRoles, mode),
        fg: get('neutral.primaryText', 'text.user.primary', 'text.primary'),
        border: get('neutral.lightBorder', 'border.messageUser', 'border.message', 'border.subtle'),
      }
    case 'ui.message.userSolid':
      return {
        bg: resolveUserBubbleSolidBg(resolvedTheme, surfaceRoles, mode),
        fg: get('neutral.primaryText', 'text.user.primary', 'text.primary'),
        border: get('neutral.lightBorder', 'border.messageUser', 'border.message', 'border.subtle'),
      }
    case 'ui.message.assistant':
      {
        const bg = get('bg.message.ai') || 'transparent'
        const surface = bg === 'transparent'
          ? surfaceRoles.chatBg
          : (colorToRgbString(resolveColorOverBackground(bg, surfaceRoles.chatBg)) || surfaceRoles.chatBg)
        return {
          bg,
          fg: readableAgainst(surface, [
            get('text.ai.primary'),
            get('neutral.primaryText', 'text.primary'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
          border: get('neutral.lightBorder', 'border.message', 'border.subtle'),
        }
      }
    case 'ui.message.system': {
      // Reads raw bg.* first, so it can collide with the promoted chat surface
      // the same way the composer did. Non-opaque values pass through untouched.
      const rawSystemBg = get('bg.message.system', 'bg.panel') || surfaceRoles.panelBg
      return {
        bg: guaranteeMinAbsDeltaL(surfaceRoles.chatBg, rawSystemBg, SURFACE_GUARD_MIN_DELTA_L.systemMessage, mode === 'dark') ?? rawSystemBg,
        fg: get('neutral.regularText', 'text.system', 'text.secondary', 'text.primary'),
        border: get('neutral.lightBorder', 'border.message', 'border.subtle'),
      }
    }
    case 'ui.message.error':
      return {
        bg: get('color.dangerBg', 'color.dangerLight', 'bg.message.error'),
        fg: get('color.dangerText', 'color.danger', 'text.error'),
        border: get('color.dangerBorder', 'color.danger', 'border.error'),
      }
    case 'ui.message.hover':
      return { bg: get('bg.message.hover', 'bg.hover') }
    case 'ui.message.thinking':
      return { fg: get('neutral.secondaryText', 'text.ai.thinking', 'text.muted') }
    case 'ui.tool.surface':
      return {
        bg: get('neutral.darkFill', 'bg.toolCall', 'neutral.baseFill', 'bg.panel'),
        fg: get('neutral.primaryText', 'text.primary'),
        border: get('neutral.lightBorder', 'border.subtle', 'border.default'),
      }
    case 'ui.tool.surfaceHover':
      return {
        bg: get('neutral.darkerFill', 'bg.toolCallHover', 'bg.toolCall', 'neutral.darkFill', 'bg.hover'),
        fg: get('neutral.primaryText', 'text.primary'),
        border: get('neutral.baseBorder', 'border.default', 'border.subtle'),
      }
    case 'ui.tool.surfaceSubtle':
      return {
        bg: 'color-mix(in srgb, var(--ui-tool-text-fg, var(--tool-ink)) 6%, var(--ui-tool-surface-bg, var(--bg-tool-call)))',
      }
    case 'ui.tool.result':
      return {
        bg: get('neutral.baseFill', 'bg.toolResult', 'bg.toolCall', 'bg.panel'),
        fg: get('neutral.regularText', 'text.tool.result', 'text.primary'),
      }
    case 'ui.tool.error':
      return {
        bg: get('color.dangerBg', 'color.dangerLight', 'bg.toolError', 'bg.message.error'),
        fg: get('color.dangerText', 'color.danger', 'text.tool.error', 'text.error'),
        border: get('color.dangerBorder', 'color.danger', 'border.error'),
      }
    case 'ui.tool.success':
      return {
        bg: get('color.successBg', 'color.successLight', 'bg.toolSuccess'),
        fg: get('color.successText', 'color.success', 'text.success'),
        border: get('color.successBorder', 'color.success', 'border.success'),
      }
    case 'ui.tool.text':
      {
        const bg = get('neutral.darkFill', 'bg.toolCall', 'neutral.baseFill', 'bg.panel')
        return {
          fg: readableAgainst(bg, [
            get('neutral.primaryText', 'text.primary'),
            get('text.tool.name'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.basicWhite'),
            get('neutral.basicBlack'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
        }
      }
    case 'ui.tool.textMuted':
      {
        const bg = get('neutral.darkFill', 'bg.toolCall', 'neutral.baseFill', 'bg.panel')
        return {
          fg: readableAgainst(bg, [
            get('text.tool.args'),
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
        }
      }
    case 'ui.tool.textFaint':
      {
        const bg = get('neutral.darkFill', 'bg.toolCall', 'neutral.baseFill', 'bg.panel')
        return {
          fg: readableAgainst(bg, [
            get('text.tool.label'),
            get('neutral.disabledText', 'text.faint'),
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3),
        }
      }
    case 'ui.tool.accent':
      return { fg: get('primary', 'accent') }
    case 'ui.tool.accentOn':
      return { fg: get('neutral.pageBackground', 'bg.app', 'text.btn.primary') }
    case 'ui.tool.successText':
      return { fg: get('color.success', 'text.success') }
    case 'ui.tool.dangerText':
      return { fg: get('color.danger', 'text.error') }
    case 'ui.tool.border':
      return { border: get('neutral.lightBorder', 'border.subtle', 'border.default') }
    case 'ui.editor.text':
      return {
        fg: get('neutral.primaryText', 'text.input', 'text.primary'),
        bg: resolveComposerInputBg(resolvedTheme, surfaceRoles, mode),
        border: get('neutral.baseBorder', 'border.input', 'border.default'),
      }
    case 'ui.editor.placeholder':
      {
        const bg = resolveComposerInputBg(resolvedTheme, surfaceRoles, mode)
        return {
          fg: readableAgainst(bg, [
            get('neutral.placeholderText', 'text.inputPlaceholder'),
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
        }
      }
    case 'ui.editor.caret':
      return { fg: get('neutral.primaryText', 'text.input', 'text.primary') }
    case 'ui.editor.selection':
      return {
        bg: get('primaryBg', 'bg.selected'),
        fg: get('neutral.primaryText', 'text.primary'),
      }
  }

  return {}
}

/**
 * Resolve app UI semantic tokens from the shared role mapping. `theme.ui` is
 * intentionally not applied here: product chrome should be derived from the
 * same role contract for every theme instead of per-theme semantic overrides.
 */
export function resolveThemeUI(
  theme: Theme,
  mode: 'dark' | 'light',
  resolvedTheme: Record<string, string> = resolveTheme(theme, mode)
): Record<SemanticUIToken, ResolvedUIStyle> {
  const styles = new Map<SemanticUIToken, ResolvedUIStyle>()
  const surfaceRoles = deriveSemanticSurfaceRoles(resolvedTheme, mode)
  anchorNeutralFillsToSurfaceRoles(resolvedTheme, surfaceRoles, mode)
  const categoryColors = deriveCategoryColors(
    {
      ...resolvedTheme,
      ...resolveThemeDefinitionColors(theme, mode, resolvedTheme),
    },
    [
      surfaceRoles.sidebarBg,
      surfaceRoles.sidebarBg,
      surfaceRoles.sidebarBg,
      surfaceRoles.sidebarBg,
      surfaceRoles.panelBg,
      surfaceRoles.panelBg,
      surfaceRoles.panelBg,
    ],
    mode,
    7
  )

  for (const token of SEMANTIC_UI_TOKENS) {
    styles.set(token, fallbackUIStyle(resolvedTheme, token, surfaceRoles, mode, categoryColors))
  }

  // Post-process: guarantee surface elevation chain using chained anchoring.
  // Each surface is anchored to the already-guarded surface below it in the hierarchy.
  {
    const isDark = mode === 'dark'
    const chatBg = styles.get('ui.surface.chat')?.bg

    // codeBlock distinct from chat (ΔL≥0.04 both modes)
    const rawCodeBlock = styles.get('ui.surface.codeBlock')
    const guardedCodeBlockBg = rawCodeBlock?.bg
      ? (guaranteeMinDeltaL(chatBg, rawCodeBlock.bg, 0.04, isDark) ?? rawCodeBlock.bg)
      : rawCodeBlock?.bg
    if (rawCodeBlock && guardedCodeBlockBg !== rawCodeBlock.bg) {
      styles.set('ui.surface.codeBlock', { ...rawCodeBlock, bg: guardedCodeBlockBg })
    }

    // codeHeader distinct from guarded codeBlock (dark ΔL≥0.05; light ΔL≥0.025 —
    // light headers should read as part of the block, not a separate panel)
    const rawCodeHeader = styles.get('ui.surface.codeHeader')
    const guardedCodeHeaderBg = rawCodeHeader?.bg
      ? (guaranteeMinDeltaL(guardedCodeBlockBg, rawCodeHeader.bg, isDark ? 0.05 : 0.025, isDark) ?? rawCodeHeader.bg)
      : rawCodeHeader?.bg
    if (rawCodeHeader && guardedCodeHeaderBg !== rawCodeHeader.bg) {
      styles.set('ui.surface.codeHeader', { ...rawCodeHeader, bg: guardedCodeHeaderBg })
    }

    // panel distinct from chat (ΔL≥0.04 both modes)
    const rawPanel = styles.get('ui.surface.panel')
    const guardedPanelBg = rawPanel?.bg
      ? (guaranteeMinDeltaL(chatBg, rawPanel.bg, 0.04, isDark) ?? rawPanel.bg)
      : rawPanel?.bg
    if (rawPanel && guardedPanelBg !== rawPanel.bg) {
      styles.set('ui.surface.panel', { ...rawPanel, bg: guardedPanelBg })
    }

    // elevated distinct from guarded panel (dark ΔL≥0.04, light ΔL≥0.03 — shadows compensate)
    const rawElevated = styles.get('ui.surface.elevated')
    const guardedElevatedBg = rawElevated?.bg
      ? (guaranteeMinDeltaL(guardedPanelBg, rawElevated.bg, isDark ? 0.04 : 0.03, isDark) ?? rawElevated.bg)
      : rawElevated?.bg
    if (rawElevated && guardedElevatedBg !== rawElevated.bg) {
      styles.set('ui.surface.elevated', { ...rawElevated, bg: guardedElevatedBg })
    }

    // floating distinct from guarded elevated (dark ΔL≥0.04, light ΔL≥0.03)
    const rawFloating = styles.get('ui.surface.floating')
    const guardedFloatingBg = rawFloating?.bg
      ? (guaranteeMinDeltaL(guardedElevatedBg, rawFloating.bg, isDark ? 0.04 : 0.03, isDark) ?? rawFloating.bg)
      : rawFloating?.bg
    if (rawFloating && guardedFloatingBg !== rawFloating.bg) {
      styles.set('ui.surface.floating', { ...rawFloating, bg: guardedFloatingBg })
    }

    if (isDark) {
      // menu distinct from chat (ΔL≥0.04, dark mode only — light mode menus are white/light)
      const rawMenu = styles.get('ui.surface.menu')
      if (rawMenu?.bg) {
        const guardedMenuBg = guaranteeMinDeltaL(chatBg, rawMenu.bg, 0.04, true) ?? rawMenu.bg
        if (guardedMenuBg !== rawMenu.bg) {
          styles.set('ui.surface.menu', { ...rawMenu, bg: guardedMenuBg })
        }
      }
    }

    // The elevation chain above may have moved panel/elevated/floating past the
    // anchored values; sync the neutral ramp (and role stash) to the final
    // surfaces so emitted --color-neutral-* variables match what is painted.
    const surfaceSync: Array<[SemanticUIToken, keyof ThemeSurfaceRoles, string]> = [
      ['ui.surface.panel', 'panelBg', 'neutral.baseFill'],
      ['ui.surface.elevated', 'elevatedBg', 'neutral.darkFill'],
      ['ui.surface.floating', 'floatingBg', 'neutral.darkerFill'],
    ]
    for (const [token, role, neutralPath] of surfaceSync) {
      const finalBg = styles.get(token)?.bg
      if (finalBg) {
        resolvedTheme[neutralPath] = finalBg
        resolvedTheme[SURFACE_ROLE_STASH_KEYS[role]] = finalBg
      }
    }

    const finalPanelBg = styles.get('ui.surface.panel')?.bg
    const panelState = deriveStateOverlaysForSurface(resolvedTheme, finalPanelBg, mode)
    if (panelState) {
      styles.set('ui.state.hover', {
        ...(styles.get('ui.state.hover') || {}),
        bg: panelState.hover,
      })
      styles.set('ui.state.active', {
        ...(styles.get('ui.state.active') || {}),
        bg: panelState.active,
      })
      styles.set('ui.state.selected', {
        ...(styles.get('ui.state.selected') || {}),
        bg: panelState.selected.bg,
        border: panelState.selected.border,
      })
      styles.set('ui.state.selectedHover', {
        ...(styles.get('ui.state.selectedHover') || {}),
        bg: panelState.selectedHover,
        border: panelState.selected.border,
      })
    }
  }

  return Object.fromEntries(
    SEMANTIC_UI_TOKENS.map(token => [token, styles.get(token) || {}])
  ) as Record<SemanticUIToken, ResolvedUIStyle>
}
