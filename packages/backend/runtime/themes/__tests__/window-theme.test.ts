import { describe, expect, it } from 'vitest'
import {
  resolveOnethingThemeMode,
  resolveOnethingWindowThemeSelection,
} from '../window-theme.js'

const defaults = {
  themeId: 'flexoki',
  darkThemeId: 'flexoki-dark',
  lightThemeId: 'flexoki-light',
  colorTheme: 'blue',
}

describe('onething window theme selection', () => {
  it('resolves system mode from the host-provided native theme signal', () => {
    expect(resolveOnethingThemeMode('system', true)).toBe('dark')
    expect(resolveOnethingThemeMode('system', false)).toBe('light')
  })

  it('prefers mode-specific theme IDs before legacy themeId and defaults', () => {
    expect(resolveOnethingWindowThemeSelection({
      theme: 'dark',
      general: {
        themeId: 'legacy',
        darkThemeId: 'dark-custom',
        lightThemeId: 'light-custom',
        colorTheme: 'green',
      },
      defaults,
      systemShouldUseDarkColors: false,
    })).toEqual({
      mode: 'dark',
      themeId: 'dark-custom',
      colorTheme: 'green',
    })

    expect(resolveOnethingWindowThemeSelection({
      theme: 'light',
      general: {
        themeId: 'legacy',
        darkThemeId: 'dark-custom',
        lightThemeId: 'light-custom',
      },
      defaults,
      systemShouldUseDarkColors: true,
    })).toEqual({
      mode: 'light',
      themeId: 'light-custom',
      colorTheme: 'blue',
    })
  })

  it('falls back to legacy themeId before defaults', () => {
    expect(resolveOnethingWindowThemeSelection({
      theme: 'system',
      general: {
        themeId: 'legacy',
      },
      defaults,
      systemShouldUseDarkColors: true,
    })).toEqual({
      mode: 'dark',
      themeId: 'legacy',
      colorTheme: 'blue',
    })
  })
})
