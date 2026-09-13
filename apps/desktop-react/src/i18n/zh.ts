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
  /* 点会话列表一行是什么意思(C2,设计 session-continuity-2026-09.md §4.2)。
   * 三档的名字说的是**结果**不是机制 —— 用户看的是「点完屏幕上多不多一格」。 */
  'sessions.openMode': '点会话时',
  'sessions.openModeHint': '在左边的会话列表里点一行,那一下开在哪儿',
  'sessions.openMode.preview': '预览',
  'sessions.openMode.newTab': '新标签',
  'sessions.openMode.replace': '替换',

  /* ── 斜杠命令(命令名 / 说明 / 用法都来自 core 的注册表,是**数据**不进字典;
   *    这里只有壳自己要说的那几句)────────────────────────────────────── */
  'command.done': '{name} 完成',
  'command.failed': '{name} 没能执行',
  /* 用法那句原样来自注册表的 `usage`,这里只包一句「用法:」。 */
  'command.usage': '用法:{usage}',
  'command.needsSession': '这条命令需要先有一条会话',
  'command.cdDone': '工作目录已改为 {path}',
  /* 压缩是**发出去就完** —— 结果以一张卡落在会话里,壳没有第二块地方画进度。 */
  'command.compactStarted': '已请求压缩上下文',
  'command.compactFailed': '压缩没有发出去',

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
  /*
   * 药丸带着档字时的无障碍名(09-05 庚复审补)。屏幕上药丸右半画着「· 高」,
   * 而 `composer.model` 只念模型名 —— 读屏的人因此听不到「此刻想得多深」,
   * 那正是这枚药丸新长出来的那半格意思。`{level}` 用的就是屏幕上那一个词
   * (`THINKING_LABEL_KEY` 那张表),眼睛看到的与耳朵听到的是同一份事实。
   * 不思考的型仍走上面那条 —— 不念一个「思考 无」出来。
   */
  'composer.modelWithThinking': '选择模型:{name},思考 {level}',
  /* 三层事实都答不上来时药丸上那句话 —— 不拿一个默认模型名去顶。 */
  'composer.modelUnset': '选择模型',
  'composer.modelSearch': '搜模型或 Provider…',
  /* ── 思考档位(09-05 庚:药丸右半 + 抽屉右栏那条竖排阶梯)──────────────
   * 档名是**六档 + 关**,与 `ThinkingEffort` 一一对应;注是一句手感,不是参数说明。
   * 它们是文案不是数据 —— 换一门语言这几个字当然要跟着变(与窗口 / 价格相反)。 */
  'composer.thinkOff': '关',
  'composer.thinkMinimal': '最少',
  'composer.thinkLow': '低',
  'composer.thinkMedium': '中',
  'composer.thinkHigh': '高',
  'composer.thinkXhigh': '极高',
  'composer.thinkMax': '最大',
  /* 只有开 / 关那一族(qwen3.5 / 智谱:能开关但一档都没有)药丸上写的字。 */
  'composer.thinkOn': '开',
  'composer.thinkNoteOff': '不思考,最快',
  'composer.thinkNoteMinimal': '几乎不想',
  'composer.thinkNoteLow': '略想',
  'composer.thinkNoteMedium': '日常',
  'composer.thinkNoteHigh': '认真想',
  'composer.thinkNoteXhigh': '想很久',
  'composer.thinkNoteMax': '想到底',
  'composer.thinkNoteOn': '按这一型的缺省想',
  /* 阶梯那一组的组头与无障碍名。 */
  'composer.thinkLabel': '思考',
  /* 这一型压根没有思考这回事 —— 说实话,不画一个禁用的控件冒充。 */
  'composer.thinkNone': '这一型不思考',
  /* 右栏那张卡上的两行读数。价格单位写死「每 1M token」,与目录的单位一致。 */
  'composer.modelWindow': '窗口',
  'composer.modelPrice': '价格 / 1M',
  'composer.modelPriceValue': '{input} 进 / {output} 出',
  /* 目录一条都读不到时右栏说的实话(不是空白,也不是骨架)。 */
  'composer.modelCardUnknown': '这一型的读数还没拉到',
  'composer.headFiles': '引用文件',
  'composer.headCommands': '命令',
  /* 抽屉里命令分的另外两组(09-12)。三个组头在一列里各出现恰好一次。 */
  'composer.headSkills': '技能',
  'composer.headPlugins': '插件',
  'composer.hintFile': '⏎ 引用',
  'composer.hintCommand': '⏎ 选用',
  'composer.noMatch': '无匹配',
  /* 候选在飞、手上还没有旧候选时列表那一行。**纯文字**:Spinner 只许在按钮内 /
   * 状态栏(禁令区),而且这一行的寿命常常只有一次去抖那么长。 */
  'composer.searching': '正在找…',
  /* 候选这一发失败:旧候选留屏,这一行与它并陈(律②:错误不抹掉旧答案)。 */
  'composer.searchFailed': '这一发没找成,先看上一批',
  /* `/skill:<名字> [说明]` 里方括号中那个词 —— 选中之后它是输入框里的幽灵占位,
   * 说的是「接着说你要它干什么」。 */
  'composer.skillArg': '说明',
  'composer.context': '上下文用量',
  /* 窗口大小拿不到时读屏软件听见的那句 —— 不能说成 0%。 */
  'composer.contextUnknown': '上下文用量未知',
  /* 压缩中:那圈脉动给眼睛看,这两句给读屏软件听 —— 说的是同一件事。 */
  'composer.contextCompacting': '上下文用量 · 正在压缩',
  'composer.contextUnknownCompacting': '上下文用量未知 · 正在压缩',

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
  /* 压缩中才出现的那一行。k/N 只有多块才有 —— 单块编一个「1 / 1」是撒谎。 */
  'meter.compact': '压缩',
  'meter.compacting': '正在压缩',
  'meter.compactingProgress': '正在压缩 · {chunk} / {total}',

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
  /** 整条 Dock 的地标名(`<nav aria-label>`)。Dock 挂在 `<main>` 外面,没有地标
   * 就是一块「不在任何地标里」的页面内容(axe region);它是一排通往各块面的入口,
   * 所以地标类型是导航而不是补充说明。 */
  'dock.label': '应用坞',
  'dock.add': '添加',
  'dock.openWith': '打开方式',
  'dock.openStage': '弹窗',
  'dock.openFloat': '浮窗',
  'dock.openFull': '全屏',
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
  'dock.magnify': '磁性放大',
  'dock.magnifyHint': '指针滑过时脚下的图标鼓起来;关掉之后整条纹丝不动',
  'dock.magnifyLevel': '放大幅度',
  'dock.magnifySm': '小',
  'dock.magnifyMd': '中',
  'dock.magnifyLg': '大',
  'dock.runningDot': '运行中指示点',
  'dock.runningDotHint': '正开着的那几块瓦上画一颗小圆点',
  /* **在 Dock 上隐藏**(W7-p 裁定 7,审计 A 的 A10)。从前这一档只在「所有应用」
   * 那块面里有一颗开关 —— 一个「把这块瓦从条上收走」的动作,却要先打开另一块面
   * 才找得到。右键这一行与那颗开关是**同一格状态**(`stage.hiddenItems`),
   * 常驻 Dock 的那几块瓦禁灰不消失(判词在 ui/Menu 的 `disabled` 上)。 */
  'dock.hideTile': '在 Dock 上隐藏',
  'dock.settings': 'Dock 设置…',

  /* ── Dock 上那几块瓷砖的名字(是界面标签,不是内容) ───────────────── */
  'item.files': '文件',
  /* W6-a:那块瓦现在是**目录**的启动瓦(一个目录一份面板)。 */
  'item.dirs': '目录',
  'item.viewer': '查看器',
  'item.diff': '改动',
  'item.terminal': '终端',
  'item.browser': '浏览器',
  'item.sessions': '会话总览',
  'item.search': '检索',
  'item.notifications': '通知',
  'item.settings': '设置',
  'item.providers': '模型服务',
  'item.workspace': '工作区',
  'item.apps': '所有应用',
  /* 音乐(音乐收尾 · 壳半边)。面里是电台 + 播放器 + 歌词三块。 */
  'item.music': '音乐',

  /* ── 所有应用(Dock 露面管理)─────────────────────────────────────── */
  'apps.subtitle': '这台壳里能打开的全部。关掉一行,它的 Dock 瓦就不见了 —— 随时能从这里打开它。',
  'apps.inDock': '显示在 Dock',
  'apps.showRow': '在 Dock 上显示{name}',
  'apps.alwaysInDock': '常驻 Dock',
  'apps.open': '打开{name}',
  'apps.hiddenCount': '已隐藏 {count} 块',

  /* ── 舞台 / 钉栏 ──────────────────────────────────────────────────── */
  'stage.pinToEdge': '钉到边',
  'stage.toFloat': '变浮窗',
  'float.toStage': '上舞台',
  'float.toDock': '收回 Dock',
  /* W4:浮窗那颗 ✕ 关的是**这扇窗**,里面的标签全部转为隐藏(设计 §2.2)——
     所以它不叫「收回 Dock」:那句话只对瓦说得通,而一扇窗里可能装着文件。 */
  'float.close': '关闭这扇窗',
  /* 一扇窗还什么都没显示时的兜底无障碍名(树刚建、内容未定的那一帧)。 */
  'float.window': '浮窗',
  /* ── 真全屏(W2,设计 §4)────────────────────────────────────────────── */
  'full.region': '全屏',
  'full.exit': '退出全屏',
  /* 这一种进不了全屏时的结构化拒绝(今天只有聊天;W5 撤)。 */
  'full.refuseChat': '聊天区暂时不能全屏 —— 输入框会被盖住',
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
  'shelf.railMenu': '{name}细梁动作',
  'shelf.railHideAll': '隐藏收起把手(所有边)',
  'shelf.railToggle': '收起后显示把手',

  /* ── 设置面 ───────────────────────────────────────────────────────── */
  'settings.dockDisplay': 'Dock 显示方式',
  'settings.dockDisplayHint': 'Dock 始终是浮层;自动隐藏时移到那条边才滑出来',
  'settings.shelfRail': '收起后的把手',
  'settings.shelfRailHint': '架子收起来之后留不留一条可点的细梁;隐藏后收起的架子零厚度,用快捷键或点 Dock 那块瓦照样展开',
  'settings.shelfRailShown': '显示',
  'settings.shelfRailHidden': '隐藏',
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
  'keymap.toggleFull': '全屏',
  'keymap.hint': '点一行的键位再按下组合;Esc 取消,Backspace 解绑',
  'keymap.recording': '按下组合…',
  'keymap.unbound': '未绑定',
  'keymap.conflict': '与「{name}」冲突',
  'keymap.reset': '恢复默认',
  'keymap.resetOf': '恢复「{name}」的默认组合',
  'keymap.recordOf': '为「{name}」设置快捷键',
  'keymap.structuralNote': 'Esc 逐层退出、总览的方向键与回车、浮窗拖拽是形态语法的一部分,不参与改键',
  'keymap.scopedNote': '面域局部键(查看器 ⌘S/⌘L/⌘F、文件行 ⌘I)只在焦点落在那块面里时生效,局部先接、没接住才轮到全局',
  'keymap.scopedConflict': '「{scope}」里被「{action}」占着',

  /* ── 响应链的作用域名(focus/scopes.ts 的 labelKey)──────────────────
   *    只补**真缺**的那几格:根 / 查看器 / 文件 / 检索 / 会话总览 / 设置 / Dock
   *    的名字早就有键了(a11y.appTitle · viewer.label · item.* · dock.label),
   *    再开一份就是同一句话的第二个产地。哪一格复用了谁写在那张表上。 */
  'focus.scope.composer': '输入面板',
  'focus.scope.chat': '消息流',
  'focus.scope.permission': '权限卡',
  'focus.scope.leaf': '标签页',
  'focus.scope.stageLayer': '舞台',
  'focus.scope.floatLayer': '浮窗',
  'focus.scope.shelfLayer': '边栏',
  'focus.scope.fullLayer': '全屏层',
  'focus.scope.jumpbar': '跳转条',
  'focus.scope.drawer': '抽屉',
  'focus.scope.zoom': '缩放层',
  'focus.scope.popover': '浮层',
  'focus.scope.tooltip': '提示',
  'focus.scope.dialog': '对话框',
  'focus.scope.menu': '菜单',
  'focus.scope.palette': '工作区快切',

  /* ── 浏览器面(壳,不是页面内容;B2:content/browser/BrowserLeaf.tsx)── */
  'browser.address': '地址',
  'browser.addressPlaceholder': '输入网址,或者搜点什么',
  'browser.back': '后退',
  'browser.forward': '前进',
  'browser.reload': '刷新',
  'browser.stop': '停止',
  'browser.newTab': '新标签页',
  'browser.openTabsSection': '开着的标签页',
  'browser.closeOffscreen': '关闭不在屏上的标签({count})',
  'browser.noHost': '此宿主没有内嵌浏览器,页开在桌面里。',
  'browser.gone': '这一页找不到了。',

  /* ── 页内查找(B3-a)。`browser.find` 同时是 ⌘F 那条局部键在设置页键位表上的
   *    名字 —— 原话说的是「这一页」,与终端那句「这块屏幕」、查看器那句「这份
   *    文件」是三句话,所以各有各的键(i18n 纪律:同一句话才只该有一个键)。 */
  'browser.find': '在这一页里查找',
  'browser.findPlaceholder': '查找',
  'browser.findPrev': '上一处',
  'browser.findNext': '下一处',
  'browser.findClose': '收起查找',

  /* ── 网页权限询问(B3-a)。卡的形复用既有权限卡。 */
  'browser.perm.title': '{origin} 想要{capability}',
  'browser.perm.titleAnonymous': '这个网页想要{capability}',
  'browser.perm.notifications': '给你发通知',
  'browser.perm.geolocation': '知道你在哪儿',
  'browser.perm.media': '用摄像头或麦克风',
  'browser.perm.clipboardRead': '读你的剪贴板',
  'browser.perm.midi': '连你的 MIDI 设备',
  'browser.perm.pointerLock': '接管你的鼠标指针',
  'browser.perm.unknown': '一格它没说清的能力',

  /* ── 下载落地(B3-a)。一行文字读数,禁 spinner 禁 Toast。 */
  'browser.downloadStarted': '正在下载 {name}…',
  'browser.downloadDone': '已下载 {name}',
  'browser.downloadFailed': '{name} 没下成',
  'browser.downloadReveal': '在文件管理器中显示',
  'browser.downloadDismiss': '收起这条下载读数',

  /* ── 身份与 @ 引入(B3-b)────────────────────────────────────────── */
  'browser.actions': '这一页的动作',
  'browser.giveToChat': '把这一页交给对话',
  'browser.giveToChatNoComposer': '此刻没有开着的对话可以接这一页',
  'browser.profileBadge': '身份:{name}',
  'browser.profileSection': '身份',
  'browser.openInProfile': '在「{name}」中打开此页',
  'browser.newTabInProfile': '新标签页(「{name}」)',
  'browser.profileDefaultName': '默认',
  /* 起始页 */
  'browser.startHint': '输入网址,或者搜点什么',
  'browser.startEngine': '用{name}搜',
  'browser.startEngineSection': '搜索引擎',

  /* ── 会话总览 Exposé ──────────────────────────────────────────────── */
  'expose.searchPlaceholder': '搜索会话、章节、消息',
  'expose.searchLabel': '搜索会话',
  'expose.noMatchingSessions': '没有匹配的会话',

  /* ── 侧栏范围(SCOPE_SPECS 读这几条;侧栏项不带数字)──────────────── */
  'expose.scopeLabel': '项目',
  'expose.scopeAll': '全部',
  /* 09-12 方向 A:顶上三行导航,搜索是其中一行。这一条是它**静息时那行字**;
   * 点开之后那只输入框读的仍是下面 placeholder / label 两条(同一件的两种形,
   * 文案也该是同一组)。**不画快捷键提示** —— 今天没有「聚焦会话搜索」这条
   * 全局命令,画一个按不出来的键位是在说谎(正本 §7 留账)。 */
  'expose.searchRow': '搜索',
  'expose.scopeCollab': '协作',
  'expose.scopeLoose': '无项目',
  'expose.newSession': '新会话',

  /* ── 分节(SECTION_BUCKETS 读这几条;节头不带计数)────────────────── */
  'expose.sectionPinned': '置顶',
  'expose.sectionToday': '今天',
  'expose.sectionYesterday': '昨天',
  'expose.sectionThisWeek': '本周',
  /* 跨年的月份才带年;本年的月份标题**就是** time.month<N> 自己,不再包一层。 */
  'expose.sectionMonthYear': '{year} 年 {month}',

  /* ── 行上的两个动作(图钉 / 展开)与它们的播报 ────────────────────── */
  'expose.pin': '置顶',
  'expose.unpin': '取消置顶',
  'expose.pinnedAnnounce': '已置顶 {name}',
  'expose.unpinnedAnnounce': '已取消置顶 {name}',
  'expose.expandRoom': '展开 {name}',
  'expose.collapseRoom': '收起 {name}',
  /* W5-b:会话行的右键菜单(09-12 起行尾那颗 ⋯ 弹的是同一张表),以及那颗
   * 空心「已打开·隐藏」点的 accname。头两行菜单项复用 `files.menuOpen*`
   * (同一句话只该有一个键),Quick Look 那行复用 `card.preview`。 */
  'expose.rowMenu': '更多操作',
  /* 09-12 拍板 4:会话这边**竖着并排不存在**(两格只有左右),所以「在下方打开」
   * 名不副实,改名为它真做的事。**不复用 `files.menuOpenBelow`** —— 那把键在
   * 文件树里字字属实(那边真的 `splitLeaf(leaf.id, 'col')`),改它的文案会把
   * 文件树那一行一起改错。一句话一把键。 */
  'expose.menuOpenNewTab': '在新标签页打开',
  /* ── A2 补齐的四行动作 ──────────────────────────────────────────────
   * 「关闭」= 把这条从所有开着它的格子里摘掉,**不删数据**(拍板 5)——
   * 所以它与「删除…」必须是两句一眼分得开的话,而后者带省略号(还有一问)。
   * 置顶那一行复用 `expose.pin` / `expose.unpin`(行上那颗图钉退役之后,
   * 菜单与 ⌘⇧P 说的是同一句话,同一把键)。 */
  'expose.menuClose': '关闭',
  'expose.menuRename': '重命名…',
  'expose.menuDelete': '删除…',
  /* 原地改名那只框的名字:**只念不看**(`labelHidden`)—— 屏幕上它就长在那一行
   * 标题的位置上,画一个可见标签会把行挤成 A1 刚治好的样子。 */
  'expose.renameLabel': '会话名称',
  /* 唯一允许的确认(数据会没)。正文点名那条会话 —— 一句「确定删除吗」在
   * 一屏 400 行里说不清删的是哪一条。 */
  'expose.deleteConfirmTitle': '删除会话',
  'expose.deleteConfirmBody': '删除「{name}」?这条会话与它的历史会没。',
  'expose.deleteConfirmAction': '删除',
  /* 两句**只在没成时**播报的话(成了的那一下屏幕自己说明白了)。后端原话原样
   * 带上:这一族的失败原因通常是「这条会话不在了」/ 沙箱拒绝,人看得懂。 */
  'expose.renameFailed': '改名没成:{error}',
  'expose.deleteFailed': '删除没成:{error}',
  'expose.openStateHidden': '打开着(已隐藏)',
  /* 空态 / 载入态:数据源说了算,不留 mock 兜底 —— 假数据比空更糟。 */
  'expose.loading': '正在读会话…',
  'expose.emptyTitle': '这里还没有会话',
  'expose.emptyHint': '在 onething 里开一条会话,它会出现在这里',
  'expose.disconnectedTitle': '没连上 core',
  'expose.disconnectedHint': '会话数据来自本机正在跑的 core;{error}',

  /* ── 组列表视图 09-04 退役(方向 A:总览与组列表合并成一张树)──────────
   * `list.*` 六条与 `expose.sessionCount*` 两条随 `ListView` 一起删:
   * 没有第二屏了,也没有一处再写「N 会话」(08-30 计数禁令)。 */

  /* ── 检索面板(search/:搜索行 + 一张平铺列表) ────────────────────── */
  /* 自述还没回来时的兜底占位:**不列档名**(列出来的必然是猜的)。 */
  'search.placeholder': '搜索…',
  /* 有自述之后的占位:档名由 `capabilities.ts` 的 `scopeNamesOf` 串出来递进来
   * (落差 #51:写死那串「搜文件、章节、消息、会话…」上一次说对是在「章节」
   * 还是一个档的时候)。 */
  'search.placeholderOf': '搜{names}…',
  /* 串档名用的顿号。它是**标点不是文案**,但中英两边不是同一个符号,所以成对进字典。 */
  'search.scopeJoin': '、',
  'search.label': '搜索',
  'search.scopeLabel': '搜索范围',
  'search.scopeAll': '所有',
  /* ── 能力自述的文案键(S4a)────────────────────────────────────────
   * tab 上的名字由 `search.capabilities` 回来的 `manifest.labelKey` 点名,
   * 壳只负责按那个键查字典。所以**加一类能搜的东西 = 这里加两行(zh/en)**,
   * 面板一个字不改;插件能力自带成品文案(它的 `labelKey` 查不到就画原文)。
   * `search.scopeSessions` / `search.scopeFiles` 两条随旧那三档一起退役 ——
   * 今天会话那一档的名字来自 `search.capability.chats`。 */
  'search.capability.chats': '会话',
  'search.capability.messages': '消息',
  'search.capability.files': '文件',
  'search.capability.daily': '笔记',
  'search.capability.prompts': '提示词',
  'search.capability.actions': '命令',
  'search.resultsLabel': '结果',
  'search.noResults': '无结果',
  /* 零结果那一屏:一句话说清**没搜到什么**,第二行给下一步(与当前生效的片对应)。
   * 「无结果」三个字不说出用户搜的是什么,而那正是这一刻他最想确认的东西。 */
  'search.noResultsFor': '没有和「{query}」匹配的结果',
  'search.emptySearchAllSpaces': '搜全部空间',
  'search.emptyClearFilters': '清除过滤',
  /* 徽上的字。**由目标渲染器点名**(`search/targets/<kind>.tsx` 的 `badge()`),
   * 一种 `target.kind` 一句;文件那一种的徽是**数据**(扩展名),不在这张表里。 */
  'search.badgeSession': '会话',
  'search.badgeMessage': '消息',
  'search.badgeDaily': '笔记',
  'search.badgePrompt': '提示',
  'search.badgeAction': '命令',
  /* 两颗事实徽(§9「徽」那一条)。归档会话**搜得到**(S3b 治好的那条病),
   * 所以要让人一眼看出这一行来自一间已归档的会话;跨空间徽只在「全部空间」
   * 过滤下才画 —— 那格过滤片是 S4b,今天这一颗画不出来。 */
  'search.badgeArchived': '已归档',
  'search.badgeOtherSpace': '别的空间',
  /* 来自向量路的行。**不是计数徽** —— 它说的是「这一条未必逐字含那个词」。 */
  'search.badgeSemantic': '语义',
  /* 后端把占位名(`New Chat`)归了空;首条用户消息也没有时画这一句。
   * 它是一个**状态**不是一个名字,所以行上斜体降一档。 */
  'search.untitledSession': '未命名会话',
  'search.openedFile': '已打开 {file}',
  /* D5 文件侧接真数据之后新增的两句。两句说的都是**产地的实情**,不是暂时的空:
   * 「最近打开的文件」后端没有产地,所以空词时文件侧本来就没有东西可给;
   * 检索失败与「没搜到」是两件事,合成一句就等于把失败说成空结果。 */
  /* S4b:壳这一侧只剩**一条**查询路(`search.query`),所以失败也只剩一句。
   * `search.filesNeedQuery` / `search.filesFailed` / `search.messagesFailed`
   * 三条随那三个壳自带产地一起退役 —— 空词那一形今天由 chats 能力自己接住,
   * 失败由后端一处说。 */
  'search.queryFailed': '没搜成',
  /* `all` 档里某一组塌了(§9 第四条:「某组 error 时组头一句『没搜成』」)。
   * 它与上面那句是两件事:上面那句说的是「这一发整个塌了」,这一句说的是
   * 「六组里有一组没答上来,别的照常」。 */
  'search.groupFailed': '没搜成',
  /* 会话进去了,那条消息却不在它的账本里(被删 / 被压缩掉)。**说出来**而不是
   * 咽下去:用户按了一下总得知道结果,而「滚到附近」是在说谎。 */
  'search.messageGone': '已进入会话 —— 那条消息不在里面了',
  /* 列表最后一条 item。计数是**读数**不是徽:它说的是「此刻看到了多少」,
   * 而总数只有在文件侧取尽的那一刻才真的知道(后端不下发总数,判据见
   * search/transitions.ts 的「分页」一节)—— 不知道就只说「加载更多」,不猜一个数。 */
  'search.loadMore': '加载更多',
  'search.loadMoreCount': '加载更多 · 已显示 {shown} / {total}',
  'search.loading': '加载中…',
  'search.loadFailed': '没加载出来 · 再试一次',
  /* 「不挑」那一档不等去外部枚举的那一路(文件),壳随即自己去问一次;这是那一块
   * 在那段时间里说的话。**不是「加载中…」**:那句说的是「你看到的行后面还在长」,
   * 这句说的是「这一类还没被问过」,它底下一行都没有。 */
  'search.scanning': '扫描中…',
  /* 扫盘的预算到点了。说清楚手上有多少,也承认不知道一共有多少 —— 这一路本来就
   * 答不出总数,所以这句话里永远不出现「共 N 条」。 */
  'search.partialScan': '已扫描 {shown} 条 · 未扫完',
  /* ── 底部状态行(§9 第三条)。四条读数各说各的一件事,一条都不合并。 ── */
  /* 后端给的**真总数**(单类档,能力知道才给)。上面那一行说的是「我手上有多少」,
   * 这一行说的是「全集有多大」—— 两个数,两句话。 */
  'search.totalCount': '共 {total} 条',
  /* 严格档没中、放宽之后才有的命中(§6.2)。不说出来,用户会以为自己那个词
   * 精确命中了这些行。**三级三句**(阶梯在 core/search/pipeline/plan.ts:
   * ①严格 ②去相邻 ③至少一半的词 ④任一词)—— 从前一句「按任一词匹配」包打三级,
   * 那在只放宽到②的时候是一句谎话:它说得比实际远。 */
  'search.relaxed1': '已放宽:不要求相邻',
  'search.relaxed2': '已放宽:命中至少一半的词',
  'search.relaxed3': '已放宽:按任一词',
  /* 这一发还在路上。**首发在飞时画的是它,不是「无结果」** —— 后者是一句谎话
   * (检索面终稿 拍点 K,报备修正)。 */
  'search.searching': '搜索中…',
  /* 某一类的头页塌了。组头退役之后这句话唯一诚实的落点是页脚(拍点 A);
   * 后端原话不上屏,进日志。 */
  'search.blockFailed': '{name}没搜成',
  'search.retry': '重试',
  /* 这台上根本没起索引(`status.mode === 'error'`)。**没有重试** ——
   * 重建索引不是一颗按钮能承诺的事。 */
  'search.indexUnavailable': '索引不可用 · 只显示未建索引的结果',
  /* 现在答的这一份还没追上账本。数是**真读数**(`search.status` 的 pending)。 */
  'search.indexPending': '索引更新中(剩 {pending})',
  /* 折账本的是另一台进程(§5.6)。今天恒 owner,所以这一行画不出来 ——
   * 键先备着,持有权落地那天壳一个字不改。 */
  'search.indexReader': '由 {host} 维护',
  /* 语义召回(S7 §15)还没就绪的那两态。四态里只有这两态值一行字:
   * `ready` 与 `off` 什么都不画 —— 开关关着不是新闻,能用了也不必宣布。 */
  'search.vectorDownloading': '语义召回:下载中',
  'search.vectorEmbedding': '语义召回:建向量中(剩 {pending})',
  /* 两句「这一下没接上」。**说出来而不是静默吞掉** —— 一次按下去什么都不发生的
   * 点击,比一句「还没接上」更让人怀疑是不是自己按错了。 */
  /* ── 页级动作(R3:动作不是结果)────────────────────────────────────────
   * 后端只交 `labelKey + params`(能力自报),句子在这里 —— 「新建提示词 “jira”」
   * 里那个引号中间的字是**料**,不是句子的一部分。 */
  'search.action.createPrompt': '新建提示词 “{title}”',
  'search.action.createDailyNote': '新建今天的日记',
  'search.actionUnavailable': '这条动作在这里还打不开:{action}',
  'search.targetUnavailable': '这一类结果还打不开:{kind}',

  /* ── 过滤片(S4b,§9 第五条)────────────────────────────────────────────
   * 片名是**片自己叫什么**(空间 / 角色 / 时间),值是**此刻挑的是哪一格**。
   * 两截分开,因为片名永不弯腰、值才是那个会长的东西(挤压纪律)。
   * 一颗片画不画由能力自述说了算 —— 这些键在没有产地时一句都不上屏。 */
  'search.filterSpace': '空间',
  'search.filterSpaceCurrent': '当前',
  'search.filterSpaceAll': '全部',
  'search.filterRole': '角色',
  'search.filterRoleAny': '不挑',
  'search.filterRoleUser': '用户',
  'search.filterRoleAssistant': '助手',
  'search.filterTime': '时间',
  'search.filterTimeAny': '不挑',
  'search.filterTimeToday': '今天',
  'search.filterTimeWeek': '7 天',
  'search.filterTimeMonth': '30 天',
  'search.filterTimeCustom': '自定',
  /* 两颗两态片。**缺省是「含」**(等价于一格都不发)—— 关掉它才落成一格过滤。 */
  /* 两颗从前的「两态片」改成两格选项(09-05 裁定:按下态语义反了,改形根治)。
   * 片名是名词(「归档」),值才是「含 / 不含」—— 与空间 / 角色 / 时间同一形。 */
  'search.filterArchived': '归档',
  'search.filterReasoning': '推理',
  'search.filterWith': '含',
  'search.filterWithout': '不含',
  /* ── 续搜(S4b,§4.6)──────────────────────────────────────────────────
   * 范围片是「加一格过滤,词留着」;枢轴是「换一次查询」。两句话说清这个区别,
   * 所以不合并成一句「在这里搜」。 */
  'search.continueInSession': '在此会话内搜',
  'search.continueInDir': '在此目录内搜',
  'search.pivotSessionMessages': '它的消息',
  'search.pivotFileMentions': '提到它的消息',
  'search.scopeChipRemove': '去掉这个范围',
  'search.historyBack': '回上一条查询',
  'search.historyForward': '再往前一条',
  /* 行的右键动作表(动作单产地 = 右键上下文菜单,09-01 判例)。 */
  'search.rowActions': '这一条能做什么',
  'search.rowOpen': '打开',
  /* 「查看全部」从组头搬进这张表(R1:组头退役)。说的是同一件事,落点换了。 */
  'search.onlyThisKind': '只看这一类',
  /* ── 预览窗(S4b,§4.5)────────────────────────────────────────────────
   * 五种状态各有一句,一句都不合并:没选中 / 这一类没有预览 / 算不出(后端原话
   * 跟在下一行)/ 壳还画不出这种媒介 / 载荷不成形。 */
  'search.previewEmpty': '选一条看看',
  'search.previewNone': '这一类还没有预览',
  'search.previewFailed': '预览算不出来',
  'search.previewUnavailable': '这种预览还画不出来:{kind}',
  'search.previewMalformed': '这份预览的形状不对',
  'search.previewLoading': '正在读…',
  'search.previewRoleUser': '用户',
  'search.previewRoleAssistant': '助手',
  'search.previewMessageCount': '消息',
  'search.previewUpdatedAt': '更新于',
  'search.previewUnknownTime': '不知道',
  'search.previewBatchSummary': '共 {total} 条 · 画出来 {shown} 条',

  /* ── 聊天区(D3:正文/工具名/错误原文都是**数据**,不在这儿) ────────── */
  'chat.noSession': '还没有选中会话',
  'chat.loading': '正在读这条会话…',
  // 列表顶端那一行读数(工单 5 ⑥)。三档都是**文字**——列表/卡的加载态禁 spinner。
  'chat.olderMore': '还有更早的',
  'chat.olderLoading': '正在取更早的…',
  'chat.olderNone': '已到开头',
  // 工具结果太大、还没取正文时,卡上那几句(工单 5 ②)。
  'chat.tool.resultDeferred': '结果 {size},展开时取',
  'chat.tool.resultLoading': '正在取结果…',
  'chat.tool.resultFailed': '这一格结果读不到',
  'chat.error': '读不到这条会话',
  'chat.empty': '这条会话还没有消息',
  'chat.errorCard': '出错了',
  /* 用户消息里那枚 `@路径` chip 的 Tooltip / 无障碍名(content/user-message)。
   * 路径是数据不是文案 —— 它按 {path} 插进来,两门语言都原样带全路径。 */
  'chat.ref.openFile': '打开 {path}',
  'chat.ref.openDir': '打开目录 {path}',
  'chat.thought': '思考',
  'chat.streaming': '正在生成',
  /* ── 上下文更新 chip(U3)──────────────────────────────────────────────
   * 块名是**回合通道片段 id 的人话名**,不是这里发明的分类:改名要去产地
   * (prompts/builder.ts 的 turn 片段 / variable-board.ts / plugin-context.ts)。
   * 壳不认识的块 id **原样显示 id**,不进字典 —— 那是数据不是文案。 */
  'chat.contextDeltaTitle': '上下文更新',
  'chat.contextDeltaCount': '{name} {n}',
  /* 技能引用那枚 chip(09-12):点了打开那条技能所在的目录。技能名是数据。
   * 三条路全落空时那句 warn —— 不带详情,因为没有详情可看。 */
  'chat.ref.openSkill': '打开技能目录 {name}',
  'chat.ref.openSkillFailed': '打不开技能目录 {name}',
  /* 提示词引用那枚药丸没有标题时的兜底(它不可点,只是把这一格说出来)。 */
  'chat.ref.promptUntitled': '未命名提示词',
  'chat.contextDeltaRemoved': '移除 {n}',
  'chat.contextDeltaGone': '已移除',
  'chat.contextDeltaCollapse': '收起',
  'chat.contextDeltaBlockVariables': '变量',
  'chat.contextDeltaBlockTodo': '待办',
  'chat.contextDeltaBlockSkills': '技能',
  'chat.contextDeltaBlockActiveProject': '当前项目',
  'chat.contextDeltaBlockKnownProjects': '项目清单',
  'chat.contextDeltaBlockAgentsMd': '项目约定',
  'chat.contextDeltaBlockVoice': '语音',
  'chat.contextDeltaBlockPlugins': '插件',
  'chat.retry': '重试',
  'chat.discard': '不发了',
  /* ── 压缩折痕(U2)────────────────────────────────────────────────────
   * 「重试」不在这里 —— 它复用 `chat.retry`(同一件事在同一台上不该有两种叫法)。
   * provider 那句失败原文是**数据**,原样显示,不进字典。
   * 分隔号 `·` 是排版,拼在代码里(与上下文更新折痕那一行同一手)。 */
  'chat.compactRunning': '正在压缩上下文',
  'chat.compactProgress': '{chunk} / {total}',
  'chat.compactDone': '已压缩 {n} 条',
  'chat.compactSize': '{before} → {after}',
  'chat.compactRetained': '剩 {after}',
  'chat.compactFailed': '压缩失败',
  'chat.compactCollapse': '收起摘要',
  /* 流式读数行(台一定稿):一句话说完「还活着 + 跑了多久」。
   * tokens 那一格**不在这句话里** —— 壳今天没有活的 token 产地,详见汇报的留账。
   * 09-05:`{s}s` 改成 `{d}` —— 值由 `format/quantity.formatDuration` 交出来时
   * **已经带着单位**(一位小数的 `12.4s`,分钟档是 `1m 05s`),字典里再补一个
   * `s` 就会在分钟档写出 `1m 05ss`。单位归产地,不归模板。 */
  'chat.streamReadout': '正在生成 · {d}',
  /* ── 活性读数(§6.6)—— 「它是在接收流式,还是卡住了」───────────────────
   * 判据是**静默时长**(上一次收到 delta 到此刻),不是总耗时:一轮跑十分钟但
   * 每秒都在吐字是正常的,跑三十秒一个字没来才是异常。两句话分两键:软阈值只
   * 陈述事实(不下结论),硬阈值才补一句判断 —— 「可能」两个字不许去掉,
   * 壳没有能力知道它真的卡死了。 */
  'chat.streamStalled': '已 {silent} 没有新内容 · {d}',
  'chat.streamStuck': '可能卡住了',
  'chat.stop': '停止',
  /* ── 收场通知(2026-09-09 `length` 事故)────────────────────────────────
   * 这一轮**为什么提前结束**。事实全在账本里(`request/end.stopReason` + 同一条
   * 请求的配方与用量),这几句只是把它说成人话。
   * 「哪些收场原因值得占屏幕」不在这里 —— 那是 core 的 `stop-reasons.ts` 那张表,
   * 壳按它交出来的 `kind` 查这几个键。表里加一档而这里还没有对应句子时,落到
   * `chat.stopGeneric`(原样摆出 provider 的词),不会说错话。
   * 四句 output-limit 的分法:有没有可见正文 × 知不知道上限是多少。没有正文而
   * 产出几乎全是推理,那不是「被截断」,是「想完就没额度了,一个字没回」——
   * 用户要做的事不一样(前者续写,后者调上限 / 少让它想)。
   * `{max}` 已经带着进位(`format/quantity`),模板里不再补单位以外的东西。 */
  'chat.stopOutputLimit': '输出达到上限 {max} token,回复被截断',
  'chat.stopOutputLimitNoLimit': '输出达到上限,回复被截断',
  'chat.stopOutputLimitThinking': '输出达到上限 {max} token,思考还没结束就被截断,没有生成回复',
  'chat.stopOutputLimitThinkingNoLimit': '输出达到上限,思考还没结束就被截断,没有生成回复',
  'chat.stopContentFilter': '回复被内容过滤截断',
  /* provider 报的那个词是**数据**,原样摆出来,不进字典。 */
  'chat.stopGeneric': '回复提前结束({reason})',
  'chat.copy': '复制',
  /* 幽灵动作行整条的名字(读屏软件读它,眼睛看到的是两个字钮)。 */
  'chat.messageActions': '这条回复的动作',

  /* ── 跟随丸(§5.3 三张脸)────────────────────────────────────────────────
   * 三张脸只有两句字:生成中那张**一个字都不写**(三个点带动画,09-04 用户定),
   * 所以它只有无障碍名。箭头是文案的一部分(它说的是「往下」这个方向),
   * 不是图标 —— 图标会跟着字号变、会被换主题的人换掉,而这个箭头不该。 */
  'chat.follow.sent': '↓ 已发送',
  'chat.follow.reply': '↓ 回到最新',
  /* 生成中那张脸的无障碍名:先说此刻在发生什么,再说按下去会怎样。 */
  'chat.follow.streamingLabel': '正在生成,回到最新',
  'chat.tool.pending': '待执行',
  'chat.tool.queued': '排队中',
  'chat.tool.received': '已收齐',
  'chat.tool.executing': '执行中',
  'chat.tool.completed': '已完成',
  'chat.tool.failed': '失败',
  'chat.tool.cancelled': '已取消',
  'chat.tool.inputStreaming': '参数生成中',

  /* ── 工具卡(C2-a:一种卡 / 头行 / 三段流中态)──────────────────────────
   * 成果词是**事实的复述**,不是打卡词:「N 行」「+a −d」「退出 0」都在说这次
   * 调用做出了什么。上面那八档状态从此只在「还没有成果词可说」时才露面。
   *
   * C2-a 退役三键:`durationMs` / `durationS`(耗时改走 §5.7 的唯一产地
   * `format/quantity.ts`,只到 0.1s、永不写毫秒 —— 一个数的写法本来就没有译文)、
   * `toolGroup.count`(「执行了 N 步」那句计数旁白随头行退役)、
   * `toolGroup.moreKinds`(头行的溢出改写「+N」,是数不是话)。 */
  'chat.tool.lines': '{n} 行',
  'chat.tool.diffStat': '+{add} −{del}',
  'chat.tool.exitOk': '退出 0',
  'chat.tool.exitCode': '退出 {code}',
  'chat.tool.results': '{n} 条结果',
  'chat.tool.arguments': '参数',
  'chat.tool.result': '结果',
  'chat.tool.noResult': '这次调用没有留下结果',
  /* 执行中的行现在也能展开(C2-a 拍点 ⑩):它还没到留下结果的时候,
   * 对一条正在跑的调用说「没有留下结果」是说错,不是说少。 */
  'chat.tool.noOutputYet': '还没有输出',
  /* C2-b:一次还在跑的调用**此刻**报出来的输出。它是读数不是结果 —— 每来一份
   * 快照整段替换,也从不进账本。 */
  'chat.tool.liveOutput': '实时输出',
  /* 活性读数(§6.6)。壳**只会说「多久没收到数据」**,「卡住了」永远不是壳的判断
   * —— 真正的收场是引擎那一侧的超时与重试,这一行只是让那段等待看得见。 */
  'chat.tool.stallArgs': '参数已 {n} 秒没有新字符',
  'chat.tool.stallData': '已 {n} 秒没收到数据',
  'chat.tool.stallStuck': '可能卡住了',
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
  /* 超宽表的削列尾格(R4b):文字读数,不是计数徽。 */
  'block.table.moreColumns': '还有 {n} 列',
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
  /* agent ⇄ agent 私聊。徽用符号而不是汉字:它说的正是「两头都不是人」这件事,
   * 而 ⇄ 在两门语言里读法相同(en 那本原样同一个字符)。 */
  'kind.swapBadge': '⇄',
  'kind.workBadge': '工',
  'kind.agentBadge': '代',
  'kind.chat': '会话',
  'kind.room': '房间',
  'kind.dm': '私聊',
  'kind.swap': 'Agent 私聊',
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
  /* 月份名。中文是「9 月」,英文是「September」—— 一门语言一种体例,
   * 所以它是一族十二条,而不是一个 '{month} 月' 的模板(那样英文拼不出月名)。
   * 本年的分节标题**就是**这一条;跨年的由 expose.sectionMonthYear 再包一层。 */
  'time.month1': '1 月',
  'time.month2': '2 月',
  'time.month3': '3 月',
  'time.month4': '4 月',
  'time.month5': '5 月',
  'time.month6': '6 月',
  'time.month7': '7 月',
  'time.month8': '8 月',
  'time.month9': '9 月',
  'time.month10': '10 月',
  'time.month11': '11 月',
  'time.month12': '12 月',

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
  'perf.batchMore': ',本批另有 {count} 条',
  'perf.batchRest': '本批另有 {count} 条超预算:',

  /* ── 通知系统(08-30 批)────────────────────────────────────────────────
   * 面板标题不另起一个键:它就是 'item.notifications' 那两个字,
   * 同一句话不该有第二个键(与 SHELF_SIDE_CHOICES 复用 Dock 那四个边键同一条)。
   * 组头三个键与 'time.yesterday' 刻意分开:那一个是时间戳里的「昨天」,
   * 这三个是列表的**组标**(英文小写、灰、字距撑开),两种体例不共用一个键。 */
  'notify.filterAll': '全部',
  'notify.filterWarn': '警告',
  'notify.filterError': '错误',
  'notify.filterLabel': '按级别过滤',
  'notify.copyAll': '复制全部',
  'notify.markAllRead': '全部已读',
  'notify.clear': '清空',
  'notify.today': '今天',
  'notify.yesterday': '昨天',
  'notify.earlier': '更早',
  'notify.empty': '还没有通知',
  'notify.repeat': '×{count}',
  'notify.openLog': '打开完整日志(app.jsonl)',
  'notify.more': '+{count} 更早 · 打开通知中心',
  /* 弹框上通往通知中心那条可展开记录的门(09-01:栈与完整 URL 不铺在弹框上)。 */
  'notify.viewDetails': '查看详情',

  /* 各产地报出来的那句话。它们是**界面文案**(换语言要跟着变),
   * 所以在字典里;而错误本身的文字是数据,原样进 body / detail。 */
  /* 09-01 改人话:从前这里直接摆 `event.filename`(一条带 ?t= 的完整模块 URL),
   * 用户读到的是一句机器话。现在 {where} 收的是短名(见 services/crash.ts 的
   * shortWhere),完整那条在详情里。 */
  'notify.crash': '界面出错了 · {where}',
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
  // 09-02 批 6:「正在保存…」是**任何一颗异步钮**的忙态话,不是查看器的话。
  // 从前三处(查看器存盘、模型目录手填钮、总览新建卡)借的都是 `viewer.saving` ——
  // 一个域的键被别的域借用,改一个字就会在两个不相干的面上同时变。
  'common.saving': '正在保存…',
  /* 任何一颗**不是在存东西**的异步钮的忙态话(音乐那十三条做法都是)。 */
  'common.working': '进行中…',
  'notify.copied': '已复制这条回复',
  'notify.copyFailed': '没能复制',
  'notify.retryFailed': '重试没有发出去',
  'notify.retryRejected': '重试被 core 拒了',
  'notify.retryBusy': '这一轮还在跑,先停止再重试',
  'notify.retryBusyHint': '重试会删掉这条回复重新生成;引擎忙的时候不发。',
  'notify.retryStuck': '重试发出去了,core 还没开新一轮',
  'notify.retryStuckHint': '命令已经被 core 收下,但账本上没长出新的 run。',
  'notify.permissionFailed': '审批没有发出去',

  /* ── 权限卡与已授权账页(应用级许可 · 壳半边,2026-09-10)───────────────────
   * **效果类那 17 个名字是后端枚举 → 字典键的一张明表**(照 content/tools/status.ts
   * 的 TOOL_STATUS_KEYS 立法):不拼键、认不出来的原样摆那个英文枚举 —— 那是事实,
   * 编一句中文是猜。表在 content/permission/effect-label.ts。
   * **资源串(路径 / 地址 / 命令)一个字都不在字典里**:它们是数据。 */
  'permission.waiting': '等待授权:{title}',
  'permission.queuedLabel': '排队等待授权:{title}',
  'permission.queued': '排在前一个审批后面',
  'permission.allowOnce': '允许一次',
  'permission.allowSession': '本会话',
  'permission.allowWorkdir': '本工作目录',
  'permission.allowAlways': '始终允许「{app}」',
  'permission.reject': '拒绝',
  'permission.sending': '提交中…',
  'permission.answeredAllow': '已允许,等核心确认',
  'permission.answeredReject': '已拒绝,等核心确认',
  'permission.effect.read': '读取',
  'permission.effect.file_edit': '改文件',
  'permission.effect.file_write': '写文件',
  'permission.effect.file_destructive_edit': '覆盖文件',
  'permission.effect.bash': '执行命令',
  'permission.effect.mcp': '调用 MCP 工具',
  'permission.effect.external_directory': '访问项目之外的目录',
  'permission.effect.sensitive_file_read': '读取敏感文件',
  'permission.effect.capability_change': '改指向',
  'permission.effect.net_fetch': '访问网络',
  'permission.effect.user_ask': '向你提问',
  'permission.effect.session_message': '往会话里发消息',
  'permission.effect.session_spawn': '新建会话',
  'permission.effect.session_destructive': '删会话内容',
  'permission.effect.plugin_exec': '运行插件',
  'permission.effect.external-agent': '调用外部 agent',
  'permission.effect.ui_change': '改界面',
  'permission.effect.browser_navigate': '让内置浏览器去一个地址',
  /* ── 内置浏览器(B2′:content/settings/BrowserSettings.tsx)──────────────────
   * 「开着会有什么后果」那两句是**会造成后果的警告**,所以它们是文案不是数据,
   * 双语成对。端口是数据,由 `{port}` 插进来 —— 换一门语言它不该变。 */
  'settings.sectionBrowser': '内置浏览器',
  'browser.cdpLabel': '允许 AI 与外部工具控制(CDP)',
  'browser.cdpHint':
    '开启后下次启动生效;本机任何程序都能驱动这个浏览器,包括登着账号的页面与 onething 自己的界面。',
  'browser.loadFailed': '浏览器设置拉不到',
  'browser.cdpSaveFailed': '这一格没能存上',
  'browser.mcpInstall': '给 AI 装上',
  'browser.mcpInstalling': '安装中…',
  'browser.mcpInstalled': '已装上',
  'browser.mcpInstalledNote': '已装上,重启 onething 后 AI 可用。',
  'browser.mcpInstallFailed': '没能装上',
  'browser.copyConfig': '复制给 Claude Code / Cursor 的配置',
  'browser.copyConfigTip': '复制一段 JSON,贴进它们的 MCP 配置里。',
  'browser.cdpPortNote': '调试口开在 127.0.0.1:{port},只监听本机。',
  'browser.newPageNote': 'new_page 在 Electron 上不可用,AI 开新标签走内置 browser 工具。',
  'browser.searchEngineLabel': '地址栏搜索用',
  'browser.searchEngineHint': '地址栏里打一句不像网址的话时,去哪儿搜。',
  'browser.searchEngineSaveFailed': '搜索引擎没能存上',
  'browser.profilesLabel': '身份',
  'browser.profilesHint': '一格身份 = 一套独立的 cookie 与登录。同一个网站可以用两个号各开一格标签页。',
  'browser.profileName': '身份的名字',
  'browser.profileAdd': '新建身份',
  'browser.profileDelete': '删掉这个身份',
  'browser.profileDeleteTitle': '删掉「{name}」?',
  'browser.profileDeleteBody': '这个身份下的登录与数据会消失,它开着的标签页会被关掉。这一下撤不回来。',
  'browser.profileDeleteConfirm': '删掉',
  'browser.defaultProfileLabel': '新标签页用哪个身份',
  'browser.profileSaveFailed': '身份没能存上',
  'settings.sectionPermissions': '已授权',
  'permissions.hint': '这些是你点过「本会话」「本工作目录」「始终允许」之后记下来的许可。',
  'permissions.empty': '还没有记下任何许可 —— 每一次动手都会问你。',
  'permissions.loadFailed': '授权账页拉不到',
  'permissions.revokeFailed': '撤销没有成功',
  'permissions.ungrouped': '单条许可',
  'permissions.revoke': '撤销',
  'permissions.revoking': '撤销中…',
  'permissions.revokeApp': '全部撤销',
  'permissions.scopeSession': '本会话',
  'permissions.scopeWorkspace': '本工作目录',
  'permissions.revokeOne': '撤销「{what}」',
  'permissions.revokeAppOf': '撤销「{app}」的全部许可',

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
  /* 面包屑(08-31 IDE 紧凑树:面板内那个与 tab 重名的「文件」大标题退役,
   * 头上换成路径本身)。**路径的每一段都是数据**,字典里只有这一句无障碍名。 */
  'files.breadcrumb': '当前路径',
  /* 详情面(双击一行)。大小与时间只活在这里,不进树。 */
  'files.detailTypeLabel': '类型',
  'files.detailSizeLabel': '大小',
  'files.detailModifiedLabel': '修改时间',
  'files.detailPathLabel': '完整路径',
  'files.typeFile': '文件',
  'files.typeDirectory': '目录',
  'files.copyPath': '复制路径',
  'files.collapseAll': '全部收起',
  'files.hint': '单击打开 · 行尾 ⋯ 或右键出菜单',
  'files.rowMenu': '更多操作',
  'files.splitLabel': '树与查看区的分隔杆(← → 调宽度,↵ 回默认)',
  'files.menuOpen': '打开查看',
  'files.menuExpand': '展开',
  'files.menuCollapse': '收起',
  'files.openWith': '打开方式',
  'files.openIn.panel': '面板内',
  'files.openIn.stage': '主区域',
  'files.openIn.edgeTop': '上侧钉',
  'files.openIn.edgeBottom': '下侧钉',
  'files.openIn.edgeLeft': '左侧钉',
  'files.openIn.edgeRight': '右侧钉',
  'files.openIn.float': '浮窗',
  'files.openModeSoon': '还没接上',
  'files.menuKeep': '保留',
  'files.menuHide': '隐藏',
  'files.menuClose': '关闭',
  'files.menuOpenRight': '在右侧打开',
  'files.menuOpenBelow': '在下方打开',
  'files.openStateShown': '打开着',
  'files.openStateHidden': '打开着(已隐藏)',
  /* 目录面板(W6-a)。 */
  'files.recentDirs': '最近打开的目录',
  'files.openDirTitle': '打开目录…',
  'files.openDirConfirm': '打开',
  'files.openDirPlaceholder': '绝对路径,例如 /Users/me/notes',
  'workbench.leafTabs': '标签',
  'workbench.hiddenTabs': '隐藏的标签',
  'workbench.hiddenNote': '已隐藏',
  /* 一颗 ⋯、一张表、两节(W7-t / B1):滚出视野的与收起来的。
   * 两节答的是同一句话 —— 「这一格此刻点不到」。 */
  'workbench.reachTabs': '够不着的标签',
  'workbench.offscreenTabs': '看不见的',
  /* ⌘W 落在关不掉的那一格上时说的那句话(W7-t / B12)——
   * 与拖拽拒绝那句同一口 announce。 */
  'workbench.tabNotClosable': '这一格关不掉 —— 它是这儿最后一格同类',
  /* 动作表自己的无障碍名(W6-c)。开它那颗钮上仍旧写着「分屏」;
   * 表自己按它**是什么**起名,不按它第一项叫什么起名。 */
  'workbench.tabActions': '标签动作',
  'workbench.split': '分屏',
  'workbench.splitRight': '在右侧',
  'workbench.splitLeft': '在左侧',
  'workbench.splitDown': '在下方',
  'workbench.splitUp': '在上方',
  'workbench.splitterLabel': '分隔杆',
  'workbench.topbarTabs': '中央区标签',
  /* 中央区什么都没有的那一态(W7-t / A12)。空态说两句话:
   * 这儿本来该有什么、以及怎么让它回来。 */
  'workbench.centerEmpty': '这儿什么都没开着',
  'workbench.centerEmptyNew': '新建会话',
  /* 一个标签装两格(W6-a)。 */
  'workbench.pair': '二合一',
  /* 关这一格标签(W7-c 裁定 3 的第六项)。它与 tab 上那颗 ✕、与 ⌘W 是同一件事,
   * 所以句子只说动作、不带宾语 —— 宾语就是右键点中的那一格。 */
  'workbench.tabClose': '关闭',
  /* 预览格那两句(C2)。`tabPreview` 是**只念不看**的状态词(斜体给眼睛看,
   * 这一句给读屏软件听);`tabKeep` 是右键表里那一行「转正」。 */
  'workbench.tabPreview': '预览',
  'workbench.tabKeep': '保留',
  /* 钉住那一行(C3,设计 §3.4)。一个开关两句话,同一行轮流说 —— 判词在
   * `LeafActions` 的 `isCompanion` 那一格上。播报是**落定**的一部分,
   * 所以「已钉住 / 已取消钉住」跟着动作走,不是菜单的装饰。 */
  'workbench.tabPin': '钉住(不随会话收放)',
  'workbench.tabUnpin': '取消钉住',
  'workbench.tabPinned': '已钉住 —— 换会话时它留在原处',
  'workbench.tabUnpinned': '已取消钉住 —— 它跟着会话收放',
  'workbench.pairRight': '与右边的标签二合一',
  'workbench.pairLeft': '与左边的标签二合一',
  'workbench.unpair': '拆开',
  /* 格头上那颗 × 只关这一格(W7-t / B7,设计 §6)。 */
  'workbench.closePairSide': '关闭{name}',
  'workbench.unpaired': '已拆开',
  'workbench.pairedWith': '已与{name}并排',
  'workbench.pairSplitter': '两格分隔杆',
  'workbench.pairBroken': '这一格的两格读不出来',
  /* ── 拖拽(W3)—— 浮影上那句话与落区上那句话共用这一族 ─────────────── */
  'drag.toFloat': '撕成浮窗',
  'drag.toEdgeLeft': '移到左侧',
  'drag.toEdgeRight': '移到右侧',
  'drag.toEdgeTop': '移到上方',
  'drag.toEdgeBottom': '移到下方',
  /* 那一种自述了 `ContentKind.regions`,而这个落点不在里面(W5-b 裁定 8)。
   * 它顶掉了 W3 那句专供会话行的 `drag.sessionOnlyCenter`:拒绝从此由种类自述
   * 生成,不再是某一处手写的判据。 */
  'drag.regionRefused': '这一种开不到这里',
  /* **这条边摆不下**(W7-p 裁定 3):四条边与中央区分同一块地,预算不够时
   * **拒绝并保持原样**,不许把中央区压成 0(审计 A 的 A3:四边各钉 400,
   * 真机量到中央区 h=0、输入框浮在上架子的内容上)。拒绝要说话,不许静默。 */
  'stage.shelfNoRoom': '{side}放不下了 —— 先收一条架子',
  'drag.movedToEdge': '已移到{side}',
  'drag.movedIntoLeaf': '已并入{name}',
  'drag.movedToFloat': '已撕成浮窗',
  'drag.menuMoveTo': '移到架子',
  /* W3-b 裁定 8 立、W7-c 从菜单里搬到**全局命令**:条内换序的键盘等价。
   * 走的仍是同一只 `reorderTab`;命令名要在设置页那一列里说得出自己动的是什么,
   * 所以带上宾语「标签」。 */
  'keymap.moveTabLeft': '标签左移一位',
  'keymap.moveTabRight': '标签右移一位',
  'drag.reordered': '已移到第 {at} 位,共 {total} 位',
  'drag.menuTearOff': '撕成浮窗',
  /* ── 浮影下那行字(W6-b,设计 v3 §5「浮影下那行字永远不空」)──────────────
   * 它是拖拽期间**唯一一处**出现的文字:落区上不再写字。每一种落点各一句,
   * 一张表 —— 判据换了落点,字跟着换,两处不必各写一遍。 */
  'drag.hint.back': '松手放回',
  'drag.hint.strip': '放到第 {at} 位',
  'drag.hint.open': '开成新标签',
  'drag.hint.float': '松手成新浮窗',
  'drag.hint.pairLeft': '与「{name}」二合一 · 放在左侧',
  'drag.hint.pairRight': '与「{name}」二合一',
  'drag.hint.replaceLeft': '替换左半边的「{name}」',
  'drag.hint.replaceRight': '替换「{name}」',
  'drag.hint.edgeLeft': '钉成左侧架子',
  'drag.hint.edgeRight': '钉成右侧架子',
  'drag.hint.edgeTop': '钉成上方架子',
  'drag.hint.edgeBottom': '钉成下方架子',
  /* 拒绝三句(§5 第一行 + §6「不允许」+ U3 的「家不许空着」)。 */
  'drag.refuseHere': '这里不能放',
  'drag.refusePairNest': '两格的标签不能再并',
  /* U3:中央区最后一格常驻内容撕不走。**不点种类名** —— 判据认的是种类自述的
   * `resident.region`,而这句话是拒绝行里的固定一句(`DropRules.accepts` 只交
   * 一个 key,交不了变量),所以用壳自己的词说「中央区」与「一格」。 */
  'drag.refuseResidentLeave': '中央区要留一格,这一格挪不走',
  'drag.sideLeft': '左侧',
  'drag.sideRight': '右侧',
  'drag.sideTop': '上方',
  'drag.sideBottom': '下方',
  'files.detailAction': '详情',
  'files.copiedPath': '已复制路径',
  'files.retry': '重试',
  'files.bind': '绑定…',
  'files.bindPlaceholder': '输入工作目录的绝对路径',
  'files.bindFailed': '没能绑定工作目录',
  'files.detailLoading': '正在读取信息…',
  'files.detailDenied': '没有权限读这一项的信息',
  'files.detailMissing': '这一项不在了',
  'files.detailFailed': '读不到这一项的信息',

  /* ── 文件查看器(content/viewer,F1)──────────────────────────────────────
   * 从前那一层「预览」的字典整条退役了 —— 它说的是「瞄一眼」,而这里是**看**:
   * 一份文件按它自己的样子完整地铺开(代码带行号、markdown 按正文排版、图能缩放)。
   * 文件名、路径、后端原话照旧一个字都不在字典里:它们是数据。 */
  'viewer.label': '文件查看器',
  'viewer.close': '关闭查看器',
  'viewer.reading': '正在读取…',
  'viewer.empty': '这个文件是空的',
  /* 五种「看不成」各说各的,一种都不回退到别的那一种。 */
  'viewer.binary': '这是二进制文件,没法按文本查看',
  'viewer.oversize': '这个文件超过 {limit},没有按文本打开',
  'viewer.denied': '没有权限读这个文件',
  'viewer.missing': '这个文件不在了',
  'viewer.failed': '读不到这个文件',
  'viewer.imageFailed': '这台取不到这张图的字节',
  /* 只载了开头一段(判据:真实字节数 > 已经要到的量)。 */
  'viewer.truncated': '文件有 {size},已经载入前 {shown}',
  'viewer.loadedPercent': '已载入 {percent}% · 共 {size}',
  'viewer.loadMore': '继续加载',
  /* 各形自己那一格动作(工具条与状态栏)。 */
  'viewer.wrap': '折行',
  'viewer.mdView': '渲染方式',
  'viewer.mdRendered': '渲染',
  'viewer.mdSource': '源码',
  'viewer.zoomLabel': '缩放',
  'viewer.zoomFit': '适应',
  'viewer.zoomActual': '1:1',
  'viewer.mediaFailed': '这台取不到这个文件的字节,放不了',
  'viewer.noFile': '还没有打开的文件 —— 去文件树里点一个',
  /* ⌘L 跳转条 —— 跳转的唯一入口。四档里今天只有行号真接上。 */
  'viewer.jumpLabel': '跳转到',
  'viewer.findLabel': '在这份文件里检索',
  'viewer.findReadout': '检索 ⌘F',
  'viewer.jumpHitCount': '第 {index} 个 · 共 {total} 个',
  'viewer.jumpNoHit': '没有命中',
  'viewer.jumpPlaceholder': '行号,或 # 符号 · / 检索 · @ 改动',
  'viewer.jumpLine': '行号',
  'viewer.jumpSymbol': '符号',
  'viewer.jumpSearch': '检索命中',
  'viewer.jumpDiff': '改动处',
  'viewer.lineReadout': '行 {line}:1  ⌘L',
  /* 键位档。档只是一张表,换档即时生效。 */
  'viewer.keymapDefault': '默认键位',
  'viewer.keymapVim': 'Vim',
  /* 轻编辑:铅笔 → 等宽可写文本 → ⌘S。 */
  'viewer.edit': '编辑',
  'viewer.editDone': '完成编辑',
  'viewer.editing': '正在编辑 {name}',
  'viewer.unsaved': '未保存',
  'viewer.save': '保存 ⌘S',
  // `viewer.saving` 已删(09-02 批 6):那句话进了 `common.saving` —— 它本来就是
  // 任何一颗异步钮的忙态话,查看器只是它的第一个消费者(而后来又被另外两处借走)。
  'viewer.saved': '已保存',
  'viewer.saveFailed': '没能保存',
  'viewer.conflict': '这个文件在你打开之后被改过 —— 没有覆盖',
  'viewer.confirmTitle': '还有没保存的改动',
  'viewer.confirmBody': '{name} 有改动还没保存。关掉就没了。',
  'viewer.discard': '不保存',
  'viewer.saveAndClose': '保存并关闭',

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
  /* 窄面板里左栏收成一条图标条,这两句是那颗钮的名字(它同时是 aria-label 与提示)。 */
  'providers.railExpand': '展开服务商名册',
  'providers.railCollapse': '收起服务商名册',
  'providers.groupCloud': '云服务',
  'providers.groupLocal': '本地',
  'providers.groupCustom': '自定义',
  'providers.addCustom': '＋ 自定义服务商',
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
  'providers.baseUrl': '高级 · Base URL',
  'providers.baseUrlDefault': '(默认)',
  'providers.baseUrlSave': '保存 Base URL',
  'providers.baseUrlDefaultIs': '默认地址 {url} —— 清空这一格就回到它。',
  'providers.baseUrlDialOwned': '这一家的地址由上面的计费档位算出来:手改之后再拨一次档位会把它覆盖掉。',

  /* 凭证池:多把密钥 / 顺序 / 轮换策略 / 冷却
   * 「顺序即优先级」不是一句提示,是这张表的**读法** —— 第 1 条就是最先用的那条。
   * 策略名与语义句逐字照生产(SpaceCredentialPool.vue:367-377):这几个字用户
   * 已经认识了,这块壳没有资格另起一套。 */
  'providers.keyCount': '密钥 · {count} 条',
  'providers.keyNone': '还没有密钥。',
  'providers.keyAdd': '＋ 添加密钥',
  'providers.keyAddNew': '新密钥',
  'providers.keyAddNote': '备注名(可空)',
  'providers.keyAddSubmit': '添加',
  'providers.keyNewEmpty': '粘贴新的密钥',
  'providers.keyReveal': '显示密钥',
  'providers.keyHide': '隐藏密钥',
  'providers.keyMenuFor': '第 {ordinal} 条的更多动作',
  'providers.keyMenuReplace': '换一把密钥…',
  'providers.keyMenuRename': '改备注名…',
  'providers.keyMenuDelete': '删除…',
  'providers.keyReplaceFor': '给第 {ordinal} 条换一把密钥',
  'providers.keyReplacedFrom': '{preview} →',
  'providers.keyLabelFor': '改第 {ordinal} 条的备注名',
  'providers.keyDelete': '删除',
  'providers.keyDeleteAsk': '删掉这一条?已经记在它名下的用量仍留在账本里。',
  'providers.keyDeleteFor': '删除第 {ordinal} 条',
  'providers.keyMoveUp': '上移',
  'providers.keyMoveDown': '下移',
  'providers.keyMoveUpFor': '把第 {ordinal} 条上移',
  'providers.keyMoveDownFor': '把第 {ordinal} 条下移',
  'providers.keyOAuthEntry': '订阅账号',
  'providers.poolFailed': '凭证没写上',
  'providers.rotation': '轮换策略',
  'providers.rotationSingle': '只用第一条',
  'providers.rotationFailover': '按序接力',
  'providers.rotationRoundRobin': '轮流使用',
  'providers.rotationSingleHint': '始终用最上面那条,不自动换 —— 它冷却时这个 provider 就停用。',
  'providers.rotationFailoverHint': '从上往下取第一条可用的;配额耗尽或被限流会自动换下一条。顺序即优先级。',
  'providers.rotationRoundRobinHint': '每次请求轮换到下一条,把用量摊开;冷却中的条目自动跳过。',
  'providers.rotationUnknown': '{policy}(不可用)',
  'providers.rotationUnavailable': '这条策略此刻不可用,正在用内置的「按序接力」。你的选择保留着,插件回来它自动生效。',
  'providers.coolSoon': '即将恢复',
  'providers.coolMinutes': '剩 {count} 分钟',
  'providers.coolHours': '剩 {count} 小时',
  'providers.coolDays': '剩 {count} 天',
  'providers.cooling': '冷却中',

  /* 订阅坑 */
  'providers.subIntro': '用你已有的订阅跑模型,不产生额外 API 费用。这一坑的模型不按 token 计价。密码只在浏览器里输入,应用不经手。',
  'providers.subAccount': '账号',
  'providers.subSignIn': '登录',
  'providers.subCatalogLocked': '登录后才有模型目录 —— 没登录时这一坑有哪些模型,应用并不知道。',
  /* 登录流三形。**画哪一形由后端这一次的答案定**(判据在 auth.ts 文件头)。 */
  'providers.subDeviceCode': '在网页里输入这串码',
  'providers.subDeviceUrl': '验证网址',
  'providers.subWaiting': '等待确认…确认后本页自动接续,不用手动回来。',
  'providers.subPasteHint': '浏览器里完成授权;若没有自动跳回,把授权码粘回来。',
  'providers.subCodeLabel': '授权码',
  'providers.subCodeSubmit': '提交',
  'providers.subBrowserWaiting': '已在浏览器里打开授权页,完成后这边自动接续。',
  'providers.subCancel': '取消登录',
  'providers.subFailed': '登录失败',
  'providers.subTimedOut': '等太久了 —— 这一次登录已经作废,重新来一次。',
  'providers.subReauth': '重新授权',
  'providers.subSignOut': '退出登录',
  'providers.subSignOutFor': '退出 {account}',
  'providers.signOutFailed': '退不出去',
  'providers.subTokenValid': '令牌有效',
  'providers.subTokenExpired': '令牌已过期,需要重新授权',
  'providers.subExpires': '有效期至 {time}',
  'providers.subPlan': '套餐 {plan}',
  'providers.subAccounts': '这一坑支持多账号 · 现有 {count} 个',
  'providers.subAddAccount': '＋ 添加账号',

  /* 订阅用量。**拿不到的读数如实缺席,不显示 0%** —— 0% 是「一点没用」,
   * 而缺席是「不知道」,这两件事在屏幕上长得像、在事实上差得远。 */
  'providers.usage': '订阅用量',
  'providers.usageCache': '60s 缓存',
  'providers.usageRefresh': '刷新',
  'providers.usageLoading': '正在问用量…',
  'providers.usageFailed': '用量拿不到',
  'providers.usagePlan': '套餐',
  'providers.usageCredits': 'Credits',
  'providers.usageUnlimited': 'Unlimited',
  'providers.usageNoCredits': '无额度',
  'providers.usageHasCredits': '可用',
  'providers.usageUnavailable': '服务商未给数',
  'providers.usagePrimary': 'Primary',
  'providers.usageSecondary': 'Secondary',
  'providers.usageWindow': '{name} · {window} 窗口',
  'providers.usageReset': '{time} 重置',
  'providers.usageMore': '其他限额({count})',

  /* 本地坑 */
  'providers.localIntro': '本机进程,零凭证。探测、连接与启动配置在下一批。',

  /* 自定义家 */
  'providers.customIntro': '自定义端点。改这一家的名称、地址与默认模型走下面那颗「编辑」。',
  'providers.customEdit': '编辑这一家',
  'providers.customAdd': '添加自定义服务商',
  'providers.customAddIntro': 'OpenAI 兼容或 Anthropic 兼容端点:本地 Ollama / vLLM / 第三方聚合。',
  'providers.customName': '名称 · 必填',
  'providers.customDesc': '描述',
  'providers.customCompat': '兼容形 · 必填',
  'providers.customCompatOpenai': 'OpenAI 兼容',
  'providers.customCompatAnthropic': 'Anthropic 兼容',
  'providers.customBaseUrl': 'Base URL · 必填',
  'providers.customBaseUrlHint': '端点地址,不带 /chat/completions',
  'providers.customKey': 'API 密钥 · 可空',
  'providers.customModel': '默认模型',
  'providers.customModelHint': '端点常常不报目录,也不报能力。拉不到就手填 ID,能力项留空 —— 不猜、不预填。',
  'providers.customSubmit': '添加',
  'providers.customSave': '保存',
  'providers.customDelete': '删除这一家…',
  /* 后果说全:模型勾选 + 这个空间里它那把钥匙。会话不动 —— 老会话还绑着它的话,
     发消息时会诚实地失败(与「配错家的模型选得中、发消息才失败」同一条口径)。 */
  'providers.customDeleteConfirm': '真删 —— 模型勾选与这个空间里它的密钥一起没',
  'providers.customDeleteMenu': '删除这一家…',
  'providers.rowMenu': '{name} 的动作',
  'providers.rowEnable': '启用这一家',
  'providers.rowDisable': '停用这一家',
  'providers.customDeleteKeyLeft': '这一家删掉了,但它的密钥没清干净',
  'providers.builtinNoDelete': '内置的这一家删不掉 —— 用上面的开关停用它',
  'providers.customNameRequired': '名称必填',
  'providers.customBaseUrlRequired': 'Base URL 必填',

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
  /* 长目录滚过一屏之后出现的回顶钮(08-31:1000 型的后果)。 */
  'providers.catalogToTop': '回到顶部',
  /* 手填模型 ID:目录没有的型也能用。「手填」= 在 selectedModels 里、目录里没有,
   * 与 Vue 壳 model-list-entry.ts:18 的 isCustom 同一个判据。 */
  'providers.addModel': '＋ 手填 ID',
  'providers.addModelPlaceholder': '模型 ID,例如 qwen3-max',
  'providers.addModelLabel': '手填模型 ID',
  'providers.addModelSubmit': '添加',
  'providers.addModelDuplicate': '{model} 已经在这一坑的列表里了',
  'providers.manualModel': '手填',
  'providers.removeModel': '删除 {model}',
  /* 手填模型改 id(09-11 报障「手写的不能改模型 id」)。入口在覆盖浮层的头部:
   * 手填行的 id 那一行旁一颗笔,点下去换成一条行内输入条。目录里有的行不给改
   * —— 它的 id 是目录说的。重复那一句复用上面的 addModelDuplicate(同一件事)。 */
  'providers.renameModel': '改模型 ID',
  'providers.renameModelSave': '保存',
  'providers.renameModelEmpty': '模型 ID 不能为空',
  /* 厂牌折叠(OpenRouter 300+ 型):已选置顶 + 按 id 前缀分组 + 检索截断。 */
  'providers.groupPicked': '已选 · {count}(始终置顶)',
  'providers.groupOther': '其他',
  'providers.groupCount': '{count} 型',
  'providers.groupVendors': '{count} 个厂牌',
  'providers.catalogTruncated': '还有 {count} 型没画出来 —— 把检索词收窄一点。',
  'providers.colModel': '模型',
  'providers.colCaps': '能力',
  'providers.colCtx': '上下文',
  'providers.colOut': '最大输出',
  'providers.colPrice': '单价 入/出',
  'providers.priceIncluded': '订阅内',
  /* 「不知道」的那一格画这个,不画 0、不画「免费」。 */
  'providers.unknownValue': '—',
  'providers.current': '当前模型',
  'providers.setCurrent': '设为当前',
  'providers.pickModel': '勾选 {model}',
  /* 能力:**全名**。从前这几格是「视 工 推 出 音」几个单字缩写,08-31 报障
   * 「谁都读不懂」—— 屏幕上改画图标,这几句成了图标的名字(悬停提示 +
   * aria-label 同一句,两路同源)。缩写连同它的图例句一起退役。
   * 09-10 加了第六格「文件输入」:它在引擎那侧是独立一格(收不收得下 PDF /
   * 附件),不是「图像输入」的搭头,所以名字也各说各的。
   * 这几句 09-10 起还有第二个读者 —— 覆盖浮层「能力」那五行的行名与
   * 那六句 Tooltip 里的 `{cap}`,所以它们必须能**当句子里的一个名词短语用**。 */
  'providers.capVision': '图像输入',
  'providers.capTools': '工具调用',
  'providers.capReasoning': '推理',
  'providers.capImageOut': '图像输出',
  'providers.capFileIn': '文件输入',
  'providers.capAudioIn': '音频输入',

  /* ── 逐型覆盖(09-09,设计正本 docs/model-override-proposal-2026-09-09.html)──
   * 后端早有这两格(contextLengthByModel / modelCapabilitiesByModel[m].tools),
   * 这一族是壳上那张嘴。**提示行与悬停一律整句成键,不拿翻译过的词去拼**:
   * 「目录:支持」在英文里是另一套语序与括号,拼装等于换一门语言就赌一次。 */
  'providers.configureModel': '配置 {model}',
  'providers.overrideContextLabel': '上下文窗口',
  'providers.overrideContextUnit': 'token',
  'providers.overrideContextPlaceholderCatalog': '{n}(目录)',
  'providers.overrideContextPlaceholderDefault': '{n}(默认)',
  'providers.overrideContextHintCatalog': '目录给的是 {n}。',
  'providers.overrideContextHintDefault': '目录没填这一型;不填按 {n} 算,压缩阈值也按它算。',
  'providers.overrideContextHintCustom': '自定 {value}。清空回到目录 {fallback}。',
  'providers.overrideContextHintCustomDefault': '自定 {value}。清空回到默认 {fallback}。',
  /* 例子就写在句子里 —— 「格式不对」这种话谁都改不对自己那一行。 */
  'providers.overrideContextInvalid': '填正数,可带 K / M:200000、200K、1M',
  /* 最大输出。这一格的话与上一格不同,因为引擎的读法不同:目录有上限时它发的是
   * **那个上限的一半**(`resolveAgentLoopContextBudgetValues` 的 halfDefault),
   * 填了覆盖就直接当 max_tokens。那个「一半」必须说出来 —— 不说,「目录 16,384」
   * 会被读成「一次能吐 16,384」。
   * **目录没填这一型时只有一句**(09-09 裁定):**不带上限**,由服务商用它自己的
   * 默认值。从前这里说「兜底 4,096 的一半」,而那个 4096 是引擎编的:它同日连同
   * 产地一起删了;同日全局 `chat.maxTokens` 也整格退役(两个设置管一个值,只留
   * 按模型这一格),所以这一档从两句收回一句 —— 壳上再没有第二个数可说。
   * 这一族的数一律写全位不进位:四五位的数,8,192 与 8.2k 差的是真 token。 */
  'providers.overrideOutputLabel': '最大输出',
  'providers.overrideOutputPlaceholderCatalog': '{n}(目录 {catalog} 的一半)',
  'providers.overrideOutputPlaceholderNoCatalog': '由服务商决定',
  'providers.overrideOutputHintCatalog': '目录上限 {n};不填按它的一半发。',
  'providers.overrideOutputHintNoCatalog':
    '目录没填这一型;不填就不带上限,由服务商用它自己的默认值。',
  'providers.overrideOutputHintCustom': '自定 {value};不再对半砍,只受模型上限夹。',
  /* 能力五行(09-10。从前这里只有「工具调用」一格,连同它那五句随状态换的
   * 提示语一起退役:五格照抄就是二十五句,而那五句真正在说的「目录说了什么」
   * 现在由每一行右边的三态小字说,「关了会怎样」对五项是同一句 → 归组上的 hint)。
   * 第一格叫「跟目录」而不是「默认」:目录没填时它跟的是引擎按名字猜的那张
   * 规则表(`runtime/src/providers/model-capability.ts`),而「跟目录」这三个字
   * 至少没有把「有个数在」这件事说死。 */
  'providers.overrideCapsLabel': '能力',
  'providers.overrideCapsHint': '关 = 这一型的请求不再带这项能力;开 = 目录说不支持也照发。',
  'providers.overrideCapInherit': '跟目录',
  'providers.overrideCapOn': '开',
  'providers.overrideCapOff': '关',
  /* 目录事实三态。**整句成键**:它是行尾那一小格的全部文字,不是「目录:」加一个词。 */
  'providers.overrideCatalogYes': '目录:支持',
  'providers.overrideCatalogNo': '目录:不支持',
  'providers.overrideCatalogUnset': '目录:没填',
  'providers.overrideFoot': '改了就存,没有保存钮',
  'providers.overrideReset': '恢复目录值',
  'providers.overrideContext': '自定 {value}(目录 {catalog})',
  'providers.overrideContextNoCatalog': '自定 {value}(目录没填,默认 {fallback})',
  'providers.overrideOutput': '自定 {value}(目录 {catalog})',
  'providers.overrideOutputNoCatalog': '自定 {value}(目录没填,不填则由服务商决定)',
  /* 行上那一枚被人说过话的能力图标,它的名字(= aria-label = Tooltip)。
   * 六句整话,只有能力名走 `{cap}` —— 括号里那半句在英文里是另一套语序,
   * 拿翻译过的词去拼等于换一门语言就赌一次;而能力名在两门语言里都只是
   * 句中的一个名词短语,它是这六句里唯一能安全变的那一格。 */
  'providers.overrideCapOnTipCatalogOn': '自定:支持{cap}(目录:支持)',
  'providers.overrideCapOnTipCatalogOff': '自定:支持{cap}(目录:不支持)',
  'providers.overrideCapOnTipUnknown': '自定:支持{cap}(目录没填)',
  'providers.overrideCapOffTipCatalogOn': '自定:关闭{cap}(目录:支持)',
  'providers.overrideCapOffTipCatalogOff': '自定:关闭{cap}(目录:不支持)',
  'providers.overrideCapOffTipUnknown': '自定:关闭{cap}(目录没填)',
  'providers.saveFailed': '设置没保存上',

  /* ── 工作区切换器(08-31 v1) ─────────────────────────────────────────────
   * 面板标题不另起一个键:它就是 'item.workspace' 那三个字(与文件面复用
   * 'item.files' 同一条判例)。
   *
   * **工作区的名字不在这里** —— 那是用户自己起的名,是数据不是文案
   * (判据见本文件顶部:换一门语言它该不该跟着变?)。唯一的例外是
   * 'workspace.defaultName':它只在**读不到列表**时顶一下那条兜底记录,
   * 连得上的时候名字是后端给的真数据,根本不经过这一句。
   * ────────────────────────────────────────────────────────────────────── */
  'workspace.defaultName': '默认',
  'workspace.current': '当前',
  'workspace.overviewEntry': '工作区总览…',
  'workspace.create': '新建工作区',
  'workspace.createNamed': '新建「{name}」工作区…',
  'workspace.createLabel': '新工作区的名字',
  'workspace.createFailed': '工作区没建成',
  /* 建完播报一句:总览留在原地、新卡就位,读屏用户也该知道发生了什么(09-01 报障 ②)。 */
  'workspace.createdAnnounce': '已建好「{name}」并切了过去',
  'workspace.rename': '改名',
  'workspace.renameLabel': '工作区名字',
  'workspace.renameFailed': '名字没改上',
  'workspace.recolor': '换色',
  'workspace.recolorLabel': '挑一个色',
  'workspace.recolorFailed': '颜色没换上',
  'workspace.remove': '删除…',
  'workspace.removeTitle': '删除「{name}」?',
  'workspace.removeConsequence': '这个工作区自己那份设置与凭证会一起删掉。里面还有会话的话删不掉 —— 先把会话清空。',
  'workspace.removeNext': '继续',
  'workspace.removeConfirmTitle': '真的删掉「{name}」?',
  'workspace.removeFinal': '删除',
  'workspace.removeDefault': '默认工作区删不掉',
  'workspace.removeNotEmpty': '这个工作区里还有会话',
  'workspace.removeMissing': '这个工作区已经不在了',
  'workspace.removeFailed': '没删掉',
  'workspace.loadFailed': '工作区列表读不到',
  'workspace.factDefault': '默认工作区',
  'workspace.factCreated': '自建工作区',
  /* 切换换的是什么。09-01「真切换」批之后这句话从留账变成了说明,机制见
     workspace/store.ts 文件头(A 屏幕、B 引擎,接缝是建会话时写下的归属)。 */
  'workspace.scopeNote': '每个工作区各有一套会话、模型服务与凭证。切换只影响这台窗口,别的窗口照旧停在它自己那个。',
  'workspace.paletteLabel': '切换工作区',
  'workspace.paletteSearch': '找一个工作区…',
  'workspace.paletteHint': '切换工作区',
  'workspace.paletteNoHit': '没有匹配的工作区',
  'workspace.footMove': '↑↓ 选择',
  'workspace.footSwitch': '↵ 切换',
  'workspace.footClose': 'esc 关闭',
  /* 序号直达三条在设置页里的名字。KeymapCommand.labelKey 不带插值,所以三条各一句。 */
  'workspace.slot1': '切到第 1 个工作区',
  'workspace.slot2': '切到第 2 个工作区',
  'workspace.slot3': '切到第 3 个工作区',
  /* 六格色的名字。它们是**控件的无障碍名**(读屏软件念的那句),所以进字典;
   * 色值本身在 styles/palette.css,这里一个 # 都没有。 */
  'workspace.color.violet': '紫',
  'workspace.color.blue': '蓝',
  'workspace.color.green': '绿',
  'workspace.color.amber': '琥珀',
  'workspace.color.rose': '玫瑰',
  'workspace.color.teal': '青',

  /* ── 音乐面(音乐收尾 · 壳半边,2026-09-10)─────────────────────────────
   * 面里每一颗按钮走的都是 `resources.do`(与模型调的同一条),所以这里的话
   * 说的都是**做法自己的名字**,与自述 `runtime/src/music/resource-spec.ts` 上
   * 那十三条一一对得上。歌名 / 简报正文 / 后端原话是**事实**不是界面文案,
   * 不进字典 —— 它们由数据带过来,插在 {title} / {message} 那一格上。 */
  'music.player': '正在放',
  'music.radio': '电台',
  'music.lyrics': '歌词',
  'music.prev': '上一首',
  'music.pause': '暂停',
  'music.resume': '播放',
  'music.next': '下一首',
  'music.like': '红心',
  'music.seekLabel': '播放进度',
  'music.volumeLabel': '音量',
  'music.untitled': '未知曲目',
  'music.playerIdle': '播放器没在跑。',
  'music.radioOff': '电台没开 —— 说一句想听什么就能开台。',
  'music.intentPlaceholder': '想听点什么(例:下雨天,安静的中文民谣)',
  'music.open': '开台',
  'music.retune': '换台',
  'music.close': '关台',
  'music.radioResume': '续播',
  'music.radioStop': '停止',
  'music.requestPlaceholder': '点一首歌(歌名 歌手)',
  'music.request': '点歌',
  'music.programme': '节目单',
  'music.programmeEmpty': '节目单空着。',
  'music.onDeck': '台上:{title}',
  'music.upNext': '下一首:{title}',
  'music.starting': '换歌中:{title}',
  'music.programmeMore': '还有 {count} 首没列出来',
  'music.lyricsEmpty': '这首没有歌词。',
  'music.backendNotReady': '音乐后端还没配好 —— 装好那只 CLI 并登录之后才放得出声。',
  'music.backendError': '音乐后端报了一句:{message}',

  /* 终端(T1,方案 `apps/desktop-react/docs/terminal-browser-2026-09.md` §2.1)。
   * 瓦名复用 `item.terminal`(i18n 纪律:同一句话只有一个键)。 */
  'terminal.attaching': '正在接上…',
  'terminal.detached': '已断开。',
  'terminal.reconnect': '重新连接',
  'terminal.exited': '进程已退出({code})',
  'terminal.dead': '已结束。',
  'terminal.openAnother': '再开一个',
  'terminal.new': '新建终端',
  'terminal.newInDir': '在目录…新建',
  'terminal.aliveSection': '开着的终端',
  /* 键盘礼让那五行共用的一句(判词在 `content/terminal/key-courtesy.ts`)。 */
  'terminal.keyToPty': '交给终端',
  /* 终端内查找(T2)。`terminal.find` 同时是 ⌘F 那条局部键在设置页键位表上的名字
   * ——**不复用** `viewer.findLabel`(那一句写死了「文件」,这里找的是一块屏幕)。 */
  'terminal.find': '在这块屏幕里查找',
  'terminal.findPlaceholder': '查找',
  'terminal.findPrev': '上一处',
  'terminal.findNext': '下一处',
  'terminal.findClose': '收起查找',

  /* ── 快捷键表合一(K0,2026-09-12)──────────────────────────────────────
   * 从前每块面自报键位,「查找」在查看器 / 终端 / 浏览器各是一行;K0 起它们答
   * 的是**同一条命令**,所以命令自己要有一句**通名** —— 三块面各自的说法
   * (`viewer.findLabel` / `terminal.find` / `browser.find`)一句没少,挂在
   * `FOCUS_SCOPES[*].answers` 上。 */
  'keymap.find': '查找',
  'keymap.sectionApp': '全局',
  'keymap.sectionScoped': '跟随焦点',
  'keymap.scopedNote2': '这些键只在对应的那块面在活动路径上时才响;没人答就放行,不再兜底成别的事',
  'keymap.answerer': '{scope}·{action}',
  'keymap.sharedChord': '与「{name}」共用这个键(不同时在场)',
  'keymap.conflictApp': '与「{name}」冲突:同一个键上只能有一条全局命令',
  'keymap.conflictOverlap': '与「{name}」冲突:在「{scope}」里两者都可能答',

  /* ── 标签族(K2,方案 docs/keymap-responder-2026-09.md §3 / §5 K2)──────── */
  'keymap.tabNew': '新标签(同类再开一格)',
  'keymap.contentNew': '新建这一种内容',
  'keymap.tabReopen': '重开刚关掉的标签',
  'keymap.tabNext': '下一个标签',
  'keymap.tabPrev': '上一个标签',
  'keymap.tabSelect1': '切到第 1 格标签',
  'keymap.tabSelect2': '切到第 2 格标签',
  'keymap.tabSelect3': '切到第 3 格标签',
  'keymap.tabSelect4': '切到第 4 格标签',
  'keymap.tabSelect5': '切到第 5 格标签',
  'keymap.tabSelect6': '切到第 6 格标签',
  'keymap.tabSelect7': '切到第 7 格标签',
  'keymap.tabSelect8': '切到第 8 格标签',
  'keymap.tabSelect9': '切到最后一格标签',
  /** 会话总览 / composer 对「新建这一种内容」的说法(它们是「焦点在会话里」的两种形)。 */
  'keymap.contentNewSession': '新建会话',

  /* ── 内容族(K3,方案 docs/keymap-responder-2026-09.md §3 / §5 K3)────────
   * 这六条是**命令自己那一句通名**;每块面自己的说法挂在 `answers` 上
   * (浏览器的后退 / 前进 / 刷新复用地址栏那三颗钮的名字,不另起键)。 */
  'keymap.navBack': '后退',
  'keymap.navForward': '前进',
  'keymap.viewReload': '重载这块内容',
  'keymap.zoomIn': '放大',
  'keymap.zoomOut': '缩小',
  'keymap.zoomReset': '实际大小',

} as const
