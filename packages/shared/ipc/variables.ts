/**
 * Variable subsystem IPC types — scalar variables only.
 *
 * Three RPCs, all on the generic router (`variablesRouter`, below — 结构债 P4c
 * 之后再没有 `VARIABLES_*` 手写通道了):
 *   - list   : pull a snapshot for a session
 *   - set    : set a variable (workdir or custom)
 *   - delete : delete a custom variable
 *
 * Project directories live in their own module — see
 * `ipc/project-dirs.ts`.
 *
 * Live updates flow through the existing `session:variables-updated`
 * event on SESSION_EVENT, so renderer code only needs LIST for the
 * initial fetch.
 */

import { defineRouter } from './router.js'
import type { ContextVariable, VariableScope, VariableType } from './chat.js'

export interface VariablesListRequest {
  sessionId: string
}

export interface VariablesListResponse {
  success: boolean
  variables?: ContextVariable[]
  error?: string
  /** Stable error code (matches main-process VariableErrorCode). */
  code?: string
}

export interface VariablesSetRequest {
  sessionId: string
  name: string
  value: string
  scope?: VariableScope
  type?: VariableType
  description?: string
  state?: boolean
}

export interface VariablesSetResponse {
  success: boolean
  variable?: ContextVariable
  error?: string
  code?: string
}

export interface VariablesDeleteRequest {
  sessionId: string
  name: string
  scope?: VariableScope
}

export interface VariablesDeleteResponse {
  success: boolean
  error?: string
  code?: string
}

/**
 * variables(标量变量)域 —— 结构债 P4c 第二域。
 *
 * 三个方法全是**纯数据面**:读一个会话的变量快照、写一个、删一个。判定与错误
 * 码(`VariableError` → `{ success:false, error, code }`)住在
 * `@onething/runtime/variables` 的投影里,传输面只把注册表接上去。
 *
 * 与被删掉的那条线的差别:壳上那三个方法是**位置参数**的
 * (`setVariable(sessionId, name, value, description, scope)`),信封化之后位置
 * 参数在这条通道上没有位置 —— 请求形状回到契约层本来就写好的
 * `VariablesSetRequest`,少一处「壳自己排的参数顺序」可以排错。
 *
 * 实时更新不走这个域:变量变化经 `session:variables-updated` 会话事件推,
 * 所以渲染侧只需要 `list` 拉一次初始快照。
 */
export type VariablesRoutes = {
  list: { input: VariablesListRequest; output: VariablesListResponse }
  set: { input: VariablesSetRequest; output: VariablesSetResponse }
  delete: { input: VariablesDeleteRequest; output: VariablesDeleteResponse }
}

export const variablesRouter = defineRouter<VariablesRoutes>('variables', [
  'list',
  'set',
  'delete',
])
