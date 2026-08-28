import type { MessageKey } from './index'

/**
 * 英文文案字典。类型是 Record<MessageKey, string> —— 漏译 = 编译期报错,
 * 不需要任何运行时兜底,也不许写占位串糊弄(缺了就是红的,补上就是绿的)。
 * 键的次序与 zh.ts 一一对应,便于两边对读。
 */
export const en: Record<MessageKey, string> = {
  /* ── common ───────────────────────────────────────────────────────── */
  'common.close': 'Close',
  'common.closeTab': 'Close {label}',
  'common.confirm': 'Confirm',
  'common.cancel': 'Cancel',

  /* ── top bar ──────────────────────────────────────────────────────── */
  'topbar.newSession': 'New session',

  /* ── composer ─────────────────────────────────────────────────────── */
  'composer.placeholder': 'Say something…',
  'composer.send': 'Send',

  /* ── dock & context menu ──────────────────────────────────────────── */
  'dock.add': 'Add',
  'dock.openWith': 'Open as',
  'dock.openDefault': 'Follow default',
  'dock.openStage': 'Popup',
  'dock.openFloat': 'Float',
  'dock.openPinned': 'Pin to the right',
  'dock.edge': 'Dock edge',
  'dock.edgeBottom': 'Bottom',
  'dock.edgeTop': 'Top',
  'dock.edgeLeft': 'Left',
  'dock.edgeRight': 'Right',
  'dock.align': 'Position along edge',
  'dock.alignStart': 'Start',
  'dock.alignCenter': 'Center',
  'dock.alignEnd': 'End',
  'dock.size': 'Size',
  'dock.sizeSm': 'Small',
  'dock.sizeMd': 'Medium',
  'dock.sizeLg': 'Large',
  'dock.settings': 'Dock settings…',

  /* ── dock tiles ───────────────────────────────────────────────────── */
  'item.files': 'Files',
  'item.diff': 'Changes',
  'item.terminal': 'Terminal',
  'item.browser': 'Browser',
  'item.sessions': 'Sessions',
  'item.search': 'Search',
  'item.settings': 'Settings',

  /* ── stage / pinned ───────────────────────────────────────────────── */
  'stage.pinToEdge': 'Pin to edge',
  'stage.toFloat': 'Float',
  'float.toStage': 'To stage',
  'float.toDock': 'Back to Dock',
  'pinned.label': 'Pinned panel',
  'pinned.collapse': 'Collapse pinned panel',
  'pinned.expand': 'Expand pinned panel',

  /* ── settings ─────────────────────────────────────────────────────── */
  'settings.dockDisplay': 'Dock display',
  'settings.dockDisplayHint': 'The Dock always floats above the UI; on auto-hide it slides out when you reach that edge',
  'settings.dockAlways': 'Always shown',
  'settings.dockAutohide': 'Auto-hide',
  'settings.defaultOpen': 'Default open behavior',
  'settings.defaultOpenHint': 'Where a Dock icon lands: a popup opens centered, a float window can be dragged and resized, a pin stays on the right',
  'settings.overrideNote': 'Each icon can override this from its context menu',
  'settings.workdir': 'Working directory',
  'settings.language': '语言 / Language',
  'settings.localeSystem': 'System',
  'settings.localeZh': '中文',
  'settings.localeEn': 'English',

  /* ── browser shell ────────────────────────────────────────────────── */
  'browser.pagePlaceholder': 'Page placeholder',

  /* ── session exposé ───────────────────────────────────────────────── */
  'expose.title': 'Session overview',
  'expose.searchPlaceholder': 'Search sessions, sections, messages',
  'expose.searchLabel': 'Search sessions',
  'expose.newProject': 'Project',
  'expose.sessionCount': '{count} sessions',
  'expose.sessionCountOne': '{count} session',
  'expose.newSessionIn': 'New session in {name}',
  'expose.noMatchingSessions': 'No matching sessions',
  'expose.groupCollab': 'Collaboration',
  'expose.groupLoose': 'Loose sessions',
  'expose.groupLoosePath': 'not in any project',

  /* ── list view ────────────────────────────────────────────────────── */
  'list.backToOverview': '‹ Overview',
  'list.here': '{group} · {count} sessions',
  'list.hereOne': '{group} · {count} session',
  'list.filter': 'Filter within this group',
  'list.bucketThisWeek': 'This week',
  'list.bucketEarlier': 'Earlier',

  /* ── search results ───────────────────────────────────────────────── */
  'search.youPrefix': 'You: ',
  'search.empty': 'Type to search sessions, sections and messages',

  /* ── quick look ───────────────────────────────────────────────────── */
  'quicklook.enter': 'Open ↵',
  'quicklook.dismiss': 'Dismiss',
  'quicklook.hintSwitch': 'switch session',
  'quicklook.hintEnter': 'open',

  /* ── session kinds ────────────────────────────────────────────────── */
  'kind.chatBadge': 'C',
  'kind.roomBadge': 'R',
  'kind.dmBadge': 'D',
  'kind.chat': 'Chat',
  'kind.room': 'Room',
  'kind.dm': 'Direct message',

  /* ── session card ─────────────────────────────────────────────────── */
  'card.passed': 'passed',
  'card.preview': 'Quick Look',

  /* ── piano-key outline ────────────────────────────────────────────── */
  'toc.title': 'Session outline',
  'toc.jumpTo': 'Jump to message {index}',

  /* ── shortcut glyphs (same in both languages, still dictionary-owned) ─ */
  'shortcut.palette': '⌘P',
  'shortcut.left': '←',
  'shortcut.right': '→',
  'shortcut.space': 'Space',
  'shortcut.esc': 'Esc',
  'shortcut.enter': '↵',
}
