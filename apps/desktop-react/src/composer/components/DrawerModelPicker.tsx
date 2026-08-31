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

  const pick = (providerId: string, model: string) => (e: MouseEvent) => {
    e.preventDefault()
    choose(sessionId || null, providerId, model)
  }

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
        />
      </div>
      {groups.length === 0 && <div className={s.pickEmpty}>{t('composer.noMatch')}</div>}
      {groups.map((g) => (
        <div key={g.id}>
          <div className={s.provHead}>{g.provider}</div>
          {g.models.map((m) => (
            <button
              key={m.model}
              type="button"
              className={s.pickRow}
              onMouseDown={pick(g.id, m.model)}
            >
              <span className={s.pickMono}>{m.model}</span>
              {/* 窗口大小是**数据**不是文案(与 files-source.formatBytes 同判据):
                  换一门语言 '200k' 不该变。不知道就不画那一格,不写「未知」。 */}
              <span>{m.contextLength === null ? '' : formatCount(m.contextLength)}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  )
}
