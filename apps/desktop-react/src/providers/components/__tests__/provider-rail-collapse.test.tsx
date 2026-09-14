import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../../stage/store'
import { ProviderRail } from '../ProviderRail'
import type { RailRow } from '../../types'

/**
 * 左栏的**两种形**(09-11 报障「模型配置页面没有响应式布局」):
 * 268 的名册 / 44 的图标条。
 *
 * 门分两半,理由与 `model-catalog-layout.test.tsx` 头上那条逐字相同:
 *   · **哪一种形**是排版,判据在 `@container providers-panel` 里,而 CSS Modules
 *     那份样式表从来没有进过 jsdom —— 所以这一半读**样式表源文件**,
 *     并且真机那一半在 `scripts/gate-providers-squeeze.mjs` 六档里量宽;
 *   · **两种形里各画了什么、点下去发生什么**是 DOM,那一半在这里真渲染。
 *
 * 读源文本之前先剥注释:病历里逐字抄着「从前是这样」的声明,不剥就会指着病历
 * 判自己红(block-shell.test.ts / model-catalog-layout.test.tsx 立过同一条)。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (hit) => hit.replace(/[^\n]/g, ' '))
}

const root = process.cwd()
const railCss = stripComments(
  readFileSync(resolve(root, 'src/providers/components/ProviderRail.module.css'), 'utf8'),
)
const panelCss = stripComments(
  readFileSync(resolve(root, 'src/providers/components/ProviderSettingsPanel.module.css'), 'utf8'),
)
const detailCss = stripComments(
  readFileSync(resolve(root, 'src/providers/components/ProviderDetail.module.css'), 'utf8'),
)
const poolCss = stripComments(
  readFileSync(resolve(root, 'src/providers/components/CredentialPool.module.css'), 'utf8'),
)
const tokens = stripComments(readFileSync(resolve(root, 'src/styles/tokens.css'), 'utf8'))

function px(name: string): number {
  const hit = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(tokens)
  expect(hit, `tokens.css 里找不到 ${name}`).toBeTruthy()
  return Number(hit![1])
}

function row(over: Partial<RailRow> = {}): RailRow {
  return {
    familyId: 'deepseek',
    label: 'DeepSeek',
    initial: 'D',
    facts: [{ key: 'providers.factConfigured' }, { key: 'providers.factKeys', vars: { count: 3 } }],
    tone: 'idle',
    group: 'cloud',
    custom: false,
    ...over,
  }
}

function renderRail(over: { onSelect?: (id: string) => void; rows?: readonly RailRow[] } = {}) {
  return render(
    <ProviderRail
      rows={over.rows ?? [row()]}
      connectedCount={1}
      selectedId={null}
      query=""
      onQuery={vi.fn()}
      onSelect={over.onSelect ?? vi.fn()}
      onAddCustom={vi.fn()}
      onRowMenu={vi.fn()}
    />,
  )
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

describe('收起档的判据与几何(样式表源文本 + token 算术)', () => {
  /*
   * 这块面自己声明「我能活到多窄」(挤压四律第四条),而那个数必须**算得出来**:
   * 图标条 + 详情内衬 + 目录地板。三格里任何一格改了而这里没跟,当场红 ——
   * 那正是 08-31 / 09-11 两次报障的同一种算术病。
   */
  it('面板地板 = 图标条 + 详情内衬 + 目录地板', () => {
    expect(px('--pv-panel-min')).toBe(
      px('--pv-rail-collapsed-w') + px('--pv-detail-inset') + px('--pv-catalog-floor'),
    )
    expect(panelCss).toMatch(/\.panel\s*\{[^}]*min-width:\s*var\(--pv-panel-min\)/)
  })

  /*
   * 左栏**只在「让开它之后目录连地板三列都保不住」时才收**(09-14 用户裁定:
   * 「供应商只有字母……把它展开」)。这条不等式是收起阈值唯一的理由 ——
   * 定高了会在还排得下的时候把名册收掉(报障那一形:设置页分页之后面板少了
   * 168px 左导航,普通窗口下左栏当场收成图标条),定低了则连地板都保不住。
   *
   * 09-11 的旧账是「还保得住**五列**」(--pv-catalog-bare 568),用户把
   * 「看得见供应商名字」与「目录五列」的次序拍反,于是右项换成目录地板。
   */
  it('收起阈值不低于「左栏 + 详情内衬 + 目录地板」', () => {
    const needed = px('--pv-rail-w') + px('--pv-detail-inset') + px('--pv-catalog-floor')
    expect(px('--pv-panel-rail-collapse')).toBeGreaterThanOrEqual(needed)
    // 留的余量不许离谱:超过一档(16px)就是在还排得下的时候提前收名册。
    expect(px('--pv-panel-rail-collapse') - needed).toBeLessThanOrEqual(px('--sp-4'))
  })

  it('@container 的字面量与 token 是同一事实的两处', () => {
    // 面板是容器,名字叫 providers-panel;查询判「≤」,所以字面量就是那个 token。
    expect(panelCss).toMatch(/container-name:\s*providers-panel/)
    expect(panelCss).toMatch(/container-type:\s*inline-size/)
    const railQueries = [
      ...railCss.matchAll(/@container providers-panel \(max-width:\s*(\d+)px\)/g),
    ].map((m) => Number(m[1]))
    expect(railQueries).toEqual([px('--pv-panel-rail-collapse')])

    // 详情列是另一个容器,两处消费它:详情头与凭证卡的轮换行。
    expect(detailCss).toMatch(/container-name:\s*providers-detail/)
    const detailQueries = [
      ...[...detailCss.matchAll(/@container providers-detail \(max-width:\s*(\d+)px\)/g)],
      ...[...poolCss.matchAll(/@container providers-detail \(max-width:\s*(\d+)px\)/g)],
    ].map((m) => Number(m[1]))
    expect(detailQueries).toEqual([px('--pv-detail-stack'), px('--pv-detail-stack')])
  })

  it('收起档只收宽与几个 display —— 不换组件、不重挂(切档必须布局连续)', () => {
    const at = railCss.indexOf('@container providers-panel')
    const block = railCss.slice(at)
    expect(block).toMatch(/\.rail:not\(\[data-expanded='true'\]\)\s*\{[^}]*width:\s*var\(--pv-rail-collapsed-w\)/)
    // 这一段里不许出现 JS 驱动的形变或过渡以外的东西:只有宽、display、内衬与对齐。
    expect(block).not.toMatch(/transform:/)
    expect(block).not.toMatch(/position:\s*fixed/)
  })

  it('宽档里那枚方图标不吃指针 —— 提示只在收起档触发', () => {
    expect(railCss).toMatch(/\.icon\s*\{[^}]*pointer-events:\s*none/)
    const at = railCss.indexOf('@container providers-panel')
    expect(railCss.slice(at)).toMatch(
      /\.rail:not\(\[data-expanded='true'\]\) \.icon\s*\{[^}]*pointer-events:\s*auto/,
    )
  })
})

describe('两种形里各画了什么、点下去发生什么(真 DOM)', () => {
  it('行的可达名把名字与副行都说出来 —— 收起档里 .text 不在无障碍树上', () => {
    renderRail()
    const button = screen.getByTestId('provider-row-deepseek')
    const spoken = button.getAttribute('aria-label') ?? ''
    expect(spoken).toBe('DeepSeek · 已配置 · 3 把')
    // 可见的那两行逐字含在可达名里(WCAG 2.5.3「可见标签含于可达名」)。
    for (const visible of ['DeepSeek', '已配置 · 3 把']) expect(spoken).toContain(visible)
  })

  it('展开 / 收起那颗钮:aria-expanded 两态,再点一次收回', () => {
    renderRail()
    const toggle = screen.getByTestId('provider-rail-toggle')
    const rail = screen.getByTestId('provider-rail')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(rail.getAttribute('data-expanded')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(rail.getAttribute('data-expanded')).toBe('true')
    // 展开之后它换了名字与图标 —— 一颗钮两副面孔,面孔是状态的产地。
    expect(toggle.getAttribute('aria-label')).toBe('收起服务商名册')

    fireEvent.click(toggle)
    expect(rail.getAttribute('data-expanded')).toBeNull()
    expect(toggle.getAttribute('aria-label')).toBe('展开服务商名册')
  })

  it('选中一家 = 撑开的条子自己收回去(不靠调用方记得)', () => {
    const onSelect = vi.fn()
    renderRail({ onSelect })
    const rail = screen.getByTestId('provider-rail')
    fireEvent.click(screen.getByTestId('provider-rail-toggle'))
    expect(rail.getAttribute('data-expanded')).toBe('true')

    fireEvent.click(screen.getByTestId('provider-row-deepseek'))
    expect(onSelect).toHaveBeenCalledWith('deepseek')
    expect(rail.getAttribute('data-expanded')).toBeNull()
  })

  it('「＋ 自定义服务商」两种形读同一句文案,各有一个稳定选择器', () => {
    renderRail()
    const text = screen.getByTestId('provider-add-custom')
    const icon = screen.getByTestId('provider-add-custom-icon')
    expect(text.textContent).toBe('＋ 自定义服务商')
    expect(icon.getAttribute('aria-label')).toBe('＋ 自定义服务商')
  })
})
