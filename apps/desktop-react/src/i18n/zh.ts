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
  /** 外壳的一级标题。只念不看(.visually-hidden)—— 一张没有 h1 的页,
   * 读屏软件的「按标题跳」那一手从第一步就落空。 */
  'a11y.appTitle': 'onething 工作台',

  /* ── 顶栏 ─────────────────────────────────────────────────────────── */
  'topbar.newSession': '新会话',

  /* ── 顶栏 agent 切换器 ────────────────────────────────────────────── */
  // 「默认助手」是名册里查不到 id=default 那条记录时的兜底名 ——
  // 名册给了名字就用名册那份,这一句只在它缺席时出面。
  'agent.default': '默认助手',
  'agent.menuLabel': 'Agent 切换器',
  'agent.rosterUnavailable': '名册不可用',
  'agent.manage': '管理 Agents…',
  'agent.switchFailed': '切换 Agent 失败',
  /* 模型切换失败(上行没被后端认下)—— 药丸会变回原来那个,所以这句话要说出来。 */
  'model.switchFailed': '切换模型失败',

  /* ── 会话(新建那条命令的命令名;标题本身由后端落默认值,不进字典)──── */
  'session.new': '新建会话',

  /* ── 输入框(Composer 形态学:本体行 / 抽屉槽 / 状态条 / ask 形态 / 附件) ── */
  'composer.placeholder': '说点什么…( @ 文件 · / 命令 )',
  'composer.send': '发送',
  /* 忙态下发送键换的那句 aria-label。它说的是**动作**(停下这一轮),
   * 不是状态(「正在生成」)—— 读屏读到的必须是按下去会发生什么。 */
  'composer.stop': '停止生成',
  /* Esc 两段式停止的预备话(08-31 拍板对齐 Vue 口径):有草稿时占位符不可见,预备即静默。 */
  'composer.escStopHint': '再按一次 Esc 停止生成',
  'composer.attach': '添加附件',
  'composer.attachments': '附件',
  'composer.removeAttachment': '移除附件',
  'composer.model': '选择模型:{name}',
  /* 三层事实都答不上来时药丸上那句话 —— 不拿一个默认模型名去顶。 */
  'composer.modelUnset': '选择模型',
  'composer.modelSearch': '搜模型或 Provider…',
  'composer.headFiles': '引用文件',
  'composer.headCommands': '命令',
  'composer.hintFile': '⏎ 引用',
  'composer.hintCommand': '⏎ 选用',
  'composer.noMatch': '无匹配',
  'composer.context': '上下文用量',
  /* 窗口大小拿不到时读屏软件听见的那句 —— 不能说成 0%。 */
  'composer.contextUnknown': '上下文用量未知',

  /* ── 读数明细(数来自账本,句子在这里) ───────────────────────────── */
  'meter.context': '上下文',
  'meter.contextValue': '{used} / {max} · {pct}%',
  /* 用量有、模型窗口不知道:只说用量,并如实交代占比算不出来。 */
  'meter.contextNoWindow': '{used} · 窗口未知',
  /* 整份读数缺席(还没有会话 / 账本没答上话)。 */
  'meter.empty': '还没有读数',
  'meter.tokens': 'Tokens',
  'meter.tokensValue': '↑{sent} ↓{received}',
  'meter.cost': '花费',
  'meter.costValue': '${cost}',
  /* 厂商自己报的价 —— 与上面那行并存,报了才出现。 */
  'meter.costProvider': '厂商报价',
  'meter.cache': '缓存命中',
  /* 「省 $x」在整仓没有产地,D2 波一连同那半句一起删了 —— 不编省钱数字。 */
  'meter.cacheValue': '{pct}%',

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
  'item.notifications': '通知',
  'item.settings': '设置',
  'item.providers': '模型服务',

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
  'settings.defaultOpenNote': '只有从没被放过的瓦才用得上它 —— 放过一次,它就记住你放的地方',
  'settings.workdir': '工作目录',
  'settings.language': '语言 / Language',
  'settings.localeSystem': '跟随系统',
  'settings.localeZh': '中文',
  'settings.localeEn': 'English',

  'settings.sectionGeneral': '通用',
  'settings.sectionDock': 'Dock',
  'settings.sectionKeymap': '快捷键',

  /* ── 外观·阅读(08-31)。四根正交的轴,只管聊天正文列。 ───────────────── */
  'settings.sectionReading': '外观 · 阅读',
  'settings.readingFs': '字号',
  /* 档名说的是「相对大小」不是像素数:用户挑的是「这样读着舒不舒服」,
   * 不是「13 还是 14」。像素数留在 tokens.css 里。 */
  'settings.readingFsSm': '小',
  'settings.readingFsMd': '标准',
  'settings.readingFsLg': '大',
  'settings.readingFsXl': '特大',
  'settings.readingDensity': '密度',
  'settings.readingDensityHint': '段落、标题、卡片之间留多少白;跟着字号等比缩放',
  'settings.readingDensityCompact': '紧凑',
  'settings.readingDensityComfortable': '舒适',
  'settings.readingDensityRelaxed': '宽松',
  'settings.readingCol': '列宽',
  'settings.readingColStandard': '标准',
  'settings.readingColWide': '宽',
  'settings.readingColFull': '满幅',
  'settings.motion': '动效',
  'settings.motionHint': '没选过时跟随系统的「减弱动态效果」;选了就以你选的为准',
  'settings.motionStandard': '标准',
  'settings.motionCalm': '克制',
  'settings.motionNone': '无',

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
  // 面包屑后面只写组名。08-30「计数禁令」(tab / 列表 / 组头不挂个数)之后这里不再带条数,
  // 于是单复数两支同文、`list.hereOne` 成了孤儿键 —— 与 `expose.sessionCountOne` 同一批同一形,
  // 照仓里的读法留在原地等 i18n 批清理,不单独删。
  'list.here': '{group}',
  'list.hereOne': '{group}',
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
  /* D5 文件侧接真数据之后新增的两句。两句说的都是**产地的实情**,不是暂时的空:
   * 「最近打开的文件」后端没有产地,所以空词时文件侧本来就没有东西可给;
   * 检索失败与「没搜到」是两件事,合成一句就等于把失败说成空结果。 */
  'search.filesNeedQuery': '文件要先输入关键词',
  'search.filesFailed': '文件没搜成',

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
  /* 流式读数行(台一定稿):一句话说完「还活着 + 跑了多久」。
   * tokens 那一格**不在这句话里** —— 壳今天没有活的 token 产地,详见汇报的留账。 */
  'chat.streamReadout': '正在生成 · {s}s',
  'chat.stop': '停止',
  'chat.copy': '复制',
  /* 幽灵动作行整条的名字(读屏软件读它,眼睛看到的是两个字钮)。 */
  'chat.messageActions': '这条回复的动作',
  'chat.tool.pending': '待执行',
  'chat.tool.queued': '排队中',
  'chat.tool.received': '已收齐',
  'chat.tool.executing': '执行中',
  'chat.tool.completed': '已完成',
  'chat.tool.failed': '失败',
  'chat.tool.cancelled': '已取消',
  'chat.tool.inputStreaming': '参数生成中',

  /* ── 工具三件套(P2:A1 卡行 / B2 计数句 / C1 抽屉)────────────────────
   * 成果词是**事实的复述**,不是打卡词:「N 行」「+a −d」「退出 0」都在说这次
   * 调用做出了什么。上面那八档状态从此只在「还没有成果词可说」时才露面。 */
  'chat.tool.lines': '{n} 行',
  'chat.tool.diffStat': '+{add} −{del}',
  'chat.tool.exitOk': '退出 0',
  'chat.tool.exitCode': '退出 {code}',
  'chat.tool.results': '{n} 条结果',
  'chat.tool.durationMs': '{n}ms',
  'chat.tool.durationS': '{n}s',
  'chat.tool.arguments': '参数',
  'chat.tool.result': '结果',
  'chat.tool.noResult': '这次调用没有留下结果',
  'chat.toolGroup.count': '执行了 {n} 步',
  'chat.toolGroup.moreKinds': '等 {n} 种',
  'chat.toolGroup.failed': '{n} 失败',
  'chat.toolGroup.times': '×{n}',

  /* ── 检索段(§5.3 四件套) ─────────────────────────────────────────────
   * 查询词、标题、域名、摘录一律是**外部事实**,不进字典 —— 换一门语言它们
   * 不该跟着变。这里只有句子的骨架。 */
  'chat.research.label': '检索',
  'chat.research.sources': '{n} 个来源',
  'chat.research.queries': '{n} 组查询',
  'chat.research.queryHead': '搜索 {query}',
  'chat.research.direct': '直接打开',
  'chat.research.noSources': '这一组没有搜到来源',
  'chat.research.openFailed': '未读到正文',
  'chat.research.searching': '正在搜索 {query}',
  'chat.research.reading': '正在阅读 {domain} — {title}',
  'chat.research.readingPlain': '正在阅读 {domain}',
  /* 说不清此刻在忙哪一件时的那句话 —— 不编一个查询词把句子撑起来。 */
  'chat.research.working': '正在检索',
  'chat.research.progress': '已搜索 {q} 组关键词 · 打开 {p} 个页面',
  'chat.research.footLabel': '跳到这段检索的来源',

  /* ── 内容块的壳(檐上的动作、限高折叠、降级说明) ─────────────────────
   * 块的 `reason`(unknown-kind:… / tool-default)是**标识**不是文案,
   * 与错误边界的 `where` 同一条判据:换语言它不该跟着变,所以它不在这儿。 */
  'block.actions': '更多动作',
  'block.action.copySource': '复制源码',
  'block.action.copyMarkdown': '复制 Markdown',
  'block.action.copyCsv': '复制 CSV',
  /* 列头上的 ⧉ —— 块内热区,不进檐上的动作组,但共用同一个执行器。 */
  'block.action.copyColumn': '复制这一列',
  'block.action.viewSource': '查看源码',
  'block.action.hideSource': '收起源码',
  /* 图的两格(P3):放大常显在檐上,下载 PNG 收在 ⋯ 里。 */
  'block.action.zoom': '放大',
  'block.action.downloadPng': '下载 PNG',
  'block.expand': '展开',
  'block.collapse': '收起',
  'block.renderFailed': '这块没画出来',
  /* 放大浮层没有可见标题,这句是它的无障碍名。 */
  'block.zoom.label': '放大预览',
  /* 图渲染失败:一行灰说明 + 渲染器的原话(原话不进字典,它是事实不是文案)。 */
  'block.figure.renderFailed': '这张图没画出来',

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
  /* 消息数(产地 SessionMeta.messageCount)。0 是真值,所以「0 条消息」照常说得出口。 */
  'quicklook.messageCount': '{count} 条消息',
  'quicklook.messageCountOne': '{count} 条消息',
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

  /* ── 分区错误边界(工程卫生批①)──────────────────────────────────── */
  'error.title': '这块崩了',
  'error.hint': '其余部分还在正常跑。点重试重新挂载这一块;还是不行就把下面的技术细节发给我们。',
  'error.retry': '重试',
  'error.detail': '技术细节',

  /* ── 性能 HUD(dev 工具,localStorage `onething.perfHud` 开)────────── */
  'perf.title': '性能',
  'perf.empty': '暂无读数',
  'perf.longFrame': '长帧 {ms}ms',
  'perf.slowEvent': '{name} 延迟 {ms}ms',
  'perf.span': '{name} {ms}ms',
  'perf.budgetOk': '在预算内',
  'perf.budgetOver': '超预算',
  'perf.close': '关闭性能 HUD',
  'perf.report': '聚合',
  'perf.reportHint': '按名字聚成 p50/p95/max,打进控制台',
  'perf.rowDetail': '展开这条的完整现场',

  /* ── 通知系统(08-30 批)────────────────────────────────────────────────
   * 面板标题不另起一个键:它就是 'item.notifications' 那两个字,
   * 同一句话不该有第二个键(与 SHELF_SIDE_CHOICES 复用 Dock 那四个边键同一条)。
   * 组头三个键与 'time.yesterday' 刻意分开:那一个是时间戳里的「昨天」,
   * 这三个是列表的**组标**(英文小写、灰、字距撑开),两种体例不共用一个键。 */
  'notify.filterAll': '全部',
  'notify.filterWarn': '警告',
  'notify.filterError': '错误',
  'notify.filterLabel': '按级别过滤',
  'notify.markAllRead': '全部已读',
  'notify.clear': '清空',
  'notify.today': '今天',
  'notify.yesterday': '昨天',
  'notify.earlier': '更早',
  'notify.empty': '还没有通知',
  'notify.repeat': '×{count}',
  'notify.openLog': '打开完整日志(app.jsonl)',
  'notify.more': '+{count} 更早 · 打开通知中心',

  /* 各产地报出来的那句话。它们是**界面文案**(换语言要跟着变),
   * 所以在字典里;而错误本身的文字是数据,原样进 body / detail。 */
  'notify.crash': '{where} 出错了',
  'notify.disconnected': '没连上 core',
  'notify.sendFailed': '消息没发出去',
  'notify.createSessionFailed': '新建会话失败',
  'notify.bindWorkdirFailed': '会话已建,但没归进项目目录',
  'notify.abortFailed': '停止没有发出去',
  'notify.abortStuck': '停止发出去了,这一轮还没收尾',
  'notify.abortStuckHint': '命令已经被 core 收下;收尾要等引擎那边结束这一轮。',
  // 08-31 起复制反馈就地长在按钮上,notify.copied / copyFailed 两键成孤儿(照仓惯例保留)。
  'common.copied': '已复制',
  'common.copyFailed': '没能复制',
  'notify.copied': '已复制这条回复',
  'notify.copyFailed': '没能复制',
  'notify.retryFailed': '重试没有发出去',

  /* ── 文件面板(D5:content/FilesPanel.tsx)────────────────────────────────
   * 面板标题不另起一个键:它就是 'item.files' 那两个字(与通知中心复用
   * 'item.notifications' 同一条)。
   * **路径、目录名、文件名、后端的英文原话一个字都不在字典里** —— 它们是数据,
   * 换一门语言不该变(判据见 i18n/index.ts 顶部)。这里只有「这台此刻处在哪种
   * 状态」的那几句人话。 */
  'files.treeLabel': '文件树',
  'files.refresh': '重新读取',
  'files.rootLoading': '正在确定根目录…',
  'files.rootFailed': '没能确定根目录',
  /* 会话没带工作目录时退到主目录。这句话必须说出来:用户看到的不是他以为的那棵树。 */
  'files.rootFallback': '这条会话没有工作目录,显示的是主目录',
  'files.reveal': '在文件管理器中显示',
  'files.revealFailed': '没能在文件管理器中定位',
  /* 目录的四态。空 / 没权限 / 不在了 / 别的失败,各说各的 —— 不合并成一句
   * 「读不到」:能不能改、要不要改,取决于是哪一种。 */
  'files.dirLoading': '正在读取…',
  'files.dirEmpty': '这个目录是空的',
  'files.dirDenied': '没有权限读这个目录',
  'files.dirMissing': '这个目录不在了',
  'files.dirFailed': '读不到这个目录',
  /* 预览的五态。同上,一种都不回退到别的那一种。 */
  'files.previewLoading': '正在读取文件…',
  'files.previewEmpty': '这个文件是空的',
  'files.previewBinary': '这是二进制文件,没法按文本预览',
  'files.previewTruncated': '文件有 {size},只预览了前 {shown}',
  'files.previewDenied': '没有权限读这个文件',
  'files.previewMissing': '这个文件不在了',
  'files.previewFailed': '读不到这个文件',
  'files.previewClose': '关闭预览',

  /* ── 模型服务(providers/:左栏家名册 + 右面模式分坑)─────────────────────
   * 面板标题不另起键:它就是 'item.providers' 那四个字(与文件面复用
   * 'item.files' 同一条)。
   * **provider 名、模型 id、账号邮箱、后端原话一个字都不在字典里** —— 它们是
   * 数据,换一门语言不该变(判据见 i18n/index.ts 顶部)。这里只有「这一家此刻
   * 处在哪种状态」的那几句人话,以及缺席态里那句「这件事在下一批」。
   *
   * `providers.factRaw` 是**透传格**:副行里要嵌一段真数据(账号、尾号)时用它,
   * 这样副行那串事实仍然是同构的一串 Fact,组件不必为「有一段不用翻译」分叉。 */
  'providers.railTitle': '模型服务',
  'providers.railCount': '{count} 家已接入',
  'providers.searchPlaceholder': '搜索服务商',
  'providers.groupCloud': '云服务',
  'providers.groupLocal': '本地',
  'providers.groupCustom': '自定义',
  'providers.addCustom': '＋ 自定义服务商',
  'providers.addCustomNext': '新建自定义服务商在下一批',
  'providers.railEmpty': '没有匹配的服务商',
  'providers.loading': '正在读取模型服务…',
  'providers.loadFailed': '读不到模型服务名册',
  'providers.retry': '重新读取',
  'providers.pickOne': '在左边选一家',

  /* 副行 / 分段器上的事实句。每一句都对应一条真读数,没有一句是凑数的。 */
  'providers.factRaw': '{text}',
  'providers.factConfigured': '已配置',
  'providers.factUnconfigured': '未配置',
  'providers.factSignedIn': '已登录',
  'providers.factSignedOut': '未登录',
  /* 「不知道」与「没有」是两件事:凭证那一口读不到时说这句,不说「未配置」。 */
  'providers.factUnknown': '状态未知',
  'providers.factKeys': '{count} 把',
  'providers.factCooling': '冷却中',
  'providers.factSelected': '已选 {count} 型',
  'providers.factDisabled': '已停用',
  'providers.factLocal': '本地',
  'providers.factCustom': '自定义',

  /* 模式名。同一家的两坑各带一份凭证与一份模型目录,不混用。 */
  'providers.modeApi': 'API 密钥',
  'providers.modeSub': '订阅',
  'providers.modeLocalCli': '本地 CLI',
  'providers.modeAcp': 'ACP',
  'providers.modeCustom': '自定义端点',
  'providers.modeLabel': '接入模式',

  /* 家的头部 */
  'providers.enable': '启用',
  'providers.enableFamily': '启用 {name}',

  /* API 坑 */
  'providers.keySection': 'API 密钥',
  'providers.keyNeverRead': '密钥原文永不回读,只看得到尾号。',
  'providers.keyStored': '已存 {tail},输入新的可替换',
  'providers.keyEmpty': '粘贴 API 密钥',
  'providers.keyLabel': '{name} 的 API 密钥',
  'providers.keySave': '保存',
  'providers.keySaved': '已保存',
  'providers.keySaveFailed': '密钥没保存上',
  'providers.keyMultiNext': '多把密钥、顺序与轮换策略在下一批',
  'providers.baseUrl': '高级 · Base URL',
  'providers.baseUrlDefault': '(默认)',

  /* 订阅坑 */
  'providers.subIntro': '用你已有的订阅跑模型,不产生额外 API 费用。这一坑的模型不按 token 计价。密码只在浏览器里输入,应用不经手。',
  'providers.subAccount': '账号',
  'providers.subSignIn': '登录',
  'providers.subSignInNext': '登录入口在下一批',
  'providers.subCatalogLocked': '登录后才有模型目录 —— 没登录时这一坑有哪些模型,应用并不知道。',

  /* 本地坑 / 自定义坑 */
  'providers.localIntro': '本机进程,零凭证。探测、连接与启动配置在下一批。',
  'providers.customIntro': '自定义端点。编辑、删除与新建在下一批。',

  /* 模型目录 */
  'providers.catalog': '模型目录',
  'providers.catalogHint': '勾选后出现在聊天的模型选择器里',
  'providers.catalogFetched': '上次拉取 {time}',
  'providers.catalogNeverFetched': '还没拉过',
  'providers.catalogRefresh': '刷新目录',
  'providers.catalogSearch': '检索模型',
  'providers.catalogLoading': '正在拉目录…',
  'providers.catalogFailed': '目录拉不到',
  'providers.catalogEmpty': '这一坑还没有模型',
  'providers.catalogNoHit': '没有匹配的模型',
  'providers.addModelNext': '手填模型 ID 在下一批',
  'providers.colModel': '模型',
  'providers.colCaps': '能力',
  'providers.colCtx': '上下文',
  'providers.colOut': '最大输出',
  'providers.colPrice': '单价 入/出',
  'providers.priceIncluded': '订阅内',
  /* 「不知道」的那一格画这个,不画 0、不画「免费」。 */
  'providers.unknownValue': '—',
  'providers.current': '当前模型',
  'providers.setCurrentNext': '设为当前在下一批',
  'providers.pickModel': '勾选 {model}',
  'providers.capVision': '视',
  'providers.capTools': '工',
  'providers.capReasoning': '推',
  'providers.capImageOut': '出',
  'providers.capAudioIn': '音',
  'providers.capLegend': '能力缩写:视 图像输入 · 工 工具调用 · 推 推理 · 出 图像输出 · 音 音频输入。',
  'providers.saveFailed': '设置没保存上',

} as const
