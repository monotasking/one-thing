import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { sameTitleTip, titleTipText } from '../model/title-tip'
import { renderTitleTip } from '../title-tip'

/**
 * 「这段提示是一条路径」由**产地自述**,消费者只读表。这份用例钉的是那张表的
 * 两头:字符串形原样过去,路径形变成 `ui/PathText` 那两行。
 */
describe('renderTitleTip:读表,不猜', () => {
  it('字符串形原样交出去', () => {
    expect(renderTitleTip('npm run test -- --run', null)).toBe('npm run test -- --run')
  })

  it('缺席就是缺席(不挂提示的那一族)', () => {
    expect(renderTitleTip(undefined, null)).toBeUndefined()
  })

  /**
   * **一串长得像路径的字符串不该被画成路径** —— 消费者里没有
   * `if (looksLikePath(tip))`,所以它照旧是一句话、一个 `<span>` 都不多。
   */
  it('长得像路径的**字符串**照旧是一句话,不进 PathText', () => {
    const { container } = render(<>{renderTitleTip('cd /Users/me/src && ls', null)}</>)
    expect(container.querySelectorAll('span').length).toBe(0)
    expect(container.querySelectorAll('wbr').length).toBe(0)
    expect(container.textContent).toBe('cd /Users/me/src && ls')
  })

  it('路径形 → 名字一行 + 目录一行(家目录缩成 `~`)', () => {
    const { container } = render(
      <>{renderTitleTip({ path: '/Users/me/data/x.lua' }, '/Users/me')}</>,
    )
    const spans = container.querySelectorAll('span')
    expect(spans.length).toBe(2)
    expect(spans[0]?.textContent).toBe('x.lua')
    expect(spans[1]?.textContent).toBe('~/data')
  })

  it('路径形 + `dir` → 名字行带回尾随 `/`', () => {
    const { container } = render(<>{renderTitleTip({ path: '/Users/me/src', dir: true }, null)}</>)
    const spans = container.querySelectorAll('span')
    expect(spans[0]?.textContent).toBe('src/')
    expect(spans[1]?.textContent).toBe('/Users/me')
  })

  it('home 还没拿到(null)= 不缩,不闪', () => {
    const { container } = render(<>{renderTitleTip({ path: '/Users/me/data/x.lua' }, null)}</>)
    const spans = container.querySelectorAll('span')
    expect(spans[1]?.textContent).toBe('/Users/me/data')
  })
})

describe('titleTipText:字符串形给拼接与 aria', () => {
  it('字符串形就是它自己', () => {
    expect(titleTipText('rg foo')).toBe('rg foo')
  })

  it('路径形交的是**全路径**,不是画出来那份缩过的', () => {
    expect(titleTipText({ path: '/Users/me/a.ts' })).toBe('/Users/me/a.ts')
  })

  it('缺席传导', () => {
    expect(titleTipText(undefined)).toBeUndefined()
  })
})

/**
 * `sameTitleTip` 是 `stage/live-title` 那句短路的判据。它必须**按值**比 ——
 * 路径形是产地每次现造的对象,用 `===` 的话每一次发布都判成「变了」。
 */
describe('sameTitleTip:按值比', () => {
  it('两个现造的同值路径形相等', () => {
    expect(sameTitleTip({ path: '/a' }, { path: '/a' })).toBe(true)
    expect(sameTitleTip({ path: '/a', dir: true }, { path: '/a', dir: true })).toBe(true)
  })

  it('路径不同 / 目录位不同 / 跨形 / 缺席,都不等', () => {
    expect(sameTitleTip({ path: '/a' }, { path: '/b' })).toBe(false)
    expect(sameTitleTip({ path: '/a' }, { path: '/a', dir: true })).toBe(false)
    expect(sameTitleTip({ path: '/a' }, '/a')).toBe(false)
    expect(sameTitleTip({ path: '/a' }, undefined)).toBe(false)
  })

  it('都缺席 = 相等', () => {
    expect(sameTitleTip(undefined, undefined)).toBe(true)
  })
})
