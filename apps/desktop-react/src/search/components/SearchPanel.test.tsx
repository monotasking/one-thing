import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SearchFilters, SearchResponse, SearchResult } from '@shared/ipc/search'
import { SearchPanel } from './SearchPanel'
import { useStageStore } from '../../stage/store'
import { useExposeStore } from '../../expose/store'
import { initialStageState } from '../../stage/transitions'
import { useToastHub } from '../../ui/Toast'
import { useNotifyStore } from '../../services/notify-store'
import { useLocateMessage } from '../../content/locate-message'
import { translate } from '../../i18n'
import { ensureSearchCatalog, resetSearchCatalog } from '../../data/search-catalog-source'
import { refetchSearchListing, resetSearchListing } from '../../data/search-listing-source'
import { configureSearchPort } from '../../data/search-port'
import type { SearchPort } from '../../data/search-port'
import {
  FAKE_BROWSE_MANIFEST,
  FAKE_CAPABILITY_MANIFESTS,
  FAKE_EXTRA_MANIFEST,
  fakeSearchPort,
} from '../../test/fake-search-port'
import { useSearchStore } from '../store'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { FOCUS_SCOPES } from '../../focus/scopes'

/**
 * 检索面板(第 ⑦⑧ 步「换心 + 裁定落地」之后)。
 *
 * ── 种答案的手法换了,而且是**更诚实的一版** ──────────────────────────────
 * S4b 那一版是往 kernel 那一格里 `patch` 一份回执:查询族当年导出得到,所以
 * 用例可以绕过取数直接摆一个「这个问题已经有答案了」。新数据层**不导出 family**
 * (`search-listing-source.ts` 只交五口 —— 那是「零 `invalidate` 调用方」的结构
 * 保证),于是种答案只剩一条路:**换掉端口**,让真 fetcher 跑一遍。
 *
 * 代价是每条用例要等一次合并窗口(220ms)—— 换来的是这份文件验的东西从「面板
 * 怎么用这批答案」变成「从一次真取数到屏幕上那几行」整条链。`waitFor` 的缺省
 * 超时(1s)足够。
 */

interface Ask {
  query: string
  category: string
  limit: number
  filters?: SearchFilters
  cursor?: string
}

/** 这台假 core 此刻怎么答。每条用例自己换。 */
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

/** 一发就答这些行(最常见的那一形)。 */
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
  /*
   * 自述**先喂饱再渲染**:tab 条与片条都是从它算出来的,而那条 query 是异步的。
   * 面板自己那条 `ensureSearchCatalog` 照样跑(幂等),这里只是让用例从
   * 「自述已经到手」那一帧开始。
   */
  await ensureSearchCatalog()
})

afterEach(() => {
  configureSearchPort(fakeSearchPort())
})

const input = () => screen.getByLabelText('搜索')
/** 屏幕上那几条**结果行** —— 块尾项与动作行都是 option,但都不是结果。 */
const rows = () => [...document.querySelectorAll('[role="option"]')]
  .filter(el => {
    const at = el.getAttribute('data-row')
    return at !== 'more' && at !== 'action'
  })
const actionRows = () => [...document.querySelectorAll('[data-row="action"]')]
const moreItems = () => [...document.querySelectorAll('[data-row="more"]')]

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
    serve(() => ({ success: true, results: [] }), {
      capabilities: async () => [...FAKE_CAPABILITY_MANIFESTS, FAKE_EXTRA_MANIFEST],
    })
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
    serve(() => ({ success: true, results: [] }), {
      capabilities: async () => FAKE_CAPABILITY_MANIFESTS.filter(m => m.id !== 'daily'),
    })
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
 * 空词的「所有」档 = **浏览态**。判据全在自述那一格 `browse` 上 —— 这一节里没有
 * 一个能力 id 是面板认识的:用例点名 `chats` 是因为**用例**要验它。
 */
describe('空词的「所有」档 = 浏览态(§9 / 09-01 裁定)', () => {
  const chatRows = (count: number, from = 0): SearchResult[] =>
    Array.from({ length: count }, (_, i) => chatHit({
      id: `c${i + from}`,
      title: `会话 ${i + from}`,
      target: { kind: 'chat', payload: { sessionId: `s${i + from}` } },
    }))

  it('空词不发 `all`,而是问自报浏览态的那个能力 —— 一张平铺列表,**没有组头**', async () => {
    const asked: string[] = []
    serve((ask) => {
      asked.push(ask.category)
      return { success: true, results: chatRows(5) }
    })
    render(<SearchPanel />)
    await waitFor(() => expect(rows()).toHaveLength(5))
    expect(asked).toEqual(['chats'])
    // 「所有」仍然是选中的那一格 —— 变的是问谁,不是用户看见的档。
    expect(screen.getByText('所有').getAttribute('aria-checked')).toBe('true')
    expect(document.querySelectorAll('[data-group]')).toHaveLength(0)
  })

  it('取尽那一刻块尾换成一条读数,报的是**这一块**的条数', async () => {
    serveRows({ results: chatRows(5), total: 5 })
    render(<SearchPanel />)
    await waitFor(() => expect(rows()).toHaveLength(5))
    expect(moreItems()).toHaveLength(0)
    expect(document.querySelector('[data-readout="end"]')?.textContent).toContain('5')
  })

  it('**翻得了页**:有游标就画块尾那条,按一下这一块自己长一页', async () => {
    serve((ask) => (ask.cursor === undefined
      ? { success: true, results: chatRows(20), cursor: 'c1', total: 25 }
      : { success: true, results: chatRows(5, 20), total: 25 }))
    render(<SearchPanel />)
    await waitFor(() => expect(rows()).toHaveLength(20))
    expect(screen.getByTestId('search-more').textContent).toContain('20')
    fireEvent.click(screen.getByTestId('search-more'))
    await waitFor(() => expect(rows()).toHaveLength(25))
    expect(document.querySelector('[data-readout="end"]')?.textContent).toContain('25')
  })

  /**
   * **翻页四条不变量**(R4 / §5.4)。这一条是第 ⑦ 步唯一改行为那一步的自证:
   * 从前翻页换整把查询键 → 新格 `data === undefined` → 列表清空 → 容器高度归零
   * → `scrollTop` 被浏览器钳到 0(就是用户报的「Load more 跳回顶部」)。
   */
  it('按了「加载更多」:首行同一个 DOM 节点、scrollTop 不变、焦点仍在输入框、新行追加在块尾', async () => {
    serve((ask) => (ask.cursor === undefined
      ? { success: true, results: chatRows(20), cursor: 'c1' }
      : { success: true, results: chatRows(5, 20) }))
    render(<SearchPanel />)
    await waitFor(() => expect(rows()).toHaveLength(20))

    const list = document.querySelector('[data-testid="search-list"]') as HTMLElement
    const firstBefore = document.querySelector('[data-row="0"]')
    input().focus()
    // jsdom 不排版,所以这一格量的是「有没有人去改它」,不是真滚动距离。
    list.scrollTop = 0
    const topBefore = list.scrollTop

    fireEvent.click(screen.getByTestId('search-more'))
    await waitFor(() => expect(rows()).toHaveLength(25))

    expect(document.querySelector('[data-row="0"]')).toBe(firstBefore)
    expect(list.scrollTop).toBe(topBefore)
    expect(document.activeElement).toBe(input())
    expect(rows()[24].textContent).toContain('会话 24')
  })

  /**
   * §4.0 的硬指标:**注册表再来一个自报浏览态的能力,空词那一屏自己多一块**,
   * 面板 / 数据源一个字不改。
   */
  it('注册表多一个 `browse` 的陌生能力 → 空词多一块,次序按自述', async () => {
    resetSearchCatalog()
    resetSearchListing()
    serve(
      (ask) => ({
        success: true,
        results: [chatHit({ id: `${ask.category}:1`, title: `${ask.category} 的一行` })],
      }),
      { capabilities: async () => [FAKE_BROWSE_MANIFEST, ...FAKE_CAPABILITY_MANIFESTS] },
    )
    await ensureSearchCatalog()
    render(<SearchPanel />)
    await waitFor(() => expect(rows()).toHaveLength(2), { timeout: 3000 })
    // order 0.5 在 chats(1)前面 —— 次序也来自自述。
    expect(rows().map(el => el.getAttribute('data-capability')))
      .toEqual([FAKE_BROWSE_MANIFEST.id, 'chats'])
    // 块之间只有一格空 + 一条发线:第二块的首行自报 `first`,没有任何组头。
    expect(document.querySelectorAll('[data-group]')).toHaveLength(0)
  })
})

describe('全部档:一张清单,块相邻不混排(R1 / R2)', () => {
  const groups: SearchResponse['groups'] = [
    { capability: 'chats', label: 'search.capability.chats', total: 12, results: [chatHit()] },
    { capability: 'messages', label: 'search.capability.messages', results: [hit()] },
    { capability: 'files', label: 'search.capability.files', results: [], error: '索引不可用' },
  ]

  it('**没有组头、没有「in total」、没有「View all」**', async () => {
    serveRows({ results: [chatHit(), hit()], groups })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(document.querySelectorAll('[data-group]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-group-total]')).toHaveLength(0)
    expect(screen.queryByText('查看全部')).toBeNull()
  })

  it('块相邻不混排,次序原样;零命中的那一块**一个像素都不占**', async () => {
    serveRows({ results: [chatHit(), hit()], groups })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows().map(el => el.getAttribute('data-capability'))).toEqual(['chats', 'messages'])
    // files 那一块零命中(而且塌了)→ DOM 里不出现它。
    expect(document.querySelector('[data-capability="files"]')).toBeNull()
  })

  it('块级失败只在**页脚**说一句「<能力名>没搜成 · 重试」(拍点 A)', async () => {
    serveRows({ results: [chatHit(), hit()], groups })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(document.querySelector('[data-readout="block-errors"]')).toBeTruthy())
    const line = document.querySelector('[data-readout="block-errors"]')?.textContent ?? ''
    expect(line).toContain('文件')
    expect(line).toContain('重试')
    // 别的块照常出结果。
    expect(rows()).toHaveLength(2)
  })

  it('后端多答一组(陌生能力)→ 屏上多一块,它的行走「缺渲染器画标题行」那条路', async () => {
    serveRows({
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
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(3))
    const alien = rows().find(el => el.getAttribute('data-capability') === FAKE_EXTRA_MANIFEST.id)
    expect(alien).toBeTruthy()
    // 缺渲染器 = 空徽 + 照样画出正文(§4.3:绝不因为壳没跟上而把结果吞掉)。
    expect(alien?.children[0].textContent).toBe('')
    expect(alien?.children[1].textContent).toContain('陌生能力的一行')
  })

  it('单类档就是一块 —— 与全部档同一只列表', async () => {
    serveRows({ results: [hit()] })
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('消息'))
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(document.querySelectorAll('[data-group]')).toHaveLength(0)
  })
})

describe('动作行(R3):分隔线下、不计数、序列末项', () => {
  const withAction: Partial<SearchResponse> & { results: SearchResult[] } = {
    results: [hit()],
    actions: [{
      id: 'create-prompt:jira',
      labelKey: 'search.action.createPrompt',
      capability: 'prompts',
      kind: 'create',
      params: { title: 'jira' },
    }],
  }

  it('画在分隔线下,带「＋」前缀,**不计入结果行**', async () => {
    serveRows(withAction)
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(actionRows()).toHaveLength(1))
    expect(rows()).toHaveLength(1)
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(1)
    expect(actionRows()[0].textContent).toContain('新建提示词 “jira”')
  })

  it('零结果那一屏上它**照样在** —— 它是动作不是结果', async () => {
    serveRows({ results: [], actions: withAction.actions ?? [] })
    render(<SearchPanel />)
    type('jira')
    await waitFor(() => expect(actionRows()).toHaveLength(1))
    expect(rows()).toHaveLength(0)
    expect(screen.getByText('没有和「jira」匹配的结果')).toBeTruthy()
  })

  it('↓ 走得到它(序列末项),⏎ 落在它身上', async () => {
    serveRows(withAction)
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(actionRows()).toHaveLength(1))
    // 首项是那一行;再往下就是动作项(这一块取尽,所以没有块尾项)。
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    await waitFor(() => expect(actionRows()[0].getAttribute('aria-selected')).toBe('true'))
    fireEvent.keyDown(input(), { key: 'Enter' })
    // 壳今天没有落点:如实说一句,不静默吞掉。
    await waitFor(() => expect(useNotifyStore.getState().items).toHaveLength(1))
  })
})

describe('过滤片(§9 第五条):画不画由自述说,传的是结构', () => {
  it('messages 档画四颗(空间 / 角色 / 时间 / 归档);files 档一颗都不画', async () => {
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('消息'))
    await waitFor(() => expect(document.querySelectorAll('[data-filter]').length).toBe(4))
    expect([...document.querySelectorAll('[data-filter]')].map(el => el.getAttribute('data-filter')))
      .toEqual(['space', 'role', 'time', 'archived'])
    fireEvent.click(screen.getByText('文件'))
    await waitFor(() => expect(document.querySelectorAll('[data-filter]').length).toBe(0))
  })

  /** ⑧:两态片改成两格选项 —— 片名是名词,值才是「含 / 不含」。 */
  it('归档那一颗是「归档 · 含 / 不含」两格,不是一个反义的按下态', async () => {
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('消息'))
    await waitFor(() => expect(document.querySelector('[data-filter="archived"]')).toBeTruthy())
    const chip = document.querySelector('[data-filter="archived"]') as HTMLElement
    expect(chip.textContent).toContain('归档')
    expect(chip.textContent).toContain('含')
    fireEvent.click(chip.querySelector('button') as HTMLElement)
    expect(await screen.findByText('不含')).toBeTruthy()
  })

  /** ⑧:时间那颗不摆死选项 —— 「自定」挑下去开不出任何日期件。 */
  it('时间片上没有「自定」', async () => {
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('消息'))
    await waitFor(() => expect(document.querySelector('[data-filter="time"]')).toBeTruthy())
    fireEvent.click(document.querySelector('[data-filter="time"] button') as HTMLElement)
    expect(await screen.findByText('7 天')).toBeTruthy()
    expect(screen.queryByText('自定')).toBeNull()
  })

  it('挑一格角色 → 换一把键(结构传的那一格进了键),屏幕上只剩那一档的结果', async () => {
    serve((ask) => ({
      success: true,
      results: ask.filters?.role === 'user'
        ? [hit({ title: '用户说的那句' })]
        : [hit({ title: '用户说的那句' }), hit({ id: 'r2', title: '助手说的那句' })],
    }))
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('消息'))
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(2))
    fireEvent.click(screen.getByText('角色'))
    fireEvent.click(await screen.findByText('用户'))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].children[1].textContent).toContain('用户说的那句')
  })

  it('跨空间徽**只在「全部空间」下画** —— 默认那一档里一颗都没有', async () => {
    serveRows({ results: [hit({ facets: { spaceId: 'w9' } })] })
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('消息'))
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(document.querySelectorAll('[data-tag="space"]')).toHaveLength(0)
    fireEvent.click(screen.getByText('空间'))
    fireEvent.click(await screen.findByText('全部'))
    await waitFor(() => expect(document.querySelectorAll('[data-tag="space"]')).toHaveLength(1))
  })

  it('归档徽按**事实**画(facets.archived 为真),与过滤片无关', async () => {
    serveRows({ results: [hit({ facets: { archived: true } })] })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(document.querySelectorAll('[data-tag="archived"]')).toHaveLength(1))
  })

  /** ⑧:语义徽 —— 来自向量路的行右列一枚小徽(不是计数徽)。 */
  it('`source: vector` 的行多一枚「语义」徽,lexical 的没有', async () => {
    serveRows({
      results: [hit({ source: 'vector' }), hit({ id: 'r2', source: 'lexical' })],
    })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(document.querySelectorAll('[data-tag="semantic"]')).toHaveLength(1)
    expect(rows()[0].querySelector('[data-tag="semantic"]')).toBeTruthy()
  })
})

describe('无标题会话(§6):后端归空,壳兜底', () => {
  it('标题空 + 有首条用户消息 → 把它顶上来当正文', async () => {
    serveRows({ results: [chatHit({ title: '', subtitle: '我今天很难受…' })] })
    render(<SearchPanel />)
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].children[1].textContent).toContain('我今天很难受…')
  })

  it('两样都没有 → 行上画一句「未命名会话」,不是一行空白', async () => {
    serveRows({ results: [chatHit({ title: '', subtitle: '' })] })
    render(<SearchPanel />)
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].children[1].textContent).toBe('未命名会话')
  })
})

describe('续搜(§4.6):范围片 / 枢轴 / 查询历史', () => {
  function openRowMenu(): void {
    fireEvent.contextMenu(rows()[0])
  }

  it('右键一条消息 → 菜单里有「打开」「只看这一类」与「在此会话内搜」', async () => {
    serveRows({ results: [hit()] })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    expect(await screen.findByText('打开')).toBeTruthy()
    expect(screen.getByText('只看这一类')).toBeTruthy()
    expect(screen.getByText('在此会话内搜')).toBeTruthy()
  })

  /** ⑧:「查看全部」从组头搬进右键菜单。 */
  it('按「只看这一类」→ 换到那一档', async () => {
    /* 全部档的行归在**它自己那一块**名下,所以这一发要带 `groups`(真机上就是)。 */
    serveRows({
      results: [hit()],
      groups: [{ capability: 'messages', label: 'search.capability.messages', results: [hit()] }],
    })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    fireEvent.click(await screen.findByText('只看这一类'))
    /* 「消息」两处有:tab 条那一格与行首那颗徽 —— 按 role 取,不按文案取。 */
    const tab = () => [...document.querySelectorAll('[role="radio"]')]
      .find(el => (el.textContent ?? '').trim() === '消息')
    await waitFor(() => expect(tab()?.getAttribute('aria-checked')).toBe('true'))
  })

  it('按「在此会话内搜」→ 片条上多一颗范围片,而且**词留着**', async () => {
    serveRows({ results: [hit()] })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    fireEvent.click(await screen.findByText('在此会话内搜'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeTruthy())
    expect(document.querySelector('[data-filter="scope"]')?.textContent).toContain('那间会话')
    expect((input() as HTMLInputElement).value).toBe('词')
  })

  it('范围片的 × 去掉它 —— 它就是 filters 的可视化,不是第二种状态', async () => {
    serveRows({ results: [hit()] })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    fireEvent.click(await screen.findByText('在此会话内搜'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('去掉这个范围'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeNull())
  })

  it('枢轴「提到它的消息」→ 换到消息那一档 + 种子词是**文件名**', async () => {
    serveRows({
      results: [{
        id: 'f1',
        type: 'file',
        title: '/repo/a/model-registry.ts',
        target: { kind: 'file', payload: { filePath: '/repo/a/model-registry.ts' } },
      }],
    })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    fireEvent.click(await screen.findByText('提到它的消息'))
    await waitFor(() => expect((input() as HTMLInputElement).value).toBe('model-registry.ts'))
    expect(screen.getByText('消息').getAttribute('aria-checked')).toBe('true')
  })

  it('「在此目录内搜」按得动 —— files 自述里有 `dir` 这个 facet', async () => {
    serveRows({
      results: [{
        id: 'f1',
        type: 'file',
        title: '/repo/a/x.ts',
        target: { kind: 'file', payload: { filePath: '/repo/a/x.ts' } },
      }],
    })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    const item = await screen.findByText('在此目录内搜')
    expect(item.closest('button')?.disabled).toBe(false)
  })

  /** 反面:一个不声明 `dir` 的档上它仍然按不动(判据真的是自述,不是「恒真」)。 */
  it('换到一个不认 `dir` 的档,「在此目录内搜」又灰回去', async () => {
    serveRows({
      results: [{
        id: 'f1',
        type: 'file',
        title: '/repo/a/x.ts',
        target: { kind: 'file', payload: { filePath: '/repo/a/x.ts' } },
      }],
    })
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('消息'))
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    const item = await screen.findByText('在此目录内搜')
    expect(item.closest('button')?.disabled).toBe(true)
  })

  it('走过一步之后 ⌘[ 退回去,四格**原样还原**(词 / 档 / 片)', async () => {
    serveRows({ results: [hit()] })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    openRowMenu()
    fireEvent.click(await screen.findByText('在此会话内搜'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('回上一条查询'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeNull())
    expect((input() as HTMLInputElement).value).toBe('词')
  })

  /** 落差 #18:历史条目按 `activeId` 记,不按下标 —— 翻一页下标就全变了。 */
  it('历史记的是**活动项的 id**:回去时那一项还在就回它', async () => {
    serveRows({ results: [hit(), hit({ id: 'r2' })] })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(2))
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    await waitFor(() => expect(rows()[1].getAttribute('aria-selected')).toBe('true'))
    /* 右键会把活动位落到被点的那一行 —— 记进历史的就该是**它**的 id。 */
    fireEvent.contextMenu(rows()[0])
    const activeNow = useSearchStore.getState().selection.id
    expect(activeNow).toBe(rows()[0].getAttribute('data-item-id'))
    fireEvent.click(await screen.findByText('在此会话内搜'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeTruthy())
    /*
     * 历史那一格是 **id 串**,不是下标(落差 #18)—— 翻一页下标就全变了,
     * 而「我刚才停在这一条上」不该跟着页码漂。
     */
    const recorded = useSearchStore.getState().history.entries.map(e => e.activeId)
    expect(recorded).toContain(activeNow)
    expect(typeof activeNow).toBe('string')
  })

  it('前进钮在没走过之前是**禁灰而不消失**', async () => {
    serveRows({ results: [hit()] })
    render(<SearchPanel />)
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

  it('↑ 在**输入框空着且停在第一项**时回上一条查询;有词的时候它只走行', async () => {
    serveRows({ results: [hit(), hit({ id: 'r2' })] })
    render(<SearchPanel />)
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
    serveRows({
      results: [chatHit({
        preview: {
          kind: 'session-overview',
          payload: { sessionId: 's1', title: '一间会话', messageCount: 7, updatedAt: 1, preview: '首条' },
        },
      })],
    })
    render(<SearchPanel />)
    type('词')
    await waitFor(() =>
      expect(document.querySelector('[data-preview-kind="session-overview"]')).toBeTruthy())
    expect(document.querySelector('[data-fact="count"]')?.textContent).toBe('7')
  })

  /** ⑦:预览 error 只画字典句,原话进日志 + `data-preview-error`。 */
  it('lazy 那一种走 `search.preview`;算不出时画**字典句**,原话不上屏', async () => {
    serveRows({ results: [hit()] }, {
      preview: async () => ({ success: false, error: '那条消息不在账本里了' }),
    })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(document.querySelector('[data-preview="error"]')).toBeTruthy())
    const box = document.querySelector('[data-preview="error"]') as HTMLElement
    expect(box.textContent).toBe('预览算不出来')
    expect(box.textContent).not.toContain('那条消息不在账本里了')
    expect(box.getAttribute('data-preview-error')).toBe('那条消息不在账本里了')
  })

  it('后端画得出来时按 kind 从注册表取组件', async () => {
    serveRows({ results: [hit()] }, {
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
    })
    render(<SearchPanel />)
    type('词')
    await waitFor(() =>
      expect(document.querySelector('[data-preview-kind="message-context"]')).toBeTruthy())
    expect(screen.getByText('命中那一条')).toBeTruthy()
    expect(screen.getByText('前一条')).toBeTruthy()
  })

  it('壳画不出这种媒介时画**Row 放大版**,零解释句', async () => {
    serveRows({ results: [hit()] }, {
      preview: async () => ({ success: true, preview: { kind: '外星媒介', payload: {}, title: '一个标题' } }),
    })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(document.querySelector('[data-preview="fallback"]')).toBeTruthy())
    const box = document.querySelector('[data-preview="fallback"]') as HTMLElement
    expect(box.textContent).toContain('一个标题')
    expect(box.textContent).not.toContain('外星媒介')
  })

  /** ⑦:自述里没有 `preview` 那一格的能力 —— **一发请求都不出门**。 */
  it('自述说这一类没有预览 → 零请求,窗里是行的放大版', async () => {
    let asked = 0
    serveRows({
      results: [{
        id: 'p1',
        type: 'prompt',
        title: '周报模板',
        subtitle: '工作 · 周报',
        target: { kind: 'prompt', payload: { actionId: 'insert-prompt:p1', promptId: 'p1' } },
      }],
    }, {
      preview: async () => { asked += 1; return { success: true } },
    })
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('提示词'))
    type('周报')
    await waitFor(() => expect(document.querySelector('[data-preview="none"]')).toBeTruthy())
    expect(document.querySelector('[data-preview="none"]')?.textContent).toContain('周报模板')
    expect(asked).toBe(0)
  })

  it('⌘ 点两条同 kind → compare;点第三条 → batch(基数是请求的一部分)', async () => {
    const modes: string[] = []
    serveRows({ results: [hit(), hit({ id: 'r2' }), hit({ id: 'r3' })] }, {
      preview: async (_items, mode) => {
        modes.push(mode)
        return { success: true }
      },
    })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(rows()[0], { metaKey: true })
    fireEvent.click(rows()[1], { metaKey: true })
    await waitFor(() => expect(modes).toContain('compare'))
    fireEvent.click(rows()[2], { metaKey: true })
    await waitFor(() => expect(modes).toContain('batch'))
  })

  it('⌘ 点**不打开**那一行 —— 带修饰键的点击是「挑」,不带的才是「做」', async () => {
    serveRows({ results: [hit()] })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.click(rows()[0], { metaKey: true })
    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
    expect(rows()[0].getAttribute('data-picked')).toBe('true')
  })
})

describe('落点与读数', () => {
  it('点一条正文命中 = 进会话 + 留一格「落到那条消息」的待办', async () => {
    serveRows({ results: [hit()] })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.click(rows()[0])
    expect(useLocateMessage.getState().request).toMatchObject({ sessionId: 's1', messageId: 'm1' })
  })

  it('缺渲染器的行按下去**如实说一句**,不静默吞掉', async () => {
    serveRows({
      results: [{ id: 'x', type: 'plugin', title: '外星行', target: { kind: '外星形', payload: {} } }],
    })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.click(rows()[0])
    expect(useNotifyStore.getState().items[0].title)
      .toBe(translate('zh', 'search.targetUnavailable', { kind: '外星形' }))
  })

  it('后端给了真 total → 取尽那一刻块尾读数报的是它(不知道 ≠ 0)', async () => {
    serveRows({
      results: [hit({ target: { kind: 'daily', payload: { filePath: '/a.md' } } })],
      total: 42,
    })
    render(<SearchPanel />)
    fireEvent.click(screen.getByText('笔记'))
    type('词')
    await waitFor(() => expect(document.querySelector('[data-readout="end"]')).toBeTruthy())
    expect(document.querySelector('[data-readout="end"]')?.textContent).toContain('42')
  })

  it('放宽过才画「已放宽」那一行', async () => {
    serveRows({ results: [hit()], relaxed: 2 })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(document.querySelector('[data-readout="relaxed"]')).toBeTruthy())
  })

  /**
   * **三级三句**(步⑦ 留账 E-6 第二条)。阶梯在 `core/search/pipeline/plan.ts`:
   * ①严格 ②去相邻 ③至少一半的词 ④任一词。从前一句「按任一词匹配」包打三级 ——
   * 那在只放宽到 ② 的时候说得比实际远。
   */
  it('放宽那句话按级数换 —— 放宽到 ② 时不许说「按任一词」', async () => {
    serveRows({ results: [hit()], relaxed: 1 })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(document.querySelector('[data-readout="relaxed"]')).toBeTruthy())
    expect(document.querySelector('[data-readout="relaxed"]')?.textContent)
      .toBe(translate('zh', 'search.relaxed1'))
    expect(document.querySelector('[data-readout="relaxed"]')?.textContent)
      .not.toBe(translate('zh', 'search.relaxed3'))
  })

  it('没放宽(0 / 缺席)= 那一行不画', async () => {
    serveRows({ results: [hit()], relaxed: 0 })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows().length).toBe(1))
    expect(document.querySelector('[data-readout="relaxed"]')).toBeNull()
  })

  /**
   * **语义召回读数**(步⑦ 留账 E-6 第一条)。`ready` / `off` 不画 —— 页脚是
   * 「此刻有什么不对劲」的地方,不是功能清单。
   */
  it('语义召回:建向量中画一行带真读数;就绪 / 关着一个字不画', async () => {
    resetSearchCatalog()
    serve(() => ({ success: true, results: [] }), {
      status: async () => ({ mode: 'owner', pending: 0, vector: 'embedding', vectorPending: 41 }),
    })
    await ensureSearchCatalog()
    render(<SearchPanel />)
    await waitFor(() => expect(document.querySelector('[data-readout="vector"]')).toBeTruthy())
    expect(document.querySelector('[data-readout="vector"]')?.textContent)
      .toBe(translate('zh', 'search.vectorEmbedding', { pending: 41 }))

    cleanup()
    resetSearchCatalog()
    serve(() => ({ success: true, results: [] }), {
      status: async () => ({ mode: 'owner', pending: 0, vector: 'ready' }),
    })
    await ensureSearchCatalog()
    render(<SearchPanel />)
    await waitFor(() => expect(screen.getByTestId('search-panel')).toBeTruthy())
    expect(document.querySelector('[data-readout="vector"]')).toBeNull()
  })

  /**
   * **占位从自述生成**(步⑦ 留账 E-6 第三条;落差 #51)。写死那串「搜文件、章节、
   * 消息、会话…」上一次说对是在「章节」还是一个档的时候。
   */
  it('输入框占位念的是自述里那几档,不是字典里写死的一串', async () => {
    serveRows({ results: [] })
    render(<SearchPanel />)
    await waitFor(() => expect(screen.getByText('会话')).toBeTruthy())
    const input = screen.getByLabelText(translate('zh', 'search.label')) as HTMLInputElement
    expect(input.placeholder).toBe(translate('zh', 'search.placeholderOf', {
      names: ['会话', '提示词', '笔记', '文件', '消息', '命令'].join(translate('zh', 'search.scopeJoin')),
    }))
    // 从前那句里的「章节」早就不是一个档了 —— 它不许再出现在屏幕上。
    expect(input.placeholder).not.toContain('章节')
  })

  it('索引状态:pending > 0 才画「更新中」;reader 才画「由 … 维护」', async () => {
    resetSearchCatalog()
    serve(() => ({ success: true, results: [] }), {
      status: async () => ({ mode: 'reader', pending: 7, owner: { host: 'other', pid: 1 }, vector: 'off' }),
    })
    await ensureSearchCatalog()
    render(<SearchPanel />)
    await waitFor(() => expect(document.querySelector('[data-readout="index-reader"]')).toBeTruthy())
    expect(document.querySelector('[data-readout="index-pending"]')?.textContent).toContain('7')
    expect(document.querySelector('[data-readout="index-reader"]')?.textContent).toContain('other')
  })

  /** ⑧:索引不可用不再被吞 —— 一句人话,没有重试。 */
  it('索引 `mode: error` → 页脚一句「索引不可用 · 只显示未建索引的结果」', async () => {
    resetSearchCatalog()
    serve(() => ({ success: true, results: [] }), {
      status: async () => ({ mode: 'error', pending: 0, vector: 'off' }),
    })
    await ensureSearchCatalog()
    render(<SearchPanel />)
    await waitFor(() =>
      expect(document.querySelector('[data-readout="index-unavailable"]')).toBeTruthy())
    expect(document.querySelector('[data-readout="index-unavailable"]')?.textContent)
      .toContain('索引不可用')
  })

  it('这一发塌了:上面一行「没搜成」+ 后端原话,**旧结果不清屏**(律②)', async () => {
    let fail = false
    serve(() => {
      if (fail) throw new Error('后端说的那句原话')
      return { success: true, results: [hit()] }
    })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fail = true
    /*
     * **同一把键**再问一次(「重试」那一下的落点 —— 五口里的 `refetch`)。
     * 律②说的正是这一形:错误与旧答案共存,列表一行都不清。
     */
    await refetchSearchListing(useSearchStore.getState().committedKey)
    await waitFor(() => expect(screen.getByText('后端说的那句原话')).toBeTruthy())
    expect(rows()).toHaveLength(1)
  })

  /**
   * **R11:换词在飞的那一段,上一把键的行留在屏上**(律②′)。
   * 列表根挂 `data-stale`(文字降一档),页脚「搜索中…」,**不闪「无结果」**。
   */
  it('换词在飞:旧行留屏 + `data-stale` + 页脚「搜索中…」,不闪「无结果」', async () => {
    let hang = false
    serve(() => (hang
      ? new Promise<SearchResponse>(() => {})
      : { success: true, results: [hit()] }))
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    hang = true
    type('词二')
    await waitFor(() =>
      expect(document.querySelector('[data-testid="search-list"][data-stale]')).toBeTruthy())
    // 旧那一行还在屏上 —— 换词不清屏。
    expect(rows()).toHaveLength(1)
    expect(document.querySelector('[data-readout="searching"]')).toBeTruthy()
    expect(document.querySelector('[data-readout="empty"]')).toBeNull()
  })

  /** 拍点 K(报备修正):首发在飞画的是「搜索中…」,不是「无结果」。 */
  it('首发在飞:列表空、**不画「无结果」**,页脚一行「搜索中…」', async () => {
    serve(() => new Promise<SearchResponse>(() => {}))
    render(<SearchPanel />)
    await waitFor(() => expect(document.querySelector('[data-readout="searching"]')).toBeTruthy())
    expect(document.querySelector('[data-readout="empty"]')).toBeNull()
    expect(rows()).toHaveLength(0)
  })
})

/**
 * **R10:IME 组字期间不接键**。中文输入法选字用的正是 ↑↓ 与 ⏎ ——
 * 组字那一段里把它们当成「走行 / 打开」,用户就打不出字。
 */
describe('R10:IME 组字期间那一下键归输入法', () => {
  it('`isComposing` 的 ↓ 不动活动项,也不被吞', async () => {
    serveRows({ results: [hit(), hit({ id: 'r2' })] })
    render(<SearchPanel />)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(2))
    const before = useSearchStore.getState().selection.id

    const composing = new KeyboardEvent('keydown', {
      key: 'ArrowDown', bubbles: true, cancelable: true,
    })
    Object.defineProperty(composing, 'isComposing', { value: true })
    input().dispatchEvent(composing)
    expect(useSearchStore.getState().selection.id).toBe(before)
    expect(composing.defaultPrevented).toBe(false)

    // 反面:组完字之后那一下照常走行。
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    await waitFor(() => expect(useSearchStore.getState().selection.id).not.toBe(before))
  })
})

describe('面域局部键:⌘[ / ⌘](§4.6 的查询历史)', () => {
  it('实例注入的 keyHandlers 名单 = FOCUS_SCOPES.search.keys 的 action 集合', async () => {
    render(<SearchPanel />)
    await waitFor(() => expect(screen.getByLabelText('搜索')).toBeTruthy())
    const node = focusTree.dump().nodes.find(n => n.scope === 'search')
    expect(node?.keys.slice().sort()).toEqual(
      [...new Set(FOCUS_SCOPES.search.keys?.map(k => k.action) ?? [])].sort(),
    )
  })

  it('那两格真的能走历史 —— 与两颗方向钮落的是同一条路', async () => {
    serveRows({ results: [hit()] })
    render(<><FocusDispatchHarness /><SearchPanel /></>)
    type('词')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.contextMenu(rows()[0])
    fireEvent.click(await screen.findByText('在此会话内搜'))
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeTruthy())

    fireEvent.keyDown(window, { key: '[', metaKey: true })
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeNull())
    fireEvent.keyDown(window, { key: ']', metaKey: true })
    await waitFor(() => expect(document.querySelector('[data-filter="scope"]')).toBeTruthy())
  })
})

/* ── 09-07 事故第二条修:「不挑」那一档不等扫盘型 ──────────────────────── */

/**
 * 真机原样:搜「all」之后文件那一路扎进 18GB 目录永不落地,而整发要收齐所有组
 * 才答 —— 屏幕上**一个结果都没有**。修完之后后端在 `all` 里对那一路当场答
 * `groups[].deferred`,别的块立刻上屏,壳随即自己去问一次那一档。
 */
describe('deferred 块(不挑那一档不等扫盘型)', () => {
  /** `all` 那一发答「files 这次没问」;单类那一发慢慢答。 */
  function serveDeferred(options: { holdFiles?: boolean } = {}): {
    asks: string[]
    releaseFiles: (rows: SearchResult[]) => void
  } {
    const asks: string[] = []
    let release: ((rows: SearchResult[]) => void) | undefined
    serve(async (ask) => {
      asks.push(ask.category)
      if (ask.category === 'files') {
        if (options.holdFiles !== true) {
          return { success: true, results: [hit({ id: 'f1', type: 'file', title: 'note.ts' })] }
        }
        const rows = await new Promise<SearchResult[]>((resolve) => { release = resolve })
        return { success: true, results: rows }
      }
      return {
        success: true,
        results: [chatHit()],
        groups: [
          { capability: 'chats', label: '', results: [chatHit()] },
          { capability: 'files', label: '', results: [], total: 0, deferred: true },
        ],
      }
    })
    return { asks, releaseFiles: rows => release?.(rows) }
  }

  it('会话那一块先上屏,文件那一块只有一条「扫描中…」', async () => {
    const { asks } = serveDeferred({ holdFiles: true })
    render(<SearchPanel />)
    type('note')
    // 别的块**不等它**。
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].getAttribute('data-capability')).toBe('chats')
    const scanning = moreItems().find(el => el.getAttribute('data-block') === 'files')
    expect(scanning?.getAttribute('data-more-state')).toBe('scanning')
    expect(scanning?.textContent).toContain(translate('zh', 'search.scanning'))
    // 壳自己去问了那一档(同词同片同页大小)。
    await waitFor(() => expect(asks).toContain('files'))
  })

  it('那一发落地:只有文件那一块长出行,会话那一块一行不动', async () => {
    serveDeferred()
    render(<SearchPanel />)
    type('note')
    await waitFor(() => expect(rows()).toHaveLength(2))
    const caps = rows().map(el => el.getAttribute('data-capability'))
    expect(caps).toEqual(['chats', 'files'])
    // 「扫描中…」那条项换成了取尽读数(那一发没给游标)。
    expect(moreItems().some(el => el.getAttribute('data-block') === 'files')).toBe(false)
  })

  it('还在扫的时候**不许画「无结果」**(那是一句会自我否定的话)', async () => {
    serve(async (ask) => {
      if (ask.category === 'files') {
        await new Promise<void>(() => undefined)
        return { success: true, results: [] }
      }
      return {
        success: true,
        results: [],
        groups: [{ capability: 'files', label: '', results: [], total: 0, deferred: true }],
      }
    })
    render(<SearchPanel />)
    type('note')
    await waitFor(() => {
      expect(document.querySelector('[data-more-state="scanning"]')).not.toBeNull()
    })
    expect(document.querySelector('[data-readout="empty"]')).toBeNull()
  })

  it('那一发塌了 = 页脚一行「文件没搜成 · 重试」,列表其余不受影响', async () => {
    serve(async (ask) => {
      if (ask.category === 'files') return { success: false, results: [], error: 'rg gone' }
      return {
        success: true,
        results: [chatHit()],
        groups: [
          { capability: 'chats', label: '', results: [chatHit()] },
          { capability: 'files', label: '', results: [], total: 0, deferred: true },
        ],
      }
    })
    render(<SearchPanel />)
    type('note')
    await waitFor(() => {
      expect(document.querySelector('[data-readout="block-errors"]')).not.toBeNull()
    })
    expect(document.querySelector('[data-readout="block-errors"]')?.textContent)
      .toContain(translate('zh', 'search.blockFailed', { name: '文件' }))
    // 原话不上屏(R6 的同一条纪律:块级失败说的是人话)。
    expect(document.body.textContent).not.toContain('rg gone')
    expect(rows()).toHaveLength(1)
  })

  it('只扫到一半:行照画,块尾说「已扫描 N 条 · 未扫完」而不是「共 N 条」', async () => {
    serve(async (ask) => {
      if (ask.category === 'files') {
        return {
          success: true,
          results: [hit({ id: 'f1', type: 'file', title: 'note.ts' })],
          partial: true,
        }
      }
      return {
        success: true,
        results: [],
        groups: [{ capability: 'files', label: '', results: [], total: 0, deferred: true }],
      }
    })
    render(<SearchPanel />)
    type('note')
    await waitFor(() => expect(rows()).toHaveLength(1))
    const readout = document.querySelector('[data-readout="partial"]')
    expect(readout?.textContent).toBe(translate('zh', 'search.partialScan', { shown: 1 }))
    expect(document.querySelector('[data-readout="end"]')).toBeNull()
  })
})
