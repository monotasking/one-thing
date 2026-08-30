import type { ProjectedToolCall } from '../../model/segments'
import type { ToolPresenter } from '../presenter'
import { baseToolRow, truncate } from '../row'
import { argString, toolDetails, toolOutputText } from '../result'

/**
 * `web_search` / `web_open` 的展示(§5.1 表第四行)。
 *
 * ── 本批它们只是普通工具行 ────────────────────────────────────────────
 * 定稿里这一族最终要折进**检索段**(四件套:流中态行 / favicon 收起行 / 来源清单 /
 * 引用角标),那是 P4。本批给的是「散发时」的那一份:一行说清查了什么 / 开了哪个
 * 站,详情是结果正文。P4 接进来时换的是**归组步**(② 认出这一族),这个 presenter
 * 原样留用 —— 它回答的问题(单次调用怎么展示)不会因为归组而改变。
 *
 * 行 = 查询词(search)/ 域名(open)。域名而不是全 URL:一行里 URL 的后半截通常是
 * 一串追踪参数,截断之后剩下的正好是最没有信息的那一半。
 */
export const webPresenter: ToolPresenter = {
  match: (call) => WEB_TOOLS.has(call.toolName || call.toolId),

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

  detail: (call) => {
    const source = toolOutputText(call)
    // 结果摘要是**已经排好版的纯文本**(工具自己拼的列表),不是任何一门语言 ——
    // 所以 lang 为空:高亮它只会把标题染成关键字色。
    return source === undefined ? [] : [{ kind: 'code', lang: null, source, closed: true }]
  },
}

const WEB_TOOLS = new Set(['web_search', 'web_open'])

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

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    // URL 解析不了就原样用那串字符 —— 它是用户/模型给的东西,原样显示是诚实的。
    return truncate(url, 48)
  }
}
