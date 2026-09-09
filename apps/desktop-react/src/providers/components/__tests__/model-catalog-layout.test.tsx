import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useStageStore } from '../../../stage/store'
import { ModelCatalog } from '../ModelCatalog'
import { NO_CATALOG_FACTS, NO_MODEL_OVERRIDE } from '../../types'
import type { CatalogRow } from '../../types'

/**
 * 模型目录的**版式**(08-31 两条真机报障的门):
 *   ④ 列头「Caps」压在「Context」上,而行里的能力字标整列不见;
 *   ⑤ 详情面一屏只见一个半模型 —— 目录自己开了一个小内滚窗。
 *
 * 这两条的病灶都在样式表里,而 CSS Modules 那份样式表**从来没有进过 jsdom**
 * (vite 只在浏览器里注入它),所以 `getComputedStyle` 在这台机器上答的是
 * 「jsdom 没有这条规则」,不是「这块 UI 排成什么样」。拿它当断言,规则删掉了
 * 也照样绿 —— 与 composer-css.test.ts 立的是同一条判例。
 * 于是门分两半:
 *   · 排版纪律读**样式表源文件**(轨道单产地、能力轨的下限、两级阈值的算术);
 *   · 「列头与行的格子数一样多」读**真渲染出来的 DOM**(那是 CSS 说不出的话)。
 */

/**
 * 注释里出现的声明**不算数**,只看真正的声明行(block-shell.test.ts 立过同一条)。
 * 这一批当场吃到了它:上面那两条报障的病灶(`minmax(0, …)`、`.rows { overflow-y: auto }`)
 * 被逐字写进了「从前是这样、为什么改」的病历里,于是「样式表里再没有一条 minmax(0,」
 * 这句断言指着病历判了自己红。
 *
 * 抹掉的是**注释里的字**,不是注释占的位置:每个非换行字符换成一个空格,
 * 行号与字节偏移逐字不变 —— 下面那条「轨道只许长在 .grid 上」是靠往前找选择器的,
 * 偏移一动它就开始看错行。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (hit) => hit.replace(/[^\n]/g, ' '))
}

const root = process.cwd()
const css = stripComments(
  readFileSync(resolve(root, 'src/providers/components/ModelCatalog.module.css'), 'utf8'),
)
const tokens = stripComments(readFileSync(resolve(root, 'src/styles/tokens.css'), 'utf8'))

/** 从 tokens.css 里读一个 px 值。读不到就当场红 —— 不给默认值兜底。 */
function px(name: string): number {
  const hit = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(tokens)
  expect(hit, `tokens.css 里找不到 ${name}`).toBeTruthy()
  return Number(hit![1])
}

/** 样式表里所有 `grid-template-columns: …` 声明的值(按出现次序)。 */
function templates(): string[] {
  return [...css.matchAll(/grid-template-columns:\s*([^;]+);/g)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim(),
  )
}

/** 数一条模板里有几条轨:按顶层空格切,括号里的空格不算(minmax(a, b) 是一条)。 */
function trackCount(template: string): number {
  let depth = 0
  let tracks = 0
  let inTrack = false
  for (const ch of template) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (depth === 0 && /\s/.test(ch)) {
      inTrack = false
      continue
    }
    if (!inTrack) {
      tracks += 1
      inTrack = true
    }
  }
  return tracks
}

describe('七列表的轨道:单产地 + 每一档都排得下', () => {
  /*
   * 「列头与行共用同一张网格」这句话得**守得住**:样式表里只有 `.grid` 一族
   * 声明轨道(常态一条 + 两条 @container 覆盖),`.columns` / `.row` 一条都不许自己写。
   * 两处各写一遍就是两处会漂开 —— 那正是 ④ 那条报障最容易演变成的下一个形态。
   */
  it('轨道声明只有三处,全部长在 .grid 上', () => {
    expect(templates()).toHaveLength(3)
    for (const [i] of templates().entries()) {
      // 每条声明往前找最近的一个选择器,必须是 .grid。
      const at = [...css.matchAll(/grid-template-columns:/g)][i].index ?? 0
      const before = css.slice(0, at)
      const lastSelector = before.lastIndexOf('{')
      const selector = before.slice(before.lastIndexOf('\n', lastSelector) + 1, lastSelector).trim()
      expect(selector, '轨道只许长在 .grid 上').toBe('.grid')
    }
  })

  it('三档轨道数是 7 / 6 / 5 —— 一次让一整列,不是每列缩一点', () => {
    expect(templates().map(trackCount)).toEqual([7, 6, 5])
  })

  /*
   * ④ 的直接病灶:能力轨从前写的是 `minmax(0, …)`,那个 0 是**真的 0**。
   * 轨塌到 0 之后,行里的 `.caps`(有 overflow:hidden)整列消失,
   * 而列头那个 `<span>` 没有裁切、直接画到邻轨上 —— 一个 bug,两种表现。
   */
  it('能力轨有下限,样式表里再没有一条 minmax(0, …)', () => {
    for (const template of templates()) {
      expect(template).toContain('minmax(var(--pv-col-caps-min), var(--pv-col-caps))')
    }
    expect(css).not.toMatch(/minmax\(\s*0\s*,/)
  })

  it('列头每一格都裁切 —— 弯的方式是内容裁切,不是画到邻居身上', () => {
    const at = css.indexOf('.columns > * {')
    expect(at, '列头缺了那条统一裁切规则').toBeGreaterThanOrEqual(0)
    const rule = css.slice(at, css.indexOf('}', at))
    expect(rule).toMatch(/min-width:\s*0/)
    expect(rule).toMatch(/overflow:\s*hidden/)
    expect(rule).toMatch(/text-overflow:\s*ellipsis/)
  })

  /*
   * 两级阈值不是估的,是**算出来的**:一档的入场宽 = 该档所有轨的最小宽 + 轨间距。
   * ④ 的另一半病因就是旧阈值(640)定在了七列入场宽(728)之下 —— 于是
   * 640–728 这一整段里表还是七列、却排不下,唯一能让的能力轨被榨到 0。
   * 这条断言把那次算术钉进门里:改任何一条列宽 token 而忘了重算阈值,当场红。
   */
  it('两级阈值 = 下一档的入场宽(照列宽 token 现算)', () => {
    const gap = px('--sp-2')
    const wide =
      px('--pv-col-check') +
      px('--pv-col-name-min') +
      px('--pv-col-caps-min') +
      px('--pv-col-ctx') +
      px('--pv-col-out') +
      px('--pv-col-price') +
      px('--pv-col-current') +
      6 * gap
    const narrow = wide - px('--pv-col-price') - gap
    expect(px('--pv-catalog-narrow')).toBe(wide)
    expect(px('--pv-catalog-tight')).toBe(narrow)

    // @container 条件里写不了 var(),所以那两个字面量与 token 是**同一事实的两处**。
    const queries = [...css.matchAll(/@container catalog \(max-width:\s*(\d+)px\)/g)].map((m) =>
      Number(m[1]),
    )
    expect(queries).toEqual([wide, narrow])
  })
})

describe('行尾动作组:✕ 的位置每一行都占着(09-09 报障:手填行错位)', () => {
  it('.slot 与 ✕ 同宽(--icon-btn-sm),.actions 仍是右对齐 flex 而不是内层 grid', () => {
    const slot = /\.slot\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(slot).toMatch(/width:\s*var\(--icon-btn-sm\)/)
    expect(slot).toMatch(/flex:\s*none/)
    const actions = /\.actions\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    // 轨道声明只长在 .grid 上(上面那组守卫);动作组不许自己开一张 grid。
    expect(actions).not.toMatch(/grid-template-columns/)
  })

  /*
   * 09-09 用户报障「对齐」:同一列上下相邻的两颗药丸 ——「设为当前」那颗钮与
   * 「当前模型」那格读数 —— 左边线对不上(英文标签一长一短)。修法是两处共读
   * **同一个** token 的 min-width。这条断言守的是那个「同一个」:两处各写一个
   * 数就是两处会漂开,而那正是这条报障的下一个形态。
   */
  it('「设为当前」与「当前模型」共读 --pv-btn-current-w 的宽下限', () => {
    const setCurrent = /\.setCurrent\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const current = /\.current\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(setCurrent).toMatch(/min-width:\s*var\(--pv-btn-current-w\)/)
    expect(current).toMatch(/min-width:\s*var\(--pv-btn-current-w\)/)
    // 动作列装得下它:110 + 4 + 22 + 4 + 22 = 162,一格余量都没有了。
    expect(px('--pv-col-current')).toBe(
      px('--pv-btn-current-w') + 2 * px('--sp-1') + 2 * px('--icon-btn-sm'),
    )
  })
})

describe('目录不自己滚:滚动收敛在详情列那一层(报障⑤)', () => {
  function block(selector: string): string {
    const at = css.indexOf(`${selector} {`)
    expect(at, `样式表里找不到 ${selector}`).toBeGreaterThanOrEqual(0)
    return css.slice(at, css.indexOf('}', at))
  }

  it('.rows 不再是滚动容器,也不抢高', () => {
    expect(block('.rows')).not.toMatch(/overflow/)
    expect(block('.rows')).toMatch(/flex:\s*none/)
  })

  it('.catalog 按自然高度画,而且用 clip 而不是 hidden(hidden 会把组头的 sticky 钉死)', () => {
    expect(block('.catalog')).toMatch(/flex:\s*none/)
    expect(block('.catalog')).toMatch(/overflow:\s*clip/)
    expect(block('.catalog')).not.toMatch(/overflow:\s*hidden/)
  })
})

/* ── 真 DOM 那一半:列头与行的格子数必须一样多 ─────────────────────────────── */

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

function row(id: string): CatalogRow {
  return {
    id,
    name: id,
    selected: false,
    current: false,
    contextLength: 200_000,
    maxOutput: 32_768,
    caps: [],
    price: { input: 3, output: 15 },
    manual: false,
    override: NO_MODEL_OVERRIDE,
    catalog: NO_CATALOG_FACTS,
  }
}

describe('列头与行同源:格子数一样多', () => {
  it('两边都是 7 格,与常态模板的轨道数对得上', () => {
    render(
      <ModelCatalog
        providerId="openrouter"
        rows={[row('a')]}
        phase="ready"
          dataRev={1}
        refresh={undefined}
        kind="api"
        query=""
        pendingModelIds={new Set<string>()}
        write={undefined}
        onQuery={vi.fn()}
        onRefresh={vi.fn()}
        onToggle={vi.fn()}
        onSetCurrent={vi.fn()}
        onAddManual={vi.fn()}
        onRemoveManual={vi.fn()}
        onWriteOverride={vi.fn()}
      />,
    )

    const rowEl = screen.getByTestId('model-row-a')
    // 从行往外找到整块目录,再在里面认列头 —— 不数「往上几层」:
    // 分组包装那一层在不在,取决于这一行落在「已选置顶」还是某个厂牌组里。
    const headEl = rowEl.closest('section')?.querySelector('[class*="columns"]')
    expect(headEl, '找不到列头行').toBeTruthy()

    const wide = trackCount(templates()[0])
    expect(headEl!.children).toHaveLength(wide)
    expect(rowEl.children).toHaveLength(wide)
  })
})
