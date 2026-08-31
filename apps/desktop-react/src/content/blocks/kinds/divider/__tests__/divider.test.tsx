import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BlockView } from '../../../BlockView'
import type { BlockCtx } from '../../../registry'

/**
 * 分隔线的门。
 *
 * 它只钉一件事,而这一件事是 08-31 真机报障的真因:**这条线画得出来**。
 *
 * ── 病历:一条宽 0 的横线 ──────────────────────────────────────────────
 * `<hr>` 的 UA 样式带 `margin-inline: auto`。承载块的 `.row` 是 flex 列,而 flex
 * 布局里**交叉轴上的 auto 边距会吃掉全部剩余空间并关掉 stretch** —— 真机量出来是
 * 宽 0 / 左右各 300px 边距 / 高 1px:上下的 --pr-hr 照留(所以间距看着像多了一档),
 * 唯独线本身一个像素都不落。屏幕上就是「`---` 那儿只剩一段空白」。
 * 邻接表那条 `.row > * { margin-block: 0 }` 只清块向边距,清不到这一格。
 *
 * 与引用块 `margin-inline: 0` 那条(quote.test.tsx ③)是**同一类病**:UA 给的
 * 行内边距,块自己不清就没人清。所以断言也照那边的写法读 CSS 文本 —— jsdom 不跑
 * CSS Modules 的样式表,布局在这一层量不出来。
 */

const rulesOf = (file: string): string =>
  readFileSync(path.resolve(__dirname, file), 'utf-8')
    // 掏掉注释再断言:病历正大光明写在文件头注里,不该被当成声明读进来。
    .replace(/\/\*[\s\S]*?\*\//g, '')

const css = rulesOf('../Divider.module.css')

const ctx = { messageId: 'm', live: false } as unknown as BlockCtx

describe('分隔线块', () => {
  it('画出来的是 <hr data-prose="hr"> —— 语义与节奏钩子都在标签上', () => {
    const { container } = render(<BlockView block={{ kind: 'divider' }} ctx={ctx} />)
    const hr = container.querySelector('hr')
    expect(hr).not.toBeNull()
    expect(hr?.getAttribute('data-prose')).toBe('hr')
  })

  it('UA 的 margin-inline 已清 —— 否则 flex 列里这条线宽 0(08-31 真机报障)', () => {
    expect(css).toMatch(/margin-inline:\s*0/)
  })

  it('线是发丝一条:--bw-1 × --line-1,零字面色值零字面几何', () => {
    expect(css).toMatch(/border-block-start:\s*var\(--bw-1\)\s+solid\s+var\(--line-1\)/)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/\b\d+(?:\.\d+)?px\b/)
  })

  it('上下留白不在块里 —— 节奏归邻接表(同特异性两条规则抢一个值只会看打包顺序)', () => {
    expect(css).not.toMatch(/margin-block/)
  })
})
