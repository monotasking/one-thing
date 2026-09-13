import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createFileToken } from '@onething/runtime/prompts/prompt-references'
import type { FilesListRequest } from '@shared/ipc/files'
import { Composer } from './Composer'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { composerStoreFor, resetComposerStore } from '../store'
import type { ComposerState } from '../types'
/*
 * `drawerKind` 的来源那半边 09-12 从两个**种类名**(`'files' | 'commands'`)收成了
 * 「哪个触发字符」—— 下面两条断言因此换了形,说的还是同一句话:「`@` 那一档开着」。
 * 这是这一单里**唯一**动过的既有断言(其余全是调用形)。
 */
import { pickDrawer } from '../types'
import { composerDraftKeys, readComposerDraft } from '../drafts'
import { configureComposerSink } from '../sink'
import { ASK_DEMO_SPEC } from '../data'
import { useStageStore } from '../../stage/store'
import { useChatSource } from '../../data/chat-source'
import { useCommandsSource } from '../../data/commands-source'
import { configureCommandsPort } from '../../data/commands-port'
import { configureSkillsPort } from '../../data/skills-port'
import { useSkillsSource } from '../../data/skills-source'
import {
  FILE_MENTION_DEBOUNCE_MS,
  useFileMentionsSource,
} from '../../data/file-mentions-source'
import { configureFilesPort } from '../../data/files-port'
import { configureProviderSettingsPort } from '../../data/provider-settings-port'
import { fakeProviderPort } from '../../providers/__tests__/fake-port'
import { useProviderSettings } from '../../providers/store'
import type { OpenRouterModel } from '@shared/ipc/providers'
import { prefsQuery, providersQuery, useModelsSource } from '../../data/models-source'
import { configureModelsPort } from '../../data/models-port'
import { catalogQuery } from '../../providers/catalog-query'
import { openRouterModel, providerModelPrefs } from '../../data/__fixtures__/models'

/**
 * D3 起 composer 不再自己攒一条假队列 —— 它把话**交给 sink**(见 composer/sink.ts)。
 * 所以「到底交出去了什么」在这一层就是断言这只假 sink 收到了什么:形态机一条没变,
 * 换的只是收件人从一个数组变成了一个接口。
 */
const handed: ({ kind: 'text'; text: string; attachments: number } | { kind: 'notice'; notice: string })[] = []

/** 交给 sink 的「停一轮」有几次。忙态是**真 store 的那一格**,不另造一个假的。 */
let aborts = 0

/**
 * **每一次出站动作交给了哪条会话**(W5-c-2)。上面那个 `handed` 记的是「交了什么」,
 * 这一格记的是「交给谁」—— 路线 A 之后屏幕上可以有两块面板,收件人不再是一句
 * 说得清的投影,所以它是一件要单独钉的事实。
 */
const handedTo: string[] = []

/**
 * 假 sink 眼里「有没有当前会话」—— 首开草稿态就是这一格为 false:
 * 真实现里 `send` 正是在没有当前会话时返回 false(chat-source 的那句 `if (!sessionId)`)。
 */
let hasSession = true
/** 「惰性建会话」被叫了几次。首开那条路的全部信用都在这个数上:恰好一次。 */
let starts = 0
/** 那一发怎么答。默认当场给一条新会话;要验「在飞」的用例自己换成一只挂着的 promise。 */
let answerStart: () => Promise<string | undefined> = async () => 'created-1'

/** `@` 候选那条口收到过哪几发请求(去抖验的就是这个数)。 */
const fileAsks: FilesListRequest[] = []
/** 假的工作区:两个文件,顺序即后端给的顺序(这一层一个字都不重排)。 */
const REPO_FILES = ['/repo/src/model-capability.ts', '/repo/src/codex.ts']

/**
 * 组件层只钉「谁在场、谁让位、键盘归谁」—— 判断本身在 transitions.test.ts。
 * 抽屉纪律(一个槽、后来者顶替、Esc 收)与 ask 形态的进出是这一层的主戏。
 */
beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetComposerStore()
  handed.length = 0
  handedTo.length = 0
  aborts = 0
  hasSession = true
  starts = 0
  answerStart = async () => 'created-1'
  configureComposerSink({
    send: (text, attachments, sessionId) => {
      // 没有当前会话就交不出去 —— 与真实现同判据(见 sink.ts 上的 send 注释)。
      if (!hasSession) return false
      handed.push({ kind: 'text', text, attachments })
      handedTo.push(sessionId)
      return true
    },
    notice: (notice) => void handed.push({ kind: 'notice', notice }),
    abort: () => void (aborts += 1),
    startSession: async () => {
      starts += 1
      const id = await answerStart()
      // 建成了 = 从这一刻起有当前会话,后面那次 send 才交得出去。
      if (id) hasSession = true
      return id
    },
  })
  useChatSource.setState({ activeMessageId: undefined })

  /*
   * `@` 候选走真数据源(D3 波二),所以这里换的是**端口**而不是候选表:
   * 「词怎么传、cwd 怎么定、一行怎么念」归 data/file-mentions-source.test.ts,
   * 这一层只验编排 —— 什么时候发、发几次、选中之后草稿里留下什么。
   */
  fileAsks.length = 0
  useFileMentionsSource.getState().reset()
  configureFilesPort({
    ready: async () => undefined,
    listDirectory: async () => ({ success: false, error: 'not used here' }),
    stat: async () => ({ success: false, error: 'not used here' }),
    readContent: async () => ({ success: false, error: 'not used here' }),
    saveContent: async () => ({ success: true }),
    reveal: async () => ({ success: false, error: 'not used here' }),
    list: async (request) => {
      fileAsks.push(request)
      return {
        success: true,
        files: REPO_FILES,
        entries: REPO_FILES.map((path) => ({ path, type: 'file' as const })),
      }
    },
  })
  // 命令表:内置那七条是编译期常量(不经端口),插件那一半用 setup 里的空表。
  useCommandsSource.getState().reset()
  /*
   * 模型侧:直接把答案**打进那三格 query**,不去动端口 —— 这一层要验的是
   * 「谁在场」,取数(两道闸、懒加载、上行三态)归 data/models-source.test.ts。
   * `patch` 是 kernel 交出来的就地补丁口,不绕过任何东西(与 MeterCard.test 同一手)。
   *
   * 目录那一格**已经拉好**:抽屉一开就不会再去拉一次(懒加载那条路归
   * data/models-source.test.ts 验)。这里要的是一份静止的现场。
   * 没有当前会话,所以这里选中的模型落进 `pending`(草稿态那一格)。
   */
  useModelsSource.getState().reset()
  catalogQuery.reset()
  providersQuery.patch([{ id: 'xai', name: 'xAI' }])
  prefsQuery.get('default').patch({
    prefs: {
      defaultProvider: '',
      configs: { xai: providerModelPrefs({ selectedModels: ['grok-4'] }) },
    },
    custom: [],
  })
  catalogQuery.get('xai').patch([openRouterModel('grok-4', 500_000)])
})

afterEach(() => {
  vi.useRealTimers()
  configureComposerSink(undefined)
  configureFilesPort(undefined)
  useFileMentionsSource.getState().reset()
  useCommandsSource.getState().reset()
  // 包在 act 里:vitest 的 afterEach 后进先出,这一钩比 RTL 的卸载先跑,
  // 那时组件还挂着 —— 一次 store 归零就是一次 act 之外的重渲染。
  act(() => {
    useModelsSource.getState().reset()
    // 目录那一族有自己的家(providers/catalog-query.ts),models-source 的 reset
    // 不收它 —— 两个 reset 收同一格就是两个主人。所以用例自己收。
    catalogQuery.reset()
  })
  // 响应链是模块级单例(同 store):一份用例留下的作用域不该被下一份看见。
  focusTree.reset()
  rendered = undefined
  shown = ''
})

/**
 * **这块面板此刻对着哪条会话**(W5-c:`Composer` 收 `sessionId` prop,store 按它
 * 分家)。`renderComposer` / `switchTo` 记在这里,下面两口读它 —— 于是这一族
 * 用例里那八十来处 `state()` 一个字都不必改:它们问的一直是「屏幕上这块面板
 * 此刻那一份状态」,只是那句话从前恰好只有一个答案。
 */
let shown = ''
const state = () => composerStoreFor(shown).getState()
const setState = (partial: Partial<ComposerState>) => composerStoreFor(shown).setState(partial)
/**
 * **输入面板 + 那一格派发器**(09-03 R2)。
 *
 * Esc 三层与 ask 的 ← → 从前挂在一条 window keydown 上,单独渲染这块面按键就会响;
 * R2 之后它们是**作用域声明**(`onEscape` / 作用域根上的行内结构键),真正听键盘的
 * 只有 `focus/dispatch.ts` 那一个,而它挂在外壳上。所以这一族用例要补两样才是
 * 「一台真机器」:①那个派发器;②**这块面在活动路径上** —— 路由问的是
 * 「composer 是不是当前」,不是「这一下按键经不经过它的根」。
 */
/**
 * 这块面板挂在哪一格上。真机上是内容层那一格的 refId(`session:<key>`),
 * 用例只需要一个**稳定且各会话不同**的形状 —— 它是 `FocusScope` 的 `owner`,
 * 「切标签 → 焦点进这一格自己的输入面板」靠的正是它(见 `workbench/focus-into`)。
 */
const ownerOf = (sessionId: string) => `session:${sessionId || 'new'}`

/** 最近一次渲染交出来的句柄,`switchTo` 拿它换 prop。 */
let rendered: ReturnType<typeof render> | undefined

const tree = (sessionId: string) => (
  <>
    <FocusDispatchHarness />
    <Composer sessionId={sessionId} owner={ownerOf(sessionId)} />
  </>
)

function renderComposer(sessionId = '') {
  shown = sessionId
  const view = render(tree(sessionId))
  rendered = view
  act(() => {
    focusTree.activateScope('composer')
  })
  return view
}

/**
 * **换一条会话**。真机上那是「这一格的 refId 换了 → 这一格重挂」(内容层按 refId
 * 分格);用例里换的是 prop,走的是 `Composer` 那两只 layout effect 的同一条路
 * —— 先把旧那份稿存下来,再把新那份铺上去。
 */
function switchTo(id: string): void {
  shown = id
  act(() => void rendered!.rerender(tree(id)))
}

/** 输入面板那一格作用域的根。ask 的 ← → 是**行内结构键**,派在它身上。 */
function panel(): HTMLElement {
  return document.querySelector('[data-focus-scope="composer"]') as HTMLElement
}

const modelPill = () => screen.getByRole('button', { name: /选择模型/ })
const inputBox = () => screen.getByRole('textbox', { name: /说点什么|再按一次/ })

/** 把去抖窗口走完,并让那一次往返落地。 */
async function settleMentions() {
  await act(async () => {
    vi.advanceTimersByTime(FILE_MENTION_DEBOUNCE_MS)
    await Promise.resolve()
    await Promise.resolve()
  })
}

/**
 * **不推时钟**,只把微任务放干净 —— 「首开那一发有没有出门」要的正是这个:
 * 推一格时钟就分不清「当场发的」与「去抖到期发的」了。
 */
async function settleWithoutClock() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** 在 contenteditable 里「打」一段话:落文本 + 把光标放到末尾 + 发 input。 */
function type(el: HTMLElement, text: string) {
  el.textContent = text
  const node = el.firstChild
  if (node) {
    const range = document.createRange()
    range.setStart(node, text.length)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
  fireEvent.input(el)
}

/**
 * **两格 prop 都是这一格叶自己的事实**(W5-c,正本 §4.3)。
 *
 * 这一族的其余用例只顺手用着它们(`renderComposer(sessionId)`),所以「它们真的
 * 落到了该落的地方」由这两条单独钉:
 *  · `owner` 挂在作用域根上 —— `focusIntoRef` 靠它挑**这一格自己**那份实例
 *    (判词在 `workbench/focus-into.ts`;它那一头的用例在 `tabs-w7t.test.tsx`);
 *  · `sessionId` 决定读写哪一份 store —— 两块面板并排时互不相干。
 *
 * **反证**:把 `Composer` 的 `FocusScope` 上那句 `owner={owner}` 去掉 → 第一条红。
 */
describe('W5-c:这块面板的两格 prop', () => {
  it('作用域根登记的 owner 就是这一格的 refId', () => {
    renderComposer('s-1')
    const registered = focusTree.dump().nodes.find((node) => node.scope === 'composer')
    expect(registered?.owner).toBe('session:s-1')
  })

  it('两块面板并排:一块开抽屉,另一块一个字不动', () => {
    renderComposer('A')
    fireEvent.click(modelPill())
    expect(composerStoreFor('A').getState().drawerKind).toBe('model')
    expect(composerStoreFor('B').getState().drawerKind).toBeNull()
  })
})

describe('抽屉:一个槽,后来者顶替先来者', () => {
  it('打出 @ 就开文件抽屉;模型抽屉正开着时被它直接顶掉', async () => {
    vi.useFakeTimers()
    renderComposer()
    fireEvent.click(modelPill())
    expect(screen.getByLabelText('搜模型或 Provider…')).toBeTruthy()

    type(inputBox(), '看看 @model')
    expect(state().drawerKind).toEqual(pickDrawer('@'))
    expect(screen.queryByLabelText('搜模型或 Provider…')).toBeNull()
    expect(screen.getByText('引用文件')).toBeTruthy()

    await settleMentions()
    expect(screen.getByText('/repo/src/model-capability.ts')).toBeTruthy()
  })

  it('Esc 收抽屉(并 preventDefault:外层只在 !defaultPrevented 时才轮到它)', () => {
    renderComposer()
    fireEvent.click(modelPill())
    expect(state().drawerKind).toBe('model')

    const consumed = !fireEvent.keyDown(window, { key: 'Escape' })
    expect(consumed).toBe(true)
    expect(state().drawerKind).toBeNull()
  })

  it('点 composer 外面:模型抽屉一律关,选没选都关', () => {
    renderComposer()
    fireEvent.click(modelPill())
    fireEvent.pointerDown(document.body)
    expect(state().drawerKind).toBeNull()
  })

  it('抽屉一开焦点就在搜索行(开它的那一下手已经离开键盘了)', () => {
    renderComposer()
    fireEvent.click(modelPill())
    /*
     * 反证:把 `DrawerModelPicker` 那句 `activateOnMount restingTarget=…` 拆掉 →
     * 焦点留在药丸上,打字打不进搜索行。R2 之前这是一条
     * `useEffect(() => ref.current?.focus(), [])`,现在是一句声明。
     */
    expect(document.activeElement).toBe(screen.getByLabelText('搜模型或 Provider…'))
  })

  /**
   * 09-05(庚)改口:**点一行只做一件事 —— 选中它,抽屉不关**。
   *
   * 从前这一口是「一个手势,两件事」(选中 + 收抽屉)。设计 §5.8 之后右栏那张卡
   * 讲的正是「刚选中的这一型」,选完当场关掉等于把刚翻开的那一页合上。
   * 反证:把 `composer/store.chooseModel` 里那句 `set({drawerKind:null})` 加回去 →
   * 这一条当场红。
   */
  it('选一个模型:pill 换名,抽屉**不关**(右栏立刻换成这一型)', () => {
    renderComposer()
    fireEvent.click(modelPill())
    fireEvent.mouseDown(screen.getByText('grok-4'))
    expect(state().drawerKind).toBe('model')
    // 没有当前会话:这次选择是「下一条新会话用谁」,记在 pending 上,不发请求。
    expect(useModelsSource.getState().pending).toEqual({ provider: 'xai', model: 'grok-4' })
    expect(modelPill().textContent).toContain('grok-4')
  })

  /**
   * **render-prop 里不许读写外层的可变游标**(09-03 R2 施工中抓到的真 bug)。
   *
   * 抽屉的行下标从前是一个「边画边走」的游标(`let flat = -1`,在 JSX 里 `flat += 1`)。
   * 把这块面包进 `<FocusScope>` 的 render-prop 之后,那段 JSX 由**子组件**产生 ——
   * 子组件自己重渲一次(它订着响应链,焦点一动就重渲)游标就接着往上加,于是
   * 第二遍画出来的行下标全体 +1:点第一行选到第二个模型,点最后一行什么都不发生。
   * 这一条逼出那次重渲再点,拆掉 `offsets` 那格纯派生量当场红。
   */
  it('焦点动过一次(抽屉重渲)之后,点第一行选到的仍然是第一个模型', () => {
    renderComposer()
    fireEvent.click(modelPill())
    // 焦点从搜索行挪到别处再回来 —— 树一变,FocusScope 就重渲一次它的 children。
    act(() => {
      focusTree.activateScope('composer')
    })
    act(() => {
      focusTree.activateScope('drawer')
    })
    fireEvent.mouseDown(screen.getByText('grok-4'))
    expect(useModelsSource.getState().pending).toEqual({ provider: 'xai', model: 'grok-4' })
  })

  it('一个模型都还没有:药丸写「选择模型」,不拿目录第一条去顶', () => {
    providersQuery.patch([])
    prefsQuery.get('default').patch({ prefs: { defaultProvider: '', configs: {} }, custom: [] })
    renderComposer()
    expect(modelPill().textContent).toContain('选择模型')
  })

  it('命令抽屉里的 /ask-demo 是 dev 扳机:选中即把本体变成问卷', () => {
    renderComposer()
    type(inputBox(), '/ask')
    fireEvent.mouseDown(screen.getByText('/ask-demo'))
    expect(state().mode).toBe('ask')
    expect(state().drawerKind).toBeNull()
  })
})

/**
 * `@` 引用(D3 波二)。候选来自真产地(`files.list`),而 chip 与交出去的那句话是
 * **两样东西**:屏幕上那几个字是给人看的,`data-token` 上那一截 `{{file:…}}` 才是
 * 这枚 chip 的位置 —— 它在**草稿的出口**展成 `@<绝对路径>`(09-12,见
 * `ComposerInput.test.tsx`;从前这一步在 chat-port,那正是重复气泡的病根)。
 */
describe('@ 引用:候选是真的,插进去的是 token', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  /*
   * ── 首开不去抖,此后每一次改词才去抖(09-12 第二批)──────────────────────
   * 从前这一条守的是「连打几下只发一次」,而它连**第一下**也一起去抖了 ——
   * 那 120ms 里屏幕上写着「正在找…」,请求却还没出门。去抖是给**打字的节奏**
   * 准备的,而 `@` 敲下去的那一拍没有节奏可言:它是一次明确的「我要看候选」。
   * 所以今天判据分两段,两段都要守:首开当场发、后续仍然只发一次最后那个词。
   */
  it('首开不去抖:`@` 敲下去那一拍当场发一次', async () => {
    renderComposer()
    type(inputBox(), '看看 @m')
    await settleWithoutClock()
    expect(fileAsks, '刚切到 files 的那一拍不该再等 120ms').toHaveLength(1)
    // 没有当前会话 = 没有工作目录:`cwd` 与 `sessionId` 两格都**不带**,
    // 不在渲染层拼一个根去顶(判据见 data/file-mentions-source.ts 文件头)。
    expect(fileAsks[0]).toEqual({ query: 'm', limit: 50 })
  })

  it('首开之后照旧去抖 120ms:窗口里连打几下只发一次,发的就是最后那个词', async () => {
    renderComposer()
    const box = inputBox()

    type(box, '看看 @m')
    await settleWithoutClock()
    expect(fileAsks, '首开那一发').toHaveLength(1)

    type(box, '看看 @mo')
    type(box, '看看 @mod')
    await settleWithoutClock()
    expect(fileAsks, '去抖窗口里一发都不该再发出去').toHaveLength(1)

    await settleMentions()
    expect(fileAsks).toHaveLength(2)
    expect(fileAsks[1]).toEqual({ query: 'mod', limit: 50 })
  })

  it('抽屉一收就把候选散掉 —— 它是「此刻在匹配什么」,不是缓存', async () => {
    renderComposer()
    type(inputBox(), '看看 @mod')
    await settleMentions()
    expect(useFileMentionsSource.getState().mentions).toHaveLength(2)

    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    expect(state().drawerKind).toBeNull()
    expect(useFileMentionsSource.getState().mentions).toEqual([])
  })

  it('已到手的那批里再收一次 —— 多打两个字,列表当场收窄,不等下一次往返', async () => {
    renderComposer()
    const box = inputBox()
    // 刚敲下 `@`:空词也发,该出全表。
    type(box, '看看 @')
    await settleMentions()
    expect(screen.getByText('/repo/src/model-capability.ts')).toBeTruthy()
    expect(screen.getByText('/repo/src/codex.ts')).toBeTruthy()

    // 这一下还在下一个去抖窗口里(一发都还没走),但屏幕已经该只剩一条了。
    type(box, '看看 @codex')
    expect(screen.queryByText('/repo/src/model-capability.ts')).toBeNull()
    expect(screen.getByText('/repo/src/codex.ts')).toBeTruthy()
  })

  it('选中一条:chip 上写路径,交出去的那句话里是 `@<绝对路径>`', async () => {
    renderComposer()
    const box = inputBox()
    type(box, '看看 @model')
    await settleMentions()

    /*
     * 插完一枚 chip,光标回到这块可编辑区:接着打字就是接着说话。
     *
     * 这一条**只能钉「有没有把焦点要回去」这个动作**,不能钉最终的 activeElement:
     * 候选行走的是 `onMouseDown + preventDefault`(那正是为了不让输入框失焦),
     * 所以焦点从头到尾没离开过 box —— 而把焦点先挪开再点会连插入本身一起弄坏
     * (`caretToken` 读的是当下的 selection,焦点一走光标就没了)。
     * 反证:把 `ComposerInput` 那句 `activate('programmatic')` 删掉 → 这里红。
     */
    const refocus = vi.spyOn(box, 'focus')
    fireEvent.mouseDown(screen.getByText('/repo/src/model-capability.ts'))
    expect(state().drawerKind).toBeNull()
    // 屏幕上是一枚写着 `@路径` 的 chip(呈现)。
    expect(box.textContent).toContain('@/repo/src/model-capability.ts')
    expect(refocus).toHaveBeenCalled()
    refocus.mockRestore()

    // 发送那一条得**先把焦点挪开**才量得出东西(壳一挂起来它本来就在 box 上)。
    act(() => screen.getByTestId('composer-send').focus())
    fireEvent.click(screen.getByTestId('composer-send'))
    // 交出去的是**草稿**:chip 那一格换成它代表的那条路径(位置)。token 在
    // 草稿的出口就展成了 `@<绝对路径>` —— 与账本上最终落下的那句逐字相同
    // (09-12:展开从 `chat-port` 挪到这里,判词在 `ComposerInput.readDraft`)。
    expect(handed.at(-1)).toEqual({
      kind: 'text',
      attachments: 0,
      text: '看看 @/repo/src/model-capability.ts',
    })
    /*
     * 发完话光标回输入框。R2 之前这是 `inputRef.current?.focus()`(一次跨作用域的
     * 程序置焦),现在是 `activateScope('composer')` —— 焦点落在这块面**声明的
     * 落点**上。反证:把 `useComposerSend` 里那句 `backToComposer()` 删掉 → 这里红。
     */
    expect(document.activeElement).toBe(box)
  })

  /**
   * **病 ② 的那条反证**(09-12 真机:@ 的是一个目录,气泡与模型都把它当成文件)。
   *
   * 候选自己说得清是 `directory` 还是 `file`,而下游谁都没有 stat —— 气泡里那枚
   * chip(`content/user-message.tsx` 的 `dirRef`)判「这是目录吗」的唯一判据就是
   * 路径尾巴上那个 `/`,模型看见的也只是那一条路径。所以那一格得在**选中的那一刻**
   * 写进路径里,判据只此一处(`usePickDrawer.applyPick`)。
   *
   * **反证**:把那两句 `ensureTrailingSlash` 拆掉 → 这一条当场读到不带尾巴的路径。
   */
  it('选中的是目录:chip 与交出去的那条路径都带尾斜杠(文件不带)', async () => {
    configureFilesPort({
      ready: async () => undefined,
      listDirectory: async () => ({ success: false, error: 'not used here' }),
      stat: async () => ({ success: false, error: 'not used here' }),
      readContent: async () => ({ success: false, error: 'not used here' }),
      saveContent: async () => ({ success: true }),
      reveal: async () => ({ success: false, error: 'not used here' }),
      list: async () => ({
        success: true,
        files: ['/repo/src/lib', '/repo/src/lib.ts'],
        entries: [
          { path: '/repo/src/lib', type: 'directory' as const },
          { path: '/repo/src/lib.ts', type: 'file' as const },
        ],
      }),
    })
    renderComposer()
    const box = inputBox()
    type(box, '看看 @lib')
    await settleMentions()

    fireEvent.mouseDown(screen.getByText('/repo/src/lib'))
    expect(box.textContent).toContain('@/repo/src/lib/')
    expect(box.querySelector('[data-token]')?.getAttribute('data-token')).toBe(
      createFileToken('/repo/src/lib/'),
    )

    act(() => screen.getByTestId('composer-send').focus())
    fireEvent.click(screen.getByTestId('composer-send'))
    expect(handed.at(-1)).toMatchObject({ text: '看看 @/repo/src/lib/' })
  })

  it('选中的是文件:尾巴上一个斜杠都不许多', async () => {
    renderComposer()
    const box = inputBox()
    type(box, '看看 @codex')
    await settleMentions()

    fireEvent.mouseDown(screen.getByText('/repo/src/codex.ts'))
    expect(box.querySelector('[data-token]')?.getAttribute('data-token')).toBe(
      createFileToken('/repo/src/codex.ts'),
    )
    expect(box.textContent).toContain('@/repo/src/codex.ts')
    expect(box.textContent?.endsWith('/')).toBe(false)
  })
})

/**
 * `/` 命令(D4 波二)。这一层钉的是**路由**:选中做什么、按下发送之后谁接手。
 * 「一条命令具体怎么执行」在 data/commands-source.test.ts。
 */
describe('/ 命令:选中只插文本,执行在按下发送的那一刻', () => {
  const send = () => screen.getByTestId('composer-send')

  it('抽屉里列的是 core 注册表那七条,不是壳编的', () => {
    renderComposer()
    type(inputBox(), '/c')
    expect(screen.getByText('/cd')).toBeTruthy()
    expect(screen.getByText('/compact')).toBeTruthy()
    // 波一那三条样例(/review /plan /test)整仓没有产地,已经删掉。
    expect(screen.queryByText('/review')).toBeNull()
  })

  it('选中 /cd:只把命令徽插进框里(参数是选完之后才打的),不执行', () => {
    renderComposer()
    const box = inputBox()
    type(box, '/cd')
    // 输入框里此刻也写着 `/cd`,所以要的是抽屉里那一行(按钮),不是随便一处文字。
    const row = screen.getAllByText('/cd').find((el) => el.closest('button'))
    fireEvent.mouseDown(row as HTMLElement)
    /*
     * **09-12 改口**:框里除了命令徽还多一枚参数幽灵占位(`<path>`)——
     * 它是画出来的一句提示,`textContent` 看得见、草稿里一个字都没有
     * (那条缝由 `ComposerInput.test.tsx` 逐条钉)。这里只认「命令徽进去了、
     * 执行没发生」这两件事,所以改问那枚徽自己。
     */
    expect(box.querySelector('[data-arg-ghost]')?.textContent).toBe('<path>')
    expect(box.textContent?.trim()).toBe('/cd <path>')
    expect(handed).toHaveLength(0)
  })

  it('/new + 回车:走建会话的唯一编排点,一条消息都不发', async () => {
    renderComposer()
    const box = inputBox()
    type(box, '/new')

    await act(async () => void fireEvent.click(send()))

    expect(starts).toBe(1)
    expect(handed).toHaveLength(0)
    expect(box.textContent).toBe('')
  })

  it('/goal 那一类壳不执行:原样当一条消息发出去,不报错也不吞掉', async () => {
    renderComposer()
    const box = inputBox()
    type(box, '/goal 把徽标那处改了')

    await act(async () => void fireEvent.click(send()))

    expect(starts).toBe(0)
    expect(handed).toEqual([{ kind: 'text', text: '/goal 把徽标那处改了', attachments: 0 }])
  })

  it('句中的斜杠不是命令 —— 「看看 /new 那条」照常是一句话', () => {
    renderComposer()
    type(inputBox(), '看看 /new 那条')
    fireEvent.click(send())
    expect(starts).toBe(0)
    expect(handed).toEqual([{ kind: 'text', text: '看看 /new 那条', attachments: 0 }])
  })

  /* ── 09-12:命令行画用法(用户报障「命令无提示」)────────────────────── */

  it('一行三格:名 · 说明 · 用法 —— usage 从此上屏,不再只在报错里出现', () => {
    renderComposer()
    type(inputBox(), '/cd')
    const row = screen.getAllByText('/cd').find((el) => el.closest('button'))?.closest('button')
    expect(row?.textContent).toContain('/cd <path>')
    expect(row?.textContent).toContain('Change the working directory')
  })

  it('用法与命令名一样时不画 —— 同一个词一行里不写两遍', () => {
    renderComposer()
    type(inputBox(), '/compact')
    const row = screen
      .getAllByText('/compact')
      .find((el) => el.closest('button'))
      ?.closest('button')
    // `/compact` 的 usage 就是它自己:行上只出现一次。
    expect(row?.textContent?.match(/\/compact/g) ?? []).toHaveLength(1)
  })

  it('按说明也找得到 —— 「directory」打进去,`/cd` 在列(它名字里没这几个字母)', () => {
    renderComposer()
    type(inputBox(), '/directory')
    expect(screen.getAllByText('/cd').some((el) => el.closest('button'))).toBe(true)
  })
})

/**
 * 抽屉里命令分三组(09-12)。这一层钉的是**画法**:组头各出现一次、
 * 键盘走位仍旧是一条扁平序。切组的判据在 transitions.test.ts。
 */
describe('/ 命令抽屉:命令 / 技能 / 插件三个组头', () => {
  beforeEach(async () => {
    /*
     * **先散账再换端口**:这只 store 按 cwd 缓存(拉过同一个 cwd 就是恒等),
     * 而前面的用例已经用 setup.ts 那份空端口把 `cwd: null` 这一格拉成 ready 了
     * —— 不散,这一组换上来的端口一发都不会发(踩过一次)。
     */
    useSkillsSource.getState().reset()
    configureSkillsPort({
      ready: async () => undefined,
      getAll: async () => ({
        success: true,
        skills: [
          {
            id: 'user/writing',
            name: 'writing',
            description: '把一段话改得更像人说的',
            source: 'user',
            path: '/s/SKILL.md',
            directoryPath: '/s',
            enabled: true,
            instructions: '',
          },
        ],
      }),
    })
    configureCommandsPort({
      ready: async () => undefined,
      listPluginCommands: async () => ({
        success: true,
        commands: [{ id: 'note', name: '/note', description: '记一条', usage: '/note <文字>' }],
      }),
      executePluginCommand: async () => ({ success: false }),
      compactContext: async () => ({ success: false }),
    })
  })

  afterEach(() => {
    configureSkillsPort(undefined)
    useSkillsSource.getState().reset()
  })

  /** 开一次命令抽屉,并把那两发懒拉落地。 */
  async function openCommands(word = '/') {
    renderComposer()
    type(inputBox(), word)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('三个组头各出现恰好一次,顺序是 命令 → 技能 → 插件', async () => {
    await openCommands()
    const heads = Array.from(document.querySelectorAll('[data-testid="composer-panel"] div'))
      .map((el) => el.textContent)
      .filter((text) => text === '命令' || text === '技能' || text === '插件')
    expect(heads).toEqual(['命令', '技能', '插件'])
  })

  it('技能那一行是 `/skill:<名字>`,选中只插文本(展开在引擎那头)', async () => {
    await openCommands()
    const row = screen.getByText('/skill:writing')
    fireEvent.mouseDown(row)
    const box = inputBox()
    expect(box.textContent).toContain('/skill:writing')
    // 幽灵占位说的是「接着说你要它干什么」。
    expect(box.querySelector('[data-arg-ghost]')?.textContent).toBe('[说明]')
    expect(handed).toHaveLength(0)
  })

  it('发出去的就是 `/skill:… …` 那句话本身 —— 壳一个字都不执行', async () => {
    await openCommands()
    fireEvent.mouseDown(screen.getByText('/skill:writing'))
    const box = inputBox()
    type(box, '/skill:writing 改一下这段')
    await act(async () => void fireEvent.click(screen.getByTestId('composer-send')))
    expect(handed).toEqual([
      { kind: 'text', text: '/skill:writing 改一下这段', attachments: 0 },
    ])
  })

  it('分组不改键盘走位:↓ 一格一格走过三组,↵ 落在键盘那一行', async () => {
    await openCommands()
    const box = inputBox()
    // 扁平序里技能排在内置七条(+dev)之后。走到它那一格再回车。
    const flat = Array.from(
      document.querySelectorAll('[data-testid="composer-panel"] button'),
    ).filter((el) => el.className.includes('pickRow'))
    const at = flat.findIndex((el) => el.textContent?.startsWith('/skill:writing'))
    expect(at).toBeGreaterThan(0)
    for (let i = 0; i < at; i += 1) fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.textContent).toContain('/skill:writing')
  })
})

/**
 * `@` 候选的四态(09-12)。从前这一列只按长度判,于是去抖窗口里屏幕上写着
 * 「无匹配」—— 用户报的「出现的动画很突兀」有一半是这句不成立的话。
 */
describe('@ 候选:正在找 / 旧候选留屏 / 无匹配 / 出错', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('刚敲下 @、一发还没回来:画「正在找…」,**不**说「无匹配」', () => {
    renderComposer()
    type(inputBox(), '看看 @')
    expect(screen.getByText('正在找…')).toBeTruthy()
    expect(screen.queryByText('无匹配')).toBeNull()
  })

  it('回来了、真的一条都没有:这时才说「无匹配」', async () => {
    configureFilesPort({
      ready: async () => undefined,
      listDirectory: async () => ({ success: false, error: 'x' }),
      stat: async () => ({ success: false, error: 'x' }),
      readContent: async () => ({ success: false, error: 'x' }),
      saveContent: async () => ({ success: true }),
      reveal: async () => ({ success: false, error: 'x' }),
      list: async () => ({ success: true, files: [], entries: [] }),
    })
    renderComposer()
    type(inputBox(), '看看 @zzz')
    await settleMentions()
    expect(screen.getByText('无匹配')).toBeTruthy()
    expect(screen.queryByText('正在找…')).toBeNull()
  })

  it('手上有旧候选时再打字:旧候选**留在屏上**,不闪一下「正在找…」', async () => {
    renderComposer()
    const box = inputBox()
    type(box, '看看 @')
    await settleMentions()
    expect(screen.getByText('/repo/src/codex.ts')).toBeTruthy()

    type(box, '看看 @c')
    expect(screen.queryByText('正在找…')).toBeNull()
    expect(screen.getByText('/repo/src/codex.ts')).toBeTruthy()
  })

  it('这一发失败:旧候选留屏,错误与它并陈(律②:错误不抹掉旧答案)', async () => {
    renderComposer()
    const box = inputBox()
    type(box, '看看 @')
    await settleMentions()

    configureFilesPort({
      ready: async () => undefined,
      listDirectory: async () => ({ success: false, error: 'x' }),
      stat: async () => ({ success: false, error: 'x' }),
      readContent: async () => ({ success: false, error: 'x' }),
      saveContent: async () => ({ success: true }),
      reveal: async () => ({ success: false, error: 'x' }),
      list: async () => ({ success: false, error: '后端说不成', files: [] }),
    })
    type(box, '看看 @co')
    await settleMentions()
    expect(screen.getByText('/repo/src/codex.ts')).toBeTruthy()
    expect(screen.getByText('这一发没找成,先看上一批')).toBeTruthy()
  })
})

describe('状态条:执行完不消失,只换成绿点', () => {
  const spec = {
    name: '/review',
    prompt: '把三处读取点改成同一个判据。',
    steps: [
      { label: '读取', detail: 'model-capability.ts' },
      { label: '测试', detail: 'providers 套件' },
    ],
  }

  it('开一次执行:条出现、状态抽屉跟着开;点条收起,条还在', () => {
    renderComposer()
    act(() => state().beginStatus(spec))
    const bar = screen.getByLabelText('执行状态')
    expect(bar.textContent).toContain('正在执行 /review')
    expect(screen.getByText(spec.prompt)).toBeTruthy()

    fireEvent.click(bar)
    expect(state().drawerKind).toBeNull()
    expect(screen.getByLabelText('执行状态')).toBeTruthy()
  })

  it('走到最后一步就自己落定成完成:条改念「执行完成」', () => {
    renderComposer()
    act(() => state().beginStatus(spec))
    act(() => state().tickStatus())
    expect(state().status?.stepIdx).toBe(1)
    act(() => state().tickStatus())
    expect(state().status?.running).toBe(false)
    expect(screen.getByLabelText('执行状态').textContent).toContain('执行完成 · /review · 2 步')
  })
})

describe('ask 形态:本体的另一副样子', () => {
  const openDemo = () => act(() => state().openAsk(ASK_DEMO_SPEC))

  it('变形即问卷在场;Esc 整单拒绝,回落 write 并在流里留一条', () => {
    renderComposer()
    openDemo()
    expect(screen.getByText(ASK_DEMO_SPEC.questions[0].q)).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(state().mode).toBe('write')
    expect(handed.at(-1)).toEqual({ kind: 'notice', notice: 'ask-rejected' })
  })

  /*
   * 09-01 批 3.5:「拒绝」换 `ui/Button` 的 **danger** 档 —— 批 3 迁库件时
   * 因为库件没有这一档而退役的危险语义,这一条就是它回来的证词。
   * 测 class 而不是测颜色:颜色由 `Button.module.css` 的 `.danger` 保证,
   * jsdom 不解析 CSS Modules 的真值 —— 「哪一档挂上了」是 JS 侧唯一测得到的那一面
   *(真机 hover 转红的对照另见交卷报告)。
   */
  it('「拒绝」挂 ui/Button 的 danger 档(危险语义回填,不是 ghost)', () => {
    renderComposer()
    openDemo()
    const reject = screen.getByRole('button', { name: '拒绝回答' })
    expect(reject.className).toMatch(/danger/)
    expect(reject.className).not.toMatch(/ghost/)
    // 落点皮肤仍在(把它顶到行尾的那一格),没有被库件档位挤掉。
    expect(reject.className).toMatch(/askReject/)
  })

  it('单选再点即取消;没答全时提交按钮不亮', () => {
    renderComposer()
    openDemo()
    const first = ASK_DEMO_SPEC.questions[0].opts[0].l
    fireEvent.click(screen.getByText(first))
    expect(state().askAnswers[0]).toBe(first)
    fireEvent.click(screen.getByText(first))
    expect(state().askAnswers[0]).toBeNull()
    expect(screen.getByRole('button', { name: /提交 0\/3/ }).hasAttribute('disabled')).toBe(true)
  })

  it('三题答满才亮提交;交出去的是一条合并消息,本体回落 write', () => {
    renderComposer()
    openDemo()
    // 第一题单选 → 第二题多选两条 → 第三题单选,中间用 › 翻题
    fireEvent.click(screen.getByText(ASK_DEMO_SPEC.questions[0].opts[0].l))
    fireEvent.click(screen.getByLabelText('下一题'))
    fireEvent.click(screen.getByText(ASK_DEMO_SPEC.questions[1].opts[0].l))
    fireEvent.click(screen.getByText(ASK_DEMO_SPEC.questions[1].opts[2].l))
    fireEvent.click(screen.getByLabelText('下一题'))
    fireEvent.click(screen.getByText(ASK_DEMO_SPEC.questions[2].opts[1].l))

    const submit = screen.getByRole('button', { name: /提交 3\/3/ })
    expect(submit.hasAttribute('disabled')).toBe(false)
    fireEvent.click(submit)

    expect(state().mode).toBe('write')
    // 交卷 = 一条真消息:一行一题,`标签: 答案`。
    expect(handed.at(-1)).toEqual({
      kind: 'text',
      attachments: 0,
      text: [
        `徽标: ${ASK_DEMO_SPEC.questions[0].opts[0].l}`,
        `验证: ${ASK_DEMO_SPEC.questions[1].opts[0].l}、${ASK_DEMO_SPEC.questions[1].opts[2].l}`,
        `提交: ${ASK_DEMO_SPEC.questions[2].opts[1].l}`,
      ].join('\n'),
    })
  })

  it('「其他」就在行里写,回车即答;点记号即取消,不新开任何输入框', () => {
    renderComposer()
    openDemo()
    const free = screen.getAllByRole('textbox', { name: /就在这行写/ })[0]
    free.textContent = '两处都先别动'
    fireEvent.keyDown(free, { key: 'Enter' })
    expect(state().askAnswers[0]).toBe('两处都先别动')

    fireEvent.click(screen.getByRole('button', { name: '其他' }))
    expect(state().askAnswers[0]).toBeNull()
  })

  it('← → 翻题,但焦点在输入面里时不抢(写字的人按方向键是在移光标)', () => {
    renderComposer()
    openDemo()
    fireEvent.keyDown(panel(), { key: 'ArrowRight' })
    expect(state().askIdx).toBe(1)

    /*
     * 「焦点在输入面里」这一半:真机上那一下按键的 target **就是**拿着焦点的
     * 那个元素,所以判据从 `document.activeElement` 换成 `e.target` 是同义改写
     * (设计 §7:别再读 activeElement 判「我是不是当前」)。用例因此也得照真机
     * 派事件 —— 派在那格自由输入上,它自己冒泡到作用域根。
     */
    const free = screen.getAllByRole('textbox', { name: /就在这行写/ })[0]
    free.focus()
    fireEvent.keyDown(free, { key: 'ArrowRight' })
    expect(state().askIdx).toBe(1)
  })
})

describe('拍立得附件', () => {
  const drop = (name: string) => new File(['x'], name, { type: 'text/plain' })

  const attach = (container: HTMLElement, names: string[]) => {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: names.map(drop) } })
  }

  it('📎 进来几张就有几张卡,计数徽念总数;删一张其余就位', () => {
    const { container } = renderComposer()
    attach(container, ['a.log', 'b.png'])
    const stack = screen.getByLabelText('附件')
    expect(within(stack).getAllByLabelText('移除附件')).toHaveLength(2)
    expect(within(stack).getByText('2')).toBeTruthy()

    fireEvent.click(within(stack).getAllByLabelText('移除附件')[0])
    expect(state().attachments).toHaveLength(1)
    expect(within(screen.getByLabelText('附件')).getByText('1')).toBeTruthy()
  })

  it('离开摞带 200ms 宽限,再进即取消(卡缝与删卡的瞬间出界不塌摞)', () => {
    vi.useFakeTimers()
    const { container } = renderComposer()
    attach(container, ['a.log'])
    const stack = screen.getByLabelText('附件')

    fireEvent.mouseEnter(stack)
    expect(state().attOpen).toBe(true)

    fireEvent.mouseLeave(stack)
    act(() => vi.advanceTimersByTime(120))
    expect(state().attOpen).toBe(true)

    fireEvent.mouseEnter(stack) // 再进 → 取消收拢
    act(() => vi.advanceTimersByTime(400))
    expect(state().attOpen).toBe(true)

    fireEvent.mouseLeave(stack)
    act(() => vi.advanceTimersByTime(200))
    expect(state().attOpen).toBe(false)
  })
})

describe('发送', () => {
  it('空话不发;有话就交出去,附件随消息一起离开,输入框清空', () => {
    const { container } = renderComposer()
    const box = screen.getByRole('textbox', { name: /说点什么/ })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.log')] } })

    fireEvent.click(screen.getByLabelText('发送'))
    expect(handed).toHaveLength(0)

    type(box, '把徽标那处也改了')
    fireEvent.click(screen.getByLabelText('发送'))
    expect(handed.at(-1)).toEqual({
      kind: 'text',
      text: '把徽标那处也改了',
      attachments: 1,
    })
    expect(state().attachments).toHaveLength(0)
    expect(box.textContent).toBe('')
  })

  /*
   * 08-31 用户真机报障:中文输入法下打 `hi` 按一下回车,消息发了**两次**。
   *
   * 拼音输入法候选框开着时按回车,浏览器先发一个「确认候选」的 keydown
   * (`isComposing === true` / 老实现 `keyCode === 229`),IME 结束组字之后**再**发
   * 一个真回车。两下都被当成发送,于是同一句话出去两遍 —— 而第一遍还发在候选上屏
   * 之前,内容也不对。
   *
   * 两条用例分别钉两种问法:标准的 `isComposing` 与老 WebKit 的 229。缺哪一条都会
   * 漏掉一类宿主,而漏掉的后果就是这条报障。
   */
  it.each([
    ['标准问法 isComposing', { isComposing: true }],
    ['老实现 keyCode 229', { keyCode: 229 }],
  ])('组字确认的那一下回车不发送(%s),随后的真回车发且只发一条', (_label, composing) => {
    renderComposer()
    const box = screen.getByRole('textbox', { name: /说点什么/ })
    type(box, 'hi')

    fireEvent.keyDown(box, { key: 'Enter', ...composing })
    expect(handed, '组字期间的回车属于输入法,不该交出去').toHaveLength(0)

    fireEvent.keyDown(box, { key: 'Enter' })
    expect(handed).toEqual([{ kind: 'text', text: 'hi', attachments: 0 }])
  })

  /*
   * 组字期间**一个键都不抢**,不只是回车:上下键在候选框里是翻页,Escape 是取消
   * 这次组字。抽屉开着时它们本来归抽屉 —— 抢走的话中文用户就得在「选字」和
   * 「用这个应用」之间二选一。
   */
  it('组字期间上下键归输入法,不去翻抽屉的选中项', async () => {
    vi.useFakeTimers()
    renderComposer()
    const box = screen.getByRole('textbox', { name: /说点什么/ })
    type(box, '看看 @')
    expect(state().drawerKind).toEqual(pickDrawer('@'))
    // 候选是真取来的(D3 波二):没有候选就没有可翻的行,这一条也就验不出东西。
    await settleMentions()
    const before = state().pickIndex

    fireEvent.keyDown(box, { key: 'ArrowDown', isComposing: true })
    expect(state().pickIndex).toBe(before)

    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(state().pickIndex).not.toBe(before)
  })
})

/**
 * 抽屉封顶(08-31 报障:候选一多,抽屉一直往上长,把聊天顶出屏外)。
 *
 * 限高本身是 CSS,守在 composer-css.test.ts(那份样式表从来没进过 jsdom,
 * `getComputedStyle` 在这台机器上答不出真话 —— 同一条判例)。
 * 这里守的是**限高必然带出来的那另一半**:选中项走出视野时要滚回来。
 * 只做限高不做滚入视野,比不限高更糟 —— 键盘还在动,屏幕上什么都不变。
 */
describe('抽屉列表封顶之后:选中项要滚进视野', () => {
  it('↑↓ 换选中项时,对那一行调 scrollIntoView({ block: "nearest" })', async () => {
    const original = Element.prototype.scrollIntoView
    /**
     * 自己收两件事:`this`(被滚的那个元素)与那一发的参数。
     * 不读 `mock.calls`:`vi.fn` 推出来的参数元组跟着实现签名走,拿它取下标
     * 在 tsc 眼里是越界(空元组没有第 0 位)—— 收在自己的数组里既准又不用绕。
     */
    const targets: HTMLElement[] = []
    const opts: (ScrollIntoViewOptions | boolean | undefined)[] = []
    const scrollIntoView = vi.fn(function (
      this: HTMLElement,
      arg?: ScrollIntoViewOptions | boolean,
    ) {
      targets.push(this)
      opts.push(arg)
    })
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      vi.useFakeTimers()
      renderComposer()
      const box = inputBox()
      type(box, '看看 @')
      await settleMentions()

      // 两个候选(REPO_FILES),下标 0 → 1。
      scrollIntoView.mockClear()
      targets.length = 0
      opts.length = 0
      fireEvent.keyDown(box, { key: 'ArrowDown' })
      expect(state().pickIndex).toBe(1)

      expect(scrollIntoView).toHaveBeenCalled()
      // 'nearest':已经在视野里的选中项一动不动,只有真走出去了才滚最短那一段。
      expect(opts.at(-1)).toMatchObject({ block: 'nearest' })

      // 滚的是**当下选中的那一行**,不是随便一行 —— 用 .pickSel 那件皮肤认它。
      const target = targets.at(-1)
      expect(target?.className ?? '').toMatch(/pickSel/)
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})

/**
 * hover ≠ active(09-01 用户裁定)。从前抽屉每一行挂着
 * `onMouseEnter={() => onHover(i)}`,把键盘位直接交给鼠标 —— 两个后果:
 *  ① 鼠标停在候选上时按 ↑↓,↵ 落在鼠标那一行;
 *  ② 上面那段滚入视野把列表滚一段,**鼠标一动没动**却换了脚下的行,
 *     浏览器补一发 mouseenter,键盘位当场被拽走(二次污染)。
 * 现在改键盘位的只剩键盘与点击,hover 由 CSS 画。
 * 反证:把那句 onMouseEnter 加回 DrawerPickList,下面两条立刻红。
 */
describe('抽屉候选:hover 不许影响 select', () => {
  it('鼠标经过第二条,选中位一格不动', async () => {
    vi.useFakeTimers()
    renderComposer()
    const box = inputBox()
    type(box, '看看 @')
    await settleMentions()

    expect(state().pickIndex).toBe(0)
    const rows = screen.getAllByRole('button').filter((el) => /pickRow/.test(el.className))
    expect(rows.length).toBeGreaterThan(1)
    act(() => void fireEvent.mouseEnter(rows[1]))
    expect(state().pickIndex).toBe(0)
    // 屏幕上带选中皮肤的仍然是第一条。
    expect(rows[0].className).toMatch(/pickSel/)
    expect(rows[1].className).not.toMatch(/pickSel/)
  })

  it('滚入视野之后补来的那发合成 mouseenter,同样拽不走选中位', async () => {
    vi.useFakeTimers()
    renderComposer()
    const box = inputBox()
    type(box, '看看 @')
    await settleMentions()

    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(state().pickIndex).toBe(1)
    // 真机上这一发是浏览器在指针静止时补的(列表被 scrollIntoView 滚了一段),
    // jsdom 不排版不会自己补,所以按真机次序手动重演。
    const rows = screen.getAllByRole('button').filter((el) => /pickRow/.test(el.className))
    act(() => void fireEvent.mouseEnter(rows[0]))
    expect(state().pickIndex).toBe(1)
  })
})

/**
 * 忙态那半边(D1 开工批)。忙不忙的判据只有一个产地(data/chat-source.ts 的
 * `selectEngineBusy`),所以这里就地掀那一格 —— 不为测试另造一个假的忙态开关。
 */
describe('发送键的两副面孔:闲时发送,忙时停止', () => {
  const busy = () => act(() => useChatSource.setState({ activeMessageId: 'a1' }))
  const sendBtn = () => screen.getByTestId('composer-send')

  it('闲时:aria-label 是发送,data-mode 说的也是 send', () => {
    renderComposer()
    expect(sendBtn().getAttribute('data-mode')).toBe('send')
    expect(sendBtn().getAttribute('aria-label')).toBe('发送')
  })

  it('忙时同一颗按钮换脸:label 变「停止生成」,点它是交出一次 abort 而不是发消息', () => {
    renderComposer()
    const box = screen.getByRole('textbox', { name: /说点什么/ })
    type(box, '这句话不该在这时候被发出去')
    busy()

    expect(sendBtn().getAttribute('data-mode')).toBe('stop')
    expect(sendBtn().getAttribute('aria-label')).toBe('停止生成')

    fireEvent.click(sendBtn())
    expect(aborts).toBe(1)
    expect(handed).toHaveLength(0)
    // 那句话还在框里 —— 停止不是发送,更不是丢弃。
    expect(box.textContent).toBe('这句话不该在这时候被发出去')
  })

  it('Esc 停止是两段式(08-31 拍板对齐 Vue):第一下只预备并换占位话,窗口内第二下才停', () => {
    renderComposer()
    const box = screen.getByRole('textbox', { name: /说点什么/ })
    box.focus()
    busy()

    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    expect(aborts).toBe(0)
    // 预备期占位符换话 —— 用户能看见「再按一次」的唯一通道(有草稿时静默,与 Vue 同取舍)。
    expect(box.getAttribute('data-placeholder')).toBe('再按一次 Esc 停止生成')

    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    expect(aborts).toBe(1)
    expect(box.getAttribute('data-placeholder')).toBe('说点什么…( @ 文件 · / 命令 )')
  })

  it('预备窗口过期后再按 Esc 只是重新预备;引擎收尾也拆预备', () => {
    vi.useFakeTimers()
    try {
      renderComposer()
      const box = screen.getByRole('textbox', { name: /说点什么/ })
      box.focus()
      busy()

      act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
      act(() => void vi.advanceTimersByTime(2100))
      act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
      expect(aborts).toBe(0)
      act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
      expect(aborts).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('抽屉开着时 Esc 先收抽屉 —— 看得见的那层先退,这一下不会顺手停掉一轮', () => {
    renderComposer()
    fireEvent.click(modelPill())
    expect(state().drawerKind).toBe('model')
    busy()

    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    expect(state().drawerKind).toBeNull()
    expect(aborts).toBe(0)
  })

  /**
   * 「焦点在这块面板里」R2 之后**不是一句判据,是结构**:两段式停止的唯一调用点
   * 是这块面那一格作用域的 `onEscape`,而树只在它在活动路径上时才问。所以这一条
   * 照树的说法摆现场:把第一响应者指到**别的一格**上(这里是壳根),再按 Esc。
   * 反证:把 `focus/transitions.routeEscape` 里那句「不在路径上的不进候选表」
   * 拆掉 → 这一条当场红(别处按 Esc 退层会顺手掐掉后台那一轮)。
   */
  it('这块面不是当前时 Esc 不停 —— 别处按 Esc 退层不该顺手掐掉后台那一轮', () => {
    renderComposer()
    busy()
    const elsewhere = document.createElement('div')
    elsewhere.tabIndex = -1
    document.body.append(elsewhere)
    act(() => {
      const root = focusTree.register('root', null)
      root.setRoot(elsewhere)
      root.activate('programmatic')
    })

    /*
     * **按两下**:第一下只预备(静默),第二下才交 abort —— 只按一下的话
     * 「没接住」与「接住了但还在预备」读数相同,那条守卫就翻不红了。
     */
    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    expect(aborts).toBe(0)
  })
})

/*
 * 首开草稿态(08-31 用户拍板)。
 *
 * 刚打开 app 时没有活动会话 —— 当前会话**故意**不跨启动持久化(它是真会话 id,
 * 记到下次启动换来的是一个指向空气的标题),于是标题栏画的是「新会话」这张空脸。
 * 在这张脸上打一句话按发送,从前被静默吞掉(sink 说没交出去,而这一层就此收工:
 * 没提示、没动作);现在那一下的意思被认成它本来的意思 ——「开始一段对话」。
 *
 * 这一层钉的是**路由**:什么时候该去建、建完发什么、建不成剩下什么。
 * 「怎么建」在 data/session-create.test.ts(唯一编排点那一侧),这里一台 core 都不起。
 */
describe('首开草稿态:没有会话时发送 = 先建一条,再把这句话发进去', () => {
  const sendBtn = () => screen.getByLabelText('发送')
  const box = () => screen.getByRole('textbox', { name: /说点什么/ })

  it('恰好建一条会话,原话发进去,输入框清空', async () => {
    hasSession = false
    renderComposer()
    type(box(), '先建一条会话再说')

    await act(async () => void fireEvent.click(sendBtn()))

    expect(starts).toBe(1)
    expect(handed).toEqual([{ kind: 'text', text: '先建一条会话再说', attachments: 0 }])
    expect(box().textContent).toBe('')
    /*
     * **收件人是刚建出来那一条,不是这块面板出厂时那个空串**(W5-c-2)。
     * 这是这块面板一辈子唯一一次收件人与自己不同的时刻 —— W5-c-2 之前它白拿
     * (sink 每次现问「当前会话是谁」),收件人钉进 store 之后就得说出来。
     *
     * **反证**:把 `useComposerSend` 那句 `send(text, created)` 的第二个参数删掉 →
     * 这一条读到空串。真机上那是**首开第一句话静默发不出去**
     * (`chatSources.get('')` 查无此人)。
     */
    expect(handedTo).toEqual(['created-1'])
  })

  it('空话不建会话 —— 「开始一段对话」的前提是真有一句话要说', async () => {
    hasSession = false
    renderComposer()

    await act(async () => void fireEvent.click(sendBtn()))

    expect(starts).toBe(0)
    expect(handed).toHaveLength(0)
  })

  it('建会话在飞时第二下当没按:不建第二条、不双发,话还在框里', async () => {
    hasSession = false
    let release: (id: string | undefined) => void = () => undefined
    answerStart = () =>
      new Promise((resolve) => {
        release = resolve
      })
    renderComposer()
    type(box(), 'hi')

    fireEvent.click(sendBtn())
    // 第二下落在那段往返窗口里(中文输入法一次回车发两下是真发生过的事)。
    fireEvent.click(sendBtn())
    expect(starts).toBe(1)
    expect(box().textContent, '被忽略的那一下无损:话没被清掉').toBe('hi')

    await act(async () => {
      release('created-1')
      await Promise.resolve()
    })

    expect(starts).toBe(1)
    expect(handed).toEqual([{ kind: 'text', text: 'hi', attachments: 0 }])
    expect(box().textContent).toBe('')

    // 闸拆干净了:下一句照常走「已有会话」那条直路,不再建第二条。
    type(box(), '第二句')
    await act(async () => void fireEvent.click(sendBtn()))
    expect(starts).toBe(1)
    expect(handed).toHaveLength(2)
  })

  it('建不成:话留在框里,这一层不再加第二条提示(编排点已经说过了)', async () => {
    hasSession = false
    answerStart = async () => undefined
    renderComposer()
    type(box(), '这句话不能丢')

    await act(async () => void fireEvent.click(sendBtn()))

    expect(starts).toBe(1)
    expect(handed).toHaveLength(0)
    expect(box().textContent).toBe('这句话不能丢')
  })
})

/**
 * 律③补口(批 7b):切模型这一发在飞时,反馈长在**发起它的那个控件**上,
 * 而且是**逐格**的 —— 不是把整条工具行禁灰。
 *
 * 两处读的是同一格(`selectKey(sessionId)`):
 *  · 药丸 `aria-busy`(它永不禁用 —— 禁了就连抽屉都开不了,与 AgentChip 同一条);
 *  · 抽屉 commit 的那道闸(在飞时**连抽屉都不收**,因为它根本没走到 `choose`)。
 */
describe('律③:切模型在飞时,药丸自报忙、抽屉不接第二下', () => {
  /* 这一族要一条**真会话**:`selectKey(sessionId)` 是药丸忙态与抽屉那道闸共读的
   * 那一格,空串(草稿态)走的是另一条路(记成「下一条新会话用谁」)。
   * W5-c 之前它由 `expose.currentSessionId` 立,现在由这块面板的 prop 立。 */
  const SESSION = 's1'
  const updates: string[] = []
  let land: (value: { success: boolean }) => void = () => undefined

  /** 药丸按 aria-expanded 认 —— 它的 aria-label 会跟着选中的模型改名。 */
  const pill = () => screen.getAllByRole('button').find((b) => b.hasAttribute('aria-expanded'))!
  /**
   * 抽屉里那一行。**不能按文字找**:立牌之后药丸上写的也是 grok-4,
   * `getByText` 会一次找到两个 —— 行是那个不带 aria-expanded 的钮。
   */
  const row = () =>
    screen
      .getAllByRole('button')
      .find((b) => !b.hasAttribute('aria-expanded') && (b.textContent ?? '').includes('grok-4'))!

  beforeEach(() => {
    updates.length = 0
    configureModelsPort({
      ready: async () => undefined,
      listProviders: async () => ({ success: true, providers: [] }),
      readProviderSettings: async () => ({ success: false, error: '这组用例不走取数口' }),
      readSettings: async () => ({ success: true, settings: {} as never }),
      updateSessionModel: async (_sessionId, _provider, model) => {
        updates.push(model)
        return new Promise((resolve) => {
          land = resolve
        })
      },
    })
  })

  /*
   * 把那一发放走再拆台:挂着的 promise 会让 mutation 的收尾落在用例之外,
   * 那正是 React 抱怨「act 之外的更新」的形状。
   */
  afterEach(async () => {
    await act(async () => {
      land({ success: true })
      // settle 那一路是**不被 await 的**(重拉会话表 → 撤牌),让它在这里跑完,
      // 否则那次撤牌会落在用例之外。
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    configureModelsPort(undefined)
  })

  it('在飞时药丸 aria-busy,而且它自己不被禁用', async () => {
    renderComposer(SESSION)
    fireEvent.click(pill())
    await act(async () => void fireEvent.mouseDown(row()))

    expect(updates).toEqual(['grok-4'])
    expect(pill().getAttribute('aria-busy')).toBe('true')
    expect(pill().hasAttribute('disabled')).toBe(false)

    await act(async () => land({ success: true }))
    expect(pill().getAttribute('aria-busy')).toBe('false')
  })

  /**
   * 09-05(庚)之后抽屉**两下都不关**(选中不再收抽屉),所以这一条守的东西
   * 收窄成它真正要守的那一件:**在飞时第二下一个字都不发**(闸在 commit)。
   */
  it('在飞时抽屉的第二下**不发**(闸在 commit,不在 store)', async () => {
    renderComposer(SESSION)
    fireEvent.click(pill())
    await act(async () => void fireEvent.mouseDown(row()))
    expect(updates).toEqual(['grok-4'])

    // 再点同一行:commit 那道闸把它整下拦掉,不发第二发。
    await act(async () => void fireEvent.mouseDown(row()))
    expect(updates).toEqual(['grok-4'])
    expect(state().drawerKind).toBe('model')
  })
})

/**
 * ══════════════════════════════════════════════════════════════════════════
 * 庚:模型药丸带档位 + 抽屉右栏那张卡与它的思考阶梯(09-05,设计 §5.8)
 * ══════════════════════════════════════════════════════════════════════════
 * 四件事各自钉死:
 *  ① **只画这一型支持的档** —— 档表来自目录行上那四格(后端投影),不是这一层编的;
 *  ② **点一档写的是什么** —— 两张表一起写(`thinkingByModel` + `thinkingEffortByModel`),
 *     `writeProviderSettings` 收到的 patch 逐格断言;
 *  ③ **只打补丁** —— 选另一行前后 `.pickScroll` 是**同一个 DOM 节点**且 scrollTop 不动;
 *  ④ **药丸六形** —— 不思考 / 关 / 开 / 明确档 / 不可关的缺省档 / 可关但没设过。
 *
 * 目录那一格直接 `patch` 进 `catalogQuery`(与文件头 setup 同一手):这一层验的是
 * 「谁在场、点了写什么」,投影本身归 `packages/backend/rpc/__tests__/models-domain`。
 */
describe('庚:模型选择器带思考档位', () => {
  /** 药丸按 aria-expanded 认 —— 它的 aria-label 会跟着选中的模型改名。 */
  const pill = () => screen.getAllByRole('button').find((b) => b.hasAttribute('aria-expanded'))!
  const ladder = () => screen.queryByRole('radiogroup')
  const rungs = () =>
    screen.queryAllByRole('radio').map((r) => (r.closest('label')?.textContent ?? '').trim())

  /**
   * 摆一台「一家一型」的现场:名册一家、设置勾了这一型、目录里这一条带着
   * 后端投过来的思考四格。`thinking` 那两格是**盘上已有的设置**。
   */
  function stage(
    modelId: string,
    caps: Partial<OpenRouterModel>,
    stored: { thinking?: Record<string, boolean>; thinkingEffort?: Record<string, never> } = {},
  ): void {
    providersQuery.patch([{ id: 'xai', name: 'xAI' }])
    prefsQuery.get('default').patch({
      prefs: {
        defaultProvider: 'xai',
        configs: {
          xai: providerModelPrefs({
            selectedModels: [modelId],
            model: modelId,
            ...stored,
          }),
        },
      },
      custom: [],
    })
    catalogQuery.reset()
    catalogQuery.get('xai').patch([openRouterModel(modelId, 200_000, caps)])
  }

  const THINKS_4 = {
    thinkingLevels: ['low', 'medium', 'high', 'max'],
    thinkingToggleable: true,
    thinkingDefaultOn: false,
    thinkingDefaultLevel: 'high',
  } as Partial<OpenRouterModel>

  afterEach(() => {
    configureProviderSettingsPort(undefined)
    act(() => {
      useProviderSettings.getState().reset()
    })
  })

  /* ── ① 阶梯只画这一型支持的档 ─────────────────────────────────────────── */

  it('deepseek 那一形(两档 + 可关)→ 关 / 高 / 最大', () => {
    stage('deepseek-v4-pro', {
      thinkingLevels: ['high', 'max'],
      thinkingToggleable: true,
      thinkingDefaultOn: true,
      thinkingDefaultLevel: 'high',
    })
    renderComposer()
    fireEvent.click(pill())
    expect(rungs()).toEqual(['关不思考,最快', '高认真想', '最大想到底'])
  })

  it('gpt-5 那一形(不可关)→ 阶梯上**没有**「关」', () => {
    stage('gpt-5', {
      thinkingLevels: ['minimal', 'low', 'medium', 'high'],
      thinkingToggleable: false,
      thinkingDefaultOn: true,
      thinkingDefaultLevel: 'medium',
    })
    renderComposer()
    fireEvent.click(pill())
    expect(rungs().some((text) => text.startsWith('关'))).toBe(false)
    expect(rungs()).toHaveLength(4)
  })

  it('kimi k3 那一形(一档 + 可关)→ 关 / 最大', () => {
    stage('kimi-k3', {
      thinkingLevels: ['max'],
      thinkingToggleable: true,
      thinkingDefaultOn: true,
      thinkingDefaultLevel: 'max',
    })
    renderComposer()
    fireEvent.click(pill())
    expect(rungs()).toEqual(['关不思考,最快', '最大想到底'])
  })

  it('qwen3.5 那一形(能开关但一档都没有)→ 只有开 / 关', () => {
    stage('qwen3.5-max', {
      thinkingLevels: [],
      thinkingToggleable: true,
      thinkingDefaultOn: true,
      thinkingDefaultLevel: 'high',
    })
    renderComposer()
    fireEvent.click(pill())
    expect(rungs()).toEqual(['关不思考,最快', '开按这一型的缺省想'])
  })

  it('不思考的型 → 一句实话,一个控件都不画', () => {
    stage('deepseek-chat', { thinkingLevels: null })
    renderComposer()
    fireEvent.click(pill())
    expect(ladder()).toBeNull()
    expect(screen.getByText('这一型不思考')).toBeTruthy()
  })

  /* ── ② 点一档写进去的是什么 ───────────────────────────────────────────── */

  it('点一档:两张表一起写(只写档不写开关,发送链会当没设过)', async () => {
    const writes: { thinkingByModel?: unknown; thinkingEffortByModel?: unknown }[] = []
    configureProviderSettingsPort(
      fakeProviderPort({
        readSettings: async () => ({
          success: true,
          settings: { ai: { providers: { xai: { model: 'grok-4', selectedModels: ['grok-4'] } } } } as never,
        }),
        readProviderSettings: async () => ({
          success: true,
          ai: {
            provider: 'xai',
            providers: { xai: { model: 'grok-4', selectedModels: ['grok-4'] } },
            customProviders: [],
          } as never,
        }),
        writeProviderSettings: async (request) => {
          writes.push((request.ai?.providers?.xai ?? {}) as never)
          return { success: true, ai: request.ai }
        },
      }),
    )
    stage('grok-4', THINKS_4)
    renderComposer()
    fireEvent.click(pill())

    await act(async () => {
      fireEvent.click(screen.getAllByRole('radio')[3])
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(writes).toHaveLength(1)
    expect(writes[0].thinkingByModel).toEqual({ 'grok-4': true })
    expect(writes[0].thinkingEffortByModel).toEqual({ 'grok-4': 'high' })
  })

  it('点「关」:只写开关那一张表,不给它钉一个档', async () => {
    const writes: { thinkingByModel?: unknown; thinkingEffortByModel?: unknown }[] = []
    configureProviderSettingsPort(
      fakeProviderPort({
        readSettings: async () => ({
          success: true,
          settings: { ai: { providers: { xai: { model: 'grok-4', selectedModels: ['grok-4'] } } } } as never,
        }),
        readProviderSettings: async () => ({
          success: true,
          ai: {
            provider: 'xai',
            providers: { xai: { model: 'grok-4', selectedModels: ['grok-4'] } },
            customProviders: [],
          } as never,
        }),
        writeProviderSettings: async (request) => {
          writes.push((request.ai?.providers?.xai ?? {}) as never)
          return { success: true, ai: request.ai }
        },
      }),
    )
    // 得先是开着的:原生 radio 点已经选中的那一颗**不发 change**(浏览器的行为,
    // 不是我们的)—— 用 THINKS_4 的缺省(defaultOn:false)开场,「关」本来就按着。
    stage('grok-4', THINKS_4, { thinking: { 'grok-4': true } })
    renderComposer()
    fireEvent.click(pill())

    await act(async () => {
      fireEvent.click(screen.getAllByRole('radio')[0])
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(writes[0].thinkingByModel).toEqual({ 'grok-4': false })
    expect(writes[0].thinkingEffortByModel).toBeUndefined()
  })

  /* ── ③ 只打补丁:列表这棵 DOM 不重建 ──────────────────────────────────── */

  /**
   * 报障「列表独滚卡不滚」的两半,一条用例守两件事:
   *
   *  ① **卡是列表的兄弟,不是它的内容** —— 卡在滚动区里,滚列表就会把卡滚走,
   *     而卡恰恰是「必须一直看得见」的那一半(设计 §5.8)。
   *     反证:把 `<ModelDetailCard/>` 搬进 `.pickScroll` 里 → 这一条当场红。
   *  ② **换选中之后列表不许重挂** —— 否则滚动位当场归零:用户滚到第 40 条
   *     点了一下,列表跳回顶。
   *     反证:给列表那棵子树加一个跟着选中变的 `key` → 这一条当场红。
   */
  it('右栏是兄弟不是内容;选另一行时 `.pickScroll` 是同一个节点、scrollTop 不动', () => {
    providersQuery.patch([{ id: 'xai', name: 'xAI' }])
    prefsQuery.get('default').patch({
      prefs: {
        defaultProvider: 'xai',
        configs: {
          xai: providerModelPrefs({ selectedModels: ['grok-4', 'grok-4-fast'], model: 'grok-4' }),
        },
      },
      custom: [],
    })
    catalogQuery.reset()
    catalogQuery
      .get('xai')
      .patch([
        openRouterModel('grok-4', 200_000, THINKS_4),
        openRouterModel('grok-4-fast', 128_000, THINKS_4),
      ])

    const { container } = renderComposer()
    fireEvent.click(pill())
    const scroll = container.querySelector('[class*="pickScroll"]') as HTMLElement
    expect(scroll).toBeTruthy()
    // ① 卡在滚动区**外面**。这是结构断言,不是样式断言 —— CSS 说不出「谁装着谁」。
    expect(scroll.contains(screen.getByTestId('model-detail-card'))).toBe(false)
    // ② jsdom 不排版,所以 scrollTop 只是一格可写的数 —— 这一条守的是
    //    「这棵子树没被重建」,重建的话赋上去的值当然也就没了。
    scroll.scrollTop = 120

    fireEvent.mouseDown(screen.getByText('grok-4-fast'))

    expect(container.querySelector('[class*="pickScroll"]')).toBe(scroll)
    expect(scroll.scrollTop).toBe(120)
  })

  /* ── ④ 药丸六形 ──────────────────────────────────────────────────────── */

  async function pillText(
    caps: Partial<OpenRouterModel>,
    stored: { thinking?: Record<string, boolean>; thinkingEffort?: Record<string, never> } = {},
  ): Promise<string> {
    stage('m-1', caps, stored)
    renderComposer()
    // 目录那几发 ensure 是异步的(缓存命中也要过一次微任务),放它们落地再读 ——
    // 否则最后那一次落地会变成一次 act 之外的重渲。
    await act(async () => {
      await Promise.resolve()
    })
    return pill().textContent ?? ''
  }

  it('不思考的型:药丸只写名,不留一个孤零零的间隔点', async () => {
    expect(await pillText({ thinkingLevels: null })).toBe('m-1')
  })

  it('明确关掉:写「关」', async () => {
    expect(await pillText(THINKS_4, { thinking: { 'm-1': false } })).toContain('关')
  })

  it('明确开着并钉了档:写那一档', async () => {
    expect(
      await pillText(THINKS_4, {
        thinking: { 'm-1': true },
        thinkingEffort: { 'm-1': 'max' } as never,
      }),
    ).toContain('最大')
  })

  it('不可关、没设过:写 profile 的缺省档(那一发真的会这么跑)', async () => {
    expect(
      await pillText({
        thinkingLevels: ['low', 'medium', 'high'],
        thinkingToggleable: false,
        thinkingDefaultOn: true,
        thinkingDefaultLevel: 'medium',
      }),
    ).toContain('中')
  })

  it('可关、没设过、服务端缺省不想:写「关」', async () => {
    // THINKS_4 的 defaultOn 是 false(claude 那一形):没设过 = 一个参数都不发 = 不想。
    expect(await pillText(THINKS_4)).toContain('关')
  })

  it('能开关但一档都没有、开着:写「开」', async () => {
    expect(
      await pillText(
        {
          thinkingLevels: [],
          thinkingToggleable: true,
          thinkingDefaultOn: true,
          thinkingDefaultLevel: 'high',
        },
        { thinking: { 'm-1': true } },
      ),
    ).toContain('开')
  })

  /* ── ⑤ 读屏听到的与眼睛看到的一样多 ───────────────────────────────────── */

  /**
   * 药丸右半那格档字是**画**出来的(`.modelPillLevel` 里一个 span)——
   * aria-label 若只念模型名,读屏的人恰好丢掉这枚药丸新长出来的那半格意思。
   * 所以这两条读的是**同一次渲染**的两面:嘴上念的与眼睛看的必须是同一个词。
   * 反证:把 aria-label 换回 `t('composer.model', …)` 那一条 → 下面第一条当场红。
   */
  async function pillFaces(
    caps: Partial<OpenRouterModel>,
    stored: { thinking?: Record<string, boolean>; thinkingEffort?: Record<string, never> } = {},
  ): Promise<{ label: string; text: string }> {
    stage('m-1', caps, stored)
    renderComposer()
    await act(async () => {
      await Promise.resolve()
    })
    const el = pill()
    return { label: el.getAttribute('aria-label') ?? '', text: el.textContent ?? '' }
  }

  it('有档的型:无障碍名把那一档也念出来,而且念的就是屏幕上那个词', async () => {
    const { label, text } = await pillFaces(THINKS_4, {
      thinking: { 'm-1': true },
      thinkingEffort: { 'm-1': 'max' } as never,
    })
    expect(label).toBe('选择模型:m-1,思考 最大')
    // 眼睛与耳朵同一份事实:药丸上画的那个词,label 里一字不差地又出现一次。
    expect(text).toContain('最大')
    expect(label).toContain('最大')
  })

  it('不思考的型:仍是旧名 —— 不念一个「思考 无」出来', async () => {
    const { label, text } = await pillFaces({ thinkingLevels: null })
    expect(label).toBe('选择模型:m-1')
    expect(text).toBe('m-1')
  })
})


/*
 * ── **一条会话一份草稿**(W7-t / B2)────────────────────────────────────────
 *
 * 真机读数(审计 B 第 79 条):A、B 两格会话并排,在 A 里打字 → 切到 B,B 的输入框
 * 里躺着 A 的稿;在 B 里接着打 → 回到 A,A 的稿已经被顶掉了。
 *
 * 病根是**输入框是外壳级的一件、而它的内容没有主人**。修法与 W5-a 同一条路:
 * 状态按 `sessionId` 分家(表在 `composer/drafts.ts`)—— 所以这一组用例走的正是
 * 用户那三步:A 打字 → 切 B → 回 A。
 *
 * W5-c 之后换会话是**换这块面板的 `sessionId` prop**(`switchTo`),而不是改一格
 * 全局投影:真机上那是「这一格的 refId 换了 → 这一格重挂」,而重挂与换 prop 在
 * `Composer` 这一层走的是同一条 layout effect(先存旧稿、再铺新稿)。
 */
describe('B2:一条会话一份草稿', () => {

  it('A 打字 → 切 B 是空的 → B 打字 → 回 A 仍是 A 的稿', () => {
    renderComposer('A')
    act(() => type(inputBox(), 'A 的稿'))

    switchTo('B')
    /*
     * **反证**:把 `Composer` 里那句 layout effect 删掉 → 这一条当场读到「A 的稿」,
     * 也就是用户报的那一半(A 的字跟着切标签跑到 B 里)。
     */
    expect(inputBox().textContent).toBe('')

    act(() => type(inputBox(), 'B 的稿'))
    switchTo('A')
    /*
     * **反证**:把那句 effect 里「先存旧的」那半删掉 → 这一条读到空串,
     * 也就是用户报的另一半(A 的稿被顶掉了)。
     */
    expect(inputBox().textContent).toBe('A 的稿')

    switchTo('B')
    expect(inputBox().textContent).toBe('B 的稿')
  })

  /**
   * 存的是 **HTML** 而不是纯文本:`@` 引用是真节点(不可编辑的 chip,真正代表的
   * 那截文本挂在 `data-token` 上)。存纯文本等于换一格会话回来 chip 就散成几个字,
   * 而散掉之后**发出去的那句话与人看见的不再是同一句**。
   * **反证**:把 `saveComposerDraft` 那一句的 `html()` 换成 `text()` → 这一条读到
   * 的是 `{{file:…}}` 那串字面,而不是一枚 chip。
   */
  it('@ 引用是真节点:切走再回来,它仍旧是一枚 chip,交出去的仍是那截 token', async () => {
    // `@` 候选那条口是去抖的,所以这一条要一台假钟(与那一族用例同一手)。
    vi.useFakeTimers()
    renderComposer('A')
    const box = inputBox()
    act(() => type(box, '@model'))
    await settleMentions()
    // 抽屉里第一行 = 那份假工作区的第一个文件。
    const first = screen.getAllByRole('button').find((b) => (b.textContent ?? '').includes('model-capability'))
    expect(first).toBeTruthy()
    await act(async () => void fireEvent.mouseDown(first as HTMLElement))

    const chips = () => box.querySelectorAll('[data-token]')
    expect(chips()).toHaveLength(1)
    const token = chips()[0]?.getAttribute('data-token') ?? ''
    expect(token).toBe(createFileToken(REPO_FILES[0]))

    switchTo('B')
    expect(chips()).toHaveLength(0)
    switchTo('A')
    expect(chips()).toHaveLength(1)
    expect(chips()[0]?.getAttribute('data-token')).toBe(token)
  })

  /**
   * 附件那半边走 store 的 `setState`(它是这块面板的状态产地):**摞里有什么**与
   * **摞开着没有**是同一件事的两半,所以两格一起搬。
   */
  it('附件与那只摞的开合跟着会话走', () => {
    renderComposer('A')
    act(() => {
      setState({
        attachments: [{ id: 'a1', name: 'a.png' }],
        attOpen: true,
      })
    })
    switchTo('B')
    expect(state().attachments).toEqual([])
    expect(state().attOpen).toBe(false)
    switchTo('A')
    expect(state().attachments.map((a) => a.id)).toEqual(['a1'])
    expect(state().attOpen).toBe(true)
  })

  /**
   * **空稿不进表**:打完字又清空,那条会话在表里不该留下一具空壳
   * (判词与反证在 `composer/drafts.test.ts`;这一条量的是编排这一头真的走到了它)。
   */
  it('打完又清空的那条会话,切走时不在表里留空壳', () => {
    renderComposer('A')
    act(() => type(inputBox(), '写了又删'))
    act(() => type(inputBox(), ''))
    switchTo('B')
    expect(composerDraftKeys()).toEqual([])
    expect(readComposerDraft('A').html).toBe('')
  })
})
