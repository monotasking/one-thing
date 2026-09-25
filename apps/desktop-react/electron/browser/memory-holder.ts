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
import type { MemoryHolder, MemoryPressure } from '@onething/core/memory'

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
