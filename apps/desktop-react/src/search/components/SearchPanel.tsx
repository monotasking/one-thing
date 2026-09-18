import { useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useStageStore } from '../../stage/store'
import { useExposeStore } from '../../expose/store'
import { FocusScope } from '../../focus/FocusScope'
import type { SegmentedOption } from '../../ui/Segmented'
import { getLogger } from '../../services/log'
import { notify } from '../../services/notify'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { itemRefOf, resultRows } from '../transitions'
import type { SearchRow, SearchScope } from '../types'
import {
  ALL_TAB,
  browseCapabilitiesOf,
  indexReadoutOf,
  labelKeyOf,
  labelTextOf,
  nextTab,
  resolveTab,
  scopeNamesOf,
  tabsOf,
} from '../capabilities'
import {
  INITIAL_FILTERS,
  facetKeysOf,
  filterChipsOf,
  filtersAreDefault,
  filtersOf,
  SPACE_FACET,
} from '../filters'
import { canGoBack } from '../history'
import { resolveTargetRenderer } from '../targets'
import type { SearchTargetContext } from '../targets'
import { resolveItemKind } from '../items'
import type { SearchItemContext, SearchItemView } from '../items'
import { rowOfItem } from '../sequence'
import type { SearchItem } from '../sequence'
import {
  useSearchCapabilities,
  useSearchIndexStatus,
} from '../../data/search-catalog-source'
import type { SearchPreviewMode } from '../../data/search-catalog-source'
import {
  refetchSearchListing,
  searchInvoke,
  searchListingKey,
  searchLoadMore,
} from '../../data/search-listing-source'
import { useLocateMessage } from '../../content/locate-message'
import { openFileInCurrentTarget } from '../../content/viewer/open-target'
import { useSessionCwd } from '../../data/files-source'
import { currentSpaceId } from '../../workspace/current'
import { DEFAULT_SPACE_ID } from '../../workspace/types'
import { useSearchListing } from '../hooks/useSearchListing'
import { useSearchKeys } from '../hooks/useSearchKeys'
import { useSearchStore } from '../store'
import { SearchBindings } from './SearchBindings'
import { SearchPreview } from './SearchPreview'
import { SearchFailedLine } from './SearchFailedLine'
import { SearchFilterBar } from './SearchFilterBar'
import { SearchHead } from './SearchHead'
import { SearchList } from './SearchList'
import { SearchRowMenu } from './SearchRowMenu'
import type { RowMenuState } from './SearchRowMenu'
import s from './SearchPanel.module.css'

/**
 * 检索面板 = 一块普通的 Dock 内容(id 'search')。三张状态表的**正本**在
 * `apps/desktop-react/docs/search-panel-2026-09.md`(附录 B §2–§4)——
 * 这里不再抄一份:文件头那张表与代码不符地活了两个月,那正是 09-05 报障的一半。
 *
 * 第 ⑦ 步「换心」之后这只件是**骨架**:零业务状态,一个 ref。它做四件事 ——
 * 算出主语那把键、装配 `items` 那张表要的宿主能力、把键盘接到 `useSearchKeys`、
 * 摆好五件骨架(顶栏 / 输入框 / 档位条 / 过滤片 / 左列表右预览)。
 *
 * 事实分三层住(附录 B §0 ②):kernel 的格持行集 / 每块 cursor / 忙态;
 * `search/store.ts` 持词 / 档 / 片 / 历史 / 活动项 / 多选 / 滚动记忆;
 * 组件只持组件寿命的瞬态(右键菜单锚点)。从前那八格 `useState` 全部退役。
 */

export function SearchPanel() {
  const t = useT()
  const panelRef = useRef<HTMLDivElement | null>(null)
  /** 组件寿命的唯一一格瞬态:右键菜单开在哪儿(点锚,不跟滚)。 */
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null)

  /* ── 主语三格(产地在 store)────────────────────────────────────────── */
  const query = useSearchStore(st => st.query)
  const requestedScope = useSearchStore(st => st.scope)
  const filters = useSearchStore(st => st.filters)
  const picked = useSearchStore(st => st.picked)
  const selection = useSearchStore(st => st.selection)
  const setQuery = useSearchStore(st => st.setQuery)
  const setScope = useSearchStore(st => st.setScope)
  const setFilters = useSearchStore(st => st.setFilters)
  const setActive = useSearchStore(st => st.setActive)
  const pick = useSearchStore(st => st.pick)
  const clearPicks = useSearchStore(st => st.clearPicks)
  const pushCommit = useSearchStore(st => st.pushCommit)
  const stepHistory = useSearchStore(st => st.stepHistory)
  const runContinuation = useSearchStore(st => st.runContinuation)
  const history = useSearchStore(st => st.history)

  /* ── 档位:从自述读,不是一张写死的表(§9 第一条)──────────────────── */
  const manifests = useSearchCapabilities()
  const tabs = useMemo(() => tabsOf(manifests), [manifests])
  /** 这一档还在不在。刚被注销的档退回 `all` —— 停在一个不存在的档上等于给死路。 */
  const scope = resolveTab(tabs, requestedScope)
  const indexStatus = useSearchIndexStatus()
  const indexReadout = useMemo(() => indexReadoutOf(indexStatus), [indexStatus])

  /* ── 过滤片:哪几颗画得出来由自述说 ────────────────────────────────── */
  const spaceId = currentSpaceId()
  const cwd = useSessionCwd()
  const available = useMemo(
    () => facetKeysOf(manifests, scope, ALL_TAB),
    [manifests, scope],
  )
  const chips = useMemo(() => filterChipsOf(filters, available), [filters, available])
  const wire = useMemo(
    () => filtersOf(filters, {
      spaceId,
      defaultSpaceId: DEFAULT_SPACE_ID,
      now: Date.now(),
      available,
      ...(cwd === null ? {} : { cwd }),
    }),
    [filters, spaceId, available, cwd],
  )
  /** 跨空间徽**只在「全部空间」下画**(§9 原话)。 */
  const allSpaces = filters.space === 'all'

  /* ── 主语那把键 ────────────────────────────────────────────────────── */
  const searching = query.trim().length > 0
  /**
   * 空词的「所有」档 = **浏览态**:去问自述里声明了 `browse` 的那些能力。
   * 判据只能是「有没有词」—— 后端的 `'all'` 是有词时的分组总览(不分页)。
   */
  const browsePlan = useMemo(
    () => (scope === ALL_TAB && !searching ? browseCapabilitiesOf(manifests) : []),
    [scope, searching, manifests],
  )
  const asked = browsePlan.length > 0 ? browsePlan : scope
  const subjectKey = useMemo(
    () => searchListingKey(asked, query, wire),
    [asked, query, wire],
  )
  /**
   * 主语里**除词以外**那一半的指纹。它变了 = 一次「确定的一步」(换档 / 拨片 /
   * 续搜),不等合并窗口 —— 让一次确定的点击等 220ms 是把它当成了打字。
   */
  const subjectShape = useMemo(
    () => searchListingKey(asked, '', wire),
    [asked, wire],
  )

  /* ── 屏幕上那一张清单 ──────────────────────────────────────────────── */
  const listing = useSearchListing()
  const { held, sequence } = listing
  const shownQuery = held.data?.query ?? ''

  /* ── 落点 ─────────────────────────────────────────────────────────── */
  const enterSession = useExposeStore((st) => st.enterSession)
  const closeToDock = useStageStore((st) => st.closeToDock)
  const locateMessage = useLocateMessage((st) => st.locateMessage)

  const targetContext: SearchTargetContext = {
    enterSession(sessionId, messageId) {
      enterSession(sessionId)
      if (messageId) locateMessage(sessionId, messageId)
    },
    /*
     * **真的打开它**(09-18 报障:「在搜索里面搜到笔记后回车,有提示框显示已打开,
     * 但实际上没打开」)。S4 起这一格是个占位:只弹一句「已打开 {file}」,从没接过
     * 打开动作 —— 而 `targets/file.tsx` 与 `targets/note.tsx` 的落点都走它,于是
     * 文件与笔记两类结果按下去得到的都是同一句假话。
     *
     * 落点走 `openFileInCurrentTarget` —— 全壳「打开一个文件」的唯一编排点(文件面板、
     * 消息里的文件引用、改动面、待办共八个调用方走的都是它),所以「打开方式」那七档
     * 在检索面这一路上自动成立,这里一个字都不必知道它开去哪儿。
     *
     * **不再弹通知**:文件真的开了,那块查看器自己就是反馈;读不到时查看器画的是
     * 自己那句人话(`viewer.denied` / `missing` / `failed`),所以这里也不补一句 ——
     * 一件事两处各说一遍,迟早说的不是同一句。
     */
    openFile(path, line) {
      openFileInCurrentTarget(path, line)
    },
    runAction(actionId, capability) {
      // 「这一行本身就是一条动作」那一形(还没建出来的那篇笔记)。`items` 不发:
      // 后端那一侧夹的是动作号里编着的那条路径,不是这一行。
      void invokeAction(capability, actionId)
    },
  }

  /**
   * **按下一条后端动作**(P5)。
   *
   * 成功那一下屏幕上什么都不说:按下「在 Obsidian 中打开」的结果是那台 app 跳到
   * 前台 —— 再弹一句「已打开」就是在解释一件用户正看着的事。失败才说话,而且说
   * 的是字典里那一句,**原话只进日志**(R6 / R12)。
   */
  const invokeAction = async (capability: string, actionId: string, row?: SearchRow): Promise<void> => {
    try {
      await searchInvoke.run({
        capability,
        actionId,
        ...(row === undefined
          ? {}
          : { items: [{ capability: row.capability, id: row.id, target: row.target }] }),
      })
      closeToDock('search')
    } catch (error) {
      getLogger('search.invoke').warn('a search action failed', { capability, actionId }, error)
      notify({
        level: 'error',
        source: 'search.open',
        title: t('search.actionFailed'),
      })
    }
  }

  const openRow = (row: SearchRow): void => {
    const renderer = resolveTargetRenderer(row.target.kind)
    if (renderer === undefined) {
      notify({
        level: 'info',
        source: 'search.open',
        title: t('search.targetUnavailable', { kind: row.target.kind }),
      })
      return
    }
    renderer.activate(row, targetContext)
    // 选中就是这块面板的活干完了,收回 Dock(拍点 F 保旧)。
    closeToDock('search')
  }

  /** 契约的形 → 壳的形。**收窄只有 `resultRows` 一处产地**(与 `items/row` 同一只)。 */
  const rowModelOf = (item: SearchItem): SearchRow | undefined => {
    const result = rowOfItem(held.data, item)
    if (result === undefined || item.block === undefined) return undefined
    return resultRows([result], item.block)[0]
  }

  /** 项按下去时手上那几条窄回调(宿主给能力,项只说要干什么)。 */
  const itemContext: SearchItemContext = {
    listing: held.data,
    openRow(result, capability) {
      const row = resultRows([result], capability)[0]
      if (row !== undefined) openRow(row)
    },
    loadMore(capability, cursor) {
      void searchLoadMore.run({ key: listing.key, capability, cursor })
    },
    runAction(action) {
      // 动作自报它属于哪一类(契约 `SearchActionDescriptor.capability`);缺席的
      // 那一档问不出该找谁,如实说一句而不是猜一个能力 id。
      if (action.capability === undefined) {
        notify({
          level: 'info',
          source: 'search.open',
          title: t('search.actionUnavailable', { action: action.id }),
        })
        return
      }
      void invokeAction(action.capability, action.id)
    },
    canLoadMore: listing.canLoadMore,
  }

  const activateItem = (item: SearchItem): void => {
    resolveItemKind(item.kind)?.activate(item, itemContext)
  }

  /* ── 项的画法要的那几样宿主能力 ────────────────────────────────────── */
  const rowIndex = useMemo(() => {
    const table = new Map<string, number>()
    let at = 0
    for (const item of sequence) {
      if (item.kind === 'row') {
        table.set(item.id, at)
        at += 1
      }
    }
    return table
  }, [sequence])

  const itemView: SearchItemView = {
    t,
    spaceId,
    defaultSpaceId: DEFAULT_SPACE_ID,
    allSpaces,
    moreStateOf: listing.moreStateOf,
    picked: (item: SearchItem) => (item.rowId === undefined ? false : picked.includes(item.rowId)),
    rowIndexOf: (item: SearchItem) => rowIndex.get(item.id),
    onPointer(item: SearchItem, event: ReactMouseEvent) {
      // **显式点击**是原语允许改 active 的第二条产地(第一条是键盘)。
      setActive(item.id, 'pointer')
      if (item.kind !== 'row') {
        activateItem(item)
        return
      }
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        // 带修饰键的点击在这套形态语法里从来就是「挑」,不带的是「做」。
        if (item.rowId !== undefined) pick(item.rowId)
        return
      }
      clearPicks()
      activateItem(item)
    },
    onContextMenu(item: SearchItem, event: ReactMouseEvent) {
      if (item.kind !== 'row') return
      const row = rowModelOf(item)
      if (row === undefined) return
      event.preventDefault()
      setActive(item.id, 'pointer')
      setRowMenu({ row, x: event.clientX, y: event.clientY })
    },
  }

  /* ── 键盘 ─────────────────────────────────────────────────────────── */
  const canRecallHistory = !searching && canGoBack(history)
  const { onKeyDown, commands } = useSearchKeys({
    sequence,
    activate: activateItem,
    stepScope: (step: 1 | -1) => setScope(nextTab(tabs, scope, step)),
    canRecallHistory,
  })

  /* ── 预览(§4.5)──────────────────────────────────────────────────── */
  const previewRows = useMemo(() => {
    const byId = new Map<string, SearchRow>()
    for (const block of listing.blocks) {
      for (const result of resultRows(block.rows, block.capability)) byId.set(result.id, result)
    }
    if (picked.length > 0) {
      return picked.map(id => byId.get(id)).filter((row): row is SearchRow => row !== undefined)
    }
    const active = sequence.find(item => item.id === selection.id)
    // **块尾项与动作行不进预览**:锚不变,停在它们身上时预览不闪(R3 / §4)。
    if (active === undefined || active.kind !== 'row' || active.rowId === undefined) return []
    const row = byId.get(active.rowId)
    return row === undefined ? [] : [row]
  }, [listing.blocks, picked, sequence, selection.id])

  const previewMode: SearchPreviewMode = useMemo(() => {
    if (previewRows.length <= 1) return 'single'
    if (previewRows.length === 2 && previewRows[0].target.kind === previewRows[1].target.kind) {
      return 'compare'
    }
    return 'batch'
  }, [previewRows])

  const previewItems = useMemo(() => previewRows.map(itemRefOf), [previewRows])
  const inlinePreview = previewRows.length === 1 ? previewRows[0].preview : undefined
  /**
   * **这一类到底有没有预览**(§4.5 ①;落差 #2)。自述里**明说**没有 `preview`
   * 那一格 = 这一类根本不产预览 —— 那就一发请求都不出门,窗里画行的放大版。
   *
   * 「查不到那份自述」**不算**明说(全部档的行归在 `all` 名下,而 `all` 不是一个
   * 能力):不知道就照问,由后端答 —— 拿「我没查到」当「它没有」,就是把一次
   * 探测变成一次断言。
   */
  const previewable = previewRows.every(row => {
    const manifest = manifests.find(one => one.id === row.capability)
    return manifest === undefined || manifest.preview !== undefined
  })

  /* ── 档位表(自述原样)─────────────────────────────────────────────── */
  const options: Array<SegmentedOption<SearchScope>> = tabs.map((tab) => ({
    value: tab.id,
    label: labelTextOf(tab.labelKey, t(tab.labelKey as MessageKey)),
  }))

  const labelOf = (capability: string): string => {
    const key = labelKeyOf(manifests, capability) ?? capability
    return labelTextOf(key, t(key as MessageKey))
  }

  /**
   * 输入框那句占位**从自述生成**(R12;落差 #51):「搜 会话、消息、笔记…」。
   * 自述还没回来 = 一个档名都没有 = 退到那句不带档名的兜底,而不是印一串猜的。
   */
  const placeholder = useMemo(() => {
    const names = scopeNamesOf(tabs, tab => labelTextOf(tab.labelKey, t(tab.labelKey as MessageKey)))
    return names.length === 0
      ? t('search.placeholder')
      : t('search.placeholderOf', { names: names.join(t('search.scopeJoin')) })
  }, [tabs, t])

  /* ── 画 ───────────────────────────────────────────────────────────── */

  return (
    <FocusScope
      scope="search"
      rootRef={panelRef}
      restingTarget={() => panelRef.current?.querySelector('input') ?? null}
      commands={commands}
    >
      {({ scopeProps }) => (
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
         * 这里挂 onKeyDown 是**事件委托**,不是把一个 div 变成控件:真正拿焦点的是里面那个
         * 输入框(落点声明),↑↓/⏎ 从它冒泡上来,由面板统一按当前活动项处理。 */
        <div {...scopeProps} className={s.panel} data-testid="search-panel" onKeyDown={onKeyDown}>
          {/* 三条副作用(取数去抖 / 摆出来送焦点 / 收回去回出厂)住在一片叶子里。 */}
          <SearchBindings subjectKey={subjectKey} subjectShape={subjectShape} />

          <SearchHead
            query={query}
            onQueryChange={setQuery}
            options={options}
            scope={scope}
            onScopeChange={setScope}
            placeholder={placeholder}
            t={t}
          />

          <SearchFilterBar
            filters={filters}
            chips={chips}
            available={available}
            history={history}
            onFilters={(next) => setFilters(next(filters))}
            onStepHistory={stepHistory}
            t={t}
          />

          {/* 检索失败不许静默:它与「没搜到」是两件事(拍点 A′ 保旧:原话并陈)。 */}
          <SearchFailedLine error={held.error} t={t} />

          <div className={s.main}>
            <SearchList
              listing={listing}
              itemView={itemView}
              query={shownQuery}
              typed={query}
              t={t}
              labelOf={labelOf}
              indexReadout={indexReadout}
              onRetryBlock={() => { void refetchSearchListing(listing.key) }}
              {...(filters.space === 'current' && available.has(SPACE_FACET)
                ? { onSearchAllSpaces: () => setFilters({ ...filters, space: 'all' }) }
                : {})}
              {...(filtersAreDefault(filters)
                ? {}
                : { onClearFilters: () => setFilters(INITIAL_FILTERS) })}
            />

            <SearchPreview
              items={previewItems}
              mode={previewMode}
              previewable={previewable}
              {...(inlinePreview === undefined ? {} : { inline: inlinePreview })}
              {...(previewRows.length === 1 ? { row: previewRows[0] } : {})}
              query={shownQuery}
            />
          </div>

          {/* 行的动作表(右键):「打开」+「只看这一类」+ 这一类自报的续搜与后端动作。 */}
          <SearchRowMenu
            state={rowMenu}
            available={available}
            t={t}
            onClose={() => setRowMenu(null)}
            onOpen={openRow}
            onContinuation={runContinuation}
            onScopeOnly={(capability: string) => {
              // 「查看全部」从组头搬到这里(R1):先记这一步,再换档。
              pushCommit()
              setScope(capability)
            }}
            onRowAction={(row, action) => { void invokeAction(row.capability, action.actionId, row) }}
          />
        </div>
      )}
    </FocusScope>
  )
}
