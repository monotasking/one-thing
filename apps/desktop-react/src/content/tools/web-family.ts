import type { ProjectedToolCall } from '../model/segments'

/**
 * **web 族**是谁 —— 检索段的入场判据(§5.3)。
 *
 * ── 为什么是一张明表,不是名字前缀 ────────────────────────────────────────
 * 「按 `web_` 前缀认」看着更省事,可它会把将来任何一个叫 `web_*` 的工具(比如
 * 一个「把网页存进笔记」的写工具)一并卷进检索段,而那件事既不产查询词也不产
 * 来源 —— 折出来的 episode 会是一张空清单。族的边界是**语义**(这次调用是不是
 * 在「上网找东西」),语义只能列表,不能从名字推。加一个真检索工具的代价是这里
 * 一行。
 *
 * ── 为什么这张表住 tools/ 而不是 research/ ──────────────────────────────
 * 「哪几个工具属于 web 族」是一件关于**工具**的事实,research 段是它的消费者。
 * 放进 research/ 的话,`tools/presenters/web.ts` 要反过来 import research —— 一层
 * 模型互相认领,以后谁都说不清哪边是产地。现在是单向的:tools 说事实,
 * assemble/research 读事实。
 */
export const WEB_TOOL_NAMES: ReadonlySet<string> = new Set(['web_search', 'web_open'])

export function isWebToolName(name: string): boolean {
  return WEB_TOOL_NAMES.has(name)
}

export function isWebCall(call: ProjectedToolCall): boolean {
  return isWebToolName(call.toolName || call.toolId)
}

/** 这一次调用是不是「搜」(相对于「开」)。 */
export function isSearchCall(call: ProjectedToolCall): boolean {
  return (call.toolName || call.toolId) === 'web_search'
}

/**
 * URL → 域名(去掉 `www.`)。
 *
 * 一行里 URL 的后半截通常是一串追踪参数,截断之后剩下的正好是最没有信息的那一半;
 * 域名才是「这句话是谁说的」。解析不了就**原样把那串字符还回去** —— 它是模型给的
 * 东西,原样显示是诚实的,编一个域名不是。
 */
export function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

/**
 * 这串字符看起来像不像一个真主机名。
 *
 * favicon 只对像主机名的东西去取(见 research/favicon.ts):把 `not a url` 拼进
 * `https://…/favicon.ico` 会发出一条注定 404 的请求,还会在控制台留一条误导人的错。
 */
export function looksLikeHost(domain: string | undefined): boolean {
  return domain !== undefined && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)
}
