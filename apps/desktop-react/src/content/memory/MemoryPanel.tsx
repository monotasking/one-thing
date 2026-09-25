import { useEffect, useState } from 'react'
import { AsyncButton } from '../../ui/AsyncButton'
import { Progress } from '../../ui/Progress'
import { StatusDot } from '../../ui/StatusDot'
import { Tooltip } from '../../ui/Tooltip'
import { announce } from '../../ui/a11y/live-region'
import { useMutation, useQuery } from '../../data/kernel'
import { memoryReportQuery, memoryTrimMutation } from '../../data/memory-source'
import { formatBytes } from '../../format/quantity'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import type { MemoryHolderReport, MemoryTrimReport } from '@shared/ipc/memory'
import { usePanelVisibility } from '../visibility'
import {
  MEMORY_POLL_MS,
  budgetRatio,
  holderDetailText,
  holderUnitKey,
  pressureLabelKey,
  pressureTone,
  processKindKey,
  shareOfLargest,
  sortProcesses,
} from './memory-model'
import s from './MemoryPanel.module.css'

/**
 * **内存监视器**(2026-09-25,用户:「给一个 monitor 应用,来查看内存占用」)。
 *
 * 一块普通的 Dock 瓦(`panel:memory`,与音乐 / 待办同一条路)。读的是 core 的
 * `memory.report` —— 与 `bun run memory:report` 同一只接口,屏上的数与终端里的
 * 数是同一份:整个 Electron 按进程拆开(core / 界面 / 每一格网页 / GPU / 系统服务),
 * 以及内存预算表上每一只持有者此刻攒了多少。
 *
 * 状态清单:
 *  · 首载:一行「正在读取…」(不画骨架 —— 这块面定长,首载只有一拍);
 *  · 重拉:旧数留在屏上,整块面不闪(律②,query 的性质);
 *  · 出错:错话与旧数并陈(律②),下一次轮询自己重试;
 *  · 空:没有进程行(量不到)画一行灰字;
 *  · 超量:进程 30+ 行(开了很多网页)—— 表在自己的滚动身里,头不动;
 *  · 看不见就不问:面板收起 / 被切走时停轮询(`usePanelVisibility`)。
 *
 * 「释放缓存」= `memory.trim('hard')`:叫每一只持有者把能重建的都放掉(后台放久了的
 * 网页、空闲的会话缓存……)。只有本机可信的调用方能做,浏览器壳上会答一句拒绝。
 */
export function MemoryPanel() {
  const t = useT()
  const { visible } = usePanelVisibility()
  const { data, error, phase } = useQuery(memoryReportQuery)
  const trim = useMutation(memoryTrimMutation)
  const [lastTrim, setLastTrim] = useState<MemoryTrimReport | undefined>(undefined)

  useEffect(() => {
    if (!visible) return
    void memoryReportQuery.refetch()
    const timer = setInterval(() => void memoryReportQuery.refetch(), MEMORY_POLL_MS)
    return () => clearInterval(timer)
  }, [visible])

  const release = async (): Promise<void> => {
    const result = await memoryTrimMutation.run('hard')
    if (!result) return
    setLastTrim(result)
    announce(trimLine(t, result))
  }

  const tone = data ? pressureTone(data) : 'idle'
  const processes = data ? sortProcesses(data.processes) : []
  const shares = shareOfLargest(processes)

  return (
    <section className={s.panel} aria-labelledby="memory-panel-title" data-testid="memory-panel">
      <header className={s.head}>
        <h2 id="memory-panel-title" className={s.title}>{t('item.memory')}</h2>
        {data ? (
          <span className={s.total} data-testid="memory-total">
            <StatusDot tone={tone} />
            {data.totalBytes === null ? t('memory.totalUnknown') : formatBytes(data.totalBytes)}
            {' · '}
            {t(pressureLabelKey(tone))}
          </span>
        ) : null}
        <span className={s.spacer} />
        <AsyncButton
          action={memoryTrimMutation}
          pendingLabel={t('memory.releasing')}
          size="sm"
          onClick={() => void release()}
        >
          {t('memory.release')}
        </AsyncButton>
      </header>

      <div className={s.body}>
        {error ? <p className={s.error} role="alert">{t('memory.readFailed', { reason: error })}</p> : null}
        {trim.error ? <p className={s.error} role="alert">{t('memory.releaseFailed', { reason: trim.error })}</p> : null}

        {!data ? (
          phase === 'initial' || !error ? <p className={s.none}>{t('memory.loading')}</p> : null
        ) : (
          <>
            <div className={s.budget}>
              <Progress
                {...(budgetRatio(data) === undefined ? {} : { value: budgetRatio(data) })}
                label={t('memory.budgetLabel')}
              />
              <p className={s.meta}>
                {t('memory.budgetLine', {
                  soft: formatBytes(data.budget.softBytes),
                  hard: formatBytes(data.budget.hardBytes),
                  heap: formatBytes(data.heap.usedBytes),
                })}
                {data.partial ? ` · ${t('memory.partial')}` : ''}
              </p>
              {lastTrim ? <p className={s.meta}>{trimLine(t, lastTrim)}</p> : null}
            </div>

            <div className={s.section}>
              <h3 className={s.sectionLabel}>{t('memory.processes')}</h3>
              {processes.length === 0 ? (
                <p className={s.none}>{t('memory.noProcesses')}</p>
              ) : (
                <div role="table" aria-label={t('memory.processes')}>
                  <div role="row" className={s.headRow}>
                    <span role="columnheader">{t('memory.colName')}</span>
                    <span role="columnheader">{t('memory.colKind')}</span>
                    <span role="columnheader" className={s.bytes}>{t('memory.colMemory')}</span>
                  </div>
                  {processes.map(row => (
                    <div role="row" key={row.pid} className={s.row} data-testid="memory-process-row">
                      <span role="cell" className={s.name}>
                        <Tooltip content={`${row.name} · pid ${row.pid}`}>
                          <span className={s.nameText}>{row.name}</span>
                        </Tooltip>
                        <span className={s.share} aria-hidden="true">
                          <span className={s.shareFill} style={{ width: `${(shares.get(row.pid) ?? 0) * 100}%` }} />
                        </span>
                      </span>
                      <span role="cell" className={s.kind}>{t(processKindKey(row.kind))}</span>
                      <span role="cell" className={s.bytes}>
                        {row.bytes === null ? t('memory.unmeasured') : formatBytes(row.bytes)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className={s.section}>
              <h3 className={s.sectionLabel}>{t('memory.holders')}</h3>
              {data.holders.map(holder => (
                <div key={holder.id} className={s.holder} data-testid="memory-holder-row">
                  <div className={s.holderLine}>
                    <Tooltip content={holder.id}>
                      <span className={s.nameText}>{holder.label}</span>
                    </Tooltip>
                    <span className={s.holderReadout}>{holderReadout(t, holder)}</span>
                  </div>
                  {holderDetailText(holder) || holder.error ? (
                    <p className={s.meta}>{holder.error ?? holderDetailText(holder)}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function countText(t: TFn, count: number, unit: string): string {
  const key = holderUnitKey(unit)
  return key ? t(key, { count }) : `${count} ${unit}`
}

/** 「8 个会话 · 26.9 MB / 上限 8 个会话 · 64 MB」。 */
function holderReadout(t: TFn, holder: MemoryHolderReport): string {
  const now = [countText(t, holder.entries, holder.unit), holder.bytes === undefined ? undefined : formatBytes(holder.bytes)]
    .filter(Boolean).join(' · ')
  if (!holder.limit) return now
  const limit = [
    holder.limit.entries === undefined ? undefined : countText(t, holder.limit.entries, holder.unit),
    holder.limit.bytes === undefined ? undefined : formatBytes(holder.limit.bytes),
  ].filter(Boolean).join(' · ')
  return limit ? `${now} / ${t('memory.limit', { limit })}` : now
}

function trimLine(t: TFn, result: MemoryTrimReport): string {
  return t('memory.released', { count: result.releasedEntries, bytes: formatBytes(result.releasedBytes) })
}
