import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../ui/Button'
import { Checkbox } from '../../ui/Checkbox'
import { Input } from '../../ui/Input'
import { Spinner } from '../../ui/Spinner'
import { useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import {
  formatFetchedAt,
  formatPrice,
  formatTokens,
  groupCatalog,
  priceIsIncluded,
} from '../projection'
import { MODEL_CAPS, OTHER_GROUP } from '../types'
import type { CatalogGroup, CatalogRow, ModelCap, ProviderModeKind } from '../types'
import type { CatalogStatus } from '../store'
import s from './ModelCatalog.module.css'

/**
 * 一坑的模型目录。**目录跟着模式走** —— 订阅坑与 API 坑各一份,这块组件一次只
 * 画一份,所以它连「合并两份目录」的可能性都没有。
 *
 * 一行七格:勾选 / 模型(名 + id)/ 能力 / 上下文 / 最大输出 / 单价 / 当前模型。
 * 每一格都可能是「不知道」——目录没填就画一个破折号,不画 0、不画「免费」。
 *
 * ── 300+ 行怎么画(批二)────────────────────────────────────────────────────
 * OpenRouter 一家就 300 多型,平铺是卡顿的产地。三条判据全在 `groupCatalog` 里
 * (纯函数、可断言),这块组件只负责**收起的组不渲染行** —— 收起还渲染 DOM
 * 就等于没折叠,那是这类列表最常见的假优化。
 */

const CAP_LABELS: Record<ModelCap, MessageKey> = {
  vision: 'providers.capVision',
  tools: 'providers.capTools',
  reasoning: 'providers.capReasoning',
  imageOut: 'providers.capImageOut',
  audioIn: 'providers.capAudioIn',
}

/**
 * 超过这个行数的**展开**组,行上挂 `content-visibility: auto` 让浏览器跳过
 * 视口外的排版。只对长组挂:短组挂了只是多一层 containment,白付成本。
 */
const SKIP_ROWS_FROM = 40

export function ModelCatalog({
  providerId,
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
  onSetCurrent,
  onAddManual,
  onRemoveManual,
}: {
  /** 这一坑是谁。换一坑要把「展开了哪些组」忘掉 —— 那是上一坑的事。 */
  providerId: string
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
  /** 设为这一坑的当前模型(写 `providers[pid].model`)。 */
  onSetCurrent: (modelId: string) => void
  /** 手填一个目录里没有的 id。返回一句错误原文 = 没加上。 */
  onAddManual: (modelId: string) => string | undefined
  onRemoveManual: (modelId: string) => void
}) {
  const t = useT()
  const loading = status === 'loading'
  const fetched = formatFetchedAt(fetchedAt)
  const included = priceIsIncluded(kind)
  const searching = query.trim().length > 0

  const grouped = useMemo(() => groupCatalog(rows, searching), [rows, searching])

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [addError, setAddError] = useState<string | undefined>(undefined)

  // 换一坑 = 换一份目录。上一坑展开过哪些组、正在填的那个 id,都不能跟过来。
  useEffect(() => {
    setExpanded(new Set())
    setAdding(false)
    setDraft('')
    setAddError(undefined)
  }, [providerId])

  function submitManual() {
    const id = draft.trim()
    if (!id) return
    const failure = onAddManual(id)
    setAddError(failure)
    if (failure) return
    setDraft('')
  }

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
        <Button
          size="sm"
          onClick={() => {
            setAdding((open) => !open)
            setAddError(undefined)
          }}
          aria-expanded={adding}
        >
          {t('providers.addModel')}
        </Button>
      </div>

      {adding && (
        <div className={s.addRow}>
          <div className={s.addField}>
            <Input
              size="sm"
              value={draft}
              onValueChange={(value) => {
                setDraft(value)
                setAddError(undefined)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitManual()
                }
              }}
              invalid={Boolean(addError)}
              placeholder={t('providers.addModelPlaceholder')}
              aria-label={t('providers.addModelLabel')}
            />
          </div>
          <Button size="sm" variant="primary" disabled={!draft.trim() || saving} onClick={submitManual}>
            {t('providers.addModelSubmit')}
          </Button>
          {addError && <span className={s.addError}>{addError}</span>}
        </div>
      )}

      <div className={`${s.grid} ${s.columns}`}>
        <span />
        <span>{t('providers.colModel')}</span>
        <span>{t('providers.colCaps')}</span>
        <span>{t('providers.colCtx')}</span>
        <span>{t('providers.colOut')}</span>
        {/* 窄容器里这一格与行上的价格一起退场 —— 类名是它俩的共同开关。 */}
        <span className={s.colPrice}>{t('providers.colPrice')}</span>
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
          {/*
            已选置顶。**只有折叠生效时才画这条组头** —— 平铺的目录里
            「已选 · 3」是一句废话,行本来就都在眼前。
          */}
          {grouped.grouped && grouped.picked.length > 0 && (
            <div className={s.groupHead}>
              {t('providers.groupPicked', { count: grouped.picked.length })}
            </div>
          )}
          {grouped.picked.map((row) => (
            <Row
              key={row.id}
              t={t}
              row={row}
              included={included}
              saving={saving}
              skip={false}
              onToggle={onToggle}
              onSetCurrent={onSetCurrent}
              onRemoveManual={onRemoveManual}
            />
          ))}

          {grouped.groups.map((group) => {
            const open = !grouped.grouped || searching || expanded.has(group.prefix)
            const skip = open && group.rows.length > SKIP_ROWS_FROM
            return (
              <div key={group.prefix}>
                {grouped.grouped && (
                  <button
                    type="button"
                    className={s.groupToggle}
                    aria-expanded={open}
                    // 检索时组是被**判据**打开的,不是用户打开的 —— 那时这颗钮
                    // 点了不该把它关上,不然「命中的组自动展开」立刻自相矛盾。
                    disabled={searching}
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev)
                        if (next.has(group.prefix)) next.delete(group.prefix)
                        else next.add(group.prefix)
                        return next
                      })
                    }
                    data-testid={`model-group-${group.prefix.trim() || 'other'}`}
                  >
                    <span className={s.groupCaret} aria-hidden="true">
                      {open ? '▾' : '▸'}
                    </span>
                    <span className={s.groupName}>{groupLabel(t, group)}</span>
                    <span className={s.groupNote}>{groupNote(t, group)}</span>
                  </button>
                )}
                {/* 收起 = **不渲染行**。收起还渲染就等于没折叠。 */}
                {open &&
                  group.rows.map((row) => (
                    <Row
                      key={row.id}
                      t={t}
                      row={row}
                      included={included}
                      saving={saving}
                      skip={skip}
                      onToggle={onToggle}
                      onSetCurrent={onSetCurrent}
                      onRemoveManual={onRemoveManual}
                    />
                  ))}
              </div>
            )
          })}

          {/* 截了就说。默默少画几百行是这类列表最容易犯的那种谎。 */}
          {grouped.truncated > 0 && (
            <p className={s.truncated}>
              {t('providers.catalogTruncated', { count: grouped.truncated })}
            </p>
          )}
        </div>
      )}

      <p className={s.note}>{t('providers.capLegend')}</p>
    </section>
  )
}

/** 「anthropic/」;杂项组说「其他」。前缀是数据,不翻译。 */
function groupLabel(t: TFn, group: CatalogGroup): string {
  return group.prefix === OTHER_GROUP ? t('providers.groupOther') : group.prefix
}

/** 「18 型」/「125 型 · 45 个厂牌」。厂牌数只有杂项组说得出口。 */
function groupNote(t: TFn, group: CatalogGroup): string {
  const count = t('providers.groupCount', { count: group.rows.length })
  if (group.prefix !== OTHER_GROUP || group.vendors === 0) return count
  return `${count} · ${t('providers.groupVendors', { count: group.vendors })}`
}

function Row({
  t,
  row,
  included,
  saving,
  skip,
  onToggle,
  onSetCurrent,
  onRemoveManual,
}: {
  t: TFn
  row: CatalogRow
  included: boolean
  saving: boolean
  /** 长组里的行跳过视口外排版。 */
  skip: boolean
  onToggle: (modelId: string, selected: boolean) => void
  onSetCurrent: (modelId: string) => void
  onRemoveManual: (modelId: string) => void
}) {
  return (
    <div
      className={`${s.grid} ${s.row} ${skip ? s.rowSkip : ''}`}
      data-testid={`model-row-${row.id}`}
    >
      <Checkbox
        checked={row.selected}
        onChange={(next) => onToggle(row.id, next)}
        disabled={saving}
        label={t('providers.pickModel', { model: row.id })}
      />
      <span className={s.cell}>
        <span className={`${s.name} ${row.selected ? '' : s.nameOff}`}>{row.name}</span>
        <span className={s.idLine}>
          <span className={s.id}>{row.id}</span>
          {/* 手填的行标出来:它的能力与容量是**没人给过**的,不是「都不支持」。 */}
          {row.manual && <span className={s.manual}>{t('providers.manualModel')}</span>}
        </span>
      </span>
      <span className={s.caps}>
        {row.caps.length === 0
          ? t('providers.unknownValue')
          : MODEL_CAPS.filter((cap) => row.caps.includes(cap))
              .map((cap) => t(CAP_LABELS[cap]))
              .join(' ')}
      </span>
      <span className={s.num}>{formatTokens(row.contextLength) ?? t('providers.unknownValue')}</span>
      <span className={s.num}>{formatTokens(row.maxOutput) ?? t('providers.unknownValue')}</span>
      <span className={s.price}>
        {included
          ? t('providers.priceIncluded')
          : row.price
            ? `${formatPrice(row.price.input)} / ${formatPrice(row.price.output)}`
            : t('providers.unknownValue')}
      </span>
      <span className={s.actions}>
        {row.current ? (
          <span className={s.current}>{t('providers.current')}</span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => onSetCurrent(row.id)}
            data-testid={`set-current-${row.id}`}
          >
            {t('providers.setCurrent')}
          </Button>
        )}
        {row.manual && (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            disabled={saving}
            onClick={() => onRemoveManual(row.id)}
            aria-label={t('providers.removeModel', { model: row.id })}
          >
            ✕
          </Button>
        )}
      </span>
    </div>
  )
}
