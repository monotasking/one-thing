import { Input } from '../../ui/Input'
import { Segmented } from '../../ui/Segmented'
import type { SegmentedOption } from '../../ui/Segmented'
import { Search } from '../../components/icons'
import type { TFn } from '../../i18n'
import type { SearchScope } from '../types'
import s from './SearchPanel.module.css'

/**
 * **顶栏**:输入框 + 档位条(骨架五件里的两件,一个字不许改形)。
 *
 * 第 ⑥ 步从 `SearchPanel.tsx` 原样搬出来 —— props 原样、DOM 原样、CSS 类原样
 * (共用同一份 `SearchPanel.module.css`:CSS module 的类名带文件哈希,拆成第二份
 * 文件就等于换了一批类名,那与「像素零差」直接冲突)。
 *
 * ── 它不拥有任何状态 ────────────────────────────────────────────────────
 * 词与档的产地在 `search/store.ts`(第 ⑦ 步接上);今天它们仍由面板那两格
 * `useState` 递进来。点段之后焦点**留在那一段上**(`Segmented` 是 roving radio,
 * APG 既定),所以这里一句 `activate()` 都没有 —— 指针操作不搬焦点。
 *
 * 档位表(`options`)由**自述**算出(`capabilities.ts` 的 `tabsOf`),所以这只文件
 * 里一个能力 id、一句文案、一个图标名都没有。
 */
export interface SearchHeadProps {
  query: string
  onQueryChange(query: string): void
  /** 档位表:`value` 是能力 id 或 `all`,`label` 已经查过字典。 */
  options: Array<SegmentedOption<SearchScope>>
  scope: SearchScope
  onScopeChange(scope: SearchScope): void
  t: TFn
}

export function SearchHead({
  query,
  onQueryChange,
  options,
  scope,
  onScopeChange,
  t,
}: SearchHeadProps) {
  return (
    <div className={s.head}>
      <Input
        className={s.input}
        value={query}
        onValueChange={onQueryChange}
        size="lg"
        prefix={<Search className={s.icon} strokeWidth={1.75} aria-hidden="true" />}
        placeholder={t('search.placeholder')}
        aria-label={t('search.label')}
      />
      <Segmented
        options={options}
        value={scope}
        onChange={onScopeChange}
        label={t('search.scopeLabel')}
      />
    </div>
  )
}
