import { resolveIcon } from '../../components/icons'
import { createPageToken, pageReferenceLabel } from '../../data/page-references'
import { registerReferenceKind } from '../registry'
import s from '../ReferenceChip.module.css'
import type { ReferenceKind } from '../kind'

/**
 * **网页引用** `{{page:<tabId>}}` —— 浏览器叶的「把这一页交给对话」(B3-b)。
 *
 * ── 三格,每一格缺席都有理由 ──────────────────────────────────────────────
 *  · **没有 `source`** —— 它不从抽屉进。动作留在浏览器叶自己的右键菜单里
 *    (「动作单产地 = 右键上下文菜单」),落点是 `composer/references.ts` 那条缝。
 *  · **没有 `expand`** —— 它不是一句话,是**发送那一刻才物化的一件附件**:
 *    那一页此刻长什么样只有那一刻知道(`data/page-references.materializePageReferences`
 *    在 `chat-port` 里跑)。所以这一枚记号原样穿过草稿出口。
 *  · **没有 `parse`** —— 正文里根本没有它:它在发送那一刻就变成了 attachments,
 *    落账的气泡里那一格归附件那条路。
 *
 * ── 09-14:`render` 补上了,而且那条缝真的接进来了 ──────────────────────────
 * 09-12 立表时这一份是「自述在场、读者缺席」:落 chip 的是
 * `content/browser/BrowserActionsMenu.tsx`,它自己拼 `{label, token, tip}` 交给
 * `insertComposerReference`,压根没走这张表。所见即所发那一单把那条缝改成收
 * `{kindId, ref}`,于是这一份的 `toRef` / `token` / `render` 三格全部上岗:
 * 输入框里那一枚网页 chip 与别的引用**是同一个组件画的**。
 *
 * 落账后这枚引用由消息顶层的附件元信息呈现(`content/user-attachments`):
 * `materializePageReferences` 摘掉正文里的记号,附件仍以名称显示在用户消息里。
 */

const PageIcon = resolveIcon('Globe')

/** 一格 tab 交到这里的样子(只要标题与地址两格 —— 正文到发送那一刻才读)。 */
export interface PageHit {
  tabId: string
  title?: string
  url?: string
}

/** 落下来的那一枚。形与 `PageHit` 同 —— 这一种没有「候选」与「引用」之别。 */
export interface PageRef extends PageHit {
  kind: 'pageRef'
}

export const pageReferenceKind: ReferenceKind<PageHit, PageRef> = {
  id: 'page',

  draft: {
    toRef: (hit) => ({
      kind: 'pageRef',
      tabId: hit.tabId,
      ...(hit.title ? { title: hit.title } : {}),
      ...(hit.url ? { url: hit.url } : {}),
    }),
    token: (ref) => createPageToken(ref.tabId),
  },

  /*
   * 页标题 → 主机名 → 地址。三档与叶檐那只同源同序(`pageReferenceLabel`)。
   * **不可点**:壳里「点一枚网页 chip」该做的事(跳回那一格 tab)还没有裁定,
   * 而屏幕上不该出现一个按下去没反应的东西。提示走 `tooltipText` —— 一条 URL
   * 是**数据**不是文案,不进字典。
   */
  render: (ref) => ({
    className: s.ref,
    dataKind: 'pageRef',
    icon: PageIcon,
    iconClassName: s.refIcon,
    label: pageReferenceLabel(ref) || (ref.url ?? ''),
    labelClassName: s.refName,
    ...(ref.url ? { tooltipText: ref.url } : {}),
    clickable: false,
  }),
}

registerReferenceKind(pageReferenceKind, import.meta.hot)
