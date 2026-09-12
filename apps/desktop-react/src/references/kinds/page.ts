import { createPageToken, pageReferenceLabel } from '../../data/page-references'
import { registerReferenceKind } from '../registry'
import type { ReferenceKind } from '../kind'

/**
 * **网页引用** `{{page:<tabId>}}` —— 浏览器叶的「把这一页交给对话」(B3-b)。
 *
 * ── 它只有「落稿」那一格,而且那一格今天**没有生产读者**(留账)──────────────
 * 三件事各有各的理由:
 *  · **没有 `source`** —— 它不从抽屉进。动作留在浏览器叶自己的右键菜单里
 *    (「动作单产地 = 右键上下文菜单」),落点是 `composer/references.ts` 那条缝。
 *  · **没有 `expand`** —— 它不是一句话,是**发送那一刻才物化的一件附件**:
 *    那一页此刻长什么样只有那一刻知道(`data/page-references.materializePageReferences`
 *    在 `chat-port` 里跑)。所以这一枚记号原样穿过草稿出口。
 *  · **没有 `parse` / `render`** —— 正文里根本没有它:它在发送那一刻就变成了
 *    attachments,气泡里那一格归附件那条路(浏览器那批),**这一单一个字不碰**。
 *
 * **留账**:今天落这一枚 chip 的是 `content/browser/BrowserActionsMenu.tsx`,
 * 它自己拼 `{label, token, tip}` 交给 `insertComposerReference` —— 那条缝**没有**
 * 走这张表(那几只文件本批是别人的地,不碰)。于是下面这两格是**自述在场、
 * 读者缺席**:登记在这里,是为了让「网页也是一种引用」这件事在表上说得出来,
 * 也为了那条缝哪天收进来的时候不必先发明一份自述。
 */

/** 一格 tab 交到这里的样子(只要标题与地址两格 —— 正文到发送那一刻才读)。 */
export interface PageHit {
  tabId: string
  title?: string
  url?: string
}

export const pageReferenceKind: ReferenceKind<PageHit, never> = {
  id: 'page',

  draft: {
    // 页标题 → 主机名 → 地址。三档与叶檐那只同源同序(`pageReferenceLabel`)。
    chip: (hit) => ({ label: pageReferenceLabel(hit) || (hit.url ?? ''), tone: 'reference' }),
    token: (hit) => createPageToken(hit.tabId),
  },
}

registerReferenceKind(pageReferenceKind, import.meta.hot)
