import {
  createPageToken,
  extractPageTokens,
} from '@onething/runtime/prompts/prompt-references'
import type { MessageAttachment } from '@shared/ipc/chat'
import { browserTabOf, browserTabsQuery, readBrowserPage } from './browser-source'

/**
 * **「把这一页交给对话」在出站那一刻怎么物化**(B3-b)。
 *
 * ── 一句话 ────────────────────────────────────────────────────────────────
 * 草稿里是一枚 `{{page:<tabId>}}`(chip 占位、零字节);**交出去那一刻**才去读
 * 那一格 tab 的正文,折成一件**文本附件**随命令走。正文**不进消息正文**。
 *
 * ── 三条判据,每一条都有判例 ──────────────────────────────────────────────
 *
 * **① 展开顺序是硬的:`expandFileTokens` 先,这一只后。**
 * (2026-07-27 判例,`project_browser_page_mention_2026_07`)URL 与页面正文都是
 * **页面自控的字节**。先物化页面、再展开文件 token,等于把一段页面可以写的文本
 * 送进「`{{file:…}}` 会被展成本地文件内联」那条信任通道 —— 一个网页就能走私出
 * 这台机器上任意一个文件。所以两者的次序不是风格,是闸。
 * **09-12 起这一条由结构保证,不再靠出站那一句里的先后**:壳里唯一那道
 * `expandFileTokens` 搬去了输入面的草稿出口(`ComposerInput.readDraft`,理由是
 * 乐观上屏的那句话必须与账本上的逐字相同),而这一只在**发送那一刻**才跑 ——
 * 页面正文进入正文的时候,展开早已结束,没有第二遍扫描可言。哪天有人把展开加回
 * `chat-port.sendMessage`,它必须仍然排在这一只**之前**(守卫在 chat-port.test)。
 *
 * **② 正文走附件,不进 `content`。**
 * (「附件链路」判例:文本 engine 内联)引擎对一件带 `sourceUrl` / `excerpt` 的
 * 附件有**现成的一支**(`packages/core/engine/message-content.ts` 的
 * `webElementAttachmentTag`):它折成一个 `<attachment source_url="…" title="…">
 * …正文…</attachment>` 的**文本部件**,不要求磁盘上真有这份字节、也不要求模型
 * 有视觉。于是 AI 侧**一个字都不必加** —— 它本来就有 `browser` 工具的 `page`
 * 读法,这里只是把「人已经指过的那一页」顺手递到手边。
 * 反过来把正文塞进 `content` 的后果是三重的:气泡里出现两万字、账本里存一份、
 * 每一轮重建历史都再喂一遍(「上下文膨胀」判例)。
 *
 * **③ 点击那一刻不取正文,发送那一刻才取。**
 * 草稿是会被存进**每一条会话的稿**里的(`composer/drafts.ts`);点击就取等于
 * 把两万字连同草稿一起存下来,而人也许根本没发出去。所以 chip 里只有一个 tab id。
 * 代价是**发送那一刻多一次往返**(一次 `resources.read`,与 AI 走的是同一条路),
 * 而那正是它该花的地方:交出去的是「这一页此刻是什么样」,不是「我点它的时候」。
 *
 * ── 结局四支,一支都不抛 ───────────────────────────────────────────────────
 * 这只函数在**发送路**上,而发送路上抛一个异常 = 人那句话没发出去。所以:
 *  · tab 早关了(死 token)→ 那枚 token 连同一个尾随空格一起消失,什么都不带
 *    (`extractPageTokens` 自己的判据);
 *  · 读正文砸了(页面正导航走 / 这台宿主没有浏览器)→ 仍然带一件**只有出处
 *    没有正文**的附件:模型看得见「用户指的是这一页」,而且它自己读得到。
 *    静默丢掉会让「我明明给了它那一页」变成一句没人承认的话;
 *  · 读回来是空串(页面还没画出东西)→ 同上;
 *  · 正常 → 出处 + 已经被 `<untrusted-content>` 定界过的正文(定界是 provider
 *    那一侧做的,见 `electron/browser/resource-provider.ts`;这里**不再包第二层**:
 *    模型要认的标记只许有一种)。
 */

/** 草稿里代表一格 tab 的那截文本。**唯一产地在 runtime**(契约层),这里只转手。 */
export { createPageToken }

/** 一件页面附件的字节上限说明:正文由 `page` 那条读法自己截(缺省 20k 字)。 */
export interface MaterializedPages {
  /** 剥掉 token 之后的正文(人那句话本身)。 */
  text: string
  /** 随命令走的附件。空数组 = 这条消息里没有页面引用。 */
  attachments: MessageAttachment[]
}

/** 一格 tab 在屏幕上叫什么:页标题 → 主机名 → 地址。三档与叶檐那只同源同序。 */
export function pageReferenceLabel(row: { title?: string; url?: string } | undefined): string {
  if (!row) return ''
  if (row.title) return row.title
  if (!row.url) return ''
  try {
    return new URL(row.url).hostname
  } catch {
    return row.url
  }
}

/**
 * 把一句带 `{{page:…}}` 的草稿折成「正文 + 附件」。
 *
 * **没有页面引用时它是恒等**(同一个字符串、空数组),而且**一发请求都不打** ——
 * 绝大多数消息走的是这一支,它不该为此去问一次 tab 表。
 */
export async function materializePageReferences(draft: string): Promise<MaterializedPages> {
  // 便宜的那一问先做:正文里没有那五个字符就什么都不必发生。
  if (!draft.includes('{{page:')) return { text: draft, attachments: [] }

  /*
   * 解 token 要一份 tab 表。`ensure()` 而不是 `refetch()`:屏幕上开着浏览器叶时
   * 这张表由四条事实推着走(`browser-source` 文件头),已经是新鲜的;没开过的
   * 那一格(人在别处发这条消息)才真的打一发。
   */
  await browserTabsQuery.ensure().catch(() => undefined)

  const { text: stripped, pages } = extractPageTokens(draft, (tabId) => {
    const row = browserTabOf(tabId)
    return row ? { url: row.url, title: row.title } : null
  })
  /*
   * **剥完要收一次两端的空白**。`extractPageTokens` 只带走 token 与紧跟其后的
   * **一个**空格(它的判据),所以一句「总结 {{page:t1}}」剥完是「总结 」——
   * 一条以空格结尾的用户消息。上游每一条发送路都已经 `trim()` 过一次了
   * (`composer/store.send` 与 `chat-source.send` 各一次),而这一道展开发生在
   * 它们**之后**,所以这一收是补上同一条纪律,不是新发明一条。
   * 只在**真剥过**的那一支收 —— 没有页面引用时上面第一句就原样答出去了。
   */
  const text = stripped.trim()
  if (pages.length === 0) return { text, attachments: [] }

  const attachments = await Promise.all(
    pages.map(async (page, index) => {
      let body = ''
      try {
        body = (await readBrowserPage(page.tabId)).text
      } catch {
        // 读不到仍然带出处(判词在文件头「结局四支」)。
      }
      const name = pageReferenceLabel(page) || page.url
      return {
        // id 只要在这条消息里唯一。`tabId` 本身是 UUID,够了;序号防同一格被
        // 引两次(`extractPageTokens` 已经按 tab 去重,这一格是兜底不是依赖)。
        id: `page-${index}-${page.tabId}`,
        fileName: name,
        // 一件**没有字节落在磁盘上**的文本附件:引擎那一支认的是
        // `sourceUrl || excerpt`,不是 `filePath`(`message-content.ts`)。
        mimeType: 'text/plain',
        size: body.length,
        mediaType: 'file' as const,
        sourceUrl: page.url,
        sourceTitle: page.title,
        excerpt: body,
      }
    }),
  )
  return { text, attachments }
}
