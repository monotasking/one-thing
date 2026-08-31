import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Composer } from './Composer'
import { useComposerStore, resetComposerStore } from '../store'
import { configureComposerSink } from '../sink'
import { ASK_DEMO_SPEC } from '../data'
import { useStageStore } from '../../stage/store'
import { useChatSource } from '../../data/chat-source'

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
})

afterEach(() => {
  vi.useRealTimers()
  configureComposerSink(undefined)
})

const state = () => useComposerStore.getState()
const modelPill = () => screen.getByRole('button', { name: /选择模型/ })

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
  it('打出 @ 就开文件抽屉;模型抽屉正开着时被它直接顶掉', () => {
    render(<Composer />)
    fireEvent.click(modelPill())
    expect(screen.getByLabelText('搜模型或 Provider…')).toBeTruthy()

    type(screen.getByRole('textbox', { name: /说点什么/ }), '看看 @model')
    expect(state().drawerKind).toBe('files')
    expect(screen.queryByLabelText('搜模型或 Provider…')).toBeNull()
    expect(screen.getByText('引用文件')).toBeTruthy()
    expect(screen.getByText('model-capability.ts')).toBeTruthy()
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
    expect(state().model).toBe('grok-4')
    expect(state().drawerKind).toBeNull()
    expect(modelPill().textContent).toContain('grok-4')
  })

  it('命令抽屉里的 /ask-demo 是 dev 扳机:选中即把本体变成问卷', () => {
    render(<Composer />)
    type(screen.getByRole('textbox', { name: /说点什么/ }), '/ask')
    fireEvent.mouseDown(screen.getByText('/ask-demo'))
    expect(state().mode).toBe('ask')
    expect(state().drawerKind).toBeNull()
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
  it('组字期间上下键归输入法,不去翻抽屉的选中项', () => {
    render(<Composer />)
    const box = screen.getByRole('textbox', { name: /说点什么/ })
    type(box, '看看 @m')
    expect(state().drawerKind).toBe('files')
    const before = state().pickIndex

    fireEvent.keyDown(box, { key: 'ArrowDown', isComposing: true })
    expect(state().pickIndex).toBe(before)

    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(state().pickIndex).not.toBe(before)
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
