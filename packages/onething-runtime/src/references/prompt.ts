import { formatRefTag } from '@onething/core/references'
import { refTypes, type RefTypeRegistry } from './registry.js'
import type { RefTypeSpec } from './spec.js'

/**
 * 提示词里「引用」那一段 = 一段手写的总则 + **一张由注册表算出来的类型表**。
 *
 * 类型表必须是算出来的,不能是写死的:写死就意味着加一种引用要改提示词文件,
 * 而那正是「加功能不许改骨架」要消灭的那种枚举点。`prompts/builder.ts` 只调
 * 这只函数,它自己一个类型名都不认识。
 *
 * 片段走 `channel: 'system'`(跨会话逐字相同,缓存前缀不破),所以这里的输出
 * 只许依赖注册表的内容与顺序 —— 不许掺时间、随机数或会话事实。
 */
export function renderReferenceGuide(
  preamble: string,
  registry: RefTypeRegistry = refTypes,
): string {
  const types = registry.list()
  if (types.length === 0) return preamble
  return [preamble, 'Reference types:', types.map(renderType).join('\n')].join(
    '\n\n',
  )
}

function renderType(spec: RefTypeSpec): string {
  const parts = [`- \`${spec.type}\` — ${spec.summary}.`]
  if (spec.attrs.length > 0) {
    parts.push(`${spec.attrs.map(renderAttr).join('; ')}.`)
  }
  parts.push(`Example: \`${formatRefTag(spec.example)}\``)
  return parts.join(' ')
}

function renderAttr(attr: RefTypeSpec['attrs'][number]): string {
  const name = attr.required ? `\`${attr.name}\` (required)` : `\`${attr.name}\``
  return `${name} ${attr.description}`
}
