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
  'common.confirm': '确定',
  'common.cancel': '取消',

  /* ── 顶栏 ─────────────────────────────────────────────────────────── */
  'topbar.newSession': '新会话',

  /* ── 输入框(Composer 形态学:本体行 / 抽屉槽 / 状态条 / ask 形态 / 附件) ── */
  'composer.placeholder': '说点什么…( @ 文件 · / 命令 )',
  'composer.send': '发送',
  'composer.attach': '添加附件',
  'composer.attachments': '附件',
  'composer.removeAttachment': '移除附件',
  'composer.model': '选择模型:{name}',
  'composer.modelSearch': '搜模型或 Provider…',
  'composer.headFiles': '引用文件',
  'composer.headCommands': '命令',
  'composer.hintFile': '⏎ 引用',
  'composer.hintCommand': '⏎ 选用',
  'composer.noMatch': '无匹配',
  'composer.context': '上下文用量',

  /* ── 读数明细(数来自遥测,句子在这里) ───────────────────────────── */
  'meter.context': '上下文',
  'meter.contextValue': '{used} / {max} · {pct}%',
  'meter.tokens': 'Tokens',
  'meter.tokensValue': '↑{sent} ↓{received}',
  'meter.cost': '花费',
  'meter.costValue': '${cost}',
  'meter.cache': '缓存命中',
  'meter.cacheValue': '{pct}% · 省 ${saved}',

  /* ── 状态条 / 执行抽屉 ────────────────────────────────────────────── */
  'status.toggle': '执行状态',
  'status.running': '正在执行 {name} · {step}',
  'status.done': '执行完成 · {name} · {count} 步',

  /* ── ask 形态(本体变形成的问卷) ─────────────────────────────────── */
  'ask.multi': '多选',
  'ask.reject': '拒绝回答',
  'ask.rejected': '(拒绝了这组问题)',
  'ask.other': '其他',
  'ask.otherPlaceholder': '就在这行写,回车即答',
  'ask.hint': '‹ › 换题 · 再点取消 · esc 拒绝整单',
  'ask.submit': '提交 {done}/{total}',
  'ask.step': '{index}/{total}',
  'ask.prev': '上一题',
  'ask.next': '下一题',
  'ask.joiner': '、',

  /* ── Dock 与右键菜单 ──────────────────────────────────────────────── */
  'dock.add': '添加',
  'dock.openWith': '打开方式',
  'dock.openDefault': '跟随默认',
  'dock.openStage': '弹窗',
  'dock.openFloat': '浮窗',
  'dock.openPinned': '钉在右侧',
  'dock.edge': '停靠边',
  'dock.edgeBottom': '下边',
  'dock.edgeTop': '上边',
  'dock.edgeLeft': '左边',
  'dock.edgeRight': '右边',
  'dock.align': '沿边位置',
  'dock.alignStart': '靠前',
  'dock.alignCenter': '居中',
  'dock.alignEnd': '靠后',
  'dock.size': '大小',
  'dock.sizeSm': '小',
  'dock.sizeMd': '中',
  'dock.sizeLg': '大',
  'dock.settings': 'Dock 设置…',

  /* ── Dock 上那几块瓷砖的名字(是界面标签,不是内容) ───────────────── */
  'item.files': '文件',
  'item.diff': '改动',
  'item.terminal': '终端',
  'item.browser': '浏览器',
  'item.sessions': '会话总览',
  'item.search': '检索',
  'item.settings': '设置',

  /* ── 舞台 / 钉栏 ──────────────────────────────────────────────────── */
  'stage.pinToEdge': '钉到边',
  'stage.toFloat': '变浮窗',
  'float.toStage': '上舞台',
  'float.toDock': '收回 Dock',
  /* ── 四边架子(W2:钉栏泛化成四条边,名字按边给) ─────────────────── */
  'shelf.labelLeft': '左侧栏',
  'shelf.labelRight': '右侧栏',
  'shelf.labelTop': '顶栏',
  'shelf.labelBottom': '底栏',
  'shelf.collapse': '收起{name}',
  'shelf.popOut': '弹出 {name} 为浮窗',
  'shelf.closeAll': '关闭整栏 {name}',
  'shelf.expand': '展开{name}',
  'shelf.resize': '调整{name}厚度',

  /* ── 设置面 ───────────────────────────────────────────────────────── */
  'settings.dockDisplay': 'Dock 显示方式',
  'settings.dockDisplayHint': 'Dock 始终是浮层;自动隐藏时移到那条边才滑出来',
  'settings.dockAlways': '常驻',
  'settings.dockAutohide': '自动隐藏',
  'settings.defaultOpen': '默认打开方式',
  'settings.defaultOpenHint': '点 Dock 图标时的落点:弹窗居中,浮窗可拖可缩,钉栏常驻右侧',
  'settings.overrideNote': '每个图标可在右键菜单里单独覆盖',
  'settings.workdir': '工作目录',
  'settings.language': '语言 / Language',
  'settings.localeSystem': '跟随系统',
  'settings.localeZh': '中文',
  'settings.localeEn': 'English',

  'settings.sectionGeneral': '通用',
  'settings.sectionDock': 'Dock',
  'settings.sectionKeymap': '快捷键',

  /* ── 快捷键设置区 ─────────────────────────────────────────────────── */
  'keymap.hint': '点一行的键位再按下组合;Esc 取消,Backspace 解绑',
  'keymap.recording': '按下组合…',
  'keymap.unbound': '未绑定',
  'keymap.conflict': '与「{name}」冲突',
  'keymap.reset': '恢复默认',
  'keymap.resetOf': '恢复「{name}」的默认组合',
  'keymap.recordOf': '为「{name}」设置快捷键',
  'keymap.structuralNote': 'Esc 逐层退出、总览的方向键与回车、浮窗拖拽是形态语法的一部分,不参与改键',

  /* ── Dock 预览泡 ─────────────────────────────────────────────────── */
  'dock.previewOf': '{name} 预览',

  /* ── 浏览器面(壳,不是页面内容) ─────────────────────────────────── */
  'browser.pagePlaceholder': '页面占位',

  /* ── 会话总览 Exposé ──────────────────────────────────────────────── */
  'expose.searchPlaceholder': '搜索会话、章节、消息',
  'expose.searchLabel': '搜索会话',
  'expose.newProject': 'Project',
  'expose.sessionCount': '{count} 会话',
  'expose.sessionCountOne': '{count} 会话',
  'expose.newSessionIn': '在 {name} 新建会话',
  'expose.noMatchingSessions': '没有匹配的会话',
  'expose.groupCollab': '协作',
  'expose.groupCollabPath': '房间与私聊',
  'expose.groupLoose': '独立会话',
  'expose.groupLoosePath': '没有工作目录',
  /* 空态 / 载入态:数据源说了算,不留 mock 兜底 —— 假数据比空更糟。 */
  'expose.loading': '正在读会话…',
  'expose.emptyTitle': '这里还没有会话',
  'expose.emptyHint': '在 onething 里开一条会话,它会出现在这里',
  'expose.disconnectedTitle': '没连上 core',
  'expose.disconnectedHint': '会话数据来自本机正在跑的 core;{error}',

  /* ── 列表视图 ─────────────────────────────────────────────────────── */
  'list.backToOverview': '‹ 总览',
  'list.here': '{group} · {count} 会话',
  'list.hereOne': '{group} · {count} 会话',
  'list.filter': '在本组内过滤',
  'list.bucketThisWeek': '本周',
  'list.bucketEarlier': '更早',

  /* ── 检索面板(search/:搜索行 + 一张平铺列表) ────────────────────── */
  'search.placeholder': '搜文件、章节、消息、会话…',
  'search.label': '搜索',
  'search.scopeLabel': '搜索范围',
  'search.scopeAll': '所有',
  'search.scopeSessions': '会话',
  'search.scopeFiles': '文件',
  'search.resultsLabel': '结果',
  'search.noResults': '无结果',
  'search.badgeSession': '会话',
  'search.badgeMessage': '消息',
  'search.openedFile': '已打开 {file}',

  /* ── 聊天区(D3:正文/工具名/错误原文都是**数据**,不在这儿) ────────── */
  'chat.noSession': '还没有选中会话',
  'chat.loading': '正在读这条会话…',
  'chat.error': '读不到这条会话',
  'chat.empty': '这条会话还没有消息',
  'chat.errorCard': '出错了',
  'chat.thought': '思考',
  'chat.streaming': '正在生成',
  'chat.retry': '重试',
  'chat.discard': '不发了',
  'chat.tool.pending': '待执行',
  'chat.tool.queued': '排队中',
  'chat.tool.received': '已收齐',
  'chat.tool.executing': '执行中',
  'chat.tool.completed': '已完成',
  'chat.tool.failed': '失败',
  'chat.tool.cancelled': '已取消',
  'chat.tool.inputStreaming': '参数生成中',

  /* ── Quick Look ───────────────────────────────────────────────────── */
  'quicklook.enter': '进入 ↵',
  'quicklook.dismiss': '收回',
  'quicklook.hintSwitch': '换会话',
  'quicklook.hintEnter': '进入',
  'quicklook.prev': '上一个会话',
  'quicklook.next': '下一个会话',
  /* 模型 / agent 徽的悬停说明:徽面上是**数据**(模型名、agent id),说明才是文案。 */
  'quicklook.modelTitle': '模型 · {model}',
  'quicklook.agentTitle': 'Agent · {agent}',
  'quicklook.loading': '正在读消息…',
  'quicklook.empty': '这条会话还没有消息',
  'quicklook.roleUser': '你',
  'quicklook.roleAssistant': 'AI',
  'quicklook.roleSystem': '系统',
  'quicklook.roleError': '错误',

  /* ── 会话种类徽(一个字的徽 + 它的悬停全称) ───────────────────────── */
  'kind.chatBadge': '话',
  'kind.roomBadge': '室',
  'kind.dmBadge': '私',
  'kind.workBadge': '工',
  'kind.agentBadge': '代',
  'kind.chat': '会话',
  'kind.room': '房间',
  'kind.dm': '私聊',
  'kind.work': '派工',
  'kind.agent': '代理执行',

  /* ── 会话卡 ───────────────────────────────────────────────────────── */
  'card.preview': '预览',

  /* ── 钢琴键会话目录(键上的文本是消息内容,属于 mock,不在这儿) ────── */
  'toc.title': '会话目录',
  'toc.jumpTo': '跳到第 {index} 条消息',
  'toc.empty': '这条会话还没有目录',
  'toc.chapterTask': '任务',
  'toc.chapterQuestion': '问答',

  /* ── 相对时间(纯函数只产出标识,成品句子在这里拼) ─────────────────── */
  'time.clock': '{hh}:{mm}',
  'time.yesterday': '昨天',
  'time.date': '{month}月{day}日',
  'time.weekday0': '周日',
  'time.weekday1': '周一',
  'time.weekday2': '周二',
  'time.weekday3': '周三',
  'time.weekday4': '周四',
  'time.weekday5': '周五',
  'time.weekday6': '周六',

  /* ── 快捷键字面(两种语言相同,但仍走字典:组件里不落字面文案) ────── */
  'shortcut.left': '←',
  'shortcut.right': '→',
  'shortcut.space': 'Space',
  'shortcut.esc': 'Esc',
  'shortcut.enter': '↵',
} as const
