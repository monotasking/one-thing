import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import type { Theme } from '@shared/ipc/themes.js'
import { contrastRatio, parseCssColor } from '@onething/runtime/themes/role-mapping'
import { resolveTheme, resolveThemeUI } from '@onething/runtime/themes/resolver'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const rendererDir = path.resolve(dirname, '..', '..')
const componentStyleRoots = ['components', 'editor']
const componentStyleFiles = ['styles/components.css']
const directColorAllowedFiles = new Set([
  'components/settings/ProviderIcon.vue',
  // Provider identity palette for the usage chart (brand-adjacent series colors
  // that must stay theme-independent) — same category as ProviderIcon above.
  'components/settings/UsageSettingsPanel.vue',
])
const styleFileExtensions = new Set(['.vue', '.ts', '.css'])
const legacyColorVars = new Set([
  '--accent',
  '--accent-hover',
  '--accent-main',
  '--accent-sub',
  '--accent-light',
  '--accent-rgb',
  '--bg',
  '--panel',
  '--panel-2',
  '--chat-canvas',
  '--muted',
  '--hover',
  '--active',
  '--bg-app',
  '--bg-sidebar',
  '--bg-chat',
  '--bg-panel',
  '--bg-elevated',
  '--bg-floating',
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--bg-muted',
  '--bg-hover',
  '--bg-sunken',
  '--bg-active',
  '--bg-selected',
  '--bg-selected-hover',
  '--bg-input',
  '--bg-input-focus',
  '--bg-input-disabled',
  '--input-bg',
  '--button-bg',
  '--border',
  '--border-default',
  '--border-subtle',
  '--border-strong',
  '--border-primary',
  '--border-secondary',
  '--border-color',
  '--text',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--text-faint',
  '--text-sidebar-item',
  '--text-sidebar-item-hover',
  '--text-sidebar-item-active',
  '--danger',
  '--error',
  '--warning',
  '--success',
  '--color-danger',
  '--color-warning',
  '--color-success',
  '--color-info',
  '--danger-color',
  '--success-color',
  '--accent-color',
  '--hover-bg',
  '--text-code-inline',
  '--text-code-block',
  '--text-code-comment',
  '--text-code-keyword',
  '--text-code-string',
  '--text-code-number',
  '--text-code-function',
  '--text-code-variable',
  '--text-code-operator',
  '--text-code-type',
  '--text-code-property',
  '--text-code-punctuation',
  '--syntax-string',
])

function readRendererFile(relativePath: string): string {
  return fs.readFileSync(path.join(rendererDir, relativePath), 'utf8')
}

function listStyleFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      listStyleFiles(absolutePath, files)
    } else if (styleFileExtensions.has(path.extname(entry.name))) {
      files.push(absolutePath)
    }
  }
  return files
}

function findMatchingParen(text: string, openParen: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = openParen; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (char === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function firstVarName(inner: string): string | null {
  return inner.match(/^\s*(--[\w-]+)/)?.[1] || null
}

function lineNumber(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

function cssDeclarationValue(css: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escapedName}\\s*:\\s*([^;]+);`).exec(css)
  return match?.[1].replace(/\s+/g, ' ').trim() || ''
}

function makeActionContrastTheme(primary: string, danger: string, colorScheme: 'dark' | 'light'): Theme {
  const dark = colorScheme === 'dark'
  return {
    id: `action-contrast-${colorScheme}`,
    name: `Action contrast ${colorScheme}`,
    type: 'full',
    colorScheme,
    defs: {},
    theme: {
      primary,
      accent: primary,
      accentSub: dark ? '#dbeafe' : '#1d4ed8',
      bg: {
        app: dark ? '#101010' : '#f8f8f8',
        sidebar: dark ? '#141414' : '#f4f4f4',
        chat: dark ? '#181818' : '#ffffff',
        panel: dark ? '#202020' : '#f1f1f1',
        elevated: dark ? '#282828' : '#e8e8e8',
        floating: dark ? '#303030' : '#ffffff',
        btn: {
          primary: '#777777',
          primaryHover: '#777777',
          danger: '#777777',
          dangerHover: '#777777',
        },
      },
      text: {
        primary: dark ? '#f5f5f5' : '#111111',
        secondary: dark ? '#d0d0d0' : '#333333',
        muted: dark ? '#999999' : '#666666',
        btn: {
          primary: '#777777',
          danger: '#777777',
        },
      },
      border: {
        default: dark ? '#333333' : '#dddddd',
        subtle: dark ? '#282828' : '#e5e5e5',
        accent: '#777777',
        error: '#777777',
        inputFocus: '#777777',
      },
      color: {
        danger,
      },
    },
  }
}

function expectResolvedActionContrast(theme: Theme, mode: 'dark' | 'light'): void {
  const resolvedTheme = resolveTheme(theme, mode)
  const resolvedUI = resolveThemeUI(theme, mode, resolvedTheme)

  for (const token of [
    'ui.action.primary',
    'ui.action.primaryHover',
    'ui.action.danger',
    'ui.action.dangerHover',
  ] as const) {
    const style = resolvedUI[token]
    const foreground = parseCssColor(style.fg)
    const background = parseCssColor(style.bg)
    if (!foreground || !background) {
      throw new Error(`${token} should resolve parseable fg/bg colors, got ${style.fg} on ${style.bg}`)
    }
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5)
  }
}

function isDirectThemeColorVar(name: string): boolean {
  return (
    /^--color-primary(?:-(?:hover|light|bg|bg-hover|border|text))?$/.test(name) ||
    /^--color-(danger|warning|success|info)(?:-(?:light|bg|bg-hover|border|text))?$/.test(name) ||
    /^--color-neutral-/.test(name) ||
    /^--(?:neutral|text-color|border-color|fill-color|bg-color)-/.test(name)
  )
}

function isSemanticVarName(name: string | null): boolean {
  return !!name && (
    /^--ui-/.test(name) ||
    /^--hg-/.test(name) ||
    /^--diff-/.test(name)
  )
}

function isInsideSemanticVar(text: string, offset: number): boolean {
  let searchFrom = offset
  while (true) {
    const start = text.lastIndexOf('var(', searchFrom)
    if (start === -1) return false
    const close = findMatchingParen(text, start + 3)
    if (close >= offset) {
      const name = firstVarName(text.slice(start + 4, close))
      if (isSemanticVarName(name)) return true
    }
    searchFrom = start - 1
  }
}

function collectDirectLegacyColorUsage(): string[] {
  const reports: string[] = []
  const files = [
    ...componentStyleRoots.flatMap((root) => listStyleFiles(path.join(rendererDir, root))),
    ...componentStyleFiles.map((file) => path.join(rendererDir, file)),
  ]

  for (const file of files) {
    const relativeFile = path.relative(rendererDir, file)
    if (directColorAllowedFiles.has(relativeFile)) continue
    const text = fs.readFileSync(file, 'utf8')
    let cursor = 0
    while (true) {
      const start = text.indexOf('var(', cursor)
      if (start === -1) break
      const close = findMatchingParen(text, start + 3)
      if (close === -1) break
      const name = firstVarName(text.slice(start + 4, close))
      if (
        name &&
        (legacyColorVars.has(name) || isDirectThemeColorVar(name)) &&
        !isInsideSemanticVar(text, start + 2)
      ) {
        reports.push(`${relativeFile}:${lineNumber(text, start)} direct ${name}`)
      }
      cursor = close + 1
    }

    const hexPattern = /#[0-9a-fA-F]{3,8}\b/g
    let match: RegExpExecArray | null
    while ((match = hexPattern.exec(text))) {
      if (isInsideSemanticVar(text, match.index)) continue
      const lineStart = text.lastIndexOf('\n', match.index) + 1
      const lineEnd = text.indexOf('\n', match.index)
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
      if (line.includes('previewColors')) continue
      // mask-image gradients only consume the alpha channel — #000 there is
      // "fully opaque", not a theme color, so tokenizing it would be wrong.
      // Check the whole enclosing declaration: the gradient often wraps
      // across lines, so the hex may sit on a continuation line.
      const declStart = Math.max(text.lastIndexOf(';', match.index), text.lastIndexOf('{', match.index))
      if (text.slice(declStart + 1, match.index).includes('mask-image')) continue
      reports.push(`${relativeFile}:${lineNumber(text, match.index)} direct ${match[0]}`)
    }
  }

  return reports
}

function collectStatusColorMixUsage(): string[] {
  const reports: string[] = []
  const files = listStyleFiles(rendererDir)
  const pattern = /color-mix\(\s*in\s+srgb,\s*var\(--ui-status-/g

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) {
      reports.push(`${path.relative(rendererDir, file)}:${lineNumber(text, match.index)} derives status color from ui.status fg`)
    }
  }

  return reports
}

describe('renderer UI semantic variables', () => {
  it('defines UI semantic tokens and routes tool chrome aliases through them', () => {
    const variables = readRendererFile('styles/variables.css')

    expect(variables).toContain('--ui-action-primary-bg')
    expect(variables).toContain('--ui-status-danger-fg')
    expect(variables).toContain('--ui-status-success-on-fg')
    expect(variables).toContain('--ui-surface-note-bg')
    expect(variables).toContain('--color-primary')
    expect(variables).toContain('--color-primary-hover')
    expect(variables).toContain('--color-primary-bg')
    expect(variables).toContain('--color-primary-bg-hover')
    expect(variables).toContain('--color-primary-border')
    expect(variables).toContain('--color-primary-text')
    expect(variables).toContain('--color-primary-light')
    expect(variables).toContain('--color-neutral-primary-text')
    expect(variables).toContain('--text-color-regular')
    expect(variables).toContain('--border-color-extra-light')
    expect(variables).toContain('--fill-color-blank')
    expect(variables).toContain('--bg-color-overlay')
    expect(variables).toContain('--color-danger-bg')
    expect(variables).toContain('--color-danger-bg-hover')
    expect(variables).toContain('--color-danger-border')
    expect(variables).toContain('--color-danger-text')
    expect(variables).toContain('--color-success-bg')
    expect(variables).toContain('--color-warning-bg')
    expect(variables).toContain('--color-info-bg')
    expect(variables).not.toContain('--color-primary-100')
    expect(variables).not.toContain('--color-danger-100')
    expect(variables).toContain('--ui-surface-tooltip-border')
    expect(variables).toContain('--ui-surface-tooltip-shadow')
    expect(variables).toContain('--ui-surface-chat-panel-shadow')
    expect(variables).toContain('--ui-surface-composer-shadow')
    expect(variables).toContain('--ui-composer-overlay-bg')
    expect(variables).toContain('--ui-composer-overlay-border')
    expect(variables).toContain('--ui-composer-overlay-shadow')
    expect(variables).toContain('--ui-surface-code-inline-fg')
    expect(variables).toContain('--ui-surface-code-block-shadow')
    expect(variables).toContain('--ui-surface-preview-light-bg')
    expect(variables).toContain('--ui-sidebar-item-active-bg')
    expect(variables).toContain('--ui-tab-bar-item-active-bg')
    expect(variables).toContain('--ui-message-user-shadow')
    expect(variables).toContain('--ui-content-media-shadow')
    expect(variables).toContain('--ui-action-primary-shadow')
    expect(variables).toContain('--ui-tool-surface-bg')
    expect(variables).toContain('--ui-editor-caret-fg')
    expect(variables).toContain('--tool-surface: var(--ui-tool-surface-bg')
    expect(variables).toContain('--tool-ink: var(--ui-tool-text-fg')
    expect(variables).toContain('--tool-del-bar: var(--ui-tool-danger-text-fg')
  })

  it('prefers canonical theme semantics in UI fallback definitions', () => {
    const variables = readRendererFile('styles/variables.css')

    expect(cssDeclarationValue(variables, '--ui-accent-primary-fg')).toBe('var(--color-primary, var(--accent))')
    expect(cssDeclarationValue(variables, '--ui-accent-subtle-fg')).toBe('var(--color-primary-hover, var(--accent-sub))')
    expect(cssDeclarationValue(variables, '--ui-action-primary-bg')).toBe('var(--color-primary, var(--bg-btn-primary))')
    expect(cssDeclarationValue(variables, '--ui-action-primary-fg')).toBe('var(--color-neutral-page-background, var(--text-btn-primary, var(--bg-app)))')
    expect(cssDeclarationValue(variables, '--ui-action-primary-hover-bg')).toBe('var(--color-primary-hover, var(--bg-btn-primary-hover, var(--accent-light, var(--color-primary))))')
    expect(cssDeclarationValue(variables, '--ui-action-primary-hover-fg')).toBe('var(--ui-action-primary-fg)')
    expect(cssDeclarationValue(variables, '--ui-action-danger-bg')).toBe('var(--color-danger, var(--bg-btn-danger))')
    expect(cssDeclarationValue(variables, '--ui-action-danger-fg')).toBe('var(--color-neutral-page-background, var(--text-btn-danger, var(--bg-app)))')
    expect(cssDeclarationValue(variables, '--ui-action-danger-hover-bg')).toBe('var(--color-danger-bg-hover, var(--bg-btn-danger-hover, var(--color-danger)))')
    expect(cssDeclarationValue(variables, '--ui-text-primary-fg')).toBe('var(--color-neutral-primary-text, var(--text-primary))')
    expect(cssDeclarationValue(variables, '--ui-text-secondary-fg')).toBe('var(--color-neutral-regular-text, var(--text-secondary))')
    expect(cssDeclarationValue(variables, '--ui-message-thinking-fg')).toBe('var(--color-neutral-secondary-text)')
    expect(cssDeclarationValue(variables, '--ui-border-default-border')).toBe('var(--color-neutral-base-border, var(--border-default))')
    expect(cssDeclarationValue(variables, '--ui-surface-app-bg')).toBe('var(--color-neutral-page-background, var(--bg-app))')
    expect(cssDeclarationValue(variables, '--ui-surface-chat-bg')).toBe('var(--color-neutral-base-background, var(--bg-chat))')
    expect(cssDeclarationValue(variables, '--ui-state-selected-bg')).toBe('var(--color-primary-bg, var(--bg-selected))')
    expect(cssDeclarationValue(variables, '--ui-state-selected-hover-bg')).toBe('var(--color-primary-bg-hover, var(--bg-selected-hover, var(--color-primary-bg)))')
    expect(cssDeclarationValue(variables, '--ui-status-danger-fg')).toBe('var(--color-danger-text, var(--color-danger, var(--text-error)))')
    expect(cssDeclarationValue(variables, '--ui-status-success-fg')).toBe('var(--color-success-text, var(--color-success, var(--text-success)))')
    expect(cssDeclarationValue(variables, '--ui-status-warning-border')).toBe('var(--color-warning-border, var(--color-warning, var(--border-warning)))')
    expect(cssDeclarationValue(variables, '--ui-status-info-border')).toBe('var(--color-info-border, var(--color-info, var(--border-accent)))')
    expect(cssDeclarationValue(variables, '--ui-tool-accent-fg')).toBe('var(--color-primary, var(--accent))')
    expect(cssDeclarationValue(variables, '--ui-tool-error-fg')).toBe('var(--color-danger-text, var(--color-danger, var(--text-tool-error)))')
    expect(cssDeclarationValue(variables, '--ui-editor-text-bg')).toBe('var(--color-neutral-lighter-fill, var(--bg-input))')
  })

  it('resolves readable on-colors for solid action UI tokens', () => {
    expectResolvedActionContrast(makeActionContrastTheme('#123abc', '#991b1b', 'dark'), 'dark')
    expectResolvedActionContrast(makeActionContrastTheme('#facc15', '#fee2e2', 'light'), 'light')
  })

  it('routes high-value UI surfaces directly through UI semantic tokens', () => {
    const stepsPanel = readRendererFile('components/chat/StepsPanel.vue')
    const toolResultRenderer = readRendererFile('components/chat/ToolResultRenderer.vue')
    const toolStepDetails = readRendererFile('components/chat/ToolStepDetails.vue')
    const toolContentPreview = readRendererFile('components/chat/ToolContentPreview.vue')
    const messageBubble = readRendererFile('components/chat/message/MessageBubble.vue')
    const messageThinking = readRendererFile('components/chat/message/MessageThinking.vue')
    const thoughtHeader = readRendererFile('components/chat/message/ThoughtHeader.vue')
    const thinkToggle = readRendererFile('components/chat/ThinkToggle.vue')
    const inputBox = readRendererFile('components/chat/InputBox.vue')
    const chatWindow = readRendererFile('components/chat/ChatWindow.vue')
    const chatContainer = readRendererFile('components/ChatContainer.vue')
    const settingsPage = readRendererFile('components/SettingsPage.vue')
    const sidebar = readRendererFile('components/sidebar/Sidebar.vue')
    const sessionItem = readRendererFile('components/sidebar/SessionItem.vue')
    // P1 合流:菜单族样式的唯一一份落在 Dropdown.vue(原 SessionContextMenu 已删)。
    const dropdownMenu = readRendererFile('components/common/Dropdown.vue')
    const todoPlanWindow = readRendererFile('components/TodoPlanWindow.vue')
    const todoPlanPanel = readRendererFile('components/chat/TodoPlanPanel.vue')
    const todoNotesActionPanel = readRendererFile('components/chat/TodoNotesActionPanel.vue')
    const todoPopover = readRendererFile('components/chat/todo-popover.css')
    const sessionHeader = readRendererFile('components/chat/SessionHeader.vue')
    const tooltip = readRendererFile('components/common/Tooltip.vue')
    const editorExtensions = readRendererFile('editor/extensions.ts')
    const markdownStyles = readRendererFile('styles/markdown.css')

    expect(stepsPanel).toContain('var(--ui-tool-danger-text-fg')
    expect(toolResultRenderer).toContain('var(--ui-tool-text-muted-fg')
    expect(toolStepDetails).toContain('var(--ui-tool-border-border')
    expect(toolContentPreview).toContain('var(--ui-tool-text-muted-fg')

    // Theme-specific tool text colors must take precedence over the generic
    // neutral tiers, or every theme's dedicated dim tool color is shadowed
    // by near-body-brightness secondary text (regression guard).
    const variablesCss = readRendererFile('styles/variables.css')
    expect(variablesCss).toContain(
      '--ui-tool-text-muted-fg: var(--text-tool-args, var(--color-neutral-secondary-text',
    )
    expect(variablesCss).toContain(
      '--ui-tool-text-faint-fg: var(--text-tool-label, var(--color-neutral-disabled-text',
    )
    expect(messageBubble).toContain('var(--ui-message-user-solid-bg')
    expect(messageBubble).toContain('var(--ui-message-user-shadow')
    // 等待行的墨色跟着 ThoughtHeader 走(rail 内的 `.generation-waiting` 和
    // 消息顶部的等待行现在是同一个组件),所以断言落在它身上,而不再落在
    // MessageBubble 里那份已经拆掉的本地 `--waiting-fg`。
    expect(thoughtHeader).toContain('--thought-fg: var(--ui-message-thinking-fg')
    expect(thoughtHeader).not.toContain('var(--ui-message-thinking-fg,')
    expect(messageBubble).toContain('--reasoning-fg: var(--ui-message-thinking-fg')
    expect(messageThinking).toContain('--thinking-fg: var(--ui-message-thinking-fg')
    expect(thinkToggle).toContain('--think-accent: var(--ui-message-thinking-fg);')
    expect(messageBubble).not.toContain('var(--ui-message-thinking-fg,')
    expect(messageThinking).not.toContain('var(--ui-message-thinking-fg,')
    expect(thinkToggle).not.toContain('var(--ui-message-thinking-fg,')
    expect(messageBubble).toContain('md-inline-code-scope')
    expect(inputBox).toContain('var(--ui-accent-primary-fg')
    expect(inputBox).toContain('--ui-surface-composer-shadow')
    expect(inputBox).toContain('var(--ui-status-success-fg')
    expect(chatWindow).toContain('var(--ui-surface-chat-bg')
    expect(chatWindow).toContain('--ui-surface-chat-panel-shadow')
    expect(chatContainer).toContain('var(--ui-surface-chat-bg')
    const settingsPaperDefs = settingsPage.match(/--settings-paper:\s*var\(--ui-surface-[^)]+/g) ?? []
    const settingsSidebarDefs = settingsPage.match(/--settings-paper-2:\s*var\(--ui-sidebar-surface-bg/g) ?? []
    const settingsPanelDefs = settingsPage.match(/--settings-paper-3:\s*var\(--ui-surface-panel-bg/g) ?? []
    // Two definitions: the base layer and the IDE-refresh layer (the middle
    // legacy layer was removed in the 2026-07 settings refactor).
    expect(settingsPaperDefs).toHaveLength(2)
    expect(settingsPaperDefs.every(def => def.includes('--ui-surface-chat-bg'))).toBe(true)
    expect(settingsSidebarDefs).toHaveLength(2)
    expect(settingsPanelDefs).toHaveLength(2)
    expect(sidebar).toContain('--ui-sidebar-surface-bg')
    // Sidebar v7: the active state is a full-row fill (SessionItem owns the
    // row background), not the pre-v7 left border.
    expect(sessionItem).toContain('var(--ui-state-selected-bg')
    expect(dropdownMenu).toContain('var(--ui-surface-menu-bg')
    expect(dropdownMenu).toContain('var(--ui-surface-menu-hover-bg')
    // Menu row hover must resolve to the dedicated menu-item-hover color, not
    // to the same elevated fill the menu surface itself uses — with
    // --color-neutral-dark-fill first, hover was literally invisible
    // (regression guard).
    expect(variablesCss).toContain('--ui-surface-menu-hover-bg: var(--bg-menu-item-hover')
    expect(dropdownMenu).toContain('var(--ui-surface-tooltip-shadow')
    expect(dropdownMenu).toContain('var(--ui-status-danger-fg')
    expect(todoPlanWindow).toContain('var(--ui-surface-elevated-bg')
    expect(todoPlanPanel).toContain('var(--ui-surface-elevated-bg')
    expect(todoPlanPanel).toContain('var(--ui-border-default-border')
    expect(todoPlanPanel).toContain('var(--ui-status-danger-fg')
    expect(todoPlanPanel).toContain('--todo-popover-content-height')
    expect(todoPlanPanel).toContain('--todo-popover-height')
    expect(todoPlanPanel).not.toContain('--todo-popover-max-height')
    expect(todoPlanPanel).not.toContain('--todo-switcher-popover-max-height')
    expect(todoPlanPanel).not.toContain('--todo-action-popover-max-height')
    expect(todoPopover).toContain('var(--todo-popover-search-height')
    expect(todoPopover).toContain('var(--todo-popover-height')
    expect(todoNotesActionPanel).toContain('var(--todo-action-row-min-height')
    // 页签退役后顶栏是 `SessionHeader`(U2),token 沿用 `--ui-tab-bar-*` 那一族
    // —— 它标的是"顶栏"这个位置,不是"页签"这个控件。
    expect(sessionHeader).toContain('var(--ui-tab-bar-surface-bg')
    expect(sessionHeader).toContain('var(--ui-tab-bar-item-active-fg')
    expect(sessionHeader).toContain('var(--ot-active-text')
    // 2026-08-11 用户拍板:tooltip 弃反色并入统一浮层面(菜单面族)。
    expect(tooltip).toContain('var(--ui-surface-menu-bg')
    expect(tooltip).toContain('var(--ui-text-primary-fg)')
    expect(editorExtensions).toContain('var(--ui-editor-caret-fg')
    expect(markdownStyles).toContain('--md-inline-code-bg')
    expect(markdownStyles).toContain('var(--ui-content-media-shadow')
  })

  it('keeps component colors routed through UI, highlight, or diff semantic variables', () => {
    expect(collectDirectLegacyColorUsage()).toEqual([])
  })

  it('uses complete ui.status bg/border/fg tokens instead of deriving status surfaces from fg', () => {
    expect(collectStatusColorMixUsage()).toEqual([])
  })

  /** SFC 的 `<style>` 段。断言 CSS 的时候只该看这一段。 */
  function styleBlockOf(source: string): string {
    const start = source.indexOf('<style')
    return start === -1 ? '' : source.slice(start)
  }

  it('keeps the todo window startup surface on semantic color fallbacks', () => {
    const html = fs.readFileSync(path.resolve(rendererDir, '..', '..', 'index.html'), 'utf8')
    const todoPlanWindow = readRendererFile('components/TodoPlanWindow.vue')
    const todoPlanPanel = readRendererFile('components/chat/TodoPlanPanel.vue')
    const todoNotesActionPanel = readRendererFile('components/chat/TodoNotesActionPanel.vue')
    const todoPopover = readRendererFile('components/chat/todo-popover.css')

    expect(html).not.toContain('#282726')
    expect(html).toContain('var(--ui-surface-app-bg')
    expect(todoPlanWindow).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    expect(todoPlanPanel).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    expect(todoNotesActionPanel).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    expect(todoPopover).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    expect(todoPlanPanel).toContain('--todo-plan-nav-gutter: 52px')
    // 退役的 `.flush` 版式变体。只看样式段:`flush` 也是脚本里的常用词
    // (草稿纸落盘走的就是 `flushNow`),整文件搜会把无关的代码当成 CSS 报出来。
    expect(styleBlockOf(todoPlanPanel)).not.toContain('flush')
    expect(todoPlanPanel).toContain('overflow: hidden;')
    expect(todoPlanPanel).toContain('popover-open')
    expect(todoPlanPanel).not.toContain('surface-chat-floating-card.action-panel-open')
  })
})
