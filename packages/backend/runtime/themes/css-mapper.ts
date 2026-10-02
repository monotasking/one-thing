/**
 * CSS Variable Mapper
 * Maps semantic theme properties to existing 130+ CSS variable names
 * Ensures backward compatibility with existing components
 */

import type { SemanticHighlightToken, SemanticUIToken } from './types.js'
import {
  SEMANTIC_HIGHLIGHT_TOKENS,
  SEMANTIC_UI_TOKENS,
  THEME_NEUTRAL_COLOR_TOKENS,
} from './resolver.js'
import type { ResolvedHighlightStyle, ResolvedUIStyle, ThemeNeutralColorToken } from './resolver.js'
import { deriveRegionOverlay, guaranteeMinMixOpacity } from './role-mapping.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('themes')

/**
 * Maps theme property paths to CSS variable names
 * Each theme property can map to multiple CSS variables for compatibility
 */
export const CSS_VAR_MAP: Record<string, string[]> = {
  // ============================================
  // Accent Colors
  // ============================================
  'primary': ['--color-primary', '--primary'],
  'primaryHover': ['--color-primary-hover'],
  'primaryBg': ['--color-primary-bg'],
  'primaryBgHover': ['--color-primary-bg-hover'],
  'primaryBorder': ['--color-primary-border'],
  'primaryText': ['--color-primary-text'],
  'primaryLight': ['--color-primary-light'],
  'accent': ['--accent', '--accent-main'],
  'accentMain': ['--accent-main'],
  'accentSub': ['--accent-sub'],
  'accentLight': ['--accent-light'],  // Used by buttons and gradients
  'accentRgb': ['--accent-rgb'],

  // ============================================
  // Background Colors
  // ============================================
  'bg.app': ['--bg-app', '--bg'],
  'bg.sidebar': ['--bg-sidebar', '--panel-2'],
  'bg.chat': ['--bg-chat', '--chat-canvas'],
  'bg.panel': ['--bg-panel', '--panel'],
  'bg.elevated': ['--bg-elevated'],
  'bg.floating': ['--bg-floating'],

  // Message Backgrounds
  'bg.message.user': ['--bg-message-user', '--user-bubble', '--gradient-user-bubble'],
  'bg.message.userSolid': ['--bg-message-user-solid'],
  'bg.message.ai': ['--bg-message-ai'],
  'bg.message.system': ['--bg-message-system'],
  'bg.message.error': ['--bg-message-error'],
  'bg.message.hover': ['--bg-message-hover'],

  // Tool Call Backgrounds
  'bg.toolCall': ['--bg-tool-call'],
  'bg.toolCallHover': ['--bg-tool-call-hover'],
  'bg.toolResult': ['--bg-tool-result'],
  'bg.toolError': ['--bg-tool-error'],
  'bg.toolSuccess': ['--bg-tool-success'],

  // Input Backgrounds
  'bg.input': ['--bg-input'],
  'bg.inputFocus': ['--bg-input-focus'],
  'bg.inputDisabled': ['--bg-input-disabled'],

  // Button Backgrounds
  'bg.btn.primary': ['--bg-btn-primary'],
  'bg.btn.primaryHover': ['--bg-btn-primary-hover'],
  'bg.btn.secondary': ['--bg-btn-secondary'],
  'bg.btn.secondaryHover': ['--bg-btn-secondary-hover'],
  'bg.btn.ghost': ['--bg-btn-ghost'],
  'bg.btn.ghostHover': ['--bg-btn-ghost-hover'],
  'bg.btn.danger': ['--bg-btn-danger'],
  'bg.btn.dangerHover': ['--bg-btn-danger-hover'],

  // Code Backgrounds
  'bg.code.inline': ['--bg-code-inline'],
  'bg.code.block': ['--bg-code-block'],
  'bg.code.header': ['--bg-code-header'],

  // Menu & Popup Backgrounds
  'bg.menu': ['--bg-menu'],
  'bg.menuItemHover': ['--bg-menu-item-hover'],
  'bg.menuItemActive': ['--bg-menu-item-active'],
  'bg.tooltip': ['--bg-tooltip'],
  'bg.modal': ['--bg-modal'],
  'bg.modalOverlay': ['--bg-modal-overlay'],

  // Selection & Highlight
  'bg.selected': ['--bg-selected', '--session-highlight'],
  'bg.selectedHover': ['--bg-selected-hover'],
  'bg.highlight': ['--bg-highlight'],
  'bg.hover': ['--bg-hover', '--hover', '--overlay-hover'],
  'bg.active': ['--bg-active', '--active', '--overlay-active'],

  // ============================================
  // Text Colors
  // ============================================
  'text.primary': ['--text-primary', '--text'],
  'text.secondary': ['--text-secondary'],
  'text.muted': ['--text-muted', '--muted'],
  'text.faint': ['--text-faint'],
  'text.error': ['--text-error'],
  'text.warning': ['--text-warning'],
  'text.success': ['--text-success'],

  // Message Text
  'text.user.primary': ['--text-user-primary'],
  'text.user.secondary': ['--text-user-secondary'],
  'text.ai.primary': ['--text-ai-primary', '--ai-text'],
  'text.ai.secondary': ['--text-ai-secondary'],
  'text.ai.thinking': ['--text-ai-thinking'],
  'text.system': ['--text-system'],

  // Status Text
  'text.llmWaiting': ['--text-llm-waiting'],
  'text.toolCalling': ['--text-tool-calling'],
  'text.toolWaiting': ['--text-tool-waiting'],
  'text.streaming': ['--text-streaming'],
  'text.timestamp': ['--text-timestamp'],
  'text.timestampHover': ['--text-timestamp-hover'],

  // Tool Call Text
  'text.tool.name': ['--text-tool-name'],
  'text.tool.args': ['--text-tool-args'],
  'text.tool.result': ['--text-tool-result'],
  'text.tool.error': ['--text-tool-error'],
  'text.tool.label': ['--text-tool-label'],

  // Sidebar Text
  'text.sidebar.title': ['--text-sidebar-title'],
  'text.sidebar.item': ['--text-sidebar-item'],
  'text.sidebar.itemActive': ['--text-sidebar-item-active'],
  'text.sidebar.itemHover': ['--text-sidebar-item-hover'],
  'text.sidebar.muted': ['--text-sidebar-muted'],
  'text.sidebar.count': ['--text-sidebar-count'],

  // Input Text
  // --editor-caret follows text.input (not accent) so editors keep a high-contrast
  // insertion cursor across full themes and Markdown live-preview surfaces.
  'text.input': ['--text-input', '--editor-caret'],
  'text.inputPlaceholder': ['--text-input-placeholder'],
  'text.inputDisabled': ['--text-input-disabled'],

  // Code Text (also maps to --hljs-* for highlight.js integration)
  'text.code.inline': ['--text-code-inline'],
  'text.code.block': ['--text-code-block'],
  'text.code.comment': ['--text-code-comment', '--hljs-comment'],
  'text.code.keyword': ['--text-code-keyword', '--hljs-keyword'],
  'text.code.string': ['--text-code-string', '--hljs-string'],
  'text.code.number': ['--text-code-number', '--hljs-number'],
  'text.code.function': ['--text-code-function', '--hljs-function'],
  'text.code.variable': ['--text-code-variable', '--hljs-variable'],
  'text.code.operator': ['--text-code-operator', '--hljs-operator'],
  'text.code.type': ['--text-code-type', '--hljs-type'],
  'text.code.property': ['--text-code-property', '--hljs-property'],
  'text.code.punctuation': ['--text-code-punctuation', '--hljs-punctuation'],

  // Link Text
  'text.link': ['--text-link'],
  'text.linkHover': ['--text-link-hover'],
  'text.linkVisited': ['--text-link-visited'],
  'text.linkExternal': ['--text-link-external'],

  // Button Text
  'text.btn.primary': ['--text-btn-primary'],
  'text.btn.secondary': ['--text-btn-secondary'],
  'text.btn.ghost': ['--text-btn-ghost'],
  'text.btn.danger': ['--text-btn-danger'],
  'text.btn.disabled': ['--text-btn-disabled'],

  // Form Text
  'text.label': ['--text-label'],
  'text.helper': ['--text-helper'],
  'text.validationError': ['--text-validation-error'],
  'text.validationSuccess': ['--text-validation-success'],

  // Menu Text
  'text.menu.item': ['--text-menu-item'],
  'text.menu.itemHover': ['--text-menu-item-hover'],
  'text.menu.itemActive': ['--text-menu-item-active'],
  'text.menu.header': ['--text-menu-header'],
  'text.tooltip': ['--text-tooltip'],
  'text.modalTitle': ['--text-modal-title'],
  'text.modalBody': ['--text-modal-body'],

  // ============================================
  // Border Colors
  // ============================================
  'border.default': ['--border-default', '--border'],
  'border.subtle': ['--border-subtle'],
  'border.strong': ['--border-strong'],
  'border.accent': ['--border-accent'],
  'border.error': ['--border-error'],
  'border.success': ['--border-success'],
  'border.warning': ['--border-warning'],
  'border.input': ['--border-input'],
  'border.inputFocus': ['--border-input-focus'],
  'border.inputError': ['--border-input-error'],
  'border.message': ['--border-message'],
  'border.messageUser': ['--border-message-user', '--user-bubble-border'],
  'border.code': ['--border-code'],
  'border.divider': ['--border-divider'],

  // ============================================
  // Shadows
  // ============================================
  'shadow.xs': ['--shadow-xs'],
  'shadow.sm': ['--shadow-sm'],
  'shadow.md': ['--shadow-md'],
  'shadow.lg': ['--shadow-lg', '--shadow'],
  'shadow.xl': ['--shadow-xl'],
  'shadow.inner': ['--shadow-inner'],
  'shadow.glow.accent': ['--shadow-glow-accent', '--shadow-glow'],
  'shadow.glow.error': ['--shadow-glow-error'],
  'shadow.elevated': ['--shadow-elevated'],
  'shadow.floating': ['--shadow-floating'],

  // ============================================
  // Effects
  // ============================================
  'effects.gradientUserBubble': ['--gradient-user-bubble'],
  'effects.gradientAiBubble': ['--gradient-ai-bubble'],
  'effects.gradientAccent': ['--gradient-accent'],
  'effects.overlayHover': ['--overlay-hover'],
  'effects.overlayActive': ['--overlay-active'],
  'effects.overlayDisabled': ['--overlay-disabled'],
  'effects.blurBackdrop': ['--blur-backdrop'],

  // ============================================
  // Semantic Colors
  // ============================================
  'color.danger': ['--color-danger', '--danger'],
  'color.dangerBg': ['--color-danger-bg'],
  'color.dangerBgHover': ['--color-danger-bg-hover'],
  'color.dangerBorder': ['--color-danger-border'],
  'color.dangerText': ['--color-danger-text'],
  'color.dangerLight': ['--color-danger-light'],
  'color.warning': ['--color-warning'],
  'color.warningBg': ['--color-warning-bg'],
  'color.warningBgHover': ['--color-warning-bg-hover'],
  'color.warningBorder': ['--color-warning-border'],
  'color.warningText': ['--color-warning-text'],
  'color.warningLight': ['--color-warning-light'],
  'color.success': ['--color-success'],
  'color.successBg': ['--color-success-bg'],
  'color.successBgHover': ['--color-success-bg-hover'],
  'color.successBorder': ['--color-success-border'],
  'color.successText': ['--color-success-text'],
  'color.successLight': ['--color-success-light'],
  'color.info': ['--color-info'],
  'color.infoBg': ['--color-info-bg'],
  'color.infoBgHover': ['--color-info-bg-hover'],
  'color.infoBorder': ['--color-info-border'],
  'color.infoText': ['--color-info-text'],
  'color.infoLight': ['--color-info-light'],

  // ============================================
  // Neutral Color Semantics
  // ============================================
  'neutral.primaryText': ['--color-neutral-primary-text', '--neutral-primary-text', '--text-color-primary'],
  'neutral.regularText': ['--color-neutral-regular-text', '--neutral-regular-text', '--text-color-regular'],
  'neutral.secondaryText': ['--color-neutral-secondary-text', '--neutral-secondary-text', '--text-color-secondary'],
  'neutral.placeholderText': ['--color-neutral-placeholder-text', '--neutral-placeholder-text', '--text-color-placeholder'],
  'neutral.disabledText': ['--color-neutral-disabled-text', '--neutral-disabled-text', '--text-color-disabled'],
  'neutral.darkerBorder': ['--color-neutral-darker-border', '--neutral-darker-border', '--border-color-darker'],
  'neutral.darkBorder': ['--color-neutral-dark-border', '--neutral-dark-border', '--border-color-dark'],
  'neutral.baseBorder': ['--color-neutral-base-border', '--neutral-base-border', '--border-color-base'],
  'neutral.lightBorder': ['--color-neutral-light-border', '--neutral-light-border', '--border-color-light'],
  'neutral.lighterBorder': ['--color-neutral-lighter-border', '--neutral-lighter-border', '--border-color-lighter'],
  'neutral.extraLightBorder': ['--color-neutral-extra-light-border', '--neutral-extra-light-border', '--border-color-extra-light'],
  'neutral.darkerFill': ['--color-neutral-darker-fill', '--neutral-darker-fill', '--fill-color-darker'],
  'neutral.darkFill': ['--color-neutral-dark-fill', '--neutral-dark-fill', '--fill-color-dark'],
  'neutral.baseFill': ['--color-neutral-base-fill', '--neutral-base-fill', '--fill-color-base'],
  'neutral.lightFill': ['--color-neutral-light-fill', '--neutral-light-fill', '--fill-color-light'],
  'neutral.lighterFill': ['--color-neutral-lighter-fill', '--neutral-lighter-fill', '--fill-color-lighter'],
  'neutral.extraLightFill': ['--color-neutral-extra-light-fill', '--neutral-extra-light-fill', '--fill-color-extra-light'],
  'neutral.blankFill': ['--color-neutral-blank-fill', '--neutral-blank-fill', '--fill-color-blank'],
  'neutral.basicBlack': ['--color-neutral-basic-black', '--neutral-basic-black', '--color-black'],
  'neutral.basicWhite': ['--color-neutral-basic-white', '--neutral-basic-white', '--color-white'],
  'neutral.transparent': ['--color-neutral-transparent', '--neutral-transparent', '--color-transparent'],
  'neutral.pageBackground': ['--color-neutral-page-background', '--neutral-page-background', '--bg-color-page'],
  'neutral.baseBackground': ['--color-neutral-base-background', '--neutral-base-background', '--bg-color-base'],
  'neutral.overlayBackground': ['--color-neutral-overlay-background', '--neutral-overlay-background', '--bg-color-overlay'],

  // ============================================
  // Diff Colors (for code diff views)
  // ============================================
  'diff.addBg': ['--diff-add-bg'],
  'diff.addText': ['--diff-add-text'],
  'diff.delBg': ['--diff-del-bg'],
  'diff.delText': ['--diff-del-text'],
  'diff.hunkBg': ['--diff-hunk-bg'],
  'diff.hunkText': ['--diff-hunk-text'],
}

const HIGHLIGHT_LEGACY_FG_VAR_MAP: Partial<Record<SemanticHighlightToken, string[]>> = {
  'syntax.plain': ['--text-code-inline', '--text-code-block'],
  'syntax.comment': ['--text-code-comment', '--hljs-comment', '--syntax-comment'],
  'syntax.keyword': ['--text-code-keyword', '--hljs-keyword', '--syntax-keyword'],
  'syntax.string': ['--text-code-string', '--hljs-string', '--syntax-string'],
  'syntax.number': ['--text-code-number', '--hljs-number', '--syntax-number'],
  'syntax.function': ['--text-code-function', '--hljs-function', '--syntax-func'],
  'syntax.variable': ['--text-code-variable', '--hljs-variable'],
  'syntax.property': ['--text-code-property', '--hljs-property'],
  'syntax.type': ['--text-code-type', '--hljs-type'],
  'syntax.operator': ['--text-code-operator', '--hljs-operator'],
  'syntax.punctuation': ['--text-code-punctuation', '--hljs-punctuation', '--syntax-punct'],
}

/**
 * 代码色 token 的**别名族 → 权威族**归一表。
 *
 * 为什么权威族是 `syntax.*`:它**就是** `SemanticHighlightToken` 本身 —— 与
 * `resolveThemeHighlights` 的原生输出结构、与它发出的 `--hg-syntax-*` 变量名
 * 一一对应。`text.code.*` 只是同一批变量在 `CSS_VAR_MAP` 里的**另一条路**:
 * 它没有对应的解析结构,写它等于隔着一层去指同一个高亮 token。两族写同一批
 * 变量,只能有一个正主,正主是有解析结构的那一族。
 *
 * `text.code.inline` / `text.code.block` 都归到 `syntax.plain`:高亮层只有一个
 * "正文码色",inline 与 block 从来是它的两个出口(见 `HIGHLIGHT_LEGACY_FG_VAR_MAP`
 * 里 `syntax.plain` 同时写这两个变量)。声明别名族的任意一个 = 声明 `syntax.plain`。
 *
 * `text.code.*` **仍然是合法声明**(别名不是弃用),只是在覆盖解析期归一 ——
 * 目录投影里会带上 `canonicalToken`,设置页据此说得出 "alias of syntax.…"。
 */
export const HIGHLIGHT_TOKEN_ALIASES: Readonly<Record<string, SemanticHighlightToken>> = {
  'text.code.inline': 'syntax.plain',
  'text.code.block': 'syntax.plain',
  'text.code.comment': 'syntax.comment',
  'text.code.keyword': 'syntax.keyword',
  'text.code.string': 'syntax.string',
  'text.code.number': 'syntax.number',
  'text.code.function': 'syntax.function',
  'text.code.variable': 'syntax.variable',
  'text.code.operator': 'syntax.operator',
  'text.code.type': 'syntax.type',
  'text.code.property': 'syntax.property',
  'text.code.punctuation': 'syntax.punctuation',
}

const SEMANTIC_HIGHLIGHT_TOKEN_SET: ReadonlySet<string> = new Set(SEMANTIC_HIGHLIGHT_TOKENS)

/** 这个 token 是别名族里的键吗(权威族返回 false)。 */
export function isHighlightAliasToken(token: string): boolean {
  return Object.prototype.hasOwnProperty.call(HIGHLIGHT_TOKEN_ALIASES, token)
}

/**
 * token → 代码色权威键。不是代码色(既不在 `syntax.*` 也不在别名表里)返回 `null`。
 *
 * 这是**唯一**一张归一表:主题层(`pickHighlightTokenOverrides`)与插件裁决层
 * (`resolvePluginThemeOverrides`)都查它,两边不可能漂移。
 */
export function canonicalHighlightToken(token: string): SemanticHighlightToken | null {
  if (SEMANTIC_HIGHLIGHT_TOKEN_SET.has(token)) return token as SemanticHighlightToken
  // hasOwnProperty，不是直接取值：`toString` 之类的原型链成员不是 token。
  if (!isHighlightAliasToken(token)) return null
  return HIGHLIGHT_TOKEN_ALIASES[token]
}

/**
 * 一个 token 能不能被覆盖(`applyTheme(…, tokenOverrides)` 与插件 L2 共用这道门)。
 *
 * 两张表的并集,不是抄一份第三张:
 *  - `CSS_VAR_MAP` —— 走 `resolvedColors` 出去的普通主题 token;
 *  - 代码色权威族 `syntax.*` —— 走 `resolvedHighlights` 出去,**从来不在**
 *    `CSS_VAR_MAP` 里(它在 `HIGHLIGHT_LEGACY_FG_VAR_MAP`)。这正是老缺陷的
 *    另一半:白名单只认 `CSS_VAR_MAP`,于是权威族连门都进不来,别名族进得来
 *    却被高亮层盖回去 —— 两族都是死键,一族死在门口,一族死在出口。
 */
export function isThemeTokenOverridable(token: string): boolean {
  if (Object.prototype.hasOwnProperty.call(CSS_VAR_MAP, token)) return true
  return canonicalHighlightToken(token) !== null
}

/**
 * 一个可覆盖 token 会写到哪些 CSS 变量上(说明性投影用,不是产出路径)。
 *
 * 代码色查的是高亮层的出口(`--hg-<token>-fg` + legacy 别名),不是 `CSS_VAR_MAP`。
 */
export function themeTokenCssVariables(token: string): string[] {
  const canonical = canonicalHighlightToken(token)
  if (canonical) {
    return [highlightVarName(canonical, 'fg'), ...(HIGHLIGHT_LEGACY_FG_VAR_MAP[canonical] || [])]
  }
  return CSS_VAR_MAP[token] ?? []
}

/**
 * 从一张 token 覆盖表里挑出代码色那部分,并归一到权威键。
 *
 * 挑出来是为了把它送进 `resolveThemeHighlights` 的**输入层**(在对比度护栏
 * 之前),而不是往成品变量上打补丁 —— 代码色变量由高亮层发出,补丁会被高亮层
 * 原样盖回去(这正是 `syntax.*` / `text.code.*` 曾经是死键的根因)。
 *
 * 同一张表里两族撞车(`syntax.keyword` 与 `text.code.keyword` 都给了值)时
 * **权威族胜**:先写别名族、再写权威族,后者覆盖前者。
 */
export function pickHighlightTokenOverrides(
  tokenOverrides?: Record<string, string>
): Partial<Record<SemanticHighlightToken, string>> | undefined {
  if (!tokenOverrides) return undefined
  const picked: Partial<Record<SemanticHighlightToken, string>> = {}
  let found = false
  for (const pass of ['alias', 'canonical'] as const) {
    for (const [token, value] of Object.entries(tokenOverrides)) {
      const canonical = canonicalHighlightToken(token)
      if (!canonical) continue
      if ((pass === 'alias') !== isHighlightAliasToken(token)) continue
      picked[canonical] = value
      found = true
    }
  }
  return found ? picked : undefined
}

type UIStyleField = keyof ResolvedUIStyle

/**
 * 语义 UI token 的**别名**输出(P4b 前叫 UI_LEGACY_VAR_MAP,曾双写 159 个 legacy 变量名)。
 *
 * P4a/P4b 把 renderer 里对那 159 个名字的全部引用换成了 `--ui-*` 正主
 * (2949 处替换 + 2663 处自指 fallback 折叠),双轨到此终止 —— 现在这里只剩两类
 * **仍有消费者**的别名,逐条 grep 过:
 *
 * 1. `--shadow-floating` / `--shadow-elevated` —— 不是 legacy,是 ui-system.md §2
 *    写进规则卡的浮层阴影档位,renderer 里 11 处按档位名引用。
 * 2. `--ui-table-*` / `--ui-category-N-*` —— 也不是 legacy,而是**比自动生成名更好听的
 *    正式名**(自动名会是 `--ui-table-border-border` / `--ui-category-1-icon-fg`)。
 *    Badge / Table / RightWorkbenchPanel 用的都是这一组短名。
 *
 * 停掉的那 159 个名字(`--accent` / `--text` / `--hover` / `--border` …)仍由
 * `variables.css` 静态定义着,只是**不再被主题覆写** —— 换句话说它们从"跟着主题变的
 * 第二套真相"退化成"没人该用的静态兜底"。新代码引用它们等于拿到不跟主题的死值。
 *
 * 注:`HIGHLIGHT_LEGACY_FG_VAR_MAP`(`--text-code-*` / `--hljs-*`)不在此列 ——
 * hljs-theme.css、diff-theme.ts、StreamingCodeBlock 仍在按那套名字消费,照旧双写。
 */
const UI_ALIAS_VAR_MAP: Partial<Record<SemanticUIToken, Partial<Record<UIStyleField, string[]>>>> = {
  'ui.surface.elevated': {
    shadow: ['--shadow-elevated'],
  },
  'ui.surface.floating': {
    shadow: ['--shadow-floating'],
  },
  'ui.table.headerBg': {
    bg: ['--ui-table-header-bg'],
  },
  'ui.table.rowBg': {
    bg: ['--ui-table-row-bg'],
  },
  'ui.table.border': {
    border: ['--ui-table-border'],
  },
  'ui.category.1.icon': {
    fg: ['--ui-category-1-icon'],
  },
  'ui.category.1.badgeBg': {
    bg: ['--ui-category-1-badge-bg'],
  },
  'ui.category.1.badgeText': {
    fg: ['--ui-category-1-badge-text'],
  },
  'ui.category.2.icon': {
    fg: ['--ui-category-2-icon'],
  },
  'ui.category.2.badgeBg': {
    bg: ['--ui-category-2-badge-bg'],
  },
  'ui.category.2.badgeText': {
    fg: ['--ui-category-2-badge-text'],
  },
  'ui.category.3.icon': {
    fg: ['--ui-category-3-icon'],
  },
  'ui.category.3.badgeBg': {
    bg: ['--ui-category-3-badge-bg'],
  },
  'ui.category.3.badgeText': {
    fg: ['--ui-category-3-badge-text'],
  },
  'ui.category.4.icon': {
    fg: ['--ui-category-4-icon'],
  },
  'ui.category.4.badgeBg': {
    bg: ['--ui-category-4-badge-bg'],
  },
  'ui.category.4.badgeText': {
    fg: ['--ui-category-4-badge-text'],
  },
  'ui.category.5.icon': {
    fg: ['--ui-category-5-icon'],
  },
  'ui.category.5.badgeBg': {
    bg: ['--ui-category-5-badge-bg'],
  },
  'ui.category.5.badgeText': {
    fg: ['--ui-category-5-badge-text'],
  },
  'ui.category.6.icon': {
    fg: ['--ui-category-6-icon'],
  },
  'ui.category.6.badgeBg': {
    bg: ['--ui-category-6-badge-bg'],
  },
  'ui.category.6.badgeText': {
    fg: ['--ui-category-6-badge-text'],
  },
  'ui.category.7.icon': {
    fg: ['--ui-category-7-icon'],
  },
  'ui.category.7.badgeBg': {
    bg: ['--ui-category-7-badge-bg'],
  },
  'ui.category.7.badgeText': {
    fg: ['--ui-category-7-badge-text'],
  },
}

function highlightVarName(token: SemanticHighlightToken, suffix: string): string {
  return `--hg-${token.replace(/\./g, '-')}-${suffix}`
}

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)
}

function uiVarName(token: SemanticUIToken, suffix: UIStyleField): string {
  return `--${camelToKebab(token).replace(/\./g, '-')}-${suffix}`
}

function neutralRgbVarName(token: ThemeNeutralColorToken): string {
  return `--color-neutral-${camelToKebab(token)}-rgb`
}

function getFontStyleParts(fontStyle: string | undefined): {
  fontStyle: string
  fontWeight: string
  textDecoration: string
} {
  const value = fontStyle || 'normal'
  return {
    fontStyle: value.includes('italic') ? 'italic' : 'normal',
    fontWeight: value.includes('bold') ? '700' : '400',
    textDecoration: value.includes('underline') ? 'underline' : 'none',
  }
}

function addHighlightCSSVariables(
  result: Record<string, string>,
  resolvedHighlights: Record<SemanticHighlightToken, ResolvedHighlightStyle>
): void {
  for (const [token, style] of Object.entries(resolvedHighlights) as Array<[SemanticHighlightToken, ResolvedHighlightStyle]>) {
    const fontStyleParts = getFontStyleParts(style.fontStyle)

    if (style.fg) {
      result[highlightVarName(token, 'fg')] = style.fg
      const legacyVars = HIGHLIGHT_LEGACY_FG_VAR_MAP[token] || []
      for (const cssVar of legacyVars) {
        result[cssVar] = style.fg
      }
    }

    result[highlightVarName(token, 'bg')] = style.bg || 'transparent'
    result[highlightVarName(token, 'font-style')] = fontStyleParts.fontStyle
    result[highlightVarName(token, 'font-weight')] = fontStyleParts.fontWeight
    result[highlightVarName(token, 'text-decoration')] = fontStyleParts.textDecoration
  }
}

function addUICSSVariables(
  result: Record<string, string>,
  resolvedUI: Record<SemanticUIToken, ResolvedUIStyle>
): void {
  // Two UI tokens writing different values to the same legacy variable means
  // last-writer-wins by iteration order — the class of bug where --bg-input
  // silently diverged from ui.surface.input. Surface it instead of hiding it.
  const aliasWriters = new Map<string, { token: SemanticUIToken; value: string }>()

  for (const [token, style] of Object.entries(resolvedUI) as Array<[SemanticUIToken, ResolvedUIStyle]>) {
    for (const field of ['fg', 'bg', 'border', 'ring', 'shadow'] as UIStyleField[]) {
      const value = style[field]
      if (!value) continue

      result[uiVarName(token, field)] = value

      const aliasVars = UI_ALIAS_VAR_MAP[token]?.[field] || []
      for (const cssVar of aliasVars) {
        const previous = aliasWriters.get(cssVar)
        if (previous && previous.value !== value) {
          log.warn('conflicting alias css variable', {
            cssVar,
            previousToken: previous.token,
            previousValue: previous.value,
            token,
            value,
          })
        }
        aliasWriters.set(cssVar, { token, value })
        result[cssVar] = value
      }
    }
  }
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100) / 100}%`
}

function addTableMixCSSVariables(result: Record<string, string>): void {
  const tableBg = result['--ui-surface-chat-bg'] || result['--ui-surface-app-bg'] || result['--panel'] || result['--bg']
  const primaryText = result['--ui-text-primary-fg'] || result['--text']
  const mutedText = result['--ui-text-muted-fg'] || result['--muted'] || primaryText
  if (!tableBg || !primaryText) return

  result['--app-table-head-mix-percent'] = formatPercent(
    guaranteeMinMixOpacity(primaryText, tableBg, 4, 0.02)
  )
  result['--app-table-border-mix-percent'] = formatPercent(
    guaranteeMinMixOpacity(primaryText, tableBg, 5, 0.02)
  )
  result['--app-table-strong-border-mix-percent'] = formatPercent(
    guaranteeMinMixOpacity(primaryText, tableBg, 7, 0.028)
  )
  if (mutedText) {
    result['--app-table-stripe-mix-percent'] = formatPercent(
      guaranteeMinMixOpacity(mutedText, tableBg, 5, 0.014)
    )
  }
}

/**
 * 区域交互态墨阶下沉(UI 系统收敛 P4)。
 *
 * 在这里而不是 resolver 里,理由与 `addTableMixCSSVariables` 相同:它是**已解析
 * 变量之上的派生**,不参与 resolver 的对比度修复回路 —— 把 color-mix 表达式塞回
 * `resolveThemeUI` 会让 `readableAgainst` 拿不到可解析的底色。
 *
 * sidebar 的 item hover/active 底**刻意盖掉** resolver 的通用 state ramp:
 * 通用 ramp 是 OKLCH 亮度偏移(实测 ΔRGB 6~17),而列表行要的是同一条墨色上的
 * 等比阶梯(ΔRGB 40~83),两者相差近一倍。盖的是 renderer 里已经跑了很久的那条
 * 派生链的**原值**,不是新设计。fg 侧不动(resolver 的对比度修复照旧)。
 */
export const REGION_OVERLAY_VAR_NAMES = [
  '--ui-sidebar-row-ink',
  '--ui-sidebar-row-fg',
  '--ui-sidebar-rail-bg',
  '--ui-sidebar-rail-hover-bg',
  '--ui-sidebar-rail-active-bg',
  '--ui-sidebar-rail-muted-fg',
  '--ui-settings-row-hover-bg',
  '--ui-settings-row-active-bg',
  '--ui-state-hover-accent-bg',
  '--ui-state-hover-accent-strong-bg',
  '--ui-state-hover-raised-bg',
] as const

function addRegionOverlayCSSVariables(result: Record<string, string>): void {
  const ink = result['--ui-text-primary-fg'] || result['--text-primary'] || result['--text']
  const sidebarBg = result['--ui-sidebar-surface-bg']
    || result['--ui-surface-sidebar-bg']
    || result['--ui-surface-app-bg']
    || result['--bg-app']
  const accent = result['--ui-accent-primary-fg'] || result['--color-primary'] || result['--accent']
  // 设置区的行底画在 `--settings-paper-3`(= panel 面)上。
  const settingsSurface = result['--ui-surface-panel-bg'] || result['--bg-panel'] || result['--ui-surface-elevated-bg']

  const assign = (name: string, value: string | undefined): void => {
    if (value) result[name] = value
  }

  if (ink && sidebarBg) {
    result['--ui-sidebar-row-ink'] = ink
    assign('--ui-sidebar-row-fg', deriveRegionOverlay(ink, sidebarBg, 'sidebarRowFg'))
    assign('--ui-sidebar-item-hover-bg', deriveRegionOverlay(ink, sidebarBg, 'sidebarRowHover'))
    assign('--ui-sidebar-item-active-bg', deriveRegionOverlay(ink, sidebarBg, 'sidebarRowActive'))
    // rail 自己是一层 2.5% 的墨底,它上面的行状态原本是**半透明叠加**,合成后
    // 等于"叠在 rail 底上"而不是"叠在侧栏底上"。解析成实色时必须以 rail 底为基,
    // 否则 hover/当前项会整体淡掉一档(实测差 ~2.4% 墨)。
    const railBg = deriveRegionOverlay(ink, sidebarBg, 'sidebarRailBg')
    assign('--ui-sidebar-rail-bg', railBg)
    const railBase = railBg || sidebarBg
    assign('--ui-sidebar-rail-hover-bg', deriveRegionOverlay(ink, railBase, 'sidebarRailHover'))
    assign('--ui-sidebar-rail-active-bg', deriveRegionOverlay(ink, railBase, 'sidebarRailActive'))
    assign('--ui-sidebar-rail-muted-fg', deriveRegionOverlay(ink, railBase, 'sidebarRailMuted'))
  }

  if (accent && settingsSurface) {
    assign('--ui-settings-row-hover-bg', deriveRegionOverlay(accent, settingsSurface, 'settingsRowHover'))
    assign('--ui-settings-row-active-bg', deriveRegionOverlay(accent, settingsSurface, 'settingsRowActive'))
    // 通用 accent hover 族(G6)。同一条配方链、同一张基面(panel),只是这两档
    // 不归设置区专有 —— 全窗任何"叠 accent 淡底"的 hover / 强调底都引它,
    // 组件端不再各写一次 color-mix(存量 99 处的根因就是没有这枚 token)。
    assign('--ui-state-hover-accent-bg', deriveRegionOverlay(accent, settingsSurface, 'stateHoverAccent'))
    assign(
      '--ui-state-hover-accent-strong-bg',
      deriveRegionOverlay(accent, settingsSurface, 'stateHoverAccentStrong')
    )
  }

  // G8:「hover 底上再进一档」。基面是 **hover 底本身**(不是区域底色)——
  // 给的是"静息已经在 hover 底上"的那一批控件。hover 底由 resolver 的 state ramp
  // 解析,这里读它的实色再压一层墨,所以必须排在 `deriveStateOverlays` 之后。
  const hoverSurface = result['--ui-state-hover-bg']
  if (ink && hoverSurface) {
    assign('--ui-state-hover-raised-bg', deriveRegionOverlay(ink, hoverSurface, 'stateHoverRaised'))
  }
}

/**
 * Extract RGB components from a hex color
 * @param hex - Hex color like "#282726"
 * @returns RGB triplet like "40, 39, 38" or null if invalid
 */
function hexToRgbTriplet(hex: string): string | null {
  if (!hex || !hex.startsWith('#')) return null

  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return null

  const r = parseInt(result[1], 16)
  const g = parseInt(result[2], 16)
  const b = parseInt(result[3], 16)

  return `${r}, ${g}, ${b}`
}

/**
 * Generate CSS variables string from resolved theme
 * @param resolvedTheme - Map of theme property path -> resolved color value
 * @returns CSS variable declarations as a string
 */
export function generateCSSVariables(
  resolvedTheme: Record<string, string>,
  resolvedHighlights?: Record<SemanticHighlightToken, ResolvedHighlightStyle>,
  resolvedUI?: Record<SemanticUIToken, ResolvedUIStyle>
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [themePath, value] of Object.entries(resolvedTheme)) {
    const cssVars = CSS_VAR_MAP[themePath]
    if (cssVars) {
      for (const cssVar of cssVars) {
        result[cssVar] = value
      }
    }
  }

  if (resolvedHighlights) {
    addHighlightCSSVariables(result, resolvedHighlights)
  }

  if (resolvedUI) {
    addUICSSVariables(result, resolvedUI)
  }

  addTableMixCSSVariables(result)
  addRegionOverlayCSSVariables(result)

  // Generate RGB triplet variables for transparency patterns
  // These are used in rgba(var(--bg-rgb), opacity) patterns
  const bgAppColor = result['--bg-app'] || resolvedTheme['bg.app']
  if (bgAppColor) {
    const bgRgb = hexToRgbTriplet(bgAppColor)
    if (bgRgb) {
      result['--bg-rgb'] = bgRgb
    }
  }

  // Use theme's accentRgb if defined, otherwise extract from hex
  if (!result['--accent-rgb']) {
    const accentColor = resolvedTheme['accent']
    if (accentColor) {
      const accentRgb = hexToRgbTriplet(accentColor)
      if (accentRgb) {
        result['--accent-rgb'] = accentRgb
      }
    }
  }

  // Also generate for specific colors that need RGB triplets
  const sidebarColor = result['--bg-sidebar'] || resolvedTheme['bg.sidebar']
  if (sidebarColor) {
    const sidebarRgb = hexToRgbTriplet(sidebarColor)
    if (sidebarRgb) {
      result['--sidebar-rgb'] = sidebarRgb
    }
  }

  // Generate RGB triplets for semantic colors (danger, warning, success, info)
  // These enable rgba(var(--color-*-rgb), opacity) patterns in components
  const semanticColorPaths: [string, string][] = [
    ['primary', '--color-primary-rgb'],
    ['primary', '--primary-rgb'],
    ['color.danger', '--color-danger-rgb'],
    ['color.warning', '--color-warning-rgb'],
    ['color.success', '--color-success-rgb'],
    ['color.info', '--color-info-rgb'],
    ['text.error', '--text-error-rgb'],
    ['text.warning', '--text-warning-rgb'],
    ['text.success', '--text-success-rgb'],
  ]

  for (const [path, cssVar] of semanticColorPaths) {
    const color = resolvedTheme[path]
    if (color) {
      const rgb = hexToRgbTriplet(color)
      if (rgb) result[cssVar] = rgb
    }
  }

  for (const token of THEME_NEUTRAL_COLOR_TOKENS) {
    const color = resolvedTheme[`neutral.${token}`]
    if (!color) continue

    const rgb = hexToRgbTriplet(color)
    if (rgb) result[neutralRgbVarName(token)] = rgb
  }

  return result
}

/**
 * Generate CSS style string from CSS variables
 */
export function generateCSSStyleString(
  cssVariables: Record<string, string>
): string {
  return Object.entries(cssVariables)
    .map(([varName, value]) => `${varName}: ${value};`)
    .join('\n')
}

/**
 * Get all CSS variable names that the theme system controls
 */
export function getAllCSSVariableNames(): string[] {
  const allVars = new Set<string>()
  for (const vars of Object.values(CSS_VAR_MAP)) {
    for (const varName of vars) {
      allVars.add(varName)
    }
  }
  for (const token of SEMANTIC_HIGHLIGHT_TOKENS) {
    allVars.add(highlightVarName(token, 'fg'))
    allVars.add(highlightVarName(token, 'bg'))
    allVars.add(highlightVarName(token, 'font-style'))
    allVars.add(highlightVarName(token, 'font-weight'))
    allVars.add(highlightVarName(token, 'text-decoration'))
  }
  for (const token of SEMANTIC_UI_TOKENS) {
    for (const field of ['fg', 'bg', 'border', 'ring', 'shadow'] as UIStyleField[]) {
      allVars.add(uiVarName(token, field))
    }
    for (const varsByField of Object.values(UI_ALIAS_VAR_MAP[token] || {})) {
      for (const varName of varsByField || []) {
        allVars.add(varName)
      }
    }
  }
  for (const varName of REGION_OVERLAY_VAR_NAMES) {
    allVars.add(varName)
  }
  allVars.add('--color-primary-rgb')
  allVars.add('--primary-rgb')
  for (const token of THEME_NEUTRAL_COLOR_TOKENS) {
    allVars.add(neutralRgbVarName(token))
  }
  return Array.from(allVars)
}
