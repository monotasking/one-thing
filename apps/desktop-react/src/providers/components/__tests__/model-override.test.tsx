import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStageStore } from '../../../stage/store'
import { FocusDispatchHarness } from '../../../test/focus-harness'
import { ModelCatalog } from '../ModelCatalog'
import { NO_CATALOG_FACTS, NO_MODEL_OVERRIDE } from '../../types'
import type { CapabilityKey, CatalogRow, ModelOverride } from '../../types'

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

/** 一份覆盖。`caps` 恒在(某一项缺席 = 没说过),夹具里不必每处写一遍空表。 */
function over(o: Partial<ModelOverride> = {}): ModelOverride {
  return { caps: {}, ...o }
}

/**
 * 目录说的那五项。**缺省全 false** —— 目录条目里没列这一项就是「目录说不支持」
 * (与 `NO_CATALOG_FACTS` 的全 `null` = 手填行、目录没填这一型,是两件事)。
 */
function catalogCaps(
  o: Partial<Record<CapabilityKey, boolean | null>> = {},
): Record<CapabilityKey, boolean | null> {
  return { vision: false, tools: false, reasoning: false, imageOutput: false, fileInput: false, ...o }
}

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
    catalog: { contextLength: 200_000, maxOutput: 32_768, caps: catalogCaps({ tools: false }) },
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
        onRenameManual={vi.fn()}
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
const outBox = () => screen.getByTestId('model-override-output') as HTMLInputElement

/** 浮层此刻挂在哪一型上(落点自己的身份,写在浮层内容那一层)。 */
const openModelId = () =>
  screen.getByTestId('model-override').querySelector('[data-model]')?.getAttribute('data-model')

describe('自定义思考配置', () => {
  it('等级与名称一次保存，非法映射不会写入', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('grok-4.6')], { onWriteOverride })
    await openOverride('grok-4.6')
    fireEvent.click(screen.getByText('自定义思考配置'))
    fireEvent.change(screen.getByLabelText('低档的显示名称'), { target: { value: '快速' } })
    fireEvent.click(screen.getByText('高级：请求参数映射'))
    fireEvent.change(screen.getByLabelText('高级：请求参数映射'), { target: { value: '{broken' } })
    fireEvent.click(screen.getByText('保存思考配置'))
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(onWriteOverride).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('高级：请求参数映射'), { target: {
      value: '{"effortPath":"reasoning.effort","effortValues":{"low":"fast","high":"deep"}}',
    } })
    fireEvent.click(screen.getByText('保存思考配置'))
    expect(onWriteOverride).toHaveBeenCalledWith('grok-4.6', expect.objectContaining({ reasoningProfile: expect.objectContaining({
      efforts: ['low', 'high'], effortLabels: { low: '快速' },
      custom: { effortPath: 'reasoning.effort', effortValues: { low: 'fast', high: 'deep' } },
    }) }))
  })
})

/* ══ ① 那颗钮 ═══════════════════════════════════════════════════════════ */

describe('行尾第三颗钮', () => {
  it('每一行都有 —— 手填的与目录里有的都能配', () => {
    renderCatalog([row('a'), row('ghost', { manual: true, catalog: NO_CATALOG_FACTS })])
    expect(screen.getByTestId('configure-a')).toBeTruthy()
    expect(screen.getByTestId('configure-ghost')).toBeTruthy()
  })

  it('✕ 的位置每一行都占着:手填行是 ✕,别的行是同宽空位(09-09 报障:手填行错位)', () => {
    renderCatalog([row('a'), row('ghost', { manual: true, catalog: NO_CATALOG_FACTS })])
    const remove = screen.getByTestId('remove-ghost')
    const slot = screen.getByTestId('remove-slot-a')
    expect(remove.tagName).toBe('BUTTON')
    expect(slot.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByTestId('remove-slot-ghost')).toBeNull()
    expect(screen.queryByTestId('remove-a')).toBeNull()
    // 两行动作组里的**件数一样**:三件,顺序 [设为当前 | 滑杆 | ✕ 或空位]。
    const cellOf = (id: string) => screen.getByTestId(`configure-${id}`).parentElement!
    expect(cellOf('a').children.length).toBe(3)
    expect(cellOf('ghost').children.length).toBe(3)
    expect(cellOf('a').lastElementChild).toBe(slot)
    expect(cellOf('ghost').lastElementChild).toBe(remove)
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
    renderCatalog([row('a', { override: over({ contextLength: 200_000 }) })], { onWriteOverride })
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

/* ══ 第三格:最大输出 ═════════════════════════════════════════════════════ */

describe('最大输出那一格', () => {
  it('它真的在,而且与上下文那一格是两个框', async () => {
    renderCatalog([row('a')])
    await openOverride('a')
    // 「最大输出」这四个字表头上也有一份 —— 这里问的是**浮层里**那一份。
    expect(within(screen.getByTestId('model-override')).getByText('最大输出')).toBeTruthy()
    expect(outBox()).not.toBe(contextBox())
  })

  it('↵ 提交一个合法值,写的是 maxOutput 这一格', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a')], { onWriteOverride })
    await openOverride('a')

    fireEvent.change(outBox(), { target: { value: '32768' } })
    fireEvent.keyDown(outBox(), { key: 'Enter' })
    expect(onWriteOverride).toHaveBeenCalledWith('a', { maxOutput: 32_768 })
  })

  it('「32k」也认 —— 两个框同一把 parseQuantity 的尺', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a')], { onWriteOverride })
    await openOverride('a')

    fireEvent.change(outBox(), { target: { value: '32k' } })
    fireEvent.blur(outBox())
    expect(onWriteOverride).toHaveBeenCalledWith('a', { maxOutput: 32_000 })
  })

  it('清空 = 删键', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a', { override: over({ maxOutput: 8_192 }) })], { onWriteOverride })
    await openOverride('a')
    expect(outBox().value).toBe('8192')

    fireEvent.change(outBox(), { target: { value: '' } })
    fireEvent.keyDown(outBox(), { key: 'Enter' })
    expect(onWriteOverride).toHaveBeenCalledWith('a', { maxOutput: null })
  })

  it('写不进去的值:aria-invalid + 错误句,而且一发都不发', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a')], { onWriteOverride })
    await openOverride('a')

    fireEvent.change(outBox(), { target: { value: '8192 tokens' } })
    fireEvent.keyDown(outBox(), { key: 'Enter' })
    expect(onWriteOverride).not.toHaveBeenCalled()
    expect(outBox().getAttribute('aria-invalid')).toBe('true')
    // 上一格**不跟着变红**:两格各自一份 invalid。
    expect(contextBox().getAttribute('aria-invalid')).not.toBe('true')
  })

  it('占位符与提示行说的是「今天实际会发多少、为什么是这个数」', async () => {
    renderCatalog([row('a')])
    await openOverride('a')
    // 目录上限 32,768 → 今天实际发它的一半(agent-loop-runtime.ts:821)。
    expect(outBox().getAttribute('placeholder')).toBe(
      `${(16_384).toLocaleString()}(目录 ${(32_768).toLocaleString()} 的一半)`,
    )
    expect(screen.getByText(`目录上限 ${(32_768).toLocaleString()};不填按它的一半发。`)).toBeTruthy()
  })

  /*
   * ── 目录没填这一型:只有一态(09-09 晚:全局 chat.maxTokens 整格退役)──
   *
   * 事故 fe5261d9:手填的模型不在目录里,引擎从前给它编一个 4096 的上限,于是
   * 屏幕上写「默认 2,048(兜底 4,096 的一半)」,而用户在这一格填的 10000 真被
   * `min(10000, 4096)` 夹成 4096。那个编出来的 4096 已连同产地一起删除,壳上
   * 也就**没有这个数可说** —— 这一条守的正是「屏幕不再说出一个不存在的数」。
   */
  it('目录没填这一型:屏幕上一个数都没有,说「由服务商决定」', async () => {
    renderCatalog([row('ghost', { manual: true, maxOutput: null, catalog: NO_CATALOG_FACTS })])
    await openOverride('ghost')
    expect(outBox().getAttribute('placeholder')).toBe('由服务商决定')
    expect(
      screen.getByText('目录没填这一型;不填就不带上限,由服务商用它自己的默认值。'),
    ).toBeTruthy()
    // 那个编出来的数不许以任何形式回到屏幕上。
    expect(screen.queryByText(/4,096|2,048/)).toBeNull()
  })

  it('人填过之后,提示行改口说「不再对半砍」', async () => {
    renderCatalog([row('a', { maxOutput: 65_536, override: over({ maxOutput: 65_536 }) })])
    await openOverride('a')
    expect(
      screen.getByText(`自定 ${(65_536).toLocaleString()};不再对半砍,只受模型上限夹。`),
    ).toBeTruthy()
  })

  it('两格各自提交,互不影响 —— 改上下文时 maxOutput 一个字不进补丁', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a', { override: over({ maxOutput: 8_192 }) })], { onWriteOverride })
    await openOverride('a')

    fireEvent.change(contextBox(), { target: { value: '300k' } })
    fireEvent.keyDown(contextBox(), { key: 'Enter' })
    expect(onWriteOverride).toHaveBeenCalledWith('a', { contextLength: 300_000 })
    // 另一格的草稿原样留着,也没被顺手写一遍。
    expect(outBox().value).toBe('8192')
    expect(onWriteOverride).toHaveBeenCalledTimes(1)
  })
})

/* ══ 第四格:能力五行(09-10)═══════════════════════════════════════════ */

/** 某一项那只分段器里的一格。五只同名三格,所以先按能力取组再在组里找。 */
const capSeg = (key: CapabilityKey, name: string) =>
  within(screen.getByTestId(`model-override-cap-${key}`)).getByRole('radio', { name })

describe('能力那一组', () => {
  it('五行都在,顺序照 MODEL_CAPS(视 工 推 出 文件),各带自己的名字', async () => {
    renderCatalog([row('a')])
    await openOverride('a')
    const group = screen.getByTestId('model-override-caps')
    const ids = [...group.querySelectorAll('[data-testid^="model-override-cap-"]')].map((el) =>
      el.getAttribute('data-testid'),
    )
    expect(ids).toEqual([
      'model-override-cap-vision',
      'model-override-cap-tools',
      'model-override-cap-reasoning',
      'model-override-cap-imageOutput',
      'model-override-cap-fileInput',
    ])
    // 每只分段器自己的名字 = 那一项的能力名(读屏软件靠它分得清五组)。
    expect(screen.getByTestId('model-override-cap-vision').getAttribute('aria-label')).toBe(
      '图像输入',
    )
    expect(screen.getByTestId('model-override-cap-fileInput').getAttribute('aria-label')).toBe(
      '文件输入',
    )
  })

  it('组是一只 role=group,名字与说明接在 Field 那一格上(五只分段器不各挂一份 id)', async () => {
    renderCatalog([row('a')])
    await openOverride('a')
    const group = screen.getByTestId('model-override-caps')
    expect(group.getAttribute('role')).toBe('group')
    const labelId = group.getAttribute('aria-labelledby')
    expect(labelId).toBeTruthy()
    expect(document.getElementById(labelId!)?.textContent).toBe('能力')
    const describedId = group.getAttribute('aria-describedby')
    expect(document.getElementById(describedId!)?.textContent).toBe(
      '关 = 这一型的请求不再带这项能力;开 = 目录说不支持也照发。',
    )
    // 全场**没有**第二个带同一个 id 的元素(五只分段器各自只有 aria-label)。
    // 不用 `#id` 选择器:`useId` 造出来的 id 带冒号,jsdom 这一档没有 CSS.escape。
    const sameId = [...document.querySelectorAll('[id]')].filter((el) => el.id === group.id)
    expect(sameId).toHaveLength(1)
  })

  it('点「关」只写那一键 —— 别的四项一个字不进补丁', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a')], { onWriteOverride })
    await openOverride('a')

    fireEvent.click(capSeg('vision', '关'))
    expect(onWriteOverride).toHaveBeenCalledWith('a', { caps: { vision: false } })
    expect(onWriteOverride).toHaveBeenCalledTimes(1)
  })

  it('工具那一行还在,点「关」写的是 tools 这一键(它并进五行,没退役)', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a')], { onWriteOverride })
    await openOverride('a')

    fireEvent.click(capSeg('tools', '关'))
    expect(onWriteOverride).toHaveBeenCalledWith('a', { caps: { tools: false } })
  })

  it('点回「跟目录」= 删这一键(inherit 不是第三种值)', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a', { override: over({ caps: { tools: false } }) })], { onWriteOverride })
    await openOverride('a')
    expect(capSeg('tools', '关').getAttribute('aria-checked')).toBe('true')
    // 没被说过的那几行仍停在「跟目录」。
    expect(capSeg('vision', '跟目录').getAttribute('aria-checked')).toBe('true')

    fireEvent.click(capSeg('tools', '跟目录'))
    expect(onWriteOverride).toHaveBeenCalledWith('a', { caps: { tools: null } })
  })

  it('每行右边那句小字说目录事实,三态各一句', async () => {
    renderCatalog([
      row('a', { catalog: { contextLength: null, maxOutput: null, caps: catalogCaps({ tools: true }) } }),
    ])
    await openOverride('a')
    const body = within(screen.getByTestId('model-override'))
    expect(body.getAllByText('目录:支持')).toHaveLength(1)
    expect(body.getAllByText('目录:不支持')).toHaveLength(4)
    expect(body.queryByText('目录:没填')).toBeNull()
  })

  it('手填行:五行都说「目录:没填」,而分段仍是三格(没填不等于不能覆盖)', async () => {
    renderCatalog([row('ghost', { manual: true, catalog: NO_CATALOG_FACTS })])
    await openOverride('ghost')
    const body = within(screen.getByTestId('model-override'))
    expect(body.getAllByText('目录:没填')).toHaveLength(5)
    expect(within(screen.getByTestId('model-override-cap-fileInput')).getAllByRole('radio')).toHaveLength(3)
  })
})

describe('恢复目录值', () => {
  it('七个键一起删(两个数 + 五项能力)', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog(
      [row('a', { override: over({ contextLength: 300_000, maxOutput: 8_192, caps: { tools: false } }) })],
      { onWriteOverride },
    )
    await openOverride('a')
    fireEvent.click(screen.getByTestId('model-override-reset'))
    expect(onWriteOverride).toHaveBeenCalledWith('a', {
      contextLength: null,
      maxOutput: null,
      caps: {
        vision: null,
        tools: null,
        reasoning: null,
        imageOutput: null,
        fileInput: null,
      },
    })
    // 两个框都清空 —— 屏幕上不许留着一个已经被删掉的数。
    expect(contextBox().value).toBe('')
    expect(outBox().value).toBe('')
  })

  it('没覆盖时禁用 —— 它无事可做', async () => {
    renderCatalog([row('a')])
    await openOverride('a')
    expect((screen.getByTestId('model-override-reset') as HTMLButtonElement).disabled).toBe(true)
  })

  it('只有最大输出被人填过时,它照样可按(第三格也算覆盖)', async () => {
    renderCatalog([row('a', { override: over({ maxOutput: 8_192 }) })])
    await openOverride('a')
    expect((screen.getByTestId('model-override-reset') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('在写(pending 逐行)', () => {
  it('这一行的钮与浮层控件一起禁,而且写不出去', async () => {
    const onWriteOverride = vi.fn()
    renderCatalog([row('a', { override: over({ contextLength: 300_000 }) }), row('b')], {
      onWriteOverride,
      pendingModelIds: new Set(['a']),
    })
    // 忙态下钮仍然点得开?不 —— 它自己就是禁的,所以先开再让它忙不现实:
    // 这里直接断言禁用那一格,浮层由下一条(未忙的行开着、忙起来)覆盖。
    expect((screen.getByTestId('configure-a') as HTMLButtonElement).disabled).toBe(true)
    // 别的行一个都不许动(律③粒度)。
    expect((screen.getByTestId('configure-b') as HTMLButtonElement).disabled).toBe(false)
  })

  it('浮层开着时这一行忙起来:七件控件全禁,点了也不写', async () => {
    const onWriteOverride = vi.fn()
    const view = renderCatalog([row('a', { override: over({ contextLength: 300_000 }) })], {
      onWriteOverride,
    })
    await openOverride('a')

    view.rerender(
      <>
        <FocusDispatchHarness />
        <ModelCatalog
          providerId="openrouter"
          rows={[row('a', { override: over({ contextLength: 300_000 }) })]}
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
          onRenameManual={vi.fn()}
          onWriteOverride={onWriteOverride}
        />
      </>,
    )

    expect(contextBox().disabled).toBe(true)
    // 五只分段器一只不落。
    for (const key of ['vision', 'tools', 'reasoning', 'imageOutput', 'fileInput'] as const) {
      expect((capSeg(key, '关') as HTMLButtonElement).disabled, key).toBe(true)
    }
    expect((screen.getByTestId('model-override-reset') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(capSeg('tools', '关'))
    fireEvent.click(screen.getByTestId('model-override-reset'))
    expect(onWriteOverride).not.toHaveBeenCalled()
  })
})

/* ══ 第五格:改模型 ID(09-11)══════════════════════════════════════════════
 * 报障原话「手写的不能改模型 id」。入口在这张浮层的**头部**:手填行的 id 那一行
 * 尾巴上一颗笔,点下去换成一条 `ui/InlineEditStrip`。目录里有的行**没有**这一格
 * (它的 id 是目录说的),而那不是「禁着的笔」—— 是压根不画。
 */

/** 手填的一行(目录对它什么都没说)。 */
const manualRow = (id: string) => row(id, { manual: true, catalog: NO_CATALOG_FACTS })

const pencil = (id: string) => screen.getByTestId(`model-override-rename-${id}`)
const idBox = () => screen.getByTestId('model-override-rename-input') as HTMLInputElement

describe('改模型 ID', () => {
  it('目录里有的行:头部照旧,一颗笔都没有', async () => {
    renderCatalog([row('a')])
    await openOverride('a')
    expect(screen.queryByTestId('model-override-rename-a')).toBeNull()
    expect(screen.queryByTestId('model-override-rename-input')).toBeNull()
  })

  it('手填行:点笔换成输入条,框里预填当前 id 且已选中全文', async () => {
    renderCatalog([manualRow('ghost')])
    await openOverride('ghost')
    expect(pencil('ghost').getAttribute('aria-label')).toBe('改模型 ID')

    fireEvent.click(pencil('ghost'))
    await waitFor(() => expect(screen.getByTestId('model-override-rename-input')).toBeTruthy())
    expect(idBox().value).toBe('ghost')
    // 一进来就 focus + 全选(`ui/inline-edit` 那一手)——接着打就是覆盖。
    expect(document.activeElement).toBe(idBox())
    expect(idBox().selectionStart).toBe(0)
    expect(idBox().selectionEnd).toBe('ghost'.length)
    // 读数那一行让位了:笔与它一起退场(一格里不摆两套同名的东西)。
    expect(screen.queryByTestId('model-override-rename-ghost')).toBeNull()
  })

  it('↵ 落定:递出去的是 **trim 过的**那个 id', async () => {
    const onRenameManual = vi.fn(() => undefined)
    renderCatalog([manualRow('ghost')], { onRenameManual })
    await openOverride('ghost')
    fireEvent.click(pencil('ghost'))
    fireEvent.change(idBox(), { target: { value: '  my-qwen  ' } })
    fireEvent.keyDown(idBox(), { key: 'Enter' })
    expect(onRenameManual).toHaveBeenCalledWith('ghost', 'my-qwen')
  })

  it('「保存」那颗钮走同一条路;空草稿时它自己是禁的', async () => {
    const onRenameManual = vi.fn(() => undefined)
    renderCatalog([manualRow('ghost')], { onRenameManual })
    await openOverride('ghost')
    fireEvent.click(pencil('ghost'))

    const save = () =>
      within(screen.getByTestId('model-override')).getByRole('button', {
        name: '保存',
      }) as HTMLButtonElement
    fireEvent.change(idBox(), { target: { value: '   ' } })
    expect(save().disabled).toBe(true)

    fireEvent.change(idBox(), { target: { value: 'my-qwen' } })
    fireEvent.click(save())
    expect(onRenameManual).toHaveBeenCalledWith('ghost', 'my-qwen')
  })

  it('被拒:红字就地说原因,**输入条不收、草稿一个字不清**', async () => {
    const onRenameManual = vi.fn(() => 'my-qwen 已经在这一坑的列表里了')
    renderCatalog([manualRow('ghost')], { onRenameManual })
    await openOverride('ghost')
    fireEvent.click(pencil('ghost'))
    fireEvent.change(idBox(), { target: { value: 'my-qwen' } })
    fireEvent.keyDown(idBox(), { key: 'Enter' })

    await waitFor(() =>
      expect(screen.getByText('my-qwen 已经在这一坑的列表里了')).toBeTruthy(),
    )
    // 边线转 danger 那一半给眼睛,aria-invalid 给读屏 —— 两件事都要在。
    expect(idBox().getAttribute('aria-invalid')).toBe('true')
    expect(idBox().value).toBe('my-qwen')

    // 接着打就把上一次那句话抹掉 —— 它是对上一次提交说的。
    fireEvent.change(idBox(), { target: { value: 'my-qwen-2' } })
    expect(screen.queryByText('my-qwen 已经在这一坑的列表里了')).toBeNull()
  })

  it('Esc 收回的是**这一格**,不是整张浮层(归响应链的瞬态口)', async () => {
    const onRenameManual = vi.fn(() => undefined)
    renderCatalog([manualRow('ghost')], { onRenameManual })
    await openOverride('ghost')
    fireEvent.click(pencil('ghost'))
    fireEvent.change(idBox(), { target: { value: 'my-qwen' } })

    act(() => {
      fireEvent.keyDown(idBox(), { key: 'Escape' })
    })
    await waitFor(() => expect(screen.queryByTestId('model-override-rename-input')).toBeNull())
    // 浮层还开着(它那句 onEscape 轮不到),而且一发都没写出去。
    expect(screen.getByTestId('model-override')).toBeTruthy()
    expect(onRenameManual).not.toHaveBeenCalled()
    // 再点开一次:草稿丢掉了,框里回到当前 id。
    fireEvent.click(pencil('ghost'))
    expect(idBox().value).toBe('ghost')
  })

  it('别的行在写不影响这一行的笔(律③粒度)', async () => {
    renderCatalog([manualRow('ghost'), manualRow('other')], {
      pendingModelIds: new Set(['ghost']),
    })
    // ghost 那一行的滑杆钮此刻是禁的(开不了浮层),other 那一行一个字不动。
    expect((screen.getByTestId('configure-ghost') as HTMLButtonElement).disabled).toBe(true)
    await openOverride('other')
    expect((pencil('other') as HTMLButtonElement).disabled).toBe(false)
  })

  it('浮层开着时这一行忙起来:读数态笔禁,编辑态框与两颗钮一起禁', async () => {
    const onRenameManual = vi.fn(() => undefined)
    const view = renderCatalog([manualRow('ghost')], { onRenameManual })
    await openOverride('ghost')
    expect((pencil('ghost') as HTMLButtonElement).disabled).toBe(false)

    /** 同一行、只把 `pendingModelIds` 换掉的那一帧。 */
    const busy = (
      <>
        <FocusDispatchHarness />
        <ModelCatalog
          providerId="openrouter"
          rows={[manualRow('ghost')]}
          phase="ready"
          dataRev={1}
          refresh={undefined}
          kind="api"
          query=""
          pendingModelIds={new Set(['ghost'])}
          write={undefined}
          onQuery={vi.fn()}
          onRefresh={vi.fn()}
          onToggle={vi.fn()}
          onSetCurrent={vi.fn()}
          onAddManual={vi.fn()}
          onRemoveManual={vi.fn()}
          onRenameManual={onRenameManual}
          onWriteOverride={vi.fn()}
        />
      </>
    )

    // ① 读数态:笔自己禁着。
    view.rerender(busy)
    expect((pencil('ghost') as HTMLButtonElement).disabled).toBe(true)

    // ② 编辑态:框 + 两颗钮一起禁,主钮换「正在保存…」,点了也写不出去。
    view.rerender(
      <>
        <FocusDispatchHarness />
        <ModelCatalog
          providerId="openrouter"
          rows={[manualRow('ghost')]}
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
          onRenameManual={onRenameManual}
          onWriteOverride={vi.fn()}
        />
      </>,
    )
    fireEvent.click(pencil('ghost'))
    fireEvent.change(idBox(), { target: { value: 'my-qwen' } })
    view.rerender(busy)

    const pop = () => within(screen.getByTestId('model-override'))
    expect(idBox().disabled).toBe(true)
    const saving = pop().getByRole('button', { name: /正在保存…/ }) as HTMLButtonElement
    expect(saving.disabled).toBe(true)
    expect(saving.getAttribute('aria-busy')).toBe('true')
    expect((pop().getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(saving)
    expect(onRenameManual).not.toHaveBeenCalled()
  })

  it('改成了:浮层**留在原位改到新 id 上**(目录层把 openOverride 换过去)', async () => {
    const onRenameManual = vi.fn(() => undefined)
    const view = renderCatalog([manualRow('ghost')], { onRenameManual })
    await openOverride('ghost')
    expect(openModelId()).toBe('ghost')

    fireEvent.click(pencil('ghost'))
    fireEvent.change(idBox(), { target: { value: 'my-qwen' } })
    fireEvent.keyDown(idBox(), { key: 'Enter' })

    // 写是乐观的:真店里行当场就换了 id,这里把那一帧演出来。
    view.rerender(
      <>
        <FocusDispatchHarness />
        <ModelCatalog
          providerId="openrouter"
          rows={[manualRow('my-qwen')]}
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
          onRenameManual={onRenameManual}
          onWriteOverride={vi.fn()}
        />
      </>,
    )
    await waitFor(() => expect(openModelId()).toBe('my-qwen'))
    // 回到读数态(改完那一格就收工了),而且笔还在 —— 还能再改一次。
    expect(screen.queryByTestId('model-override-rename-input')).toBeNull()
    expect(pencil('my-qwen')).toBeTruthy()
  })
})

/* ══ ③ 行上把「谁说的」画出来 ═══════════════════════════════════════════ */

describe('行上的覆盖读数', () => {
  it('上下文格换笔迹(ovr)+ 悬停出目录原值,禁 native title=', async () => {
    renderCatalog([row('a', { contextLength: 1_048_576, override: over({ contextLength: 1_048_576 }) })])
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
    expect(screen.getByTestId('out-a').className).not.toContain('ovr')
  })

  it('最大输出格同一手:换笔迹 + 悬停出目录原值,禁 native title=', async () => {
    renderCatalog([row('a', { maxOutput: 8_192, override: over({ maxOutput: 8_192 }) })])
    const cell = screen.getByTestId('out-a')
    expect(cell.className).toContain('ovr')
    expect(cell.getAttribute('title')).toBeNull()

    fireEvent.mouseEnter(cell)
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('自定 8.2k(目录 32.8k)'))
  })

  /* 上一格永远有个 128k 可说,这一格一个数都没有 —— 那就说那件事本身。 */
  it('最大输出:目录没填,括号里说的是「由服务商决定」而不是一个数', async () => {
    renderCatalog([
      row('ghost', {
        manual: true,
        maxOutput: 8_192,
        override: over({ maxOutput: 8_192 }),
        catalog: NO_CATALOG_FACTS,
      }),
    ])
    fireEvent.mouseEnter(screen.getByTestId('out-ghost'))
    await waitFor(() =>
      expect(screen.getByRole('tooltip').textContent).toBe('自定 8.2k(目录没填,不填则由服务商决定)'),
    )
  })

  it('目录没填时那句话说的是「默认 128k」,不是编一个目录值', async () => {
    renderCatalog([
      row('ghost', {
        manual: true,
        contextLength: 200_000,
        override: over({ contextLength: 200_000 }),
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
      row('a', {
        caps: [],
        override: over({ caps: { tools: false } }),
        catalog: { contextLength: 200_000, maxOutput: 32_768, caps: catalogCaps({ tools: true }) },
      }),
    ])
    const wrench = screen.getByTestId('cap-tools')
    expect(wrench.className).toContain('capOff')
    expect(wrench.getAttribute('aria-label')).toBe('自定:关闭工具调用(目录:支持)')
  })

  it('tools:true —— 目录没列它也画一枚,带虚线', () => {
    renderCatalog([row('a', { caps: ['tools'], override: over({ caps: { tools: true } }) })])
    const wrench = screen.getByTestId('cap-tools')
    expect(wrench.className).toContain('ovr')
    expect(wrench.className).not.toContain('capOff')
    expect(wrench.getAttribute('aria-label')).toBe('自定:支持工具调用(目录:不支持)')
  })

  /* 09-10:这一手从工具一枚泛化到能覆盖的五枚,名字进句子里那一格。 */
  it('vision:false —— 眼睛那一枚也画出来也划掉,名字换成「图像输入」', () => {
    renderCatalog([
      row('a', {
        caps: [],
        override: over({ caps: { vision: false } }),
        catalog: { contextLength: 200_000, maxOutput: 32_768, caps: catalogCaps({ vision: true }) },
      }),
    ])
    const eye = screen.getByTestId('cap-vision')
    expect(eye.className).toContain('capOff')
    expect(eye.getAttribute('aria-label')).toBe('自定:关闭图像输入(目录:支持)')
  })

  it('fileIn 那一枚(09-10 新)从 modalities 推,人开了也画得出来', () => {
    renderCatalog([row('a', { caps: ['fileIn'] })])
    expect(screen.getByTestId('cap-fileIn').getAttribute('aria-label')).toBe('文件输入')

    renderCatalog([
      row('ghost', {
        manual: true,
        caps: ['fileIn'],
        override: over({ caps: { fileInput: true } }),
        catalog: NO_CATALOG_FACTS,
      }),
    ])
    const clips = screen.getAllByTestId('cap-fileIn')
    const custom = clips[clips.length - 1]
    expect(custom.className).toContain('ovr')
    expect(custom.getAttribute('aria-label')).toBe('自定:支持文件输入(目录没填)')
  })

  it('`audioIn` 没有覆盖键 —— 它永远只听目录的,画不出虚线', () => {
    renderCatalog([row('a', { caps: ['audioIn'], override: over({ caps: { vision: false } }) })])
    const mic = screen.getByTestId('cap-audioIn')
    expect(mic.className).not.toContain('ovr')
    expect(mic.getAttribute('aria-label')).toBe('音频输入')
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
