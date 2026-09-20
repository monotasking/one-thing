import { resolveIcon } from '../../components/icons'
import { registerReferenceKind } from '../registry'
import s from '../ReferenceChip.module.css'
import type { ReferenceKind } from '../kind'

/**
 * **出处引用** `<ref type="reference" href="…" title="…"/>`(B2,正本 §1)。
 *
 * 「一处出处」:网页、文档、规范条目 —— 助手说「这句话是从这儿来的」时写的那一枚。
 * **它不是文件**(文件有 `file` 那一种),也不是「打开着的那一格网页」
 * (那是 `kinds/page.ts` 的 `{{page:<tabId>}}`,一件发送时才物化的附件)。
 * 三者共用不了一种自述,因为它们的 Ref、落点、打开法各不相同。
 *
 * ── 三格,缺的三格各有理由 ────────────────────────────────────────────────
 *  · **没有 `source`** —— 它不从抽屉进:人手里没有一张「出处」的候选表。
 *  · **没有 `draft`** —— 壳里没有任何一处**落**一枚出处引用,它只从助手那边来。
 *  · **没有 `parse`** —— 正文里没有第二种写法。裸 URL 与 markdown 链接各有各的
 *    归宿(`InlineRun` 的 `link` 那一支),把它们也认成这一种等于发明新语法,
 *    而正本 §2.4 那条判词是「引用是**已经在正文里的写法**,壳只是认出来」。
 *
 * ── 打开:内置浏览器 ▷ 交给系统 ───────────────────────────────────────────
 * 判词在下面 `open` 上。这里只记一句 import 的纪律:`content/browser-launcher`
 * **只在点下去那一刻动态 import**。它在模块作用域里跑一句
 * `setBrowserTabAdopter(...)`,静态 import 会把那句登记装进每一个 import 过引用
 * 表的世界(`content/user-message` → `ChatStream` → 每一个渲染聊天的用例),
 * 而那正是 `content/dir-open.ts` 文件头记的那桩事故的同一种形。
 */

const LinkIcon = resolveIcon('Link')

export interface LinkRef {
  kind: 'linkRef'
  href: string
  title?: string
}

/** 这条地址交给内置浏览器,还是交给系统。**只有 http(s) 是内置浏览器的事。** */
function isWebHref(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

/**
 * 屏幕上那几个字:`title` ▷ `label` ▷ **去掉协议的地址**。
 *
 * 最后那一档去协议是因为一行里认得出 `example.com/spec` 的人认不出多出来的
 * `https://` —— 它是语法不是内容。空串在这里不可能出现:`toRef` 已经挡掉了没有
 * `href` 的那一枚。
 */
function linkLabel(ref: LinkRef): string {
  if (ref.title) return ref.title
  return ref.href.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') || ref.href
}

export const linkReferenceKind: ReferenceKind<never, LinkRef> = {
  id: 'reference',

  tag: {
    type: 'reference',
    toRef: (tag) => {
      const href = tag.attrs.href?.trim()
      // 没有地址就不是一处出处 —— 认不出,照实画中性 chip、原话留屏。
      if (!href) return null
      // `label` 是**通用**属性(编解码器的宽容形把标签文字收在这一格),
      // `title` 是这一种自己的。两格都可能有,`title` 更具体所以在前。
      const title = (tag.attrs.title || tag.attrs.label || '').trim()
      return { kind: 'linkRef' as const, href, ...(title ? { title } : {}) }
    },
    toTag: (ref) => {
      const attrs: Record<string, string> = { href: ref.href }
      if (ref.title) attrs.title = ref.title
      return { type: 'reference', attrs }
    },
  },

  render: (ref) => ({
    className: s.ref,
    dataKind: 'linkRef',
    icon: LinkIcon,
    iconClassName: s.refIcon,
    label: linkLabel(ref),
    labelClassName: s.refName,
    /*
     * 提示说的是**整条地址**(标签上那几个字往往是标题,读不出它指向哪儿)。
     * 走 `tooltipText` 而不是字典:一条 URL 是**数据**不是文案,它没有中英两说
     * (与 `kinds/page.ts` 逐字同一条)。
     */
    tooltipText: ref.href,
    clickable: true,
    failKey: 'chat.ref.openLinkFailed',
    failSource: 'chat.linkRef',
  }),

  /**
   * **http(s) → 内置浏览器开一格;其余 scheme → 交给系统**(正本 §1 的类型表)。
   *
   * 两条路各自的降级都写在这里,因为「这台宿主有没有内置浏览器」不是这一种能
   * 预先知道的事 —— 它只能**问过才知道**:`openBrowser` 答 false = 后端没有
   * `browser:` 那位提供者(浏览器壳 / 单测 / 将来别的宿主),那时退到最后一条。
   *
   * 最后那一条是 `window.open`,而且**只在没有 Electron 宿主的时候走**:桌面壳里
   * 一句 `window.open` 会开出一扇没人管的 Electron 窗(没有导航策略、没有会话
   * 隔离、关不掉),那比什么都不做坏。桌面上退到这一步就答 false,由 chip 说一句
   * 人话 —— 今天这只会发生在「非 http(s) 的 scheme」上(壳这一侧没有
   * `shell.openExternal` 那个面,判词在 `content/files/open-dir-hub.ts`:
   * `configureShellHost` 是一格闩,声明它是别批的拍板)。留账见交卷。
   */
  open: async (ref) => {
    if (isWebHref(ref.href)) {
      const { openBrowser } = await import('../../content/browser-launcher')
      if (await openBrowser(ref.href)) return true
    }
    return openOutsideApp(ref.href)
  },
}

/**
 * 交给这台宿主之外的东西去开。
 *
 * 有 Electron 宿主(`window.onethingHost`,判据与 `platform/connection` 同源)
 * 就**什么都不做**:壳这一侧今天没有 `openExternal`,而 `window.open` 在
 * Electron 里开出来的是一扇壳自己的窗,不是系统默认浏览器。
 */
function openOutsideApp(href: string): boolean {
  if (typeof window === 'undefined') return false
  if ((window as { onethingHost?: unknown }).onethingHost) return false
  // `noopener` 是硬性的:新开的页面不该拿得到这台壳的 `window.opener`。
  return window.open(href, '_blank', 'noopener') !== null
}

registerReferenceKind(linkReferenceKind, import.meta.hot)
