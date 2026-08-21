/**
 * R4b —— 工具自带的提示词片段,读源从旧注册表换成目录(`Catalog`)。
 *
 * 这一条**不是**工具系统的内部机制,而是一件独立的产品语义:一只工具可以带着
 * 自己的那几句话(guideline 子弹 / workspace-rule 子弹 / 独立小节),话跟着工具
 * 走 —— 在这一回合的工具面上就注入,不在面上 / 被关掉 / 没注册就没有。
 *
 * 旧读源是 `OnethingToolRegistry.collect`(`ToolInfo.prompt`);新读源是目录里那
 * 只工具的 `spec.prompt`(内核 `ToolSpec.prompt`,类型就是同一个
 * `CoreToolPromptContribution`)。**判据逐字保留**:
 *
 *  - `ctx.hasTools` 为假 → 一句都不说;
 *  - `ctx.toolNames` 是这一回合真正进请求的工具名(档 ∩ 设置 ∩ 场景 ∩ 白名单),
 *    经 `resolveAIToolName` 还原成 id 后**排序**(渲染出来的字节不许依赖注册
 *    次序 —— 那是提示词缓存的静态前缀);
 *  - 同一个 id 只算一次;目录里没有的 id、没有 `prompt` 的工具什么都不产。
 *
 * 目录还没装上(宿主没走 backend)时它安静地返回空 —— 与旧路"注册表是空的"
 * 同一个结果,不是一次错误。
 */

import { resolveAIToolName } from '@onething/core/agent-loop'
import {
  promptFragmentsFromToolContribution,
  type CoreBuildPromptContextOptions,
  type CorePromptFragment,
} from '@onething/core/engine'
import type { PromptSource } from '@onething/runtime/prompts'
import { getToolkitCatalog } from '@onething/runtime/toolkit'

/** 目录里这几只工具带的提示词片段,按给定次序、每个 id 只算一次。 */
export function toolkitPromptFragments(toolIds: Iterable<string>): CorePromptFragment[] {
  const catalog = getToolkitCatalog()
  if (!catalog) return []
  const out: CorePromptFragment[] = []
  const seen = new Set<string>()
  for (const toolId of toolIds) {
    if (seen.has(toolId)) continue
    seen.add(toolId)
    const prompt = catalog.get(toolId)?.spec.prompt
    if (!prompt) continue
    out.push(...promptFragmentsFromToolContribution(toolId, prompt))
  }
  return out
}

/** 目录作为一个 `PromptSource`(这一回合面上的工具说了什么)。 */
export const toolkitPromptSource: PromptSource = {
  name: 'tools',
  collect(ctx: CoreBuildPromptContextOptions): CorePromptFragment[] {
    if (!ctx.hasTools) return []
    const ids = (ctx.toolNames ?? []).map(name => resolveAIToolName(name)).sort()
    return toolkitPromptFragments(ids)
  },
}
