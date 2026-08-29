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
  'composer.placeholder': 'Say something… ( @ files · / commands )',
  'composer.send': 'Send',
  'composer.attach': 'Add attachment',
  'composer.attachments': 'Attachments',
  'composer.removeAttachment': 'Remove attachment',
  'composer.model': 'Pick a model: {name}',
  'composer.modelSearch': 'Search models or providers…',
  'composer.headFiles': 'Reference a file',
  'composer.headCommands': 'Commands',
  'composer.hintFile': '⏎ reference',
  'composer.hintCommand': '⏎ use',
  'composer.noMatch': 'No match',
  'composer.context': 'Context usage',

  /* ── readouts ─────────────────────────────────────────────────────── */
  'meter.context': 'Context',
  'meter.contextValue': '{used} / {max} · {pct}%',
  'meter.tokens': 'Tokens',
  'meter.tokensValue': '↑{sent} ↓{received}',
  'meter.cost': 'Spend',
  'meter.costValue': '${cost}',
  'meter.cache': 'Cache hits',
  'meter.cacheValue': '{pct}% · saved ${saved}',

  /* ── status bar / run drawer ──────────────────────────────────────── */
  'status.toggle': 'Run status',
  'status.running': 'Running {name} · {step}',
  'status.done': 'Done · {name} · {count} steps',

  /* ── ask form ─────────────────────────────────────────────────────── */
  'ask.multi': 'multi',
  'ask.reject': 'Decline',
  'ask.rejected': '(declined these questions)',
  'ask.other': 'Other',
  'ask.otherPlaceholder': 'Type right here, enter to answer',
  'ask.hint': '‹ › switch · click again to clear · esc declines all',
  'ask.submit': 'Submit {done}/{total}',
  'ask.step': '{index}/{total}',
  'ask.prev': 'Previous question',
  'ask.next': 'Next question',
  'ask.joiner': ', ',

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
  'shelf.labelLeft': 'Left shelf',
  'shelf.labelRight': 'Right shelf',
  'shelf.labelTop': 'Top shelf',
  'shelf.labelBottom': 'Bottom shelf',
  'shelf.collapse': 'Collapse {name}',
  'shelf.popOut': 'Pop {name} out as a window',
  'shelf.closeAll': 'Close all in {name}',
  'shelf.expand': 'Expand {name}',
  'shelf.resize': 'Resize {name}',

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

  'settings.sectionGeneral': 'General',
  'settings.sectionDock': 'Dock',
  'settings.sectionKeymap': 'Shortcuts',

  /* ── shortcut settings ────────────────────────────────────────────── */
  'keymap.hint': 'Click a binding, then press the combo; Esc cancels, Backspace unbinds',
  'keymap.recording': 'Press a combo…',
  'keymap.unbound': 'Unbound',
  'keymap.conflict': 'Conflicts with “{name}”',
  'keymap.reset': 'Reset',
  'keymap.resetOf': 'Reset the default combo for “{name}”',
  'keymap.recordOf': 'Set a shortcut for “{name}”',
  'keymap.structuralNote': 'Esc stepping back, the overview arrow keys and Enter, and float-window dragging are part of the layout grammar and are not rebindable',

  /* ── browser shell ────────────────────────────────────────────────── */
  'dock.previewOf': '{name} preview',

  'browser.pagePlaceholder': 'Page placeholder',

  /* ── session exposé ───────────────────────────────────────────────── */
  'expose.searchPlaceholder': 'Search sessions, sections, messages',
  'expose.searchLabel': 'Search sessions',
  'expose.newProject': 'Project',
  'expose.sessionCount': '{count} sessions',
  'expose.sessionCountOne': '{count} session',
  'expose.newSessionIn': 'New session in {name}',
  'expose.noMatchingSessions': 'No matching sessions',
  'expose.groupCollab': 'Collaboration',
  'expose.groupCollabPath': 'rooms and direct messages',
  'expose.groupLoose': 'Loose sessions',
  'expose.groupLoosePath': 'no working directory',
  'expose.loading': 'Loading sessions…',
  'expose.emptyTitle': 'No sessions yet',
  'expose.emptyHint': 'Start a session in onething and it shows up here',
  'expose.disconnectedTitle': 'Not connected to a core',
  'expose.disconnectedHint': 'Sessions come from the core running on this machine; {error}',

  /* ── list view ────────────────────────────────────────────────────── */
  'list.backToOverview': '‹ Overview',
  'list.here': '{group} · {count} sessions',
  'list.hereOne': '{group} · {count} session',
  'list.filter': 'Filter within this group',
  'list.bucketThisWeek': 'This week',
  'list.bucketEarlier': 'Earlier',

  /* ── search results (SearchResults: the overview filter bar's three-layer hits) ─ */

  /* ── search panel (search/: one search row + one flat hit list) ───── */
  'search.placeholder': 'Search files, sections, messages, sessions…',
  'search.label': 'Search',
  'search.scopeLabel': 'Search scope',
  'search.scopeAll': 'All',
  'search.scopeSessions': 'Sessions',
  'search.scopeFiles': 'Files',
  'search.resultsLabel': 'Results',
  'search.noResults': 'No results',
  /* Badge text rides the same fixed-width mono chip as file-type codes (TS/MD),
   * so English uses code-style caps that fit the chip; zh uses 会话/消息. */
  'search.badgeSession': 'CHAT',
  'search.badgeMessage': 'MSG',
  'search.openedFile': 'Opened {file}',

  /* ── quick look ───────────────────────────────────────────────────── */
  'quicklook.enter': 'Open ↵',
  'quicklook.dismiss': 'Dismiss',
  'quicklook.hintSwitch': 'switch session',
  'quicklook.hintEnter': 'open',
  'quicklook.loading': 'Loading messages…',
  'quicklook.empty': 'No messages in this session yet',
  'quicklook.roleUser': 'You',
  'quicklook.roleAssistant': 'AI',
  'quicklook.roleSystem': 'System',
  'quicklook.roleError': 'Error',

  /* ── session kinds ────────────────────────────────────────────────── */
  'kind.chatBadge': 'C',
  'kind.roomBadge': 'R',
  'kind.dmBadge': 'D',
  'kind.workBadge': 'W',
  'kind.agentBadge': 'A',
  'kind.chat': 'Chat',
  'kind.room': 'Room',
  'kind.dm': 'Direct message',
  'kind.work': 'Dispatched work',
  'kind.agent': 'Agent run',

  /* ── session card ─────────────────────────────────────────────────── */
  'card.preview': 'Quick Look',

  /* ── piano-key outline ────────────────────────────────────────────── */
  'toc.title': 'Session outline',
  'toc.jumpTo': 'Jump to message {index}',
  'toc.empty': 'No outline for this session yet',
  'toc.chapterTask': 'Task',
  'toc.chapterQuestion': 'Question',
  'time.clock': '{hh}:{mm}',
  'time.yesterday': 'Yesterday',
  'time.date': '{month}/{day}',
  'time.weekday0': 'Sun',
  'time.weekday1': 'Mon',
  'time.weekday2': 'Tue',
  'time.weekday3': 'Wed',
  'time.weekday4': 'Thu',
  'time.weekday5': 'Fri',
  'time.weekday6': 'Sat',

  /* ── shortcut glyphs (same in both languages, still dictionary-owned) ─ */
  'shortcut.left': '←',
  'shortcut.right': '→',
  'shortcut.space': 'Space',
  'shortcut.esc': 'Esc',
  'shortcut.enter': '↵',
}
