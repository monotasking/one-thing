import { useEffect, useRef } from 'react'
import type { MouseEvent } from 'react'
import { useT } from '../../i18n'
import { Search } from '../../components/icons'
import { MOCK_PROVIDERS } from '../data'
import { filterProviders } from '../transitions'
import { useComposerStore } from '../store'
import s from './Composer.module.css'

/**
 * 模型抽屉:一行搜索 + 按 Provider 分组的表。**不混列** ——
 * 「哪家的」是模型最先要回答的问题,混在一张长表里等于把它藏起来。
 *
 * 数据接 model-registry 时换 data.ts 里的 MOCK_PROVIDERS,这个文件一行不动。
 */
export function DrawerModelPicker() {
  const t = useT()
  const query = useComposerStore((st) => st.modelQuery)
  const setQuery = useComposerStore((st) => st.setModelQuery)
  const choose = useComposerStore((st) => st.chooseModel)
  const ref = useRef<HTMLInputElement>(null)

  // 抽屉一开焦点就在搜索行:开它的那一下手已经离开键盘了,别再让人多点一次。
  useEffect(() => {
    ref.current?.focus()
  }, [])

  const groups = filterProviders(MOCK_PROVIDERS, query)
  const pick = (model: string) => (e: MouseEvent) => {
    e.preventDefault()
    choose(model)
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
        <div key={g.provider}>
          <div className={s.provHead}>{g.provider}</div>
          {g.models.map((m) => (
            <button
              key={m.model}
              type="button"
              className={s.pickRow}
              onMouseDown={pick(m.model)}
            >
              <span className={s.pickMono}>{m.model}</span>
              <span>{m.desc}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  )
}
