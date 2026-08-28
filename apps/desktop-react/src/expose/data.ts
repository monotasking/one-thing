import type { GroupMock, ProjectMock, SessionMock } from './types'

/**
 * L2 是静态 mock 表。之后接真实数据时,只有这张表换来源,
 * 状态机 / 组件一行不改 —— 和 stage/items.ts 同一个理由。
 */
export const PROJECTS: ProjectMock[] = [
  { id: 'onething', name: 'onething', path: '~/data/code/start-electron', active: true },
  { id: 'transreader', name: 'TransReader', path: '~/data/code/transreader', active: true },
  { id: 'deepseek-harness', name: 'deepseek-harness', path: '~/data/code/deepseek-harness', active: false },
  { id: 'personal-site', name: 'personal-site', path: '~/data/code/personal-site', active: false },
  { id: 'memory-wiki', name: 'memory-wiki', path: '~/data/note/memory-wiki', active: false },
  { id: 'onething-site', name: 'onething-site', path: '~/data/code/onething-site', active: false },
]

export const SESSIONS: SessionMock[] = [
  {
    id: 'os-provider',
    title: '重构 provider 抽象',
    kind: 'chat',
    projectId: 'onething',
    summary:
      '三处读取点已经改成调用同一个纯函数:请求装配、能力徽标、生图路由。目录缓存那条也顺手对齐,不再按时间过期。',
    segments: [
      { title: '摸清三处读取点', detail: '请求装配读 capabilities.output,徽标读 modalities,生图路由读第三个字段。' },
      { title: '抽成一个判定函数', detail: 'onethingModelSupportsImageGeneration 只留一个实现,三处都改成调它。' },
      { title: '目录缓存跟着目录键走', detail: '缓存键从时间戳换成目录键,换目录立刻失效,不再等过期。' },
    ],
    userTurns: [
      '把 provider 的能力判定收敛到一处,别再一边读请求侧一边读能力侧。',
      '先别改代码,先告诉我三处读取点分别读的是哪个字段。',
      '那这个不一致是从什么时候开始的?',
      '好,抽成纯函数。名字用 onethingModelSupportsImageGeneration。',
      '徽标那处也要改,不然还是两套事实。',
      '目录缓存按时间过期这个是另一个 bug 吧?顺手一起修。',
      '跑一下 typecheck。',
      '测试补上,至少覆盖「请求侧说支持、能力侧说不支持」这一条。',
    ],
    time: '14:22',
    badges: { diff: 2, testOk: true },
  },
  {
    id: 'os-compact',
    title: '上下文压缩早触发排查',
    kind: 'chat',
    projectId: 'onething',
    summary:
      '根因不是 goal:预留 maxOutput/2 把 hard-limit 线塌到了 248k,而估算器本身还高 1.3 到 1.7 倍。修法待拍板。',
    segments: [
      { title: '复现', detail: 'grok 的 output=context=500k,预留一半直接把可用窗口砍到 248k。' },
      { title: '排除 goal', detail: '关掉 goal 一样触发,和 goal 无关。' },
      { title: '估算器偏高', detail: '同一段历史,估算 31k、实际 19k,系数在 1.3 到 1.7 之间浮动。' },
    ],
    userTurns: [
      '为什么开了 goal 之后压缩会提前触发?',
      '你确定是 goal 引起的吗?关掉再试一次。',
      '那 hard limit 是怎么算出来的?把公式写给我看。',
      'maxOutput/2 这个预留是谁定的?',
      '估算器偏高多少?给个区间。',
      '先别动,这个改法我要看到几个选项再拍。',
      '把复现步骤记下来,别只留在对话里。',
    ],
    time: '昨天',
    badges: { diff: 1 },
  },
  {
    id: 'os-expose',
    title: '会话总览 Exposé 设计',
    kind: 'chat',
    projectId: 'onething',
    summary:
      '总览分三层:分组网格 → 列表 → Quick Look。Esc 逐层退,方向键在展开组拼出的卡序列上走,折叠状态持久化。',
    segments: [
      { title: '形态机先行', detail: 'ExposeView 四态,纯函数迁移,组件只读投影。' },
      { title: '焦点序列', detail: '序列 = 展开组的卡顺序拼接,折叠一个组序列立刻变短。' },
      { title: 'Quick Look', detail: '左右换会话但面板不关,内容做一次 120ms 淡切。' },
    ],
    userTurns: [
      '会话总览要做成 Exposé 那样,一屏看全。',
      '分组按项目分,不活跃的项目默认折叠。',
      'Esc 要逐层退,不要一下子全关。',
      'Space 是 Quick Look,Enter 才是真进入。',
      'Quick Look 里左右键换会话,面板别关。',
      '搜索要能搜到消息级别,不只是标题。',
      '折叠状态要记住,重开还是折叠的。',
      '卡片 hover 只加影子,不要位移。',
    ],
    time: '周一',
    badges: { testOk: true },
  },
  {
    id: 'tr-menubar',
    title: '菜单栏翻译窗口丢焦点',
    kind: 'chat',
    projectId: 'transreader',
    summary:
      'NSPanel 换成 nonactivatingPanel 之后输入框拿不到第一响应者,得在 showWindow 之后显式 makeFirstResponder。',
    segments: [
      { title: '现象', detail: '点菜单栏图标弹出面板,光标不在输入框里,得再点一下。' },
      { title: '定位', detail: 'nonactivatingPanel 不抢 key window,第一响应者留在原 app。' },
      { title: '修法', detail: 'orderFront 之后 makeKeyAndOrderFront + makeFirstResponder(输入框)。' },
    ],
    userTurns: [
      '菜单栏弹出来之后要再点一下才能打字,这个能修吗?',
      '是不是 NSPanel 的问题?',
      '那为什么以前是好的?',
      '改完不能影响「点外面自动收起」这个行为。',
      '在 Flask 那端有没有类似的坑?',
      '验证一下:连开五次,每次都要能直接打字。',
    ],
    time: '周二',
  },
  {
    id: 'rm-release',
    title: '发布计划评审室',
    kind: 'room',
    projectId: null,
    summary:
      '三个人在过 0.9 的回归清单。卡在「插件写面在独立 server 上一律拒」这条要不要写进发布说明。',
    segments: [
      { title: '回归清单', detail: '11 条,已过 7 条,剩下的都是插件相关。' },
      { title: '争议点', detail: '独立 server 拒写面,是「已知限制」还是「缺陷」。' },
      { title: '下一步', detail: '记录员整理成一页,明天早上定稿。' },
    ],
    userTurns: [
      '先把回归清单过一遍,一条一条来。',
      '插件写面那条谁负责?',
      '独立 server 上拒绝写面,这算限制还是 bug?',
      '写进发布说明就得有替代路径,有吗?',
      '那就先记成已知限制,下个版本再说。',
      '记录员把结论整理成一页。',
      '明天早上十点定稿。',
    ],
    time: '刚刚',
    members: ['影', '卡', '记'],
    live: '影 正在发言:先把回归清单剩下那四条过完',
  },
  {
    id: 'dm-ying',
    title: '影',
    kind: 'dm',
    projectId: null,
    summary: '影发来三条:压缩阈值那条她跑出来的数和我不一样,想约个时间对一下口径。',
    segments: [
      { title: '数对不上', detail: '她跑出来 1.9 倍,我这边 1.3 到 1.7。' },
      { title: '怀疑样本', detail: '她的样本里带了工具结果,占了请求的八成。' },
      { title: '约时间', detail: '明天下午两点对口径。' },
    ],
    userTurns: [
      '你那边估算器偏多少?',
      '样本里带工具结果了吗?',
      '那不能直接比,工具结果占八成的话分布完全不一样。',
      '你把样本发我,我这边跑一遍。',
      '明天下午两点?',
      '好,到时候把两边的脚本也对一下。',
    ],
    time: '10:05',
    unread: 3,
    members: ['影'],
  },
  {
    id: 'lo-notes',
    title: '整理这周的排查笔记',
    kind: 'chat',
    projectId: null,
    summary: '把四条排查记录归到 notebook 的对应章节,重复的两条合并,顺手补了复现步骤。',
    segments: [
      { title: '收集', detail: '四条散在不同会话里,先抄出来。' },
      { title: '合并', detail: '「焦点丢失」和「第一响应者」其实是同一条。' },
      { title: '补复现', detail: '每条都补上最短复现步骤,不然三个月后自己也看不懂。' },
    ],
    userTurns: [
      '把这周的排查记录整理一下。',
      '有重复的吗?',
      '那两条合并,标题用后面那个。',
      '每条都要有最短复现步骤。',
      '归到 notebook 的哪一章?',
      '52.03 那节下面新开一小节。',
    ],
    time: '上周',
  },
  {
    id: 'dh-events',
    title: '事件日志读法调研',
    kind: 'chat',
    projectId: 'deepseek-harness',
    summary: '它的做法是事件日志唯一事实、一切皆投影、不存 duration。时间戳全留,时长现算。',
    segments: [
      { title: '唯一事实', detail: '消息表是投影,事件日志才是源。' },
      { title: '不存时长', detail: '只存时间戳,duration 每次从两个戳现算。' },
      { title: '可借鉴的', detail: '投影函数集中一处,扩展它而不是加局部豁免。' },
    ],
    userTurns: [
      '它的事件日志是怎么读的?',
      '时长是存的还是算的?',
      '为什么不存?存下来不是更快吗?',
      '投影函数有几个?',
      '我们这边能照搬吗?',
      '写成一页对照,放 docs/audit。',
    ],
    time: '8月12日',
  },
  {
    id: 'ps-deploy',
    title: '部署脚本收敛',
    kind: 'chat',
    projectId: 'personal-site',
    summary: '三个部署脚本合成一个,环境差异走参数不走分叉文件。回滚从手工改成一条命令。',
    segments: [
      { title: '三份脚本', detail: 'dev / staging / prod 各一份,改一处要改三处。' },
      { title: '合并', detail: '差异只有四个变量,提成参数。' },
      { title: '回滚', detail: '保留上一版符号链接,回滚就是换链接。' },
    ],
    userTurns: [
      '这三个部署脚本能合吗?',
      '差异有哪些?',
      '只有四个变量?那直接提成参数。',
      '回滚现在是怎么做的?',
      '手工改太危险了,做成一条命令。',
      '试一次回滚,确认真的能回去。',
    ],
    time: '8月6日',
  },
  {
    id: 'mw-cls',
    title: 'CLS 两层写者设计',
    kind: 'chat',
    projectId: 'memory-wiki',
    summary: '两层结构 + 单一写者:上层负责归类,下层负责落盘,写入口只有一个,避免两份内存事实。',
    segments: [
      { title: '两层', detail: '归类层不碰文件,落盘层不做判断。' },
      { title: '单一写者', detail: '任何写都经同一个函数,别处只读。' },
      { title: '归因', detail: '走 toolCallModel,不另开一条链路。' },
    ],
    userTurns: [
      '这个两层是怎么分的?',
      '写入口有几个?',
      '只有一个的话并发怎么办?',
      '归因走哪条链路?',
      '外部根这条先不做,记下来。',
      '网关 v1 不进,确认一下。',
    ],
    time: '7月29日',
  },
  {
    id: 'st-landing',
    title: '官网首屏改版',
    kind: 'chat',
    projectId: 'onething-site',
    summary: '首屏从三栏改成一句话 + 一张图。下载按钮上移,GitHub releases 那批 Draft 得先转正式。',
    segments: [
      { title: '首屏', detail: '三栏信息量大但没人读,换成一句话加一张图。' },
      { title: '下载', detail: '按钮从页脚上移到首屏,直接给 mac 包。' },
      { title: 'Releases', detail: '现有的全是 Draft,链接点过去 404。' },
    ],
    userTurns: [
      '首屏三栏太满了,砍成一句话。',
      '图用哪张?',
      '下载按钮放首屏。',
      '点下载会 404,是不是 releases 有问题?',
      '全是 Draft?那得先转正式。',
      '转之前先确认包能装。',
    ],
    time: '7月18日',
  },
]

/** 当前会话 = TopBar 一开始显示的那个。 */
export const CURRENT_SESSION_ID = 'os-provider'

function projectGroup(p: ProjectMock): GroupMock {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    projectId: p.id,
    sessions: SESSIONS.filter((s) => s.projectId === p.id),
    defaultCollapsed: !p.active,
  }
}

/**
 * 组的顺序 = 总览的阅读顺序,也是方向键序列的拼接顺序。
 * 活跃项目在前,协作/独立居中,不活跃项目垫底(且默认折叠)。
 */
export const GROUPS: GroupMock[] = [
  ...PROJECTS.filter((p) => p.active).map(projectGroup),
  // 这两个是合成组,不对应任何项目,所以组名是界面文案(走字典)而不是数据。
  {
    id: 'collab',
    nameKey: 'expose.groupCollab',
    path: 'room · dm',
    projectId: null,
    sessions: SESSIONS.filter((s) => s.kind !== 'chat'),
    defaultCollapsed: false,
  },
  {
    id: 'loose',
    nameKey: 'expose.groupLoose',
    pathKey: 'expose.groupLoosePath',
    projectId: null,
    sessions: SESSIONS.filter((s) => s.kind === 'chat' && s.projectId === null),
    defaultCollapsed: false,
  },
  ...PROJECTS.filter((p) => !p.active).map(projectGroup),
]

export const DEFAULT_COLLAPSED_GROUP_IDS: string[] = GROUPS.filter((g) => g.defaultCollapsed).map((g) => g.id)

export function findSession(id: string | null): SessionMock | undefined {
  if (!id) return undefined
  return SESSIONS.find((s) => s.id === id)
}

export function findGroup(id: string): GroupMock | undefined {
  return GROUPS.find((g) => g.id === id)
}

/**
 * list 视图的取数:**按组**,不按项目。
 * 组自己就带着 sessions(GROUPS 是唯一那份分组事实),所以这里不重新 filter 一遍 ——
 * 重新 filter 就是第二份分组规则,协作组和独立组当年正是这样被合成一坨的。
 */
export function sessionsOfGroup(groupId: string): SessionMock[] {
  return findGroup(groupId)?.sessions ?? []
}

/**
 * 消息时间是占位:mock 里 userTurns 只有文本,时间按序号推。
 * 放在数据层是因为它属于「这批 mock 的事实」,不属于渲染。
 */
export function turnTimeAt(index: number): string {
  const minutes = 9 * 60 + 12 + index * 17
  const hh = String(Math.floor(minutes / 60) % 24).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return `${hh}:${mm}`
}
