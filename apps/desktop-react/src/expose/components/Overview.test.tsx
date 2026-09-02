import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useStageStore } from '../../stage/store'
import { ExposeView } from './ExposeView'
import {
  GROUPS,
  SESSIONS,
  SESSION_META,
  seedSessionsFailure,
  seedSessionsSource,
} from '../../data/__fixtures__/sessions'
import { configureSessionsPort } from '../../data/sessions-port'
import { sessionMutation, sessionsQuery } from '../../data/sessions-source'
import { useExposeStore } from '../store'
import { initialExposeState } from '../transitions'

/**
 * 这一批是「折叠/展开原地形变」的回归闸(用户实机报的 bug:
 * 鼠标停在原地只能点一次,再点没反应)。真因是折叠态与展开态曾是**两个不同的
 * DOM 结构** —— 折叠行 .collapsedRow 是整行按钮,展开后组头换成另一套几何,
 * 指针底下那个点落到了不可点的 .groupPath 上。
 *
 * 所以这里断言的不是「点了会变」,而是「同一个节点连点 N 次 = 切换 N 次」:
 * 前者旧代码也过,后者只有原地形变才过。
 */
const FIRST_GROUP = GROUPS[0].id

beforeEach(() => {
  useStageStore.setState({ locale: 'zh', placements: {} })
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState, view: { mode: 'overview' } })
})

/**
 * 「摆出来」不再是 Overview 的 prop,而是 stage store 里的事实(AutoFocusSearch
 * 叶子自己去问,见 use-live.ts)—— 测试的排布跟着改成真往 store 里摆一份。
 */
const placeSessions = () =>
  useStageStore.setState((s) => ({
    placements: { ...s.placements, sessions: { kind: 'edge', side: 'right' } },
  }))

const ids = () =>
  screen
    .getAllByTestId(/^group-toggle-/)
    .map((el) => el.getAttribute('data-testid'))

describe('总览组头:折叠/展开是原地形变', () => {
  it('鼠标不动连点四次 = 精确切换四次,且每次命中的是同一个 DOM 节点', () => {
    render(<ExposeView />)
    const toggle = screen.getByTestId(`group-toggle-${FIRST_GROUP}`)

    expect(useExposeStore.getState().collapsedGroups).not.toContain(FIRST_GROUP)
    for (const expected of [true, false, true, false]) {
      // 故意不重新查询:复用同一个引用,模拟「指针一动不动再点一次」
      fireEvent.click(toggle)
      expect(useExposeStore.getState().collapsedGroups.includes(FIRST_GROUP)).toBe(expected)
      expect(screen.getByTestId(`group-toggle-${FIRST_GROUP}`)).toBe(toggle)
    }
  })

  it('组头在两态里是同一个节点,aria-expanded 跟着翻,组头本身不被卸载', () => {
    render(<ExposeView />)
    const toggle = screen.getByTestId(`group-toggle-${FIRST_GROUP}`)
    expect(toggle).toHaveProperty('isConnected', true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(toggle.isConnected).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.isConnected).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('组的次序只由数据决定,手动折叠不重排', () => {
    render(<ExposeView />)
    const before = ids()
    fireEvent.click(screen.getByTestId(`group-toggle-${FIRST_GROUP}`))
    expect(ids()).toEqual(before)
    fireEvent.click(screen.getByTestId('group-toggle-collab'))
    expect(ids()).toEqual(before)
  })

  it('折叠只收起卡片区,组头那一行仍在(所以位置不跳)', () => {
    render(<ExposeView />)
    const toggle = screen.getByTestId(`group-toggle-${FIRST_GROUP}`)
    const headerBefore = toggle.parentElement
    fireEvent.click(toggle)
    expect(toggle.parentElement).toBe(headerBefore)
    expect(headerBefore?.isConnected).toBe(true)
  })
})

/**
 * D1 的新行为:**没有卡时不回退 mock**。三种「空」各说各的话 ——
 * 还在读 / 读不到(没连上 core)/ 真的一条会话都没有。
 */
describe('会话侧的三种空态', () => {
  it('读不到时说的是「没连上 core」,并带上那句错误原文', async () => {
    await seedSessionsFailure('连不上')
    render(<ExposeView />)
    expect(screen.getByText('没连上 core')).toBeTruthy()
    expect(screen.getByText(/连不上/)).toBeTruthy()
  })

  it('还在读时说的是「正在读会话」,不画一张假卡', () => {
    // 律①:骨架 / 等待只看 `phase === 'initial'` —— 「从来没有过列表」。
    seedSessionsSource({ sessions: [], phase: 'initial' })
    render(<ExposeView />)
    expect(screen.getByText('正在读会话…')).toBeTruthy()
    expect(screen.queryAllByTestId(/^group-toggle-/).length).toBe(0)
  })

  it('真的一条都没有时是「这里还没有会话」', () => {
    seedSessionsSource({ sessions: [] })
    render(<ExposeView />)
    expect(screen.getByText('这里还没有会话')).toBeTruthy()
  })

  /**
   * 律①:等待态的判据**只有** `phase === 'initial'`(「从来没有过列表」),
   * 不许掺 `inflight`。
   *
   * 分得开的那一档正是这里:后端说过「你一条会话都没有」(phase 走到 ready),
   * 此刻一发后台重拉在飞 —— 该说的仍然是「这里还没有会话」。掺了 inflight 的话,
   * 每秒一次的重拉都会把这句话换成「正在读会话…」再换回来,一句结论闪成一个转圈。
   * (有卡的那一档由「有卡就画卡」那条分支兜住,分不出两种判据。)
   */
  it('空列表 + 后台重拉在飞:说的仍是「这里还没有会话」,不是「正在读」', async () => {
    seedSessionsSource({ sessions: [] })
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    configureSessionsPort({
      ready: async () => undefined,
      listMeta: async () => {
        await gate
        return { success: true, sessions: [] }
      },
      getSegments: async () => ({ success: true, segments: [] }),
      getMessagesPage: async () => ({ success: true, messages: [] }),
      getUserMarkers: async () => ({ success: true, markers: [] }),
      create: async () => ({ success: false, error: 'not stubbed' }),
      updateWorkingDirectory: async () => ({ success: true }),
      onSessionEvent: () => () => undefined,
      onSessionLifecycle: () => () => undefined,
    })

    let flying!: Promise<void>
    await act(async () => {
      flying = sessionsQuery.refetch()
      await Promise.resolve()
    })
    render(<ExposeView />)

    expect(sessionsQuery.get().inflight).toBe(true)
    expect(sessionsQuery.get().phase).toBe('ready')
    expect(screen.getByText('这里还没有会话')).toBeTruthy()
    expect(screen.queryByText('正在读会话…')).toBeNull()

    await act(async () => {
      release()
      await flying
    })
  })
})

/**
 * ── 7e 规范修正(勘察偏离 5 结掉)──────────────────────────────────────────
 * 从前这块面只有一种画法:整块「没连上 core」空态,而它排在「有卡就画卡」
 * 后面 —— 于是**手上有列表时那句错永远画不出来**(分支顺序把它遮住了)。
 * 现在错误与列表**并存**:卡照留在屏上(律②),表头下面多一行原话。
 */
describe('错误与列表并存', () => {
  it('手上有列表时:卡还在屏上,同时多出那一行原话', async () => {
    await seedSessionsFailure('连不上', SESSIONS)
    render(<ExposeView />)

    // 列表没被清掉 —— 组还在,卡还在(这一句就是律②)。
    expect(screen.getAllByTestId(/^group-toggle-/).length).toBeGreaterThan(0)
    // 那句错也在,而且是那一行(role=status),不是整块空态。
    const line = screen.getByRole('status')
    expect(line.textContent).toContain('没连上 core')
    expect(line.textContent).toContain('连不上')
    // 整块空态的两句话一句都没出现(它们是「屏幕上没有卡」那一档的)。
    expect(screen.queryByText('这里还没有会话')).toBeNull()
    expect(screen.queryByText('正在读会话…')).toBeNull()
  })

  it('搜不到词的那一屏照样说 —— 手上有列表这件事不因为过滤而改变', async () => {
    await seedSessionsFailure('连不上', SESSIONS)
    useExposeStore.setState({ query: '绝不可能命中的词' })
    render(<ExposeView />)

    expect(screen.getByRole('status').textContent).toContain('连不上')
  })

  it('没有错误时那一行不在场(零常驻像素)', () => {
    seedSessionsSource()
    render(<ExposeView />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})

/**
 * 律③:异步动作的反馈长在**发起它的那个控件**上,而且是**逐格**的。
 * 建会话唯一的入口就是组头那颗 `+`。
 */
describe('新建入口的进行中反馈', () => {
  /** 可控的一发建会话:拿住「正在飞」那一刻,拿计时器去撞是碰运气。 */
  function flyCreate(): { land: () => void; done: Promise<unknown> } {
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    configureSessionsPort({
      ready: async () => undefined,
      // 落地之后 settle 会重拉一次 —— 回的是同一份样本,于是 `equals` 判「没变」、
      // kernel 留住上一份、屏幕上那些组一个都不换(顺带就是律④那条守卫)。
      listMeta: async () => ({ success: true, sessions: SESSION_META }),
      getSegments: async () => ({ success: true, segments: [] }),
      getMessagesPage: async () => ({ success: true, messages: [] }),
      getUserMarkers: async () => ({ success: true, markers: [] }),
      create: async () => {
        await gate
        return {
          success: true,
          session: { id: 'new-1', name: 'New Chat', messages: [], createdAt: 0, updatedAt: 0 },
        }
      },
      updateWorkingDirectory: async () => ({ success: true }),
      onSessionEvent: () => () => undefined,
      onSessionLifecycle: () => () => undefined,
    })
    /*
     * 直接跑那只 mutation,而不是点钮走 `newSession` —— 这一批要钉的是
     * 「控件读的是不是那一格忙态」,而 `newSession` 后面还挂着进会话 / 开聊天面
     * 一整串编排(那条链在 data/session-create.test.ts 里钉)。
     */
    return { land: release, done: sessionMutation.run({ kind: 'create', projectId: null }) }
  }

  afterEach(() => sessionMutation.reset())

  it('在飞时那颗 + 上 aria-busy —— 逐格,不是整面禁灰', async () => {
    seedSessionsSource()
    render(<ExposeView />)
    const plus = screen.getByTestId(`group-plus-${FIRST_GROUP}`)
    expect(plus.getAttribute('aria-busy')).toBeNull()

    let flight!: ReturnType<typeof flyCreate>
    await act(async () => {
      flight = flyCreate()
      await Promise.resolve()
    })
    expect(screen.getByTestId(`group-plus-${FIRST_GROUP}`).getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      flight.land()
      await flight.done
    })
    expect(screen.getByTestId(`group-plus-${FIRST_GROUP}`).getAttribute('aria-busy')).toBeNull()
  })

  it('二次闸:飞着的时候再点几下,一发都不发出去', async () => {
    seedSessionsSource()
    render(<ExposeView />)
    const calls: (string | null)[] = []
    const before = useExposeStore.getState().newSession
    useExposeStore.setState({ newSession: async (projectId) => void calls.push(projectId) })
    try {
      let flight!: ReturnType<typeof flyCreate>
      await act(async () => {
        flight = flyCreate()
        await Promise.resolve()
      })
      fireEvent.click(screen.getByTestId(`group-plus-${FIRST_GROUP}`))
      fireEvent.click(screen.getByTestId(`group-plus-${FIRST_GROUP}`))
      expect(calls).toEqual([])

      await act(async () => {
        flight.land()
        await flight.done
      })
      // 落地之后那颗钮照常工作 —— 闸是「在飞时」而不是「按过一次就废」。
      fireEvent.click(screen.getByTestId(`group-plus-${FIRST_GROUP}`))
      expect(calls).toEqual([GROUPS[0].projectId])
    } finally {
      useExposeStore.setState({ newSession: before })
    }
  })

  it('**不用 disabled**:在飞时那颗钮仍在焦点序里(禁灰会当场把键盘的人甩掉)', async () => {
    seedSessionsSource()
    render(<ExposeView />)
    let flight!: ReturnType<typeof flyCreate>
    await act(async () => {
      flight = flyCreate()
      await Promise.resolve()
    })
    expect(screen.getByTestId(`group-plus-${FIRST_GROUP}`).hasAttribute('disabled')).toBe(false)
    await act(async () => {
      flight.land()
      await flight.done
    })
  })
})

/**
 * ── F 批:搜索是过滤器,不换形态 ──────────────────────────────────────────
 * 这一批钉的正是「屏幕没变形」这件事:输入词之后仍然是组头 + 卡网格
 * (同样的 group-toggle / card-* testid、同样的结构),只是内容少了。
 * 曾经这里会整块换成 SearchResults 的三层缩进列表 —— 那条呈现连同它的组件一起删了。
 */
describe('总览搜索:过滤器,不是第四种形态', () => {
  const type = (value: string) =>
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value } })

  it('搜索时屏幕仍是「项目头 + 卡网格」:组头与卡的 testid 一个没换', () => {
    render(<ExposeView />)
    type('Exposé')
    expect(screen.getByTestId(`group-toggle-${FIRST_GROUP}`)).toBeTruthy()
    expect(screen.getByTestId('card-os-expose')).toBeTruthy()
    // 卡上的预览眼睛还在 —— 搜索结果照常能 QuickLook。
    expect(screen.getByTestId('card-preview-os-expose')).toBeTruthy()
  })

  it('不命中的卡消失,变空的组整个消失', () => {
    render(<ExposeView />)
    type('Exposé')
    expect(screen.queryByTestId('card-os-provider')).toBeNull()
    expect(screen.queryByTestId('group-toggle-collab')).toBeNull()
    expect(screen.queryByTestId('group-toggle-loose')).toBeNull()
  })

  it('命中项目名时该组整组保留 —— 组里每一条都还在', () => {
    render(<ExposeView />)
    type('start-electron')
    for (const id of ['os-provider', 'os-compact', 'os-expose', 'os-toolkit']) {
      expect(screen.getByTestId(`card-${id}`)).toBeTruthy()
    }
    // 别的组不因为项目命中而留下。
    expect(screen.queryByTestId('card-tr-menubar')).toBeNull()
  })

  it('命中词在卡上高亮', () => {
    render(<ExposeView />)
    type('Exposé')
    const marks = [...document.querySelectorAll('mark')].map((m) => m.textContent)
    expect(marks).toContain('Exposé')
  })

  it('搜不到时是一行灰字,不是「这里还没有会话」也不是插画', () => {
    render(<ExposeView />)
    type('这个词哪儿都没有')
    expect(screen.getByText('没有匹配的会话')).toBeTruthy()
    expect(screen.queryByText('这里还没有会话')).toBeNull()
    expect(screen.queryAllByTestId(/^card-/).length).toBe(0)
  })

  it('清空搜索词就回到全量,一格没变', () => {
    render(<ExposeView />)
    const before = screen.getAllByTestId(/^card-[^p]/).map((el) => el.getAttribute('data-testid'))
    type('Exposé')
    type('')
    expect(screen.getAllByTestId(/^card-[^p]/).map((el) => el.getAttribute('data-testid'))).toEqual(
      before,
    )
  })

  it('回车进入的是屏幕上第一张卡(过滤后的阅读次序,不是第二套命中排序)', () => {
    render(<ExposeView />)
    type('transreader')
    fireEvent.keyDown(screen.getByLabelText('搜索会话'), { key: 'Enter' })
    expect(useExposeStore.getState().currentSessionId).toBe('tr-menubar')
  })
})


/**
 * ── 08-30 键盘死区(用户实机报)────────────────────────────────────────────
 * 面板开出来之后键盘无处可去:焦点还在 Dock 那块瓦上,一按空格就把面板又关了;
 * 点进搜索条之后 ↑↓←→ 与空格全被输入框吃掉,键盘党永远走不到卡上。
 *
 * 修法两条,这一组把两条都钉住:摆出来就把焦点交给搜索条;搜索条里的 ↑↓ 再把
 * 焦点交给卡网格(词留着)。**←→ 故意不接** —— 它们在一个还在编辑的输入框里
 * 是移光标,那是文本编辑的基本盘,不能为了「网格是二维的」抢走。
 */
describe('总览的键盘交接', () => {
  const search = () => screen.getByLabelText('搜索会话') as HTMLInputElement

  it('摆出来的那一刻焦点落进搜索条(不再留在 Dock 那块瓦上)', () => {
    placeSessions()
    render(<ExposeView />)
    expect(document.activeElement).toBe(search())
  })

  it('没摆出来就不抢焦点 —— Dock 悬停预览泡里也渲染一份,不该夺走光标', () => {
    render(<ExposeView />)
    expect(document.activeElement).not.toBe(search())
  })

  it('搜索条里按 ↓:焦点交给网格,搜索词原样留着', () => {
    placeSessions()
    render(<ExposeView />)
    fireEvent.change(search(), { target: { value: 'Exposé' } })
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    expect(useExposeStore.getState().query).toBe('Exposé')
    expect(useExposeStore.getState().focusVisible).toBe(true)
    expect(useExposeStore.getState().focusId).toBe('os-expose')
    /*
     * 交接之后焦点落在**这块面的根**上,不是掉到 body 上 —— 后者正是 R1 之前
     * 那一手 `blur()` 的结果,而孤儿焦点会被收回落点、于是弹回搜索条,接着按 ↓
     * 又被「输入面里的无修饰单键」让给输入框,网格纹丝不动。
     * 反证:把 `activate('programmatic')` 换回 `inputRef.current?.blur()` → 这一条红。
     */
    const view = document.querySelector('[data-focus-scope="expose"]')
    expect(document.activeElement).toBe(view)
  })

  it('↑ 同理:交接那一下只点亮锚点,不顺手再走一步', () => {
    placeSessions()
    render(<ExposeView />)
    /*
     * 开场归位(`open()`)会把锚点放在当前会话上,而这一条要验的是「交接那一下
     * 不动锚点」—— 所以摆锚点要在**归位之后**。R2 之前这一组渲染的是光秃秃的
     * `<Overview>`(没有 `ExposeBindings`,归位根本不跑),所以摆在前面也没事;
     * 现在渲染的是整块面(落点声明在它身上),归位真的会跑。
     */
    act(() => useExposeStore.setState({ focusId: 'os-toolkit', focusVisible: false }))
    fireEvent.keyDown(search(), { key: 'ArrowUp' })
    expect(useExposeStore.getState().focusVisible).toBe(true)
    expect(useExposeStore.getState().focusId).toBe('os-toolkit')
  })

  /*
   * hover ≠ active(09-01 用户裁定,批 4 补的守卫)。
   * 这块面的「键盘位」是 store 里的 `focusId`,改它的只该有键盘与显式点击;
   * 鼠标扫过一张卡一个字都不许写 —— 二次污染那条链(↑↓ → scrollIntoView →
   * 指针没动却换了脚下的卡 → 浏览器补一发 mouseenter)在网格上一样成立,
   * 而网格的行距更小,拽走一次更难被看成是自己按错了。
   */
  it('mouseenter 不改锚点:鼠标扫过别的卡,键盘位一格不动', () => {
    placeSessions()
    render(<ExposeView />)
    // 同上:摆锚点在归位之后(理由见上一条)。
    act(() => useExposeStore.setState({ focusId: 'os-toolkit', focusVisible: true }))
    const cards = screen.getAllByTestId(/^card-[\w-]+$/)
    // 防空转:一张卡都没扫到的话下面那句断言是白给的。
    expect(cards.length).toBeGreaterThan(1)
    for (const card of cards) {
      fireEvent.mouseEnter(card)
      fireEvent.mouseOver(card)
    }
    expect(useExposeStore.getState().focusId).toBe('os-toolkit')
  })

  it('←→ 不接:焦点留在输入框里给光标用,状态机一格不动', () => {
    placeSessions()
    render(<ExposeView />)
    const before = useExposeStore.getState()
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      const e = fireEvent.keyDown(search(), { key })
      // fireEvent 返回 false 表示被 preventDefault 了 —— 这两个键必须没有。
      expect(e).toBe(true)
    }
    expect(document.activeElement).toBe(search())
    expect(useExposeStore.getState().focusVisible).toBe(before.focusVisible)
    expect(useExposeStore.getState().focusId).toBe(before.focusId)
  })
})

/**
 * ── 08-30 窄形 N2 + 抗挤压纪律批(用户实机视频报障)────────────────────────
 * 三件事在这一组里钉住:计数徽真的没了、入口还在、组名只截断不换行。
 *
 * 「组名只截断不换行」在 jsdom 里量不出几何(它不排版),所以这里钉的是
 * **规则本身**(读源码,与下面那一组「卡网格的两条几何规则」同一个办法);
 * 真的有没有压住东西,由 `npm run gate:squeeze` 在真机五档上判。
 */
describe('组头:计数禁令 + 幽灵入口 + 只截断不换行', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/expose/components/Overview.module.css'),
    'utf8',
  )
  const block = (selector: string) => {
    const at = css.indexOf(selector + ' {')
    expect(at).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }

  it('组头上不出现个数 —— 「N 会话」那颗按钮整个没了', () => {
    render(<ExposeView />)
    // 文案层:fixtures 里每组的条数都 ≥ 1,任何一句「N 会话」都不该在 DOM 里。
    expect(screen.queryByText(/\d+\s*会话/)).toBeNull()
    expect(screen.queryByText(/\d+\s*sessions?/)).toBeNull()
  })

  it('进组入口还在:点组头右端的「›」= 原来点计数徽,进的是同一组', () => {
    render(<ExposeView />)
    fireEvent.click(screen.getByTestId(`group-enter-${FIRST_GROUP}`))
    expect(useExposeStore.getState().view).toEqual({ mode: 'list', groupId: FIRST_GROUP })
  })

  it('入口是幽灵的:常驻在 DOM 里(不是 hover 才插进来 —— 那会挤动整行)', () => {
    render(<ExposeView />)
    for (const group of GROUPS) {
      expect(screen.getByTestId(`group-enter-${group.id}`)).toBeTruthy()
    }
    expect(block('.enter')).toContain('opacity: 0')
  })

  it('入口的 aria-label 是组名(本批禁改 i18n,字典里没有「进入某组」这句话)', () => {
    render(<ExposeView />)
    const first = GROUPS[0]
    const label = first.nameKey ? undefined : first.name
    expect(screen.getByTestId(`group-enter-${first.id}`).getAttribute('aria-label')).toBe(
      label ?? first.id,
    )
  })

  it('律一 / 律二:组名可缩 + 单行截断,右端入口一律 flex: none', () => {
    const name = block('.groupName')
    // 少任何一句,长组名就会折行(有连字符)或整条溢出(没连字符)去压别人。
    expect(name).toContain('min-width: 0')
    expect(name).toContain('white-space: nowrap')
    expect(name).toContain('text-overflow: ellipsis')
    expect(name).toContain('overflow: hidden')
    // 主名不抢剩余空间,副名抢 —— 于是挤起来副名先让。
    expect(name).toContain('flex: 0 1 auto')
    expect(block('.groupPath')).toContain('flex: 1 1 auto')
    expect(block('.enter')).toContain('flex: none')
    expect(block('.plus')).toContain('flex: none')
  })

  it('组头是粘性的,并且滚动容器给它留了 scroll-padding(否则键盘会把卡停在它底下)', () => {
    const head = block('.groupHead')
    expect(head).toContain('position: sticky')
    expect(head).toContain('top: 0')
    expect(block('.scroll')).toContain('scroll-padding-top: var(--list-row-h)')
  })
})

/**
 * ── 08-30 方向 A「隐形组头」(用户比稿选定的样例)──────────────────────────
 * 两个病一处治:
 *  ① 组头写死 `background: var(--surface-1)`,连上 core 主题桥之后与容器实际底
 *     不配 —— 平时就是屏幕上一条色带。治法:**默认全透明,粘住了才显影**。
 *  ② `.groupToggle` 拉满整行,hover 铺一块拉满整行的大 pill,与右端 ›/+ 两颗小方
 *     hover 并列出现像三块补丁。治法:hover **降为文字语言**,一块底都不画。
 *
 * 底色 / 悬停这一族在 jsdom 里量不出来(它不排版、也不做层叠),所以与上面那两组
 * 同一个办法:钉**规则本身**。真机三截图(未粘 / 粘附 / 悬停)写在本批汇报里。
 */
describe('隐形组头:默认无底,粘附才显影,hover 只动文字', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/expose/components/Overview.module.css'),
    'utf8',
  )
  const block = (selector: string) => {
    const at = css.indexOf(selector + ' {')
    expect(at).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }

  it('组头默认没有底 —— 写死的 --surface-1 色带没了', () => {
    const head = block('.groupHead')
    expect(head).toContain('background: transparent')
    expect(head).not.toContain('var(--surface-1)')
  })

  it('粘附态也不画底(08-30 当晚二裁):全文件没有任何 data-stuck 视觉规则', () => {
    // 用户真机复核把玻璃底也否了:组头任何状态都不是一条带。
    // data-stuck 属性本身保留(JS 侧机制未拆),但样式层没有人消费它。
    expect(css).not.toContain('[data-stuck]')
    expect(css).not.toContain('var(--glass)')
    expect(css).not.toContain('backdrop-filter')
  })

  it('组头没有下缘线也没有补间残留:box-shadow/transition 随底一起退役', () => {
    const head = block('.groupHead')
    expect(head).not.toContain('box-shadow')
    expect(head).not.toContain('transition')
    expect(head).not.toContain('border')
  })

  it('hover 不再画底:--st-hover 与它的圆角一起没了', () => {
    expect(css).not.toContain('var(--st-hover)')
    const toggle = block('.groupToggle')
    expect(toggle).not.toContain('background')
    expect(toggle).not.toContain('border-radius')
  })

  it('hover 是文字语言:组名常态 --text-2,hover 与 caret 一起升到 --text-1', () => {
    // 静态观感变化:组名常态从 text-1 降到 text-2(用户选定样例里的样子)。
    expect(block('.groupName')).toContain('color: var(--text-2)')
    expect(block('.groupToggle:hover .groupName')).toContain('color: var(--text-1)')
    expect(block('.caret')).toContain('color: var(--text-3)')
    expect(block('.groupToggle:hover .caret')).toContain('color: var(--text-1)')
  })

  it('哨兵一格布局都不占 —— 绝对定位,不进 .group 那道 gap', () => {
    const rule = block('.sentinel')
    expect(rule).toContain('position: absolute')
    expect(rule).toContain('height: 1px')
    expect(block('.group')).toContain('position: relative')
  })
})

/**
 * 哨兵 × IntersectionObserver 的接线。jsdom 没有 IO,所以这里自己摆一份假的:
 * 记下 root / options,并把回调交出来手动触发 —— 验的是**接线**(观察了谁、
 * 判出来落在哪),不是浏览器的相交算法。
 */
describe('粘附侦测:哨兵 + IntersectionObserver 的接线', () => {
  type Cb = (entries: { target: Element; isIntersecting: boolean }[]) => void
  let calls: { cb: Cb; root: Element | null; threshold: unknown; targets: Element[] }[] = []

  const installIO = () => {
    calls = []
    class FakeIO {
      private rec: (typeof calls)[number]
      constructor(cb: Cb, options?: { root?: Element | null; threshold?: unknown }) {
        this.rec = { cb, root: options?.root ?? null, threshold: options?.threshold, targets: [] }
        calls.push(this.rec)
      }
      observe(el: Element) {
        this.rec.targets.push(el)
      }
      unobserve() {}
      disconnect() {
        this.rec.targets = []
      }
    }
    ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO
    return () => {
      delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver
    }
  }

  let restore: () => void
  beforeEach(() => {
    restore = installIO()
  })
  afterEach(() => restore())

  /** 最后一台被造出来的 observer —— effect 重跑会 disconnect 旧的、造一台新的。 */
  const latest = () => calls[calls.length - 1]

  it('每组一枚哨兵,且每一枚都是它那组的第一个孩子(组头是它的下一个兄弟)', () => {
    render(<ExposeView />)
    const sentinels = [...document.querySelectorAll('[data-sentinel]')]
    expect(sentinels.length).toBe(GROUPS.length)
    for (const group of GROUPS) {
      const sentinel = document.querySelector(`[data-sentinel="${group.id}"]`)
      expect(sentinel).toBeTruthy()
      expect(sentinel?.parentElement?.firstElementChild).toBe(sentinel)
      expect(sentinel?.nextElementSibling).toBe(screen.getByTestId(`group-head-${group.id}`))
    }
    // 读屏读不到它。
    for (const s of sentinels) expect(s.getAttribute('aria-hidden')).toBe('true')
  })

  it('root 是滚动容器、threshold 是 1,并且每一枚哨兵都被观察上了', () => {
    render(<ExposeView />)
    const io = latest()
    expect(io.threshold).toBe(1)
    // root 必须是**滚动容器**(哨兵 → 组 → .inner → .scroll),不是文档视口:
    // 总览可以待在架子 / 浮窗里,那时页面根本没滚,滚的是这个盒子。
    const scroll = document.querySelector('[data-sentinel]')?.parentElement?.parentElement
      ?.parentElement
    expect(io.root).toBe(scroll)
    expect(scroll?.nextElementSibling).toBe(null)
    expect(io.targets.length).toBe(GROUPS.length)
  })

  it('哨兵滚出去 → 组头挂上 data-stuck;滚回来 → 摘掉', () => {
    render(<ExposeView />)
    const io = latest()
    const head = screen.getByTestId(`group-head-${FIRST_GROUP}`)
    const sentinel = document.querySelector(`[data-sentinel="${FIRST_GROUP}"]`)!
    expect(head.hasAttribute('data-stuck')).toBe(false)

    io.cb([{ target: sentinel, isIntersecting: false }])
    expect(head.hasAttribute('data-stuck')).toBe(true)

    io.cb([{ target: sentinel, isIntersecting: true }])
    expect(head.hasAttribute('data-stuck')).toBe(false)
  })

  it('只影响自己那一组的头 —— 一枚哨兵翻,别的组头不动', () => {
    render(<ExposeView />)
    const io = latest()
    io.cb([{ target: document.querySelector(`[data-sentinel="${FIRST_GROUP}"]`)!, isIntersecting: false }])
    expect(screen.getByTestId(`group-head-${FIRST_GROUP}`).hasAttribute('data-stuck')).toBe(true)
    expect(screen.getByTestId('group-head-collab').hasAttribute('data-stuck')).toBe(false)
  })

  it('组列表变了(搜索过滤)就重观察:新的哨兵一一对应,没有谁被落下', () => {
    render(<ExposeView />)
    const before = calls.length
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'Exposé' } })
    // 组少了 → effect 重跑 → 造了新的一台
    expect(calls.length).toBeGreaterThan(before)
    const io = latest()
    const sentinels = [...document.querySelectorAll('[data-sentinel]')]
    expect(io.targets).toEqual(sentinels)
    // 新一批里每一枚仍然紧挨着自己的组头。
    for (const s of sentinels) {
      expect(s.nextElementSibling?.getAttribute('data-testid')).toBe(
        `group-head-${s.getAttribute('data-sentinel')}`,
      )
    }
  })

  it('卸载时断开观察,不留悬着的 observer', () => {
    const view = render(<ExposeView />)
    const io = latest()
    expect(io.targets.length).toBeGreaterThan(0)
    view.unmount()
    expect(io.targets.length).toBe(0)
  })
})

/**
 * ── 08-30 靠边卡焦点环被截 + 三列硬挤(用户实机截图)────────────────────────
 * 两件事同一处收口:卡网格那个盒子。几何断言在 jsdom 里做不了(不排版),
 * 所以这里钉的是**规则本身**——真机量法与读数写在本批汇报里。
 *
 *  ① `.bodyInner` 的 overflow 只为纵向收合而存在,横向必须留出一个焦点环的余量;
 *     没有这一条,最左 / 最右列的 outline 会被这条边削成一条竖线(真机量到
 *     首列 gapLeft=0、末列 gapRight=0,修后两侧各 3px = --focus-ring-w)。
 *  ② 列数由容器宽度算,不是写死的 3;窄到钉边架子(240px)时得退成一列,
 *     而不是把卡挤成 42px 的竖条。
 */
describe('卡网格的两条几何规则(源码级钉死)', () => {
  // 读源码而不是读 import.meta.url:vite 把测试文件的 URL 换成了 http 形式。
  const css = readFileSync(resolve(process.cwd(), 'src/expose/components/Overview.module.css'), 'utf8')
  const block = (selector: string) => {
    const at = css.indexOf(selector + ' {')
    expect(at).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }

  it('.bodyInner 的裁剪框横向留出一个焦点环的余量(纵向一格都不许加)', () => {
    const rule = block('.bodyInner')
    expect(rule).toContain('overflow: hidden')
    expect(rule).toContain('padding-inline: var(--focus-ring-w)')
    expect(rule).toContain('margin-inline: calc(-1 * var(--focus-ring-w))')
    // 纵向加了 padding 会在 0fr 收合时留残高,折叠动画当场破。
    expect(rule).not.toContain('padding-block')
    expect(rule).not.toMatch(/padding:\s/)
  })

  it('.grid 的列数按容器宽度算,且窄到极限时退化成一列而不是溢出', () => {
    const rule = block('.grid')
    expect(rule).toContain('repeat(auto-fill, minmax(min(var(--card-min-w), 100%), 1fr))')
    expect(rule).not.toContain('repeat(3')
    // auto-fit 会把最后一行的单张卡拉成整行宽 —— 同一批数据在不同组里长得不一样。
    expect(rule).not.toContain('auto-fit')
  })
})

/**
 * 组头右端那颗 +(D1 开工批之前它是个只有 aria-label 的空壳)。
 *
 * 这里只钉**接线**:点它 = 调唯一那条建会话入口,并把「这一组是哪个项目」
 * 递对。建会话本身发几发请求、失败怎么说,在 data/session-create.test.ts。
 */
describe('组头的 +:在这一组下新建会话', () => {
  /** 换掉 store 上那条 action,断言收到的 projectId —— 不发一次真请求。 */
  function spyNewSession(): { calls: (string | null)[]; restore: () => void } {
    const calls: (string | null)[] = []
    const before = useExposeStore.getState().newSession
    useExposeStore.setState({ newSession: async (projectId) => void calls.push(projectId) })
    return { calls, restore: () => useExposeStore.setState({ newSession: before }) }
  }

  it('项目组:把那个组的工作目录递过去', () => {
    render(<ExposeView />)
    const spy = spyNewSession()
    try {
      fireEvent.click(screen.getByTestId(`group-plus-${FIRST_GROUP}`))
      expect(spy.calls).toEqual([GROUPS[0].projectId])
      expect(GROUPS[0].projectId).toBeTruthy()
    } finally {
      spy.restore()
    }
  })

  it('合成组(协作 / 独立会话)没有项目,递 null —— 不替它编一个目录', () => {
    render(<ExposeView />)
    const synthetic = GROUPS.find((g) => g.projectId === null)
    expect(synthetic).toBeTruthy()
    const spy = spyNewSession()
    try {
      fireEvent.click(screen.getByTestId(`group-plus-${synthetic!.id}`))
      expect(spy.calls).toEqual([null])
    } finally {
      spy.restore()
    }
  })
})
