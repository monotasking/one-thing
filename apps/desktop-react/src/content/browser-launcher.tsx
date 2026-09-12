import { useEffect } from 'react'
import { MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { t } from '../i18n'
import { useQuery } from '../data/kernel'
import { browserOps, browserTabsQuery, openBrowserTab } from '../data/browser-source'
import { findItem } from '../stage/items'
import { registerStageLauncher } from '../stage/launchers'
import { nextFloatId } from '../stage/placement'
import { useStageStore } from '../stage/store'
import { CENTER_REGION, edgeRegion, floatRegion } from '../workbench/regions'
import { refId } from '../workbench/kinds'
import { findLeaf, firstRefOfKindIn } from '../workbench/tree'
import { regionOfLeafIn, regionOfRefIn, useWorkbenchStore } from '../workbench/store'
import { focusTree } from '../focus/registry'
import { BROWSER_KIND, browserRef } from './browser/browser-ref'
import { requestBrowserFocus } from './browser/focus-request'
import type { PlacementMemory } from '../stage/types'
import type { ContentRef } from '../workbench/kinds'
import type { RegionId } from '../workbench/regions'

/**
 * **Dock 上那块「浏览器」瓦降格成启动瓦**(B2,方案 §2.2-4;照 `terminal-launcher`
 * 与 `files-launcher` 的形)。
 *
 * 从前它是「一块面」(`panel:browser` → 一份 14 行的假地址栏)。浏览器不是一块面,
 * 它是**一族**:一格 tab 一份 `browser:<id>`。所以那块瓦要做的事变成了「开哪一格」:
 *  · 点它    = 有开着的就把**最近那一格**召唤出来,一格都没有就开一格空白页
 *              (地址栏自己拿焦点);
 *  · 右键    = 开着的那几格各一行(点 = 激活)+「新标签页」;
 *  · 拖它    = 拖出屏幕上那一格活动 tab。
 *
 * 它不是 Dock 里的一句 `if` —— 判词整段在 `stage/launchers.ts` 的文件头上
 * (「瓦自述,Dock 读表」)。
 *
 * ── 落点:记忆 > 天生,天生 = **中央区** ────────────────────────────────
 * 与 `terminal-launcher.regionForLauncher` 是同一只的两份实例(它读 `terminal` 那
 * 一格记忆,这只读 `browser`)。天生那一档写在 `stage/items.ts` 的
 * `defaultPlacement`:浏览器出厂落**中央** —— 一页网页要的地与一段对话要的地一样
 * 大,塞进底架只能看见三行。用户自己摆过的算数(记忆压过它)。
 *
 * ── 「点它」为什么是**召唤**而不是「开新的」 ──────────────────────────
 * 与终端刚好相反,而那不是不一致:一格终端是一台**独立的 shell**(人要第二台就是
 * 要第二台),一格浏览器是**一扇窗**(人按 Dock 上那枚地球,想的是「把浏览器拿出来」,
 * 不是「再开一个空标签」)。所以这里先问 `summonRef` 四态,召唤不着才开新的。
 */

/** 「浏览器」那块启动瓦的 id(它就是从前那块「浏览器」面板瓦 —— id 不改)。 */
export const BROWSER_ITEM_ID = 'browser'

/** 这块瓦此刻该把内容开到哪个区域。**记忆 > 天生**(见文件头)。 */
function regionForLauncher(ref: ContentRef): RegionId {
  const stage = useStageStore.getState()
  const memory: PlacementMemory | undefined = stage.memory[BROWSER_ITEM_ID]
  const wanted = memory ?? findItem(BROWSER_ITEM_ID)?.defaultPlacement
  if (wanted?.kind === 'edge') return edgeRegion(wanted.side)
  if (wanted?.kind === 'float') {
    // 同一格内容已经有一扇自己的窗就交回那一扇(与 files/terminal 同一句)。
    const already = regionOfRefIn(useWorkbenchStore.getState().regions, refId(ref))
    if (already?.startsWith('float:')) return already
    const winId = nextFloatId()
    useStageStore.getState().ensureFloatRect(winId)
    return floatRegion(winId)
  }
  return CENTER_REGION
}

/** 屏幕上此刻那一格浏览器(焦点叶优先,否则读序第一格)。判词同 terminal-launcher。 */
export function visibleBrowserRef(): ContentRef | null {
  const workbench = useWorkbenchStore.getState()
  const focusRegion = workbench.focusLeafId
    ? regionOfLeafIn(workbench.regions, workbench.focusLeafId)
    : null
  const tree = focusRegion ? workbench.regions[focusRegion] : undefined
  const leaf = tree && workbench.focusLeafId ? findLeaf(tree, workbench.focusLeafId) : null
  const active = leaf?.tabs[leaf.active]
  if (active && active.kind === BROWSER_KIND) return active
  return firstRefOfKindIn(workbench.regions, BROWSER_KIND)
}

/**
 * **把一格 tab 摆到屏幕上并把焦点送进去**(点瓦、右键点名、地址栏那颗 + 三处共用)。
 *
 * **次序即语义:先点名,再摆**(与终端逐字同一条)。那一格挂载时自己把条子取走 ——
 * 判词整段在 `content/browser/focus-request.ts` 上,含真机病历:在外面
 * `activateScopeAfterCommit` 够不着那一拍(叶还在 `lazy` + 一次提交之外),门里量到
 * 的是焦点仍然停在输入面板上。
 *
 * 这一句**不能省**:`stage/focus-follow` 那条跟焦链判的是 `placements[瓦 id]` 的
 * 前后差,而启动瓦开出来的是一格**内容**(`browser:<id>`),那张表上一个字都没动。
 */
export function placeBrowserTab(tabId: string): void {
  const ref = browserRef(tabId)
  // 响应链规则 2「打开什么,焦点进什么」。
  requestBrowserFocus(tabId)
  useStageStore.getState().placeRef(ref, regionForLauncher(ref))
}

/**
 * **开一格新的并摆出来**。开不出来(后端拒绝 / 这台宿主没有浏览器)什么都不做 ——
 * 摆一片指着不存在的 tab 的叶,比不摆更糟。
 */
export async function openBrowser(url?: string): Promise<void> {
  /*
   * **先把叶那个 chunk 拉下来,再去开 tab**(两件事并发,等的是慢的那一件)——
   * 与 `terminal-launcher.openTerminal` 逐字同一条判例:叶是 `lazy` 进来的,
   * 不预拉的话下面那句送焦点会排在「这一拍提交的还是 Suspense 的 fallback」上,
   * 作用域实例根本还没登记,「送不进去不追」当场生效,人开了一格浏览器却不能打地址。
   */
  const [tabId] = await Promise.all([
    openBrowserTab(url ? { url } : {}),
    import('./browser/BrowserLeaf'),
  ])
  if (!tabId) return
  placeBrowserTab(tabId)
}

/** 点那块瓦:先召唤,召唤不着才开新的(判词在文件头)。 */
export async function summonBrowser(): Promise<void> {
  await browserTabsQuery.ensure()
  const table = browserTabsQuery.get().data
  const wanted = table?.activeId ?? table?.tabs[table.tabs.length - 1]?.id
  if (!wanted) {
    await openBrowser()
    return
  }
  const ref = browserRef(wanted)
  // 已经在屏幕上就走四态(展开架子 / 点名 tab / 送焦点),不在就摆出来 ——
  // 与 `stage/open-item` 那条判例同源。
  if (useStageStore.getState().summonRef(ref) === null) placeBrowserTab(wanted)
  else focusTree.activateScope('browser', { owner: refId(ref), reason: 'open' })
}

/** 开着的那几格 + 新建一条。 */
function BrowserLauncherMenuRows({ onDone }: { onDone: () => void }) {
  const tabs = useQuery(browserTabsQuery)
  // 菜单开着的这一段就是这条读数要新鲜的那一段 —— 一张只在右键那一下出现的菜单
  // 不值得让全壳挂一条订阅(与 terminal-launcher 逐字同一条)。
  useEffect(() => {
    void browserTabsQuery.ensure()
  }, [])
  const rows = tabs.data?.tabs ?? []
  return (
    <>
      {rows.length > 0 && (
        <>
          <MenuSection>{t('browser.openTabsSection')}</MenuSection>
          {rows.map((row) => (
            <MenuItem
              key={row.id}
              onClick={() => {
                const ref = browserRef(row.id)
                if (useStageStore.getState().summonRef(ref) === null) placeBrowserTab(row.id)
                else focusTree.activateScope('browser', { owner: refId(ref), reason: 'open' })
                // 「切到这一格」是浏览器自己的事实,所以照样经资源路说一声 ——
                // 主进程那边的活动 tab 与屏幕上被召唤的那一格要是同一格。
                void browserOps.activate.run({ tabId: row.id })
                onDone()
              }}
            >
              {row.title || row.url || t('browser.newTab')}
            </MenuItem>
          ))}
          <MenuSeparator />
        </>
      )}
      <MenuItem
        onClick={() => {
          void openBrowser()
          onDone()
        }}
      >
        {t('browser.newTab')}
      </MenuItem>
    </>
  )
}

registerStageLauncher(
  BROWSER_ITEM_ID,
  {
    open: () => void summonBrowser(),
    dragRef: visibleBrowserRef,
    /*
     * `dragRef()` 答 null 时的退一步(W7-c 裁定 6):屏幕上有没有**同类**的一格开着。
     */
    residentKind: BROWSER_KIND,
    MenuRows: BrowserLauncherMenuRows,
  },
  import.meta.hot,
)
