import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HostTitle } from '../HostTitle'
import hostTitleCss from '../HostTitle.module.css'
import statusDotCss from '../../ui/StatusDot.module.css'
import { useLiveTitleStore } from '../../stage/live-title'

/**
 * **宿主檐上那颗未保存丸的收编(09-02 批 8b)。**
 *
 * 它从前是本地一份 `.dot` 配方(5px 圆 + `--warn` 实心),`ui:consume` 的
 * `shared-vocab-css` 把它记成 `dot` 这个词的第 N 个产地。批 8a 给
 * `ui/StatusDot` 补了 `sm`(5px)档之后,它与库件**逐字同色同大小**,于是收编。
 *
 * 判据照 `providers/components/__tests__/vocab-migration.test.tsx` 那一组:
 * 不比「长什么样」(那是截图的事),比**它到底是不是那件库件画的** ——
 * 渲染出来的 class 与 `ui/StatusDot.module.css` 导出的 class 是同一个值。
 *
 * 反证:把 `<StatusDot>` 换回本地 `<span className={s.dot}>` → 三条全红。
 */
beforeEach(() => {
  useLiveTitleStore.setState({ titles: {} })
})

function publish(dirty: boolean) {
  useLiveTitleStore.getState().setLiveTitle('viewer', { text: 'engine.ts', dirty })
}

describe('HostTitle:未保存丸由 ui/StatusDot 画', () => {
  it('没有未保存改动时那颗丸整个不渲染', () => {
    publish(false)
    render(<HostTitle id="viewer" fallback="查看器" />)
    expect(screen.queryByTestId('host-title-dirty')).toBeNull()
  })

  it('有未保存改动时画的是 StatusDot 的 warn × sm 档', () => {
    publish(true)
    render(<HostTitle id="viewer" fallback="查看器" />)
    const slot = screen.getByTestId('host-title-dirty')
    const dot = slot.firstElementChild as HTMLElement
    expect(dot).toBeTruthy()
    expect(dot.classList.contains(statusDotCss.dot)).toBe(true)
    expect(dot.classList.contains(statusDotCss.warn)).toBe(true)
    // `sm` 是 5px 那一档 —— 缺了它这颗丸会从 5px 胖到 6px(缺省 md)。
    expect(dot.classList.contains(statusDotCss.sm)).toBe(true)
    // 旁边就写着文件名,丸是纯装饰:给它一个名字等于让读屏软件念两遍。
    expect(dot.getAttribute('aria-hidden')).toBe('true')
    expect(dot.getAttribute('aria-label')).toBeNull()
  })

  it('本地只剩「落位」两格,丸自己的几何与底色已经删干净', () => {
    // CSS Modules 在 vitest 里是一只 proxy(任何键都返回类名),所以「删没删」
    // 只能读源文本。先剥注释 —— 病历里正写着这些名字。
    const css = readFileSync(path.resolve(__dirname, '../HostTitle.module.css'), 'utf-8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    expect(css).not.toContain('--files-open-dot')
    expect(css).not.toContain('--warn')
    expect(css).not.toContain('border-radius')
    // 留下的两格是这条檐自己的排版,不是「一枚状态点」的事实。
    // 名字也换了:它是那枚点的**落位**,不再是「一枚点」——
    // `shared-vocab-css` 数的是 `.dot` 这个词的产地,留旧名字等于赖着不走。
    expect(css).not.toContain('.dot ')
    expect(css).toContain('.dirtySlot')
    expect(css).toContain('margin-left')
    expect(css).toContain('vertical-align')
    expect(hostTitleCss.dirtySlot).toBeTruthy()
  })
})
