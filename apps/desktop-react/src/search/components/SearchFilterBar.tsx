import { FilterChip } from '../../ui/FilterChip'
import { IconButton } from '../../ui/IconButton'
import { ChevronLeft, ChevronRight } from '../../components/icons'
import type { TFn } from '../../i18n'
import type { FilterChipSpec, SearchFilterState } from '../filters'
import { canGoBack, canGoForward } from '../history'
import type { SearchHistory } from '../history'
import s from './SearchPanel.module.css'

/**
 * **片条**:历史的两颗方向钮 / 范围片 / 过滤片,次序固定(§9 第五条 + §4.6 结论 1)。
 *
 * 第 ⑥ 步从 `SearchPanel.tsx:700-781` 原样搬出来 —— props 原样、DOM 原样、CSS 类
 * 原样。**整条画不画的那句判据也一起搬**(一颗片都摆不出、也没有范围片、历史也是
 * 空的时候整条不画:一条恒空的横条只是在占地方),所以这只件在那种时候答 `null`,
 * 与从前「父层那个 `&&` 短路」在 DOM 上逐字相同。
 *
 * ── 它不拥有任何状态 ────────────────────────────────────────────────────
 * 片摆不摆得出由**自述**说(`available` 是 `facetKeysOf` 算的那张键集),片的取值
 * 与历史都由上面递进来;两颗方向钮走到头是**禁灰而不消失**(判例保留)。
 */
export interface SearchFilterBarProps {
  filters: SearchFilterState
  /** 这一档摆得出来的那几颗片(`filterChipsOf` 算的)。 */
  chips: readonly FilterChipSpec[]
  /** 这一档认得哪几个 facet 键 —— 范围片按不按得动读它。 */
  available: ReadonlySet<string>
  history: SearchHistory
  onFilters(next: (current: SearchFilterState) => SearchFilterState): void
  onStepHistory(direction: 'back' | 'forward'): void
  t: TFn
}

export function SearchFilterBar({
  filters,
  chips,
  available,
  history,
  onFilters,
  onStepHistory,
  t,
}: SearchFilterBarProps) {
  const back = canGoBack(history)
  const forward = canGoForward(history)
  if (chips.length === 0 && filters.scope === undefined && !back && !forward) return null

  return (
    <div className={s.filters} data-testid="search-filters">
      <IconButton
        icon={ChevronLeft}
        size="xs"
        label={t('search.historyBack')}
        disabled={!back}
        onClick={() => onStepHistory('back')}
        testId="search-history-back"
      />
      <IconButton
        icon={ChevronRight}
        size="xs"
        label={t('search.historyForward')}
        disabled={!forward}
        onClick={() => onStepHistory('forward')}
        testId="search-history-forward"
      />
      {/* 范围片(续搜)。它就是 `filters` 的可视化,× 去掉它。 */}
      {filters.scope !== undefined && (
        <FilterChip
          name="scope"
          label={filters.scope.label}
          on
          disabled={!available.has(filters.scope.key)}
          onRemove={() => onFilters(current => ({ ...current, scope: undefined }))}
          removeLabel={t('search.scopeChipRemove')}
        />
      )}
      {chips.map(chip => (
        <FilterChip
          key={chip.id}
          name={chip.id}
          label={t(chip.labelKey)}
          on={chip.on}
          value={chip.value}
          options={(chip.options ?? []).map(option => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
          /*
           * 五颗片今天都是「键 · 值」那一形(09-05 起归档 / 推理也是两格选项,
           * 不再是「按下去代表反义」的两态片)。落点逐颗按 `chip.id` 分 ——
           * 片是什么由 `filterChipsOf` 说,这里只负责把选中的那一格写回去。
           */
          onSelect={(value: string) => onFilters(current => (
            chip.id === 'space'
              ? { ...current, space: value as SearchFilterState['space'] }
              : chip.id === 'role'
                ? { ...current, role: value as SearchFilterState['role'] }
                : chip.id === 'time'
                  ? { ...current, time: value as SearchFilterState['time'] }
                  : chip.id === 'archived'
                    ? { ...current, archived: value === 'yes' }
                    : { ...current, reasoning: value === 'yes' }
          ))}
        />
      ))}
    </div>
  )
}
