import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Plus, RotateCw, X } from '../../components/icons'
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
import { NativeViewSlot } from '../native-view/NativeViewSlot'
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
 * ══════════════════════════════════════════════════════════════════════════
 * ③ 交互状态
 * ══════════════════════════════════════════════════════════════════════════
 * | 交互 | 结果 |
 * | --- | --- |
 * | 地址栏打字 | 只改草稿。**不发请求** |
 * | 回车 | `resolveBrowserOmniboxInput` 折成一个 URL(像地址就当地址,像话就去搜)→ `do navigate` |
 * | Esc(在地址栏里) | 草稿退回真地址,焦点回页面。这是**元素级**的一下,不进退层链 |
 * | ⌘L | 地址栏聚焦并全选(面域局部键,同时是推给主进程的保留键) |
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
  const slotRef = useRef<HTMLDivElement | null>(null)
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
      <div className={s.leaf} data-testid="browser-leaf" data-browser-state="no-host">
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
      <div className={s.leaf} data-testid="browser-leaf" data-browser-state="missing">
        <p className={s.notice}>{t('browser.gone')}</p>
        <Button onClick={() => closeBrowserLeaf(id)} data-testid="browser-gone-close">
          {t('common.close')}
        </Button>
      </div>
    )
  }

  const loading = row?.loading === true
  const known = row !== undefined

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
      keyHandlers={{ address: focusAddress }}
    >
      {({ scopeProps }) => (
        <div
          {...scopeProps}
          className={s.leaf}
          data-testid="browser-leaf"
          data-browser-state={loading ? 'loading' : known ? 'live' : 'unknown'}
        >
          <div className={s.bar} ref={barRef}>
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
            <IconButton
              icon={Plus}
              label={t('browser.newTab')}
              onClick={() => void import('../browser-launcher').then((m) => m.openBrowser())}
              testId="browser-new-tab"
            />
          </div>
          {/*
            加载条:**一条 1px 的描线**(browser-v2 口径),不是一条进度条 ——
            我们拿不到真进度(Chromium 不给),画一条会自己走到 80% 再等的假进度
            是编。它只说两件事:在走 / 不在走。
          */}
          <div className={s.progress} data-on={loading || undefined} data-testid="browser-progress" />
          {row?.error && (
            <p className={s.error} data-testid="browser-error">
              {row.error}
            </p>
          )}
          <NativeViewSlot viewId={id} scope="browser" elementRef={slotRef} />
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
