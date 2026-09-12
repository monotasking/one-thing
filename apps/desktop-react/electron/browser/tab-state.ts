/**
 * 一格 tab 的**纯状态投影**与它的 reducer。零 Electron、零 node —— 所以它在
 * vitest 里跑得起来(旧壳 `apps/electron/src/browser/tab-state.ts` 同一条理由:
 * `BrowserViewService` 的表面全是 `WebContentsView` / `session`,测不动;几何与
 * 状态折叠这两件真会藏 bug 的事必须住在测得动的地方)。
 *
 * ## 这不是「渲染层的镜像」
 *
 * 旧壳那份的注释写着「渲染器只持一份 mirror,真源在 BrowserViewService」——
 * 今天这句话仍然成立,但**出口变了**:状态变化经 provider 的 `emit` → `resource:event`
 * → SSE 到壳(方案 §2.2-3),不再有一条 `browser:tabs-changed` 的手写推送通道。
 * 于是旧壳那只 `createTabStateCoalescer`(把一次导航的十来发细粒度事件攒成一发
 * 广播)**没有搬过来**:合批是「一条推送通道的流控」,而 `resource:event` 有它
 * 自己的出网口与节流位置,在这里再攒一层等于两处合批、两套时序。
 *
 * ## `error` 取代旧壳的 `crashed`
 *
 * 旧壳只认「渲染进程没了」这一种坏;真机上更常见的是 `did-fail-load`(DNS 挂了、
 * 证书被拒、离线)。两者对用户是同一件事:**这一格现在打不开东西**,而屏幕上
 * 该说出是哪一句。所以这一格是一句话(`undefined` = 没坏),不是一个布尔。
 */

/** 一格 tab 对外的全部事实。`profile` 决定它跑在哪个持久分区上。 */
export interface BrowserTabState {
  readonly id: string
  /** 已经**提交**的地址。空串 = 这一格还停在起始页(什么都没加载)。 */
  readonly url: string
  readonly title: string
  readonly favicon?: string
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  /** 最近一次失败的人话。成功一次导航就清掉。 */
  readonly error?: string
  readonly profile: string
}

/** 可被 reducer 改的那几格(`id` / `profile` 是身份,一格 tab 一辈子不变)。 */
export type BrowserTabPatch = Partial<Omit<BrowserTabState, 'id' | 'profile'>>

export interface BrowserTabInit {
  readonly id: string
  readonly profile: string
  readonly url?: string
  readonly title?: string
}

export function createTabState(init: BrowserTabInit): BrowserTabState {
  return {
    id: init.id,
    profile: init.profile,
    url: init.url ?? '',
    title: init.title ?? '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  }
}

/**
 * 折一次状态。**没变就返回原对象**(引用相等)—— 调用方拿「变没变」当发不发事件
 * 的判据,而一次导航会连发十来个事件、其中大半格格相同(`did-stop-loading` 与
 * `did-finish-load` 紧挨着各来一发)。在这里答出身份相等,上面那层就不必再写一遍
 * 逐格比较,也不会把同一件事发两遍。
 *
 * `undefined` 的格子按 JS 的常识处理:`{ favicon: undefined }` 是**清掉** favicon
 * (页面换了、新页面没有图标),不是「这一格别动」。想「别动」就别把这个键放进
 * patch —— 判据是 `key in patch`,不是 `patch[key] !== undefined`。
 */
export function reduceTabState(prev: BrowserTabState, patch: BrowserTabPatch): BrowserTabState {
  let changed = false
  const next: Record<string, unknown> = { ...prev }
  for (const key of Object.keys(patch) as Array<keyof BrowserTabPatch>) {
    const value = patch[key]
    if (prev[key] === value) continue
    changed = true
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return changed ? (next as unknown as BrowserTabState) : prev
}

/**
 * 落盘的那一份 —— **只留跨重启还成立的格子**。
 *
 * `loading` / `canGoBack` / `canGoForward` 是活视图的属性,进程死了它们就是谎话;
 * `error` 是上一条命的死因,新起一格不该顶着它。`favicon` 不落是另一条理由:
 * 它是一坨 data URL(封顶 256KB),把它写进一份要频繁重写的小账本是拿磁盘换
 * 一次冷启动的图标闪现 —— 页面一加载它自己就回来了。
 */
export interface PersistedTab {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly profile: string
}

export function persistTab(state: BrowserTabState): PersistedTab {
  return { id: state.id, url: state.url, title: state.title, profile: state.profile }
}

/** 落盘账本的全形。`version` 在,是为了将来换形状时能认出旧账本而不是把它当垃圾。 */
export interface PersistedTabTable {
  readonly version: 1
  readonly tabs: readonly PersistedTab[]
  readonly activeId: string | null
}

export const EMPTY_TAB_TABLE: PersistedTabTable = { version: 1, tabs: [], activeId: null }

/**
 * 读一份账本。**坏账本 = 空账本,不是一次崩溃**:这是一份可以随时丢掉重建的
 * 派生数据(丢了的后果是重启后没有上次那几格 tab),为它让整个壳起不来是错的
 * 取舍。认不出的版本同理。
 */
export function parseTabTable(raw: unknown): PersistedTabTable {
  if (!raw || typeof raw !== 'object') return EMPTY_TAB_TABLE
  const table = raw as { version?: unknown; tabs?: unknown; activeId?: unknown }
  if (table.version !== 1 || !Array.isArray(table.tabs)) return EMPTY_TAB_TABLE
  const tabs: PersistedTab[] = []
  for (const entry of table.tabs) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as { id?: unknown; url?: unknown; title?: unknown; profile?: unknown }
    if (typeof row.id !== 'string' || !row.id) continue
    tabs.push({
      id: row.id,
      url: typeof row.url === 'string' ? row.url : '',
      title: typeof row.title === 'string' ? row.title : '',
      profile: typeof row.profile === 'string' && row.profile ? row.profile : 'default',
    })
  }
  const activeId = typeof table.activeId === 'string' && tabs.some(tab => tab.id === table.activeId)
    ? table.activeId
    : null
  return { version: 1, tabs, activeId }
}
