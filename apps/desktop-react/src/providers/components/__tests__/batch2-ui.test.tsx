import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../../stage/store'
import { ModelCatalog } from '../ModelCatalog'
import { CredentialPool } from '../CredentialPool'
import { OAuthCard } from '../OAuthCard'
import { UsageCard } from '../UsageCard'
import { CustomProviderDialog } from '../CustomProviderDialog'
import { ModeCard } from '../ModeCard'
import { IDLE_AUTH_FLOW } from '../../auth'
import { NO_CATALOG_FACTS, NO_MODEL_OVERRIDE } from '../../types'
import type { CatalogRow, ProviderMode } from '../../types'
import type { PoolView } from '../../projection'
import poolCss from '../CredentialPool.module.css'

/**
 * 批二那几块新组件。它们全是**哑组件**(事实进、画面出),所以这一组直接喂它们
 * 事实,不经 store —— 判据那一半已经在 projection / auth / dials 三组里守过了,
 * 这里守的是**画面有没有兑现那些事实**。
 */

beforeEach(() => {
  // 断言的是中文那一份文案,语言得钉死(jsdom 的 navigator.language 是 en-US)。
  useStageStore.setState({ locale: 'zh' })
})

function row(id: string, over: Partial<CatalogRow> = {}): CatalogRow {
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
    ...over,
  }
}

function catalog(props: Partial<Parameters<typeof ModelCatalog>[0]> = {}) {
  return (
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
      chatMaxTokens={undefined}
      onQuery={vi.fn()}
      onRefresh={vi.fn()}
      onToggle={vi.fn()}
      onSetCurrent={vi.fn()}
      onAddManual={vi.fn()}
      onRemoveManual={vi.fn()}
      onWriteOverride={vi.fn()}
      {...props}
    />
  )
}

describe('ModelCatalog · 单价', () => {
  it('每百万的数原样画出来,不再乘一遍 1e6', () => {
    render(catalog({ rows: [row('gpt-5.6', { price: { input: 5, output: 30 } })] }))
    expect(screen.getByText('$5 / $30')).toBeTruthy()
  })

  it('订阅坑写「订阅内」;目录没给价写破折号', () => {
    render(catalog({ kind: 'subscription' }))
    expect(screen.getByText('订阅内')).toBeTruthy()
  })
})

describe('ModelCatalog · 设为当前 / 手填 ID', () => {
  it('当前那一行画读数,别的行画钮', () => {
    render(catalog({ rows: [row('a', { current: true }), row('b')] }))
    expect(screen.getByText('当前模型')).toBeTruthy()
    expect(screen.getByTestId('set-current-b')).toBeTruthy()
    expect(screen.queryByTestId('set-current-a')).toBeNull()
  })

  it('手填的行标出来,并且只有它有删除钮', () => {
    render(catalog({ rows: [row('a'), row('ghost', { manual: true, selected: true })] }))
    expect(screen.getByText('手填')).toBeTruthy()
    expect(screen.getByRole('button', { name: '删除 ghost' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除 a' })).toBeNull()
  })

  it('手填被拒时**当场显示原因且不清空输入框** —— 让人看得见自己刚打的是什么', () => {
    const onAddManual = vi.fn(() => 'a 已经在这一坑的列表里了')
    render(catalog({ onAddManual }))

    fireEvent.click(screen.getByRole('button', { name: '＋ 手填 ID' }))
    const field = screen.getByLabelText('手填模型 ID') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'a' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    expect(screen.getByText('a 已经在这一坑的列表里了')).toBeTruthy()
    expect(field.value).toBe('a')
  })

  it('手填成功就清空,好接着填下一个', () => {
    render(catalog({ onAddManual: vi.fn(() => undefined) }))
    fireEvent.click(screen.getByRole('button', { name: '＋ 手填 ID' }))
    const field = screen.getByLabelText('手填模型 ID') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'qwen3-max' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(field.value).toBe('')
  })

  /**
   * 09-02 批 10:这一行收编 `ui/Field` 的横排档,结掉 9a 留的那笔账 ——
   * 「错误那一句没有跟输入框关联」。断的是**关联**不是文字在不在:
   * 上面那条「被拒时显示原因」对手写 `<span>` 也绿,这一条不会。
   *
   * 反证:把 `error={addError}` 从 `<Field>` 上摘掉(错误改回自己画一个 span),
   * 或者把 `layout="inline"` 摘掉 —— 两处各当场红一条。
   */
  it('手填被拒:错误经 Field 的 error 槽关联到输入框(aria-describedby + aria-invalid)', () => {
    render(catalog({ onAddManual: vi.fn(() => 'a 已经在这一坑的列表里了') }))
    fireEvent.click(screen.getByRole('button', { name: '＋ 手填 ID' }))
    const field = screen.getByLabelText('手填模型 ID') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'a' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    expect(field.getAttribute('aria-invalid')).toBe('true')
    const describedBy = field.getAttribute('aria-describedby') as string
    expect(document.getElementById(describedBy)?.textContent).toBe('a 已经在这一坑的列表里了')

    // 名字来自一条真 `<label>`(只念不看),不再是 `aria-label` 那一句凭空的字符串。
    const labelId = field.getAttribute('aria-labelledby') as string
    const label = document.getElementById(labelId) as HTMLLabelElement
    expect(label.tagName).toBe('LABEL')
    expect(label.className).toBe('visually-hidden')
    expect(label.getAttribute('for')).toBe(field.id)

    // 形由库件给:横排档在根上落一格类,不是这块面自己掰 flex-direction。
    expect((label.parentElement as HTMLElement).className).toMatch(/_inline_/)
  })
})

describe('ModelCatalog · 厂牌折叠', () => {
  /** 70 行、两个厂牌 —— 过了折叠门槛。 */
  const many = [
    ...Array.from({ length: 40 }, (_, i) => row(`anthropic/m${i}`)),
    ...Array.from({ length: 30 }, (_, i) => row(`openai/m${i}`)),
  ]

  it('**收起的组不渲染行** —— 收起还渲染就等于没折叠', () => {
    render(catalog({ rows: many }))
    expect(screen.getByTestId('model-group-anthropic/')).toBeTruthy()
    expect(screen.queryByTestId('model-row-anthropic/m0')).toBeNull()
  })

  it('点组头才展开', () => {
    render(catalog({ rows: many }))
    fireEvent.click(screen.getByTestId('model-group-anthropic/'))
    expect(screen.getByTestId('model-row-anthropic/m0')).toBeTruthy()
    // 另一组仍然收着 —— 展开是逐组的。
    expect(screen.queryByTestId('model-row-openai/m0')).toBeNull()
  })

  it('已选置顶且始终展开,不藏在任何一组后面', () => {
    render(catalog({ rows: [...many, row('meta/picked', { selected: true })] }))
    expect(screen.getByTestId('model-row-meta/picked')).toBeTruthy()
    expect(screen.getByText(/已选 · 1/)).toBeTruthy()
  })

  it('检索时组自动展开,组头那颗钮同时被禁 —— 免得点一下就自相矛盾', () => {
    render(catalog({ rows: many, query: 'm1' }))
    expect(screen.getByTestId('model-row-anthropic/m0')).toBeTruthy()
    expect((screen.getByTestId('model-group-anthropic/') as HTMLButtonElement).disabled).toBe(true)
  })

  it('截断了就如实报剩余,不默默少画', () => {
    const huge = Array.from({ length: 200 }, (_, i) => row(`openai/m${i}`))
    render(catalog({ rows: huge, query: 'm' }))
    expect(screen.getByText(/还有 150 型没画出来/)).toBeTruthy()
  })

  it('行数不够就不折叠 —— 十几行折起来只是多两次点击', () => {
    render(catalog({ rows: [row('anthropic/a'), row('anthropic/b')] }))
    expect(screen.queryByTestId('model-group-anthropic/')).toBeNull()
    expect(screen.getByTestId('model-row-anthropic/a')).toBeTruthy()
  })
})

/* ── 凭证池 ──────────────────────────────────────────────────────────────── */

function pool(over: Partial<PoolView> = {}): PoolView {
  return {
    rows: [
      {
        id: 'e0',
        ordinal: 1,
        label: '个人',
        authType: 'apiKey',
        preview: '…8c1d',
        source: 'user',
        cooling: false,
      },
      {
        id: 'e1',
        ordinal: 2,
        label: '公司报销',
        authType: 'apiKey',
        preview: '…44f0',
        source: 'user',
        cooldownUntil: Date.now() + 4 * 60_000,
        cooling: true,
      },
    ],
    policy: 'priority-failover',
    policyUnavailable: false,
    ...over,
  }
}

function credentialPool(over: Partial<Parameters<typeof CredentialPool>[0]> = {}) {
  return (
    <CredentialPool
      providerId="grok"
      pool={pool()}
      busy={false}
      onAdd={vi.fn()}
      onReplace={vi.fn()}
      onRelabel={vi.fn()}
      onRemove={vi.fn()}
      onMove={vi.fn()}
      onRotation={vi.fn()}
      {...over}
    />
  )
}

/**
 * 09-02 批 12:行重排之后的凭证池。守的是**用户那五条拍板**逐条的落点,
 * 加上四形输入条共用一个槽位那条不变量。
 *
 * 与批 11 的差别(为什么整组改判而不是删断言换绿):
 *  · 尾号与备注名**不再是钮** —— 改密钥的入口是铅笔与 ⋯ 菜单两处;
 *  · 上移 / 下移从行上两颗钮改成菜单里两项,**到端点禁灰不消失**;
 *  · 删除从「钮上两段变字」改成行里长出一条确认条(菜单进);
 *  · 提交之后条**不当场收走**,跟着 `busy` 的下降沿判成败。
 */
/**
 * 「第 N 条那一格密钥输入框」。**按标签取会同时命中那颗铅笔钮**(两者共用同一个
 * 无障碍名 —— 那是有意的:它们是同一件事的两个面),所以这里按标签取完再按
 * 标签名筛出 `<input>` 那一个。
 */
function keyBox(ordinal: number): HTMLInputElement | undefined {
  return screen
    .queryAllByLabelText(`给第 ${ordinal} 条换一把密钥`)
    .find((el) => el.tagName === 'INPUT') as HTMLInputElement | undefined
}

/**
 * 一台**会像真 store 那样置忙**的替身。
 *
 * 判据在 `CredentialPool` 的 `usePoolWriteGate` 文件头:store 的 `writePool`
 * 第一句就是 `set({ poolBusy: true })`,而它是在点击处理器里**同步**跑到的 ——
 * 所以「提交」与「忙起来」落在同一次渲染里。这台替身照这条复刻:
 * `onReplace` 里同步 `setBusy(true)`,写完由测试自己调 `finish()` 放下来。
 *
 * 为什么不能用 `rerender(<CredentialPool busy />)` 那一手:那是**两次**渲染 ——
 * 中间夹着一次 `busy` 仍为 false 的 effect,而那一拍恰恰是「这次写根本没发」
 * 的签名。用错夹具会把一条真判据量成假红(09-02 批 12 复审时就是这么发现的)。
 */
function BusyHarness({
  onReplace,
  ready,
}: {
  onReplace: (entryId: string, apiKey: string) => void
  ready: (api: { finish: (error?: string) => void }) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  ready({
    finish: (next) => {
      setBusy(false)
      setError(next)
    },
  })
  return (
    <CredentialPool
      providerId="grok"
      pool={pool()}
      busy={busy}
      error={error}
      onAdd={vi.fn()}
      onReplace={(entryId, apiKey) => {
        // 与真 store 同一刻、同一次事件里置忙。
        setBusy(true)
        setError(undefined)
        onReplace(entryId, apiKey)
      }}
      onRelabel={vi.fn()}
      onRemove={vi.fn()}
      onMove={vi.fn()}
      onRotation={vi.fn()}
    />
  )
}

describe('CredentialPool', () => {
  it('序号画出来 —— 「第 1 条」和「最先用的那条」是同一件事', () => {
    render(credentialPool())
    expect(screen.getByText('密钥 · 2 条')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('② 动作多则收进 ⋯:休止态每行只有一颗 ⋯ 与一颗(占位的)铅笔,没有第三颗', () => {
    const { container } = render(credentialPool())
    const rows = container.querySelectorAll('li')
    expect(rows).toHaveLength(2)
    // 一行恰两颗钮:铅笔 + ⋯。上移 / 下移 / 删除都进了菜单。
    expect(rows[0].querySelectorAll('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '第 1 条的更多动作' })).toBeTruthy()
    // ⑤ 铅笔**在树上**(位置预留),看不看得见由 ui/Reveal 那副配方管。
    expect(screen.getByRole('button', { name: '给第 1 条换一把密钥' })).toBeTruthy()
  })

  it('尾号与备注名**不再是钮** —— 一段身份文字不该同时是一颗按钮', () => {
    render(credentialPool())
    const mask = screen.getByText('…8c1d')
    expect(mask.tagName).toBe('SPAN')
    expect(screen.getByText('个人').tagName).toBe('SPAN')
  })

  it('冷却读数写在那一条上', () => {
    render(credentialPool())
    expect(screen.getByText(/冷却中 剩 4 分钟/)).toBeTruthy()
  })

  it('② 菜单五项都在;到顶的上移 / 到底的下移**禁灰不消失**', () => {
    render(credentialPool())
    fireEvent.click(screen.getByRole('button', { name: '第 1 条的更多动作' }))
    for (const name of ['换一把密钥…', '改备注名…', '上移', '下移', '删除…']) {
      expect(screen.getByRole('menuitem', { name })).toBeTruthy()
    }
    // 第 1 条到顶:上移禁、下移活。
    expect((screen.getByRole('menuitem', { name: '上移' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('menuitem', { name: '下移' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('② 到底那一条反过来:下移禁、上移活,而且点了真的发出去', () => {
    const onMove = vi.fn()
    render(credentialPool({ onMove }))
    fireEvent.click(screen.getByRole('button', { name: '第 2 条的更多动作' }))
    expect((screen.getByRole('menuitem', { name: '下移' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: '上移' }))
    expect(onMove).toHaveBeenCalledWith('e1', -1)
  })

  it('④ 改密钥:旧尾号**留在屏上**当前缀,输入框顶替第 1 行,副行不动', () => {
    const onReplace = vi.fn()
    render(credentialPool({ onReplace }))
    fireEvent.click(screen.getByRole('button', { name: '给第 2 条换一把密钥' }))
    const box = keyBox(2)!
    expect(box.tagName).toBe('INPUT')
    // 密钥永不回读 —— 这一格从空开始。
    expect(box.value).toBe('')
    expect(box.type).toBe('password')
    // ① 旧值留屏:那一条的尾号仍然读得到(此刻它是左端那一格前缀)。
    expect(screen.getByText(/…44f0/)).toBeTruthy()
    // 副行还在 —— 改的是哪一条要看得见。
    expect(screen.getByText(/公司报销/)).toBeTruthy()
    fireEvent.change(box, { target: { value: 'sk-x' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onReplace).toHaveBeenCalledWith('e1', 'sk-x')
  })

  it('④ 序号在改密钥时换成对齐输入条的中线,改备注时不换', () => {
    const { container } = render(credentialPool())
    const ordinal = () => container.querySelector('li')!.firstElementChild!
    expect(ordinal().className).not.toContain(poolCss.ordinalMid)
    fireEvent.click(screen.getByRole('button', { name: '给第 1 条换一把密钥' }))
    expect(ordinal().className).toContain(poolCss.ordinalMid)
    fireEvent.keyDown(keyBox(1)!, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '第 1 条的更多动作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '改备注名…' }))
    expect(ordinal().className).not.toContain(poolCss.ordinalMid)
  })

  it('改密钥有 Save / Cancel 两颗真钮;**失焦不取消**,Esc 才收回', () => {
    const onReplace = vi.fn()
    render(credentialPool({ onReplace }))
    fireEvent.click(screen.getByRole('button', { name: '给第 1 条换一把密钥' }))
    const box = keyBox(1)!
    fireEvent.change(box, { target: { value: 'sk-x' } })
    // 失焦不取消:并肩站着两颗真钮,blur 早于 click 到 —— 收条会让它们点不到。
    fireEvent.blur(box)
    expect(keyBox(1)).toBeTruthy()
    expect(keyBox(1)!.value).toBe('sk-x')
    // 保存那一颗是真钮,点它与 ↵ 同一条路。
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onReplace).toHaveBeenCalledWith('e0', 'sk-x')
  })

  it('改密钥:Esc 收回,一个字都不写', () => {
    const onReplace = vi.fn()
    render(credentialPool({ onReplace }))
    fireEvent.click(screen.getByRole('button', { name: '给第 1 条换一把密钥' }))
    const box = keyBox(1)!
    fireEvent.change(box, { target: { value: 'sk-x' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onReplace).not.toHaveBeenCalled()
    expect(screen.getByText('…8c1d')).toBeTruthy()
  })

  it('空值时 Save 禁,打了字才活', () => {
    render(credentialPool())
    fireEvent.click(screen.getByRole('button', { name: '给第 1 条换一把密钥' }))
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(keyBox(1)!, { target: { value: 'sk-x' } })
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('改备注:走菜单进,现值预填,第 1 行的尾号原样留着', () => {
    const onRelabel = vi.fn()
    render(credentialPool({ onRelabel }))
    fireEvent.click(screen.getByRole('button', { name: '第 1 条的更多动作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '改备注名…' }))
    const box = screen.getByLabelText('改第 1 条的备注名') as HTMLInputElement
    // 备注名读得回来,所以从现值开始 —— 与密钥那一格(永不回读)不同。
    expect(box.value).toBe('个人')
    expect(box.type).toBe('text')
    expect(screen.getByText('…8c1d')).toBeTruthy()
    fireEvent.change(box, { target: { value: '我的' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onRelabel).toHaveBeenCalledWith('e0', '我的')
  })

  it('没改就不发 —— 一次空写只会让屏幕闪一下忙态', () => {
    const onRelabel = vi.fn()
    render(credentialPool({ onRelabel }))
    fireEvent.click(screen.getByRole('button', { name: '第 1 条的更多动作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '改备注名…' }))
    fireEvent.keyDown(screen.getByLabelText('改第 1 条的备注名'), { key: 'Enter' })
    expect(onRelabel).not.toHaveBeenCalled()
    // 没发也照样收条(没什么可等的)。
    expect(screen.queryByLabelText('改第 1 条的备注名')).toBeNull()
  })

  it('一次只允许一条输入条:开始添加会收掉正在编辑的那一行,反之亦然', () => {
    render(credentialPool())
    fireEvent.click(screen.getByRole('button', { name: '给第 1 条换一把密钥' }))
    expect(keyBox(1)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加密钥' }))
    expect(keyBox(1)).toBeUndefined()
    expect(screen.getByLabelText('新密钥')).toBeTruthy()
    // 反向:添加开着时去改一行的密钥,添加那一条收走。
    fireEvent.click(screen.getByRole('button', { name: '给第 2 条换一把密钥' }))
    expect(screen.queryByLabelText('新密钥')).toBeNull()
    expect(keyBox(2)).toBeTruthy()
  })

  it('③ 添加长在**列表顶部**:一行排完,Add 空值禁、打字后活', () => {
    const onAdd = vi.fn()
    const { container } = render(credentialPool({ onAdd }))
    const add = screen.getByRole('button', { name: '＋ 添加密钥' })
    expect(add.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(add)
    expect(add.getAttribute('aria-expanded')).toBe('true')
    // 顶部:添加那一条是列表的第一个 li,原来的第 1 条排在它下面。
    const rows = container.querySelectorAll('li')
    expect(rows).toHaveLength(3)
    expect(rows[0].querySelector('input')).toBeTruthy()
    expect(rows[1].textContent).toContain('…8c1d')
    expect((screen.getByRole('button', { name: '添加' }) as HTMLButtonElement).disabled).toBe(true)
    // 一进来光标落在**密钥**格:两格都要自动聚焦的话,后挂载的备注格会把它抢走。
    expect(document.activeElement).toBe(screen.getByLabelText('新密钥'))
    fireEvent.change(screen.getByLabelText('新密钥'), { target: { value: 'sk-new' } })
    fireEvent.change(screen.getByLabelText('备注名(可空)'), { target: { value: '备用' } })
    expect((screen.getByRole('button', { name: '添加' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(onAdd).toHaveBeenCalledWith('sk-new', '备用')
  })

  it('删除:菜单进,行里长出确认条(带后果那句话),Cancel 收回', () => {
    const onRemove = vi.fn()
    render(credentialPool({ onRemove }))
    fireEvent.click(screen.getByRole('button', { name: '第 2 条的更多动作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除…' }))
    expect(screen.getByText(/已经记在它名下的用量仍留在账本里/)).toBeTruthy()
    // 第 1、2 行不动。
    expect(screen.getByText('…44f0')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.queryByText(/已经记在它名下的用量/)).toBeNull()
  })

  it('删除:确认条上那颗危险钮才真删', () => {
    const onRemove = vi.fn()
    render(credentialPool({ onRemove }))
    fireEvent.click(screen.getByRole('button', { name: '第 1 条的更多动作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除…' }))
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(onRemove).toHaveBeenCalledWith('e0')
  })

  it('只剩一条时照样删得动 —— 空池是合法终态,不是禁令', () => {
    const onRemove = vi.fn()
    render(credentialPool({ onRemove, pool: pool({ rows: [pool().rows[0]] }) }))
    fireEvent.click(screen.getByRole('button', { name: '第 1 条的更多动作' }))
    const del = screen.getByRole('menuitem', { name: '删除…' }) as HTMLButtonElement
    expect(del.disabled).toBe(false)
    fireEvent.click(del)
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(onRemove).toHaveBeenCalledWith('e0')
  })

  it('落定等后端回话:忙态里条还在、主钮说「正在保存…」,写完了才收', () => {
    const onReplace = vi.fn()
    let api = { finish: (_?: string) => {} }
    render(<BusyHarness onReplace={onReplace} ready={(next) => { api = next }} />)
    fireEvent.click(screen.getByRole('button', { name: '给第 1 条换一把密钥' }))
    fireEvent.change(keyBox(1)!, { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    // 忙态里:条还在,主钮改口,取消一并禁(写已经发出去了,取消不掉它)。
    expect(keyBox(1)).toBeTruthy()
    expect(screen.getByRole('button', { name: /正在保存/ })).toBeTruthy()
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true)
    act(() => api.finish())
    expect(keyBox(1)).toBeUndefined()
  })

  it('后端拒了:那句原话落卡底,**条留着、草稿不丢**,再点一次就是重试', () => {
    const onReplace = vi.fn()
    let api = { finish: (_?: string) => {} }
    render(<BusyHarness onReplace={onReplace} ready={(next) => { api = next }} />)
    fireEvent.click(screen.getByRole('button', { name: '给第 1 条换一把密钥' }))
    fireEvent.change(keyBox(1)!, { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    act(() => api.finish('401 Unauthorized'))
    expect(screen.getByText('401 Unauthorized')).toBeTruthy()
    const box = keyBox(1)!
    expect(box.value).toBe('sk-x')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onReplace).toHaveBeenCalledTimes(2)
  })

  /*
   * 09-02 批 12 复审抓到的真 bug 的守卫。store 有**不置忙就返回**的路:
   * `removeCredential` 在这条 entry 已经不在池里时直接 return
   * (`providers/store.ts:881`)—— 复现路径是「确认条开着时这条 entry 被别处
   * 删掉(SSE 对账),再点一次删除」。首版只等「看见 busy 升起」,于是相位
   * 永远停在 submitted:条卡在「正在保存…」,别的行的 ⋯ 与铅笔全禁。
   */
  it('store 不置忙就返回(那次写根本没发):条当场收掉,不卡在「正在保存…」', () => {
    // 这个 onRemove 就是那条早返回的路:它什么都不做,busy 一次都不升。
    const onRemove = vi.fn()
    render(credentialPool({ onRemove }))
    fireEvent.click(screen.getByRole('button', { name: '第 1 条的更多动作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除…' }))
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(onRemove).toHaveBeenCalledWith('e0')
    // 条收掉了(确认那句后果不在了),而且没有任何一颗钮卡在忙态。
    expect(screen.queryByText(/已经记在它名下的用量/)).toBeNull()
    expect(screen.queryByRole('button', { name: /正在保存/ })).toBeNull()
    // 别的行没被那次「永不落地的写」禁住。
    expect(
      (screen.getByRole('button', { name: '第 2 条的更多动作' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  /*
   * 换一坑把相位一并归零(复审点名的第二半)。**这一条的反证观察不到差别**,
   * 如实记:修好 `submitted` 那一档之后,相位在 `busy` 为 false 的任何一拍都会
   * 自己收敛回 idle,而 `busy` 为 true 时整坑本来就是禁着的 —— 于是「换坑时
   * 相位还挂着」这件事在今天的任何一种状态下都看不出来。
   * 归零那一句仍然留着:它把「换一坑 = 什么都不带过去」变成**这块面自己的
   * 不变量**,而不是一条要靠上面那台状态机的收敛性去论证的结论。
   * 这一条测的是那个不变量看得见的那半边:换坑之后条没了、没有任何一颗钮卡着。
   */
  it('换一坑:条不跟过来,也没有一颗钮卡在忙态', () => {
    const onReplace = vi.fn()
    let api = { finish: (_?: string) => {} }
    const { rerender } = render(
      <BusyHarness onReplace={onReplace} ready={(next) => { api = next }} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '给第 1 条换一把密钥' }))
    fireEvent.change(keyBox(1)!, { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByRole('button', { name: /正在保存/ })).toBeTruthy()
    // 忙态还没落下来就换了一坑:条与相位都得清干净。
    rerender(credentialPool({ providerId: 'kimi' }))
    expect(keyBox(1)).toBeUndefined()
    expect(screen.queryByRole('button', { name: /正在保存/ })).toBeNull()
    expect(
      (screen.getByRole('button', { name: '第 1 条的更多动作' }) as HTMLButtonElement).disabled,
    ).toBe(false)
    // 新开一条也不该长在忙态里(相位若跟过来,这一条会画成「正在保存…」)。
    fireEvent.click(screen.getByRole('button', { name: '给第 1 条换一把密钥' }))
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /正在保存/ })).toBeNull()
    // 收尾:替身那一格状态不留给下一条用例。
    act(() => api.finish())
  })

  it('忙态:别的行的 ⋯ 与铅笔一并禁(池写吃的是整串 id,不是某一行的事)', () => {
    render(credentialPool({ busy: true }))
    expect(
      (screen.getByRole('button', { name: '第 1 条的更多动作' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: '给第 1 条换一把密钥' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByRole('button', { name: '＋ 添加密钥' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('空池:列表位置一句话,轮换选择器禁灰', () => {
    render(credentialPool({ pool: pool({ rows: [] }) }))
    expect(screen.getByText('还没有密钥。')).toBeTruthy()
    expect((screen.getByLabelText('轮换策略') as HTMLButtonElement).disabled).toBe(true)
    // 开始添加时那句话让位 —— 此刻「还没有」已经不是实情了。
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加密钥' }))
    expect(screen.queryByText('还没有密钥。')).toBeNull()
  })

  it('换一坑 = 换一池钥匙:没提交的草稿绝不跟过来', () => {
    const { rerender } = render(credentialPool())
    fireEvent.click(screen.getByRole('button', { name: '给第 1 条换一把密钥' }))
    fireEvent.change(keyBox(1)!, { target: { value: 'sk-x' } })
    rerender(credentialPool({ providerId: 'kimi' }))
    expect(keyBox(1)).toBeUndefined()
  })

  it('每一档策略都带一句语义说明 —— 三个名字单看字面分不出来', () => {
    render(credentialPool())
    expect(screen.getByText(/从上往下取第一条可用的/)).toBeTruthy()
  })

  it('插件策略不可用:仍然显示它、并说清正在用什么顶着', () => {
    render(credentialPool({ pool: pool({ policy: 'plugin:x:round', policyUnavailable: true }) }))
    // 选择器里必须有一格能显示它,否则会画成空白、看起来像没设过。
    expect(screen.getByLabelText('轮换策略').textContent).toContain('plugin:x:round(不可用)')
    expect(screen.getByText(/正在用内置的「按序接力」/)).toBeTruthy()
    // 认不出的策略没有语义句可说 —— 不编一句。
    expect(screen.queryByText(/从上往下取第一条可用的/)).toBeNull()
  })

  it('② OAuth 行只有一个动作 → **常驻一颗钮**,不收菜单也不画铅笔', () => {
    const onRemove = vi.fn()
    render(
      credentialPool({
        onRemove,
        pool: pool({
          rows: [
            {
              id: 'o0',
              ordinal: 1,
              label: '',
              authType: 'oauth',
              oauthAccount: 'me@example.com',
              source: 'oauth',
              cooling: false,
            },
          ],
        }),
      }),
    )
    expect(screen.getByText('me@example.com')).toBeTruthy()
    // 没有密钥可换,也没有 ⋯。
    expect(screen.queryByRole('button', { name: '给第 1 条换一把密钥' })).toBeNull()
    expect(screen.queryByRole('button', { name: '第 1 条的更多动作' })).toBeNull()
    // 那一颗钮走的是与 API key 行**同一条**确认条。
    fireEvent.click(screen.getByRole('button', { name: '删除第 1 条' }))
    expect(screen.getByText(/已经记在它名下的用量仍留在账本里/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(onRemove).toHaveBeenCalledWith('o0')
  })
})

/* ── 登录卡 ──────────────────────────────────────────────────────────────── */

function oauth(over: Partial<Parameters<typeof OAuthCard>[0]> = {}) {
  return (
    <OAuthCard
      status={undefined}
      flow={IDLE_AUTH_FLOW}
      accounts={0}
      onSignIn={vi.fn()}
      onCode={vi.fn()}
      onSubmitCode={vi.fn()}
      onCancel={vi.fn()}
      onSignOut={vi.fn()}
      {...over}
    />
  )
}

describe('OAuthCard', () => {
  it('没登录:一颗真的登录钮 + 说明这是什么', () => {
    render(oauth())
    expect((screen.getByRole('button', { name: '登录' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText(/不产生额外 API 费用/)).toBeTruthy()
  })

  it('设备码流:大字码 + 验证网址 + 等待句 + 取消', () => {
    render(
      oauth({
        flow: {
          ...IDLE_AUTH_FLOW,
          kind: 'device',
          device: { userCode: 'XKCD-2048', verificationUri: 'https://x.ai/device' },
        },
      }),
    )
    expect(screen.getByText('XKCD-2048')).toBeTruthy()
    expect(screen.getByText('https://x.ai/device')).toBeTruthy()
    expect(screen.getByText(/本页自动接续/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消登录' })).toBeTruthy()
  })

  it('贴码流:显示**后端原话**的说明,提交走 onSubmitCode', () => {
    const onSubmitCode = vi.fn()
    render(
      oauth({
        flow: {
          ...IDLE_AUTH_FLOW,
          kind: 'paste',
          code: 'abc',
          paste: { state: 's', instructions: '去浏览器里把码抄回来' },
        },
        onSubmitCode,
      }),
    )
    expect(screen.getByText('去浏览器里把码抄回来')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(onSubmitCode).toHaveBeenCalled()
  })

  it('失败显示**服务商原话**,不换成一句「登录失败」', () => {
    render(oauth({ flow: { ...IDLE_AUTH_FLOW, kind: 'browser', error: 'invalid_grant: 码过期了' } }))
    expect(screen.getByText('invalid_grant: 码过期了')).toBeTruthy()
  })

  it('已登录:账号 / 套餐 / 令牌状态 / 有效期 / 退出', () => {
    render(
      oauth({
        status: {
          success: true,
          isLoggedIn: true,
          expiresAt: new Date(2026, 7, 31, 9, 12).getTime(),
          account: { email: 'me@example.com', planType: 'Max' },
        },
        accounts: 1,
      }),
    )
    expect(screen.getByText('me@example.com')).toBeTruthy()
    expect(screen.getByText('套餐 Max')).toBeTruthy()
    expect(screen.getByText(/令牌有效 · 有效期至 08-31 09:12/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '退出 me@example.com' })).toBeTruthy()
    expect(screen.getByText('这一坑支持多账号 · 现有 1 个')).toBeTruthy()
  })

  /** 「登过但过期」说成「未登录」= 让人再走一遍完整登录流。 */
  it('过期:说的是「需要重新授权」,不是「未登录」', () => {
    render(oauth({ status: { success: true, isLoggedIn: true, isExpired: true } }))
    expect(screen.getByText(/令牌已过期,需要重新授权/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新授权' })).toBeTruthy()
  })
})

/* ── 用量卡 ──────────────────────────────────────────────────────────────── */

describe('UsageCard', () => {
  it('套餐 / Credits / 主次窗口 % 与重置时刻', () => {
    render(
      <UsageCard
        status="ready"
        onRefresh={vi.fn()}
        usage={{
          success: true,
          providerId: 'codex',
          usage: {
            planType: 'Plus',
            credits: { hasCredits: true, unlimited: true },
            limits: [
              {
                id: 'codex',
                primary: { usedPercent: 34, windowSeconds: 5 * 3600, resetAt: new Date(2026, 7, 31, 16, 0).getTime() },
                secondary: { usedPercent: 12, windowSeconds: 7 * 86_400 },
              },
            ],
          },
        }}
      />,
    )
    expect(screen.getByText('Plus')).toBeTruthy()
    expect(screen.getByText('Unlimited')).toBeTruthy()
    expect(screen.getByText('Primary · 5h 窗口')).toBeTruthy()
    expect(screen.getByText('34%')).toBeTruthy()
    expect(screen.getByText('08-31 16:00 重置')).toBeTruthy()
    expect(screen.getByText('Secondary · 7d 窗口')).toBeTruthy()
  })

  /** 0% 是「一点没用」,缺席是「不知道」—— 在屏幕上长得像,在事实上差得远。 */
  it('拿不到百分比:说「服务商未给数」,**不画一根 0 宽的条**', () => {
    const { container } = render(
      <UsageCard
        status="ready"
        onRefresh={vi.fn()}
        usage={{
          success: true,
          providerId: 'codex',
          usage: { limits: [{ id: 'codex', primary: { usedPercent: Number.NaN } }] },
        }}
      />,
    )
    expect(screen.getAllByText('服务商未给数').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[class*="meterFill"]')).toHaveLength(0)
  })

  it('刷新那颗钮绕过缓存', () => {
    const onRefresh = vi.fn()
    render(
      <UsageCard
        status="ready"
        onRefresh={onRefresh}
        usage={{ success: true, providerId: 'codex', usage: { limits: [] } }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(onRefresh).toHaveBeenCalled()
    expect(screen.getByText('60s 缓存')).toBeTruthy()
  })
})

/* ── 自定义家 ────────────────────────────────────────────────────────────── */

describe('CustomProviderDialog', () => {
  function dialog(over: Partial<Parameters<typeof CustomProviderDialog>[0]> = {}) {
    return (
      <CustomProviderDialog
        open
        onClose={vi.fn()}
        onSave={vi.fn()}
        {...over}
      />
    )
  }

  it('必填在**提交时**才拦,不在打字时报红', () => {
    const onSave = vi.fn()
    render(dialog({ onSave }))
    expect(screen.queryByText('名称必填')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(screen.getByText('名称必填')).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('填齐必填才交出去', () => {
    const onSave = vi.fn()
    render(dialog({ onSave }))
    fireEvent.change(screen.getByLabelText('名称 · 必填'), { target: { value: '我的 vLLM' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(screen.getByText('Base URL 必填')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Base URL · 必填'), {
      target: { value: 'http://192.168.1.8:8000/v1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: '我的 vLLM', baseUrl: 'http://192.168.1.8:8000/v1', apiType: 'openai' }),
    )
  })

  /*
   * 09-01「动作单产地 = 右键上下文菜单」之后,**对话框页脚不再有删除**:
   * 它搬去了行的右键菜单(`ProviderRowMenu`),两段就地确认也搬进了库件
   * (`ui/Menu` 的 `confirmLabel`)。所以这里守的从「有那颗钮」翻成
   * 「**没有**那颗钮」—— 单产地的意思是只有一处,留一个「顺手也能删」的
   * 第二入口就等于没搬。
   */
  it('页脚**没有**删除钮 —— 删除只在行右键菜单一处', () => {
    render(
      dialog({
        editingId: 'custom-1',
        initial: {
          name: 'vLLM',
          description: '',
          apiType: 'openai',
          baseUrl: 'http://x/v1',
          apiKey: '',
          model: '',
        },
      }),
    )
    expect(screen.queryByRole('button', { name: /删除这一家/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /真删/ })).toBeNull()
  })

  it('新建时没有删除钮 —— 还不存在的东西删不了', () => {
    render(dialog())
    expect(screen.queryByRole('button', { name: '删除这一家' })).toBeNull()
  })
})

/* ── 计费档位 ────────────────────────────────────────────────────────────── */

describe('ModeCard · 计费档位', () => {
  function mode(providerId: string): ProviderMode {
    return {
      providerId,
      kind: 'api',
      name: providerId,
      requiresApiKey: true,
      requiresOAuth: false,
      defaultBaseUrl: 'https://api.test/v1',
    }
  }

  function modeCard(providerId: string, config?: Record<string, unknown>) {
    return (
      <ModeCard
        mode={mode(providerId)}
        config={config as never}
        dialsPending={false}
        pool={pool({ rows: [] })}
        poolBusy={false}
        onAddKey={vi.fn()}
        onReplaceKey={vi.fn()}
        onRelabelKey={vi.fn()}
        onRemoveKey={vi.fn()}
        onMoveKey={vi.fn()}
        onRotation={vi.fn()}
        onDials={vi.fn()}
        onBaseUrl={vi.fn()}
        authStatus={undefined}
        authFlow={IDLE_AUTH_FLOW}
        onSignIn={vi.fn()}
        onAuthCode={vi.fn()}
        onSubmitAuthCode={vi.fn()}
        onCancelAuth={vi.fn()}
        onSignOut={vi.fn()}
        usage={undefined}
        usageStatus="idle"
        onRefreshUsage={vi.fn()}
      />
    )
  }

  it('没有旋钮的家一格都不画', () => {
    render(modeCard('claude'))
    expect(screen.queryByLabelText('Qwen API mode')).toBeNull()
  })

  it('千问:计费方式 + 版本 + 风险原话', () => {
    render(modeCard('qwen'))
    expect(screen.getByLabelText('Qwen API mode')).toBeTruthy()
    expect(screen.getByLabelText('Qwen region')).toBeTruthy()
    expect(
      screen.getByText('订阅用户必须选对档位。用通用 Key 和地址调用会走按量计费，在订阅之外额外扣钱。'),
    ).toBeTruthy()
  })

  it('Kimi 选了编程套餐时**版本那一行整行收起**,不留一个拨了不动的选择器', () => {
    render(modeCard('kimi', { kimiApiMode: 'standard' }))
    expect(screen.getByLabelText('Kimi region')).toBeTruthy()

    render(modeCard('kimi', { kimiApiMode: 'coding-plan' }))
    expect(screen.queryAllByLabelText('Kimi region')).toHaveLength(1)
  })

  it('拨一格:档位与 baseUrl 一起交出去', () => {
    const onDials = vi.fn()
    render(
      <ModeCard
        mode={mode('zhipu')}
        config={undefined}
        dialsPending={false}
        pool={pool({ rows: [] })}
        poolBusy={false}
        onAddKey={vi.fn()}
        onReplaceKey={vi.fn()}
        onRelabelKey={vi.fn()}
        onRemoveKey={vi.fn()}
        onMoveKey={vi.fn()}
        onRotation={vi.fn()}
        onDials={onDials}
        onBaseUrl={vi.fn()}
        authStatus={undefined}
        authFlow={IDLE_AUTH_FLOW}
        onSignIn={vi.fn()}
        onAuthCode={vi.fn()}
        onSubmitAuthCode={vi.fn()}
        onCancelAuth={vi.fn()}
        onSignOut={vi.fn()}
        usage={undefined}
        usageStatus="idle"
        onRefreshUsage={vi.fn()}
      />,
    )
    // Select 是自绘的 combobox 而不是原生 <select>:先点开触发器,再点那一格。
    fireEvent.click(screen.getByLabelText('Zhipu API mode'))
    fireEvent.click(screen.getByRole('option', { name: 'Coding Plan' }))
    expect(onDials).toHaveBeenCalledWith('coding-plan', '')
  })
})
