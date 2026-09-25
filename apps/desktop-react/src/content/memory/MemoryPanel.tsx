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
 * **内存监视器**(2026-09-25,用户:「给一个 monitor 应用,来查看内存占用」→「把 ui 好好设计一版」)。
 *
 * 一块普通的 Dock 瓦(`panel:memory`,与音乐 / 待办同一条路),读 core 的 `memory.report` ——
 * 与 `bun run memory:report` 同一只接口。自上而下回答四个问题,一节一个:
 *
 *  ① **现在多少、危不危险** —— 领头大数字 + 压力点 + 一条带 soft / hard 两根刻线的预算表;
 *  ② **最近怎么走的** —— 最近 5 分钟的面积图,soft / hard 两根发丝线作参照;
 *  ③ **花在哪儿** —— 一根四段的比例条(core / 界面 / 网页 / 系统)+ 带数值的图例;
 *  ④ **具体是谁** —— 按四类分组的进程表,与内存预算表上每一只缓存(条数对上限的细表)。
 *
 * 颜色的分工:四类用分类色 `--viz-1..4`(次序固定,跟类别走不跟排名走);压力只用状态色
 * (`--accent` / `--warn` / `--danger`),两套不混 —— 一格「超 hard」的红不会被读成「第五类」。
 * 文字永远是文字色,颜色只上标记(色块 / 条 / 线)。
 *
 * 状态清单:
 *  · 首载:一行「正在读取…」(不画骨架:这块面首载只有一拍,实测 ≈200ms);
 *  · 趋势刚起步(<2 个点):那一格写「再等几秒就有曲线」,不画一根孤零零的点;
 *  · 重拉:旧数留屏,整块面不闪(律②,query 的性质);
 *  · 出错:错话与旧数并陈(律②),下一次轮询自己重试;
 *  · 空:某一类没有进程就不出现(条上画不出 0 字节的段,图例里是噪音);
 *  · 超量:开了 30 格网页 —— 进程表在自己的滚动身里,头与领头数字不动;
 *  · 看不见就不问:面板收起 / 被切走时停轮询(`usePanelVisibility`),趋势线那一段留白。
 *
 * 「释放缓存」= `memory.trim('hard')`:叫每一只持有者把能重建的都放掉(后台放久了的网页、
 * 空闲的会话缓存……)。只有本机可信的调用方能做,浏览器壳上会答一句拒绝。
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

  // 每一份新报表记一个点(`capturedAt` 去重:同一份报表重渲不重复记)。
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

// ── ① 现在多少 ──────────────────────────────────────────────────────────────

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
        预算表。填充色说「危不危险」(强调 → 警告 → 危险,状态色),两根刻线就是调度器
        用的那两条线;刻度顶留出超线那一截(`meterScale`),超了也画得出来。
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

      <p className={s.meta}>
        {t('memory.heapLine', { heap: formatBytes(data.heap.usedBytes), total: formatBytes(data.heap.totalBytes) })}
        {data.partial ? ` · ${t('memory.partial')}` : ''}
        {lastTrim ? <span data-testid="memory-last-trim">{` · ${trimLine(t, lastTrim)}`}</span> : null}
      </p>
    </Card>
  )
}

// ── ③ 花在哪儿(总览卡里的第二段)────────────────────────────────────────

function Composition({ t, groups }: { t: TFn; groups: CategoryGroup[] }) {
  return (
    <div className={s.composition}>
      <span className={s.heroLabel} id="memory-composition-title">{t('memory.composition')}</span>
      {/* 比例条是图例的图形投影;数值全在下面那张图例里,条本身对读屏隐藏。 */}
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

// ── ④ 具体是谁 ──────────────────────────────────────────────────────────────

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
                    {/* 定宽小条:这一行占最大那个进程的几成,排成整齐的一列。 */}
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
    ?? (parts.length > 0 ? parts.map(part => (part.key ? t(part.key, { count: part.value }) : `${part.raw} ${part.value}`)).join(' · ') : undefined)
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
            // **顶到上限不换色**:缓存满了就按自己的规矩淘汰,那是它的正常工作状态,
            // 染成警告色会让人以为出了事(真机看过一版黄条,读起来像故障)。
          />
        )}
      </div>
    </li>
  )
}

// ── 念法 ────────────────────────────────────────────────────────────────────

/** 压力档 → 表的色档。量不到也画强调色(轨道还在,只是没有填充)。 */
function meterTone(tone: StatusDotTone): MeterTone {
  if (tone === 'bad') return 'danger'
  if (tone === 'warn') return 'warn'
  return 'accent'
}

/** 「1.7 GB」→ ["1.7", "GB"]:领头数字与单位分两种字号。 */
function splitBytes(bytes: number | null): [string, string] {
  if (bytes === null) return ['', '']
  const text = formatBytes(bytes)
  const at = text.lastIndexOf(' ')
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)]
}

/** Chromium 服务的内部名换成人话;认不得的原样。 */
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

/** 「8 / 8 个会话 · 27 MB」:有条数上限就念成「现在 / 上限」,字节跟在后面。 */
function holderReadout(t: TFn, holder: MemoryHolderReport): string {
  const limit = holder.limit?.entries
  const count = limit === undefined ? countText(t, holder.entries, holder.unit) : `${holder.entries} / ${countText(t, limit, holder.unit)}`
  return holder.bytes === undefined ? count : `${count} · ${formatBytes(holder.bytes)}`
}

function trimLine(t: TFn, result: MemoryTrimReport): string {
  return t('memory.released', { count: result.releasedEntries, bytes: formatBytes(result.releasedBytes) })
}
