import crypto from 'node:crypto'

const VALID_TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/
const aliasToOriginal = new Map<string, string>()
const originalToAlias = new Map<string, string>()

function shortHash(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 8)
}

export function createAIToolName(originalName: string, usedNames: Set<string>): string {
  let candidate = originalName.replace(/[^a-zA-Z0-9_-]/g, '-')
  candidate = candidate.replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!candidate) candidate = 'tool'

  if (!VALID_TOOL_NAME_RE.test(candidate)) {
    candidate = `tool-${shortHash(originalName)}`
  }

  if (usedNames.has(candidate) && aliasToOriginal.get(candidate) !== originalName) {
    candidate = `${candidate}-${shortHash(originalName)}`
  }

  usedNames.add(candidate)
  aliasToOriginal.set(candidate, originalName)
  originalToAlias.set(originalName, candidate)
  return candidate
}

export function resolveAIToolName(toolName: string): string {
  return aliasToOriginal.get(toolName) || toolName
}

/**
 * 退役工具名 → 现名。**灰度期机制**,不是长期特性。
 *
 * 改名一个模型每天都在调的工具时,历史里的旧调用范例不会跟着改:执行会话的
 * 转录里全是旧名,而 provider 是生成器,模仿旧范例吐一个旧名是必然会发生的事。
 * 没有这张表,那一次调用换回来的是「Tool not available」——一条本该送达的消息
 * 就此丢掉,还要多烧一轮让模型重学。
 *
 * 与上面的 `aliasToOriginal` 分开一张表是刻意的:那张记的是「模型面名字 →
 * 工具 id」的**编码**(非法字符替换/去重),这张记的是「旧名 → 新名」的**改名
 * 历史**。混在一起,清理任何一边都会顺手废掉另一边。
 *
 * 别名只在**派发**时被查(runner 的 toolMap miss),永远不进请求的 tools 参数,
 * 也不进任何提示词 —— 模型看不见它,只是在写错名字时不被惩罚。
 */
const retiredToolNames = new Map<string, string>()

/** 登记一个退役名。调用点应当就在改名的那个工具的装配处,并注明拆除条件。 */
export function registerRetiredAgentToolName(retired: string, current: string): void {
  if (!retired || !current || retired === current) return
  retiredToolNames.set(retired, current)
}

/** 现名,或原样返回(没登记过就不是退役名)。 */
export function resolveRetiredAgentToolName(toolName: string): string {
  return retiredToolNames.get(toolName) ?? toolName
}

/** 测试用:清空退役名表。 */
export function clearRetiredAgentToolNames(): void {
  retiredToolNames.clear()
}

export function getAIToolName(originalName: string): string {
  const existing = originalToAlias.get(originalName)
  if (existing) return existing
  if (VALID_TOOL_NAME_RE.test(originalName)) return originalName
  return createAIToolName(originalName, new Set(aliasToOriginal.keys()))
}
