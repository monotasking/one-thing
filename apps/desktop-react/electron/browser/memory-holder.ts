/**
 * 内置浏览器标签页的内存持有者。
 *
 * 每个已创建视图的标签页占用一个渲染进程(页面中的跨站 iframe 另占进程)。释放方式是
 * 关闭标签页的渲染进程并保留标签页,切回时重新加载(`BrowserService.hibernate`)。
 *
 * 同时满足以下条件才释放:
 *  1. 标签页不可见的时间足够长:soft 10 分钟,hard 1 分钟(被遮挡时仍显示快照,算作可见);
 *  2. 没有在播放声音;
 *  3. 已创建视图。
 */
import type { MemoryHolder } from '@onething/backend/memory'
import type { MemoryPressure } from '@shared/memory/types'

export const BROWSER_HIBERNATE_AFTER_MS: Readonly<Record<MemoryPressure, number>> = {
  soft: 10 * 60_000,
  hard: 60_000,
}

/** 所需的标签页信息。 */
export interface HibernatableTab {
  readonly id: string
  readonly materialized: boolean
  readonly audible: boolean
  readonly hibernationCount: number
}

export interface BrowserMemoryDeps {
  tabs(): readonly HibernatableTab[]
  /** 不可见的时长;可见或未注册时为 `undefined`。 */
  hiddenForMs(tabId: string): number | undefined
  hibernate(tabId: string): boolean
}

export function createBrowserMemoryHolder(deps: BrowserMemoryDeps): MemoryHolder {
  return {
    id: 'browser.tabs',
    label: '内置浏览器网页',
    usage() {
      const tabs = deps.tabs()
      const live = tabs.filter(tab => tab.materialized)
      return {
        entries: live.length,
        unit: 'views',
        detail: {
          tabs: tabs.length,
          hidden: live.filter(tab => deps.hiddenForMs(tab.id) !== undefined).length,
          audible: live.filter(tab => tab.audible).length,
          hibernated: tabs.reduce((sum, tab) => sum + tab.hibernationCount, 0),
        },
      }
    },
    trim(pressure) {
      const threshold = BROWSER_HIBERNATE_AFTER_MS[pressure]
      let released = 0
      for (const tab of deps.tabs()) {
        if (!tab.materialized || tab.audible) continue
        const hidden = deps.hiddenForMs(tab.id)
        if (hidden === undefined || hidden < threshold) continue
        if (deps.hibernate(tab.id)) released++
      }
      return { releasedEntries: released }
    },
  }
}

export interface BrowserMemoryGovernorOptions {
  /** 预算(`@shared/memory/budget` 那把尺子,与后端判自己进程用的是同一把)。 */
  readonly budget: { readonly softBytes: number; readonly hardBytes: number }
  /** Electron 这几个进程此刻一共占多少字节(生产里是 `app.getAppMetrics()` 的工作集之和)。 */
  sampleBytes(): number
  /** 采样周期。缺省 30s,与后端的调度器同一个拍子。 */
  readonly intervalMs?: number
  /** 真的释放了几格就说一声(只为日志)。 */
  onTrim?(pressure: MemoryPressure, releasedEntries: number): void
  onError?(error: unknown): void
}

/**
 * **这几格标签页的内存由 Electron 自己判**(第④步批 2b)。
 *
 * 从前这只持有者登记进后端的内存登记表,压力由后端的调度器判 —— 那时后端与这些标签页在同一个进程树里,
 * 而且 Electron 另外报一份进程探针,后端看得见渲染 / GPU / 浏览器进程。批 2b 起后端是另一个进程,
 * 它量的是它自己;这几格标签页的渲染进程在 Electron 这边。所以压力在这里判:每 `intervalMs` 采一次
 * Electron 全部进程的工作集,过了软线按 `soft` 释放、过了硬线按 `hard` 释放(释放条件在持有者里)。
 * 返回停掉采样的那一手(幂等)。
 */
export function startBrowserMemoryGovernor(holder: MemoryHolder, options: BrowserMemoryGovernorOptions): () => void {
  const tick = (): void => {
    try {
      const bytes = options.sampleBytes()
      const pressure: MemoryPressure | undefined = bytes >= options.budget.hardBytes
        ? 'hard'
        : bytes >= options.budget.softBytes ? 'soft' : undefined
      if (!pressure || !holder.trim) return
      void Promise.resolve(holder.trim(pressure)).then(result => {
        if (result.releasedEntries > 0) options.onTrim?.(pressure, result.releasedEntries)
      }, error => { options.onError?.(error) })
    } catch (error) {
      options.onError?.(error)
    }
  }
  const timer = setInterval(tick, options.intervalMs ?? 30_000)
  timer.unref?.()
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
}
