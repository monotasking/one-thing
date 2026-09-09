import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useStageStore } from '../../../stage/store'
import { ErrorBoundary } from '../../../components/ErrorBoundary'
import cardCss from '../../../ui/Card.module.css'
import fieldCss from '../../../ui/Field.module.css'
import groupHeadCss from '../../../ui/GroupHead.module.css'
import statusDotCss from '../../../ui/StatusDot.module.css'
import { IDLE_AUTH_FLOW } from '../../auth'
import type { PoolView } from '../../projection'
import { NO_CATALOG_FACTS, NO_MODEL_OVERRIDE } from '../../types'
import type { CatalogRow, ProviderMode, RailRow, StatusTone } from '../../types'
import { CredentialPool } from '../CredentialPool'
import { CustomProviderDialog } from '../CustomProviderDialog'
import { ModelCatalog } from '../ModelCatalog'
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

/* ── 批 2c:模型目录的两条组头 ──────────────────────────────────────────── */

function catalogRow(id: string, over: Partial<CatalogRow> = {}): CatalogRow {
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

/** 70 行两个厂牌 —— 过了折叠门槛,两形组头才会同屏出现。 */
const MANY: CatalogRow[] = [
  ...Array.from({ length: 40 }, (_, i) => catalogRow(`anthropic/m${i}`)),
  ...Array.from({ length: 30 }, (_, i) => catalogRow(`openai/m${i}`)),
]

function renderCatalog(rows: readonly CatalogRow[], query = '') {
  return render(
    <ModelCatalog
      providerId="openrouter"
      rows={rows}
      phase="ready"
      dataRev={1}
      refresh={undefined}
      kind="api"
      query={query}
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
    />,
  )
}

describe('GroupHead 收编:模型目录的两条组头(批 2c)', () => {
  it('两形同屏且都由库件画:「已选」是静态 div,厂牌那条是可折叠的钮', () => {
    const { container } = renderCatalog([
      ...MANY,
      catalogRow('meta/picked', { selected: true }),
    ])
    const heads = [...container.querySelectorAll(`.${groupHeadCss.head}`)]
    // 已选那条 + anthropic/ + openai/ + meta/(单行也自成一组)。
    expect(heads.length).toBeGreaterThanOrEqual(3)
    const statics = heads.filter((h) => h.tagName === 'DIV')
    const toggles = heads.filter((h) => h.tagName === 'BUTTON')
    expect(statics.length).toBe(1)
    expect(statics[0].textContent).toContain('已选')
    expect(toggles.length).toBe(heads.length - 1)
  })

  it('本地那份组头配方**一条都不剩** —— 没有第二个产地在画同一个词', () => {
    const { container } = renderCatalog(MANY)
    const strays = [...container.querySelectorAll('div,button,span')].filter(
      (el) =>
        [...el.classList].some((c) => /_group(Head|Toggle|Caret|Name|Note)_/.test(c)),
    )
    expect(strays).toEqual([])
  })

  it('caret 与 aria-expanded 归库件同源翻转(收起 ▸ / 展开 ▾)', () => {
    const head = (root: HTMLElement) =>
      root.querySelector('[data-testid="model-group-anthropic/"]') as HTMLElement

    const { container: shut } = renderCatalog(MANY)
    expect(head(shut).getAttribute('aria-expanded')).toBe('false')
    expect(head(shut).querySelector(`.${groupHeadCss.caret}`)?.textContent).toBe('▸')

    // 检索时组由判据打开:aria-expanded 翻真、caret 跟着翻,而钮同时被禁。
    const { container: open } = renderCatalog(MANY, 'm1')
    expect(head(open).getAttribute('aria-expanded')).toBe('true')
    expect(head(open).querySelector(`.${groupHeadCss.caret}`)?.textContent).toBe('▾')
    expect((head(open) as HTMLButtonElement).disabled).toBe(true)
  })

  it('组名与读数各就各位:名字在 label 槽(落点皮肤给 mono),读数在 note 槽', () => {
    const { container } = renderCatalog(MANY)
    const btn = container.querySelector(
      '[data-testid="model-group-anthropic/"]',
    ) as HTMLElement
    const label = btn.querySelector(`.${groupHeadCss.label}`)
    expect(label?.textContent).toBe('anthropic/')
    // 落点事实包在内容那一层,不去覆盖库件的 .label(名册同一手)。
    expect(label?.firstElementChild?.className).toMatch(/_vendorName_/)
    expect(btn.querySelector(`.${groupHeadCss.note}`)?.textContent).toContain('40')
  })
})

/* ── 批 2c:错误边界那张卡 ──────────────────────────────────────────────── */

describe('Card 收编:分区错误边界的错误卡(批 2c)', () => {
  // React 接住错之后仍会往 console.error 打一整篇,那是 React 的行为不是被测对象。
  let quiet: ReturnType<typeof vi.spyOn>
  beforeAll(() => {
    quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterAll(() => quiet.mockRestore())

  function Bomb(): never {
    throw new Error('炸了')
  }

  it('错误卡的外框是 ui/Card 的 pad=lg 档,role 与 testid 经透传落在同一个根上', () => {
    render(
      <ErrorBoundary where="files">
        <Bomb />
      </ErrorBoundary>,
    )
    const card = screen.getByTestId('error-card-files')
    expect(card.classList.contains(cardCss.card)).toBe(true)
    expect(card.classList.contains(cardCss.padLg)).toBe(true)
    expect(card.classList.contains(cardCss.padMd)).toBe(false)
    expect(card.classList.contains(cardCss.bordered)).toBe(true)
    // 透传的两件事都在**同一个**节点上 —— 没有为了挂 role 再包一层 div。
    expect(card.getAttribute('role')).toBe('alert')
    expect(screen.getByRole('alert')).toBe(card)
  })

  it('本地那份卡配方不剩一条:落点皮肤已改名,不再是第 7 个「卡」的产地', () => {
    render(
      <ErrorBoundary where="chat">
        <Bomb />
      </ErrorBoundary>,
    )
    const card = screen.getByTestId('error-card-chat')
    expect([...card.classList].some((c) => /^_card_/.test(c) && c !== cardCss.card)).toBe(false)
    expect([...card.classList].some((c) => /_errorCard_/.test(c))).toBe(true)
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
        onRelabel={() => {}}
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
        onRelabelKey={() => {}}
        onRemoveKey={() => {}}
        onMoveKey={() => {}}
        onRotation={() => {}}
        onDials={() => {}}
        onBaseUrl={() => {}}
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

  /**
   * 批 2b 留的那条账(「Segmented 那一格 Field 的 label 指空」)在 09-02 批 8b
   * 结清:批 8a 的两半 —— Field 多交一格 `aria-labelledby`、Segmented 开
   * HTMLAttributes 透传 —— 让这一格照旧一句 `{...field}` 就接上了。
   *
   * 反证:把 `CompatSegmented` 里的 `{...field}` 摘掉 → 两条都真红
   *(名字没了、labelledby 没了)。所以这里刻意**不再**给 Segmented 传
   * 它自己的 `label`:传了的话名字有两个产地,摘掉 field 也照样叫得出名字,
   * 这条断言就成了陪跑。
   */
  it('分段器那一格的名字来自 Field 的 label(aria-labelledby 真接上了)', () => {
    const { baseElement } = open()
    const group = screen.getByRole('radiogroup', { name: '兼容形 · 必填' })
    const by = group.getAttribute('aria-labelledby')
    expect(by).toBeTruthy()
    const label = baseElement.querySelector(`#${by}`)
    expect(label?.tagName).toBe('LABEL')
    expect(label?.textContent).toBe('兼容形 · 必填')
    // 名字只有一个产地:这一格不再自带 aria-label。
    expect(group.getAttribute('aria-label')).toBeNull()
    // 它就长在那一格 Field 里,不是页面上另一处同名的东西。
    expect(group.closest(`.${fieldCss.field}`)).toBe(label?.parentElement)
  })
})

/**
 * **批 8b:三处「檐三件」收进 `ui/Card` 的 title / note / actions。**
 *
 * 批 2b 时 Card 的檐只有两槽(标题 + 弱色注),塞不下第三件,于是 UsageCard 与
 * CredentialPool 各写了一份 `.head` —— 正是立 Card 要治的病本身。批 8a 补了
 * `actions` 那一格,这里把两处收编。
 *
 * 判据同上:比的是**谁画的**(class 与 `ui/Card.module.css` 导出的同值),
 * 外加读源文本证明本地那几条真的删了(CSS Modules 在 vitest 里是 proxy,
 * `usageCss.head` 永远不是 undefined,那种断言会陪跑)。
 */
describe('Card 檐三件收编(批 8b)', () => {
  function stripComments(file: string) {
    return readFileSync(path.resolve(__dirname, file), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
  }

  it('订阅用量的檐三件:标题 / 缓存读数 / 刷新钮 全在 Card 自己的檐里', () => {
    const { container } = render(
      <UsageCard
        usage={{ usage: { limits: [] } } as never}
        status="ready"
        onRefresh={() => {}}
      />,
    )
    const card = container.querySelector(`.${cardCss.card}`)!
    const head = card.querySelector(`.${cardCss.head}`)
    expect(head).toBeTruthy()
    // 檐是卡的**第一个**孩子:它若掉进卡身,下面的读数就会挤到它上面去。
    expect(card.firstElementChild).toBe(head)
    const title = head!.querySelector(`.${cardCss.title}`)
    expect(title?.tagName).toBe('H3')
    expect(title?.textContent).toBe('订阅用量')
    expect(head!.querySelector(`.${cardCss.note}`)?.textContent).toBe('60s 缓存')
    // 刷新钮在檐右那一撮里,不是散在檐上。
    const actions = head!.querySelector(`.${cardCss.actions}`)
    expect(actions?.querySelector('button')?.textContent).toBe('刷新')
  })

  /*
   * 09-02 批 12:那句常驻读法(`note` 的 below 档)**退役**。所以这一条从
   * 「note 在 below 档」改判成「檐里两件在,而 note 两档一格都不在」——
   * 断言换的是判据,不是删掉一条断言换个绿:退役也要有守卫,否则下一个人
   * 顺手把它加回来没有任何东西会红。
   */
  it('凭证池的檐:读数 + 添加钮在檐里;那句常驻读法两档都不在了', () => {
    const { container } = render(
      <CredentialPool
        providerId="demo"
        pool={EMPTY_POOL}
        busy={false}
        onAdd={() => {}}
        onReplace={() => {}}
        onRelabel={() => {}}
        onRemove={() => {}}
        onMove={() => {}}
        onRotation={() => {}}
      />,
    )
    const card = container.querySelector(`.${cardCss.card}`)!
    const head = card.querySelector(`.${cardCss.head}`)
    expect(card.firstElementChild).toBe(head)
    expect(head!.querySelector(`.${cardCss.title}`)?.tagName).toBe('H3')
    expect(head!.querySelector(`.${cardCss.actions}`)?.querySelector('button')?.textContent).toBe(
      '＋ 添加密钥',
    )
    // 两档 note 一格都不在:「顺序即优先级」交给底部轮换那一句语义说明,
    // 「换 key 不换条目」是只在改密钥那一刻才需要知道的常识,不常驻。
    expect(card.querySelector(`.${cardCss.noteBelow}`)).toBeNull()
    expect(head!.querySelector(`.${cardCss.note}`)).toBeNull()
  })

  it('两处本地的檐配方都删干净了(读源文本,CSS Modules 的 proxy 判不了)', () => {
    for (const file of ['../UsageCard.module.css', '../CredentialPool.module.css']) {
      const css = stripComments(file)
      expect(css).not.toContain('.head')
      expect(css).not.toContain('.title')
    }
    // UsageCard 的 `.cache` 一起走了;CredentialPool 的 `.hint` **留着** ——
    // 它还有两个消费者(「最后一条不可删」的理由、轮换策略那句语义说明)。
    expect(stripComments('../UsageCard.module.css')).not.toContain('.cache')
    expect(stripComments('../CredentialPool.module.css')).toContain('.hint')
  })
})
