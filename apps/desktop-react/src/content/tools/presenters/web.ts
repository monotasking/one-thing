import type { ProjectedToolCall } from '../../model/segments'
import type { ToolPresenter } from '../presenter'
import { partialString } from '../partial-json'
import { baseToolRow, partialToolArgs, truncate } from '../row'
import { argString, toolDetails, toolOutputText } from '../result'
import { domainOf, isWebCall } from '../web-family'

/**
 * `web_search` / `web_open` 的展示(§5.1 表第四行)。
 *
 * ── P4 之后它去哪了 ──────────────────────────────────────────────────
 * 归组步(②)已经把这一族折进**检索段**,所以正文流里不再直接出现 web 工具行。
 * 这个 presenter **一行都没改**,而且仍然被每天调用 —— 它算的是「单次调用怎么
 * 展示」,而检索段的来源行点开的抽屉、清单里那一行的图标与成果词读的正是它。
 * 归组换的是「这几次调用摆成什么」,不是「一次调用长什么样」,所以两件事互不相干,
 * 这正是当初把归组与呈现分成两步换来的。
 *
 * 行 = 查询词(search)/ 域名(open)。域名而不是全 URL:一行里 URL 的后半截通常是
 * 一串追踪参数,截断之后剩下的正好是最没有信息的那一半。
 */
export const webPresenter: ToolPresenter = {
  match: (call) => isWebCall(call),

  row: (call) => {
    const tool = call.toolName || call.toolId
    const query = argString(call, 'query')
    const url = argString(call, 'url')
    const label = tool === 'web_open' ? argString(call, 'title') ?? hostOf(url) : query
    const count = resultCount(call)
    return baseToolRow(call, {
      icon: 'Globe',
      ...(label ? { name: truncate(label, 64), title: url ?? query } : {}),
      ...(count !== undefined && call.status === 'completed'
        ? { outcome: { key: 'chat.tool.results', vars: { n: count } } as const }
        : {}),
    })
  },

  /**
   * 参数流中的形:**查询词逐字长出来**(open 那一支是域名)。
   *
   * 与 `row` 同一条选法(open 优先标题、退到域名),差别只在这一刻还没有标题
   * —— 标题是结果里的东西,现在只有 URL。
   */
  partial: (call) => {
    const args = partialToolArgs(call)
    const query = partialString(args, 'query')
    const url = partialString(args, 'url')
    const label = query ?? hostOf(url)
    return {
      icon: 'Globe',
      ...(label ? { name: truncate(label, 64), title: url ?? query } : {}),
    }
  },

  detail: (call) => {
    const source = toolOutputText(call)
    // 结果摘要是**已经排好版的纯文本**(工具自己拼的列表),不是任何一门语言 ——
    // 所以 lang 为空:高亮它只会把标题染成关键字色。
    return source === undefined ? [] : [{ kind: 'code', lang: null, source, closed: true }]
  },
}

/** 结果条数:工具自己写的那几种数组,认哪个算哪个;都没有就没有。 */
function resultCount(call: ProjectedToolCall): number | undefined {
  const details = toolDetails(call)
  if (!details) return undefined
  for (const key of ['results', 'pages', 'searches']) {
    const value = details[key]
    if (Array.isArray(value)) return value.length
  }
  return undefined
}

/**
 * 域名。产地是 `tools/web-family.ts`(检索段读同一份)—— 一行工具卡上的域名与
 * 来源清单里那一行的域名必须逐字相同,两份算法就是两个会分叉的真相。
 * 解析不了时那边留的是**整串原文**,这里再截一次:一行卡容不下一条长 URL。
 */
function hostOf(url: string | undefined): string | undefined {
  const domain = domainOf(url)
  return domain === undefined ? undefined : truncate(domain, 48)
}
