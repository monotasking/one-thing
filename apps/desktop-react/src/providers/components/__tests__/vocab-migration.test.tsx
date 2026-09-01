import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useStageStore } from '../../../stage/store'
import cardCss from '../../../ui/Card.module.css'
import fieldCss from '../../../ui/Field.module.css'
import groupHeadCss from '../../../ui/GroupHead.module.css'
import statusDotCss from '../../../ui/StatusDot.module.css'
import { IDLE_AUTH_FLOW } from '../../auth'
import type { PoolView } from '../../projection'
import type { ProviderMode, RailRow, StatusTone } from '../../types'
import { CredentialPool } from '../CredentialPool'
import { CustomProviderDialog } from '../CustomProviderDialog'
import { ModeCard } from '../ModeCard'
import { OAuthCard } from '../OAuthCard'
import { ProviderRail } from '../ProviderRail'
import { UsageCard } from '../UsageCard'

/**
 * **批 2b「视觉词汇收编」的兜底证词。**
 *
 * 这一批的主证是真机逐态截图对照(26 面,像素差 0)。但真机走不到全部状态 ——
 * 一台全新的 store 里没有凭证也没有登录过,于是名册的状态点只出现 idle / off
 * 两档,登录卡只画得出「没登过」那一屏。**照不到的那几档由这一组守**:
 * 判据不是「长什么样」(那是截图的事),是**它到底是不是那件库件画的** ——
 * 断言比的是渲染出来的 class 与库件 module.css 导出的 class **同一个值**,
 * 所以它不吃 CSS Modules 的哈希、也不会因为某天有人在本地又抄一份配方而漏判。
 *
 * 反证跑过:把 ProviderRail 里的 `<StatusDot>` 换回本地 span → 五档全红;
 * 把 OAuthCard 的 `<Card>` 换回 `<section className={s.card}>` → 卡那一条红。
 */

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

const TONES: StatusTone[] = ['ok', 'bad', 'warn', 'idle', 'off']

function railRow(tone: StatusTone): RailRow {
  return {
    familyId: `fam-${tone}`,
    label: `家 ${tone}`,
    initial: 'F',
    facts: [],
    tone,
    group: 'cloud',
    custom: false,
  }
}

function renderRail(rows: readonly RailRow[]) {
  return render(
    <ProviderRail
      rows={rows}
      connectedCount={rows.length}
      selectedId={null}
      query=""
      onQuery={() => {}}
      onSelect={() => {}}
      onAddCustom={() => {}}
      onRowMenu={() => {}}
    />,
  )
}

const EMPTY_POOL: PoolView = {
  rows: [],
  policy: 'sequential',
  policyUnavailable: false,
  canDelete: false,
}

function mode(over: Partial<ProviderMode> = {}): ProviderMode {
  return {
    providerId: 'demo',
    kind: 'localCli',
    name: 'demo',
    requiresApiKey: false,
    requiresOAuth: false,
    defaultBaseUrl: 'https://example.test/v1',
    ...over,
  }
}

describe('StatusDot 收编:五档全部由库件画', () => {
  // 真机截图只走到 idle / off 两档(全新 store 没有凭证也没登录过)——
  // ok / bad / warn 三档是这条断言的全部理由。
  it.each(TONES)('名册行的 tone=%s 挂的是 ui/StatusDot 的那两个类', (tone) => {
    const { container } = renderRail([railRow(tone)])
    const dot = container.querySelector(`.${statusDotCss.dot}`)
    expect(dot).toBeTruthy()
    expect(dot?.classList.contains(statusDotCss[tone])).toBe(true)
    // 旁边就是名字与副行,点是纯装饰 —— 给它一个名会让读屏软件念两遍。
    expect(dot?.getAttribute('aria-hidden')).toBe('true')
    expect(dot?.getAttribute('aria-label')).toBeNull()
  })

  it('名册里没有任何一颗本地画的点了', () => {
    const { container } = renderRail(TONES.map(railRow))
    expect(container.querySelectorAll(`.${statusDotCss.dot}`).length).toBe(5)
    // 本地 dot 配方若复活,它的类名不会等于库件那个值。
    const all = [...container.querySelectorAll('span')]
    const strays = all.filter(
      (el) =>
        [...el.classList].some((c) => /(^|_)dot/i.test(c))
        && !el.classList.contains(statusDotCss.dot),
    )
    expect(strays).toEqual([])
  })

  it.each([
    ['登着', false, statusDotCss.ok],
    ['登着但过期了', true, statusDotCss.warn],
  ])('登录卡「%s」那一屏的点走库件', (_label, isExpired, expected) => {
    const { container } = render(
      <OAuthCard
        status={{
          isLoggedIn: true,
          isExpired,
          expiresAt: 1_900_000_000_000,
          account: { email: 'a@b.c' },
        } as never}
        flow={IDLE_AUTH_FLOW}
        accounts={1}
        onSignIn={() => {}}
        onCode={() => {}}
        onSubmitCode={() => {}}
        onCancel={() => {}}
        onSignOut={() => {}}
      />,
    )
    const dot = container.querySelector(`.${statusDotCss.dot}`)
    expect(dot).toBeTruthy()
    expect(dot?.classList.contains(expected)).toBe(true)
  })
})

describe('GroupHead 收编:名册的组头', () => {
  it('组头是 ui/GroupHead 的静态形(一个 div,不进 Tab 序)', () => {
    const { container } = renderRail([
      railRow('ok'),
      { ...railRow('idle'), familyId: 'local-1', group: 'local' },
    ])
    const heads = [...container.querySelectorAll(`.${groupHeadCss.head}`)]
    expect(heads.length).toBe(2)
    for (const head of heads) {
      expect(head.tagName).toBe('DIV')
      expect(head.getAttribute('aria-expanded')).toBeNull()
    }
  })

  it('组名走 GroupHead 的 label 槽,读数那一格连 DOM 都不渲染', () => {
    const { container } = renderRail([railRow('ok')])
    const head = container.querySelector(`.${groupHeadCss.head}`)
    expect(head?.querySelector(`.${groupHeadCss.label}`)?.textContent).toBe('云服务')
    // 组头不挂计数徽,也不挂读数 —— 空槽不渲染(GroupHead 的生命状态契约)。
    expect(head?.querySelector(`.${groupHeadCss.note}`)).toBeNull()
    expect(head?.querySelector(`.${groupHeadCss.caret}`)).toBeNull()
  })
})

describe('Card 收编:详情栏那几张卡', () => {
  it.each([
    [
      '凭证池',
      <CredentialPool
        key="pool"
        providerId="demo"
        pool={EMPTY_POOL}
        busy={false}
        onAdd={() => {}}
        onReplace={() => {}}
        onRemove={() => {}}
        onMove={() => {}}
        onRotation={() => {}}
      />,
    ],
    [
      '订阅用量',
      <UsageCard
        key="usage"
        usage={{ usage: { limits: [] } } as never}
        status="ready"
        onRefresh={() => {}}
      />,
    ],
    [
      '本机进程',
      <ModeCard
        key="mode"
        mode={mode()}
        config={undefined}
        dialsPending={false}
        pool={EMPTY_POOL}
        poolBusy={false}
        onAddKey={() => {}}
        onReplaceKey={() => {}}
        onRemoveKey={() => {}}
        onMoveKey={() => {}}
        onRotation={() => {}}
        onDials={() => {}}
        authStatus={undefined}
        authFlow={IDLE_AUTH_FLOW}
        onSignIn={() => {}}
        onAuthCode={() => {}}
        onSubmitAuthCode={() => {}}
        onCancelAuth={() => {}}
        onSignOut={() => {}}
        usage={undefined}
        usageStatus="idle"
        onRefreshUsage={() => {}}
      />,
    ],
    [
      '登录卡',
      <OAuthCard
        key="oauth"
        status={undefined}
        flow={IDLE_AUTH_FLOW}
        accounts={0}
        onSignIn={() => {}}
        onCode={() => {}}
        onSubmitCode={() => {}}
        onCancel={() => {}}
        onSignOut={() => {}}
      />,
    ],
  ])('%s 的外框是 ui/Card 的默认档(pad=md + 有边线)', (_name, node) => {
    const { container } = render(node)
    const card = container.querySelector(`.${cardCss.card}`)
    expect(card).toBeTruthy()
    expect(card?.classList.contains(cardCss.padMd)).toBe(true)
    expect(card?.classList.contains(cardCss.bordered)).toBe(true)
    // 卡不长交互态:它不是控件,身上不许出现按钮语义。
    expect(card?.getAttribute('role')).toBeNull()
    expect(card?.tagName).toBe('DIV')
  })
})

describe('Field 收编:自定义家对话框', () => {
  function open() {
    return render(
      <CustomProviderDialog open initial={undefined} onClose={() => {}} onSave={() => {}} />,
    )
  }

  it('六格全部走 ui/Field', () => {
    const { baseElement } = open()
    expect(baseElement.querySelectorAll(`.${fieldCss.field}`).length).toBe(6)
  })

  it('标签与控件真的关联上了(htmlFor ↔ id),而不是只画了个样子', () => {
    const { baseElement } = open()
    const fields = [...baseElement.querySelectorAll(`.${fieldCss.field}`)]
    const withInput = fields.filter((f) => f.querySelector('input'))
    // 五格是输入框(名称 / 描述 / Base URL / 密钥 / 默认模型),一格是分段器。
    expect(withInput.length).toBe(5)
    for (const field of withInput) {
      const label = field.querySelector('label')
      const input = field.querySelector('input')
      expect(label?.getAttribute('for')).toBeTruthy()
      expect(input?.id).toBe(label?.getAttribute('for'))
    }
  })

  it('说明(hint)在场时进 aria-describedby,缺席时那一格不渲染 DOM', () => {
    const { baseElement } = open()
    const fields = [...baseElement.querySelectorAll(`.${fieldCss.field}`)]
    const hinted = fields.filter((f) => f.querySelector(`.${fieldCss.hint}`))
    // Base URL 与默认模型两格有说明,其余四格没有 —— 空槽不渲染。
    expect(hinted.length).toBe(2)
    for (const field of hinted) {
      const hint = field.querySelector(`.${fieldCss.hint}`)
      const input = field.querySelector('input')
      expect(input?.getAttribute('aria-describedby')).toBe(hint?.id)
    }
    for (const field of fields) {
      expect(field.querySelectorAll(`.${fieldCss.error}`).length).toBe(0)
    }
  })

  it('表单级的那条错误留在表单上,不挂进任何一格(不许说错是哪儿错了)', () => {
    const { baseElement } = open()
    // 提交时才拦(打字时不报红)—— 这一颗就是那条判据的入口。
    screen.getByText('添加').click()
    for (const field of baseElement.querySelectorAll(`.${fieldCss.field}`)) {
      expect(field.querySelector(`.${fieldCss.error}`)).toBeNull()
      expect(field.querySelector('input')?.getAttribute('aria-invalid') ?? null).toBeNull()
    }
  })
})
