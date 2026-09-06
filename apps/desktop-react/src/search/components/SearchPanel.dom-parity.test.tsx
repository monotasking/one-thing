import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SearchFilters, SearchResponse, SearchResult } from '@shared/ipc/search'
import { SearchPanel } from './SearchPanel'
import { useStageStore } from '../../stage/store'
import { useExposeStore } from '../../expose/store'
import { initialStageState } from '../../stage/transitions'
import { useToastHub } from '../../ui/Toast'
import { useNotifyStore } from '../../services/notify-store'
import { useLocateMessage } from '../../content/locate-message'
import { ensureSearchCatalog, resetSearchCatalog } from '../../data/search-catalog-source'
import { refetchSearchListing, resetSearchListing } from '../../data/search-listing-source'
import { configureSearchPort } from '../../data/search-port'
import type { SearchPort } from '../../data/search-port'
import { fakeSearchPort } from '../../test/fake-search-port'
import { useSearchStore } from '../store'

/**
 * **九态 DOM 对照**。
 *
 * 第 ⑥ 步立它的时候是「拆件等价」的自证(快照在拆之前生成,拆完逐字节相同)。
 * 第 ⑦⑧ 步**有意**改 DOM,所以这一份快照按当批裁定 `-u` 了一次,四处变化逐条
 * 说在这里 —— 快照的用处正是**逼着说出来**,不是钉住形状不许动:
 *
 *  1. **页脚移出 listbox**:列表根从 `.body`(既是滚动容器又是那张网)拆成
 *     `.list`(滚动容器,`data-testid="search-list"`)+ `.body`(`role="listbox"`)
 *     + `SearchFooter`(listbox 的**兄弟**)。APG:listbox 的孩子只该是选项与分隔。
 *  2. **组头退役**:`[data-group]` / `[data-group-total]` / `[data-group-error]`
 *     三族属性与 `GroupHead` 一起消失;块边界只剩块首那一行上的 `.blockStart`
 *     (一格空 + 一条发线)。「查看全部」进了右键菜单。
 *  3. **动作行在分隔线下**:`role="separator"` 一条 + 每条动作 `role="option"`
 *     `data-row="action"`,带「＋」前缀;它不计入任何条数。
 *  4. **块尾那条项换了形**:`data-block` / `data-more-state` / `aria-busy` 三格新
 *     属性,取尽时它变成一条 `data-readout="end"` 的读数(不是 item)。
 *     行上多了 `data-item-id` / `tabIndex=-1`,页脚读数合成一行 `' · '` 串。
 *
 * 种答案的手法也换了(与 `SearchPanel.test.tsx` 同一条理由):新数据层不导出
 * family,只能换端口让真 fetcher 跑一遍。
 *
 * ── 第 ⑨ 步又 `-u` 了一次,**只有一处**,九态逐格相同的那一处 ──────────────
 * 输入框占位:`搜文件、章节、消息、会话…` → `搜会话、提示词、笔记、文件、消息、命令…`。
 * 从前那句是字典里写死的一串档名,而它上一次说对是在「章节」还是一个档的时候
 * (落差 #51);现在它由自述生成(`capabilities.ts` 的 `scopeNamesOf` + 档位表的
 * 次序),注销一个能力它自己就少一个名字。九态的 diff **除了这一处再无别的**
 * (`git diff` 里 `placeholder="…"` 是唯一变化的属性)—— 快照的用处正是让这句话
 * 有人可核。
 */

interface Ask {
  query: string
  category: string
  limit: number
  filters?: SearchFilters
  cursor?: string
}

let respond: (ask: Ask) => SearchResponse | Promise<SearchResponse>

function serve(
  next: (ask: Ask) => SearchResponse | Promise<SearchResponse>,
  extra: Partial<SearchPort> = {},
): void {
  respond = next
  configureSearchPort(fakeSearchPort({
    query: async (query, category, limit, filters, cursor) =>
      respond({ query, category, limit, filters, ...(cursor === undefined ? {} : { cursor }) }),
    ...extra,
  }))
}

function serveRows(
  answer: Partial<SearchResponse> & { results: SearchResult[] },
  extra: Partial<SearchPort> = {},
): void {
  serve(() => ({ success: true, ...answer }), extra)
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
  .filter(el => {
    const at = el.getAttribute('data-row')
    return at !== 'more' && at !== 'action'
  })

function type(value: string): void {
  fireEvent.change(input(), { target: { value } })
}

beforeEach(async () => {
  resetSearchCatalog()
  resetSearchListing()
  useSearchStore.getState().reset()
  useLocateMessage.getState().reset()
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  useExposeStore.setState({ view: { mode: 'overview' }, query: '' })
  useToastHub.setState({ toasts: [], folded: 0 })
  useNotifyStore.setState({ items: [] })
  serve(() => ({ success: true, results: [] }))
  await ensureSearchCatalog()
})

afterEach(() => {
  configureSearchPort(fakeSearchPort())
})

describe('九态 DOM 对照', () => {
  it('① rest —— 刚挂上来,一格答案都没有', async () => {
    serve(() => new Promise<SearchResponse>(() => {}))
    const { container } = render(<SearchPanel />)
    await waitFor(() => expect(screen.getByText('所有')).toBeTruthy())
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('② 有结果 —— 两行 + 徽 + 高亮 + 出处', async () => {
    serveRows({
      results: [hit(), hit({ id: 'r2', title: '词也在这一行里', facets: { archived: true } })],
      total: 2,
      relaxed: 1,
    })
    const { container } = render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('③ 零结果 —— 一句「没有和「词」匹配的结果」+ 下一步', async () => {
    serveRows({ results: [] })
    const { container } = render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(screen.getByText('没有和「词」匹配的结果')).toBeTruthy())
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('④ error —— 上面一行「没搜成」+ 后端原话,旧行留着', async () => {
    let fail = false
    serve(() => {
      if (fail) throw new Error('后端说的那句原话')
      return { success: true, results: [hit()] }
    })
    const { container } = render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fail = true
    await refetchSearchListing(useSearchStore.getState().committedKey)
    await waitFor(() => expect(screen.getByText('后端说的那句原话')).toBeTruthy())
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('⑤ pending —— 旧行留着,页脚一行「搜索中…」', async () => {
    let hang = false
    serve(() => (hang
      ? new Promise<SearchResponse>(() => {})
      : { success: true, results: [hit()] }))
    const { container } = render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    hang = true
    void refetchSearchListing(useSearchStore.getState().committedKey)
    await waitFor(() => expect(document.querySelector('[data-readout="searching"]')).toBeTruthy())
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('⑥ 多块 + 块级失败 —— 块相邻不混排,塌了的那一块只在页脚说一句', async () => {
    serveRows({
      results: [chatHit(), hit()],
      groups: [
        { capability: 'chats', label: 'search.capability.chats', total: 12, results: [chatHit()] },
        { capability: 'messages', label: 'search.capability.messages', results: [hit()] },
        { capability: 'files', label: 'search.capability.files', results: [], error: '索引不可用' },
      ],
    })
    const { container } = render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('⑦ more 项 —— 第一页给满且有游标,块尾那条能按', async () => {
    const chatRows = Array.from({ length: 20 }, (_, i) => chatHit({
      id: `c${i}`,
      title: `会话 ${i}`,
      target: { kind: 'chat', payload: { sessionId: `s${i}` } },
    }))
    serveRows({ results: chatRows, cursor: 'c1', total: 25 })
    const { container } = render(<SearchPanel />)
    await waitFor(() => expect(rows()).toHaveLength(20))
    expect(screen.getByTestId('search-more')).toBeTruthy()
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('⑧ 多选 + 动作行 —— ⌘ 点两行,末尾一条分隔线下的动作', async () => {
    serveRows({
      results: [hit(), hit({ id: 'r2' }), hit({ id: 'r3' })],
      actions: [{
        id: 'create-prompt:jira',
        labelKey: 'search.action.createPrompt',
        capability: 'prompts',
        kind: 'create',
        params: { title: 'jira' },
      }],
    })
    const { container } = render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(rows()[0], { metaKey: true })
    fireEvent.click(rows()[1], { metaKey: true })
    await waitFor(() => expect(document.querySelectorAll('[data-picked]')).toHaveLength(2))
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('⑨ 右键菜单开着 —— 连同浮层一起(所以读的是 body)', async () => {
    serveRows({ results: [hit()] })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.contextMenu(rows()[0])
    await waitFor(() => expect(screen.getByText('在此会话内搜')).toBeTruthy())
    expect(document.body.innerHTML).toMatchSnapshot()
  })
})
