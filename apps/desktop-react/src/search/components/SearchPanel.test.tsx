import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppShell } from '../../components/AppShell'
import { SearchPanel } from './SearchPanel'
import { useStageStore } from '../../stage/store'
import { useExposeStore } from '../../expose/store'
import { initialStageState } from '../../stage/transitions'
import { useToastHub } from '../../ui/Toast'
import { useNotifyStore } from '../../services/notify-store'
import { CHAPTERS, SESSIONS, seedSessionsSource } from '../../data/__fixtures__/sessions'
import { useFilesSource } from '../../data/files-source'
import { RECENT_LIMIT } from '../transitions'

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
  it('词为空 = 最近(不是「没找到」),清掉词就回到它', () => {
    render(<SearchPanel />)
    expect(options().length).toBe(RECENT_LIMIT)
    type(FILE_QUERY)
    expect(options().length).not.toBe(RECENT_LIMIT)
    type('')
    expect(options().length).toBe(RECENT_LIMIT)
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
