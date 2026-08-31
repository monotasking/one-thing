import { Button } from '../../ui/Button'
import { Checkbox } from '../../ui/Checkbox'
import { Input } from '../../ui/Input'
import { Spinner } from '../../ui/Spinner'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { formatFetchedAt, formatPrice, formatTokens, priceIsIncluded } from '../projection'
import { MODEL_CAPS } from '../types'
import type { CatalogRow, ModelCap, ProviderModeKind } from '../types'
import type { CatalogStatus } from '../store'
import s from './ModelCatalog.module.css'

/**
 * 一坑的模型目录。**目录跟着模式走** —— 订阅坑与 API 坑各一份,这块组件一次只
 * 画一份,所以它连「合并两份目录」的可能性都没有。
 *
 * 一行七格:勾选 / 模型(名 + id)/ 能力 / 上下文 / 最大输出 / 单价 / 当前模型。
 * 每一格都可能是「不知道」——目录没填就画一个破折号,不画 0、不画「免费」。
 */

const CAP_LABELS: Record<ModelCap, MessageKey> = {
  vision: 'providers.capVision',
  tools: 'providers.capTools',
  reasoning: 'providers.capReasoning',
  imageOut: 'providers.capImageOut',
  audioIn: 'providers.capAudioIn',
}

export function ModelCatalog({
  rows,
  status,
  error,
  fetchedAt,
  kind,
  query,
  saving,
  onQuery,
  onRefresh,
  onToggle,
}: {
  rows: readonly CatalogRow[]
  status: CatalogStatus
  /** 后端那句原话。原样显示 —— 它是数据,不是文案。 */
  error?: string
  fetchedAt?: number
  kind: ProviderModeKind
  query: string
  saving: boolean
  onQuery: (value: string) => void
  onRefresh: () => void
  onToggle: (modelId: string, selected: boolean) => void
}) {
  const t = useT()
  const loading = status === 'loading'
  const fetched = formatFetchedAt(fetchedAt)
  const included = priceIsIncluded(kind)

  return (
    <section className={s.catalog} aria-label={t('providers.catalog')}>
      <div className={s.head}>
        <div className={s.headText}>
          <h3 className={s.title}>{t('providers.catalog')}</h3>
          <span className={s.hint}>
            {fetched
              ? `${t('providers.catalogFetched', { time: fetched })} · ${t('providers.catalogHint')}`
              : t('providers.catalogHint')}
          </span>
        </div>
        <div className={s.search}>
          <Input
            size="sm"
            value={query}
            onValueChange={onQuery}
            placeholder={t('providers.catalogSearch')}
            aria-label={t('providers.catalogSearch')}
          />
        </div>
        {/* spinner 只许出现在按钮与状态栏里 —— 这一颗长在「刷新目录」上。 */}
        <Button size="sm" onClick={onRefresh} disabled={loading}>
          {loading ? <Spinner label={t('providers.catalogLoading')} /> : t('providers.catalogRefresh')}
        </Button>
      </div>

      <div className={`${s.grid} ${s.columns}`}>
        <span />
        <span>{t('providers.colModel')}</span>
        <span>{t('providers.colCaps')}</span>
        <span>{t('providers.colCtx')}</span>
        <span>{t('providers.colOut')}</span>
        <span>{t('providers.colPrice')}</span>
        <span />
      </div>

      {status === 'error' && (
        <p className={s.state}>
          {t('providers.catalogFailed')}
          {error ? ` · ${error}` : ''}
        </p>
      )}
      {status !== 'error' && rows.length === 0 && (
        <p className={s.state}>
          {loading
            ? t('providers.catalogLoading')
            : query.trim()
              ? t('providers.catalogNoHit')
              : t('providers.catalogEmpty')}
        </p>
      )}

      {rows.length > 0 && (
        <div className={s.rows}>
          {rows.map((row) => (
            <div key={row.id} className={`${s.grid} ${s.row}`} data-testid={`model-row-${row.id}`}>
              <Checkbox
                checked={row.selected}
                onChange={(next) => onToggle(row.id, next)}
                disabled={saving}
                label={t('providers.pickModel', { model: row.id })}
              />
              <span className={s.cell}>
                <span className={`${s.name} ${row.selected ? '' : s.nameOff}`}>{row.name}</span>
                <span className={s.id}>{row.id}</span>
              </span>
              <span className={s.caps}>
                {row.caps.length === 0
                  ? t('providers.unknownValue')
                  : MODEL_CAPS.filter((cap) => row.caps.includes(cap))
                      .map((cap) => t(CAP_LABELS[cap]))
                      .join(' ')}
              </span>
              <span className={s.num}>
                {formatTokens(row.contextLength) ?? t('providers.unknownValue')}
              </span>
              <span className={s.num}>
                {formatTokens(row.maxOutput) ?? t('providers.unknownValue')}
              </span>
              <span className={s.price}>
                {included
                  ? t('providers.priceIncluded')
                  : row.price
                    ? `${formatPrice(row.price.input)} / ${formatPrice(row.price.output)}`
                    : t('providers.unknownValue')}
              </span>
              {/*
                「设为当前」批一不做,所以非当前的那些行**什么都不画** ——
                画一颗点了没反应的钮比留白更坏(缺席态的通则)。
              */}
              <span className={s.current}>{row.current ? t('providers.current') : ''}</span>
            </div>
          ))}
        </div>
      )}

      <p className={s.note}>
        {t('providers.capLegend')} {t('providers.setCurrentNext')} · {t('providers.addModelNext')}
      </p>
    </section>
  )
}
