import { useEffect, useMemo, useRef } from 'react'
import type { MouseEvent } from 'react'
import { useT } from '../../i18n'
import { Search } from '../../components/icons'
import {
  buildProviderGroups,
  useCurrentModelSelection,
  useModelsSource,
} from '../../data/models-source'
import { useExposeStore } from '../../expose/store'
import { filterProviders, formatCount } from '../transitions'
import { useComposerStore } from '../store'
import { useListSelection } from '../../ui/a11y/list-selection'
import { ButtonBase } from '../../ui/ButtonBase'
import s from './Composer.module.css'

/**
 * 模型抽屉:一行搜索 + 按 Provider 分组的表。**不混列** ——
 * 「哪家的」是模型最先要回答的问题,混在一张长表里等于把它藏起来。
 *
 * D2 波一起数是真的:名册与设置来自 `data/models-source`(启动时各拉一次),
 * 每一家的**模型目录是抽屉打开时才拉的**(下面那个 effect)—— 十几家 × 上百条
 * 的东西不该为了一个也许永远不会被点开的抽屉在启动期全拉一遍。
 *
 * 目录还没到时这张表**照样是全的**:模型 id 来自设置里勾过的那些(已经在手上),
 * 少的只有行尾那一格窗口大小。所以这里没有转圈的加载态 —— 也没有骨架:
 * 骨架是给「整块内容还不存在」用的,而这里只有一格会晚到。
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
  const query = useComposerStore((st) => st.modelQuery)
  const setQuery = useComposerStore((st) => st.setModelQuery)
  const choose = useComposerStore((st) => st.chooseModel)
  const ref = useRef<HTMLInputElement>(null)

  const sessionId = useExposeStore((st) => st.currentSessionId)
  const providers = useModelsSource((st) => st.providers)
  const prefs = useModelsSource((st) => st.prefs)
  const catalog = useModelsSource((st) => st.catalog)
  const ensureVisibleCatalogs = useModelsSource((st) => st.ensureVisibleCatalogs)
  const current = useCurrentModelSelection(sessionId)

  // 抽屉一开焦点就在搜索行:开它的那一下手已经离开键盘了,别再让人多点一次。
  useEffect(() => {
    ref.current?.focus()
  }, [])

  // 懒加载:这块组件挂上 = 抽屉开了。每家目录拉一次就缓存(端口那层还有一道
  // 在飞去重),所以反复开合不会反复往返。
  useEffect(() => {
    void ensureVisibleCatalogs(current)
  }, [ensureVisibleCatalogs, current])

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

  const { active, move, select, rowRef } = useListSelection({ count: rows.length, loop: false })

  // 换词就把键盘位拉回第一条:候选变了还停在第五行,↵ 会选错模型。
  useEffect(() => {
    select(0)
  }, [query, select])

  const commit = (index: number) => {
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

  /** 拍平序里的游标:边画边走,免得在 JSX 里再算一次 offset。 */
  let flat = -1

  return (
    <>
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
      {/* 限高与滚入视野是同一件事的两半(抽屉判例):十几家 × 上百条不封顶会把
          聊天顶出屏外,封了顶就必须把键盘位滚回视野 —— 后者在 rowRef 里。 */}
      <div className={s.pickScroll}>
        {groups.length === 0 && <div className={s.pickEmpty}>{t('composer.noMatch')}</div>}
        {groups.map((g) => (
          <div key={g.id}>
            <div className={s.provHead}>{g.provider}</div>
            {g.models.map((m) => {
              flat += 1
              const i = flat
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
                  <span>{m.contextLength === null ? '' : formatCount(m.contextLength)}</span>
                </ButtonBase>
              )
            })}
          </div>
        ))}
      </div>
    </>
  )
}
