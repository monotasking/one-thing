import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStageStore } from '../../../stage/store'
import { FocusDispatchHarness } from '../../../test/focus-harness'
import { ModelCatalog } from '../ModelCatalog'
import { NO_CATALOG_FACTS, NO_MODEL_OVERRIDE } from '../../types'
import type { CatalogRow } from '../../types'

/**
 * **逐型覆盖**(09-09,设计正本 `docs/model-override-proposal-2026-09-09.html`)。
 *
 * 这一组守的是三件事,每一件都配了一条反证(在报告里逐条记了「拆掉即红」):
 *  ① 那颗钮**每一行都有**(覆盖是给「目录没填」与「目录说错了」两种情况的);
 *  ② 浮层里三条出口各走各的 —— 合法值写、空值删键、写不进去的**不写也不改行**;
 *  ③ 行上把「谁说的」画出来:虚线下划的读数、划掉的扳手,提示走 `ui/Tooltip`。
 *
 * 浮层锚在那颗钮上(`ui/Popover` 本批补的矩锚档)。jsdom 不排版,所以位置那一半
 * 只证**它真的走了矩锚这条分支**(问过锚点要矩形),真机上的读数在
 * `npm run gate:squeeze`。算式本身的守卫在 `ui/__tests__/float.test.tsx`。
 */

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

function row(id: string, over: Partial<CatalogRow> = {}): CatalogRow {
  return {
    id,
    name: id,
    selected: true,
    current: false,
    contextLength: 200_000,
    maxOutput: 32_768,
    caps: [],
    price: { input: 3, output: 15 },
    manual: false,
    override: NO_MODEL_OVERRIDE,
    catalog: { contextLength: 200_000, tools: false },
    ...over,
  }
}

const NO_PENDING: ReadonlySet<string> = new Set()

function renderCatalog(
  rows: readonly CatalogRow[],
  props: Partial<Parameters<typeof ModelCatalog>[0]> = {},
) {
  return render(
    <>
      <FocusDispatchHarness />
      <ModelCatalog
        providerId="openrouter"
        rows={rows}
        phase="ready"
        dataRev={1}
        refresh={undefined}
        kind="api"
        query=""
        pendingModelIds={NO_PENDING}
        write={undefined}
        onQuery={vi.fn()}
        onRefresh={vi.fn()}
        onToggle={vi.fn()}
        onSetCurrent={vi.fn()}
        onAddManual={vi.fn()}
        onRemoveManual={vi.fn()}
        onWriteOverride={vi.fn()}
        {...props}
      />
    </>,
  )
}

/** 打开某一行的覆盖浮层,回来时它已经在 DOM 里。 */
async function openOverride(id: string) {
  fireEvent.click(screen.getByTestId(`configure-${id}`))
  await waitFor(() => expect(screen.getByTestId('model-override')).toBeTruthy())
}

const contextBox = () => screen.getByTestId('model-override-context') as HTMLInputElement

/** 浮层此刻挂在哪一型上(落点自己的身份,写在浮层内容那一层)。 */
const openModelId = () =>
  screen.getByTestId('model-override').querySelector('[data-model]')?.getAttribute('data-model')

/* ══ ① 那颗钮 ═══════════════════════════════════════════════════════════ */

describe('行尾第三颗钮', () => {
  it('每一行都有 —— 手填的与目录里有的都能配', () => {
    renderCatalog([row('a'), row('ghost', { manual: true, catalog: NO_CATALOG_FACTS })])
    expect(screen.getByTestId('configure-a')).toBeTruthy()
    expect(screen.getByTestId('configure-ghost')).toBeTruthy()
  })

  it('点开 = role=dialog 的附属浮层 + 钮上 aria-expanded 翻面', async () => {
    renderCatalog([row('a')])
    const button = screen.getByTestId('configure-a')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')

    await openOverride('a')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('model-override').getAttribute('role')).toBe('dialog')
    // 附属浮层**不谎称打断**:没有 aria-modal(理由在 ui/Popover 的文件头 ②)。
    expect(screen.getByTestId('model-override').getAttribute('aria-modal')).toBeNull()
  })

  it('浮层锚在那颗钮上 —— 真去问了它的矩形(矩锚档)', async () => {
    renderCatalog([row('a')])
    const button = screen.getByTestId('configure-a')
    const measured = vi.spyOn(button, 'getBoundingClientRect')
    await openOverride('a')
    expect(measured).toHaveBeenCalled()
  })

  it('一次只开一个:点第二行,第一行那张自己关掉', async () => {
    renderCatalog([row('a'), row('b')])
    await openOverride('a')
    expect(openModelId()).toBe('a')

    fireEvent.click(screen.getByTestId('configure-b'))
    await waitFor(() => expect(openModelId()).toBe('b'))
    expect(screen.getAllByTestId('model-override')).toHaveLength(1)
  })

  it('Esc 关浮层 —— 归响应链(Popover 声明的 onEscape),这里一行监听都没写', async () => {
    renderCatalog([row('a')])
    await openOverride('a')
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    await waitFor(() => expect(screen.queryByTestId('model-override')).toBeNull())
  })
})

/* ══ ② 浮层里那三条出口 ═════════════════════════════════════════════════ */

describe('上下文窗口那一格', () => {
  it('↵ 提交一个合法值', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a')], { onWriteOverride })
    await openOverride('a')

    fireEvent.change(contextBox(), { target: { value: '200000' } })
    fireEvent.keyDown(contextBox(), { key: 'Enter' })
    expect(onWriteOverride).toHaveBeenCalledWith('a', { contextLength: 200_000 })
  })

  it('失焦也提交 —— 两条入口一个函数', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a')], { onWriteOverride })
    await openOverride('a')

    fireEvent.change(contextBox(), { target: { value: '999' } })
    fireEvent.blur(contextBox())
    expect(onWriteOverride).toHaveBeenCalledWith('a', { contextLength: 999 })
  })

  it('「200K」「1M」「200,000」都认 —— 认法由 parseQuantity 一处说了算', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a')], { onWriteOverride })
    await openOverride('a')

    for (const [typed, want] of [
      ['200K', 200_000],
      ['1M', 1_000_000],
      ['1.5m', 1_500_000],
      ['200,000', 200_000],
    ] as const) {
      onWriteOverride.mockClear()
      fireEvent.change(contextBox(), { target: { value: typed } })
      fireEvent.keyDown(contextBox(), { key: 'Enter' })
      expect(onWriteOverride, typed).toHaveBeenCalledWith('a', { contextLength: want })
    }
  })

  it('提交后框里回显短写(200000 → 200k),短写对不上原数时留整数', async () => {
    renderCatalog([row('a')], { onWriteOverride: vi.fn() })
    await openOverride('a')

    fireEvent.change(contextBox(), { target: { value: '200000' } })
    fireEvent.keyDown(contextBox(), { key: 'Enter' })
    expect(contextBox().value).toBe('200k')

    // 1048576 短写是「1M」,那是另一个数 —— 框里的字与盘上的数得是同一个。
    fireEvent.change(contextBox(), { target: { value: '1048576' } })
    fireEvent.keyDown(contextBox(), { key: 'Enter' })
    expect(contextBox().value).toBe('1048576')
  })

  it('清空 = 删键', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a', { override: { contextLength: 200_000 } })], { onWriteOverride })
    await openOverride('a')
    // 打开时读一次设置,回显的也是短写。
    expect(contextBox().value).toBe('200k')

    fireEvent.change(contextBox(), { target: { value: '   ' } })
    fireEvent.keyDown(contextBox(), { key: 'Enter' })
    expect(onWriteOverride).toHaveBeenCalledWith('a', { contextLength: null })
  })

  it('「200 tokens」写不进去:aria-invalid + 错误句,而且**一发都不发**', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a')], { onWriteOverride })
    await openOverride('a')

    fireEvent.change(contextBox(), { target: { value: '200 tokens' } })
    fireEvent.keyDown(contextBox(), { key: 'Enter' })
    expect(onWriteOverride).not.toHaveBeenCalled()
    expect(contextBox().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('填正数,可带 K / M:200000、200K、1M')).toBeTruthy()
    // 输入框里那几个字**留着** —— 让人看得见自己刚打的是什么。
    expect(contextBox().value).toBe('200 tokens')
  })

  it('占位符与提示行说的是「今天实际生效的数与它的来源」', async () => {
    renderCatalog([row('ghost', { manual: true, contextLength: null, catalog: NO_CATALOG_FACTS })])
    await openOverride('ghost')
    // 目录没填 → 引擎按 128k 算(model-registry.ts:914),占位符照实说。
    expect(contextBox().getAttribute('placeholder')).toBe('128k(默认)')
    expect(
      screen.getByText('目录没填这一型;不填按 128k 算,压缩阈值也按它算。'),
    ).toBeTruthy()
  })
})

describe('工具调用那一格', () => {
  it('点「关」写 tools:false', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a')], { onWriteOverride })
    await openOverride('a')

    fireEvent.click(screen.getByRole('radio', { name: '关' }))
    expect(onWriteOverride).toHaveBeenCalledWith('a', { tools: false })
  })

  it('点回「跟目录」= 删键(inherit 不是第三种值)', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a', { override: { tools: false } })], { onWriteOverride })
    await openOverride('a')
    expect(screen.getByRole('radio', { name: '关' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: '跟目录' }))
    expect(onWriteOverride).toHaveBeenCalledWith('a', { tools: null })
  })

  it('「跟目录」而目录没填时,提示说出「跟的是猜」—— 不藏', async () => {
    renderCatalog([row('ghost', { manual: true, catalog: NO_CATALOG_FACTS })])
    await openOverride('ghost')
    expect(screen.getByText('目录没填这一型;按名字判为「支持」。')).toBeTruthy()
  })
})

describe('恢复目录值', () => {
  it('两个键一起删', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a', { override: { contextLength: 300_000, tools: false } })], {
      onWriteOverride,
    })
    await openOverride('a')
    fireEvent.click(screen.getByTestId('model-override-reset'))
    expect(onWriteOverride).toHaveBeenCalledWith('a', { contextLength: null, tools: null })
  })

  it('没覆盖时禁用 —— 它无事可做', async () => {
    renderCatalog([row('a')])
    await openOverride('a')
    expect((screen.getByTestId('model-override-reset') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('在写(pending 逐行)', () => {
  it('这一行的钮与浮层控件一起禁,而且写不出去', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a', { override: { contextLength: 300_000 } }), row('b')], {
      onWriteOverride,
      pendingModelIds: new Set(['a']),
    })
    // 忙态下钮仍然点得开?不 —— 它自己就是禁的,所以先开再让它忙不现实:
    // 这里直接断言禁用那一格,浮层由下一条(未忙的行开着、忙起来)覆盖。
    expect((screen.getByTestId('configure-a') as HTMLButtonElement).disabled).toBe(true)
    // 别的行一个都不许动(律③粒度)。
    expect((screen.getByTestId('configure-b') as HTMLButtonElement).disabled).toBe(false)
  })

  it('浮层开着时这一行忙起来:三件控件全禁,点了也不写', async () => {
    const onWriteOverride = vi.fn()
    const view = renderCatalog([row('a', { override: { contextLength: 300_000 } })], {
      onWriteOverride,
    })
    await openOverride('a')

    view.rerender(
      <>
        <FocusDispatchHarness />
        <ModelCatalog
          providerId="openrouter"
          rows={[row('a', { override: { contextLength: 300_000 } })]}
          phase="ready"
          dataRev={1}
          refresh={undefined}
          kind="api"
          query=""
          pendingModelIds={new Set(['a'])}
          write={undefined}
          onQuery={vi.fn()}
          onRefresh={vi.fn()}
          onToggle={vi.fn()}
          onSetCurrent={vi.fn()}
          onAddManual={vi.fn()}
          onRemoveManual={vi.fn()}
          onWriteOverride={onWriteOverride}
        />
      </>,
    )

    expect(contextBox().disabled).toBe(true)
    expect((screen.getByRole('radio', { name: '关' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('model-override-reset') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('radio', { name: '关' }))
    fireEvent.click(screen.getByTestId('model-override-reset'))
    expect(onWriteOverride).not.toHaveBeenCalled()
  })
})

/* ══ ③ 行上把「谁说的」画出来 ═══════════════════════════════════════════ */

describe('行上的覆盖读数', () => {
  it('上下文格换笔迹(ovr)+ 悬停出目录原值,禁 native title=', async () => {
    renderCatalog([row('a', { contextLength: 1_048_576, override: { contextLength: 1_048_576 } })])
    const cell = screen.getByTestId('ctx-a')
    expect(cell.className).toContain('ovr')
    expect(cell.getAttribute('title')).toBeNull()

    fireEvent.mouseEnter(cell)
    await waitFor(() =>
      expect(screen.getByRole('tooltip').textContent).toBe('自定 1M(目录 200k)'),
    )
  })

  it('没覆盖的那一行不画虚线(反面)', () => {
    renderCatalog([row('a')])
    expect(screen.getByTestId('ctx-a').className).not.toContain('ovr')
  })

  it('目录没填时那句话说的是「默认 128k」,不是编一个目录值', async () => {
    renderCatalog([
      row('ghost', {
        manual: true,
        contextLength: 200_000,
        override: { contextLength: 200_000 },
        catalog: NO_CATALOG_FACTS,
      }),
    ])
    fireEvent.mouseEnter(screen.getByTestId('ctx-ghost'))
    await waitFor(() =>
      expect(screen.getByRole('tooltip').textContent).toBe('自定 200k(目录没填,默认 128k)'),
    )
  })

  it('tools:false —— 扳手**画出来但划掉**(消失是不知道,划掉是人说不)', () => {
    renderCatalog([
      row('a', { caps: [], override: { tools: false }, catalog: { contextLength: 200_000, tools: true } }),
    ])
    const wrench = screen.getByTestId('cap-tools')
    expect(wrench.className).toContain('capOff')
    expect(wrench.getAttribute('aria-label')).toBe('自定:关闭工具调用(目录:支持)')
  })

  it('tools:true —— 目录没列它也画一枚,带虚线', () => {
    renderCatalog([row('a', { caps: ['tools'], override: { tools: true } })])
    const wrench = screen.getByTestId('cap-tools')
    expect(wrench.className).toContain('ovr')
    expect(wrench.className).not.toContain('capOff')
    expect(wrench.getAttribute('aria-label')).toBe('自定:支持工具调用(目录:不支持)')
  })

  it('那道划痕真的画得出来 —— 伪元素画的,不是 text-decoration', () => {
    /*
     * 能力那一格是 `display: inline-flex` 且里面**一个字都没有**(身子是 svg),
     * `text-decoration: line-through` 在它身上既不传进去也没有文本盒可穿 ——
     * 样例页上看着对,是因为那份 demo 的 span 不是 inline-flex。
     * 所以这一条读样式表源文本(与「.ghost:disabled」那条判例同一手),
     * 断言划痕是伪元素那条边线。
     */
    const css = readFileSync(
      path.resolve(__dirname, '../ModelCatalog.module.css'),
      'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/\.cap\.capOff::after\s*\{[^}]*border-top/)
    expect(css).toMatch(/\.cap\.capOff\s*\{[^}]*--pv-cap-off-o/)
  })
})
