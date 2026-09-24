import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GHOST_FLIP_PX } from '../../ui/drag/DragLayer'

/**
 * **两处各一份同一个数,由这只文件钉成相等**(W3-b),外加几条「退役的东西别种回来」。
 *
 * 只登记 CSS 与 JS 两头**都有读者**的数(`--drag-flip-edge` / `GHOST_FLIP_PX`)。
 * 落点判据里的比例(09-24 起是 `NEW_SHELF_ZONE` / `SPLIT_BAND`,各 30%)不进这张表:
 * 没有一条 CSS 规则读得到它们,屏幕上画的是判完之后那块矩形,给它们造 token 就是造一个
 * 没有读者的变量。
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
  it('--drag-flip-edge === GHOST_FLIP_PX', () => {
    expect(pxOf('drag-flip-edge')).toBe(GHOST_FLIP_PX)
  })

  /** 09-24 退役的两格判据常量不许回来(12px 窄边带与 28% 并排带)。 */
  it('NEW_SHELF_BAND / PAIR_BAND 已退役', async () => {
    const drop = (await import('../drop')) as Record<string, unknown>
    expect(drop.NEW_SHELF_BAND).toBeUndefined()
    expect(drop.PAIR_BAND).toBeUndefined()
  })

  /**
   * **氛围层随 U1 退役**(用户报障「一拖整窗变色」)。与下面那条 `--drop-edge`
   * 同一种守卫,只是方向反过来:这一格 token **不许再存在** —— 它的读者
   * (`.ambient` 与 `ambientRectsOf`)已经删干净,留一格没人读的 6% 主题色在册上,
   * 下一个人照着它把整窗淡亮种回来只要一行。
   */
  it('--drop-ambient 与 ambientRectsOf 一起删干净', async () => {
    expect(pxOf('drop-ambient')).toBeNull()
    expect(tokens).not.toMatch(/--drop-ambient\s*:/)
    const drop = (await import('../drop')) as Record<string, unknown>
    expect(drop.ambientRectsOf).toBeUndefined()
    expect(drop.tabMiddleAt).toBeUndefined()
  })

  /**
   * **二合一那一圈随 U2 退役**(2026-09-08,用户裁定「压到标签上」整条带删掉)。
   *
   * 与 `--drop-ambient` 同一种守卫:`--drop-ring-line` 唯一的读者是
   * `ui/Tabs.module.css` 的 `[data-pair-hot]`,那一格与它一起删干净。真机量到的是
   * **那一圈被抬起的标签盖住 92%**(抬起那格 `z-index: 2`、底不透明、还在跟手),
   * 所以留一格没人读的落区色在册上,下一个人照着它把那圈种回来只要一行。
   * 编舞那一头的 `hover()` / `markPair()` 一并没了(`tabs-joined.test.tsx` 守着)。
   */
  it('--drop-ring-line 与 [data-pair-hot] 一起删干净', () => {
    expect(tokens).not.toMatch(/--drop-ring-line\s*:/)
    const css = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../ui/Tabs.module.css'),
      'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).not.toMatch(/data-pair-hot/)
    expect(css).not.toMatch(/--drop-ring-line/)
  })

  /**
   * **非活动标签的悬停有自己一格底**(U2;用户报「顶栏标签悬停看不见」)。
   *
   * 它不许再读 `--st-hover`:那一族 6% 的墨画在 `--surface-*` 的纸上,而这一档
   * 底下是**透明的檐**、隔壁是内容区的纸色,三样挤在一个很窄的明度区间里。
   * 这条断言守的是两头 —— 册上真有这一格,而那条规则真的读它(不是又退回 6%)。
   */
  it('joined 档非活动标签的悬停底读自己那一格 token', () => {
    expect(tokens).toMatch(/--tab-joined-hover-face\s*:/)
    const css = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../ui/Tabs.module.css'),
      'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = /\.bar\[data-look='joined'\] \.tab:not\(\.tabOn\):hover \{[^}]*\}/.exec(css)
    expect(rule, 'joined 档有那条悬停规则').toBeTruthy()
    expect(rule?.[0]).toMatch(/background:\s*var\(--tab-joined-hover-face\)/)
    expect(rule?.[0]).toMatch(/color:\s*var\(--text-1\)/)
  })

  /**
   * **像素边带的登记留着,判据零读者**(W6-b)。09-24 回来的分屏带按叶宽高比例算
   * (`SPLIT_BAND`),不读这两格像素 —— 这条断言守的是旧的像素判据别种回来。
   */
  it('--drop-edge / --drop-bar-w 只剩登记,判据里没有读者', async () => {
    expect(pxOf('drop-edge')).toBeGreaterThan(0)
    expect(pxOf('drop-bar-w')).toBeGreaterThan(0)
    const drop = (await import('../drop')) as Record<string, unknown>
    expect(drop.DROP_EDGE_PX).toBeUndefined()
    expect(drop.DROP_BAR_PX).toBeUndefined()
    expect(drop.zoneAt).toBeUndefined()
    expect(drop.zoneRectOf).toBeUndefined()
    expect(drop.ZONE_SPLIT).toBeUndefined()
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
