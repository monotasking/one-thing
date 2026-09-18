import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CaretController } from '../caret-controller'
import { EditableDoc } from '../EditableDoc'
import { EditorDocument } from '../editor-document'

/**
 * 回车的规则(`CaretController.enter`):**有字 = 接着写同一种;空的 = 退出一层**,退到底是原地一个
 * 落脚空行 —— 从不删掉光标所在的那一行、也不把光标送回上一行(09-18 用户报:空任务项再按回车,
 * 整行被删、光标跳回上一项)。
 */

beforeAll(() => {
  // jsdom 没有排版:量光标位置的那几个接口给个零盒子。
  const zero = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  Range.prototype.getBoundingClientRect ??= zero
  Range.prototype.getClientRects ??= (() => []) as unknown as () => DOMRectList
})

afterEach(() => { cleanup() })

function setup(text: string) {
  const document = new EditorDocument(text, 'r0', {
    submit: async () => ({ ok: true, revision: 'r1', content: '' }) as never,
    requestReload: () => {},
  })
  const ref = createRef<CaretController | null>() as { current: CaretController | null }
  const view = render(<EditableDoc document={document} mode="none" label="doc" addLabel="add" checkLabel={() => 'check'} controllerRef={ref} />)
  const controller = () => ref.current!
  const group = view.container.querySelector<HTMLElement>('[role="group"]')!
  const press = (key: string, init: KeyboardEventInit = {}) => act(() => { fireEvent.keyDown(group, { key, ...init }) })
  const type = (data: string) => act(() => {
    const event = new InputEvent('beforeinput', { inputType: 'insertText', data, bubbles: true, cancelable: true })
    group.dispatchEvent(event)
  })
  const at = (line: number, offset: number | 'end') => act(() => { controller().open(line, offset) })
  return { document, controller, press, type, at, text: () => document.lines.join('\n'), caret: () => controller().snapshot() }
}

describe('列表项', () => {
  it('空任务项第一下回车新起一项;第二下回车退出列表,原地落脚,光标不跳回上一项', () => {
    const t = setup('- [ ] 甲')
    t.at(0, 'end')
    t.press('Enter')
    expect(t.text()).toBe('- [ ] 甲\n- [ ] ')
    expect(t.caret()?.start).toBe(1)
    t.press('Enter')
    // 上一行是列表项:垫一个分隔空行,写下的字才不会被读成「甲」的续行。
    expect(t.text()).toBe('- [ ] 甲\n\n')
    expect(t.caret()).toMatchObject({ start: 2, value: '' })
    t.type('乙')
    expect(t.text()).toBe('- [ ] 甲\n\n乙')
  })

  it('落脚空行一个字没写就离开:连垫的空行一起收掉,文档回到只有「甲」', () => {
    const t = setup('- [ ] 甲')
    t.at(0, 'end')
    t.press('Enter')
    t.press('Enter')
    t.press('ArrowUp')
    expect(t.text()).toBe('- [ ] 甲')
    expect(t.caret()?.start).toBe(0)
  })

  it('落脚空行上退格:并回上一项末尾', () => {
    const t = setup('- [ ] 甲')
    t.at(0, 'end')
    t.press('Enter')
    t.press('Enter')
    act(() => {
      t.controller().handleBeforeInput(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', cancelable: true }))
    })
    expect(t.text()).toBe('- [ ] 甲')
    expect(t.caret()).toMatchObject({ start: 0, focus: 1 })
  })

  it('列表中间的空项退出:列表在这里断开,下面的项不动', () => {
    const t = setup('- [ ] 甲\n- [ ] \n- [ ] 丙')
    t.at(1, 0)
    t.press('Enter')
    expect(t.text()).toBe('- [ ] 甲\n\n\n- [ ] 丙')
    expect(t.caret()?.start).toBe(2)
  })

  it('缩进的空项先退一层,再按才退出列表', () => {
    const t = setup('- [ ] 甲\n  - [ ] ')
    t.at(1, 0)
    t.press('Enter')
    expect(t.text()).toBe('- [ ] 甲\n- [ ] ')
    t.press('Enter')
    expect(t.text()).toBe('- [ ] 甲\n\n')
  })

  it('光标在字最前面:上面插一个空项,光标跟着字走,勾选状态留在原项', () => {
    const t = setup('- [x] 做完的')
    t.at(0, 0)
    t.press('Enter')
    expect(t.text()).toBe('- [ ] \n- [x] 做完的')
    expect(t.caret()).toMatchObject({ start: 1, focus: 0 })
  })

  it('有序列表拆一项:后面的兄弟顺延编号,子项不动', () => {
    const t = setup('1. 甲\n2. 乙\n   1. 子\n3. 丙')
    t.at(0, 'end')
    t.press('Enter')
    expect(t.text()).toBe('1. 甲\n2. \n3. 乙\n   1. 子\n4. 丙')
  })

  it('圆点项、有序项退出规则相同', () => {
    const t = setup('- 甲\n- ')
    t.at(1, 0)
    t.press('Enter')
    expect(t.text()).toBe('- 甲\n\n')
    const o = setup('1. 甲\n2. ')
    o.at(1, 0)
    o.press('Enter')
    expect(o.text()).toBe('1. 甲\n\n')
  })

  it('选中一段再回车:先删掉选中的字再拆', () => {
    const t = setup('- [ ] 甲乙丙')
    act(() => { t.controller().open(0, 1, 2) })
    t.press('Enter')
    expect(t.text()).toBe('- [ ] 甲\n- [ ] 丙')
  })
})

describe('标题', () => {
  it('末尾回车起一个任务项(待办文档的约定)', () => {
    const t = setup('## 节')
    t.at(0, 'end')
    t.press('Enter')
    expect(t.text()).toBe('## 节\n- [ ] ')
  })

  it('光标在字最前面:标题原样不动;上面是列表就接一项', () => {
    const t = setup('- [ ] 甲\n\n## 节')
    t.at(2, 3)
    t.press('Enter')
    expect(t.text()).toBe('- [ ] 甲\n- [ ] \n\n## 节')
    expect(t.caret()?.start).toBe(1)
  })

  it('光标在字最前面、上面不是列表:在标题上面落脚', () => {
    const t = setup('# 清单')
    t.at(0, 2)
    t.press('Enter')
    expect(t.text()).toBe('\n# 清单')
    expect(t.caret()?.start).toBe(0)
  })

  it('空标题回车:去掉 #,原地落脚', () => {
    const t = setup('- [ ] 甲\n\n## ')
    t.at(2, 'end')
    t.press('Enter')
    expect(t.text()).toBe('- [ ] 甲\n\n')
    expect(t.caret()?.start).toBe(2)
  })
})

describe('引用', () => {
  it('有字回车接一行 `> `;空的 `>` 行再回车退出引用,在下面落脚', () => {
    const t = setup('> 甲')
    t.at(0, 'end')
    t.press('Enter')
    expect(t.text()).toBe('> 甲\n> ')
    t.type('乙')
    expect(t.text()).toBe('> 甲\n> 乙')
    t.press('Enter')
    t.press('Enter')
    expect(t.text()).toBe('> 甲\n> 乙\n\n')
    expect(t.caret()).toMatchObject({ start: 3, value: '' })
  })
})

describe('段落', () => {
  it('回车是段内换行;第二下回车(当前行是空行)另起一段落脚', () => {
    const t = setup('甲')
    t.at(0, 'end')
    t.press('Enter')
    t.type('乙')
    expect(t.text()).toBe('甲\n乙')
    t.press('Enter')
    t.press('Enter')
    expect(t.text()).toBe('甲\n乙\n\n')
    expect(t.caret()).toMatchObject({ start: 3, value: '' })
    t.press('Enter')
    expect(t.text()).toBe('甲\n乙\n\n')
  })

  it('落脚空行上打 `- [ ] ` 就变回任务项', () => {
    const t = setup('- [ ] 甲')
    t.at(0, 'end')
    t.press('Enter')
    t.press('Enter')
    // 打到 `- [ ]` 那一下这一行就认作任务项了(之后的空格算正文),所以不再补空格。
    for (const ch of '- [ ]乙') t.type(ch)
    expect(t.text()).toBe('- [ ] 甲\n\n- [ ] 乙')
  })
})

describe('代码块', () => {
  it('回车永远是换行,空行上也不退出', () => {
    const t = setup('```\na\n```')
    t.at(0, 'end')
    t.press('Enter')
    t.press('Enter')
    expect(t.text()).toBe('```\na\n\n\n```')
  })
})
