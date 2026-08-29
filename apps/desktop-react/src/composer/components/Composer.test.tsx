import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Composer } from './Composer'
import { useComposerStore, resetComposerStore } from '../store'
import { ASK_DEMO_SPEC } from '../data'
import { useStageStore } from '../../stage/store'

/**
 * 组件层只钉「谁在场、谁让位、键盘归谁」—— 判断本身在 transitions.test.ts。
 * 抽屉纪律(一个槽、后来者顶替、Esc 收)与 ask 形态的进出是这一层的主戏。
 */
beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetComposerStore()
})

afterEach(() => {
  vi.useRealTimers()
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
    expect(state().outbox.at(-1)).toMatchObject({ kind: 'ask-rejected' })
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
    const sent = state().outbox.at(-1)
    expect(sent).toMatchObject({ kind: 'ask' })
    expect(sent?.kind === 'ask' && sent.lines).toEqual([
      { tag: '徽标', answer: ASK_DEMO_SPEC.questions[0].opts[0].l },
      {
        tag: '验证',
        answer: `${ASK_DEMO_SPEC.questions[1].opts[0].l}、${ASK_DEMO_SPEC.questions[1].opts[2].l}`,
      },
      { tag: '提交', answer: ASK_DEMO_SPEC.questions[2].opts[1].l },
    ])
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
    expect(state().outbox).toHaveLength(0)

    type(box, '把徽标那处也改了')
    fireEvent.click(screen.getByLabelText('发送'))
    expect(state().outbox.at(-1)).toMatchObject({
      kind: 'text',
      text: '把徽标那处也改了',
      attachments: 1,
    })
    expect(state().attachments).toHaveLength(0)
    expect(box.textContent).toBe('')
  })
})
