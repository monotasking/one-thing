/**
 * 中文文案字典 —— 全仓 UI 文案的**唯一来源**,也是 MessageKey 的定义处。
 * `as const` 让 key 集合在类型层固化:en.ts 少一条就编译期报错。
 *
 * 键名按「面」分组(common / topbar / composer / dock / item / stage / pinned /
 * settings / browser / expose / list / search / quicklook / kind / card / shortcut),
 * 组名即语义,不按文件分 —— 同一句话在两处出现时只该有一个键。
 * 插值占位是 {name} 形,替换规则见 index.ts 的 format()。
 */
export const zh = {
  /* ── 通用 ─────────────────────────────────────────────────────────── */
  'common.close': '关闭',
  'common.closeTab': '关闭 {label}',

  /* ── 顶栏 ─────────────────────────────────────────────────────────── */
  'topbar.newSession': '新会话',

  /* ── 输入框 ───────────────────────────────────────────────────────── */
  'composer.placeholder': '说点什么…',
  'composer.send': '发送',

  /* ── Dock 与右键菜单 ──────────────────────────────────────────────── */
  'dock.add': '添加',
  'dock.openWith': '打开方式',
  'dock.openDefault': '跟随默认',
  'dock.openStage': '弹窗',
  'dock.openPinned': '钉在右侧',
  'dock.settings': '设置…',

  /* ── Dock 上那几块瓷砖的名字(是界面标签,不是内容) ───────────────── */
  'item.files': '文件',
  'item.diff': '改动',
  'item.terminal': '终端',
  'item.browser': '浏览器',
  'item.settings': '设置',

  /* ── 舞台 / 钉栏 ──────────────────────────────────────────────────── */
  'stage.pinToRight': '钉到右侧',
  'pinned.label': '钉栏',

  /* ── 设置面 ───────────────────────────────────────────────────────── */
  'settings.dockDisplay': 'Dock 显示方式',
  'settings.dockDisplayHint': '常驻时 Dock 占布局,输入框永远在它之上',
  'settings.dockAlways': '常驻',
  'settings.dockAutohide': '自动隐藏',
  'settings.defaultOpen': '默认打开方式',
  'settings.defaultOpenHint': '点 Dock 图标时的落点:弹窗居中,钉栏常驻右侧',
  'settings.overrideNote': '每个图标可在右键菜单里单独覆盖',
  'settings.workdir': '工作目录',
  'settings.language': '语言 / Language',
  'settings.localeSystem': '跟随系统',
  'settings.localeZh': '中文',
  'settings.localeEn': 'English',

  /* ── 浏览器面(壳,不是页面内容) ─────────────────────────────────── */
  'browser.pagePlaceholder': '页面占位',

  /* ── 会话总览 Exposé ──────────────────────────────────────────────── */
  'expose.title': '会话总览',
  'expose.searchPlaceholder': '搜索会话、章节、消息',
  'expose.searchLabel': '搜索会话',
  'expose.newProject': 'Project',
  'expose.sessionCount': '{count} 会话',
  'expose.sessionCountOne': '{count} 会话',
  'expose.newSessionIn': '在 {name} 新建会话',
  'expose.noMatchingSessions': '没有匹配的会话',
  'expose.groupCollab': '协作',
  'expose.groupLoose': '独立会话',
  'expose.groupLoosePath': '不属于任何项目',

  /* ── 列表视图 ─────────────────────────────────────────────────────── */
  'list.backToOverview': '‹ 总览',
  'list.here': '{group} · {count} 会话',
  'list.hereOne': '{group} · {count} 会话',
  'list.filter': '在本组内过滤',
  'list.bucketThisWeek': '本周',
  'list.bucketEarlier': '更早',

  /* ── 搜索结果 ─────────────────────────────────────────────────────── */
  'search.youPrefix': '你:',

  /* ── Quick Look ───────────────────────────────────────────────────── */
  'quicklook.enter': '进入 ↵',
  'quicklook.dismiss': '收回',
  'quicklook.hintSwitch': '换会话',
  'quicklook.hintEnter': '进入',

  /* ── 会话种类徽(一个字的徽 + 它的悬停全称) ───────────────────────── */
  'kind.chatBadge': '话',
  'kind.roomBadge': '室',
  'kind.dmBadge': '私',
  'kind.chat': '会话',
  'kind.room': '房间',
  'kind.dm': '私聊',

  /* ── 会话卡 ───────────────────────────────────────────────────────── */
  'card.passed': '通过',
  'card.preview': '预览',

  /* ── 钢琴键会话目录(键上的文本是消息内容,属于 mock,不在这儿) ────── */
  'toc.title': '会话目录',
  'toc.jumpTo': '跳到第 {index} 条消息',

  /* ── 快捷键字面(两种语言相同,但仍走字典:组件里不落字面文案) ────── */
  'shortcut.palette': '⌘P',
  'shortcut.left': '←',
  'shortcut.right': '→',
  'shortcut.space': 'Space',
  'shortcut.esc': 'Esc',
  'shortcut.enter': '↵',
} as const
