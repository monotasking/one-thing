import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SearchResponse, SearchResult } from '@shared/ipc/search'
import { SearchPanel } from './SearchPanel'
import { useStageStore } from '../../stage/store'
import { useExposeStore } from '../../expose/store'
import { initialStageState } from '../../stage/transitions'
import { useToastHub } from '../../ui/Toast'
import { useNotifyStore } from '../../services/notify-store'
import { useLocateMessage } from '../../content/locate-message'
import {
  capabilitySearchQuery,
  ensureSearchCatalog,
  resetSearchCatalog,
  searchCatalogKey,
} from '../../data/search-catalog-source'
import type { SearchAsk } from '../../data/search-catalog-source'
import { configureSearchPort } from '../../data/search-port'
import { FAKE_CAPABILITY_MANIFESTS, fakeSearchPort } from '../../test/fake-search-port'
import { ALL_TAB } from '../capabilities'
import { INITIAL_FILTERS, facetKeysOf, filtersOf } from '../filters'
import type { SearchFilterState } from '../filters'
import { DEFAULT_SPACE_ID } from '../../workspace/types'
import { pageWindow } from '../transitions'

/**
 * **拆件对照**(第 ⑥ 步的自证)。
 *
 * 第 ⑥ 步是「store + 拆件(**等价**)」:`SearchPanel.tsx` 里那几段画法搬进
 * `SearchHead / SearchFilterBar / SearchFailedLine / SearchRow / SearchRowMenu /
 * SearchFooter` 六个模块,props 原样、DOM 原样、CSS 类原样。**像素零差**这句话
 * 在 jsdom 里的可执行形态就是这一份:同一组 fixture 渲染出来的 `innerHTML`
 * 逐字相同。
 *
 * 取法:快照**在拆之前生成**(`__snapshots__/SearchPanel.dom-parity.test.tsx.snap`
 * 进了库),拆完再跑一遍 —— vitest 默认不自动改快照,所以任何一个字的漂移都是红。
 * 反证:给某个抽出的组件少传一格 prop,这里当场红。
 *
 * **它会在第 ⑦ / ⑧ 步合法地变红**(那两步是有意改 DOM 的:页脚移出 listbox、
 * 组头退役、动作行进分隔线下)。那时按当批的裁定 `-u` 一次,并在交卷里逐条说明
 * 哪一格为什么变 —— 快照的用处正是**逼着说出来**,不是钉住形状不许动。
 */

/** 面板此刻会算出来的那份 `filters` —— 用产品那两只纯函数算,不手抄一份。 */
function wireOf(capability: string, state: SearchFilterState = INITIAL_FILTERS) {
  return filtersOf(state, {
    spaceId: DEFAULT_SPACE_ID,
    defaultSpaceId: DEFAULT_SPACE_ID,
    now: Date.now(),
    available: facetKeysOf(FAKE_CAPABILITY_MANIFESTS, capability, ALL_TAB),
  })
}

/** 种一格答案(与 `SearchPanel.test.tsx` 的 `seed` 逐字同一套键)。 */
function seed(
  capability: SearchAsk,
  query: string,
  answer: Partial<SearchResponse> & { results: SearchResult[] },
  options: { page?: number; filters?: SearchFilterState; tab?: string } = {},
): void {
  const page = options.page ?? 1
  const limit = pageWindow(page)
  const key = searchCatalogKey(
    capability,
    query,
    limit,
    wireOf(options.tab ?? (typeof capability === 'string' ? capability : ALL_TAB), options.filters),
  )
  capabilitySearchQuery.get(key).patch({
    results: answer.results,
    limit,
    ...(answer.groups === undefined ? {} : { groups: answer.groups }),
    ...(answer.total === undefined ? {} : { total: answer.total }),
    ...(answer.cursor === undefined ? {} : { cursor: answer.cursor }),
    ...(answer.relaxed === undefined ? {} : { relaxed: answer.relaxed }),
  })
}

const hit = (over: Partial<SearchResult> = {}): SearchResult => ({
  id: 'r1',
  type: 'message',
  title: '命中的那一行',
  subtitle: '那间会话',
  target: { kind: 'message', payload: { sessionId: 's1', messageId: 'm1' } },
  ...over,
})

const chatHit = (over: Partial<SearchResult> = {}): SearchResult => ({
  id: 'c1',
  type: 'chat',
  title: '一间会话',
  subtitle: '首条消息的截断',
  target: { kind: 'chat', payload: { sessionId: 's1' } },
  ...over,
})

const input = () => screen.getByLabelText('搜索')
const rows = () => [...document.querySelectorAll('[role="option"]')]
  .filter(el => el.getAttribute('data-row') !== 'more')

function type(value: string): void {
  fireEvent.change(input(), { target: { value } })
}

beforeEach(async () => {
  resetSearchCatalog()
  useLocateMessage.getState().reset()
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  useExposeStore.setState({ view: { mode: 'overview' }, query: '' })
  useToastHub.setState({ toasts: [], folded: 0 })
  useNotifyStore.setState({ items: [] })
  configureSearchPort(fakeSearchPort())
  await ensureSearchCatalog()
})

afterEach(() => {
  configureSearchPort(fakeSearchPort())
})

describe('拆件对照:同一组 fixture 的 DOM 逐字相同', () => {
  it('① rest —— 刚挂上来,一格答案都没有', async () => {
    const { container } = render(<SearchPanel />)
    await waitFor(() => expect(screen.getByText('所有')).toBeTruthy())
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('② 有结果 —— 两行 + 徽 + 高亮 + 出处', async () => {
    const { container } = render(<SearchPanel />)
    seed(ALL_TAB, '词', {
      results: [hit(), hit({ id: 'r2', title: '词也在这一行里', facets: { archived: true } })],
      total: 2,
      relaxed: 1,
    })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('③ 空 —— 一句「无结果」', async () => {
    const { container } = render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [] })
    type('词')
    await waitFor(() => expect(screen.getByText('无结果')).toBeTruthy())
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('④ error —— 上面一行「没搜成」+ 后端原话,旧行留着', async () => {
    const { container } = render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    configureSearchPort(fakeSearchPort({
      query: async () => { throw new Error('后端说的那句原话') },
    }))
    const key = searchCatalogKey(ALL_TAB, '词', pageWindow(1), wireOf(ALL_TAB))
    await capabilitySearchQuery.get(key).refetch()
    await waitFor(() => expect(screen.getByText('后端说的那句原话')).toBeTruthy())
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('⑤ pending —— 旧行留着,底下那条是「已显示 N 条」读数', async () => {
    const { container } = render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    // 一发永不落地的重拉 = `inflight` 真而 `data` 还在 → `remote: 'pending'`。
    configureSearchPort(fakeSearchPort({
      query: () => new Promise(() => {}),
    }))
    const key = searchCatalogKey(ALL_TAB, '词', pageWindow(1), wireOf(ALL_TAB))
    void capabilitySearchQuery.get(key).refetch()
    await waitFor(() => expect(screen.getByText('已显示 1 条')).toBeTruthy())
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('⑥ 组头带 total —— 三组,一组有真数、一组塌了', async () => {
    const groups: SearchResponse['groups'] = [
      { capability: 'chats', label: 'search.capability.chats', total: 12, results: [chatHit()] },
      { capability: 'messages', label: 'search.capability.messages', results: [hit()] },
      { capability: 'files', label: 'search.capability.files', results: [], error: '索引不可用' },
    ]
    const { container } = render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [chatHit(), hit()], groups })
    type('词')
    await waitFor(() => expect(document.querySelectorAll('[data-group]')).toHaveLength(3))
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('⑦ more 项 —— 第一页给满,块尾那条能按', async () => {
    const chatRows = Array.from({ length: pageWindow(1) }, (_, i) => chatHit({
      id: `c${i}`,
      title: `会话 ${i}`,
      target: { kind: 'chat', payload: { sessionId: `s${i}` } },
    }))
    const { container } = render(<SearchPanel />)
    seed('chats', '', { results: chatRows }, { tab: ALL_TAB })
    await waitFor(() => expect(rows()).toHaveLength(pageWindow(1)))
    expect(screen.getByTestId('search-more')).toBeTruthy()
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('⑧ 多选 —— ⌘ 点两行', async () => {
    const { container } = render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit(), hit({ id: 'r2' }), hit({ id: 'r3' })] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(rows()[0], { metaKey: true })
    fireEvent.click(rows()[1], { metaKey: true })
    await waitFor(() => expect(document.querySelectorAll('[data-picked]')).toHaveLength(2))
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('⑨ 右键菜单开着 —— 连同浮层一起(所以读的是 body)', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.contextMenu(rows()[0])
    await waitFor(() => expect(screen.getByText('在此会话内搜')).toBeTruthy())
    expect(document.body.innerHTML).toMatchSnapshot()
  })
})
