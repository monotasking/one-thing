import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createFileToken } from '@shared/prompt-references'
import type { FilesListRequest } from '@shared/ipc/files'
import { Composer } from './Composer'
import { useComposerStore, resetComposerStore } from '../store'
import { configureComposerSink } from '../sink'
import { ASK_DEMO_SPEC } from '../data'
import { useStageStore } from '../../stage/store'
import { useChatSource } from '../../data/chat-source'
import { useCommandsSource } from '../../data/commands-source'
import {
  FILE_MENTION_DEBOUNCE_MS,
  useFileMentionsSource,
} from '../../data/file-mentions-source'
import { configureFilesPort } from '../../data/files-port'
import { prefsQuery, providersQuery, useModelsSource } from '../../data/models-source'
import { configureModelsPort } from '../../data/models-port'
import { useExposeStore } from '../../expose/store'
import { catalogQuery } from '../../providers/catalog-query'
import { openRouterModel } from '../../data/__fixtures__/models'

/**
 * D3 起 composer 不再自己攒一条假队列 —— 它把话**交给 sink**(见 composer/sink.ts)。
 * 所以「到底交出去了什么」在这一层就是断言这只假 sink 收到了什么:形态机一条没变,
 * 换的只是收件人从一个数组变成了一个接口。
 */
const handed: ({ kind: 'text'; text: string; attachments: number } | { kind: 'notice'; notice: string })[] = []

/** 交给 sink 的「停一轮」有几次。忙态是**真 store 的那一格**,不另造一个假的。 */
let aborts = 0

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
  aborts = 0
  hasSession = true
  starts = 0
  answerStart = async () => 'created-1'
  configureComposerSink({
    send: (text, attachments) => {
      // 没有当前会话就交不出去 —— 与真实现同判据(见 sink.ts 上的 send 注释)。
      if (!hasSession) return false
      handed.push({ kind: 'text', text, attachments })
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
    prefs: { defaultProvider: '', configs: { xai: { selectedModels: ['grok-4'], model: '' } } },
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
})

const state = () => useComposerStore.getState()
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

describe('抽屉:一个槽,后来者顶替先来者', () => {
  it('打出 @ 就开文件抽屉;模型抽屉正开着时被它直接顶掉', async () => {
    vi.useFakeTimers()
    render(<Composer />)
    fireEvent.click(modelPill())
    expect(screen.getByLabelText('搜模型或 Provider…')).toBeTruthy()

    type(inputBox(), '看看 @model')
    expect(state().drawerKind).toBe('files')
    expect(screen.queryByLabelText('搜模型或 Provider…')).toBeNull()
    expect(screen.getByText('引用文件')).toBeTruthy()

    await settleMentions()
    expect(screen.getByText('/repo/src/model-capability.ts')).toBeTruthy()
  })

  it('Esc 收抽屉(并 preventDefault:外层只在 !defaultPrevented 时才轮到它)', () => {
    render(<Composer />)
    fireEvent.click(modelPill())
    expect(state().drawerKind).toBe('model')

    const consumed = !fireEvent.keyDown(window, { key: 'Escape' })
    expect(consumed).toBe(true)
    expect(state().drawerKind).toBeNull()
  })

  it('点 composer 外面:模型抽屉一律关,选没选都关', () => {
    render(<Composer />)
    fireEvent.click(modelPill())
    fireEvent.pointerDown(document.body)
    expect(state().drawerKind).toBeNull()
  })

  it('选一个模型:pill 换名,抽屉收起', () => {
    render(<Composer />)
    fireEvent.click(modelPill())
    fireEvent.mouseDown(screen.getByText('grok-4'))
    expect(state().drawerKind).toBeNull()
    // 没有当前会话:这次选择是「下一条新会话用谁」,记在 pending 上,不发请求。
    expect(useModelsSource.getState().pending).toEqual({ provider: 'xai', model: 'grok-4' })
    expect(modelPill().textContent).toContain('grok-4')
  })

  it('一个模型都还没有:药丸写「选择模型」,不拿目录第一条去顶', () => {
    providersQuery.patch([])
    prefsQuery.get('default').patch({ prefs: { defaultProvider: '', configs: {} }, custom: [] })
    render(<Composer />)
    expect(modelPill().textContent).toContain('选择模型')
  })

  it('命令抽屉里的 /ask-demo 是 dev 扳机:选中即把本体变成问卷', () => {
    render(<Composer />)
    type(inputBox(), '/ask')
    fireEvent.mouseDown(screen.getByText('/ask-demo'))
    expect(state().mode).toBe('ask')
    expect(state().drawerKind).toBeNull()
  })
})

/**
 * `@` 引用(D3 波二)。候选来自真产地(`files.list`),而 chip 与草稿是**两样东西**:
 * 屏幕上那几个字是给人看的,草稿里那一截 `{{file:…}}` 才是这枚 chip 的位置。
 * 「展开成 `@<路径>`」发生在更下游(chat-port,见 data/chat-port.test.ts)。
 */
describe('@ 引用:候选是真的,插进去的是 token', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('去抖 120ms:窗口里连打几下只发一次,发的就是最后那个词', async () => {
    render(<Composer />)
    const box = inputBox()

    type(box, '看看 @m')
    type(box, '看看 @mo')
    type(box, '看看 @mod')
    expect(fileAsks, '去抖窗口里一发都不该发出去').toHaveLength(0)

    await settleMentions()
    expect(fileAsks).toHaveLength(1)
    // 没有当前会话 = 没有工作目录:`cwd` 与 `sessionId` 两格都**不带**,
    // 不在渲染层拼一个根去顶(判据见 data/file-mentions-source.ts 文件头)。
    expect(fileAsks[0]).toEqual({ query: 'mod', limit: 50 })
  })

  it('抽屉一收就把候选散掉 —— 它是「此刻在匹配什么」,不是缓存', async () => {
    render(<Composer />)
    type(inputBox(), '看看 @mod')
    await settleMentions()
    expect(useFileMentionsSource.getState().mentions).toHaveLength(2)

    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    expect(state().drawerKind).toBeNull()
    expect(useFileMentionsSource.getState().mentions).toEqual([])
  })

  it('已到手的那批里再收一次 —— 多打两个字,列表当场收窄,不等下一次往返', async () => {
    render(<Composer />)
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

  it('选中一条:chip 上写路径,交出去的那句话里是 {{file:…}}', async () => {
    render(<Composer />)
    const box = inputBox()
    type(box, '看看 @model')
    await settleMentions()

    fireEvent.mouseDown(screen.getByText('/repo/src/model-capability.ts'))
    expect(state().drawerKind).toBeNull()
    // 屏幕上是一枚写着 `@路径` 的 chip(呈现)。
    expect(box.textContent).toContain('@/repo/src/model-capability.ts')

    fireEvent.click(screen.getByTestId('composer-send'))
    // 交出去的是**草稿**:chip 那一格换成它代表的 token(位置)。
    expect(handed.at(-1)).toEqual({
      kind: 'text',
      attachments: 0,
      text: `看看 ${createFileToken('/repo/src/model-capability.ts')}`,
    })
  })
})

/**
 * `/` 命令(D4 波二)。这一层钉的是**路由**:选中做什么、按下发送之后谁接手。
 * 「一条命令具体怎么执行」在 data/commands-source.test.ts。
 */
describe('/ 命令:选中只插文本,执行在按下发送的那一刻', () => {
  const send = () => screen.getByTestId('composer-send')

  it('抽屉里列的是 core 注册表那七条,不是壳编的', () => {
    render(<Composer />)
    type(inputBox(), '/c')
    expect(screen.getByText('/cd')).toBeTruthy()
    expect(screen.getByText('/compact')).toBeTruthy()
    // 波一那三条样例(/review /plan /test)整仓没有产地,已经删掉。
    expect(screen.queryByText('/review')).toBeNull()
  })

  it('选中 /cd:只把命令徽插进框里(参数是选完之后才打的),不执行', () => {
    render(<Composer />)
    const box = inputBox()
    type(box, '/cd')
    // 输入框里此刻也写着 `/cd`,所以要的是抽屉里那一行(按钮),不是随便一处文字。
    const row = screen.getAllByText('/cd').find((el) => el.closest('button'))
    fireEvent.mouseDown(row as HTMLElement)
    expect(box.textContent?.trim()).toBe('/cd')
    expect(handed).toHaveLength(0)
  })

  it('/new + 回车:走建会话的唯一编排点,一条消息都不发', async () => {
    render(<Composer />)
    const box = inputBox()
    type(box, '/new')

    await act(async () => void fireEvent.click(send()))

    expect(starts).toBe(1)
    expect(handed).toHaveLength(0)
    expect(box.textContent).toBe('')
  })

  it('/goal 那一类壳不执行:原样当一条消息发出去,不报错也不吞掉', async () => {
    render(<Composer />)
    const box = inputBox()
    type(box, '/goal 把徽标那处改了')

    await act(async () => void fireEvent.click(send()))

    expect(starts).toBe(0)
    expect(handed).toEqual([{ kind: 'text', text: '/goal 把徽标那处改了', attachments: 0 }])
  })

  it('句中的斜杠不是命令 —— 「看看 /new 那条」照常是一句话', () => {
    render(<Composer />)
    type(inputBox(), '看看 /new 那条')
    fireEvent.click(send())
    expect(starts).toBe(0)
    expect(handed).toEqual([{ kind: 'text', text: '看看 /new 那条', attachments: 0 }])
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
    render(<Composer />)
    act(() => state().beginStatus(spec))
    const bar = screen.getByLabelText('执行状态')
    expect(bar.textContent).toContain('正在执行 /review')
    expect(screen.getByText(spec.prompt)).toBeTruthy()

    fireEvent.click(bar)
    expect(state().drawerKind).toBeNull()
    expect(screen.getByLabelText('执行状态')).toBeTruthy()
  })

  it('走到最后一步就自己落定成完成:条改念「执行完成」', () => {
    render(<Composer />)
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
    render(<Composer />)
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
    render(<Composer />)
    openDemo()
    const reject = screen.getByRole('button', { name: '拒绝回答' })
    expect(reject.className).toMatch(/danger/)
    expect(reject.className).not.toMatch(/ghost/)
    // 落点皮肤仍在(把它顶到行尾的那一格),没有被库件档位挤掉。
    expect(reject.className).toMatch(/askReject/)
  })

  it('单选再点即取消;没答全时提交按钮不亮', () => {
    render(<Composer />)
    openDemo()
    const first = ASK_DEMO_SPEC.questions[0].opts[0].l
    fireEvent.click(screen.getByText(first))
    expect(state().askAnswers[0]).toBe(first)
    fireEvent.click(screen.getByText(first))
    expect(state().askAnswers[0]).toBeNull()
    expect(screen.getByRole('button', { name: /提交 0\/3/ }).hasAttribute('disabled')).toBe(true)
  })

  it('三题答满才亮提交;交出去的是一条合并消息,本体回落 write', () => {
    render(<Composer />)
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
    render(<Composer />)
    openDemo()
    const free = screen.getAllByRole('textbox', { name: /就在这行写/ })[0]
    free.textContent = '两处都先别动'
    fireEvent.keyDown(free, { key: 'Enter' })
    expect(state().askAnswers[0]).toBe('两处都先别动')

    fireEvent.click(screen.getByRole('button', { name: '其他' }))
    expect(state().askAnswers[0]).toBeNull()
  })

  it('← → 翻题,但焦点在输入面里时不抢(写字的人按方向键是在移光标)', () => {
    render(<Composer />)
    openDemo()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(state().askIdx).toBe(1)

    const free = screen.getAllByRole('textbox', { name: /就在这行写/ })[0]
    free.focus()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
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
    const { container } = render(<Composer />)
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
    const { container } = render(<Composer />)
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
    const { container } = render(<Composer />)
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
    render(<Composer />)
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
    render(<Composer />)
    const box = screen.getByRole('textbox', { name: /说点什么/ })
    type(box, '看看 @')
    expect(state().drawerKind).toBe('files')
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
      render(<Composer />)
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
    render(<Composer />)
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
    render(<Composer />)
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
    render(<Composer />)
    expect(sendBtn().getAttribute('data-mode')).toBe('send')
    expect(sendBtn().getAttribute('aria-label')).toBe('发送')
  })

  it('忙时同一颗按钮换脸:label 变「停止生成」,点它是交出一次 abort 而不是发消息', () => {
    render(<Composer />)
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
    render(<Composer />)
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
      render(<Composer />)
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
    render(<Composer />)
    fireEvent.click(modelPill())
    expect(state().drawerKind).toBe('model')
    busy()

    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    expect(state().drawerKind).toBeNull()
    expect(aborts).toBe(0)
  })

  it('焦点不在这块面板里时 Esc 不停 —— 别处按 Esc 退层不该顺手掐掉后台那一轮', () => {
    render(<Composer />)
    document.body.focus()
    busy()

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
    render(<Composer />)
    type(box(), '先建一条会话再说')

    await act(async () => void fireEvent.click(sendBtn()))

    expect(starts).toBe(1)
    expect(handed).toEqual([{ kind: 'text', text: '先建一条会话再说', attachments: 0 }])
    expect(box().textContent).toBe('')
  })

  it('空话不建会话 —— 「开始一段对话」的前提是真有一句话要说', async () => {
    hasSession = false
    render(<Composer />)

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
    render(<Composer />)
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
    render(<Composer />)
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
    useExposeStore.setState({ currentSessionId: 's1' })
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
    useExposeStore.setState({ currentSessionId: '' })
  })

  it('在飞时药丸 aria-busy,而且它自己不被禁用', async () => {
    render(<Composer />)
    fireEvent.click(pill())
    await act(async () => void fireEvent.mouseDown(row()))

    expect(updates).toEqual(['grok-4'])
    expect(pill().getAttribute('aria-busy')).toBe('true')
    expect(pill().hasAttribute('disabled')).toBe(false)

    await act(async () => land({ success: true }))
    expect(pill().getAttribute('aria-busy')).toBe('false')
  })

  it('在飞时抽屉的第二下**不发**,而且连抽屉都不收(闸在 commit,不在 store)', async () => {
    render(<Composer />)
    fireEvent.click(pill())
    await act(async () => void fireEvent.mouseDown(row()))
    expect(state().drawerKind).toBeNull()

    // 重新打开,再点同一行:commit 那道闸把它整下拦掉 —— 收抽屉这一步都没跑到。
    fireEvent.click(pill())
    await act(async () => void fireEvent.mouseDown(row()))
    expect(updates).toEqual(['grok-4'])
    expect(state().drawerKind).toBe('model')
  })
})
