import { describe, expect, it } from 'vitest'
import { captureRuntimeLogs } from '../../logging/index.js'
import type { Theme } from '../types.js'
import { generateCSSVariables } from '../css-mapper.js'
import { colorMeetsContrast } from '../role-mapping.js'
import { resolveTheme, resolveThemeHighlights } from '../resolver.js'

function makeTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    id: 'test-theme',
    name: 'Test Theme',
    type: 'full',
    defs: {
      app: '#101010',
      panel: '#181818',
      text: '#eeeeee',
      muted: '#777777',
      keyword: '#aa00aa',
      string: '#00aa55',
      number: '#dd8800',
      fn: '#3388dd',
      variable: '#cccccc',
      property: '#99ccff',
      type: '#22aaaa',
      operator: '#999999',
      punctuation: '#666666',
      danger: '#dd3333',
      success: '#33aa55',
      aliasFg: '#ff00ff',
    },
    theme: {
      accent: 'fn',
      bg: {
        app: 'app',
        sidebar: 'panel',
        chat: 'panel',
        panel: 'panel',
        elevated: '#202020',
        floating: '#303030',
        code: {
          inline: '#202020',
          block: '#151515',
          header: '#202020',
        },
      },
      text: {
        primary: 'text',
        muted: 'muted',
        error: 'danger',
        success: 'success',
        link: 'fn',
        code: {
          inline: 'text',
          block: 'text',
          comment: 'muted',
          keyword: 'keyword',
          string: 'string',
          number: 'number',
          function: 'fn',
          variable: 'variable',
          property: 'property',
          type: 'type',
          operator: 'operator',
          punctuation: 'punctuation',
        },
      },
      border: {
        default: '#303030',
      },
      color: {
        danger: 'danger',
        success: 'success',
      },
    },
    ...overrides,
  }
}

describe('theme highlight groups', () => {
  it('derives highlight CSS variables from legacy text.code tokens', () => {
    const theme = makeTheme()
    const resolvedTheme = resolveTheme(theme, 'dark')
    const codeBlockBg = resolvedTheme['bg.code.block']
    const resolvedHighlights = resolveThemeHighlights(theme, 'dark', resolvedTheme, codeBlockBg)
    const cssVariables = generateCSSVariables(resolvedTheme, resolvedHighlights)

    expect(resolvedHighlights['syntax.keyword'].fg).not.toBe('#aa00aa')
    expect(colorMeetsContrast(resolvedHighlights['syntax.keyword'].fg, codeBlockBg, 4)).toBe(true)
    expect(resolvedHighlights['syntax.comment'].fontStyle).toBe('italic')
    expect(cssVariables['--hg-syntax-keyword-fg']).toBe(resolvedHighlights['syntax.keyword'].fg)
    expect(cssVariables['--hg-syntax-comment-font-style']).toBe('italic')
    expect(cssVariables['--text-code-keyword']).toBe(resolvedHighlights['syntax.keyword'].fg)
    expect(cssVariables['--hljs-keyword']).toBe(resolvedHighlights['syntax.keyword'].fg)
    expect(cssVariables['--syntax-keyword']).toBe(resolvedHighlights['syntax.keyword'].fg)
  })

  it('resolves semantic tokens, linked groups, aliases, font styles, and circular fallback', () => {
    const logs = captureRuntimeLogs()
    const theme = makeTheme({
      highlights: {
        semanticTokens: {
          'syntax.keyword': { fg: 'aliasFg', fontStyle: 'bold italic' },
        },
        groups: {
          Comment: { fg: 'muted', bg: '#080808', fontStyle: 'italic underline' },
          Operator: { link: 'syntax.keyword' },
          LoopA: { link: 'LoopB' },
          LoopB: { link: 'LoopA' },
        },
        aliases: {
          Comment: 'syntax.comment',
          Operator: 'syntax.operator',
          LoopA: 'syntax.punctuation',
        },
      },
    })

    const resolvedTheme = resolveTheme(theme, 'dark')
    const codeBlockBg = resolvedTheme['bg.code.block']
    const resolvedHighlights = resolveThemeHighlights(theme, 'dark', resolvedTheme, codeBlockBg)
    const cssVariables = generateCSSVariables(resolvedTheme, resolvedHighlights)

    expect(resolvedHighlights['syntax.keyword'].fg).toBe('#ff00ff')
    expect(resolvedHighlights['syntax.operator'].fg).toBe('#ff00ff')
    expect(resolvedHighlights['syntax.comment']).toMatchObject({
      fg: '#777777',
      bg: '#080808',
      fontStyle: 'italic underline',
    })
    expect(resolvedHighlights['syntax.punctuation'].fg).not.toBe('#666666')
    expect(colorMeetsContrast(resolvedHighlights['syntax.punctuation'].fg, codeBlockBg, 3.5)).toBe(true)
    expect(cssVariables['--hg-syntax-keyword-font-style']).toBe('italic')
    expect(cssVariables['--hg-syntax-keyword-font-weight']).toBe('700')
    expect(cssVariables['--hg-syntax-comment-text-decoration']).toBe('underline')
    expect(logs.ofLevel('warn').length).toBeGreaterThan(0)
    logs.restore()
  })
})
