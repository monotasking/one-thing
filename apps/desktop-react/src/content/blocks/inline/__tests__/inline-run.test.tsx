import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InlineRun } from '../InlineRun'
import type { InlineNode } from '../../../model/inline'
import { useStageStore } from '../../../../stage/store'

/**
 * 行内图那一支(正本 §4)。
 *
 * 守两件事:①它画成一颗**芯片**而不是一张 `<img>` —— 段落是 `pre-wrap` 的一段字,
 * 塞一件高度要等网络才知道的物件会把行律破掉;②读屏那一句里有「图片」两个字 ——
 * 芯片上只有名字,少了那两个字念出来就是一个来历不明的词。
 */
beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

const draw = (nodes: InlineNode[]) => render(<InlineRun nodes={nodes} />)

describe('行内图 = 一颗芯片', () => {
  it('画的是芯片,**不是 `<img>`**', () => {
    const { container } = draw([
      { type: 'image', ref: { kind: 'url', url: 'https://x.com/a.png' }, alt: '一只猫' },
    ])
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByLabelText('图片 一只猫')).toBeTruthy()
  })

  it('芯片上写的是 alt', () => {
    draw([{ type: 'image', ref: { kind: 'url', url: 'x.png' }, alt: '一只猫' }])
    expect(screen.getByLabelText('图片 一只猫').textContent).toBe('一只猫')
  })

  it('alt 空就退到地址末段 —— 芯片上永远有个说得出口的名字', () => {
    draw([{ type: 'image', ref: { kind: 'url', url: 'https://x.com/pics/cat.png?v=2' }, alt: '' }])
    expect(screen.getByLabelText('图片 cat.png')).toBeTruthy()
  })

  it('非交互:不是按钮、不挂 role', () => {
    draw([{ type: 'image', ref: { kind: 'url', url: 'x.png' }, alt: 'a' }])
    const chip = screen.getByLabelText('图片 a')
    expect(chip.tagName).toBe('SPAN')
    expect(chip.getAttribute('role')).toBeNull()
  })

  it('图与字混排:字照常是纯文本,芯片只多一颗', () => {
    const { container } = draw([
      { type: 'text', text: '看这个 ' },
      { type: 'image', ref: { kind: 'url', url: 'x.png' }, alt: 'a' },
      { type: 'text', text: ' 好看吧' },
    ])
    expect(container.textContent).toBe('看这个 a 好看吧')
  })
})
