import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { useStageStore } from '../../../../stage/store'
import type { BlockModel } from '../../../model/blocks'
import { BlockView } from '../../BlockView'
import type { BlockCtx } from '../../registry'
import { isKatexReady, loadKatex, mathCacheSizeForTest, renderTex, resetKatexForTest } from '../katex'

/**
 * 公式上屏。
 *
 * ── 这里用的是**真 KaTeX**,不是 mock ────────────────────────────────────
 * 与图块那一组(mermaid 必须 mock:它要量文字宽度、要真排版)正相反 ——
 * `renderToString` 是一个**纯函数**:字符串进,字符串出,不碰 DOM、不量任何东西,
 * 在 jsdom 里跑出来的产物与真机上逐字节相同。mock 掉它反而会让这一组只测到
 * 「我们自己那几行胶水」,而这里要守的恰恰包括「`trust: false` 到底拦不拦得住」——
 * 那句话只有真库答得出。
 */

const ctx: BlockCtx = { messageId: 'm1', streaming: false }

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetKatexForTest()
})

/** 库到了之后再画 —— 那正是「首帧同步命中」那条要求成立的前提。 */
async function withKatex() {
  await act(async () => {
    await loadKatex()
  })
}

describe('渲染闸', () => {
  it('库没到时 isKatexReady() 为假,renderTex 拒绝被调(它不是降级路)', () => {
    expect(isKatexReady()).toBe(false)
    expect(() => renderTex('x', false)).toThrow(/还没拉到/)
  })

  it('库到了之后是同步的,而且同源不二渲(同一段 TeX 拿到同一个对象)', async () => {
    await withKatex()
    expect(isKatexReady()).toBe(true)
    expect(renderTex('a^2', false)).toBe(renderTex('a^2', false))
  })

  it('行内与居中是两格缓存 —— 两档的产物本来就不一样', async () => {
    await withKatex()
    expect(renderTex('\\sum_{i=1}^{n} i', true)).not.toBe(renderTex('\\sum_{i=1}^{n} i', false))
  })

  it('排不出来的那一段也进缓存(失败也缓存),交出 KaTeX 的原话', async () => {
    await withKatex()
    const first = renderTex('\\frac{', false)
    expect(first.status).toBe('error')
    expect(first).toBe(renderTex('\\frac{', false))
  })
})

describe('行内公式三态', () => {
  /** 一段只装着一条公式的正文 —— 行内那一档的最小现场。 */
  const inlineMath = (tex: string): BlockModel => ({
    kind: 'paragraph',
    inline: [{ type: 'math', tex }],
  })
  const paragraph = inlineMath('a^2')

  it('库还没到 → 原文 `$a^2$` 当普通文字', () => {
    render(<BlockView block={paragraph} ctx={ctx} />)
    expect(screen.getByText('$a^2$')).toBeTruthy()
  })

  it('库到了 → **首帧**就是排好的公式,不先闪一帧源码', async () => {
    await withKatex()
    const { container } = render(<BlockView block={paragraph} ctx={ctx} />)
    // 一次 await 都没有:这就是「首帧同步命中」的机器判据(消息行会被反复挂载,
    // 每次先画一帧源码再换装就是满屏抖动)。
    expect(container.querySelector('.katex')).toBeTruthy()
    expect(screen.queryByText('$a^2$')).toBeNull()
  })

  it('排不出来 → 仍是原文,而且标着 data-failed(那一格挂着 KaTeX 的原话)', async () => {
    await withKatex()
    render(<BlockView block={inlineMath('\\frac{')} ctx={ctx} />)
    const node = screen.getByText('$\\frac{$')
    expect(node.getAttribute('data-failed')).toBe('')
  })
})

describe('块公式三态', () => {
  it('还没收尾(流式中)→ 那段 TeX 源码', () => {
    render(<BlockView block={{ kind: 'math', source: 'E=mc', closed: false }} ctx={ctx} />)
    expect(screen.getByText('E=mc')).toBeTruthy()
  })

  it('还没收尾时**库到了也不排** —— 半截 TeX 不进缓存(否则几十帧就把缓存冲掉)', async () => {
    await withKatex()
    const frames = ['\\frac{', '\\frac{a', '\\frac{a}{', '\\frac{a}{b']
    const { rerender } = render(<BlockView block={{ kind: 'math', source: frames[0], closed: false }} ctx={ctx} />)
    for (const source of frames.slice(1)) {
      rerender(<BlockView block={{ kind: 'math', source, closed: false }} ctx={ctx} />)
    }
    expect(mathCacheSizeForTest()).toBe(0)
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('收尾了 + 库到了 → KaTeX 的 display 产出', async () => {
    await withKatex()
    const { container } = render(
      <BlockView block={{ kind: 'math', source: 'E=mc^2', closed: true }} ctx={ctx} />,
    )
    expect(container.querySelector('.katex-display')).toBeTruthy()
  })

  it('排不出来 → 源码 + 一行灰说明(说明是 KaTeX 的原话,不改写)', async () => {
    await withKatex()
    render(<BlockView block={{ kind: 'math', source: '\\frac{', closed: true }} ctx={ctx} />)
    expect(screen.getByText('\\frac{')).toBeTruthy()
    expect(screen.getByRole('note').textContent).toContain('这条公式没排出来')
  })

  it('块公式是 flow —— 没有檐、没有动作(它是纸上的一句话,不是一件被引用的东西)', async () => {
    await withKatex()
    const { container } = render(
      <BlockView block={{ kind: 'math', source: 'x', closed: true }} ctx={ctx} />,
    )
    expect(container.querySelector('[data-block-kind]')).toBeNull()
    expect(container.querySelector('header')).toBeNull()
  })
})

/** 这棵子树里所有元素的所有属性值 —— 安全断言看的是属性,不是文字。 */
function attributeValues(root: Element): string[] {
  const out: string[] = []
  for (const el of root.querySelectorAll('*')) {
    for (const attr of el.attributes) out.push(attr.value)
  }
  return out
}

describe('trust: false 是这套上屏的安全边界', () => {
  it('\\href{javascript:…} 产不出一条点得动的链接', async () => {
    await withKatex()
    const { container } = render(
      <BlockView
        block={{ kind: 'math', source: '\\href{javascript:alert(1)}{点我}', closed: true }}
        ctx={ctx}
      />,
    )
    expect(container.querySelectorAll('a')).toHaveLength(0)
    /*
     * 那串 `javascript:` 确实还在屏幕上 —— 它落在 MathML 的 `<annotation>` 里
     * (KaTeX 把原始 TeX 原样存进去给读屏用),而且 `\href` 本身被画成了一个红色的
     * 文字记号。**当成字显示不是漏网,当成属性才是** —— 所以判据是「没有任何一个
     * 属性值里带着它」,不是「这几个字符不许出现」。
     */
    expect(attributeValues(container)).not.toContain('javascript:alert(1)')
  })

  it('\\includegraphics 同样不产出任何外链资源', async () => {
    await withKatex()
    const { container } = render(
      <BlockView
        block={{ kind: 'math', source: '\\includegraphics[width=1em]{http://x/y.png}', closed: true }}
        ctx={ctx}
      />,
    )
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })
})
