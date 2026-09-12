import { ChevronDown, ChevronUp, Search, X } from '../../components/icons'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { useT } from '../../i18n'
import {
  browserFindNext,
  browserFindPrevious,
  setBrowserFindQuery,
  type BrowserFindState,
} from '../../data/browser-find'
import { findReadout } from '../find-readout'
import s from './BrowserFindBar.module.css'

/**
 * **一格内嵌浏览器的查找行**(B3-a)。形照终端那一行(T2),**不另造**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ① 生命周期
 * ══════════════════════════════════════════════════════════════════════════
 * 挂载 = 查找行开了(`find.open` 为真时叶才渲染它);卸载 = 收起来了。
 * **状态不在这只组件里** —— 它按 tabId 住在 `data/browser-find.ts`,寿命是那片
 * 视图而不是这次挂载(判词整段在那只文件头上)。换宿主 / 撕浮窗 / 铺满都不重挂;
 * 真重挂了也只是把同一格状态再画一遍,页面上那些高亮一处不丢。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ② UI 生命状态(四档,与叶那五档**正交**)
 * ══════════════════════════════════════════════════════════════════════════
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | 关 | `find.open` 为假 | 这一行整个不画(叶那边判) |
 * | 开 · 无词 | `open && !query` | 输入框空着;读数整格不画;上下两颗钮禁用 |
 * | 开 · 有命中 | `total > 0` | 读数「3/17」(或只有总数时「17」) |
 * | 开 · 零命中 | `query && total === 0` | 读数「0」。**不弹任何东西**、不变红、不抖 |
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ③ UI 交互状态
 * ══════════════════════════════════════════════════════════════════════════
 * | 交互 | 结果 |
 * | --- | --- |
 * | 打字 | 就地往下找一次(增量);空掉 = 清高亮,**不是**「找一个空串」 |
 * | ↵ / ⇧↵ | 下一处 / 上一处。**行内结构键**(第三层,不进任何表) |
 * | Esc | 收起这一行,键盘还给那片页面。同样是行内结构键 |
 * | 上 / 下两颗钮 | 与 ↵ / ⇧↵ 同一只落点。词空着时**禁用**(不给一颗按不动的钮) |
 * | × | 收起。与 Esc 同一只落点 |
 * | rest / hover / focus | 全部由 `ui/Input` 与 `ui/IconButton` 带(配方随件走) |
 * | pending | **无**。查找没有往返:发出去就是发出去了,读数由推送带回来 |
 *
 * ── ↵ / ⇧↵ / Esc 为什么不进键位表 ────────────────────────────────────────
 * 它们是**行内结构键**(`keymap/types.ts` 顶部:可配置就等于不一致),与终端查找行
 * 那三个逐字同一条。真正进表的只有 ⌘F 那一条(`focus/scopes.ts` 的 `BROWSER_KEYS`)。
 */
export function BrowserFindBar({
  tabId,
  find,
  onClose,
  inputRef,
}: {
  tabId: string
  find: BrowserFindState
  /** 收起这一行(落点在叶上 —— 它还要把键盘还给占位格)。 */
  onClose: () => void
  /** 那只 `<input>` 的挂载回调(⌘F 再按一下要把光标送回来,判词在叶上)。 */
  inputRef: (el: HTMLInputElement | null) => void
}) {
  const t = useT()
  /*
   * 读数三档的判据与终端查找行**同一只函数**(B3-b 合一)。Chromium 的
   * `activeMatchOrdinal` 本来就是 1 起、`0` = 只报了总数,与那只函数的
   * `ordinal` 口径逐字相同,所以这里一个字都不折。
   */
  const readout = findReadout({ query: find.query, ordinal: find.active, total: find.total })

  return (
    <div className={s.find} data-testid="browser-find">
      <Input
        ref={inputRef}
        value={find.query}
        onValueChange={(next) => setBrowserFindQuery(tabId, next)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) browserFindPrevious(tabId)
            else browserFindNext(tabId)
            return
          }
          if (e.key === 'Escape') {
            /*
             * **元素级的一下,不进退层链**(与地址栏那一下 Esc 逐字同一条):
             * 它的意思是「收起这一行」,不是「退一层」。`stopPropagation` 让那条
             * window 捕获监听收不到它 —— 不然同一下 Esc 既收查找行又退一层。
             */
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
        size="sm"
        prefix={<Search className={s.findIcon} strokeWidth={1.75} aria-hidden="true" />}
        aria-label={t('browser.find')}
        placeholder={t('browser.findPlaceholder')}
        className={s.findInput}
      />
      {/* 读数三档只有一个产地(`content/find-readout.ts`);没词的时候整格不画 ——
          「没内容就别占地方」与叶上那一行错话同一条。 */}
      {readout !== null && (
        <span className={s.findCount} data-testid="browser-find-count" aria-live="polite">
          {readout}
        </span>
      )}
      <IconButton
        icon={ChevronUp}
        label={t('browser.findPrev')}
        size="xs"
        disabled={!find.query}
        onClick={() => browserFindPrevious(tabId)}
        testId="browser-find-prev"
      />
      <IconButton
        icon={ChevronDown}
        label={t('browser.findNext')}
        size="xs"
        disabled={!find.query}
        onClick={() => browserFindNext(tabId)}
        testId="browser-find-next"
      />
      <IconButton
        icon={X}
        label={t('browser.findClose')}
        size="xs"
        onClick={onClose}
        testId="browser-find-close"
      />
    </div>
  )
}
