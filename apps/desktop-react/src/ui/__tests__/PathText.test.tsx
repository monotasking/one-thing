import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { PathText, abbreviateHome, splitPath } from '../PathText'

/**
 * `ui/PathText` 的三件事:**怎么拆**、**怎么缩**、**断在哪儿**。
 *
 * 断点那一条是这件基础件存在的理由(修前真机截图里路径在**连字符**处被掰成
 * 两截),所以它钉的是数量关系而不是某一串具体的 HTML:**`<wbr>` 数 = `/` 数**。
 */
describe('splitPath:目录与名字', () => {
  it('普通路径', () => {
    expect(splitPath('/a/b/c.ts')).toEqual({ dir: '/a/b', name: 'c.ts' })
  })

  it('尾随 `/` 先剥 —— `/a/b/` 说的是目录 b,父目录是 /a', () => {
    expect(splitPath('/a/b/')).toEqual({ dir: '/a', name: 'b' })
  })

  it('根自己没有父目录,也不该被剥成空串', () => {
    expect(splitPath('/')).toEqual({ dir: '', name: '/' })
  })

  it('裸名字(没有斜杠)', () => {
    expect(splitPath('a.ts')).toEqual({ dir: '', name: 'a.ts' })
  })

  it('多级 —— 只在最后一个斜杠处切一刀', () => {
    expect(splitPath('/Users/me/data/work/lenovo-scripts/ChatBot.lua')).toEqual({
      dir: '/Users/me/data/work/lenovo-scripts',
      name: 'ChatBot.lua',
    })
  })

  it('根下一层的父目录是根本身,不是空串', () => {
    expect(splitPath('/a.ts')).toEqual({ dir: '/', name: 'a.ts' })
  })
})

describe('abbreviateHome:家目录只是显示层', () => {
  it('整条就是家目录 → `~`', () => {
    expect(abbreviateHome('/Users/yitiansong', '/Users/yitiansong')).toBe('~')
  })

  it('家目录 + `/` 前缀 → `~` 加余下', () => {
    expect(abbreviateHome('/Users/yitiansong/data/work', '/Users/yitiansong')).toBe('~/data/work')
  })

  /**
   * **反证锚点**:把判据拆成 `startsWith(home)`(不要那条 `/`),这一条立刻红 ——
   * 同名前缀不是同一个目录,`/Users/yitiansongX` 是另一个人的家。
   */
  it('同名前缀不缩 —— `/Users/yitiansongX` 是另一个人的家', () => {
    expect(abbreviateHome('/Users/yitiansongX/a.ts', '/Users/yitiansong')).toBe(
      '/Users/yitiansongX/a.ts',
    )
  })

  it('home 为 null / 空 → 一个字都不缩', () => {
    expect(abbreviateHome('/Users/yitiansong/a.ts', null)).toBe('/Users/yitiansong/a.ts')
    expect(abbreviateHome('/Users/yitiansong/a.ts', '')).toBe('/Users/yitiansong/a.ts')
  })
})

describe('渲染', () => {
  /**
   * **反证锚点**:把 `<wbr />` 从 `withBreaks` 里拆掉,这一条立刻红。
   */
  it('每个 `/` 后面恰好一枚 `<wbr>`', () => {
    const path = '/Users/me/data/work/x.lua'
    const { container } = render(<PathText path={path} />)
    expect(container.querySelectorAll('wbr').length).toBe(path.split('/').length - 1)
    // 字仍然是全的 —— `<wbr>` 是零宽的断点机会,不吃字符。
    expect(container.textContent).toBe(path)
  })

  it('stacked:名字一行、目录一行', () => {
    const { container } = render(
      <PathText path="/Users/me/data/lenovo-scripts/ChatBot.lua" layout="stacked" />,
    )
    const spans = container.querySelectorAll('span')
    expect(spans.length).toBe(2)
    expect(spans[0]?.textContent).toBe('ChatBot.lua')
    expect(spans[1]?.textContent).toBe('/Users/me/data/lenovo-scripts')
  })

  it('stacked + home:目录行缩成 `~`,名字行不动', () => {
    const { container } = render(
      <PathText path="/Users/me/data/work/x.lua" home="/Users/me" layout="stacked" />,
    )
    const spans = container.querySelectorAll('span')
    expect(spans[0]?.textContent).toBe('x.lua')
    expect(spans[1]?.textContent).toBe('~/data/work')
  })

  it('`dir` → 名字行带回尾随 `/`,目录行是父目录', () => {
    const { container } = render(<PathText path="/Users/me/src" layout="stacked" dir />)
    const spans = container.querySelectorAll('span')
    expect(spans[0]?.textContent).toBe('src/')
    expect(spans[1]?.textContent).toBe('/Users/me')
  })

  it('没有父目录可说就不画第二行(空 block 只是提示体里多一行白)', () => {
    const { container } = render(<PathText path="a.ts" layout="stacked" />)
    const spans = container.querySelectorAll('span')
    expect(spans.length).toBe(1)
    expect(spans[0]?.textContent).toBe('a.ts')
  })
})
