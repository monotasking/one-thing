/**
 * 内置浏览器在内存预算表上的那一行(2026-09-25,用户真机报表:1715MB 里内置浏览器
 * 五个进程占了约 550MB)。
 *
 * 每一格建了视图的 tab 就是一个渲染进程(外加它页里跨站 iframe 的进程)。这一行
 * 松手的办法是**后台释放**:关掉那一格的进程,tab 留着,切回去时重新加载
 * (`BrowserTab.hibernate` / `BrowserService.hibernate`)。
 *
 * 三条判据,少一条都不释放:
 *  ① **壳说它看不见**,而且看不见得够久 —— soft 档 10 分钟、hard 档 1 分钟
 *     (被遮的那一格不算看不见:屏幕上画着它的快照,人还在看);
 *  ② **不在出声** —— 后台放着的视频 / 音乐,释放掉等于替人按了停;
 *  ③ 有视图(没视图的那一格本来就不占进程)。
 *
 * 零 electron import:service 与 layout 都是注入的,所以它在 vitest 下能跑。
 */
import type { MemoryHolder, MemoryPressure } from '@onething/core/memory'

export const BROWSER_HIBERNATE_AFTER_MS: Readonly<Record<MemoryPressure, number>> = {
  soft: 10 * 60_000,
  hard: 60_000,
}

/** 这一行读得到的 tab 那一片。 */
export interface HibernatableTab {
  readonly id: string
  readonly materialized: boolean
  readonly audible: boolean
  readonly hibernationCount: number
}

export interface BrowserMemoryDeps {
  tabs(): readonly HibernatableTab[]
  /** 壳说「看不见」多久了;看得见 / 没登记 = `undefined`。 */
  hiddenForMs(tabId: string): number | undefined
  hibernate(tabId: string): boolean
}

export function createBrowserMemoryHolder(deps: BrowserMemoryDeps): MemoryHolder {
  return {
    id: 'browser.tabs',
    label: '内置浏览器的标签页(每格一个渲染进程)',
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
