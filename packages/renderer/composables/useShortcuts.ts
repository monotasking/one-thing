import { platformApi } from '@/platform'
/**
 * Global Keyboard Shortcuts Composable
 *
 * Provides global keyboard shortcut handling for the application.
 * Shortcuts are configurable via settings.
 */

import { onMounted, onUnmounted } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useSessionsStore } from '../stores/sessions'
import type { KeyboardShortcut, ShortcutSettings } from '@/types'
import { isEditableTarget } from '@/utils/editable-target'
import { isEventInsideTerminal } from '@/components/terminal/terminal-dom'

/**
 * Check if a keyboard event matches a shortcut configuration
 */
export function matchShortcut(event: KeyboardEvent, shortcut: KeyboardShortcut | undefined): boolean {
  if (!shortcut || !shortcut.key) return false
  if (shortcut.sequence) return false

  // Normalize the key for comparison
  const eventKey = event.key.toLowerCase()
  const shortcutKey = shortcut.key.toLowerCase()

  // Check if keys match
  if (eventKey !== shortcutKey) return false

  // Check modifier keys
  if (!!shortcut.ctrlKey !== event.ctrlKey) return false
  if (!!shortcut.altKey !== event.altKey) return false
  if (!!shortcut.shiftKey !== event.shiftKey) return false
  if (!!shortcut.metaKey !== event.metaKey) return false

  return true
}

/** 是否带修饰键。不带修饰键的快捷键是「裸键」，在输入框里必须让位给打字。 */
export function hasModifier(shortcut: KeyboardShortcut | undefined): boolean {
  return !!(shortcut?.ctrlKey || shortcut?.altKey || shortcut?.metaKey)
}

/**
 * Format a shortcut for display
 */
export function formatShortcut(shortcut: KeyboardShortcut | undefined): string {
  if (!shortcut || !shortcut.key) return ''
  if (shortcut.sequence === 'double-shift') return 'Double Shift'

  const parts: string[] = []

  if (shortcut.ctrlKey) parts.push('Ctrl')
  if (shortcut.altKey) parts.push('Alt')
  if (shortcut.shiftKey) parts.push('Shift')
  if (shortcut.metaKey) parts.push('Cmd')

  let key = shortcut.key
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()

  parts.push(key)

  return parts.join(' + ')
}

export function resolveSearchEverywhereShortcut(
  shortcuts: Pick<ShortcutSettings, 'searchEverywhere' | 'searchOverlay'> | undefined,
): KeyboardShortcut | undefined {
  return shortcuts?.searchEverywhere ?? shortcuts?.searchOverlay
}

/**
 * ⌘1..9 / Ctrl+1..9 → 按列表序切空间(批 B5,
 * docs/design/workspace-spaces-2026-08.md)。返回 0 起的下标,不是这个组合就
 * 返回 null。
 *
 * 这几个键位是**空的**:⌘1..9 原本按位置切页签,随多页签一起退役(U2),此后
 * 注释里明写着"留白,不抢"。全仓再无第二处 ⌘/Ctrl+数字(菜单只有 ⌘W/⌘T/⌘,;
 * 编辑器那三条是 ⌘⇧7/8/9)。
 *
 * ⌥ / ⇧ 一律不认:⌘⌥数字与 ⌘⇧数字要留给别人,顺手吃掉等于把冲突推给将来。
 * 与 ⌘, 一样是**固定键位**,不进 `ShortcutSettings` —— 那张表是"一个动作一个
 * 键",装不下一段 9 键的区间。
 */
export function spaceShortcutIndex(event: KeyboardEvent): number | null {
  if (!event.metaKey && !event.ctrlKey) return null
  if (event.altKey || event.shiftKey) return null
  if (!/^[1-9]$/.test(event.key)) return null
  return Number(event.key) - 1
}

export interface ShortcutHandlers {
  onNewChat?: () => void
  onCloseChat?: () => void
  onToggleSidebar?: () => void
  onFocusInput?: () => void
  onOpenSettings?: () => void
  onSearchEverywhere?: () => void
  onToggleTodoPlanWindow?: () => void
  onToggleTodoPlan?: () => void
  /** ⌘1..9 切空间。参数是 0 起的下标(⌘1 = 列表第一个空间)。 */
  onSelectSpace?: (index: number) => void
}

/**
 * Setup global keyboard shortcuts
 */
export function useShortcuts(handlers: ShortcutHandlers = {}) {
  const settingsStore = useSettingsStore()
  const sessionsStore = useSessionsStore()

  function handleGlobalKeydown(event: KeyboardEvent) {
    // Inside a terminal EVERY key belongs to the shell (Cmd+K clears, Cmd+1..9
    // are apps in the user's muscle memory) — skip all DOM-level shortcuts.
    // P2 will carve out an explicit pass-through whitelist (toggleTerminal…).
    if (isEventInsideTerminal(event.target)) return

    // Skip if we're in an input field (except for specific shortcuts)
    const isInInput = isEditableTarget(event.target)

    const shortcuts = settingsStore.settings?.general?.shortcuts
    if (!shortcuts) return

    // 输入框内只放行带修饰键的快捷键：裸键（用户可以把 Space、单字母绑上去）
    // 若照常 preventDefault，会直接把用户正在打的字吞掉。
    const match = (shortcut: KeyboardShortcut | undefined): boolean => {
      if (!matchShortcut(event, shortcut)) return false
      return !isInInput || hasModifier(shortcut)
    }

    if (match(resolveSearchEverywhereShortcut(shortcuts))) {
      event.preventDefault()
      if (handlers.onSearchEverywhere) {
        handlers.onSearchEverywhere()
      } else {
        platformApi?.toggleSearchWindow?.()
      }
      return
    }

    if (match(shortcuts.toggleTodoPlanWindow)) {
      event.preventDefault()
      if (handlers.onToggleTodoPlanWindow) {
        handlers.onToggleTodoPlanWindow()
      } else {
        platformApi?.toggleTodoPlanWindow?.({
          activation: 'preserve-current-app',
          preserveMainWindowVisibility: true,
        })
      }
      return
    }

    // New Chat - works everywhere
    if (match(shortcuts.newChat)) {
      event.preventDefault()
      if (handlers.onNewChat) {
        handlers.onNewChat()
      } else {
        // Default: create new session
        sessionsStore.createSession('')
      }
      return
    }



    // Toggle Sidebar - works everywhere
    if (match(shortcuts.toggleSidebar)) {
      event.preventDefault()
      if (handlers.onToggleSidebar) {
        handlers.onToggleSidebar()
      }
      return
    }

    if (match(shortcuts.toggleTodoPlan)) {
      event.preventDefault()
      if (handlers.onToggleTodoPlan) {
        handlers.onToggleTodoPlan()
      } else {
        window.dispatchEvent(new CustomEvent('todo-plan:toggle-card'))
      }
      return
    }

    // Focus Input - only when not already in input
    if (!isInInput && matchShortcut(event, shortcuts.focusInput)) {
      event.preventDefault()
      if (handlers.onFocusInput) {
        handlers.onFocusInput()
      }
      return
    }

    // Open Settings - Cmd+, (macOS) or Ctrl+, (Windows)
    // This is a hardcoded shortcut, not configurable
    if ((event.metaKey || event.ctrlKey) && event.key === ',') {
      event.preventDefault()
      if (handlers.onOpenSettings) {
        handlers.onOpenSettings()
      }
      return
    }

    // ⌘1..9(按位置切页签)随多页签一起退役(U2,product-two-forms-chatgpt-shell.md
    // D4):一格恰好一条会话,没有"第 N 张"可切。空出来的键位批 B5 给了空间切换
    // (Arc 的口径:数字键换的是空间,不是标签页)。
    //
    // 输入框里照样生效 —— 带修饰键的组合本来就不与打字争(同 ⌘,)。
    const spaceIndex = handlers.onSelectSpace ? spaceShortcutIndex(event) : null
    if (spaceIndex !== null) {
      event.preventDefault()
      handlers.onSelectSpace?.(spaceIndex)
      return
    }

    // Prevent Cmd+A (Select All) when not in input/textarea
    // This prevents selecting all text on the page
    if ((event.metaKey || event.ctrlKey) && event.key === 'a' && !isInInput) {
      event.preventDefault()
      return
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleGlobalKeydown)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handleGlobalKeydown)
  })

  return {
    matchShortcut,
    formatShortcut,
  }
}
