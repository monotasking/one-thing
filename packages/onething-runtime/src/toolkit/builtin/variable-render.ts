/**
 * R1 —— `variable` 的**投影**纯函数(列表 / keys / get 三种渲染 + 元数据摘要)。
 *
 * 与 `read-content.ts` 同一个理由:它们今天长在 `tools/builtin/variable.ts` 的模块
 * 私有作用域里,而那个文件整只在删除清单上。搬成独立模块而不是复制进工具壳,口径
 * 由对拍测试逐条钉住。
 */

import type { JsonObject } from '@onething/core'
import type { VariableScope, VariableType } from '../../variables/types.js'

export type VariableAction = 'list' | 'get' | 'keys' | 'set' | 'append' | 'remove' | 'delete'

/**
 * 读操作 —— 不写任何东西,因此也不该触发能力变量的审批效果。
 * (`plan` 里少了这道门,一次对能力变量的 `get` 就会弹出"重指目录"的审批框。)
 */
export const VARIABLE_READ_ACTIONS = new Set<VariableAction>(['list', 'get', 'keys'])

export interface RuntimeContextVariable {
  name: string
  value?: string
  values?: string[]
  type?: VariableType
  scope?: VariableScope
  readonly?: boolean
  state?: boolean
  description?: string
  updatedAt?: number
}

export function summarizeForMetadata(snapshot: RuntimeContextVariable[]): JsonObject[] {
  return snapshot.map(v => ({
    name: v.name,
    value: v.value,
    values: v.values,
    type: v.type,
    scope: v.scope,
    readonly: v.readonly,
    state: v.state,
    description: v.description,
    updatedAt: v.updatedAt,
  })) as unknown as JsonObject[]
}

function formatAge(updatedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function byName(a: RuntimeContextVariable, b: RuntimeContextVariable): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * `keys` 的投影:只有 name/type/scope/desc,**不带值**。非 state 变量一个字节都不
 * 进请求,能不能被找回来全靠这一步。按名字排序:字典序比 provider 优先级好找。
 */
export function renderKeysForOutput(snapshot: RuntimeContextVariable[], scope?: VariableScope): string {
  const rows = snapshot.filter(v => !scope || (v.scope ?? 'session') === scope).sort(byName)
  if (rows.length === 0) {
    return scope ? `No variables in ${scope} scope.` : 'No context variables are set.'
  }
  return rows
    .map(v => {
      const flags = `${v.type && v.type !== 'string' ? ` [${v.type}]` : ''}${v.scope ? ` [${v.scope}]` : ''}${v.readonly ? ' [readonly]' : ''}${v.state ? ' [state]' : ''}`
      return `${v.name}${flags}${v.description ? ` - ${v.description}` : ''}`
    })
    .join('\n')
}

export function renderForOutput(snapshot: RuntimeContextVariable[], now: number = Date.now()): string {
  if (snapshot.length === 0) return 'No context variables are set.'
  return snapshot
    .map(v => {
      // 工具输出永远不进缓存前缀,所以这里给的是实时相对时间(提示词段落里不行)。
      const age = v.updatedAt ? ` [updated ${formatAge(v.updatedAt, now)}]` : ''
      const flags = `${v.type && v.type !== 'string' ? ` [${v.type}]` : ''}${v.scope ? ` [${v.scope}]` : ''}${v.readonly ? ' [readonly]' : ''}${v.state ? ' [state]' : ''}${age}`
      const desc = v.description ? ` - ${v.description}` : ''
      if (v.values && v.values.length > 0) {
        return `${v.name} = ${v.value || '(empty)'}\nvalues:\n${v.values.map((value, index) => `  [${index}] ${value}${index === 0 && v.value ? ' (current)' : ''}`).join('\n')}${flags}${desc}`
      }
      return `${v.name} = ${v.value || '(empty)'}${flags}${desc}`
    })
    .join('\n')
}

/**
 * 一次 registry.list 之后按 action 投影输出。`get` 走全量渲染但只喂一条:**值不
 * 截断** —— 长值因此永远捞得回来。
 */
export function renderOutputForAction(
  action: VariableAction,
  snapshot: RuntimeContextVariable[],
  args: { name?: string; scope?: VariableScope },
): string {
  if (action === 'keys') return renderKeysForOutput(snapshot, args.scope)
  if (action === 'get') {
    const name = args.name?.trim()
    if (!name) throw new Error('name is required for get')
    const found = snapshot.find(v => v.name === name)
    // 读不到不算错:回一句能自救的话,比抛一个模型只能重试的异常有用。
    if (!found) return `No variable named "${name}". Use action="keys" to see what exists.`
    return renderForOutput([found])
  }
  return renderForOutput(snapshot)
}

export function metadataTitleForAction(action: VariableAction, name: string | undefined): string {
  if (action === 'list') return 'Listed variables'
  if (action === 'keys') return 'Listed variable names'
  return `${action[0].toUpperCase()}${action.slice(1)} ${name ?? ''}`.trim()
}
