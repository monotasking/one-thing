import { useEffect, useState } from 'react'
import { AsyncButton } from '../../ui/AsyncButton'
import { Card } from '../../ui/Card'
import { GroupHead } from '../../ui/GroupHead'
import { Meter, type MeterTone } from '../../ui/Meter'
import { StatusDot, type StatusDotTone } from '../../ui/StatusDot'
import { Tooltip } from '../../ui/Tooltip'
import { announce } from '../../ui/a11y/live-region'
import { useMutation, useQuery } from '../../data/kernel'
import { memoryReportQuery, memoryTrimMutation } from '../../data/memory-source'
import { formatBytes } from '../../format/quantity'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import type { MemoryHolderReport, MemoryReportResponse, MemoryTrimReport } from '@shared/ipc/memory'
import { usePanelVisibility } from '../visibility'
import {
  MEMORY_POLL_MS,
  appendSample,
  categoryColorVar,
  categoryHintKey,
  categoryLabelKey,
  formatShare,
  groupByCategory,
  holderDetailParts,
  holderFill,
  holderUnitKey,
  meterScale,
  pressureLabelKey,
  pressureTone,
  type CategoryGroup,
  type MemorySample,
} from './memory-model'
import { MemoryTrend } from './MemoryTrend'
import s from './MemoryPanel.module.css'

/**
 * 内存面板(Dock 上的「内存」)。数据来自 `memory.report` 接口,与 `bun run memory:report` 相同。
 *
 * 四部分:
 *  1. 概览:总占用、状态、带软 / 硬上限刻度的占用条,以及按类别的占用分布;
 *  2. 占用趋势:最近 5 分钟的总占用曲线;
 *  3. 进程:按类别分组的进程列表;
 *  4. 缓存:各缓存的用量与上限。
 *
 * 颜色:四个类别用分类色 `--viz-1..4`,按类别固定,不随排名变化;状态只用
 * `--accent` / `--warn` / `--danger`,两者不混用。文字始终使用文字色。
 *
 * 状态:
 *  - 首次加载:显示「正在读取…」;
 *  - 趋势数据不足 2 个点:显示「正在采集数据」;
 *  - 刷新期间保留旧数据;
 *  - 读取失败:显示错误,同时保留旧数据,下次轮询自动重试;
 *  - 没有进程的类别不显示;
 *  - 面板不可见时停止轮询。
 *
 * 「释放缓存」调用 `memory.trim('hard')`,释放所有可重建的缓存。只有本机可信的
 * 调用方可以执行,浏览器版界面上会返回拒绝。
 */
export function MemoryPanel() {
  const t = useT()
  const { visible } = usePanelVisibility()
  const { data, error, phase } = useQuery(memoryReportQuery)
  const trim = useMutation(memoryTrimMutation)
  const [lastTrim, setLastTrim] = useState<MemoryTrimReport | undefined>(undefined)
  const [history, setHistory] = useState<MemorySample[]>([])

  useEffect(() => {
    if (!visible) return
    void memoryReportQuery.refetch()
    const timer = setInterval(() => void memoryReportQuery.refetch(), MEMORY_POLL_MS)
    return () => clearInterval(timer)
  }, [visible])

  // 每份新报表记录一个趋势点,按 `capturedAt` 去重。
  const capturedAt = data?.capturedAt
  const totalBytes = data?.totalBytes
  useEffect(() => {
    if (capturedAt === undefined || totalBytes === undefined || totalBytes === null) return
    setHistory(prev => appendSample(prev, { at: capturedAt, bytes: totalBytes }))
  }, [capturedAt, totalBytes])

  const release = async (): Promise<void> => {
    const result = await memoryTrimMutation.run('hard')
    if (!result) return
    setLastTrim(result)
    announce(trimLine(t, result))
  }

  return (
    <section className={s.panel} aria-labelledby="memory-panel-title" data-testid="memory-panel">
      <header className={s.head}>
        <h2 id="memory-panel-title" className={s.title}>{t('item.memory')}</h2>
        <span className={s.spacer} />
        <Tooltip content={t('memory.releaseHint')}>
          <AsyncButton
            action={memoryTrimMutation}
            pendingLabel={t('memory.releasing')}
            size="sm"
            onClick={() => void release()}
          >
            {t('memory.release')}
          </AsyncButton>
        </Tooltip>
      </header>

      <div className={s.body}>
        {error ? <p className={s.error} role="alert">{t('memory.readFailed', { reason: error })}</p> : null}
        {trim.error ? <p className={s.error} role="alert">{t('memory.releaseFailed', { reason: trim.error })}</p> : null}

        {!data ? (
          phase === 'initial' || !error ? <p className={s.none}>{t('memory.loading')}</p> : null
        ) : (
          <>
            <Overview t={t} data={data} lastTrim={lastTrim} />

            <Card
              className={s.section}
              pad="lg"
              title={t('memory.trend')}
              note={t('memory.trendWindow')}
            >
              <MemoryTrend history={history} budget={data.budget} />
            </Card>

            <Processes t={t} groups={groupByCategory(data.processes)} />

            <Card className={s.section} pad="lg" title={t('memory.holders')} note={t('memory.holdersHint')} notePlacement="below">
              <ul className={s.holders}>
                {data.holders.map(holder => <HolderRow key={holder.id} t={t} holder={holder} />)}
              </ul>
            </Card>
          </>
        )}
      </div>
    </section>
  )
}

// ── 概览 ────────────────────────────────────────────────────────────────────

function Overview({ t, data, lastTrim }: { t: TFn; data: MemoryReportResponse; lastTrim: MemoryTrimReport | undefined }) {
  const tone = pressureTone(data)
  const scale = meterScale(data)
  const [value, unit] = splitBytes(data.totalBytes)
  const groups = groupByCategory(data.processes)
  return (
    <Card className={s.section} pad="lg" aria-label={t('memory.overview')}>
      <div className={s.heroRow}>
        <div className={s.heroBlock}>
          <span className={s.heroLabel}>{t('memory.totalLabel')}</span>
          <p className={s.hero} data-testid="memory-total">
            {data.totalBytes === null ? (
              <span className={s.heroUnknown}>{t('memory.totalUnknown')}</span>
            ) : (
              <>
                <span className={s.heroValue}>{value}</span>
                <span className={s.heroUnit}>{unit}</span>
              </>
            )}
          </p>
        </div>
        <span className={s.pressure} data-tone={tone}>
          <StatusDot tone={tone} />
          {t(pressureLabelKey(tone))}
        </span>
      </div>

      {/*
        占用条:填充色表示状态,两个刻度是软 / 硬上限。刻度最大值高于硬上限,
        超过硬上限的部分也能显示(见 `meterScale`)。
      */}
      <Meter
        className={s.budgetMeter}
        label={t('memory.budgetLabel')}
        max={scale.max}
        {...(data.totalBytes === null ? {} : { value: data.totalBytes, valueText: formatBytes(data.totalBytes) })}
        tone={meterTone(tone)}
        ticks={[
          { at: data.budget.softBytes, label: `${t('memory.softLine')} ${formatBytes(data.budget.softBytes)}` },
          { at: data.budget.hardBytes, label: `${t('memory.hardLine')} ${formatBytes(data.budget.hardBytes)}` },
        ]}
      />

      {groups.length > 0 ? <Composition t={t} groups={groups} /> : null}

      {data.partial || lastTrim ? (
        <p className={s.meta}>
          {[data.partial ? t('memory.partial') : undefined, lastTrim ? trimLine(t, lastTrim) : undefined]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
    </Card>
  )
}

// ── 占用分布(概览卡片内)──────────────────────────────────────────────────

function Composition({ t, groups }: { t: TFn; groups: CategoryGroup[] }) {
  return (
    <div className={s.composition}>
      <span className={s.heroLabel} id="memory-composition-title">{t('memory.composition')}</span>
      {/* 比例条的数值都在下方图例中,因此对读屏软件隐藏。 */}
      <div className={s.stack} aria-hidden="true">
        {groups.map(group => (
          <Tooltip key={group.category} content={`${t(categoryLabelKey(group.category))} · ${formatBytes(group.bytes)} · ${formatShare(group.share)}`}>
            <span
              className={s.stackSegment}
              style={{ flexGrow: group.bytes, background: categoryColorVar(group.category) }}
            />
          </Tooltip>
        ))}
      </div>
      <ul className={s.legend} aria-labelledby="memory-composition-title">
        {groups.map(group => (
          <li key={group.category} className={s.legendItem}>
            <span className={s.swatch} style={{ background: categoryColorVar(group.category) }} aria-hidden="true" />
            <Tooltip content={t(categoryHintKey(group.category))}>
              <span className={s.legendName}>{t(categoryLabelKey(group.category))}</span>
            </Tooltip>
            <span className={s.legendValue}>{formatBytes(group.bytes)}</span>
            <span className={s.legendShare}>{formatShare(group.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── 进程与缓存 ──────────────────────────────────────────────────────────────

function Processes({ t, groups }: { t: TFn; groups: CategoryGroup[] }) {
  const largest = groups.reduce((max, group) => Math.max(max, ...group.processes.map(row => row.bytes ?? 0)), 0)
  const count = groups.reduce((sum, group) => sum + group.processes.length, 0)
  return (
    <Card className={s.section} pad="lg" title={t('memory.processes')} note={t('memory.processCount', { count })}>
      {groups.length === 0 ? (
        <p className={s.none}>{t('memory.noProcesses')}</p>
      ) : (
        <div className={s.groups}>
          {groups.map(group => (
            <div key={group.category} className={s.group}>
              <GroupHead
                label={(
                  <span className={s.groupName}>
                    <span className={s.swatch} style={{ background: categoryColorVar(group.category) }} aria-hidden="true" />
                    {t(categoryLabelKey(group.category))}
                  </span>
                )}
                note={formatBytes(group.bytes)}
              />
              <ul className={s.rows} aria-label={t(categoryLabelKey(group.category))}>
                {group.processes.map(row => (
                  <li key={row.pid} className={s.row} data-testid="memory-process-row">
                    <Tooltip content={`${row.name} · pid ${row.pid}`}>
                      <span className={s.nameText} data-testid="memory-process-name">{displayName(t, row.name)}</span>
                    </Tooltip>
                    {/* 固定宽度的小条,表示该进程相对最大进程的占比。 */}
                    <span className={s.mini} aria-hidden="true">
                      <span
                        className={s.miniFill}
                        style={{
                          width: `${largest > 0 && row.bytes !== null ? (row.bytes / largest) * 100 : 0}%`,
                          background: categoryColorVar(group.category),
                        }}
                      />
                    </span>
                    <span className={s.bytes}>
                      {row.bytes === null ? t('memory.unmeasured') : formatBytes(row.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function HolderRow({ t, holder }: { t: TFn; holder: MemoryHolderReport }) {
  const fill = holderFill(holder)
  const parts = holderDetailParts(holder)
  const detail = holder.error
    ?? (parts.length > 0 ? parts.map(part => t(part.key, { count: part.value })).join(' · ') : undefined)
  return (
    <li className={s.holder} data-testid="memory-holder-row">
      <div className={s.holderText}>
        <Tooltip content={holder.id}>
          <span className={s.holderName}>{holder.label}</span>
        </Tooltip>
        {detail ? <span className={holder.error ? s.holderError : s.holderDetail}>{detail}</span> : null}
      </div>
      <div className={s.holderSide}>
        <span className={s.holderReadout}>{holderReadout(t, holder)}</span>
        {fill === undefined || holder.limit?.entries === undefined ? null : (
          <Meter
            className={s.holderMeter}
            size="sm"
            label={t('memory.holderFill', { name: holder.label })}
            value={holder.entries}
            max={holder.limit.entries}
            valueText={holderReadout(t, holder)}
            // 达到上限时不改颜色:缓存满后按自身规则淘汰,属于正常状态。
          />
        )}
      </div>
    </li>
  )
}

// ── 格式化 ──────────────────────────────────────────────────────────────────

/** 状态对应的占用条颜色。无法测量时用强调色。 */
function meterTone(tone: StatusDotTone): MeterTone {
  if (tone === 'bad') return 'danger'
  if (tone === 'warn') return 'warn'
  return 'accent'
}

/** 把「1.7 GB」拆成数值与单位,分别使用不同字号。 */
function splitBytes(bytes: number | null): [string, string] {
  if (bytes === null) return ['', '']
  const text = formatBytes(bytes)
  const at = text.lastIndexOf(' ')
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)]
}

/** 把 Chromium 服务进程的内部名称转换为可读名称;未知名称原样显示。 */
function displayName(t: TFn, name: string): string {
  if (name === 'core') return t('memory.nameCore')
  if (name.startsWith('network.mojom')) return t('memory.nameNetwork')
  if (name.startsWith('audio.mojom')) return t('memory.nameAudio')
  if (name.startsWith('storage.mojom')) return t('memory.nameStorage')
  return name
}

function countText(t: TFn, count: number, unit: string): string {
  const key = holderUnitKey(unit)
  return key ? t(key, { count }) : `${count} ${unit}`
}

/** 缓存读数,如「8 / 8 个会话 · 27 MB」;没有上限时只显示当前数量。 */
function holderReadout(t: TFn, holder: MemoryHolderReport): string {
  const limit = holder.limit?.entries
  const count = limit === undefined ? countText(t, holder.entries, holder.unit) : `${holder.entries} / ${countText(t, limit, holder.unit)}`
  return holder.bytes === undefined ? count : `${count} · ${formatBytes(holder.bytes)}`
}

function trimLine(t: TFn, result: MemoryTrimReport): string {
  return t('memory.released', { count: result.releasedEntries, bytes: formatBytes(result.releasedBytes) })
}
