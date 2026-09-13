import { Suspense, lazy } from 'react'
import { registerContentKind } from '../../workbench/kinds'
import { t } from '../../i18n'
import { browserOps, browserTabOf } from '../../data/browser-source'
import { BROWSER_KIND, browserRef } from '../browser/browser-ref'
import { requestBrowserFocus } from '../browser/focus-request'
import type { ContentRef } from '../../workbench/kinds'

/**
 * **「一格浏览器 tab」这一种内容**(B2,方案 §2.2-4)。
 *
 * `key` = tab id(于是 `refId` 拼出来就是 `browser:<tabId>` —— 拼贴树上的地址与
 * 资源地址逐字相同,判词在 `content/browser/browser-ref.ts` 上)。
 *
 * `singleton: true` —— 同一格 tab 在屏幕上只该有一份:它背后是**一片**原生视图,
 * 而一片视图只能在一个矩形里。两片占位格各报各的帧,主进程会被两套坐标来回拽,
 * 屏幕上看到的是一格视图在两处之间闪。(与「同一份文件开两棵树对照着看」不是
 * 一回事:文件是只读的,一格 tab 是一台活着的浏览器。)
 *
 * `level: 'app'` —— **浏览器不属于任何一个工作区**。终端开在项目目录里,所以它是
 * `space`;一格网页与「你此刻在做哪个项目」无关,切工作区不该让它消失。方案
 * §6「缺省不问」那一行写的就是这一格。
 *
 * ── 活标题:页标题 → 主机名 ────────────────────────────────────────────
 * 合它的是 `BrowserLeaf.browserTabTitle`,发布它的是那片叶(经 `stage/live-title`),
 * 而叶檐「活的盖静的」。**这里两条都答**:静的那一句是字典里的「浏览器」(实例
 * 还没渲染过时先写它),活的那一半在这里也读得到 —— `browser.tabs` 是一条**整表**
 * 读数,所以不必等叶挂载就答得出这一格的标题。两处同一只函数,不是两份判据。
 *
 * ── 关标签 = 关这格 tab(不弹确认)────────────────────────────────────
 * 落点是 `dispose(ref)` 而不是 `beforeClose`:`beforeClose` 是**问一句**(脏文件
 * 那一档),而这里没有要问的。与终端那一格逐字同一条判例。关掉之后视图随之销毁,
 * 主进程发 `closed`,表自己会少一行。
 *
 * ── 叶是**懒加载**的 ─────────────────────────────────────────────────────
 * 与终端同一个理由,只是主语不同:`BrowserLeaf` 拖着 `NativeViewSlot`,而那只
 * 组件在挂载时就要 `ResizeObserver` + 一条 IPC。这张种类表被 `main.tsx` 与一大票
 * 渲染类测试静态 import,静态挂着那条边 = 每个这样的测试都把占位格那套机器拉进来。
 * `fallback` 是 `null` 而不是骨架 —— 那一瞬要出现的是一页网页,而网页本来就是从
 * 一块空白开始的。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * 全部由 `BrowserLeaf` 与 `NativeViewSlot` 各自的组件头说。这一层没有任何自己的
 * 状态:tab 的真源在主进程,壳这边只有 `browser.tabs` 一条读数。
 */

const BrowserLeaf = lazy(() =>
  import('../browser/BrowserLeaf').then((m) => ({ default: m.BrowserLeaf })),
)

/** 活标题三档的**同一只函数**(叶那一侧也调它)。静态那一句在下面兜底。 */
function titleOf(ref: ContentRef): { text: string; tip?: string } {
  const row = browserTabOf(ref.key)
  const live = row?.title || (row?.url ? hostnameOf(row.url) : '')
  return live ? { text: live, tip: row?.url } : { text: t('item.browser') }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

registerContentKind(
  {
    id: BROWSER_KIND,
    singleton: true,
    level: 'app',
    title: titleOf,
    icon: () => 'Globe',
    render: (ref) => (
      <Suspense fallback={null}>
        <BrowserLeaf id={ref.key} />
      </Suspense>
    ),
    /*
     * **激活这一格 = 键盘进那片网页**(与 `terminal` / `dir` 同一条自述)。不声明的话
     * `focusIntoRef` 只能退回 `leaf` 那一层,而那是 `passThrough` —— 于是「开一格
     * 浏览器,按 ⌘L 打地址」第一下就落空。
     */
    focusInto: 'browser',
    fullable: true,
    /*
     * **同类再开一格 = 再开一格空白页**(K2,⌘T / ⌘N / 叶檐那颗 `+` 共用)。
     *
     * 身份跟着**开它的那一格**走:在「工作」身份那一页上按 ⌘T,新那一格也该是
     * 「工作」—— 而不是回落成缺省身份(那会让人在两个身份之间无声地漂)。
     * 表里读不到这一格(刚开、表还没回来)就**不给** `profile`,由后端现问设置,
     * 与 `resource-provider.payloadOf` 那条「壳这边不替它拍板」逐字相同。
     *
     * **只创建不摆放**,焦点在这儿点名(条子由那一格挂载时自己取走 —— 判词整段
     * 在 `content/browser/focus-request.ts` 上)。创建那一半复用启动瓦拆出来的
     * `createBrowserTab`,**动态** import 是为了不让这张种类表(被 `main.tsx` 与
     * 一大票渲染类测试静态 import)拖上启动瓦那整条边。
     */
    spawn: async (ref) => {
      const { createBrowserTab } = await import('../browser-launcher')
      const profile = browserTabOf(ref.key)?.profile
      const tabId = await createBrowserTab(profile ? { profile } : {})
      if (!tabId) return null
      requestBrowserFocus(tabId)
      return browserRef(tabId)
    },
    /*
     * **关一格 tab 是删一行,那个 tabId 从此不存在** —— 所以这一种是全表唯一
     * 需要自述快照的:留的影是 `{ url, profile }`,⌘⇧T 按 url 再开一格。
     * (方案 §7 留账「浏览器关闭的 tab 没有历史」补的正是这一格,不另起机制。)
     */
    snapshot: (ref) => {
      const row = browserTabOf(ref.key)
      return { url: row?.url ?? '', profile: row?.profile }
    },
    restore: async (snapshot) => {
      const shot = snapshot as { url?: unknown; profile?: unknown } | null
      const url = typeof shot?.url === 'string' ? shot.url : ''
      // 空 url 重开不出东西 —— 一格指着空白的「重开」比不响更糟(它占着栈顶)。
      if (!url) return null
      const { createBrowserTab } = await import('../browser-launcher')
      const profile = typeof shot?.profile === 'string' ? shot.profile : undefined
      const tabId = await createBrowserTab({ url, ...(profile ? { profile } : {}) })
      if (!tabId) return null
      requestBrowserFocus(tabId)
      return browserRef(tabId)
    },
    dispose: (ref) => {
      void browserOps.close.run({ tabId: ref.key })
    },
  },
  import.meta.hot,
)
