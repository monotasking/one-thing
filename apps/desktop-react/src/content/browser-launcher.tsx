import { useEffect } from 'react'
import { MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { t } from '../i18n'
import { useQuery } from '../data/kernel'
import {
  browserOps,
  browserTabsQuery,
  openBrowserTab,
  setBrowserTabAdopter,
} from '../data/browser-source'
import { browserSettingsQuery } from '../data/browser-settings-source'
import { profileDisplayName } from './settings/BrowserSettings'
import { findItem } from '../stage/items'
import { registerStageLauncher } from '../stage/launchers'
import { nextFloatId } from '../stage/placement'
import { useStageStore } from '../stage/store'
import { CENTER_REGION, edgeRegion, floatRegion } from '../workbench/regions'
import { refId } from '../workbench/kinds'
import { findLeaf, firstRefOfKindIn, locateRef } from '../workbench/tree'
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
export function placeBrowserTab(tabId: string, opts: { activate?: boolean } = {}): void {
  const ref = browserRef(tabId)
  const activate = opts.activate !== false
  // 响应链规则 2「打开什么,焦点进什么」。**后台开那一档不点名** —— 人没有要
  // 去那里(⌘-click 的意思就是「先开着」),抢焦点就是把它读反了。
  if (activate) requestBrowserFocus(tabId)
  useStageStore.getState().placeRef(ref, regionForLauncher(ref), activate ? {} : { activate: false })
}

/**
 * **屏幕上那一格 tab 坐在哪片叶的第几格**(哪棵树都问)。不在屏幕上 = `null`。
 *
 * 与 `BrowserLeaf.closeBrowserLeaf` 那一段是同一条遍历,而这里没有把它抽成
 * 一只公用函数:那一只要的是「把这片叶收掉」(拿 `leafId + index` 去 `closeTab`),
 * 这一只要的是「往它旁边插一格」——两个消费者、两种下一步,共用的只有一句
 * `locateRef`,而那已经是公用的了。
 */
function locateBrowserTab(tabId: string): { region: RegionId; leafId: string; index: number } | null {
  const regions = useWorkbenchStore.getState().regions
  const key = refId(browserRef(tabId))
  for (const [region, tree] of Object.entries(regions)) {
    const at = locateRef(tree, region as RegionId, key)
    if (at) return { region: region as RegionId, leafId: at.leafId, index: at.index }
  }
  return null
}

/**
 * **表里有、屏幕上没有的那几格**(2026-09-12)。
 *
 * 一格 tab 在账本里活着而拼贴树上没有它 —— 本单之前那是**一种常态**(页面自己
 * 开出来的每一格都长这样,用户账本里攒了 16 格,14 格 YouTube);本单之后它只
 * 剩两条正当来路:AI 开的后台 tab,以及人自己把叶关掉、却选择留着那一格。
 * 两条都是正当的,所以这不是一次自动清理,而是右键菜单上**一行看得见的动作**。
 *
 * 判据就是 `locateBrowserTab` 答 `null` ——「屏幕上有没有它」只有一个产地。
 */
export function offscreenBrowserTabs(ids: readonly string[]): string[] {
  return ids.filter((id) => locateBrowserTab(id) === null)
}

/** 逐格关掉。**一条一条走同一只 `close`**,没有第二条关法。 */
export function closeOffscreenBrowserTabs(ids: readonly string[]): Promise<void> {
  return Promise.all(ids.map((tabId) => browserOps.close.run({ tabId }))).then(() => {})
}

/**
 * **把一格 tab 摆到「开它的那一格」旁边**(2026-09-12)。
 *
 * 这是浏览器的形:一条 `target=_blank` 的链接开出来的那一格,长在**点它的那片叶
 * 的标签条上**,紧挨着它 —— 而不是另起一扇窗(那正是报障里「点新建开出来一个
 * 窗口」的那一格:`regionForLauncher` 读的是**瓦的位置记忆**,而一格新 tab 在
 * 记忆里永远没有自己的位置,于是每一格新 tab 都去要一扇新浮窗)。
 *
 * 开它的那一格不在屏幕上(人把它关了 / 从没摆过)才退回 `placeBrowserTab` 那条
 * 老路 —— 那时确实没有「旁边」可言。
 *
 * `background` = ⌘-click 那一档:摆出来,但**不换**人正看着的那一格、也不抢焦点。
 */
export function placeBrowserTabNear(openerId: string, tabId: string, background = false): void {
  const at = locateBrowserTab(openerId)
  if (!at) {
    /*
     * 开它的那一格不在屏幕上(人把它关了 / 从没摆过)—— 没有「旁边」可言,退回
     * 浏览器的常规落点。**后台那一档照样摆**:不摆的话这一格就是「表里活着、
     * 屏幕上没有它」,与本单治的病一模一样;它只是摆进去**不激活、不抢焦点**。
     */
    placeBrowserTab(tabId, background ? { activate: false } : {})
    return
  }
  // 响应链规则 2「打开什么,焦点进什么」——后台那一档人没有要去那里,所以不点名。
  if (!background) requestBrowserFocus(tabId)
  useWorkbenchStore.getState().moveRefIntoLeaf(browserRef(tabId), at.leafId, {
    at: at.index + 1,
    activate: !background,
  })
}

/*
 * **页面自己开出来的那一格由这里收养**(2026-09-12 真机报障;判词整段在
 * `data/browser-source.ts` 的 `BrowserTabAdopter` 上)。
 *
 * 落在这只文件里是因为它本来就是「一格浏览器 tab 该摆到哪」的唯一产地;`main.tsx`
 * 开机静态 import 它,所以这一句在第一格 tab 出生之前就填好了。
 */
setBrowserTabAdopter((spawn) => {
  placeBrowserTabNear(spawn.openerId, spawn.id, spawn.background)
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => setBrowserTabAdopter(null))
}

/**
 * **开一格新的并摆出来**。开不出来(后端拒绝 / 这台宿主没有浏览器)什么都不做 ——
 * 摆一片指着不存在的 tab 的叶,比不摆更糟。
 *
 * `near` = 「从这一格开出来的」(叶檐上那颗 +、⋯ 表里「以另一个身份打开此页」):
 * 新那一格落在它旁边,而不是去要一扇新窗。缺席 = 老路(记忆 > 天生 > 中央区)。
 */
export async function openBrowser(
  url?: string,
  init: { profile?: string; near?: string } = {},
): Promise<void> {
  /*
   * **先把叶那个 chunk 拉下来,再去开 tab**(两件事并发,等的是慢的那一件)——
   * 与 `terminal-launcher.openTerminal` 逐字同一条判例:叶是 `lazy` 进来的,
   * 不预拉的话下面那句送焦点会排在「这一拍提交的还是 Suspense 的 fallback」上,
   * 作用域实例根本还没登记,「送不进去不追」当场生效,人开了一格浏览器却不能打地址。
   */
  const [tabId] = await Promise.all([
    // 身份**缺席就是缺席**:回落成哪一格由后端现问设置(`service.open`),
    // 壳这边替它拍板等于同一句话两个产地(判词在 `resource-provider.payloadOf`)。
    openBrowserTab({ ...(url ? { url } : {}), ...(init.profile ? { profile: init.profile } : {}) }),
    import('./browser/BrowserLeaf'),
  ])
  if (!tabId) return
  if (init.near) {
    placeBrowserTabNear(init.near, tabId)
    return
  }
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
  // 名册(B3-b)。与 tab 表同一条纪律:只在菜单开着的那一段问一次。
  const settings = useQuery(browserSettingsQuery)
  // 菜单开着的这一段就是这条读数要新鲜的那一段 —— 一张只在右键那一下出现的菜单
  // 不值得让全壳挂一条订阅(与 terminal-launcher 逐字同一条)。
  useEffect(() => {
    void browserTabsQuery.ensure()
    void browserSettingsQuery.ensure()
  }, [])
  const rows = tabs.data?.tabs ?? []
  const profiles = settings.data?.profiles ?? []
  // 「表里有、屏幕上没有」的那几格(判词在 `offscreenBrowserTabs` 上)。
  const offscreen = offscreenBrowserTabs(rows.map((row) => row.id))
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
          {/*
            **关掉不在屏上的那几格**。0 格时这一行不画 —— 一行恒显的「关闭 0 个」
            是噪音,而且它会让人以为自己漏看了什么。
          */}
          {offscreen.length > 0 && (
            <MenuItem
              onClick={() => {
                void closeOffscreenBrowserTabs(offscreen)
                onDone()
              }}
            >
              {t('browser.closeOffscreen', { count: String(offscreen.length) })}
            </MenuItem>
          )}
          <MenuSeparator />
        </>
      )}
      {/*
        **「新标签页」按身份展开**(B3-b)。名册只有一格时就是从前那一行 ——
        一台只有一个身份的机器上「新标签页(默认)」是一句废话,而且它会把
        这张表从两行撑成三行。多于一格时每个身份一行,身份的名字进行里:
        「新标签页(「工作」)」读起来是一句完整的话,不是一列孤零零的名字。
      */}
      {profiles.length > 1 ? (
        <>
          <MenuSection>{t('browser.profileSection')}</MenuSection>
          {profiles.map((profile) => (
            <MenuItem
              key={profile.id}
              onClick={() => {
                void openBrowser(undefined, { profile: profile.id })
                onDone()
              }}
            >
              {t('browser.newTabInProfile', { name: profileDisplayName(profile, t) })}
            </MenuItem>
          ))}
        </>
      ) : (
        <MenuItem
          onClick={() => {
            void openBrowser()
            onDone()
          }}
        >
          {t('browser.newTab')}
        </MenuItem>
      )}
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
