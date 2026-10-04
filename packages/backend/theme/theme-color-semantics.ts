// 主题的色彩语义(从 `theme-resolver.ts` 拆出,拆分批 1,D226):主色与状态色从哪里取、取不到时怎么生成色阶、
// 半透明与实色怎么派生,以及给调试面看的色阶诊断。
import { generate as generateAntColorPalette } from '@ant-design/colors'
import { colorToHex, parseCssColor, resolveColorOverBackground, rgbaFromCssColor } from './theme-color-math.js'
import { deriveNeutralTextRamp, deriveStatusSurfaceRamp, nudgeDangerColorTowardRed } from './theme-role-mapping.js'
import { DEFAULT_PRIMARY_COLOR, NEUTRAL_COLOR_DEFAULTS, NEUTRAL_COLOR_FALLBACK_PATHS, NEUTRAL_TEXT_COLOR_TOKENS, type NeutralTextColorToken, type ResolvedColorScaleDiagnostics, type ResolvedPrimaryColorSemantics, type ResolvedStatusColorSemantics, type ResolvedThemeColorSemantics, STATUS_COLOR_DEFAULTS, STATUS_COLOR_FALLBACK_PATHS, THEME_NEUTRAL_COLOR_TOKENS, THEME_STATUS_COLOR_TOKENS, type ThemeNeutralColorToken, type ThemeStatusColorToken } from './theme-semantic-tokens.js'

function firstResolvedThemeValue(
  resolvedTheme: Record<string, string>,
  ...paths: string[]
): string | undefined {
  for (const path of paths) {
    const value = resolvedTheme[path]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function deriveTranslucentColor(color: string, alpha: number): string {
  if (parseCssColor(color)) {
    return rgbaFromCssColor(color, alpha)
  }
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`
}

function solidColorForRamp(color: string, background: string | undefined): string | undefined {
  const colorOverBackground = resolveColorOverBackground(color, background)
  if (colorOverBackground) return colorToHex(colorOverBackground)

  const parsed = parseCssColor(color)
  if (!parsed) return undefined

  return colorToHex(parsed)
}

function fallbackStatusColorScale(baseColor: string, mode: 'dark' | 'light'): string[] {
  const surface = mode === 'dark' ? '#141414' : '#FFFFFF'
  const contrast = mode === 'dark' ? '#FFFFFF' : '#000000'

  return [
    `color-mix(in srgb, ${baseColor} 8%, ${surface})`,
    `color-mix(in srgb, ${baseColor} 14%, ${surface})`,
    `color-mix(in srgb, ${baseColor} 22%, ${surface})`,
    `color-mix(in srgb, ${baseColor} 34%, ${surface})`,
    `color-mix(in srgb, ${baseColor} 52%, ${surface})`,
    baseColor,
    `color-mix(in srgb, ${baseColor} 86%, ${contrast})`,
    `color-mix(in srgb, ${baseColor} 72%, ${contrast})`,
    `color-mix(in srgb, ${baseColor} 58%, ${contrast})`,
    `color-mix(in srgb, ${baseColor} 44%, ${contrast})`,
  ]
}

function generateSemanticColorScale(
  baseColor: string,
  mode: 'dark' | 'light',
  background: string | undefined,
): string[] {
  const solidBase = solidColorForRamp(baseColor, background)
  if (!solidBase) return fallbackStatusColorScale(baseColor, mode)

  const solidBackground = background ? solidColorForRamp(background, undefined) : undefined
  return generateAntColorPalette(solidBase, {
    theme: mode === 'dark' ? 'dark' : 'default',
    ...(mode === 'dark' && solidBackground ? { backgroundColor: solidBackground } : {}),
  })
}

export function selectPrimaryColorSemantics(
  baseColor: string,
  mode: 'dark' | 'light',
  background: string | undefined,
): ResolvedPrimaryColorSemantics {
  const scale = generateSemanticColorScale(baseColor, mode, background)

  return {
    base: scale[5] || baseColor,
    hover: (mode === 'dark' ? scale[6] : scale[4]) || baseColor,
    bg: scale[0] || deriveTranslucentColor(baseColor, 0.1),
    bgHover: scale[1] || deriveTranslucentColor(baseColor, 0.14),
    border: scale[2] || deriveTranslucentColor(baseColor, 0.28),
    text: (mode === 'dark' ? scale[7] : scale[6]) || baseColor,
    light: scale[0] || deriveTranslucentColor(baseColor, 0.1),
  }
}

export function selectStatusColorSemantics(
  baseColor: string,
  mode: 'dark' | 'light',
  background: string | undefined,
): ResolvedStatusColorSemantics {
  const scale = generateSemanticColorScale(baseColor, mode, background)
  const surfaceRamp = deriveStatusSurfaceRamp(baseColor, background, mode)

  return {
    base: scale[5] || baseColor,
    bg: surfaceRamp?.bg || scale[0] || deriveTranslucentColor(baseColor, 0.12),
    bgHover: surfaceRamp?.bgHover || scale[1] || deriveTranslucentColor(baseColor, 0.18),
    border: surfaceRamp?.border || scale[2] || deriveTranslucentColor(baseColor, 0.32),
    text: (mode === 'dark' ? scale[7] : scale[6]) || baseColor,
    light: surfaceRamp?.bg || scale[0] || deriveTranslucentColor(baseColor, 0.12),
  }
}

export function applyThemeColorSemantics(
  resolvedTheme: Record<string, string>,
  mode: 'dark' | 'light' = 'light',
): void {
  const primary = firstResolvedThemeValue(
    resolvedTheme,
    'primary',
    'accentMain',
    'accent'
  ) || DEFAULT_PRIMARY_COLOR

  resolvedTheme.primary = primary
  if (!resolvedTheme.accent) resolvedTheme.accent = primary
  if (!resolvedTheme.accentMain) resolvedTheme.accentMain = primary
  if (!resolvedTheme.accentLight) {
    resolvedTheme.accentLight = resolvedTheme.accentSub || primary
  }

  const rampBackground = firstResolvedThemeValue(
    resolvedTheme,
    'neutral.pageBackground',
    'bg.app',
  )
  const generatedPrimary = selectPrimaryColorSemantics(primary, mode, rampBackground)

  resolvedTheme.primaryHover = firstResolvedThemeValue(
    resolvedTheme,
    'primaryHover',
  ) || generatedPrimary.hover || firstResolvedThemeValue(
    resolvedTheme,
    'bg.btn.primaryHover',
    'accentLight',
    'accentSub',
  ) || primary
  resolvedTheme.primaryBg = firstResolvedThemeValue(
    resolvedTheme,
    'primaryBg',
  ) || generatedPrimary.bg
  resolvedTheme.primaryBgHover = firstResolvedThemeValue(
    resolvedTheme,
    'primaryBgHover',
  ) || generatedPrimary.bgHover
  resolvedTheme.primaryBorder = firstResolvedThemeValue(
    resolvedTheme,
    'primaryBorder',
  ) || generatedPrimary.border || firstResolvedThemeValue(
    resolvedTheme,
    'border.accent',
    'border.inputFocus',
  ) || primary
  resolvedTheme.primaryText = firstResolvedThemeValue(
    resolvedTheme,
    'primaryText',
  ) || generatedPrimary.text
  resolvedTheme.primaryLight = resolvedTheme.primaryBg || firstResolvedThemeValue(resolvedTheme, 'primaryLight') || generatedPrimary.light

  for (const token of THEME_STATUS_COLOR_TOKENS) {
    const colorPath = `color.${token}`
    const bgPath = `color.${token}Bg`
    const bgHoverPath = `color.${token}BgHover`
    const borderPath = `color.${token}Border`
    const textPath = `color.${token}Text`
    const lightPath = `color.${token}Light`
    const requestedBaseColor = firstResolvedThemeValue(
      resolvedTheme,
      ...STATUS_COLOR_FALLBACK_PATHS[token]
    ) || STATUS_COLOR_DEFAULTS[token]
    const requestedColor = token === 'danger'
      ? nudgeDangerColorTowardRed(requestedBaseColor)
      : requestedBaseColor
    const generated = selectStatusColorSemantics(requestedColor, mode, rampBackground)
    const explicitBorder = firstResolvedThemeValue(resolvedTheme, borderPath)
    const explicitText = firstResolvedThemeValue(resolvedTheme, textPath)

    resolvedTheme[colorPath] = requestedColor
    resolvedTheme[bgPath] = firstResolvedThemeValue(resolvedTheme, bgPath, lightPath) || generated.bg
    resolvedTheme[bgHoverPath] = firstResolvedThemeValue(resolvedTheme, bgHoverPath) || generated.bgHover
    resolvedTheme[borderPath] = explicitBorder
      ? (explicitBorder === requestedBaseColor ? requestedColor : explicitBorder)
      : generated.border
    resolvedTheme[textPath] = explicitText
      ? (explicitText === requestedBaseColor ? requestedColor : explicitText)
      : generated.text
    resolvedTheme[lightPath] = resolvedTheme[bgPath] || firstResolvedThemeValue(resolvedTheme, lightPath) || generated.bg
  }

  const generatedNeutralText = deriveNeutralTextRamp(
    firstResolvedThemeValue(resolvedTheme, 'text.primary', 'neutral.primaryText') || NEUTRAL_COLOR_DEFAULTS.primaryText,
    firstResolvedThemeValue(resolvedTheme, 'neutral.pageBackground', 'bg.app') || NEUTRAL_COLOR_DEFAULTS.pageBackground,
    mode,
  )
  const generatedNeutralTextByToken = generatedNeutralText as Record<NeutralTextColorToken, string> | undefined

  for (const token of THEME_NEUTRAL_COLOR_TOKENS) {
    const path = `neutral.${token}`
    if (NEUTRAL_TEXT_COLOR_TOKENS.includes(token as NeutralTextColorToken)) {
      resolvedTheme[path] = generatedNeutralTextByToken?.[token as NeutralTextColorToken]
        || firstResolvedThemeValue(
          resolvedTheme,
          ...NEUTRAL_COLOR_FALLBACK_PATHS[token]
        )
        || NEUTRAL_COLOR_DEFAULTS[token]
      continue
    }

    resolvedTheme[path] = firstResolvedThemeValue(
      resolvedTheme,
      ...NEUTRAL_COLOR_FALLBACK_PATHS[token]
    ) || NEUTRAL_COLOR_DEFAULTS[token]
  }
}

export function resolveThemeColorSemantics(
  resolvedTheme: Record<string, string>,
  mode: 'dark' | 'light' = 'light',
): ResolvedThemeColorSemantics {
  const normalizedTheme = { ...resolvedTheme }
  applyThemeColorSemantics(normalizedTheme, mode)

  return {
    primary: {
      base: normalizedTheme.primary,
      hover: normalizedTheme.primaryHover,
      bg: normalizedTheme.primaryBg,
      bgHover: normalizedTheme.primaryBgHover,
      border: normalizedTheme.primaryBorder,
      text: normalizedTheme.primaryText,
      light: normalizedTheme.primaryLight,
    },
    status: Object.fromEntries(
      THEME_STATUS_COLOR_TOKENS.map(token => [
        token,
        {
          base: normalizedTheme[`color.${token}`],
          bg: normalizedTheme[`color.${token}Bg`],
          bgHover: normalizedTheme[`color.${token}BgHover`],
          border: normalizedTheme[`color.${token}Border`],
          text: normalizedTheme[`color.${token}Text`],
          light: normalizedTheme[`color.${token}Light`],
        },
      ])
    ) as Record<ThemeStatusColorToken, ResolvedStatusColorSemantics>,
    neutral: Object.fromEntries(
      THEME_NEUTRAL_COLOR_TOKENS.map(token => [token, normalizedTheme[`neutral.${token}`]])
    ) as Record<ThemeNeutralColorToken, string>,
  }
}

export function resolveThemeColorScaleDiagnostics(
  resolvedTheme: Record<string, string>,
  mode: 'dark' | 'light' = 'light',
): ResolvedColorScaleDiagnostics {
  const normalizedTheme = { ...resolvedTheme }
  applyThemeColorSemantics(normalizedTheme, mode)

  const rampBackground = firstResolvedThemeValue(
    normalizedTheme,
    'neutral.pageBackground',
    'bg.app',
  )

  return {
    primary: {
      semantics: {
        base: normalizedTheme.primary,
        hover: normalizedTheme.primaryHover,
        bg: normalizedTheme.primaryBg,
        bgHover: normalizedTheme.primaryBgHover,
        border: normalizedTheme.primaryBorder,
        text: normalizedTheme.primaryText,
        light: normalizedTheme.primaryLight,
      },
      scale: generateSemanticColorScale(
        normalizedTheme.primary || DEFAULT_PRIMARY_COLOR,
        mode,
        rampBackground,
      ),
    },
    status: Object.fromEntries(
      THEME_STATUS_COLOR_TOKENS.map(token => {
        const base = normalizedTheme[`color.${token}`] || STATUS_COLOR_DEFAULTS[token]
        return [
          token,
          {
            semantics: {
              base,
              bg: normalizedTheme[`color.${token}Bg`],
              bgHover: normalizedTheme[`color.${token}BgHover`],
              border: normalizedTheme[`color.${token}Border`],
              text: normalizedTheme[`color.${token}Text`],
              light: normalizedTheme[`color.${token}Light`],
            },
            scale: generateSemanticColorScale(base, mode, rampBackground),
          },
        ]
      })
    ) as ResolvedColorScaleDiagnostics['status'],
  }
}
