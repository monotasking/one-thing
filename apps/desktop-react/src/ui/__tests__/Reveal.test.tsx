import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Reveal, REVEAL_SCOPE } from '../Reveal'

/**
 * `ui/Reveal` 的门。这件的行为**全在 CSS 里**(jsdom 不跑层叠,`getComputedStyle`
 * 读不出 `[data-reveal-scope]:hover` 那一支),所以判据分两半:
 *   · 渲染那一半按 DOM 断言 —— **占位常驻**(不管有没有 hover,那颗钮都在树上);
 *   · 配方那一半**读样式表源文本**(先剥注释,本仓既有纪律:病历文本会让断言自红):
 *     休止 opacity 0、作用域 hover 与 `:focus-within` 两支都在、过渡走
 *     `--dur-hover-fade`。这三条是文件头那三条纪律的机器化。
 */
const CSS = readFileSync(path.resolve(__dirname, '../Reveal.module.css'), 'utf-8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

describe('Reveal', () => {
  it('占位常驻:不管有没有指针,塞进去的那颗钮都在树上', () => {
    render(
      <li {...REVEAL_SCOPE}>
        <Reveal>
          <button type="button">改</button>
        </Reveal>
      </li>,
    )
    expect(screen.getByRole('button', { name: '改' })).toBeTruthy()
  })

  it('作用域属性摊得开,而且落在宿主元素上', () => {
    const { container } = render(<li {...REVEAL_SCOPE}>x</li>)
    expect(container.querySelector('li')!.hasAttribute('data-reveal-scope')).toBe(true)
  })

  it('① 休止只动 opacity —— 不许用 display:none / visibility(那会推开旁边的东西)', () => {
    expect(CSS).toMatch(/opacity:\s*0/)
    expect(CSS).not.toMatch(/display:\s*none/)
    expect(CSS).not.toMatch(/visibility:\s*hidden/)
  })

  it('② 判据挂在作用域上,③ 键盘与 hover 同权', () => {
    expect(CSS).toContain('[data-reveal-scope]:hover .reveal')
    expect(CSS).toContain('[data-reveal-scope]:focus-within .reveal')
  })

  it('浮现走装饰档的时长 token,不是一个字面 ms', () => {
    expect(CSS).toContain('var(--dur-hover-fade)')
    expect(CSS).not.toMatch(/\d+ms/)
  })
})
