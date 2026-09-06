import type { SearchCapabilityManifestDto, SearchFilters } from '@shared/ipc/search'
import type { MessageKey } from '../i18n'

/**
 * 过滤片 —— **结构传 `filters`,不拼进查询串**(设计
 * `docs/design/search-index-2026-09.md` §9 第五条 / §4.0 那张枚举点清账表
 * 「过滤片 → 能力声明 `facets`;壳从注册表读出可用的过滤片」)。
 *
 * 与 `transitions.ts` / `capabilities.ts` 同一体例:纯函数,不认识 React、不认识
 * DOM。面板只负责画那几颗片,「这一片此刻可不可用」「按下去变成什么结构」全在这里。
 *
 * ── 壳仍然知道「有哪五颗片」,这不是枚举点 ────────────────────────────────
 * §9 把片逐条点了名(空间 / 角色 / 时间 / 含归档 / 含推理),所以壳这一侧确实有
 * 一张五行的表。开闭原则落在**另一格**上:一颗片**画不画**由「有没有能力声明了
 * 它对应的那个 facet 键」决定,不由壳自己拍。于是——
 *
 *  · 加一种能搜的东西,它声明了 `role`,角色片自动在它那一档出现;
 *  · 一个能力不声明 `spaceId`,选中它那一档时空间片自动消失;
 *  · 表里这五行**没有一个能力 id**(闸 `no-capability-literals` 因此仍然绿):
 *    它们说的是 facet 键,而 facet 键是**开放词表**,不是能力的名字。
 *
 * 真要加第六颗片(将来某个能力声明了 `language` 之类),那是这张表加一行 + 两条
 * 文案 —— 与 §4.0 允许动的那两处同一个量级,不必碰面板一个字。
 *
 * ── 缺省一格不发,是刻意的(行为零变化)───────────────────────────────────
 * S4a 之前壳一条 `filters` 都没发过。这一批把缺省钉成「等价于不发」:
 *
 *  | 片 | 缺省 | 缺省时发什么 |
 *  | --- | --- | --- |
 *  | 空间 | 当前 | `spaceId`(见下面那条「空 = 默认空间」的判据) |
 *  | 角色 | 不挑 | 不发 |
 *  | 时间 | 不挑 | 不发 |
 *  | 含归档 | 含 | 不发(S3b 起归档会话的消息**搜得到**,那是既有行为) |
 *  | 含推理 | 含 | 不发(消息文档本来就带 `reasoning` 字段) |
 *
 * 空间那一格是唯一发得出东西的缺省,而它换来的正是**旧行为**:S4b 之前会话侧那
 * 三路是壳本地滤的,滤的产地是**当前空间那张会话表** —— 别的空间的行从来就没上
 * 过屏。改读后端之后不带这一格才是行为变化。
 */

/* ── 五颗片的取值 ──────────────────────────────────────────────────────── */

export type SpaceFilter = 'current' | 'all'
export type RoleFilter = 'any' | 'user' | 'assistant'
export type TimeFilter = 'any' | 'today' | 'week' | 'month' | 'custom'

/**
 * **范围片**(§4.6 结论 1)——「在此会话内搜」/「在此目录内搜」那一颗。
 *
 * 它**就是 `filters` 的可视化**,不是第二种状态:一个 facet 键 + 一个值,与用户
 * 手打一条过滤条件是同一格数据。片上写什么(`label`)由产它的那个目标渲染器给,
 * 因为只有那一类知道「这个 sessionId 叫什么名字」。
 */
export interface SearchScopeChip {
  /** 落到哪个 facet 键上(`sessionId` / `dir` / …)。由目标渲染器说。 */
  key: string
  /** 那一格的值。 */
  value: string
  /** 片上那句话(成品文案:会话名 / 目录名);壳不翻译。 */
  label: string
}

export interface SearchFilterState {
  space: SpaceFilter
  role: RoleFilter
  time: TimeFilter
  /** 自定时间段(`time === 'custom'` 才读):毫秒时刻,两头都可缺。 */
  customFrom?: number
  customTo?: number
  /** 含归档。`true` = 含(缺省),`false` = 只看没归档的。 */
  archived: boolean
  /** 含推理。`true` = 含(缺省)。 */
  reasoning: boolean
  /** 范围片(续搜);缺席 = 没有限定范围。 */
  scope?: SearchScopeChip
}

export const INITIAL_FILTERS: SearchFilterState = {
  space: 'current',
  role: 'any',
  time: 'any',
  archived: true,
  reasoning: true,
}

/** 这一份是不是「什么都没挑」(除了范围片之外)。底下那颗「清空」按不按得动读它。 */
export function filtersAreDefault(state: SearchFilterState): boolean {
  return state.space === INITIAL_FILTERS.space
    && state.role === INITIAL_FILTERS.role
    && state.time === INITIAL_FILTERS.time
    && state.archived === INITIAL_FILTERS.archived
    && state.reasoning === INITIAL_FILTERS.reasoning
    && state.scope === undefined
}

/* ── 哪几颗片此刻可用 ──────────────────────────────────────────────────── */

/** 五颗片各自认哪个 facet 键。**这张表里没有一个能力 id**(见文件头)。 */
export const SPACE_FACET = 'spaceId'
export const ROLE_FACET = 'role'
export const TIME_FACET = 'time'
export const ARCHIVED_FACET = 'archived'
export const REASONING_FACET = 'includeReasoning'
/**
 * **扫描根**(S4b 修)。它不是一颗画得出来的片 —— 屏幕上它有两种样子:
 * 缺省时**隐身**(当前会话的工作目录,与从前 `useSessionCwd()` 那条根逐字相同),
 * 用户点过「在此目录内搜」之后是**范围片**(`state.scope`)。
 *
 * 为什么缺省要发它,而不是「不发 = 后端自己看着办」:后端的根列表
 * (`getSearchDirs()`)认的是**后端** `getCurrentSessionId()` 的工作目录,
 * 而 React 壳从不告诉后端当前会话是谁 —— 不发这一格,会话目录下的文件就搜不到,
 * 那不是旧行为。所以 × 掉范围片是**回到缺省 cwd**,不是回到「无 dir」。
 */
export const DIR_FACET = 'dir'

/**
 * 这一档上**摆得出**哪些 facet 键。
 *
 * 单类档 = 那一个能力自述里的 `facets`;`all` 档 = 各组声明的**并集**(§9 原话
 * 「`all` 档画各组声明的并集」)—— 全部档里同时有会话与消息,而角色只有消息认,
 * 那颗片仍然该画:按下去只影响认它的那一路,不认的那一路本来就不该被一颗片挡住。
 *
 * 认不认由**能力自述**答,不由壳猜:某个能力哪天补了 `role`,它那一档的角色片
 * 自动出现,这个文件一个字不改。
 */
export function facetKeysOf(
  manifests: readonly SearchCapabilityManifestDto[],
  capability: string,
  allTab: string,
): Set<string> {
  const keys = new Set<string>()
  for (const manifest of manifests) {
    if (capability !== allTab && manifest.id !== capability) continue
    for (const facet of manifest.facets ?? []) keys.add(facet.key)
  }
  return keys
}

/* ── 状态 → 结构 ───────────────────────────────────────────────────────── */

/** 一天有多少毫秒。时间片那三档都从它算。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 「今天」的起点(本地零点)。用 `Date` 而不是自己算 —— 时区与夏令时不该在这里
 * 被重新发明一遍。
 */
function startOfToday(now: number): number {
  const at = new Date(now)
  at.setHours(0, 0, 0, 0)
  return at.getTime()
}

/**
 * 空间那一格的值。
 *
 * **空 = 默认空间**:老会话的 `workspaceId` 是空的(后端零迁移),投影器于是把
 * `spaceId` 写成 `''`;而壳这一侧 `expose/projection.ts` 的判据是
 * `(session.workspaceId || 'default') === (spaceId || 'default')` —— 两边缺省成
 * 同一个。所以「当前是默认空间」这一形要**同时收** `'default'` 与 `''`,
 * 数组(FacetFilter 的「属于」形)正好说得出这句话。
 *
 * 不这么写的后果不是一处小偏差:真店里绝大多数会话的 `workspaceId` 是空的,
 * 发一条 `spaceId: 'default'` 会把它们全滤掉 —— 屏幕上「搜不到任何东西」。
 */
export function spaceFilterValue(spaceId: string, defaultSpaceId: string): string | string[] {
  const resolved = spaceId || defaultSpaceId
  return resolved === defaultSpaceId ? [resolved, ''] : resolved
}

/** 一行命中是不是「别的空间的」。与上面那条缺省判据是同一句话的另一半。 */
export function isOtherSpace(
  facetSpaceId: unknown,
  spaceId: string,
  defaultSpaceId: string,
): boolean {
  if (typeof facetSpaceId !== 'string') return false
  return (facetSpaceId || defaultSpaceId) !== (spaceId || defaultSpaceId)
}

export interface FilterContext {
  /** 此刻这个空间。 */
  spaceId: string
  /**
   * 此刻这条活跃会话的工作目录(`useSessionCwd()`);缺席 = 壳这边也不知道,
   * 那就一格都不发,由后端自己那张根列表答(见 `DIR_FACET`)。
   */
  cwd?: string
  /** 空 workspaceId 落回哪一个(与 `expose/projection.ts` 同一个常量)。 */
  defaultSpaceId: string
  /** 现在几点(时间片那三档从它算)。注进来,不在纯函数里读时钟。 */
  now: number
  /** 这一档摆得出的 facet 键(`facetKeysOf` 的结果)。 */
  available: ReadonlySet<string>
}

/**
 * 状态 → 线上那份 `filters`。
 *
 * **一颗片只有在这一档摆得出它对应的 facet 键时才落成结构**:摆不出还硬发,
 * 等于让壳替一个不认这个键的能力回答「你该怎么过滤」——core 的
 * `matchesFacetFilters` 会拿一个 `undefined` 去比,那一路当场清零。
 *
 * 范围片同理:它的 `key` 也要在这一档摆得出。摆不出时片仍然在屏上(用户明确按下
 * 过它),但这一档不发它 —— 那正是「换到一个不认 sessionId 的档,范围片自然失效」
 * 的诚实形。面板据此把那颗片画成失效态。
 */
export function filtersOf(state: SearchFilterState, ctx: FilterContext): SearchFilters {
  const filters: SearchFilters = {}
  const has = (key: string): boolean => ctx.available.has(key)

  if (state.space === 'current' && has(SPACE_FACET)) {
    filters[SPACE_FACET] = spaceFilterValue(ctx.spaceId, ctx.defaultSpaceId)
  }
  if (state.role !== 'any' && has(ROLE_FACET)) {
    filters[ROLE_FACET] = state.role
  }
  if (has(TIME_FACET)) {
    const range = timeRangeOf(state, ctx.now)
    if (range !== undefined) filters[TIME_FACET] = range
  }
  // 「含归档」是缺省;**只有关掉它才发一格**(`archived: false` = 只要没归档的)。
  if (!state.archived && has(ARCHIVED_FACET)) {
    filters[ARCHIVED_FACET] = false
  }
  // 「含推理」同理。今天没有一个能力声明 `includeReasoning`,所以这一片画不出来,
  // 这一句也就永远不成立 —— 留着它是因为那一天到来时这里一个字都不用改。
  if (!state.reasoning && has(REASONING_FACET)) {
    filters[REASONING_FACET] = false
  }
  if (state.scope !== undefined && has(state.scope.key)) {
    filters[state.scope.key] = state.scope.value
  }
  /*
   * 扫描根的**缺省**。放在最后,判据是「范围片没有把这一格占掉」——
   * 用户明确点过「在此目录内搜」时听他的,没点过就用当前会话的工作目录。
   * (× 掉范围片 → `state.scope` 变成缺席 → 这一句接住 → 回到 cwd,
   * 而不是回到「无 dir」= 后端的根列表。)
   */
  if (filters[DIR_FACET] === undefined && has(DIR_FACET) && ctx.cwd) {
    filters[DIR_FACET] = ctx.cwd
  }
  return filters
}

/** 时间片 → 区间。`any` 与「自定但两头都没填」都是缺席(不发)。 */
function timeRangeOf(
  state: SearchFilterState,
  now: number,
): { gte?: number; lte?: number } | undefined {
  switch (state.time) {
    case 'any':
      return undefined
    case 'today':
      return { gte: startOfToday(now) }
    case 'week':
      return { gte: now - 7 * DAY_MS }
    case 'month':
      return { gte: now - 30 * DAY_MS }
    case 'custom': {
      const range: { gte?: number; lte?: number } = {}
      if (state.customFrom !== undefined) range.gte = state.customFrom
      if (state.customTo !== undefined) range.lte = state.customTo
      return range.gte === undefined && range.lte === undefined ? undefined : range
    }
  }
}

/* ── 片上的文案 ────────────────────────────────────────────────────────── */

/** 一颗片的**画法描述**(纯数据;组件按它画,不自己判)。 */
export interface FilterChipSpec {
  /** 这颗片是谁(`data-filter` 的值,门与用例按它认)。 */
  id: 'space' | 'role' | 'time' | 'archived' | 'reasoning'
  /** 它认哪个 facet 键。 */
  facet: string
  /** 片上那句话的键。 */
  labelKey: MessageKey
  /** 它此刻是不是「挑过了」(挑过的片描边加重,与缺省一眼分得开)。 */
  on: boolean
  /**
   * 有几个可选值 = 一张小菜单。**五颗片今天全是这一形**(09-05 起归档 / 推理也
   * 改成「含 / 不含」两格)—— 库件那条两态口(`onToggle`)因此这块面不再消费,
   * 但它对别的消费方仍然成立,不动。
   */
  options?: Array<{ value: string; labelKey: MessageKey }>
  /** 此刻选中的那一格(`options` 在场时)。 */
  value?: string
}

const SPACE_OPTIONS: FilterChipSpec['options'] = [
  { value: 'current', labelKey: 'search.filterSpaceCurrent' },
  { value: 'all', labelKey: 'search.filterSpaceAll' },
]

const ROLE_OPTIONS: FilterChipSpec['options'] = [
  { value: 'any', labelKey: 'search.filterRoleAny' },
  { value: 'user', labelKey: 'search.filterRoleUser' },
  { value: 'assistant', labelKey: 'search.filterRoleAssistant' },
]

/**
 * 时间那几格。**「自定」删掉了**(09-05 裁定;检索面终稿 §6「设置极简:不摆死
 * 选项」)—— 它挑下去开不出任何日期件,是一格按了什么都不会发生的死选项。
 * `TimeFilter` 的 `'custom'` 与 `customFrom/To` 两格**留着**:`filtersOf` 那一支
 * 仍然算得对,日期件到位那天只要把这一行加回来。
 */
const TIME_OPTIONS: FilterChipSpec['options'] = [
  { value: 'any', labelKey: 'search.filterTimeAny' },
  { value: 'today', labelKey: 'search.filterTimeToday' },
  { value: 'week', labelKey: 'search.filterTimeWeek' },
  { value: 'month', labelKey: 'search.filterTimeMonth' },
]

/**
 * 「含 / 不含」那两格。
 *
 * 从前归档与推理是**两态片**:片上写「含归档」,按下去表示「不含」—— 语义正好
 * 反了(09-05 用户报障)。改形根治:片名是名词(「归档」),值才是「含 / 不含」,
 * 与空间 / 角色 / 时间三颗**同一形**,屏幕上再也没有「按下去代表反义」这回事。
 */
const WITH_OPTIONS: FilterChipSpec['options'] = [
  { value: 'yes', labelKey: 'search.filterWith' },
  { value: 'no', labelKey: 'search.filterWithout' },
]

/**
 * 这一档要画哪几颗片,以及每一颗此刻的样子。
 *
 * 次序是固定的(空间 / 角色 / 时间 / 含归档 / 含推理)—— 与 §9 的行文逐字同序。
 * 摆不出那个 facet 键的片**整颗不画**:画一颗按下去什么都不会发生的片,比不画
 * 更让人怀疑是不是坏了(与「画一颗恒不出现的徽等于骗自己」同一条判据)。
 */
export function filterChipsOf(
  state: SearchFilterState,
  available: ReadonlySet<string>,
): FilterChipSpec[] {
  const chips: FilterChipSpec[] = []
  if (available.has(SPACE_FACET)) {
    chips.push({
      id: 'space',
      facet: SPACE_FACET,
      labelKey: 'search.filterSpace',
      on: state.space !== INITIAL_FILTERS.space,
      options: SPACE_OPTIONS,
      value: state.space,
    })
  }
  if (available.has(ROLE_FACET)) {
    chips.push({
      id: 'role',
      facet: ROLE_FACET,
      labelKey: 'search.filterRole',
      on: state.role !== INITIAL_FILTERS.role,
      options: ROLE_OPTIONS,
      value: state.role,
    })
  }
  if (available.has(TIME_FACET)) {
    chips.push({
      id: 'time',
      facet: TIME_FACET,
      labelKey: 'search.filterTime',
      on: state.time !== INITIAL_FILTERS.time,
      options: TIME_OPTIONS,
      value: state.time,
    })
  }
  if (available.has(ARCHIVED_FACET)) {
    chips.push({
      id: 'archived',
      facet: ARCHIVED_FACET,
      labelKey: 'search.filterArchived',
      on: state.archived !== INITIAL_FILTERS.archived,
      options: WITH_OPTIONS,
      value: state.archived ? 'yes' : 'no',
    })
  }
  if (available.has(REASONING_FACET)) {
    chips.push({
      id: 'reasoning',
      facet: REASONING_FACET,
      labelKey: 'search.filterReasoning',
      on: state.reasoning !== INITIAL_FILTERS.reasoning,
      options: WITH_OPTIONS,
      value: state.reasoning ? 'yes' : 'no',
    })
  }
  return chips
}
