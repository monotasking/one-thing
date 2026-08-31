import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import type { Fact, RailGroup, RailRow, StatusTone } from '../types'
import s from './ProviderRail.module.css'

/**
 * 左栏 = 家名册。268px 定宽,三组(云服务 / 本地 / 自定义),
 * 一行三件:22px 方图标 / 名 + 副行 / 行尾 6px 状态点。
 *
 * 它**不认识 store** —— 行是算好的 `RailRow[]`,选中与检索由上面递进来。
 * 这样这块组件只做一件事(把事实画出来),而事实那一半在 projection 里可断言。
 */

const GROUP_LABELS: Record<RailGroup, MessageKey> = {
  cloud: 'providers.groupCloud',
  local: 'providers.groupLocal',
  custom: 'providers.groupCustom',
}

const GROUP_ORDER: RailGroup[] = ['cloud', 'local', 'custom']

const DOT_CLASS: Record<StatusTone, string> = {
  ok: s.dotOk,
  bad: s.dotBad,
  warn: s.dotWarn,
  idle: s.dotIdle,
  off: s.dotOff,
}

/** 一串事实 → 一行字。分隔符是排版记号,不是文案,所以它不进字典。 */
export function renderFacts(t: TFn, facts: readonly Fact[]): string {
  return facts.map((fact) => t(fact.key, fact.vars)).join(' · ')
}

export function ProviderRail({
  rows,
  connectedCount,
  selectedId,
  query,
  onQuery,
  onSelect,
}: {
  rows: readonly RailRow[]
  /** 「N 家已接入」的 N —— 已接入 ≠ 名册长度,判据在 projection 里。 */
  connectedCount: number
  selectedId: string | null
  query: string
  onQuery: (value: string) => void
  onSelect: (familyId: string) => void
}) {
  const t = useT()

  return (
    <nav className={s.rail} aria-label={t('providers.railTitle')}>
      <div className={s.head}>
        <div className={s.headLine}>
          <h2 className={s.title}>{t('providers.railTitle')}</h2>
          <span className={s.count}>{t('providers.railCount', { count: connectedCount })}</span>
        </div>
        <Input
          size="sm"
          value={query}
          onValueChange={onQuery}
          placeholder={t('providers.searchPlaceholder')}
          aria-label={t('providers.searchPlaceholder')}
        />
      </div>

      <div className={s.body}>
        {rows.length === 0 && <p className={s.none}>{t('providers.railEmpty')}</p>}
        {GROUP_ORDER.map((group) => {
          const inGroup = rows.filter((row) => row.group === group)
          if (inGroup.length === 0) return null
          return (
            <div key={group} className={s.group}>
              <div className={s.groupHead}>{t(GROUP_LABELS[group])}</div>
              <ul className={s.list}>
                {inGroup.map((row) => (
                  <li key={row.familyId}>
                    <button
                      type="button"
                      className={`${s.row} ${row.familyId === selectedId ? s.rowSelected : ''}`}
                      // 「这一行是当下选中的那一行」对读屏软件也要说得出来 ——
                      // 光靠底色是只给看得见的人的信息。
                      aria-current={row.familyId === selectedId ? 'true' : undefined}
                      onClick={() => onSelect(row.familyId)}
                      data-testid={`provider-row-${row.familyId}`}
                    >
                      <span className={`${s.icon} ${row.custom ? s.iconCustom : ''}`} aria-hidden="true">
                        {row.initial}
                      </span>
                      <span className={s.text}>
                        <span className={s.name}>{row.label}</span>
                        <span className={`${s.detail} ${row.tone === 'bad' ? s.detailBad : ''}`}>
                          {renderFacts(t, row.facts)}
                        </span>
                      </span>
                      <span className={`${s.dot} ${DOT_CLASS[row.tone]}`} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>

      <div className={s.foot}>
        {/*
          批一的缺席态:钮画出来但是禁用的,旁边一句话说清它什么时候会活过来。
          不做一个点了弹「敬请期待」的假流程 —— 那比一个明说「还没做」的钮更坏。
        */}
        <Button size="sm" disabled>
          {t('providers.addCustom')}
        </Button>
        <span className={s.footNote}>{t('providers.addCustomNext')}</span>
      </div>
    </nav>
  )
}
