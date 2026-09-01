import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppShell } from '../../components/AppShell'
import { SearchPanel } from './SearchPanel'
import { useStageStore } from '../../stage/store'
import { useExposeStore } from '../../expose/store'
import { initialStageState } from '../../stage/transitions'
import { useToastHub } from '../../ui/Toast'
import { useNotifyStore } from '../../services/notify-store'
import { CHAPTERS, NOW, SESSIONS, seedSessionsSource } from '../../data/__fixtures__/sessions'
import { toSessionSummary } from '../../expose/projection'
import type { SessionSummary } from '../../expose/types'
import { configureFilesPort } from '../../data/files-port'
import type { FilesPort } from '../../data/files-port'
import { useFilesSource } from '../../data/files-source'
import { translate } from '../../i18n'
import { SEARCH_FIRST_PAGE, SEARCH_PAGE_SIZE } from '../transitions'

/**
 * 文件侧的素材 = `files.list` 交回来的那份 entries(D5 接真数据之后)。
 * 用例里直接种进数据源:这一批验的是**面板怎么用这批命中**,
 * 取数本身在 data/files-source.test.ts 里验。
 */
const FILE_QUERY = 'provider'
const FILE_HITS = [
  { path: '/repo/packages/onething-runtime/src/providers/model-registry.ts', type: 'file' as const },
  { path: '/repo/docs/design/provider-oop-2026-08.md', type: 'file' as const },
]

/**
 * 面板的键盘住在面板自己身上,所以这里全部走真组件、真按键 ——
 * 不去戳 keymap 注册表(那是「面板关着时也要能触发」的那一类,与这里无关)。
 */
beforeEach(() => {
  useStageStore.setState({ ...initialStageState, locale: 'zh' })
  // 两侧都吃真数据源:会话侧 D1,文件侧 D5(../data.ts 那张 mock 表已随批退役)。
  seedSessionsSource({ chapters: CHAPTERS })
  useFilesSource.setState({
    searchStatus: 'ready',
    searchHits: FILE_HITS,
    searchQuery: FILE_QUERY,
    // 两条命中 < 要了这么多条 = 文件侧**取尽了**(判据见 transitions 的「分页」一节)。
    searchLimit: SEARCH_FIRST_PAGE,
    searchError: undefined,
  })
  useExposeStore.setState({ view: { mode: 'overview' }, query: '' })
  useToastHub.setState({ toasts: [], folded: 0 })
  useNotifyStore.setState({ items: [] })
})

const input = () => screen.getByLabelText('搜索')
const type = (value: string) => fireEvent.change(input(), { target: { value } })
const press = (key: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(input(), { key, ...init })
const options = () => screen.getAllByRole('option')
const selected = () => options().find((el) => el.getAttribute('aria-selected') === 'true')

/** ⌘P 的语义(08-29 拍板):它开的是 Dock 上那块「检索」瓦,与点图标是同一件事。 */
describe('⌘P = 开关检索面板', () => {
  const cmdP = () => fireEvent.keyDown(window, { key: 'p', metaKey: true })

  it('按一下:检索面板按打开方式开出来,输入框当场拿到焦点', () => {
    render(<AppShell />)
    cmdP()
    // 打开统一是浮窗(08-30 拍板)
    expect(useStageStore.getState().placements.search).toEqual({ kind: 'float' })
    expect(document.activeElement).toBe(input())
  })

  it('再按一下:收回 Dock,总览那块面一直没被叫起来', async () => {
    render(<AppShell />)
    cmdP()
    cmdP()
    expect('search' in useStageStore.getState().placements).toBe(false)
    expect('sessions' in useStageStore.getState().placements).toBe(false)
    // 形态当场就变了,DOM 还要多活一帧走出场动画(StageOverlay 的 held),所以这条要等。
    await waitFor(() => expect(screen.queryByLabelText('搜索')).toBeNull())
  })
})

describe('搜索行:scope 分段器', () => {
  it('Tab 轮转:所有 → 会话 → 文件 → 所有', () => {
    render(<SearchPanel />)
    expect(screen.getByRole('radio', { name: '所有' }).getAttribute('aria-checked')).toBe('true')
    press('Tab')
    expect(screen.getByRole('radio', { name: '会话' }).getAttribute('aria-checked')).toBe('true')
    press('Tab')
    expect(screen.getByRole('radio', { name: '文件' }).getAttribute('aria-checked')).toBe('true')
    press('Tab')
    expect(screen.getByRole('radio', { name: '所有' }).getAttribute('aria-checked')).toBe('true')
  })

  it('⇧Tab 反向轮转', () => {
    render(<SearchPanel />)
    press('Tab', { shiftKey: true })
    expect(screen.getByRole('radio', { name: '文件' }).getAttribute('aria-checked')).toBe('true')
    press('Tab', { shiftKey: true })
    expect(screen.getByRole('radio', { name: '会话' }).getAttribute('aria-checked')).toBe('true')
  })

  it('换范围会换掉这张列表:文件档一行会话都没有', () => {
    render(<SearchPanel />)
    type(FILE_QUERY)
    press('Tab')
    press('Tab')
    // 徽上只剩文件类型,「会话」「消息」两种徽一颗不剩。
    expect(screen.queryByText('消息')).toBeNull()
    expect(options().length).toBeGreaterThan(0)
  })
})

describe('命中列表:走行与跳转', () => {
  it('↑↓ 走行,选中停在两端不回卷', () => {
    render(<SearchPanel />)
    expect(selected()).toBe(options()[0])
    press('ArrowUp')
    expect(selected()).toBe(options()[0])
    press('ArrowDown')
    expect(selected()).toBe(options()[1])
    press('ArrowUp')
    expect(selected()).toBe(options()[0])
  })

  /*
   * hover ≠ active(09-01 用户裁定,批 4 迁 `ui/a11y/list-selection` 时补的守卫)。
   * 走行原语那一侧已有一份同名反证(ui/__tests__/list-selection.test.tsx),
   * 消费面这一份守的是「这块面自己没有再挂一条 mouseenter 把 active 拽走」——
   * 病根从来不在原语里,在各面顺手写的那一句。↵ 之后必须还落在键盘位上。
   */
  it('mouseenter 不改选中位:鼠标停在别的行上,↵ 落的仍是键盘位那一行', () => {
    useStageStore.setState({ placements: { search: { kind: 'stage' } } })
    render(<SearchPanel />)
    press('ArrowDown')
    expect(selected()).toBe(options()[1])

    fireEvent.mouseEnter(options()[0])
    fireEvent.mouseOver(options()[0])
    expect(selected()).toBe(options()[1])

    press('Enter')
    expect(useExposeStore.getState().currentSessionId).toBe(SESSIONS[1].id)
  })

  it('⏎ 进会话:换当前会话并把这块面板收回 Dock', () => {
    useStageStore.setState({ placements: { search: { kind: 'stage' } } })
    render(<SearchPanel />)
    type(SESSIONS[0].title)
    press('Enter')
    expect(useExposeStore.getState().currentSessionId).toBe(SESSIONS[0].id)
    expect('search' in useStageStore.getState().placements).toBe(false)
  })

  it('点一行 = 按 ⏎', () => {
    useStageStore.setState({ placements: { search: { kind: 'stage' } } })
    render(<SearchPanel />)
    type(SESSIONS[1].title)
    fireEvent.click(options()[0])
    expect(useExposeStore.getState().currentSessionId).toBe(SESSIONS[1].id)
    expect('search' in useStageStore.getState().placements).toBe(false)
  })

  /*
   * 08-30 通知系统批:这一句话从散装 toast 改走 services/notify 的单入口。
   * 断言因此同时看两处 —— 屏幕上照样弹一条(级别 info,与从前默认那档同义),
   * 而且它现在**进了通知中心存档**:过后想不起刚才报的是哪个文件时还翻得到。
   */
  it('文件行:壳里还没有真打开能力,所以报出落点并同样收回 Dock', () => {
    useStageStore.setState({ placements: { search: { kind: 'stage' } } })
    render(<SearchPanel />)
    type(FILE_QUERY)
    press('Tab')
    press('Tab')
    press('Enter')
    /*
     * D5:落点是**整条路径**,不再是「文件名:行号」—— 真实产地
     * (`files.list` 按名字找文件)给不出行号,补一个 `:1` 就是假装它说过。
     */
    expect(useToastHub.getState().toasts.map((x) => x.title)).toEqual([
      `已打开 ${FILE_HITS[0].path}`,
    ])
    expect(useNotifyStore.getState().items.map((x) => [x.level, x.source, x.title])).toEqual([
      ['info', 'search.open', `已打开 ${FILE_HITS[0].path}`],
    ])
    expect('search' in useStageStore.getState().placements).toBe(false)
  })
})

describe('两种空', () => {
  /*
   * 09-01:空词是**浏览态**(列全部会话),不是「没找到」。SESSIONS 这批夹具比
   * 首屏窗口短,所以屏幕上的行数 = 会话总数;超量与翻页在下面「浏览态分页」那一组里验。
   */
  it('词为空 = 浏览全部会话(不是「没找到」),清掉词就回到它', () => {
    render(<SearchPanel />)
    const browsed = options().length
    expect(browsed).toBe(SESSIONS.length)
    type(FILE_QUERY)
    expect(options().length).not.toBe(browsed)
    type('')
    expect(options().length).toBe(browsed)
    expect(screen.queryByText('无结果')).toBeNull()
  })

  it('搜不到就是居中一行灰字', () => {
    render(<SearchPanel />)
    type('zzzzzz')
    expect(screen.getByText('无结果')).toBeTruthy()
    expect(screen.queryAllByRole('option').length).toBe(0)
  })

  /*
   * D5 新增的三条,全部钉「文件侧换真」之后的诚实口径。
   */
  it('去抖窗口里不闪上一个词的结果 —— 手上那批命中对不上此刻的词就当作还没有', () => {
    render(<SearchPanel />)
    // 数据源里躺着 FILE_QUERY 的结果,而此刻的词是别的:一行文件都不该出。
    type('zzzzzz')
    expect(screen.queryAllByRole('option').length).toBe(0)
  })

  it('空词 + 只看文件 = 「要先输入关键词」,不是「无结果」', () => {
    render(<SearchPanel />)
    press('Tab')
    press('Tab')
    expect(screen.getByText('文件要先输入关键词')).toBeTruthy()
    expect(screen.queryByText('无结果')).toBeNull()
  })

  it('文件检索失败与「没搜到」是两件事 —— 会话侧照常有结果时也要看得见', () => {
    useFilesSource.setState({
      searchStatus: 'error',
      searchHits: [],
      searchQuery: FILE_QUERY,
      searchError: 'File search must stay inside the workspace sandbox root.',
    })
    render(<SearchPanel />)
    type(FILE_QUERY)
    expect(screen.getByText('文件没搜成')).toBeTruthy()
    expect(
      screen.getByText('File search must stay inside the workspace sandbox root.'),
    ).toBeTruthy()
  })
})

/**
 * 分页:列表**底部那条 item**,不是一颗悬浮按钮。
 *
 * 后端只有 limit 没有游标(`@shared/ipc/files.ts` 的 `FilesListRequest`),
 * 所以「加载更多」= 带一个更大的 limit 从头重查;取尽判据只能是
 * **回来的条数 < 要的条数**。这一组用例钉的正是这条判据在屏幕上的四种样子。
 *
 * 断言一律跟着常量走(SEARCH_FIRST_PAGE / SEARCH_PAGE_SIZE),不写死数字 ——
 * 改档位不该顺带改一堆用例。
 */
/** 一次给出 n 条**标题里都带那个词**的会话:会话侧整表在手,分页在那一侧是纯窗口。 */
const manySessions = (n: number): SessionSummary[] =>
  Array.from({ length: n }, (_, i) =>
    toSessionSummary({
      id: `pg-${i}`,
      name: `alpha beta ${i}`,
      createdAt: NOW - i * 1000,
      updatedAt: NOW - i * 1000,
    }),
  )

describe('分页:底部那条 item', () => {

  /** 比首屏多几条,第二页正好装得下 —— 于是「取尽」在第二页发生。 */
  const TOTAL = SEARCH_FIRST_PAGE + 6

  const rows = () => options().filter((el) => el.getAttribute('data-row') !== 'more')
  const moreItem = () => screen.queryByTestId('search-more')
  const zh = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
    translate('zh', key, vars)

  beforeEach(() => {
    const sessions = manySessions(TOTAL)
    /*
     * 章节缓存全部预置成空表:面板会为命中的前几条会话按需补拉章节,那是另一件
     * 事(D1 的按需取数),在这一组里只会制造与分页无关的异步噪音。
     * `sessionId in chapters` 就是数据源自己的「已经有了」判据。
     */
    seedSessionsSource({
      sessions,
      chapters: Object.fromEntries(sessions.map((session) => [session.id, []])),
    })
    // 这一组只看会话侧,所以文件侧一条都不给(而且明确说它取尽了)。
    useFilesSource.setState({
      searchStatus: 'ready',
      searchHits: [],
      searchQuery: 'alpha',
      searchLimit: SEARCH_FIRST_PAGE,
      searchError: undefined,
    })
  })

  it('首屏给 SEARCH_FIRST_PAGE 条,点一下底部那条 item 就追加下一页', () => {
    render(<SearchPanel />)
    type('alpha')
    press('Tab') // 只看会话:文件侧不参与,总数当场就是知道的
    expect(rows().length).toBe(SEARCH_FIRST_PAGE)
    expect(moreItem()?.textContent).toBe(
      zh('search.loadMoreCount', { shown: SEARCH_FIRST_PAGE, total: TOTAL }),
    )

    fireEvent.click(moreItem() as HTMLElement)
    // 第二页的窗口是 首屏 + 每页,够装下全部 —— 于是这一次追加把剩下的都放了出来。
    expect(SEARCH_FIRST_PAGE + SEARCH_PAGE_SIZE).toBeGreaterThanOrEqual(TOTAL)
    expect(rows().length).toBe(TOTAL)
  })

  it('取尽那一刻:「加载更多」换成读数,而且不再是能按的 item', () => {
    render(<SearchPanel />)
    type('alpha')
    press('Tab')
    fireEvent.click(moreItem() as HTMLElement)

    expect(moreItem()).toBeNull()
    expect(screen.getByText(zh('search.allShown', { total: TOTAL }))).toBeTruthy()
    // 读数不是选项:它进不了 ↑↓ 的轮转序列。
    expect(options().length).toBe(TOTAL)
  })

  it('换检索词 = 换了一张列表:分页回到第一页', () => {
    render(<SearchPanel />)
    type('alpha')
    press('Tab')
    fireEvent.click(moreItem() as HTMLElement)
    expect(rows().length).toBe(TOTAL)

    // 同一批会话,另一个同样全中的词 —— 变的只有「词」这一件事。
    type('beta')
    expect(rows().length).toBe(SEARCH_FIRST_PAGE)
    expect(moreItem()?.textContent).toBe(
      zh('search.loadMoreCount', { shown: SEARCH_FIRST_PAGE, total: TOTAL }),
    )
  })

  it('⏎ 走到末位就是这条 item:回车 = 点它', () => {
    render(<SearchPanel />)
    type('alpha')
    press('Tab')
    for (let i = 0; i < SEARCH_FIRST_PAGE; i++) press('ArrowDown')
    expect(moreItem()?.getAttribute('aria-selected')).toBe('true')

    const before = useExposeStore.getState().currentSessionId
    press('Enter')
    expect(rows().length).toBe(TOTAL)
    // 会话一条都没进(回车按的是「加载更多」,不是某一行)。
    expect(useExposeStore.getState().currentSessionId).toBe(before)
  })

  describe('加载失败', () => {
    let calls = 0
    const failingPort: FilesPort = {
      ready: async () => undefined,
      listDirectory: async () => ({ success: false, error: 'not used' }),
      stat: async () => ({ success: false, error: 'not used' }),
      readContent: async () => ({ success: false, error: 'not used' }),
      saveContent: async () => ({ success: true }),
      reveal: async () => ({ success: false, error: 'not used' }),
      list: async () => {
        calls += 1
        return { success: false, files: [], error: 'boom' }
      },
    }

    beforeEach(() => {
      calls = 0
      configureFilesPort(failingPort)
      // 文件侧要参与,所以这一组不按 Tab —— scope 停在「所有」。
      useFilesSource.setState({
        searchStatus: 'ready',
        searchHits: [],
        searchQuery: 'alpha',
        searchLimit: SEARCH_FIRST_PAGE,
        searchError: undefined,
      })
    })

    afterEach(() => {
      // 还原成 test/setup.ts 里那一份「什么都不回」的默认假端口。
      configureFilesPort({
        ready: async () => undefined,
        listDirectory: async () => ({ success: false, error: 'no files port in tests' }),
        stat: async () => ({ success: false, error: 'no files port in tests' }),
        readContent: async () => ({ success: false, error: 'no files port in tests' }),
        saveContent: async () => ({ success: false, error: 'no files port in tests' }),
        reveal: async () => ({ success: false, error: 'no files port in tests' }),
        list: async () => ({ success: true, files: [], entries: [] }),
      })
    })

    it('这条 item 自己说「没加载成」,再点一次就重试', async () => {
      render(<SearchPanel />)
      type('alpha')
      fireEvent.click(moreItem() as HTMLElement)

      await waitFor(() =>
        expect(moreItem()?.textContent).toBe(zh('search.loadFailed')),
      )
      const before = calls

      fireEvent.click(moreItem() as HTMLElement)
      await waitFor(() => expect(calls).toBe(before + 1))
    })
  })
})

/**
 * 空词 = **浏览态**(09-01 用户裁定)。用户原话:「我要能够在这里面看到所有的条数,
 * 所有的记录,要能够翻页」。从前这里恒定 8 条、没有读数、没有下一页。
 *
 * 这一组与上面那组共用**同一套机件**(pageWindow / moreState / 底部那条 item),
 * 所以它验的不是「另一条分页路」,而是「那条路在空词下也真的通」。
 */
describe('浏览态(空词):看得到全部、看得到总数、翻得了页', () => {
  const rows = () => screen.getAllByRole('option').filter((el) => el.getAttribute('data-row') !== 'more')
  const moreItem = () => screen.queryByTestId('search-more')
  const zh = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
    translate('zh', key, vars)

  /** 超量:500 条会话。这是四轴第 4 条(状态完备性)里的「数据 100×」那一格。 */
  const BULK = 500

  it('会话比首屏多:首屏只画一页,底下如实说「已显示 20 / 共 500」', () => {
    seedSessionsSource({ sessions: manySessions(BULK) })
    render(<SearchPanel />)
    // 削量:500 条不会一次性铺进 DOM。
    expect(rows().length).toBe(SEARCH_FIRST_PAGE)
    expect(moreItem()?.textContent).toBe(
      zh('search.loadMoreCount', { shown: SEARCH_FIRST_PAGE, total: BULK }),
    )
  })

  it('翻页:点一下就多一页,读数跟着走(不发任何请求 —— 会话侧整表在手)', () => {
    seedSessionsSource({ sessions: manySessions(BULK) })
    render(<SearchPanel />)
    fireEvent.click(moreItem() as HTMLElement)
    expect(rows().length).toBe(SEARCH_FIRST_PAGE + SEARCH_PAGE_SIZE)
    expect(moreItem()?.textContent).toBe(
      zh('search.loadMoreCount', {
        shown: SEARCH_FIRST_PAGE + SEARCH_PAGE_SIZE,
        total: BULK,
      }),
    )
  })

  it('取尽那一刻换成读数「共 N 条 · 已全部显示」,而且它不进 ↑↓ 轮转', () => {
    const total = SEARCH_FIRST_PAGE + 3
    seedSessionsSource({ sessions: manySessions(total) })
    render(<SearchPanel />)
    fireEvent.click(moreItem() as HTMLElement)
    expect(rows().length).toBe(total)
    expect(moreItem()).toBeNull()
    expect(screen.getByText(zh('search.allShown', { total }))).toBeTruthy()
    expect(screen.getAllByRole('option').length).toBe(total)
  })

  it('会话装得下一页时:第一屏就有读数(不必翻页才配知道有几条)', () => {
    render(<SearchPanel />) // 夹具那 9 条,一页装得下
    expect(moreItem()).toBeNull()
    expect(screen.getByText(zh('search.allShown', { total: SESSIONS.length }))).toBeTruthy()
  })

  /*
   * 回顶:翻到第三页之后开始打字,列表换了主语 —— 页码回第一页、选中回第一行。
   * (这条与搜索态那条「换词回第一页」是同一条纪律的另一半:浏览 → 搜索也算换列表。)
   */
  it('翻过页之后开始搜:回到第一页,选中回第一行', () => {
    seedSessionsSource({ sessions: manySessions(BULK) })
    render(<SearchPanel />)
    fireEvent.click(moreItem() as HTMLElement)
    fireEvent.click(moreItem() as HTMLElement)
    expect(rows().length).toBe(SEARCH_FIRST_PAGE + 2 * SEARCH_PAGE_SIZE)

    type('alpha')
    expect(rows().length).toBe(SEARCH_FIRST_PAGE)
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true')
  })

  it('清掉词回浏览态,也回到第一页', () => {
    seedSessionsSource({ sessions: manySessions(BULK) })
    render(<SearchPanel />)
    fireEvent.click(moreItem() as HTMLElement)
    type('alpha')
    type('')
    expect(rows().length).toBe(SEARCH_FIRST_PAGE)
    expect(moreItem()?.textContent).toBe(
      zh('search.loadMoreCount', { shown: SEARCH_FIRST_PAGE, total: BULK }),
    )
  })

  /*
   * ── 三档各自成立 ────────────────────────────────────────────────────────
   * 「所有」与「会话」两档在浏览态下是**同一张表**(浏览态的行只可能来自会话侧),
   * 所以它们逐条相同不是巧合,是定义 —— 这一条钉的是「换档不会把会话档变成半张表」。
   * 文件档是第三种:它没有产地,所以它如实说出来。三种都不许静默。
   */
  it('「所有」与「会话」两档在浏览态下逐条相同,都是全量', () => {
    seedSessionsSource({ sessions: manySessions(BULK) })
    render(<SearchPanel />)
    const all = rows().map((el) => el.textContent)
    expect(all.length).toBe(SEARCH_FIRST_PAGE)
    const allTail = moreItem()?.textContent

    press('Tab') // 所有 → 会话
    expect(rows().map((el) => el.textContent)).toEqual(all)
    expect(moreItem()?.textContent).toBe(allTail)
    expect(allTail).toBe(zh('search.loadMoreCount', { shown: SEARCH_FIRST_PAGE, total: BULK }))
  })

  it('「会话」档自己也翻得了页', () => {
    seedSessionsSource({ sessions: manySessions(BULK) })
    render(<SearchPanel />)
    press('Tab')
    fireEvent.click(moreItem() as HTMLElement)
    expect(rows().length).toBe(SEARCH_FIRST_PAGE + SEARCH_PAGE_SIZE)
  })

  /*
   * 文件档的空词**照旧**没有产地(D5 的诚实缺口,09-01 复核保留):
   * 会话侧能从 8 条放开到全部是因为它有全量产地,文件侧没有。
   */
  it('文件档的空词仍然说「要先输入关键词」—— 没有产地就不伪造一张表', () => {
    render(<SearchPanel />)
    press('Tab')
    press('Tab')
    expect(screen.getByText('文件要先输入关键词')).toBeTruthy()
    expect(screen.queryByTestId('search-more')).toBeNull()
  })
})

/**
 * 行首那颗徽:**词表是数据,不是一张能枚举完的表**(09-01 报障 NOTEBOOK 撑破边框)。
 *
 * 两种来自字典(会话 / 消息),第三种来自路径 —— 扩展名大写,没有扩展名就是整个
 * 文件名大写(`fileExt`)。所以这一组不去枚举「现有词表」当断言,它验的是:
 * 无论那颗徽上是几个字,**屏幕上都完整画出来**(没有被一个写死的宽度切掉)。
 * 真正的几何(内容宽 ≤ 胶囊内容盒宽)要真机才量得到,在 scripts/gate-search.mjs 里。
 */
describe('行首徽:长词不许被切', () => {
  /** 见过的与想得到的:四字符档、八字符的 NOTEBOOK、以及一个离谱的长名。 */
  const BADGE_CASES = [
    { path: '/repo/a/readme.md', word: 'MD' },
    { path: '/repo/a/index.ts', word: 'TS' },
    { path: '/repo/a/data.json', word: 'JSON' },
    { path: '/home/me/data/note/notebook', word: 'NOTEBOOK' },
    { path: '/repo/Makefile', word: 'MAKEFILE' },
    { path: '/repo/a/x.stylesheet', word: 'STYLESHEET' },
  ]

  it('每一种徽都完整画出来(含八字符的 NOTEBOOK)', () => {
    useFilesSource.setState({
      searchStatus: 'ready',
      searchHits: BADGE_CASES.map((c) => ({ path: c.path, type: 'file' as const })),
      searchQuery: 'a',
      searchLimit: SEARCH_FIRST_PAGE,
      searchError: undefined,
    })
    render(<SearchPanel />)
    type('a')
    press('Tab')
    press('Tab')
    for (const { word } of BADGE_CASES) {
      expect(screen.getByText(word), `徽「${word}」不在屏幕上`).toBeTruthy()
    }
  })

  it('字典侧那两种同样是完整的词(zh:会话 / 消息)', () => {
    render(<SearchPanel />)
    // 浏览态全是会话行,徽上就是「会话」两个字。
    expect(screen.getAllByText('会话').length).toBeGreaterThan(0)
  })
})
