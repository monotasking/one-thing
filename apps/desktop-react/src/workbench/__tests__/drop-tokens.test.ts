import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DROP_BAR_PX, DROP_EDGE_PX } from '../drop'

/**
 * **两处各一份同一个数,由这只文件钉成相等**(W3-b)。
 *
 * W3 那时的裁法是「不登记」:派工令列过一格 `--drop-inset: 25%`,施工时发现它
 * **没有读者**(高亮的矩形是纯函数算好之后整块递过去的),而一格没人读的 CSS
 * 变量迟早与判据分叉,所以那一格没有落地。
 *
 * W3-b 的两个数不一样:`--drop-edge` / `--drop-bar-w` 是**设计册上的登记**
 * (设计系统要答得出「分屏带多宽、预示杠多厚」),而 `DROP_EDGE_PX` /
 * `DROP_BAR_PX` 是判据非有不可的那个数 —— 杠的厚度必须进几何,否则用 CSS
 * `min-width` 撑出来的那 4px 会从叶的右缘往**外**长(违反「高亮不撑破叶」)。
 *
 * 两处都要,那就把「迟早分叉」这句话变成一条会红的断言:**改一边当场红**。
 * 这比删掉登记更诚实 —— 它把 W3 那条判词从「所以不登记」升级成「所以钉住」。
 */

const tokens = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../styles/tokens.css'),
  'utf-8',
)

/** 读一格 token 的像素值。**先剥注释** —— 病历文本里也写着这些数字。 */
function pxOf(name: string): number | null {
  const body = tokens.replace(/\/\*[\s\S]*?\*\//g, '')
  const hit = new RegExp(`--${name}\\s*:\\s*(-?[\\d.]+)px`).exec(body)
  return hit ? Number(hit[1]) : null
}

describe('落点几何:token 登记与判据镜像必须相等', () => {
  it('--drop-edge === DROP_EDGE_PX', () => {
    expect(pxOf('drop-edge')).toBe(DROP_EDGE_PX)
  })

  it('--drop-bar-w === DROP_BAR_PX', () => {
    expect(pxOf('drop-bar-w')).toBe(DROP_BAR_PX)
  })

  /*
   * 16 与 24 刻意**不相等**(裁定 3「三处三个名字」的同一条纪律):它们量的是
   * 两条不同的边,而且窗口边带优先。两个数相等会让「这一格是被哪条带接住的」
   * 在读代码时不再看得出来。
   */
  it('叶边带与窗口边带不是同一个数', () => {
    expect(DROP_EDGE_PX).not.toBe(24)
  })

  /** `joined` 档那几格也在册上(缺一格 = 那一档在真机上塌成 line 档)。 */
  it('joined 档的几何全部登记在 tokens.css', () => {
    expect(pxOf('tab-joined-h')).toBeGreaterThan(0)
    expect(pxOf('tab-joined-r')).toBeGreaterThan(0)
    expect(pxOf('tab-shoulder')).toBeGreaterThan(0)
    expect(pxOf('tab-sep-inset')).toBeGreaterThan(0)
  })

  /*
   * **肩的边长 = 条的左右内边距**(`Tabs.module.css` 的 `padding-inline`)。
   * 「肩永远在组内」这句话是这一条等式撑着的,而它今天由同一格 token 保证 ——
   * 这只用例守的是「有人给条改了内边距却忘了肩」那一天。
   */
  it('条的左右内边距读的就是肩那一格(肩因此永远在条里)', () => {
    const css = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../ui/Tabs.module.css'),
      'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/\.bar\[data-look='joined'\][\s\S]*?padding-inline:\s*var\(--tab-shoulder\)/)
  })

  /**
   * **顶栏不许再自绘 tab 皮肤**(裁定 2:皮肤归 `ui/Tabs`,顶栏只留几何)。
   * 反证之一钉的就是这一条:把 joined 的皮肤抄回 `TopBarTabs.module.css` 当场红。
   */
  it('TopBarTabs 里没有一句 tab 皮肤', () => {
    const css = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../TopBarTabs.module.css'),
      'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    /*
     * 画皮肤 = 对着 tab 写底色 / 描边 / 圆角。改字色那一格走的是 `--tab-joined-ink`
     * 变量,不在这条规则的射程里。
     *
     * **两种引号都认**(反证当场量出来的):CSS 里 `[role='tab']` 与 `[role="tab"]`
     * 是同一个选择器,而抄一份皮肤回来的人不会特意挑我们用的那一种 —— 只认单引号
     * 的断言在反证里当场绿了一次,那等于这条守卫是假的。
     */
    const tabRules = css.match(/\[role=['"]tab['"]\][^{]*\{[^}]*\}/g) ?? []
    for (const rule of tabRules) {
      expect(rule).not.toMatch(/\bbackground\s*:/)
      expect(rule).not.toMatch(/\bborder(-radius)?\s*:/)
      expect(rule).not.toMatch(/\bbox-shadow\s*:/)
    }
    expect(css).not.toMatch(/--topbar-tab-face/)
  })
})
