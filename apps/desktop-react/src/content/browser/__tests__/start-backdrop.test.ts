import { describe, expect, it } from 'vitest'
import { browserBodyPhase } from '../start-backdrop'

/**
 * **叶正文三档的判据**(2026-09-17)。这一份只量那只纯函数 —— 屏幕上真的画了
 * 什么在 `browser-b3b.test.tsx` 的「起始页」那一节里,真机上那片视图什么时候
 * 透明在 `gate:browser`。三层各管一段,不互相复刻。
 */
describe('browserBodyPhase', () => {
  it('空标签页(没地址、也没在加载)= start:只画起始页,不报帧', () => {
    expect(browserBodyPhase({ url: '', loading: false }, false)).toBe('start')
  })

  it('从起始页出发的第一次加载 = warming:占位格在,起始页留作底', () => {
    expect(browserBodyPhase({ url: 'https://x.test', loading: true }, false)).toBe('warming')
  })

  /*
   * 加载那一段 `loading` 会抖(`did-start-loading` / `did-stop-loading` 在一次
   * 导航里来回好几发,重定向更是一段一段来)。**还没成功停下来过之前一律 warming**
   * —— 判据是那格闩,不是此刻 `loading` 的真假,不然底会跟着抖,而那正是这一单
   * 要治的那一闪。
   */
  it('加载期间 loading 抖到 false,只要闩没翻仍是 warming', () => {
    expect(browserBodyPhase({ url: 'https://x.test', loading: false }, false)).toBe('warming')
  })

  it('成功停下来过一次 → live,之后什么行都不再画底', () => {
    expect(browserBodyPhase({ url: 'https://x.test', loading: false }, true)).toBe('live')
    // 第二次导航(又在加载了)照样是 live:换页由 Chromium 自己留着上一页的画面。
    expect(browserBodyPhase({ url: 'https://y.test', loading: true }, true)).toBe('live')
    // 闩赢过一切,连「表里这一格没了」都盖得住 —— 它说的是一段历史。
    expect(browserBodyPhase(undefined, true)).toBe('live')
  })

  it('row 缺席 = start(这只函数自己那一口径;叶那一侧另判,见 BrowserLeaf)', () => {
    expect(browserBodyPhase(undefined, false)).toBe('start')
  })
})
