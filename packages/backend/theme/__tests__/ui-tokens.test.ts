import { describe, expect, it } from 'vitest'
import type { Theme } from '../types.js'
import { generateCSSVariables } from '../css-mapper.js'
import {
  colorMeetsContrast,
  contrastRatio,
  deriveCategoryColors,
  deriveNeutralTextRamp,
  deriveStateOverlays,
  deriveStatusSurfaceRamp,
  nudgeDangerColorTowardRed,
  parseCssColor,
} from '../role-mapping.js'
import { resolveTheme, resolveThemeColorSemantics, resolveThemeUI } from '../resolver.js'

function expectSolidContrast(
  style: { fg?: string; bg?: string },
  label: string,
  minimumContrast = 4.5
): void {
  const foreground = parseCssColor(style.fg)
  const background = parseCssColor(style.bg)
  if (!foreground || !background) {
    throw new Error(`${label} should resolve parseable fg/bg colors, got ${style.fg} on ${style.bg}`)
  }

  expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(minimumContrast)
}

function expectNeutralTextRampContrast(
  ramp: {
    primaryText: string
    regularText: string
    secondaryText: string
    placeholderText: string
    disabledText: string
  },
  background: string
): void {
  const backgroundColor = parseCssColor(background)
  const black = parseCssColor('#000000')
  const white = parseCssColor('#FFFFFF')
  if (!backgroundColor || !black || !white) {
    throw new Error(`neutral ramp background should be parseable, got ${background}`)
  }

  const maxPossibleContrast = Math.max(
    contrastRatio(black, backgroundColor),
    contrastRatio(white, backgroundColor)
  )
  const targets = {
    primaryText: 12,
    regularText: 8,
    secondaryText: 4.5,
    placeholderText: 3,
    disabledText: 2,
  }
  const ratios = Object.fromEntries(
    Object.entries(ramp).map(([token, value]) => {
      const color = parseCssColor(value)
      if (!color) throw new Error(`${token} should be parseable, got ${value}`)
      return [token, contrastRatio(color, backgroundColor)]
    })
  ) as Record<keyof typeof targets, number>

  for (const [token, target] of Object.entries(targets) as Array<[keyof typeof targets, number]>) {
    expect(ratios[token], `${token} contrast`).toBeGreaterThanOrEqual(
      Math.min(target, maxPossibleContrast) - 0.02
    )
  }

  expect(ratios.primaryText).toBeGreaterThanOrEqual(ratios.regularText)
  expect(ratios.regularText).toBeGreaterThanOrEqual(ratios.secondaryText)
  expect(ratios.secondaryText).toBeGreaterThanOrEqual(ratios.placeholderText)
  expect(ratios.placeholderText).toBeGreaterThanOrEqual(ratios.disabledText)
}

function colorContrast(first: string, second: string): number {
  const firstColor = parseCssColor(first)
  const secondColor = parseCssColor(second)
  if (!firstColor || !secondColor) {
    throw new Error(`Expected parseable colors, got ${first} and ${second}`)
  }
  return contrastRatio(firstColor, secondColor)
}

function makeTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    id: 'test-ui-theme',
    name: 'Test UI Theme',
    type: 'full',
    defs: {
      app: '#101010',
      sidebar: '#151515',
      chat: '#181818',
      panel: '#202020',
      elevated: '#282828',
      floating: '#303030',
      text: '#eeeeee',
      secondary: '#cccccc',
      muted: '#888888',
      faint: '#555555',
      accent: '#3388dd',
      accentSub: '#cce4ff',
      danger: '#dd3333',
      dangerBg: 'rgba(221, 51, 51, 0.14)',
      success: '#33aa55',
      successBg: 'rgba(51, 170, 85, 0.14)',
      override: '#ff00ff',
    },
    theme: {
      accent: 'accent',
      accentSub: 'accentSub',
      bg: {
        app: 'app',
        sidebar: 'sidebar',
        chat: 'chat',
        panel: 'panel',
        elevated: 'elevated',
        floating: 'floating',
        message: {
          user: 'linear-gradient(135deg, #202020 0%, #181818 100%)',
          userSolid: '#202020',
          ai: 'transparent',
          system: '#181818',
          error: 'dangerBg',
          hover: 'rgba(255, 255, 255, 0.04)',
        },
        toolCall: 'panel',
        toolCallHover: 'elevated',
        toolResult: 'chat',
        input: 'panel',
        inputFocus: 'elevated',
        btn: {
          primary: 'accent',
          primaryHover: 'accentSub',
          secondary: 'elevated',
          secondaryHover: 'floating',
          ghost: 'transparent',
          ghostHover: 'elevated',
          danger: 'danger',
          dangerHover: '#aa2222',
        },
        code: {
          inline: 'elevated',
          block: 'panel',
          header: 'elevated',
        },
        menu: 'floating',
        menuItemHover: 'elevated',
        tooltip: '#eeeeee',
        modal: 'panel',
        selected: 'rgba(51, 136, 221, 0.16)',
        selectedHover: 'rgba(51, 136, 221, 0.22)',
        highlight: 'rgba(255, 200, 0, 0.16)',
        hover: 'rgba(255, 255, 255, 0.04)',
        active: 'rgba(255, 255, 255, 0.08)',
      },
      text: {
        primary: 'text',
        secondary: 'secondary',
        muted: 'muted',
        faint: 'faint',
        error: 'danger',
        success: 'success',
        link: 'accent',
        input: 'text',
        inputPlaceholder: 'muted',
        user: {
          primary: 'text',
        },
        ai: {
          primary: 'text',
          thinking: 'muted',
        },
        tool: {
          name: 'accent',
          args: 'muted',
          result: 'secondary',
          error: 'danger',
          label: 'faint',
        },
        btn: {
          primary: 'app',
          secondary: 'text',
          ghost: 'text',
          danger: 'app',
        },
        code: {
          inline: 'text',
          block: 'text',
        },
      },
      border: {
        default: '#303030',
        subtle: '#282828',
        accent: 'accent',
        error: 'danger',
        success: 'success',
        input: '#303030',
        inputFocus: 'accent',
        message: '#282828',
        messageUser: '#303030',
        code: '#303030',
        divider: '#282828',
      },
      color: {
        danger: 'danger',
        dangerBg: 'dangerBg',
        dangerBgHover: 'rgba(221, 51, 51, 0.2)',
        dangerBorder: 'danger',
        dangerText: 'danger',
        dangerLight: 'dangerBg',
        success: 'success',
        successBg: 'successBg',
        successBgHover: 'rgba(51, 170, 85, 0.2)',
        successBorder: 'success',
        successText: 'success',
        successLight: 'successBg',
        info: 'accent',
        infoBg: 'rgba(51, 136, 221, 0.14)',
        infoBgHover: 'rgba(51, 136, 221, 0.2)',
        infoBorder: 'accent',
        infoText: 'accent',
        infoLight: 'rgba(51, 136, 221, 0.14)',
      },
    },
    ...overrides,
  }
}

describe('theme UI semantic tokens', () => {
  it('derives UI CSS variables from legacy theme colors', () => {
    const theme = makeTheme()
    const resolvedTheme = resolveTheme(theme, 'dark')
    const expectedNeutralText = deriveNeutralTextRamp(
      resolvedTheme['text.primary'],
      resolvedTheme['neutral.pageBackground'],
      'dark'
    )!
    const resolvedUI = resolveThemeUI(theme, 'dark', resolvedTheme)
    const cssVariables = generateCSSVariables(resolvedTheme, undefined, resolvedUI)
    const sidebarStates = deriveStateOverlays(
      resolvedUI['ui.sidebar.surface'].bg,
      resolvedUI['ui.sidebar.itemActive'].border,
      'dark'
    )!

    expectNeutralTextRampContrast(expectedNeutralText, resolvedTheme['neutral.pageBackground'])
    expect(new Set(Object.values(expectedNeutralText))).toHaveLength(5)
    expect(resolvedUI['ui.text.primary'].fg).toBe(expectedNeutralText.primaryText)
    expect(resolvedUI['ui.action.primary']).toMatchObject({
      bg: '#3388dd',
      fg: '#000000',
      border: '#3388dd',
    })
    expectSolidContrast(resolvedUI['ui.action.primary'], 'primary action')
    expectSolidContrast(resolvedUI['ui.action.primaryHover'], 'primary action hover')
    expect(resolvedUI['ui.action.danger'].bg).toBe('#dd3333')
    expect(resolvedUI['ui.action.dangerHover'].bg).toBe('rgba(221, 51, 51, 0.2)')
    expectSolidContrast(resolvedUI['ui.action.danger'], 'danger action')
    expectSolidContrast(resolvedUI['ui.action.dangerHover'], 'danger action hover')
    expect(resolvedUI['ui.tool.surface']).toMatchObject({
      bg: '#282828',
      border: '#282828',
    })
    expect(resolvedUI['ui.surface.note']).toMatchObject({
      bg: resolvedTheme['color.warningBg'],
      fg: expectedNeutralText.primaryText,
      border: resolvedTheme['color.warningBorder'],
    })
    expect(resolvedUI['ui.surface.app']).toMatchObject({
      bg: '#101010',
    })
    expect(resolvedUI['ui.surface.chat']).toMatchObject({
      bg: '#202020',
    })
    expect(resolvedUI['ui.sidebar.surface']).toMatchObject({
      bg: '#101010',
      fg: expectedNeutralText.regularText,
      border: '#282828',
    })
    expect(resolvedUI['ui.surface.previewLight'].bg).toBe('#ffffff')
    expect(resolvedUI['ui.surface.previewDark'].bg).toBe('#0f1117')
    expect(resolvedUI['ui.sidebar.item']).toMatchObject({
      fg: expectedNeutralText.regularText,
    })
    expect(resolvedUI['ui.sidebar.itemHover']).toMatchObject({
      bg: sidebarStates.hover,
      fg: expectedNeutralText.primaryText,
    })
    expect(resolvedUI['ui.sidebar.action']).toMatchObject({
      fg: expectedNeutralText.regularText,
      bg: 'transparent',
    })
    expect(resolvedUI['ui.sidebar.itemActive']).toMatchObject({
      bg: sidebarStates.selected.bg,
      fg: expectedNeutralText.primaryText,
      border: sidebarStates.selected.border,
    })
    expect(resolvedUI['ui.tabBar.itemActive']).toMatchObject({
      fg: expectedNeutralText.primaryText,
      border: 'transparent',
    })
    expect(resolvedUI['ui.status.danger']).toMatchObject({
      fg: '#dd3333',
      bg: 'rgba(221, 51, 51, 0.14)',
      border: '#dd3333',
    })

    const colorSemantics = resolveThemeColorSemantics(resolvedTheme)
    expect(colorSemantics.primary.base).toBe('#3388dd')
    expect(colorSemantics.primary.hover).toBe(resolvedTheme.primaryHover)
    expect(colorSemantics.primary.hover).not.toBe('#cce4ff')
    expect(colorSemantics.primary.bg).toBeTruthy()
    expect(colorSemantics.primary.bgHover).toBeTruthy()
    expect(colorSemantics.primary.border).toBe(resolvedTheme.primaryBorder)
    expect(colorSemantics.primary.border).not.toBe('#3388dd')
    expect(colorSemantics.primary.text).toBeTruthy()
    expect(colorSemantics.status.danger).toMatchObject({
      base: '#dd3333',
      bg: 'rgba(221, 51, 51, 0.14)',
      bgHover: 'rgba(221, 51, 51, 0.2)',
      border: '#dd3333',
      text: '#dd3333',
    })
    expect(colorSemantics.status.success).toMatchObject({
      base: '#33aa55',
      bg: 'rgba(51, 170, 85, 0.14)',
      bgHover: 'rgba(51, 170, 85, 0.2)',
      border: '#33aa55',
      text: '#33aa55',
    })
    expect(colorSemantics.neutral).toMatchObject({
      primaryText: expectedNeutralText.primaryText,
      regularText: expectedNeutralText.regularText,
      secondaryText: expectedNeutralText.secondaryText,
      placeholderText: expectedNeutralText.placeholderText,
      disabledText: expectedNeutralText.disabledText,
      baseBorder: '#303030',
      lightBorder: '#282828',
      // Neutral fills are anchored onto the derived surface roles, so they
      // must match the resolved UI surfaces rather than the raw theme values.
      baseFill: resolvedUI['ui.surface.panel'].bg,
      blankFill: 'transparent',
      basicBlack: '#000000',
      basicWhite: '#FFFFFF',
      pageBackground: resolvedUI['ui.surface.app'].bg,
      baseBackground: resolvedUI['ui.surface.chat'].bg,
      overlayBackground: '#202020',
    })

    expect(cssVariables['--color-primary']).toBe('#3388dd')
    expect(cssVariables['--color-primary-hover']).toBe(resolvedTheme.primaryHover)
    expect(cssVariables['--color-primary-bg']).toBeTruthy()
    expect(cssVariables['--color-primary-bg-hover']).toBeTruthy()
    expect(cssVariables['--color-primary-border']).toBe(resolvedTheme.primaryBorder)
    expect(cssVariables['--color-primary-text']).toBeTruthy()
    expect(cssVariables['--color-primary-light']).toBe(cssVariables['--color-primary-bg'])
    expect(cssVariables['--color-primary-100']).toBeUndefined()
    expect(cssVariables['--color-primary-600']).toBeUndefined()
    expect(cssVariables['--color-primary-100-rgb']).toBeUndefined()
    expect(cssVariables['--primary']).toBe('#3388dd')
    expect(cssVariables['--ui-text-primary-fg']).toBe(expectedNeutralText.primaryText)
    // P4b 停双写:`--text-primary` 不再被 UI 中性字阶覆写,只剩 CSS_VAR_MAP 直写的
    // 主题原值。两者本来就不同 —— 双写正是把这个分歧盖住的那层。
    expect(cssVariables['--text-primary']).toBe(resolvedTheme['text.primary'])
    expect(cssVariables['--text-primary']).not.toBe(expectedNeutralText.primaryText)
    expect(cssVariables['--color-neutral-primary-text']).toBe(expectedNeutralText.primaryText)
    expect(cssVariables['--text-color-primary']).toBe(expectedNeutralText.primaryText)
    expect(cssVariables['--color-neutral-regular-text']).toBe(expectedNeutralText.regularText)
    expect(cssVariables['--text-color-regular']).toBe(expectedNeutralText.regularText)
    expect(cssVariables['--color-neutral-base-border']).toBe('#303030')
    expect(cssVariables['--border-color-base']).toBe('#303030')
    // Anchored onto the derived panel surface, not the raw theme fill.
    expect(cssVariables['--color-neutral-base-fill']).toBe(resolvedUI['ui.surface.panel'].bg)
    expect(cssVariables['--fill-color-base']).toBe(resolvedUI['ui.surface.panel'].bg)
    expect(cssVariables['--color-neutral-page-background']).toBe('#101010')
    expect(cssVariables['--bg-color-page']).toBe('#101010')
    expect(cssVariables['--ui-action-primary-bg']).toBe('#3388dd')
    expect(cssVariables['--bg-btn-primary']).toBe('#3388dd')
    expect(cssVariables['--ui-tool-surface-bg']).toBe('#282828')
    // P4b 停双写:`--tool-surface` 只由 UI 别名表发出过,现在不再发。
    expect(cssVariables['--tool-surface']).toBeUndefined()
    expect(cssVariables['--ui-surface-app-bg']).toBe('#101010')
    expect(cssVariables['--bg-app']).toBe('#101010')
    expect(cssVariables['--ui-sidebar-surface-bg']).toBe('#101010')
    // P4b 停双写:`--bg-sidebar` 回到 CSS_VAR_MAP 直写的主题原值,不再被
    // `ui.sidebar.surface` 派生出来的面覆写。
    expect(cssVariables['--bg-sidebar']).toBe(resolvedTheme['bg.sidebar'])
    expect(cssVariables['--ui-surface-note-bg']).toBe(resolvedTheme['color.warningBg'])
    // P4b 停双写:以下三个 legacy 名只由 UI 别名表发出过,现在不再发。
    expect(cssVariables['--bg-note']).toBeUndefined()
    expect(cssVariables['--ui-surface-preview-light-bg']).toBe('#ffffff')
    expect(cssVariables['--ui-surface-preview-dark-bg']).toBe('#0f1117')
    expect(cssVariables['--ui-sidebar-item-active-fg']).toBe(expectedNeutralText.primaryText)
    expect(cssVariables['--text-sidebar-item-active']).toBeUndefined()
    expect(cssVariables['--ui-tab-bar-item-active-fg']).toBe(expectedNeutralText.primaryText)
    expect(cssVariables['--tab-item-active-fg']).toBeUndefined()
    expect(cssVariables['--ui-status-danger-fg']).toBe('#dd3333')
    expect(cssVariables['--color-danger']).toBe('#dd3333')
    expect(cssVariables['--color-danger-bg']).toBe('rgba(221, 51, 51, 0.14)')
    expect(cssVariables['--color-danger-bg-hover']).toBe('rgba(221, 51, 51, 0.2)')
    expect(cssVariables['--color-danger-border']).toBe('#dd3333')
    expect(cssVariables['--color-danger-text']).toBe('#dd3333')
    expect(cssVariables['--color-danger-100']).toBeUndefined()
    expect(cssVariables['--color-danger-600-rgb']).toBeUndefined()
  })

  it('derives positional category tokens from theme accent slots', () => {
    const theme = makeTheme()
    theme.defs = {
      ...theme.defs,
      purple: '#A779D6',
      cyan: '#2A9FA6',
      green: '#64A255',
      orange: '#C87931',
      yellow: '#B69B2C',
      brown: '#9B7255',
      blue: '#4F8CCF',
    }

    const resolvedTheme = resolveTheme(theme, 'dark')
    const resolvedUI = resolveThemeUI(theme, 'dark', resolvedTheme)
    const cssVariables = generateCSSVariables(resolvedTheme, undefined, resolvedUI)
    const categoryBackgrounds = [
      resolvedUI['ui.sidebar.surface'].bg,
      resolvedUI['ui.sidebar.surface'].bg,
      resolvedUI['ui.sidebar.surface'].bg,
      resolvedUI['ui.sidebar.surface'].bg,
      resolvedUI['ui.surface.panel'].bg,
      resolvedUI['ui.surface.panel'].bg,
      resolvedUI['ui.surface.panel'].bg,
    ]
    const expectedCategoryColors = deriveCategoryColors(
      {
        ...resolvedTheme,
        purple: '#A779D6',
        cyan: '#2A9FA6',
        green: '#64A255',
        orange: '#C87931',
        yellow: '#B69B2C',
        brown: '#9B7255',
        blue: '#4F8CCF',
        'b30.purple': '#A779D6',
        'b30.cyan': '#2A9FA6',
        'b30.green': '#64A255',
        'b30.orange': '#C87931',
        'b30.yellow': '#B69B2C',
        'b30.brown': '#9B7255',
        'b30.blue': '#4F8CCF',
      },
      categoryBackgrounds,
      'dark',
      7
    )
    const iconTokens = [
      'ui.category.1.icon',
      'ui.category.2.icon',
      'ui.category.3.icon',
      'ui.category.4.icon',
      'ui.category.5.icon',
      'ui.category.6.icon',
      'ui.category.7.icon',
    ] as const
    const badgeBgTokens = [
      'ui.category.1.badgeBg',
      'ui.category.2.badgeBg',
      'ui.category.3.badgeBg',
      'ui.category.4.badgeBg',
      'ui.category.5.badgeBg',
      'ui.category.6.badgeBg',
      'ui.category.7.badgeBg',
    ] as const
    const badgeTextTokens = [
      'ui.category.1.badgeText',
      'ui.category.2.badgeText',
      'ui.category.3.badgeText',
      'ui.category.4.badgeText',
      'ui.category.5.badgeText',
      'ui.category.6.badgeText',
      'ui.category.7.badgeText',
    ] as const

    for (let index = 0; index < 7; index += 1) {
      const category = expectedCategoryColors[index]
      expect(resolvedUI[iconTokens[index]].fg).toBe(category.icon)
      expect(resolvedUI[badgeBgTokens[index]].bg).toBe(category.badgeBg)
      expect(resolvedUI[badgeTextTokens[index]].fg).toBe(category.badgeText)
      const slot = index + 1
      expect(cssVariables[`--ui-category-${slot}-icon`]).toBe(category.icon)
      expect(cssVariables[`--ui-category-${slot}-badge-bg`]).toBe(category.badgeBg)
      expect(cssVariables[`--ui-category-${slot}-badge-text`]).toBe(category.badgeText)
      expect(colorMeetsContrast(category.icon, categoryBackgrounds[index], 3)).toBe(true)
      expect(colorMeetsContrast(category.badgeText, category.badgeBg, 3)).toBe(true)
    }

    expect(new Set(expectedCategoryColors.map(category => category.icon))).toHaveLength(7)
  })

  it('falls back to a distinct category palette when theme accent hues collide', () => {
    const colors = deriveCategoryColors(
      {
        purple: '#8B7EC8',
        cyan: '#8D7DC6',
        green: '#907FC5',
        orange: '#927EC4',
        yellow: '#9480C3',
        brown: '#9681C2',
        blue: '#9882C1',
      },
      '#101010',
      'dark',
      7
    )

    expect(new Set(colors.map(category => category.icon))).toHaveLength(7)
    for (const category of colors) {
      expect(colorMeetsContrast(category.icon, '#101010', 3)).toBe(true)
      expect(colorMeetsContrast(category.badgeText, category.badgeBg, 3)).toBe(true)
    }
  })

  it('lets new primary and status definitions override legacy roles while generating neutral text', () => {
    const theme = makeTheme()
    theme.theme.primary = 'override'
    theme.theme.neutral = {
      regularText: 'override',
      pageBackground: 'override',
      blankFill: '#123456',
    }
    theme.theme.color = {
      ...theme.theme.color,
      dangerBg: 'override',
      dangerBgHover: 'override',
      dangerBorder: 'override',
      dangerText: 'override',
    }

    const resolvedTheme = resolveTheme(theme, 'dark')
    const resolvedUI = resolveThemeUI(theme, 'dark', resolvedTheme)
    const cssVariables = generateCSSVariables(resolvedTheme, undefined, resolvedUI)
    const colorSemantics = resolveThemeColorSemantics(resolvedTheme)
    const expectedNeutralText = deriveNeutralTextRamp(
      resolvedTheme['text.primary'],
      resolvedTheme['neutral.pageBackground'],
      'dark'
    )!

    expect(resolvedTheme.primary).toBe('#ff00ff')
    expect(resolvedTheme.accent).toBe('#ff00ff')
    expect(resolvedTheme['bg.btn.primary']).toBe('#ff00ff')
    expect(colorSemantics.primary.base).toBe('#ff00ff')
    expect(colorSemantics.primary.hover).toBe(resolvedTheme.primaryHover)
    expect(colorSemantics.primary.hover).not.toBe('#cce4ff')
    expect(colorSemantics.status.danger).toMatchObject({
      bg: '#ff00ff',
      bgHover: '#ff00ff',
      border: '#ff00ff',
      text: '#ff00ff',
    })
    expectNeutralTextRampContrast(expectedNeutralText, '#ff00ff')
    expect(colorSemantics.neutral.regularText).toBe(expectedNeutralText.regularText)
    expect(colorSemantics.neutral.regularText).not.toBe('#ff00ff')
    expect(colorSemantics.neutral.pageBackground).toBe('#ff00ff')
    expect(colorSemantics.neutral.blankFill).toBe('#123456')
    expect(cssVariables['--color-primary']).toBe('#ff00ff')
    expect(cssVariables['--color-primary-hover']).toBe(resolvedTheme.primaryHover)
    expect(cssVariables['--color-primary-bg']).toBeTruthy()
    expect(cssVariables['--color-primary-text']).toBeTruthy()
    expect(cssVariables['--color-primary-100']).toBeUndefined()
    expect(cssVariables['--color-danger-bg']).toBe('#ff00ff')
    expect(cssVariables['--color-danger-text']).toBe('#ff00ff')
    expect(cssVariables['--accent']).toBe('#ff00ff')
    expect(cssVariables['--bg-btn-primary']).toBe('#ff00ff')
    expect(cssVariables['--text-color-regular']).toBe(expectedNeutralText.regularText)
    expect(cssVariables['--bg-color-page']).toBe('#ff00ff')
    expect(cssVariables['--fill-color-blank']).toBe('#123456')
    expect(cssVariables['--color-primary-rgb']).toBe('255, 0, 255')
    expect(cssVariables['--color-neutral-blank-fill-rgb']).toBe('18, 52, 86')
  })

  it('prefers canonical primary, status, and neutral semantics when deriving UI tokens', () => {
    const theme = makeTheme()
    theme.theme.primary = '#123abc'
    theme.theme.color = {
      ...theme.theme.color,
      danger: '#ff1111',
      dangerBg: '#220000',
      dangerBgHover: '#330000',
      dangerBorder: '#ff1111',
      dangerText: '#ff1111',
      dangerLight: '#220000',
      warning: '#ffaa00',
      warningBg: '#332200',
      warningBgHover: '#443000',
      warningBorder: '#ffaa00',
      warningText: '#ffaa00',
      warningLight: '#332200',
      success: '#11cc66',
      successBg: '#002211',
      successBgHover: '#003318',
      successBorder: '#11cc66',
      successText: '#11cc66',
      successLight: '#002211',
      info: '#00aaff',
      infoBg: '#001f33',
      infoBgHover: '#002a44',
      infoBorder: '#00aaff',
      infoText: '#00aaff',
      infoLight: '#001f33',
    }
    theme.theme.neutral = {
      primaryText: '#fafafa',
      regularText: '#dedede',
      secondaryText: '#ababab',
      placeholderText: '#777777',
      disabledText: '#555555',
      baseBorder: '#444444',
      lightBorder: '#333333',
      darkBorder: '#666666',
      lighterBorder: '#222222',
      baseFill: '#242424',
      darkFill: '#303030',
      darkerFill: '#383838',
      lighterFill: '#1c1c1c',
      pageBackground: '#080808',
      baseBackground: '#121212',
      overlayBackground: '#000000cc',
    }

    const resolvedTheme = resolveTheme(theme, 'dark')
    const resolvedUI = resolveThemeUI(theme, 'dark', resolvedTheme)
    const expectedNeutralText = deriveNeutralTextRamp(
      resolvedTheme['text.primary'],
      resolvedTheme['neutral.pageBackground'],
      'dark'
    )!
    const panelStates = deriveStateOverlays(
      resolvedUI['ui.surface.panel'].bg,
      resolvedUI['ui.state.selected'].border,
      'dark'
    )!
    const cssVariables = generateCSSVariables(resolvedTheme, undefined, resolvedUI)

    expect(resolvedUI['ui.accent.primary'].fg).toBe('#123abc')
    expect(resolvedUI['ui.action.primary']).toMatchObject({
      bg: '#123abc',
      border: '#123abc',
    })
    expectSolidContrast(resolvedUI['ui.action.primary'], 'semantic primary action')
    expect(resolvedUI['ui.action.primaryHover'].bg).toBe(resolvedTheme.primaryHover)
    expect(resolvedUI['ui.action.primaryHover'].bg).not.toBe('#cce4ff')
    expectSolidContrast(resolvedUI['ui.action.primaryHover'], 'semantic primary action hover')
    expect(resolvedUI['ui.border.focus'].border).toBe(resolvedTheme.primaryBorder)
    expect(resolvedUI['ui.state.selected'].bg).toBe(panelStates.selected.bg)
    expect(resolvedUI['ui.state.selected'].border).toBe(panelStates.selected.border)
    expect(resolvedUI['ui.state.selectedHover'].bg).toBe(panelStates.selectedHover)
    expect(resolvedUI['ui.tool.accent'].fg).toBe('#123abc')
    expect(resolvedUI['ui.status.danger']).toMatchObject({
      fg: '#ff1111',
      bg: '#220000',
      border: '#ff1111',
    })
    expect(resolvedUI['ui.status.warning']).toMatchObject({
      fg: '#ffaa00',
      bg: '#332200',
      border: '#ffaa00',
    })
    expect(resolvedUI['ui.action.danger'].bg).toBe('#ff1111')
    expect(resolvedUI['ui.action.dangerHover'].bg).toBe('#330000')
    expectSolidContrast(resolvedUI['ui.action.danger'], 'semantic danger action')
    expectSolidContrast(resolvedUI['ui.action.dangerHover'], 'semantic danger action hover')
    expectNeutralTextRampContrast(expectedNeutralText, '#080808')
    expect(resolvedUI['ui.text.primary'].fg).toBe(expectedNeutralText.primaryText)
    expect(resolvedUI['ui.text.secondary'].fg).toBe(expectedNeutralText.regularText)
    expect(resolvedUI['ui.text.muted'].fg).toBe(expectedNeutralText.secondaryText)
    expect(resolvedUI['ui.message.thinking'].fg).toBe(expectedNeutralText.secondaryText)
    expect(resolvedUI['ui.border.default'].border).toBe('#444444')
    expect(resolvedUI['ui.border.subtle'].border).toBe('#333333')
    expect(resolvedUI['ui.table.headerBg'].bg).toBeTruthy()
    expect(resolvedUI['ui.table.rowBg'].bg).toBe('transparent')
    expect(resolvedUI['ui.table.border'].border).toBeTruthy()
    expect(cssVariables['--ui-table-header-bg']).toBe(resolvedUI['ui.table.headerBg'].bg)
    expect(cssVariables['--ui-table-row-bg']).toBe('transparent')
    expect(cssVariables['--ui-table-border']).toBe(resolvedUI['ui.table.border'].border)
    expect(cssVariables['--app-table-head-mix-percent']).toMatch(/%$/)
    expect(cssVariables['--app-table-border-mix-percent']).toMatch(/%$/)
    expect(resolvedUI['ui.surface.app'].bg).toBe('#080808')
    expect(resolvedUI['ui.surface.chat'].bg).toBe('#242424')
    expect(resolvedUI['ui.tool.surface']).toMatchObject({
      bg: '#303030',
      border: '#333333',
    })
    expect(resolvedUI['ui.editor.text']).toMatchObject({
      fg: expectedNeutralText.primaryText,
      // Shares the composer surface, which is always raised from chat in the
      // mode's direction — even when the theme authors a recessed input.
      bg: resolvedUI['ui.surface.input'].bg,
      border: '#444444',
    })
  })

  it('derives distinct neutral text ramp before duplicated legacy text fallbacks', () => {
    const theme = makeTheme()
    theme.defs = {
      ...theme.defs,
      everforestBg: '#f7f1df',
      everforestText: '#272f35',
      collapsedText: '#3b4349',
    }
    theme.theme.bg.app = 'everforestBg'
    theme.theme.text.primary = 'everforestText'
    theme.theme.text.secondary = 'collapsedText'
    theme.theme.text.muted = 'collapsedText'
    theme.theme.text.faint = 'collapsedText'
    theme.theme.text.inputPlaceholder = 'collapsedText'
    theme.theme.neutral = {
      primaryText: 'collapsedText',
      regularText: 'collapsedText',
      secondaryText: 'collapsedText',
      placeholderText: 'collapsedText',
      disabledText: 'collapsedText',
      pageBackground: 'everforestBg',
    }

    const resolvedTheme = resolveTheme(theme, 'light')
    const expectedNeutralText = deriveNeutralTextRamp('#272f35', '#f7f1df', 'light')!
    const resolvedNeutralText = [
      resolvedTheme['neutral.primaryText'],
      resolvedTheme['neutral.regularText'],
      resolvedTheme['neutral.secondaryText'],
      resolvedTheme['neutral.placeholderText'],
      resolvedTheme['neutral.disabledText'],
    ]

    expectNeutralTextRampContrast(expectedNeutralText, '#f7f1df')
    expect(resolvedNeutralText).toEqual([
      expectedNeutralText.primaryText,
      expectedNeutralText.regularText,
      expectedNeutralText.secondaryText,
      expectedNeutralText.placeholderText,
      expectedNeutralText.disabledText,
    ])
    expect(new Set(resolvedNeutralText)).toHaveLength(5)
    expect(resolvedNeutralText.slice(1)).not.toEqual([
      '#3b4349',
      '#3b4349',
      '#3b4349',
      '#3b4349',
    ])
  })

  it('generates distinct light and dark status semantics without exposing ramps', () => {
    const theme = makeTheme()
    delete theme.theme.color?.dangerBg
    delete theme.theme.color?.dangerBgHover
    delete theme.theme.color?.dangerBorder
    delete theme.theme.color?.dangerText
    delete theme.theme.color?.dangerLight
    delete theme.theme.bg.message?.error
    const darkTheme = resolveTheme(theme, 'dark')
    const lightTheme = resolveTheme(theme, 'light')

    for (const path of ['color.dangerBg', 'color.dangerBgHover', 'color.dangerBorder', 'color.dangerText']) {
      expect(darkTheme[path]).toMatch(/^#[0-9a-f]{6}$/i)
      expect(lightTheme[path]).toMatch(/^#[0-9a-f]{6}$/i)
    }
    expect(darkTheme['color.dangerBg']).not.toBe(lightTheme['color.dangerBg'])
    expect(darkTheme['primary.100']).toBeUndefined()
    expect(darkTheme['color.danger.100']).toBeUndefined()
  })

  it('derives status shallow surfaces in OKLCH so light ramps stay separated', () => {
    const theme = makeTheme()
    theme.theme.primary = '#3a94c5'
    theme.theme.bg.app = '#f7f1df'
    theme.theme.bg.chat = '#f7f1df'
    theme.theme.text.primary = '#272f35'
    theme.theme.color = {
      success: '#5da111',
      warning: '#f7954f',
      danger: '#c85552',
      info: '#89bfdc',
    }

    const resolvedTheme = resolveTheme(theme, 'light')
    const expectedWarning = deriveStatusSurfaceRamp('#f7954f', '#f7f1df', 'light')!
    const expectedInfo = deriveStatusSurfaceRamp('#89bfdc', '#f7f1df', 'light')!

    expect(resolvedTheme['color.warningBg']).toBe(expectedWarning.bg)
    expect(resolvedTheme['color.warningBgHover']).toBe(expectedWarning.bgHover)
    expect(resolvedTheme['color.warningBorder']).toBe(expectedWarning.border)
    expect(new Set([
      resolvedTheme['color.warningBg'],
      resolvedTheme['color.warningBgHover'],
      resolvedTheme['color.warningBorder'],
    ])).toHaveLength(3)

    const warningSurfaceContrasts = [
      colorContrast(resolvedTheme['color.warningBg'], '#f7f1df'),
      colorContrast(resolvedTheme['color.warningBgHover'], '#f7f1df'),
      colorContrast(resolvedTheme['color.warningBorder'], '#f7f1df'),
    ]
    expect(warningSurfaceContrasts[0]).toBeGreaterThan(1.05)
    expect(warningSurfaceContrasts[0]).toBeLessThan(1.2)
    expect(warningSurfaceContrasts[1]).toBeGreaterThan(warningSurfaceContrasts[0])
    expect(warningSurfaceContrasts[2]).toBeGreaterThan(warningSurfaceContrasts[1])
    expect(warningSurfaceContrasts[2]).toBeLessThan(1.6)

    for (const token of ['success', 'warning', 'danger', 'info']) {
      expect(
        colorContrast(resolvedTheme[`color.${token}Text`], resolvedTheme[`color.${token}Bg`]),
        `${token} text on generated light status bg`
      ).toBeGreaterThan(2.5)
    }

    expect(resolvedTheme.primaryBg).toBe('#f0fcff')
    expect(resolvedTheme['color.infoBg']).toBe(expectedInfo.bg)
    expect(resolvedTheme['color.infoBg']).not.toBe(resolvedTheme.primaryBg)
  })

  it('derives dark status shallow surfaces above the dark page surface', () => {
    const theme = makeTheme()
    theme.theme.bg.app = '#101010'
    theme.theme.bg.chat = '#101010'
    theme.theme.color = {
      danger: '#c85552',
    }

    const resolvedTheme = resolveTheme(theme, 'dark')
    const nudgedDanger = nudgeDangerColorTowardRed('#c85552')
    const expectedDanger = deriveStatusSurfaceRamp(nudgedDanger, '#101010', 'dark')!
    expect(resolvedTheme['color.danger']).toBe(nudgedDanger)
    expect(resolvedTheme['color.dangerBg']).toBe(expectedDanger.bg)
    expect(resolvedTheme['color.dangerBgHover']).toBe(expectedDanger.bgHover)
    expect(resolvedTheme['color.dangerBorder']).toBe(expectedDanger.border)

    const dangerSurfaceContrasts = [
      colorContrast(resolvedTheme['color.dangerBg'], '#101010'),
      colorContrast(resolvedTheme['color.dangerBgHover'], '#101010'),
      colorContrast(resolvedTheme['color.dangerBorder'], '#101010'),
    ]
    expect(dangerSurfaceContrasts[0]).toBeGreaterThan(1.05)
    expect(dangerSurfaceContrasts[1]).toBeGreaterThan(dangerSurfaceContrasts[0])
    expect(dangerSurfaceContrasts[2]).toBeGreaterThan(dangerSurfaceContrasts[1])
    expect(dangerSurfaceContrasts[2]).toBeLessThan(1.6)
    expect(
      colorContrast(resolvedTheme['color.dangerText'], resolvedTheme['color.dangerBg'])
    ).toBeGreaterThan(2.5)
  })

  it('nudges orange-leaning danger hues toward red', () => {
    const theme = makeTheme()
    theme.theme.color = {
      danger: '#D08770',
    }

    const resolvedTheme = resolveTheme(theme, 'light')
    const nudgedDanger = nudgeDangerColorTowardRed('#D08770')

    expect(nudgedDanger).not.toBe('#D08770')
    expect(resolvedTheme['color.danger']).toBe(nudgedDanger)
    expect(resolvedTheme['color.dangerText']).not.toBe('#D08770')
  })

  it('ignores theme UI overrides so every theme uses shared role mapping', () => {
    const theme = makeTheme({
      ui: {
        semanticTokens: {
          'ui.text.primary': { fg: 'override' },
        },
        groups: {
          PrimaryButton: { bg: 'override', fg: 'app', border: 'override' },
          ToolCard: { link: 'PrimaryButton' },
          LoopA: { link: 'LoopB' },
          LoopB: { link: 'LoopA' },
        },
        aliases: {
          ToolCard: 'ui.tool.surface',
          LoopA: 'ui.text.faint',
        },
      },
    })

    const resolvedTheme = resolveTheme(theme, 'dark')
    const resolvedUI = resolveThemeUI(theme, 'dark', resolvedTheme)
    const cssVariables = generateCSSVariables(resolvedTheme, undefined, resolvedUI)
    const expectedNeutralText = deriveNeutralTextRamp(
      resolvedTheme['text.primary'],
      resolvedTheme['neutral.pageBackground'],
      'dark'
    )!

    expect(resolvedUI['ui.text.primary'].fg).toBe(expectedNeutralText.primaryText)
    expect(resolvedUI['ui.action.primary']).toMatchObject({
      bg: '#3388dd',
      fg: '#000000',
      border: '#3388dd',
    })
    expectSolidContrast(resolvedUI['ui.action.primary'], 'ignored override primary action')
    expect(resolvedUI['ui.tool.surface']).toMatchObject({
      bg: '#282828',
      border: '#282828',
    })
    expect(resolvedUI['ui.text.faint'].fg).toBe(expectedNeutralText.disabledText)
    expect(cssVariables['--ui-action-primary-bg']).toBe('#3388dd')
    expect(cssVariables['--bg-btn-primary']).toBe('#3388dd')
    expect(cssVariables['--ui-tool-surface-bg']).toBe('#282828')
    // P4b 停双写:`--tool-surface` 只由 UI 别名表发出过,现在不再发。
    expect(cssVariables['--tool-surface']).toBeUndefined()
  })

  it('repairs flattened legacy surfaces into distinct app roles', () => {
    const theme = makeTheme()
    theme.theme.bg.sidebar = 'chat'
    theme.theme.bg.panel = 'chat'
    theme.theme.bg.elevated = 'chat'
    theme.theme.bg.floating = 'chat'

    const resolvedTheme = resolveTheme(theme, 'dark')
    const resolvedUI = resolveThemeUI(theme, 'dark', resolvedTheme)

    expect(resolvedUI['ui.surface.chat'].bg).toBe('#181818')
    expect(resolvedUI['ui.surface.app'].bg).not.toBe(resolvedUI['ui.surface.chat'].bg)
    expect(resolvedUI['ui.surface.app'].bg).toBe(resolvedUI['ui.sidebar.surface'].bg)
    expect(resolvedUI['ui.sidebar.surface'].bg).not.toBe(resolvedUI['ui.surface.chat'].bg)
    expect(resolvedUI['ui.surface.panel'].bg).not.toBe(resolvedUI['ui.surface.chat'].bg)
    expect(resolvedUI['ui.tabBar.surface'].bg).toBe(resolvedUI['ui.surface.chat'].bg)
    expect(resolvedUI['ui.tabBar.surface'].bg).not.toBe(resolvedUI['ui.sidebar.surface'].bg)
    expect(resolvedUI['ui.surface.elevated'].bg).not.toBe(resolvedUI['ui.surface.panel'].bg)
  })

  it('keeps explicit menu and elevated roles out of the floating surface', () => {
    const theme = makeTheme()
    theme.defs.floatBright = '#6f7a90'
    theme.theme.bg.elevated = 'panel'
    theme.theme.bg.floating = 'floatBright'
    theme.theme.bg.menu = 'panel'

    const resolvedTheme = resolveTheme(theme, 'dark')
    const resolvedUI = resolveThemeUI(theme, 'dark', resolvedTheme)

    expect(resolvedUI['ui.surface.floating'].bg).toBe('#6f7a90')
    expect(resolvedUI['ui.surface.elevated'].bg).not.toBe('#6f7a90')
    expect(resolvedUI['ui.surface.menu'].bg).not.toBe('#6f7a90')
  })
})
