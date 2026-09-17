import { memo, useEffect, useMemo, useRef } from 'react'
import type { MouseEvent } from 'react'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { Search } from '../../components/icons'
import {
  buildProviderGroups,
  ensureVisibleCatalogs,
  modelMutation,
  selectKey,
  useCatalogRecord,
  useCurrentModelSelection,
  useModelReadings,
  useProviderOptions,
  useProviderPrefs,
  useThinkingState,
} from '../../data/models-source'
import type { ModelSelection, ThinkingState } from '../../data/models-source'
import { useAsyncPending } from '../../data/kernel'
import { formatQuantity } from '../../format/quantity'
import { formatPrice } from '../../providers/projection'
import { settingsKey, settingsMutation, useProviderSettings } from '../../providers/store'
import type { ThinkingRung } from '../../providers/store'
import { filterProviders, thinkingLabel, THINKING_NOTE_KEY } from '../transitions'
import { useComposerStoreOf } from '../store'
import { useComposerSessionId } from '../session-context'
import { useListSelection } from '../../ui/a11y/list-selection'
import { FocusScope } from '../../focus/FocusScope'
import { ButtonBase } from '../../ui/ButtonBase'
import { Card } from '../../ui/Card'
import { Radio, RadioGroup } from '../../ui/Radio'
import s from './Composer.module.css'

/**
 * 模型抽屉:**两栏**(09-05 设计 §5.8「庚 = 甲的药丸 + 乙的面板」)。
 * 左栏是一行搜索 + 按 Provider 分组的表,右栏是**选中那一型的卡**:名、窗口、
 * 价格,和一条竖排的思考阶梯。
 *
 * 三条判据钉在这个形上,每一条都对着一次真机报障:
 *
 *  ① **点一行 = 换成它并收起**(09-17 用户报「选中后不会自己收起来」,推翻 09-05
 *     庚的「选中不关」;收起那句在 `composer/store.chooseModel`)。右栏讲的是**当前**
 *     那一型:要调档,开抽屉先调再选,或选完再开一次。
 *  ② **只有列表滚,卡不滚** —— 滚动区仍然只有 `.pickScroll` 一个,右栏那张卡是它
 *     的**兄弟**(不是它的内容)。**面板是定高的**(09-17 用户报「选模型时高度会变」):
 *     从前高由卡定,换一型、目录晚到,卡的行数一变整块面板就跳。今天两栏格子吃
 *     `--composer-model-drawer-h`,卡与列表各在自己那一格里。
 *  ③ **改档只打补丁** —— 右栏是按 selection 重渲的兄弟组件,列表这棵 DOM 一个节点
 *     都不重建、滚动位一格不动(用例 `选另一行:.pickScroll 是同一个节点且
 *     scrollTop 不变` 守着它)。
 *
 * ── 承下来一条没变的判例 ────────────────────────────────────────────────
 * D2 波一起数是真的:名册与设置来自 `data/models-source`(启动时各拉一次),
 * 每一家的**模型目录是抽屉打开时才拉的**(下面那个 effect)—— 十几家 × 上百条
 * 的东西不该为了一个也许永远不会被点开的抽屉在启动期全拉一遍。
 *
 * 目录还没到时这张表**照样是全的**:模型 id 来自设置里勾过的那些(已经在手上),
 * 少的只有行尾那一格窗口大小与右栏那张卡上的读数。所以左栏没有转圈的加载态 ——
 * 也没有骨架:骨架是给「整块内容还不存在」用的,而这里只有几格会晚到。
 *
 * ── 09-01 补:这张表从前**只能用鼠标点** ─────────────────────────────────
 * 一行搜索 + 一列候选,却没有 ↑↓ 也没有 ↵ —— 打完字必须把手挪回触控板。
 * 同批把它迁到 `ui/a11y/list-selection`,与 @ / 两个抽屉、工作区快切同一份
 * 状态机:↑↓ 走键盘位、↵ 落在键盘位上、当前行滚进视野。
 * 分组只是**画法**:键盘位走的是拍平之后的那条序(`rows`),
 * 「哪一家的」这件事一格没少 —— 组头照旧在,行照旧按家分段。
 * hover 仍然只是 hover(`.pickRow:hover`),鼠标经过一个字都不改键盘位。
 * ──────────────────────────────────────────────────────────────────────
 */
export function DrawerModelPicker() {
  const t = useT()
  /*
   * **这块抽屉挂在哪块面板上**(W5-c-2)。从前这里读的是 `expose.currentSessionId`
   * ——一句投影;路线 A 之后屏幕上可能有两块面板,投影答的是「焦点在哪」而不是
   * 「我是谁的」,分屏时选的模型会挂到另一条会话上去。
   */
  const sessionId = useComposerSessionId()
  const query = useComposerStoreOf(sessionId, (st) => st.modelQuery)
  const setQuery = useComposerStoreOf(sessionId, (st) => st.setModelQuery)
  const choose = useComposerStoreOf(sessionId, (st) => st.chooseModel)
  const ref = useRef<HTMLInputElement>(null)

  const providers = useProviderOptions()
  const prefs = useProviderPrefs()
  /*
   * 订阅面按**名册全集**,不按可见集:没拉过的格是空的,拼进去连一个键都不占
   * (见 useCatalogRecord),而按可见集订就得先白建一次组表。拉哪几家仍然只按
   * 可见集(`ensureVisibleCatalogs`)—— 订与拉是两件事。
   */
  const catalogIds = useMemo(() => providers.map((p) => p.id), [providers])
  const catalog = useCatalogRecord(catalogIds)
  const current = useCurrentModelSelection(sessionId)
  /*
   * 律③:同一条会话上已经有一发切模型在飞时,这张表不再发第二发。
   * 读的是与药丸上那个 aria-busy 完全同一格(`selectKey(sessionId)`)——
   * 反馈画在药丸上,闸落在这里,两处读同一个数才不会说两句话。
   */
  const switching = useAsyncPending(modelMutation, selectKey(sessionId))

  // 懒加载:这块组件挂上 = 抽屉开了。每家目录拉一次就缓存(kernel 那一族自带
  // 并发折叠与缓存),所以反复开合不会反复往返。
  useEffect(() => {
    void ensureVisibleCatalogs(current)
  }, [current])

  const groups = useMemo(
    () => filterProviders(buildProviderGroups(providers, prefs, catalog, current), query),
    [providers, prefs, catalog, current, query],
  )

  /**
   * 拍平之后的那条序 = 键盘位走的序。它与屏幕上从上往下读到的次序逐字相同
   * (组按 groups 的次序、组内按 models 的次序),所以「第 n 位」在两边说的是同一行。
   */
  const rows = useMemo(
    () => groups.flatMap((g) => g.models.map((m) => ({ providerId: g.id, model: m.model }))),
    [groups],
  )

  const currentIndex = rows.findIndex((row) =>
    row.providerId === current?.provider && row.model === current?.model,
  )
  const { active, move, select, rowRef } = useListSelection({
    count: rows.length, loop: false, initialActive: Math.max(0, currentIndex),
  })
  const previousQuery = useRef(query)

  // 打开和清空搜索时对准当前模型，也涵盖设置/名册稍后到达的情况。
  // 输入搜索词才回到首个结果；目录读数更新不重置用户已经移动的键盘位。
  useEffect(() => {
    const queryChanged = previousQuery.current !== query
    previousQuery.current = query
    if (!query.trim()) select(Math.max(0, currentIndex))
    else if (queryChanged) select(0)
  }, [query, currentIndex, select])

  const commit = (index: number) => {
    // 在飞就不接第二下(律③的另一半:反馈是「不可再点」)。草稿态永远不在飞。
    if (switching) return
    const row = rows[index]
    if (!row) return
    choose(sessionId || null, row.providerId, row.model)
  }

  /* 行上用 mousedown + preventDefault:与 @ / 抽屉同一条判例(点下去那一瞬间
   * 输入框会失焦)。点击 = 显式意图,可以改键盘位;鼠标**经过**不行。 */
  const pick = (index: number) => (e: MouseEvent) => {
    e.preventDefault()
    select(index)
    commit(index)
  }

  /**
   * 每一组在拍平序里的**起点**。
   *
   * 从前这里是一个「边画边走」的可变游标(`let flat = -1`,在 JSX 里 `flat += 1`)。
   * R2 把这块面包进 `<FocusScope>` 的 render-prop 之后那一手当场坏掉,而且坏得
   * 很安静:**render-prop 的那段 JSX 由子组件产生**,子组件自己重渲一次
   * (`FocusScope` 订着树,焦点一动就重渲)就会把外层那个游标接着往上加 ——
   * 于是第二次渲染出来的行下标全体 +1,点第一行选到的是第二个模型,
   * 点最后一行什么都不发生(`rows[i]` 越界)。真机上表现为「点了没反应」。
   *
   * 判例记这里:**render-prop 里不许读写外层的可变游标**。下标改成一次算好的
   * 纯派生量,画多少遍都是同一个数。
   */
  const offsets = useMemo(() => {
    const out = new Map<string, number>()
    let at = 0
    for (const g of groups) {
      out.set(g.id, at)
      at += g.models.length
    }
    return out
  }, [groups])

  /*
   * ── 抽屉一开焦点就在搜索行 —— 一句**声明**(09-03 R2)────────────────────
   * 从前是一条 `useEffect(() => ref.current?.focus(), [])`。R2 把它换成响应链上
   * 的一格 `float`:`activateOnMount` 说「刚开出来就把焦点送进去」、`restingTarget`
   * 说「送到搜索行」,落焦由 `activate('open')` 干。开它的那一下手已经离开键盘了,
   * 别再让人多点一次 —— 这句判据一个字没变,变的是谁去执行它。
   *
   * **Esc 不在这一层认领**:抽屉的收起归输入面板那三层次序里的第②层
   * (`Composer.onEscape`),这一格若自己也答 true,同一下 Esc 就有两个主人。
   * `float` 的「Esc 缺省关自己」是**缺省**,不是必须 —— 不声明 `onEscape` 就
   * 根本不进 Esc 候选表(`FocusScope` 那格 prop 的原话)。
   *
   * 外面那层 `div` 是这一格的根:这只组件从前交出的是一个 Fragment,而作用域
   * 要一个真的根元素(树认的是元素,不是组件)。它是块级、无样式,套在
   * `.drawerBody`(有 padding,所以外边距不会穿过它塌到父身上)里 —— 几何零变化。
   */
  return (
    <FocusScope scope="drawer" activateOnMount restingTarget={() => ref.current}>
      {({ scopeProps }) => (
        <div {...scopeProps}>
          <div className={s.pickCols}>
            <div className={s.pickListCol}>
              {/* 不自称文本载体(09-16):抽屉是面板自己的第一格,搜索框落焦时亮的是
                  **整块面板**那一格 text 载体,环围住抽屉与输入区。这里再挂一格
                  `text` 就按「里层赢」把环抢回这一行,整块反而不亮 —— 那正是用户报的
                  「焦点只在一小块上」(正本 docs/composer-unified-drawer-2026-09-16.md §3.4)。 */}
              <div className={s.modelSearch}>
                <Search className={s.searchIcon} strokeWidth={2} aria-hidden="true" />
                <input
                  ref={ref}
                  className={s.modelSearchInput}
                  value={query}
                  placeholder={t('composer.modelSearch')}
                  aria-label={t('composer.modelSearch')}
                  onChange={(e) => setQuery(e.target.value)}
                  /* ↑↓ 与 ↵ 是**这个输入框里的语法**(焦点恒在它身上,列表从不落焦),
                   * 与 composer 的 @ / 抽屉、工作区快切同一手。Home/End 不接:
                   * 它们在一个还在编辑的输入框里是到行首行尾(判据见 list-selection)。 */
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault()
                      move(e.key === 'ArrowDown' ? 1 : -1)
                      return
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commit(active)
                    }
                  }}
                />
              </div>
              {/* 列表格:**它**是相对定位的那一格,列表在里面 absolute 铺满 ——
                  于是行高只由右栏那张卡定,而列表自己该滚就滚(判据 ②)。 */}
              <div className={s.pickListCell}>
                {/* 限高与滚入视野是同一件事的两半(抽屉判例):十几家 × 上百条不封顶会把
                    聊天顶出屏外,封了顶就必须把键盘位滚回视野 —— 后者在 rowRef 里。 */}
                <div className={s.pickScroll}>
                  {groups.length === 0 && (
                    <div className={s.pickEmpty}>{t('composer.noMatch')}</div>
                  )}
                  {groups.map((g) => (
                    <div key={g.id}>
                      <div className={s.provHead}>{g.provider}</div>
                      {g.models.map((m, index) => {
                        const i = (offsets.get(g.id) ?? 0) + index
                        return (
                          <ButtonBase
                            key={m.model}
                            ref={rowRef(i)}
                            className={i === active ? `${s.pickRow} ${s.pickSel}` : s.pickRow}
                            onMouseDown={pick(i)}
                          >
                            <span className={s.pickMono}>{m.model}</span>
                            {/* 窗口大小是**数据**不是文案(与 files-source.formatBytes 同判据):
                                换一门语言 '200k' 不该变。不知道就不画那一格,不写「未知」。 */}
                            <span>
                              {m.contextLength === null ? '' : formatQuantity(m.contextLength)}
                            </span>
                          </ButtonBase>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <ModelDetailCard selection={current} />
          </div>
        </div>
      )}
    </FocusScope>
  )
}

/**
 * 右栏那张卡 —— **列表的兄弟**,不是它的内容(判据 ② / ③)。
 *
 * 它自己订两格事实(目录里这一型的读数、这一型此刻的思考态),所以选中换人时
 * 重渲的只有它;左栏那棵 DOM 一个节点都不动。`memo` 不是优化,是**这条判据的
 * 执法**:唯一那个 prop 是选中那一对,换人才重渲(换会话也走它 ——
 * `useCurrentModelSelection` 那时交出的是另一个对象)。
 */
const ModelDetailCard = memo(function ModelDetailCard({
  selection,
}: {
  selection: ModelSelection | null
}) {
  const t = useT()
  const readings = useModelReadings(selection)
  const thinking = useThinkingState(selection)
  const setThinkingEffort = useProviderSettings((st) => st.setThinkingEffort)
  /*
   * 律③逐格:这一型的档位在写盘时,阶梯不可再点。格子与设置面勾选那一行是
   * **同一格**(`settingsKey.model`)—— 同一份设置的同一行,忙态不该有两本账。
   */
  const saving = useAsyncPending(
    settingsMutation,
    selection ? settingsKey.model(selection.provider, selection.model) : '',
  )

  // 三层事实都答不上来:右栏没有「这一型」可讲,整块不画(不画一张空卡)。
  if (!selection?.model) return null

  const unknown =
    readings.contextLength === null && readings.pricing === null && !thinking.supported

  return (
    <Card className={s.modelCard} pad="md" bordered={false} data-testid="model-detail-card">
      {/*
        * 模型名**不走 Card 的 `title` 槽**:那一槽会渲染一个真的 `<h2|h3|h4>`,
        * 而这块面浮在输入框上、上文没有任何标题层级 —— 凭空长一个标题就是在
        * 无障碍树里跳级(axe 的 heading-order)。卡的檐是给「面里的区块」用的,
        * 这里要的只是一行字,所以它是卡身的第一行。
        */}
      <div className={s.modelCardName}>{selection.model}</div>
      {readings.contextLength !== null && (
        <div className={s.modelCardRow}>
          <span>{t('composer.modelWindow')}</span>
          <b>{formatQuantity(readings.contextLength)}</b>
        </div>
      )}
      {readings.pricing !== null && (
        <div className={s.modelCardRow}>
          <span>{t('composer.modelPrice')}</span>
          <b>
            {t('composer.modelPriceValue', {
              input: formatPrice(readings.pricing.input),
              output: formatPrice(readings.pricing.output),
            })}
          </b>
        </div>
      )}
      {/* 目录一条都还没到:说实话,不画骨架也不画零 —— 这里只有几格晚到,
          而卡本身(名字)已经是真的了。 */}
      {unknown && <div className={s.modelCardNote}>{t('composer.modelCardUnknown')}</div>}
      <ThinkingLadder
        t={t}
        thinking={thinking}
        saving={saving}
        onPick={(rung) => {
          void setThinkingEffort(selection.provider, selection.model, rung)
        }}
      />
    </Card>
  )
})

/**
 * 竖排的思考阶梯。**只画这一型支持的档**:
 *  · 不思考的型 → 一句实话,不画一个禁用的控件冒充;
 *  · `toggleable` 才有「关」(o 系 / gpt-5 系 / grok 永远思考,画出一个点不动的
 *    「关」是骗人);
 *  · 一档都没有的型(qwen3.5 / 智谱)→ 只有「开 / 关」。
 *
 * 键盘一行不写:同名 `name` 的一组原生 radio,↑↓←→ 与 Space 全是浏览器白送的
 * (`ui/Radio` 文件头那段)。
 */
function ThinkingLadder({
  t,
  thinking,
  saving,
  onPick,
}: {
  t: TFn
  thinking: ThinkingState
  saving: boolean
  onPick: (rung: ThinkingRung) => void
}) {
  if (!thinking.supported) {
    return (
      <div className={s.thinkBlock}>
        <div className={s.thinkHead}>{t('composer.thinkLabel')}</div>
        <div className={s.modelCardNote}>{t('composer.thinkNone')}</div>
      </div>
    )
  }

  /*
   * 屏幕上的那几根档。`'on'` 只在「能开关但一档都没有」那一形出现 ——
   * 它不是一个档,它是「开着」这件事本身(见 transitions.ThinkingRung)。
   */
  const rungs: ThinkingRung[] = [
    ...(thinking.toggleable ? (['off'] as ThinkingRung[]) : []),
    ...(thinking.levels.length === 0 ? (['on'] as ThinkingRung[]) : thinking.levels),
  ]
  const value: ThinkingRung = thinking.on ? (thinking.level ?? 'on') : 'off'

  return (
    <div className={s.thinkBlock}>
      <div className={s.thinkHead}>{t('composer.thinkLabel')}</div>
      <RadioGroup
        className={s.thinkLadder}
        label={t('composer.thinkLabel')}
        value={value}
        onChange={(next) => onPick(next as ThinkingRung)}
        disabled={saving}
        aria-busy={saving}
      >
        {rungs.map((rung) => (
          <Radio key={rung} value={rung} className={s.thinkRung}>
            <span className={s.thinkRungName}>{thinkingLabel(t, rung, thinking.levelLabels)}</span>
            <span className={s.thinkRungNote}>{t(THINKING_NOTE_KEY[rung])}</span>
          </Radio>
        ))}
      </RadioGroup>
      {!thinking.toggleable && <div className={s.modelCardNote}>{t('composer.thinkAlwaysOn')}</div>}
    </div>
  )
}
