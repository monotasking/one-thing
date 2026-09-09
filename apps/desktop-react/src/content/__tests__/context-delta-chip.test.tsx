import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ContextDeltaChip, contextDeltaEntries, contextDeltaSummary } from '../ContextDeltaChip'
import { t } from '../../i18n'
import { useStageStore } from '../../stage/store'

/**
 * 上下文更新 chip 的四态(设计正本 `docs/compact-seam-2026-09.md` §3.2)。
 *
 * 值得进 jsdom 的只有**判据**那一半:出不出、头上那行字怎么算、展开列几行、
 * 墓碑行报不报身份、键盘开不开得了。至于「右对齐随气泡」「钳到 320px」——
 * 那是排版,jsdom 不排版,由真机门量(`gate:squeeze` / `gate:a11y`)。
 * 划线那一句是 CSS 的事实,所以按 `.ghost:disabled` 那条判例的办法:**读样式表**。
 */

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

const chip = () => screen.queryByTestId('context-delta-chip')

describe('上下文更新 chip:没有 delta 就没有这件东西', () => {
  it('turnContext 缺席 —— 一个像素都不占', () => {
    const { container } = render(<ContextDeltaChip />)
    expect(container.innerHTML).toBe('')
    expect(chip()).toBeNull()
  })

  it('turnContext 在,但 set / removed 都空 —— 同样不出', () => {
    const { container } = render(<ContextDeltaChip turnContext={{ set: {}, removed: [] }} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('折叠头:文字读数,不是徽标', () => {
  it('按名字归并计数,removed 合成一格「移除 N」', () => {
    render(
      <ContextDeltaChip
        turnContext={{
          set: { variables: 'cwd=/tmp', todo: '- [ ] A1' },
          removed: ['skills'],
        }}
      />,
    )
    expect(chip()?.textContent).toBe('上下文更新 · 变量 1 · 待办 1 · 移除 1')
  })

  it('同族多块读作一格 —— 三个插件提供方是「插件 3」,不是三段各说一遍', () => {
    const summary = contextDeltaSummary(
      t,
      contextDeltaEntries({
        set: {
          'plugin:log-monitor/default': 'a',
          'plugin:note-skills/notes': 'b',
          'plugin:note-skills/tags': 'c',
        },
      }),
    )
    expect(summary).toBe('上下文更新 · 插件 3')
  })

  it('壳不认识的块 id 原样显示 —— 数据照说,不报错也不吞掉', () => {
    render(<ContextDeltaChip turnContext={{ set: { 'lab:experiment': 'x' } }} />)
    expect(chip()?.textContent).toBe('上下文更新 · lab:experiment 1')
  })

  it('折叠是默认档 —— 压完那一刻用户在等回复,不在读这一段', () => {
    render(<ContextDeltaChip turnContext={{ set: { todo: '- [ ] A1' } }} />)
    expect(chip()?.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('context-delta-body').hasAttribute('hidden')).toBe(true)
  })
})

describe('展开:每块一行', () => {
  it('逐块列出,左列块名右列正文', () => {
    render(
      <ContextDeltaChip
        turnContext={{ set: { variables: 'cwd=/tmp', 'agents-md': '# 规则' } }}
      />,
    )
    fireEvent.click(chip()!)
    const body = screen.getByTestId('context-delta-body')
    expect(body.hasAttribute('hidden')).toBe(false)
    const rows = [...body.querySelectorAll('[data-block-id]')]
    expect(rows.map((row) => row.getAttribute('data-block-id'))).toEqual(['variables', 'agents-md'])
    expect(rows[0]?.textContent).toBe('变量cwd=/tmp')
    expect(rows[1]?.textContent).toBe('项目约定# 规则')
  })

  it('正文原样(换行是事实,不截字符串)', () => {
    render(<ContextDeltaChip turnContext={{ set: { todo: '- [ ] A1\n- [x] 文档' } }} />)
    fireEvent.click(chip()!)
    const row = screen.getByTestId('context-delta-body').querySelector('[data-block-id="todo"]')
    expect(row?.textContent).toBe('待办- [ ] A1\n- [x] 文档')
  })

  it('Enter 展开(结构键,由 ui/Fold 提供,本件不写第二份)', () => {
    render(<ContextDeltaChip turnContext={{ set: { todo: '- [ ] A1' } }} />)
    fireEvent.keyDown(chip()!, { key: 'Enter' })
    expect(chip()?.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('context-delta-body').hasAttribute('hidden')).toBe(false)
  })

  it('aria-controls 指向那份正文(FoldBody 挂载时自己登记的)', () => {
    render(<ContextDeltaChip turnContext={{ set: { todo: '- [ ] A1' } }} />)
    expect(chip()?.getAttribute('aria-controls')).toBe(
      screen.getByTestId('context-delta-body').id,
    )
  })
})

describe('removed:墓碑行', () => {
  it('排在 set 之后,报得出身份,正文是「已移除」', () => {
    render(<ContextDeltaChip turnContext={{ set: { todo: 'x' }, removed: ['skills'] }} />)
    fireEvent.click(chip()!)
    const rows = [...screen.getByTestId('context-delta-body').querySelectorAll('[data-block-id]')]
    expect(rows.map((row) => row.getAttribute('data-block-id'))).toEqual(['todo', 'skills'])
    const tomb = rows[1] as HTMLElement
    expect(tomb.getAttribute('data-removed')).toBe('')
    expect(tomb.textContent).toBe('技能已移除')
  })

  it('set 的行不带墓碑标记', () => {
    render(<ContextDeltaChip turnContext={{ set: { todo: 'x' } }} />)
    fireEvent.click(chip()!)
    const row = screen.getByTestId('context-delta-body').querySelector('[data-block-id="todo"]')
    expect(row?.hasAttribute('data-removed')).toBe(false)
  })

  /*
   * 划线是 CSS 的事实,jsdom 不算层叠 —— 按 `.ghost:disabled` 那条判例读样式表原文。
   * 读之前先剥注释(病历文本里出现同样的字会让断言自红,那是本仓的既有判例)。
   */
  it('墓碑整行划线(名字也划:说的是「这一块不在了」,不是「值变了」)', () => {
    const css = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../ChatStream.module.css'),
      'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = css.match(/\.ctxDeltaEntry\[data-removed\]\s*\{([^}]*)\}/)
    expect(rule?.[1]).toContain('text-decoration: line-through')
  })
})
