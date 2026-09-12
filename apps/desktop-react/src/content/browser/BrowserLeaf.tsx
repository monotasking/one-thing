import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Ellipsis, Plus, RotateCw, X } from '../../components/icons'
import { FocusScope } from '../../focus/FocusScope'
import { focusTree } from '../../focus/registry'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { useT } from '../../i18n'
import { useLiveTitleStore } from '../../stage/live-title'
import { refId } from '../../workbench/kinds'
import { locateRef } from '../../workbench/tree'
import { useWorkbenchStore } from '../../workbench/store'
import { Button } from '../../ui/Button'
import { useQuery } from '../../data/kernel'
import { nativeViewBridge } from '../../data/browser-port'
import {
  browserOps,
  browserTabsQuery,
  useBrowserLive,
  type BrowserTabRow,
} from '../../data/browser-source'
import { resolveBrowserOmniboxInput, resolveBrowserSearchEngine } from '../../browser/omnibox'
import { browserSettingsQuery } from '../../data/browser-settings-source'
import { profileDisplayName } from '../settings/BrowserSettings'
import { Tooltip } from '../../ui/Tooltip'
import { closeBrowserFind, openBrowserFind, useBrowserFind } from '../../data/browser-find'
import { useBrowserNotices } from '../../data/browser-notices'
import { NativeViewSlot } from '../native-view/NativeViewSlot'
import { WebPermissionCard } from '../permission/WebPermissionCard'
import { BrowserActionsMenu } from './BrowserActionsMenu'
import { BrowserDownloadRow } from './BrowserDownloadRow'
import { BrowserFindBar } from './BrowserFindBar'
import { BrowserStartPage } from './BrowserStartPage'
import { browserRef } from './browser-ref'
import { takeBrowserFocusRequest } from './focus-request'
import s from './BrowserLeaf.module.css'

/**
 * **一格内嵌浏览器**(B2,方案 §2.2-4)。
 *
 * 它是**壳**:地址栏、四颗钮、一条加载线,加上一块把原生视图让出去的地
 * (`NativeViewSlot`)。真正画网页的是主进程里那片 `WebContentsView`,状态的真源
 * 也在那儿 —— 这只组件里**没有一格 url / title / loading 的本地 state**,
 * 它们全都读 `browser.tabs` 那一条读数(唯一的例外是地址栏的草稿,见下)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ① 生命周期(这一格内容的寿命)—— 表在 `data/browser-source.ts` 头上;
 *    这里只补「一片叶」这一层:挂载 = `useBrowserLive()` 引用计数加一;
 *    换宿主(拖去别的叶 / 撕成浮窗)= 拼贴树结构共享,**不重挂、视图不重载**;
 *    卸载 = 计数减一,**不关 tab**(关 tab 是 `kind.dispose` 那条显式的路)。
 * ══════════════════════════════════════════════════════════════════════════
 * ② UI 生命状态
 * ══════════════════════════════════════════════════════════════════════════
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | 此宿主没有浏览器 | `nativeViewBridge()` 缺席(`--mode web`) | 一句话:「此宿主没有内嵌浏览器;页开在桌面里」。**不画地址栏** —— 一条按不动的地址栏比没有更糟(方案 §9-12) |
 * | 还不知道 | `tabs` 读数还没到(`data === undefined`) | 地址栏画着、钮全禁用、不转圈。**不清屏、不画骨架** |
 * | 正常 | 表里有这一格 | 地址栏 = 它的 url;四颗钮按 `canGoBack/canGoForward/loading` 分档 |
 * | 加载中 | `row.loading` | 顶上那条 1px 描线在走;刷新钮变成停止钮 |
 * | 出错 | `row.error` | 地址栏下面一行原话(**后端那句,不发明文案**) |
 * | 找不到 | 表到了、里面没有这一格(账本坏 / 别人关掉了) | 「这一页找不到了」+ 一颗「关掉」 |
 *
 * **B3-a 加的三条檐与上面五档正交**(哪一档都可能同时挂着它们),每一条自己那
 * 张状态表在它自己的组件 / 数据层文件头上,这里只说落点与次序:
 * 查找行(`BrowserFindBar`,贴着导航檐)→ 错话 → 权限卡(`WebPermissionCard`,
 * **只画队头**)→ 下载读数(`BrowserDownloadRow`,**只画最近变动的那一条**)→
 * 占位格。四件都是 `flex: none`,所以它们一出现,那片原生视图的矩形就跟着缩 ——
 * **不是盖上去**:盖上去要走遮挡快照那条路(原生视图永远压在 DOM 之上),而那
 * 会让一张等着人答的卡显示成一张静止的截图。
 * ══════════════════════════════════════════════════════════════════════════
 * ③ 交互状态
 * ══════════════════════════════════════════════════════════════════════════
 * | 交互 | 结果 |
 * | --- | --- |
 * | 地址栏打字 | 只改草稿。**不发请求** |
 * | 回车 | `resolveBrowserOmniboxInput` 折成一个 URL(像地址就当地址,像话就去搜)→ `do navigate` |
 * | Esc(在地址栏里) | 草稿退回真地址,焦点回页面。这是**元素级**的一下,不进退层链 |
 * | ⌘L | 地址栏聚焦并全选(面域局部键,同时是推给主进程的保留键) |
 * | ⌘F | 开查找行并把光标送进去;**已经开着就是「回到输入框并全选」**。与 ⌘L 并列,同样是保留键 —— 页面有焦点时按它,开的是壳这一行而不是页面自己的查找条 |
 * | 失焦 | 草稿退回真地址 —— 半截地址留在栏里会让人以为页面在那儿 |
 * | 四颗钮 | 各自一只 mutation,**逐格 pending**(律③):按了刷新,后退照常能点 |
 *
 * ── 地址栏那一格草稿为什么可以是本地 state ─────────────────────────────
 * 它不是「这一格 tab 的地址」(那是读数),它是「**这个人正在打的那一句**」——
 * 一份没有产地的、只属于这一次输入的东西。判据与全壳其它输入框逐字相同:
 * 人在打字的时候后端推来的新 url 不许把他打了一半的字冲掉,所以**聚焦期间不跟**。
 */

/** 地址栏里此刻该显示什么:人在打字就显示他打的,没在打就显示真地址。 */
function useOmniboxDraft(row: BrowserTabRow | undefined): {
  value: string
  setValue: (next: string) => void
  begin: () => void
  end: () => void
} {
  const [draft, setDraft] = useState<string | null>(null)
  const url = row?.url ?? ''
  return {
    value: draft ?? url,
    setValue: setDraft,
    begin: () => setDraft((now) => (now === null ? url : now)),
    end: () => setDraft(null),
  }
}

export function BrowserLeaf({ id }: { id: string }) {
  const t = useT()
  useBrowserLive()
  const tabs = useQuery(browserTabsQuery)
  const row = tabs.data?.tabs.find((tab) => tab.id === id)
  /*
   * 查找行与檐下那两件临时的东西(B3-a)。**三格都不是这只组件的 state** ——
   * 它们按 tabId 住在 `data/browser-find.ts` / `data/browser-notices.ts` 里,
   * 寿命是那片视图而不是这次挂载(判词各在那两只文件头上)。
   */
  const find = useBrowserFind(id)
  const notices = useBrowserNotices(id)
  const slotRef = useRef<HTMLDivElement | null>(null)
  /*
   * 动作菜单开在哪一点(null = 没开)。**留在本地 state**,而不是像叶檐那张
   * 动作表那样搬进一格 store —— 判据是「有没有第二个够不着彼此的开口」
   * (`workbench/leaf-menu.ts` 那一段判词):这里两个开口(檐右端那颗 ⋯ 与
   * 右键这条檐)都在**这一只组件**里,setState 够得着。
   */
  const [actionsAt, setActionsAt] = useState<{ x: number; y: number } | null>(null)
  /*
   * 身份名册(B3-b)。叶上只用它两件事:那枚身份丸的名字,以及「多于一格时才画」。
   * `ensure()` 幂等,所以每片叶各调一次也只发一发。
   */
  const profiles = useQuery(browserSettingsQuery)
  useEffect(() => {
    void browserSettingsQuery.ensure()
  }, [])
  /*
   * 地址栏那个 `<input>` 从**檐上现取**,而不是给 `ui/Input` 递一个 ref。
   *
   * `ui/Input` 今天不收 ref(`IconButton` 收,它是另一件),而为了这一处给一件
   * 基础件加一格口子,代价是所有消费者的类型面 —— 那不是这一单该做的事。檐上
   * 只有一个 `<input>`(四颗钮是 `<button>`),所以这一问是确定的;它也正是
   * `restingTarget` 那类「进这块面焦点落哪」的写法:问 DOM,不存第二份引用。
   */
  const barRef = useRef<HTMLDivElement | null>(null)
  const addressInput = (): HTMLInputElement | null =>
    barRef.current?.querySelector('input') ?? null
  /*
   * **这一格是不是人亲手开出来的**(一次性;判词在 `focus-request.ts` 上)。
   * 在渲染期取一次并记住 —— 放进 effect 会晚一拍,而 `activateOnMount` 要的正是
   * 「第一次挂载那一拍」。
   */
  const openedByUser = useRef<boolean | undefined>(undefined)
  if (openedByUser.current === undefined) openedByUser.current = takeBrowserFocusRequest(id)
  const draft = useOmniboxDraft(row)
  const setLiveTitle = useLiveTitleStore((st) => st.setLiveTitle)
  const bridge = nativeViewBridge()

  /* 活标题 = 页标题 → 主机名(合它的判据在 `content/kinds/browser.tsx` 上,
   * 这里只把算出来的那一句发布上去;叶檐「活的盖静的」)。 */
  useEffect(() => {
    const key = refId(browserRef(id))
    const title = browserTabTitle(row)
    if (title) setLiveTitle(key, { text: title, tip: row?.url || undefined })
    return () => setLiveTitle(key, null)
  }, [id, row, setLiveTitle])

  /*
   * **焦点进这一格,要排在这次提交的 layout 阶段之后**(真机病历,B2 的 ② 卡了三轮)。
   *
   * `FocusScope` 的 `activateOnMount` 跑在**layout** effect 里,而把一格 tab 摆进
   * **已经有人的**那片叶,同一次提交里还有另一件 layout 的事:原来那一格 tab 的层
   * 翻成 `inert` → 树 `settle()` → 焦点按归还规则**回落**。layout effect 子先于父、
   * 按树序跑,于是次序是「我先入焦 → 它再把焦点归还回输入面板」,门里量到的现场是
   * `{"focused":"composer","reason":"restore"}` —— 不是竞速,是确定地输。
   *
   * 所以这一句走**被动** effect:整次提交的 layout 阶段(含那次 settle)全部跑完
   * 之后才轮到它。终端那一格没踩到是因为它落的是**新开的一片叶**(底架),同一次
   * 提交里没有谁的 tab 被翻成 inert。
   *
   * 「送不进去不追」照旧:`activateScope` 答 false 就算了(那一格可能正好被别人顶掉)。
   */
  useEffect(() => {
    if (!openedByUser.current) return
    focusTree.activateScope('browser', { owner: refId(browserRef(id)), reason: 'open' })
  }, [id])

  /*
   * ui-consume-allow: focus-outside-focus — 这三处 `.focus()` 全部是**作用域内部**
   * 的移动(地址栏 ↔ 占位格,两者都在 `browser` 这一格里),不跨作用域。判例与
   * `ui/a11y/roving` / `ui/inline-edit` 那三只被允许的文件逐字同一条:I3 禁的是
   * 「跨作用域搬焦点」(那条路是 `activateScope()`),而「这块面里键盘从这件走到
   * 那件」是这块面自己的形态语法 —— 地址栏与那片网页之间来回,正是浏览器的形。
   */
  const focusAddress = useCallback(() => {
    const el = addressInput()
    if (!el) return
    // ui-consume-allow: focus-outside-focus — 作用域内部的移动(判词见上一段)
    el.focus()
    el.select()
  }, [])

  /*
   * ── ⌘F 的落点 ──────────────────────────────────────────────────────────
   *
   * **开着的时候再按一下 = 把光标送回输入框并全选**(与浏览器、编辑器一族的
   * 手感一致:第二下不是「关掉」,是「重来一次」)。
   *
   * 「点名 + 挂载时取走」而不是 rAF —— 判词整段在 `TerminalLeaf` 的 `openFind`
   * 上(T2 的真机病历:开的那一拍输入框还没挂上来,rAF 与 React 的提交之间没有
   * 先后保证,焦点送不进去,后面那一串字进了别人那里)。ref 回调跑在提交阶段,
   * 挂载一定排在点名之后,所以它没有窗口可言。
   */
  const findFocusWanted = useRef(false)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const mountFindInput = useCallback((el: HTMLInputElement | null) => {
    findInputRef.current = el
    if (!el || !findFocusWanted.current) return
    findFocusWanted.current = false
    /*
     * ui-consume-allow: focus-outside-focus — 作用域**内部**的移动:焦点已经在
     * `browser` 这一格上,这一句只是把它从占位格 / 地址栏交给查找行那只输入框。
     * 判词与这只文件上面 `focusAddress` 那一段逐字相同。
     */
    el.focus()
    el.select()
  }, [])

  const openFind = useCallback(() => {
    openBrowserFind(id)
    const input = findInputRef.current
    if (input) {
      /* ui-consume-allow: focus-outside-focus — 同上:作用域内部的移动。 */
      input.focus()
      input.select()
      return
    }
    findFocusWanted.current = true
  }, [id])

  const closeFind = useCallback(() => {
    closeBrowserFind(id)
    findFocusWanted.current = false
    // 键盘还给那片页面(占位格就是它的落点)。
    // ui-consume-allow: focus-outside-focus — 作用域内部的移动(判词同上)
    slotRef.current?.focus()
  }, [id])

  const respondPermission = useCallback((requestId: string, allow: boolean) => {
    void browserOps.respondPermission.run({ tabId: id, requestId, allow })
  }, [id])

  const go = useCallback(() => {
    const engine = resolveBrowserSearchEngine(undefined)
    const url = resolveBrowserOmniboxInput(draft.value, engine)
    draft.end()
    if (!url) return
    void browserOps.navigate.run({ tabId: id, url })
    // 回车之后键盘回到页面里:人要的是看那一页,不是继续待在地址栏。
    // ui-consume-allow: focus-outside-focus — 作用域内部的移动(判词在 focusAddress 上)
    slotRef.current?.focus()
  }, [draft, id])

  /* ── 此宿主没有内嵌浏览器(`--mode web`)────────────────────────────── */
  if (!bridge) {
    return (
      <div className={s.leaf} data-testid="browser-leaf" data-tab-id={id} data-browser-state="no-host">
        <p className={s.notice}>{t('browser.noHost')}</p>
      </div>
    )
  }

  /*
   * ── 表到了、里面没有这一格 ───────────────────────────────────────────
   *
   * 重启之后账上残留的 `browser:<id>` **通常是活的**:tab 表由主进程落盘,
   * 起来时按表惰性重建(方案 §9-5),所以那一格在 `read tabs` 里应当有 ——
   * 视图等第一个 `visible` 帧才建。真走到这一格只有两种可能:账本坏了,
   * 或者别人(AI / 另一扇窗)把它关了。两种都只有一句话好说,加一颗把这片
   * 叶收掉的钮 —— **不自动关**:一片叶突然自己消失,人会以为是壳出了毛病。
   */
  if (tabs.data && !row) {
    return (
      <div className={s.leaf} data-testid="browser-leaf" data-tab-id={id} data-browser-state="missing">
        <p className={s.notice}>{t('browser.gone')}</p>
        <Button onClick={() => closeBrowserLeaf(id)} data-testid="browser-gone-close">
          {t('common.close')}
        </Button>
      </div>
    )
  }

  const loading = row?.loading === true
  const known = row !== undefined
  /*
   * 身份丸上写什么(`null` = 不画)。三支:名册还没到 / 只有一格 / 这一格 tab
   * 的身份在名册里认不出来(名册被手改过)—— 都不画。**不编一个名字出来**:
   * 一枚写着「default」的丸比没有丸更让人困惑。
   */
  const profileBadge = ((): string | null => {
    const rows = profiles.data?.profiles
    if (!row || !rows || rows.length <= 1) return null
    const mine = rows.find((profile) => profile.id === row.profile)
    return mine ? profileDisplayName(mine, t) : null
  })()

  return (
    <FocusScope
      scope="browser"
      owner={refId(browserRef(id))}
      /*
       * **进这块面,焦点落哪**:一格**空白**新标签落**地址栏**(人开一格新标签
       * 第一件想做的事就是打地址,全世界的浏览器都这样);已经有页的那一格落
       * **占位格**(= 键盘进那片网页)。判据是那一格有没有 url,不是「是不是刚
       * 开出来的」—— 后者要多记一格状态,而这一格现问就有。
       */
      restingTarget={() => (row?.url ? slotRef.current : addressInput() ?? slotRef.current)}
      keyHandlers={{ address: focusAddress, find: openFind }}
    >
      {({ scopeProps }) => (
        <div
          {...scopeProps}
          className={s.leaf}
          data-testid="browser-leaf"
          /*
            **这片叶画的是哪一格 tab** —— DOM 上的契约(B3-b)。从前门是拿占位格
            的 `data-native-view` 当把手的,而起始页那一档根本不画占位格
            (空标签页不报帧),于是那条把手对一格新标签页答不出东西。
            把「这是哪一格」挂在叶自己身上,是因为它在**每一档**都成立。
          */
          data-tab-id={id}
          data-browser-state={loading ? 'loading' : known ? 'live' : 'unknown'}
        >
          <div
            className={s.bar}
            ref={barRef}
            /*
              右键这条檐 = 开同一张动作表(「动作单产地 = 右键上下文菜单」)。
              地址框自己那条右键**让开**(`e.target` 落在 `<input>` 上时不拦)——
              人在一行输入框上右键要的是系统那张「粘贴 / 全选」。
            */
            onContextMenu={(e) => {
              if (e.target instanceof HTMLInputElement) return
              e.preventDefault()
              setActionsAt({ x: e.clientX, y: e.clientY })
            }}
          >
            <IconButton
              icon={ArrowLeft}
              label={t('browser.back')}
              disabled={!row?.canGoBack}
              onClick={() => void browserOps.back.run({ tabId: id })}
              testId="browser-back"
            />
            <IconButton
              icon={ArrowRight}
              label={t('browser.forward')}
              disabled={!row?.canGoForward}
              onClick={() => void browserOps.forward.run({ tabId: id })}
              testId="browser-forward"
            />
            {/*
              刷新与停止是**同一个位置的两档**,不是两颗钮:加载中那一下人要按的
              永远是「别转了」,而让钮左右跳一格是位移。图标与名字一起换,按下去
              落到同一只 mutation(`reload` 在后端对一个正在加载的 tab 就是重来)。
            */}
            <IconButton
              icon={loading ? X : RotateCw}
              label={loading ? t('browser.stop') : t('browser.reload')}
              disabled={!known}
              onClick={() => void browserOps.reload.run({ tabId: id })}
              testId="browser-reload"
            />
            <Input
              className={s.address}
              size="sm"
              value={draft.value}
              onValueChange={draft.setValue}
              onFocus={draft.begin}
              onBlur={draft.end}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  go()
                  return
                }
                if (e.key === 'Escape') {
                  /*
                   * **元素级的一下,不进退层链**:它是「把我打了一半的字收回去」,
                   * 与 `ui/inline-edit` 的「Esc 收回」同一族。`stopPropagation` 让
                   * 那条 window 捕获监听收不到它 —— 不然同一下 Esc 既收草稿又退一层。
                   */
                  e.preventDefault()
                  e.stopPropagation()
                  draft.end()
                  // ui-consume-allow: focus-outside-focus — 作用域内部的移动(同上)
                  slotRef.current?.focus()
                }
              }}
              aria-label={t('browser.address')}
              placeholder={t('browser.addressPlaceholder')}
              data-testid="browser-address"
            />
            {/*
              身份丸(B3-b)。**只在名册多于一格时画** —— 一台只有一个身份的机器上
              它说的是一句废话,而檐上每一格地都是从地址栏那里借来的。
              它是**读数不是控件**:换身份是「以另一个身份打开此页」那条动作
              (在 ⋯ 那张表里),不是就地把这一格 tab 的身份改掉 —— 一格 tab 的
              身份是它的身份(`BrowserTabPatch` 里根本没有 profile 这一格)。
            */}
            {profileBadge !== null && (
              <Tooltip content={t('browser.profileBadge', { name: profileBadge })}>
                <span className={s.profile} data-testid="browser-profile-badge">
                  {profileBadge}
                </span>
              </Tooltip>
            )}
            <IconButton
              icon={Plus}
              label={t('browser.newTab')}
              onClick={() => void import('../browser-launcher').then((m) => m.openBrowser())}
              testId="browser-new-tab"
            />
            <IconButton
              icon={Ellipsis}
              label={t('browser.actions')}
              disabled={!known}
              onClick={(e) => {
                // 钮那条路量的是**钮自己的矩形左下角**(与右键那条同一张表、
                // 两个点),不是光标 —— 键盘按下去的那一下没有光标可言。
                const rect = e.currentTarget.getBoundingClientRect()
                setActionsAt({ x: rect.left, y: rect.bottom })
              }}
              testId="browser-actions"
            />
          </div>
          {/*
            加载条:**一条 1px 的描线**(browser-v2 口径),不是一条进度条 ——
            我们拿不到真进度(Chromium 不给),画一条会自己走到 80% 再等的假进度
            是编。它只说两件事:在走 / 不在走。
          */}
          <div className={s.progress} data-on={loading || undefined} data-testid="browser-progress" />
          {/*
            查找行(B3-a)。它与下面那五档**正交**:哪一档都可能开着它。
            排在加载线之下、错话之上 —— 它是人自己开出来的一条檐,该贴着导航檐。
          */}
          {find.open && (
            <BrowserFindBar tabId={id} find={find} onClose={closeFind} inputRef={mountFindInput} />
          )}
          {row?.error && (
            <p className={s.error} data-testid="browser-error">
              {row.error}
            </p>
          )}
          {/*
            一张网页权限询问卡。**只画队头**(同一 tab 多问排队,判词在
            `data/browser-notices.ts` 上);它长在这片叶的檐下,不进任何全局通知 ——
            这一问问的是「**这一页**能不能拿你的位置」,而屏幕上说得出「这一页」
            的地方只有这片叶。
          */}
          {notices.asks[0] && (
            <WebPermissionCard ask={notices.asks[0]} onRespond={respondPermission} />
          )}
          {/* 下载读数一行。画的永远是最近变动的那一条(判词同上)。 */}
          {notices.downloads[0] && <BrowserDownloadRow notice={notices.downloads[0]} />}
          {/*
            **空标签页画壳自己的起始页,不画占位格**(B3-b)。这不是「在网页上面
            盖一块 DOM」——原生视图永远压在 DOM 之上,盖不住;这里是**根本不报帧**,
            于是 `layout` 那一侧那片视图保持 `setVisible(false)`(`register` 的第一句)。
            判据是 `row.url` 为空,而它是**精确**的:一格开在某个地址上的 tab,
            `createTabState` 那一刻 `url` 就已经是那个地址了(不必等 `did-navigate`),
            所以「开着 URL 的 tab 先闪一下起始页」这件事结构上不存在。
          */}
          {known && !row.url ? (
            <BrowserStartPage />
          ) : (
            <NativeViewSlot viewId={id} scope="browser" elementRef={slotRef} />
          )}
          {actionsAt && row && (
            <BrowserActionsMenu
              tab={row}
              at={actionsAt}
              onClose={() => setActionsAt(null)}
              onOpenInProfile={(profile) => {
                void import('../browser-launcher').then((m) =>
                  m.openBrowser(row.url || undefined, { profile }),
                )
              }}
            />
          )}
        </div>
      )}
    </FocusScope>
  )
}

/**
 * 把这片叶从拼贴树上收掉。
 *
 * **不经 `browser: do close`** —— 那一格在后端已经不存在了(这只函数只在
 * 「找不到」那一档上调),再发一次 `close` 得到的是一句「不是一格开着的 tab」。
 * 这里要收的是屏幕上那片叶本身。
 */
function closeBrowserLeaf(id: string): void {
  const workbench = useWorkbenchStore.getState()
  const key = refId(browserRef(id))
  for (const [region, tree] of Object.entries(workbench.regions)) {
    const at = locateRef(tree, region as Parameters<typeof locateRef>[1], key)
    if (at) {
      workbench.closeTab(at.leafId, at.index)
      return
    }
  }
}

/**
 * 活标题三档:**页标题 → 主机名 → 空**。
 *
 * 空的那一档交给静态标题(种类自述里那句「浏览器」)盖上去 —— 叶檐的规矩是
 * 「活的盖静的」,所以这里宁可交空串也不自己编一句「新标签页」:那句话该由
 * 字典说,而不是由两个产地各说一遍。
 */
export function browserTabTitle(row: BrowserTabRow | undefined): string {
  if (!row) return ''
  if (row.title) return row.title
  if (!row.url) return ''
  try {
    return new URL(row.url).hostname
  } catch {
    return row.url
  }
}
