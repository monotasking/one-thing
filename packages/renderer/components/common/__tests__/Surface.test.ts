// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Surface from '../Surface.vue'
import Container from '../Container.vue'
import { SURFACE_CLASS, SURFACE_TIERS, surfaceClasses, type SurfaceTier } from '../surface'

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

const COMPONENTS_CSS = readRepoFile('packages/renderer/styles/components.css')

/** 档位 → 它必须画的那一枚 token 表达式(逐字与迁移前的自绘一致)。 */
/** 档位 → 它重定义的那枚面 token。原语在**区域根**上重写它,子树跟着走。 */
const TIER_TOKEN: Record<SurfaceTier, string> = {
  app: '--ui-surface-app-bg',
  panel: '--ui-surface-panel-bg',
  chat: '--ui-surface-chat-bg',
  elevated: '--ui-surface-elevated-bg',
}

/**
 * 档位 → 公式里的**材质缺省**(`--ot-region-ink` 没拨时读这一枚墨)。
 * chat 档退到 app 墨:主题若没定义 chat 面,材质缺省与实底必须落在同一枚墨上。
 */
const TIER_INK_FALLBACK: Record<SurfaceTier, string> = {
  app: 'var(--ot-ink-surface-app-bg)',
  panel: 'var(--ot-ink-surface-panel-bg)',
  chat: 'var(--ot-ink-surface-chat-bg, var(--ot-ink-surface-app-bg))',
  elevated: 'var(--ot-ink-surface-elevated-bg)',
}

describe('Surface 区域面原语(G7-1)', () => {
  it('renders a single root element carrying the brush class and the stamp', () => {
    const wrapper = mount(Surface, {
      props: { surface: 'panel' },
      slots: { default: '<span class="child">x</span>' },
    })

    expect(wrapper.element.tagName).toBe('DIV')
    expect(wrapper.classes()).toContain(SURFACE_CLASS)
    expect(wrapper.attributes('data-surface')).toBe('panel')
    // 不多一层 DOM:插槽内容直接是根的子节点。
    expect(wrapper.element.firstElementChild?.className).toBe('child')
  })

  it('keeps the root tag swappable through `as`', () => {
    const wrapper = mount(Surface, { props: { as: 'aside', surface: 'chat' } })

    expect(wrapper.element.tagName).toBe('ASIDE')
    expect(wrapper.attributes('data-surface')).toBe('chat')
  })

  it('stamps every declared tier', () => {
    for (const tier of SURFACE_TIERS) {
      const wrapper = mount(Surface, { props: { surface: tier } })
      expect(wrapper.attributes('data-surface')).toBe(tier)
    }
  })

  it('hands out the brush class only when a tier is declared', () => {
    expect(surfaceClasses(undefined)).toEqual([])
    expect(surfaceClasses(null)).toEqual([])
    for (const tier of SURFACE_TIERS) {
      expect(surfaceClasses(tier)).toEqual([SURFACE_CLASS])
    }
  })
})

describe('Container surface 档位', () => {
  it('adds nothing when no tier is declared (零破坏判据)', () => {
    const wrapper = mount(Container, { slots: { default: '<p>main</p>' } })

    expect(wrapper.classes()).not.toContain(SURFACE_CLASS)
    expect(wrapper.attributes('data-surface')).toBeUndefined()
  })

  it('paints and stamps when a tier is declared', () => {
    const wrapper = mount(Container, {
      props: { surface: 'panel' },
      slots: { default: '<p>main</p>' },
    })

    expect(wrapper.classes()).toContain('layout-container')
    expect(wrapper.classes()).toContain(SURFACE_CLASS)
    expect(wrapper.attributes('data-surface')).toBe('panel')
  })
})

describe('档位画笔规则(styles/components.css)', () => {
  /**
   * Surface v2·行为内置:画笔规则不再是"贴一枚 token",而是**自带公式** ——
   *   「材质 × 浓度」,两个旋钮各自缺省到这一档自己的实色。
   * 于是壁纸那类全局行为只需在根上拨两个数,不必再有一本中央规则本逐档覆写。
   */
  it('paints each tier with a self-carrying formula, once', () => {
    for (const tier of SURFACE_TIERS) {
      const rule = [
        `.${SURFACE_CLASS}[data-surface='${tier}'] {`,
        `  ${TIER_TOKEN[tier]}: color-mix(`,
        `    in srgb,`,
      ].join('\n')
      expect(COMPONENTS_CSS).toContain(rule)
      // 材质缺省 + 浓度缺省:两个缺省一起 = 没有全局行为时逐像素等于原样。
      expect(COMPONENTS_CSS).toContain(`var(--ot-region-ink, ${TIER_INK_FALLBACK[tier]})`)
      // 画 background 用的是刚重定义的那枚 token(子树读同一枚,一处收口)。
      expect(COMPONENTS_CSS).toContain(`  background: var(${TIER_TOKEN[tier]});`)
    }
    // 浓度旋钮全档共用一枚 —— B 级"同级全体只认同一个数"的裁决。
    expect(COMPONENTS_CSS.match(/var\(--ot-surface-alpha, 100%\)/g)).toHaveLength(
      SURFACE_TIERS.length
    )
  })

  /**
   * 环坑:公式读的必须是**异名**的墨。写成 `--ui-surface-panel-bg:
   * color-mix(…var(--ui-surface-panel-bg)…)` 在同一元素上是自引用循环,
   * 按规范整条作废 —— 而且是**静默**的,只有真机看得见。
   */
  it('never reads the token it redefines (自引用环)', () => {
    for (const tier of SURFACE_TIERS) {
      const start = COMPONENTS_CSS.indexOf(`.${SURFACE_CLASS}[data-surface='${tier}'] {`)
      const body = COMPONENTS_CSS.slice(start, COMPONENTS_CSS.indexOf('\n}', start))
      const declaration = body.slice(0, body.indexOf('  background:'))
      expect(declaration).not.toContain(`var(${TIER_TOKEN[tier]})`)
    }
  })

  it('never uses a bare [data-surface] selector', () => {
    // 编辑器一族(MarkdownDocumentEditor / ProseNoteEditor)早就在用同名属性的别的
    // 取值,裸属性选择器会把它们一并染上 —— 画笔类必须在选择器里。
    const bare = COMPONENTS_CSS.match(/(^|[\s,{}])\[data-surface/g)
    expect(bare).toBeNull()
  })
})

describe('区域根接入(逐处同一枚 token,只是改由原语画)', () => {
  /** 取出某条选择器的规则体(只到第一个 `}`,够用:区域根规则里没有嵌套块)。 */
  function ruleBody(css: string, selector: string): string {
    const start = css.indexOf(`\n${selector} {`)
    expect(start, `${selector} rule not found`).toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('\n}', start))
  }

  it('right workbench declares the panel tier instead of self-painting', () => {
    const source = readRepoFile('packages/renderer/components/workbench/RightWorkbenchPanel.vue')

    expect(source).toContain('surface="panel"')
    // 只钉**区域根**那一条:台面里的 `.browser-toolbar` / 浏览器面各自还画自己的
    // panel 面(壁纸体系里它们是 A 级让位,另有规则),不在本刀范围内。
    expect(ruleBody(source, '.right-workbench')).not.toContain('background:')
  })

  /**
   * `MediaPanel.vue`(接 `chat` 档的那个全屏工作区容器)随 P1 双域页签迁移拆除。
   * media 视图本体搬进 `MediaPanelContent.vue`,它现在住在**工作台的 panel 面
   * 里** —— 区域根只剩工作台一处,所以内容层这一侧的约束是"不自涂底"(涂了就
   * 等于在别人的档位上再画一层,壁纸态下第一个露馅)。
   */
  it('media panel content paints no region surface of its own', () => {
    const source = readRepoFile('packages/renderer/components/MediaPanelContent.vue')

    expect(source).not.toContain('<Surface')
    expect(ruleBody(source, '.media-panel-content')).not.toContain('background:')
  })

  it('leaves the two declined region roots exactly as they were', () => {
    // 判决记在 docs/design/ui-system.md §6.6:
    // · `.session-header` 画的是页签条族的派生 token,不在四档表内(硬塞会改色);
    // · `.sidebar` 画的是区域别名 `--ui-sidebar-surface-bg`(墨阶一族),借 `app`
    //   档盖章会让 G7-2 的通用规则在 sidebar 子树里误伤后代面,而它自己纹丝不动。
    const sessionHeader = readRepoFile('packages/renderer/components/chat/SessionHeader.vue')
    const sidebar = readRepoFile('packages/renderer/components/sidebar/Sidebar.vue')

    expect(sessionHeader).toContain('background: var(--ui-tab-bar-surface-bg, var(--ui-surface-chat-bg));')
    expect(sessionHeader).not.toContain('data-surface')
    expect(sidebar).toContain('--sidebar-bg: var(--ui-sidebar-surface-bg, var(--ui-surface-app-bg));')
    expect(sidebar).not.toContain('data-surface')
  })
})

describe('壁纸只拨旋钮,不再有区域面规则(Surface v2)', () => {
  const WALLPAPER_CSS = readRepoFile('packages/renderer/styles/wallpaper.css')

  /**
   * G7-2 把区域面从"类名白名单"收成四条 `html.has-wallpaper .app-surface[…]`
   * 通用规则;Surface v2 再走一步 —— 连那四条也删了,行为长在原语里。壁纸这一侧
   * 只剩根上的两个旋钮。这条棘轮防的是"规则本借尸还魂"。
   */
  it('has no region-tier rule of its own — only the two knobs', () => {
    for (const tier of SURFACE_TIERS) {
      expect(WALLPAPER_CSS).not.toContain(`.${SURFACE_CLASS}[data-surface='${tier}']`)
    }
    const knobs = WALLPAPER_CSS.slice(
      WALLPAPER_CSS.indexOf('html.has-wallpaper {'),
      WALLPAPER_CSS.indexOf('\n}', WALLPAPER_CSS.indexOf('html.has-wallpaper {'))
    )
    // 材质:四档在壁纸下统一取页面底的墨(B 级"同级全体只认同一个数")。
    expect(knobs).toContain('--ot-region-ink: var(--ot-ink-surface-app-bg);')
    expect(knobs).toContain('--ot-surface-alpha: 18%;')
  })

  it('never uses a bare [data-surface] selector', () => {
    // 与 components.css 同一条理由:编辑器一族用同名属性的别的取值,裸属性选择器
    // 会把 `document` / `todo-notes` 的面一并稀释成纱。
    expect(WALLPAPER_CSS.match(/(^|[\s,{}])\[data-surface/g)).toBeNull()
  })

  it('drops the two class-name entries the generic rules replaced', () => {
    // 枚举制在区域面这一档终结:两条具名覆写不该再存在,否则就是一处两治。
    expect(WALLPAPER_CSS).not.toContain('.right-workbench {\n  --ui-surface-panel-bg:')
    expect(WALLPAPER_CSS).not.toMatch(/html\.has-wallpaper \.media-panel \{/)
  })

  it('keeps the bench-only patches named (they read other tokens)', () => {
    // 例外清单第 2 条:台面**里**的内容面读的不是 panel 那一枚,档位推不动它们。
    expect(WALLPAPER_CSS).toContain('html.has-wallpaper .right-workbench {')
    for (const token of ['--ui-surface-elevated-bg', '--ui-surface-app-bg', '--workbench-tool-card-bg']) {
      expect(WALLPAPER_CSS).toContain(`  ${token}: color-mix(`)
    }
  })
})
