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
import { translate } from '../../i18n'
import {
  capabilitySearchQuery,
  ensureSearchCatalog,
  resetSearchCatalog,
  searchCatalogKey,
} from '../../data/search-catalog-source'
import type { SearchAsk } from '../../data/search-catalog-source'
import { configureSearchPort } from '../../data/search-port'
import {
  FAKE_BROWSE_MANIFEST,
  FAKE_CAPABILITY_MANIFESTS,
  FAKE_EXTRA_MANIFEST,
  fakeSearchPort,
} from '../../test/fake-search-port'
import { ALL_TAB } from '../capabilities'
import { INITIAL_FILTERS, facetKeysOf, filtersOf } from '../filters'
import type { SearchFilterState } from '../filters'
import { DEFAULT_SPACE_ID } from '../../workspace/types'
import { pageWindow } from '../transitions'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { FOCUS_SCOPES } from '../../focus/scopes'

/**
 * 检索面板(S4b:**一条数据路,零能力 id**)。
 *
 * 这一批用例把断言全部搬到了那条唯一的路上:种的是 `search.query` 那一格的答案,
 * 验的是「屏幕上按后端说的画」。三件新东西各有一节:分组由后端 `groups` 说、
 * 过滤片以结构传、续搜与查询历史。
 *
 * ── 为什么种 kernel 那一格,而不是让端口真答一次 ────────────────────────
 * 面板那条取数副作用带 220ms 合并窗口(打字的余波)。让每个用例都等一次真窗口
 * 会把这份文件变成一份计时器测试 —— 而这一批验的是**面板怎么用这批答案**,
 * 取数本身在数据源自己的用例里验。`patch` 把那一格落成「这个问题已经有答案了」。
 */

/** 面板此刻会算出来的那份 `filters` —— **用产品那两只纯函数算**,不手抄一份。 */
function wireOf(capability: string, state: SearchFilterState = INITIAL_FILTERS) {
  return filtersOf(state, {
    spaceId: DEFAULT_SPACE_ID,
    defaultSpaceId: DEFAULT_SPACE_ID,
    now: Date.now(),
    available: facetKeysOf(FAKE_CAPABILITY_MANIFESTS, capability, ALL_TAB),
  })
}

/** 种一格答案:键 = 「问谁 + 什么词 + 要多少条 + 哪些过滤片」。 */
function seed(
  capability: SearchAsk,
  query: string,
  answer: Partial<SearchResponse> & { results: SearchResult[] },
  options: { page?: number; filters?: SearchFilterState; tab?: string } = {},
): void {
  const page = options.page ?? 1
  const limit = pageWindow(page)
  /*
   * 过滤片按**面板此刻那一档**算(`options.tab`),不按「问谁」算 —— 空词的
   * 「所有」档问的是 chats,而片仍然是 `all` 档那份并集(面板的 `scope` 没变)。
   * 今天这两份恰好算出同一份 `filters`,写出判据是为了它们哪天不一样时不静默错开。
   */
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

beforeEach(async () => {
  resetSearchCatalog()
  useLocateMessage.getState().reset()
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  useExposeStore.setState({ view: { mode: 'overview' }, query: '' })
  useToastHub.setState({ toasts: [], folded: 0 })
  useNotifyStore.setState({ items: [] })
  configureSearchPort(fakeSearchPort())
  /*
   * 自述**先喂饱再渲染**:tab 条与片条都是从它算出来的,而那条 query 是异步的。
   * 这不是把异步藏起来 —— 面板自己那条 `ensureSearchCatalog` 照样跑(幂等),
   * 这里只是让用例从「自述已经到手」那一帧开始。
   */
  await ensureSearchCatalog()
})

afterEach(() => {
  configureSearchPort(fakeSearchPort())
})

const input = () => screen.getByLabelText('搜索')
const rows = () => [...document.querySelectorAll('[role="option"]')]
  .filter(el => el.getAttribute('data-row') !== 'more')

function type(value: string): void {
  fireEvent.change(input(), { target: { value } })
}

describe('tab 条 = 自述表(§9 第一条)', () => {
  it('all 固定第一,其余按 order 升序', () => {
    render(<SearchPanel />)
    const labels = [...document.querySelectorAll('[role="radio"]')].map(el => el.textContent)
    expect(labels).toEqual(['所有', '会话', '提示词', '笔记', '文件', '消息', '命令'])
  })

  /** §4.0 的硬指标 + §11 S4 的反证:注册表多一个能力,壳一个字不改就跟上。 */
  it('注册表多一个**设计时没想过的**能力 → tab 条自己多一格,落在它自己声明的位置上', async () => {
    resetSearchCatalog()
    configureSearchPort(fakeSearchPort({
      capabilities: async () => [...FAKE_CAPABILITY_MANIFESTS, FAKE_EXTRA_MANIFEST],
    }))
    await ensureSearchCatalog()
    render(<SearchPanel />)
    const labels = [...document.querySelectorAll('[role="radio"]')].map(el => el.textContent)
    // order 2.5 → 落在提示词(2)与笔记(3)之间。文案键不在字典里 = 画原文。
    expect(labels).toEqual([
      '所有', '会话', '提示词', 'search.capability.unknown', '笔记', '文件', '消息', '命令',
    ])
  })

  it('能力被注销 → 停在那一档的面板退回 all(不留一个查不到东西的档)', async () => {
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('笔记'))
    await waitFor(() => expect(screen.getByText('笔记').getAttribute('aria-checked')).toBe('true'))
    resetSearchCatalog()
    configureSearchPort(fakeSearchPort({
      capabilities: async () => FAKE_CAPABILITY_MANIFESTS.filter(m => m.id !== 'daily'),
    }))
    await ensureSearchCatalog()
    await waitFor(() => expect(screen.queryByText('笔记')).toBeNull())
    expect(screen.getByText('所有').getAttribute('aria-checked')).toBe('true')
  })

  it('Tab / ⇧Tab 在 tab 条上轮转,到头回卷', () => {
    render(<SearchPanel />)
    fireEvent.keyDown(input(), { key: 'Tab' })
    expect(screen.getByText('会话').getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true })
    expect(screen.getByText('所有').getAttribute('aria-checked')).toBe('true')
  })
})

/**
 * 空词的「所有」档 = **浏览态**(S4b 修;09-01 用户裁定「我要能够在这里面看到所有
 * 的条数,所有的记录,要能够翻页」)。
 *
 * 判据全在自述的那一格 `browse` 上 —— 这一节里没有一个能力 id 是面板认识的:
 * 用例点名 `chats` 是因为**用例**要验它,面板那一侧读的是表。
 */
describe('空词的「所有」档 = 浏览态(§9 / 09-01 裁定)', () => {
  const chatRows = (count: number): SearchResult[] => Array.from({ length: count }, (_, i) => chatHit({
    id: `c${i}`,
    title: `会话 ${i}`,
    target: { kind: 'chat', payload: { sessionId: `s${i}` } },
  }))

  it('空词不发 `all`,而是问自报浏览态的那个能力 —— 一张平铺列表,**没有组头**', async () => {
    render(<SearchPanel />)
    seed('chats', '', { results: chatRows(5) }, { tab: ALL_TAB })
    await waitFor(() => expect(rows()).toHaveLength(5))
    // 「所有」仍然是选中的那一格 —— 变的是问谁,不是用户看见的档。
    expect(screen.getByText('所有').getAttribute('aria-checked')).toBe('true')
    expect(document.querySelectorAll('[data-group]')).toHaveLength(0)
  })

  it('取尽那一刻报**总条数**(「共 N 条 · 已全部显示」)', async () => {
    render(<SearchPanel />)
    seed('chats', '', { results: chatRows(5) }, { tab: ALL_TAB })
    await waitFor(() => expect(rows()).toHaveLength(5))
    expect(screen.getByText('共 5 条 · 已全部显示')).toBeTruthy()
  })

  it('**翻得了页**:给满了就画「加载更多」,按一下窗口放大、剩下的出来', async () => {
    render(<SearchPanel />)
    // 第一页给满(20 = limit)= 「后面可能还有」,那一刻不许诺总数。
    seed('chats', '', { results: chatRows(pageWindow(1)) }, { tab: ALL_TAB })
    await waitFor(() => expect(rows()).toHaveLength(pageWindow(1)))
    expect(screen.getByTestId('search-more').textContent).toBe('加载更多')
    seed('chats', '', { results: chatRows(25) }, { page: 2, tab: ALL_TAB })
    fireEvent.click(screen.getByTestId('search-more'))
    await waitFor(() => expect(rows()).toHaveLength(25))
    expect(screen.getByText('共 25 条 · 已全部显示')).toBeTruthy()
  })

  it('**有词**照旧是分组总览 —— 判据是「有没有词」,不是别的', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', {
      results: [chatHit()],
      groups: [{ capability: 'chats', label: 'search.capability.chats', results: [chatHit()] }],
    })
    type('词')
    await waitFor(() => expect(document.querySelectorAll('[data-group]')).toHaveLength(1))
  })

  /**
   * §4.0 的硬指标:**注册表再来一个自报浏览态的能力,空词那一屏自己多一组**,
   * 面板 / 数据源一个字不改。这一条走的是真 fetcher(不是种一格答案)——
   * 「多能力时一组一发」正是它要验的东西。
   */
  it('注册表多一个 `browse` 的陌生能力 → 空词多一组,组名从自述读', async () => {
    resetSearchCatalog()
    configureSearchPort(fakeSearchPort({
      capabilities: async () => [FAKE_BROWSE_MANIFEST, ...FAKE_CAPABILITY_MANIFESTS],
      query: async (_query, category) => ({
        success: true,
        results: [chatHit({ id: `${category}:1`, title: `${category} 的一行` })],
      }),
    }))
    await ensureSearchCatalog()
    render(<SearchPanel />)
    await waitFor(
      () => expect([...document.querySelectorAll('[data-group]')].map(el => el.getAttribute('data-group')))
        // order 0.5 在 chats(1)前面 —— 次序也来自自述。
        .toEqual([FAKE_BROWSE_MANIFEST.id, 'chats']),
      { timeout: 3000 },
    )
    /*
     * 组名:后端这几发没给名字(是壳自己拼的组),于是从自述表读那个能力自己的
     * `labelKey` —— 翻得出画译文(chats → 「会话」),翻不出画原文(陌生能力那一格)。
     */
    const head = (capability: string) =>
      document.querySelector(`[data-group="${capability}"]`)?.textContent ?? ''
    expect(head('chats')).toContain('会话')
    expect(head(FAKE_BROWSE_MANIFEST.id)).toContain(FAKE_BROWSE_MANIFEST.labelKey)
  })
})

describe('全部档的分组由**后端的 groups** 说(§7.2 / §9 第四条)', () => {
  const groups: SearchResponse['groups'] = [
    { capability: 'chats', label: 'search.capability.chats', total: 12, results: [chatHit()] },
    { capability: 'messages', label: 'search.capability.messages', results: [hit()] },
    { capability: 'files', label: 'search.capability.files', results: [], error: '索引不可用' },
  ]

  it('组头逐条 = 后端那几组,次序原样(壳不按行归堆)', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [chatHit(), hit()], groups })
    type('词')
    await waitFor(() => expect(document.querySelectorAll('[data-group]').length).toBe(3))
    expect([...document.querySelectorAll('[data-group]')].map(el => el.getAttribute('data-group')))
      .toEqual(['chats', 'messages', 'files'])
  })

  it('组的 total 是**后端给的真数**(能力知道才给),缺席就不画那一格', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [chatHit(), hit()], groups })
    type('词')
    await waitFor(() => expect(document.querySelector('[data-group-total="chats"]')).toBeTruthy())
    expect(document.querySelector('[data-group-total="chats"]')?.textContent).toContain('12')
    expect(document.querySelector('[data-group-total="messages"]')).toBeNull()
  })

  it('某组塌了 → 那一组的组头一句「没搜成」,别的组照常出结果', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [chatHit(), hit()], groups })
    type('词')
    await waitFor(() => expect(document.querySelector('[data-group-error="files"]')).toBeTruthy())
    expect(rows()).toHaveLength(2)
  })

  /** §4.0 的硬指标:后端多答一组,屏幕上就多一组 —— 壳一个字不改。 */
  it('后端多答一组(陌生能力)→ 屏上多一组,它的行走「缺渲染器画标题行」那条路', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', {
      results: [hit()],
      groups: [
        ...groups,
        {
          capability: FAKE_EXTRA_MANIFEST.id,
          label: FAKE_EXTRA_MANIFEST.labelKey,
          results: [{
            id: 'x1',
            type: 'plugin',
            title: '陌生能力的一行',
            target: { kind: '外星形', payload: {} },
          }],
        },
      ],
    })
    type('词')
    await waitFor(() => expect(document.querySelectorAll('[data-group]').length).toBe(4))
    const alien = rows().find(el => el.getAttribute('data-capability') === FAKE_EXTRA_MANIFEST.id)
    expect(alien).toBeTruthy()
    // 缺渲染器 = 空徽 + 照样画出正文(§4.3:绝不因为壳没跟上而把结果吞掉)。
    expect(alien?.children[0].textContent).toBe('')
    expect(alien?.children[1].textContent).toContain('陌生能力的一行')
  })

  it('单类档不分组 —— 一张平铺列表就是它自己那一组', async () => {
    render(<SearchPanel />)
    seed('messages', '词', { results: [hit()] })
    fireEvent.click(screen.getByText('消息'))
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(document.querySelectorAll('[data-group]')).toHaveLength(0)
  })
})

describe('过滤片(§9 第五条):画不画由自述说,传的是结构', () => {
  it('messages 档画四颗(空间 / 角色 / 时间 / 含归档);files 档一颗都不画', async () => {
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('消息'))
    await waitFor(() => expect(document.querySelectorAll('[data-filter]').length).toBe(4))
    expect([...document.querySelectorAll('[data-filter]')].map(el => el.getAttribute('data-filter')))
      .toEqual(['space', 'role', 'time', 'archived'])
    fireEvent.click(screen.getByText('文件'))
    await waitFor(() => expect(document.querySelectorAll('[data-filter]').length).toBe(0))
  })

  it('挑一格角色 → 换一个 query 键(结构传的那一格进了键),屏幕上只剩那一档的结果', async () => {
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('消息'))
    seed('messages', '词', { results: [hit({ title: '用户说的那句' }), hit({ id: 'r2', title: '助手说的那句' })] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(2))

    // 角色片选「用户」——同一个词、同一档,但键换了,所以这是**另一份答案**。
    const roleState: SearchFilterState = { ...INITIAL_FILTERS, role: 'user' }
    seed('messages', '词', { results: [hit({ title: '用户说的那句' })] }, { filters: roleState })
    fireEvent.click(screen.getByText('角色'))
    fireEvent.click(await screen.findByText('用户'))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].children[1].textContent).toContain('用户说的那句')
  })

  it('跨空间徽**只在「全部空间」下画** —— 默认那一档里一颗都没有', async () => {
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('消息'))
    const cross = hit({ facets: { spaceId: 'w9' } })
    seed('messages', '词', { results: [cross] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(document.querySelectorAll('[data-tag="space"]')).toHaveLength(0)

    const allSpaces: SearchFilterState = { ...INITIAL_FILTERS, space: 'all' }
    seed('messages', '词', { results: [cross] }, { filters: allSpaces })
    fireEvent.click(screen.getByText('空间'))
    fireEvent.click(await screen.findByText('全部'))
    await waitFor(() => expect(document.querySelectorAll('[data-tag="space"]')).toHaveLength(1))
  })

  it('归档徽按**事实**画(facets.archived 为真),与过滤片无关', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit({ facets: { archived: true } })] })
    type('词')
    await waitFor(() => expect(document.querySelectorAll('[data-tag="archived"]')).toHaveLength(1))
  })
})

describe('续搜(§4.6):范围片 / 枢轴 / 查询历史', () => {
  function openRowMenu(): void {
    fireEvent.contextMenu(rows()[0])
  }

  it('右键一条消息 → 菜单里有「打开」与「在此会话内搜」', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    expect(await screen.findByText('打开')).toBeTruthy()
    expect(screen.getByText('在此会话内搜')).toBeTruthy()
  })

  it('按「在此会话内搜」→ 片条上多一颗范围片,而且**词留着**', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    fireEvent.click(await screen.findByText('在此会话内搜'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeTruthy())
    expect(document.querySelector('[data-filter="scope"]')?.textContent).toContain('那间会话')
    expect((input() as HTMLInputElement).value).toBe('词')
  })

  it('范围片的 × 去掉它 —— 它就是 filters 的可视化,不是第二种状态', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    fireEvent.click(await screen.findByText('在此会话内搜'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('去掉这个范围'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeNull())
  })

  it('枢轴「提到它的消息」→ 换到消息那一档 + 种子词是**文件名**', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', {
      results: [{
        id: 'f1',
        type: 'file',
        title: '/repo/a/model-registry.ts',
        target: { kind: 'file', payload: { filePath: '/repo/a/model-registry.ts' } },
      }],
    })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    fireEvent.click(await screen.findByText('提到它的消息'))
    await waitFor(() => expect((input() as HTMLInputElement).value).toBe('model-registry.ts'))
    expect(screen.getByText('消息').getAttribute('aria-checked')).toBe('true')
  })

  /**
   * S4b 修:files 在自述里声明了 `dir`(扫描根),所以这一条**按得动了** ——
   * 而 `targets/file.tsx` 与面板都一个字没改。「片可不可用由能力自述答」。
   */
  it('「在此目录内搜」按得动 —— files 自述里有 `dir` 这个 facet', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', {
      results: [{
        id: 'f1',
        type: 'file',
        title: '/repo/a/x.ts',
        target: { kind: 'file', payload: { filePath: '/repo/a/x.ts' } },
      }],
    })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    const item = await screen.findByText('在此目录内搜')
    expect(item.closest('button')?.disabled).toBe(false)
  })

  /** 反面:一个不声明 `dir` 的档上它仍然按不动(判据真的是自述,不是「恒真」)。 */
  it('换到一个不认 `dir` 的档,「在此目录内搜」又灰回去', async () => {
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('消息'))
    seed('messages', '词', {
      results: [{
        id: 'f1',
        type: 'file',
        title: '/repo/a/x.ts',
        target: { kind: 'file', payload: { filePath: '/repo/a/x.ts' } },
      }],
    })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    const item = await screen.findByText('在此目录内搜')
    expect(item.closest('button')?.disabled).toBe(true)
  })

  it('走过一步之后 ⌘[ 退回去,四格**原样还原**(词 / 档 / 片)', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    fireEvent.click(await screen.findByText('在此会话内搜'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('回上一条查询'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeNull())
    expect((input() as HTMLInputElement).value).toBe('词')
  })

  it('前进钮在没走过之前是**禁灰而不消失**', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    fireEvent.click(await screen.findByText('在此会话内搜'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeTruthy())
    expect((screen.getByLabelText('再往前一条') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('回上一条查询'))
    await waitFor(() =>
      expect((screen.getByLabelText('再往前一条') as HTMLButtonElement).disabled).toBe(false))
  })

  it('↑ 在**输入框空着且停在第一行**时回上一条查询;有词的时候它只走行', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit(), hit({ id: 'r2' })] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(2))
    openRowMenu()
    fireEvent.click(await screen.findByText('在此会话内搜'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeTruthy())

    // 有词:↑ 是走行,历史一步都不退。
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(document.querySelector('[data-filter="scope"]')).toBeTruthy()

    // 清空输入框之后那一下才轮到历史。
    type('')
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeNull())
  })
})

describe('预览窗(§4.5)', () => {
  it('一条都没选中 = 一句「选一条看看」', () => {
    render(<SearchPanel />)
    expect(document.querySelector('[data-preview="empty"]')).toBeTruthy()
  })

  it('inline 那一种(chats)**零请求**:随候选带的载荷当场画出来', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', {
      results: [chatHit({
        preview: {
          kind: 'session-overview',
          payload: { sessionId: 's1', title: '一间会话', messageCount: 7, updatedAt: 1, preview: '首条' },
        },
      })],
    })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    await waitFor(() =>
      expect(document.querySelector('[data-preview-kind="session-overview"]')).toBeTruthy())
    expect(document.querySelector('[data-fact="count"]')?.textContent).toBe('7')
  })

  it('lazy 那一种走 `search.preview`;后端算不出时画**它的原话**', async () => {
    configureSearchPort(fakeSearchPort({
      preview: async () => ({ success: false, error: '那条消息不在账本里了' }),
    }))
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    await waitFor(() => expect(document.querySelector('[data-preview="error"]')).toBeTruthy())
    expect(document.querySelector('[data-preview="error"]')?.textContent)
      .toContain('那条消息不在账本里了')
  })

  it('后端画得出来时按 kind 从注册表取组件', async () => {
    configureSearchPort(fakeSearchPort({
      preview: async () => ({
        success: true,
        preview: {
          kind: 'message-context',
          payload: {
            sessionId: 's1',
            messageId: 'm1',
            hit: { id: 'm1', role: 'assistant', text: '命中那一条' },
            before: [{ id: 'm0', role: 'user', text: '前一条' }],
            after: [],
          },
        },
      }),
    }))
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    await waitFor(() =>
      expect(document.querySelector('[data-preview-kind="message-context"]')).toBeTruthy())
    expect(screen.getByText('命中那一条')).toBeTruthy()
    expect(screen.getByText('前一条')).toBeTruthy()
  })

  it('壳画不出这种媒介时画**Row 放大版**,而不是把结果吞掉', async () => {
    configureSearchPort(fakeSearchPort({
      preview: async () => ({ success: true, preview: { kind: '外星媒介', payload: {}, title: '一个标题' } }),
    }))
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    await waitFor(() => expect(document.querySelector('[data-preview="fallback"]')).toBeTruthy())
    expect(document.querySelector('[data-preview="fallback"]')?.textContent).toContain('一个标题')
  })

  it('⌘ 点两条同 kind → compare;点第三条 → batch(基数是请求的一部分)', async () => {
    const modes: string[] = []
    configureSearchPort(fakeSearchPort({
      preview: async (_items, mode) => {
        modes.push(mode)
        return { success: true }
      },
    }))
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit(), hit({ id: 'r2' }), hit({ id: 'r3' })] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(rows()[0], { metaKey: true })
    fireEvent.click(rows()[1], { metaKey: true })
    await waitFor(() => expect(modes).toContain('compare'))
    fireEvent.click(rows()[2], { metaKey: true })
    await waitFor(() => expect(modes).toContain('batch'))
  })

  it('⌘ 点**不打开**那一行 —— 带修饰键的点击是「挑」,不带的才是「做」', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.click(rows()[0], { metaKey: true })
    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
    expect(rows()[0].getAttribute('data-picked')).toBe('true')
  })
})

describe('落点与读数', () => {
  it('点一条正文命中 = 进会话 + 留一格「落到那条消息」的待办', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.click(rows()[0])
    expect(useLocateMessage.getState().request).toMatchObject({ sessionId: 's1', messageId: 'm1' })
  })

  it('缺渲染器的行按下去**如实说一句**,不静默吞掉', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', {
      results: [{ id: 'x', type: 'plugin', title: '外星行', target: { kind: '外星形', payload: {} } }],
    })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.click(rows()[0])
    expect(useNotifyStore.getState().items[0].title)
      .toBe(translate('zh', 'search.targetUnavailable', { kind: '外星形' }))
  })

  it('后端给了真 total 才画那一行;答不出就不画(不知道 ≠ 0)', async () => {
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('笔记'))
    seed('daily', '词', { results: [hit({ target: { kind: 'daily', payload: { filePath: '/a.md' } } })], total: 42 })
    type('词')
    await waitFor(() => expect(document.querySelector('[data-readout="total"]')).toBeTruthy())
    expect(document.querySelector('[data-readout="total"]')?.textContent).toContain('42')
  })

  it('放宽过才画「已放宽」那一行', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()], relaxed: 2 })
    type('词')
    await waitFor(() => expect(document.querySelector('[data-readout="relaxed"]')).toBeTruthy())
  })

  it('索引状态:pending > 0 才画「更新中」;reader 才画「由 … 维护」', async () => {
    resetSearchCatalog()
    configureSearchPort(fakeSearchPort({
      status: async () => ({ mode: 'reader', pending: 7, owner: { host: 'other', pid: 1 }, vector: 'off' }),
    }))
    await ensureSearchCatalog()
    render(<SearchPanel />)
    await waitFor(() => expect(document.querySelector('[data-readout="index-reader"]')).toBeTruthy())
    expect(document.querySelector('[data-readout="index-pending"]')?.textContent).toContain('7')
    expect(document.querySelector('[data-readout="index-reader"]')?.textContent).toContain('other')
  })

  it('这一发塌了:上面一行「没搜成」+ 后端原话,**旧结果不清屏**(律②)', async () => {
    render(<SearchPanel />)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    /*
     * 让**同一格**再问一次而这一次塌了 —— 那正是律②说的那一形:
     * 错误与旧答案共存,列表一行都不清。
     */
    configureSearchPort(fakeSearchPort({
      query: async () => { throw new Error('后端说的那句原话') },
    }))
    const key = searchCatalogKey(ALL_TAB, '词', pageWindow(1), wireOf(ALL_TAB))
    await capabilitySearchQuery.get(key).refetch()
    await waitFor(() => expect(screen.getByText('后端说的那句原话')).toBeTruthy())
    expect(rows()).toHaveLength(1)
  })
})

describe('面域局部键:⌘[ / ⌘](§4.6 的查询历史)', () => {
  /**
   * 声明与落点是**两处**:正本在 `focus/scopes.ts` 的 `FOCUS_SCOPES.search.keys`,
   * 落点是作用域实例注入的那张 `keyHandlers`。两处会不会分叉,要在**真的挂起来
   * 的实例**上对一次 —— 读的是树自己的排障口(与文件树那条逐字同款)。
   *
   * 反证:把 `searchKeys` 里那两格改个名(`history.back` → `back`),这一条当场红。
   */
  it('实例注入的 keyHandlers 名单 = FOCUS_SCOPES.search.keys 的 action 集合', async () => {
    render(<SearchPanel />)
    await waitFor(() => expect(screen.getByLabelText('搜索')).toBeTruthy())
    const node = focusTree.dump().nodes.find(n => n.scope === 'search')
    expect(node?.keys.slice().sort()).toEqual(
      [...new Set(FOCUS_SCOPES.search.keys?.map(k => k.action) ?? [])].sort(),
    )
  })

  it('那两格真的能走历史 —— 与两颗方向钮落的是同一条路', async () => {
    /*
     * **要把那台派发器一起摆进树里**:响应链上线之后,单独渲染一块面去按键
     * 等于「在一台没有外壳的机器上按键」—— 真正听 window 的只有
     * `focus/dispatch.ts` 那一个,而它挂在 `AppShell` 上。
     */
    render(<><FocusDispatchHarness /><SearchPanel /></>)
    seed(ALL_TAB, '词', { results: [hit()] })
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.contextMenu(rows()[0])
    fireEvent.click(await screen.findByText('在此会话内搜'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeTruthy())

    /*
     * 走的是**真的那条路**:window 上的捕获相位 keydown → 唯一那个派发器 →
     * 沿活动路径找局部键 → 实例注入的处理器。不去戳注册表的内部,
     * 因为「这一下到底谁接住了」正是这条用例要证的东西。
     */
    fireEvent.keyDown(window, { key: '[', metaKey: true })
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeNull())
    fireEvent.keyDown(window, { key: ']', metaKey: true })
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeTruthy())
  })
})
