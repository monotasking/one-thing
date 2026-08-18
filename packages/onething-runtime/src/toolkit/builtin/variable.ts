/**
 * R1 移植 —— `variable`。
 *
 * 它**不属于** R1 的四个家族里的任何一个:普通变量是无副作用的读写(会话的上下文
 * 板),而能力变量(workdir、笔记目录…)改的是"系统能够到哪里",那是一条
 * `capability_change` 效果。§4 把它排在 `ReadOnlyTool` 与 `CapabilityTool` 之间,
 * 两族都不完全是它 —— R1 因此让它直接继承 `Tool`,等 R3 的 `CapabilityTool` 落地
 * 时再归族(把一个只有一个成员的家族提前建起来,那个家族只会长成这只工具的形状)。
 *
 * 描述、参数、提示词、渲染口径逐字沿用旧 `tools/builtin/variable.ts`;渲染在
 * `variable-render.ts`。
 */

import { z } from 'zod'
import { Intent, makeEffect, Tool } from '@onething/core/toolkit'
import type { CoreToolPromptContribution } from '@onething/core/engine'
import type { PlanContext, Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import { isCapabilityVariable } from '../../variables/types.js'
import type { VariableScope, VariableType } from '../../variables/types.js'
import contextVariablesRaw from '../../tools/builtin/prompts/variable-context.md?raw'
import { defineInput } from '../contract.js'
import {
  metadataTitleForAction,
  renderOutputForAction,
  summarizeForMetadata,
  VARIABLE_READ_ACTIONS,
  type RuntimeContextVariable,
  type VariableAction,
} from './variable-render.js'

export type { VariableAction, RuntimeContextVariable }

/**
 * 见 write.ts:R2a 决定② 之后它挂回 `spec.prompt`。variable 是那条决定的判据
 * 本身 —— 它三类(guidelines / workspaceRules / sections)里用了两类,一格结构
 * 装不下。
 */
export const VARIABLE_TOOL_PROMPT: CoreToolPromptContribution = {
  workspaceRules: [
    'To change the work directory, call `variable` with action="set", name="workdir", value=<directory>.',
  ],
  sections: [
    {
      id: 'context-variables',
      content: `<context-variables>\n${contextVariablesRaw.replace(/\n+$/, '')}\n</context-variables>`,
    },
  ],
}

export interface RuntimeVariableContext {
  sessionId: string
  messageId?: string
  toolCallId?: string
}

export interface RuntimeVariableSetInput {
  name: string
  value: string
  scope?: VariableScope
  type?: VariableType
  description?: string
  state?: boolean
}

export interface RuntimeVariableRegistry {
  list(ctx: RuntimeVariableContext): Promise<RuntimeContextVariable[]> | RuntimeContextVariable[]
  set(ctx: RuntimeVariableContext, input: RuntimeVariableSetInput): Promise<RuntimeContextVariable> | RuntimeContextVariable
  append(ctx: RuntimeVariableContext, input: RuntimeVariableSetInput): Promise<RuntimeContextVariable> | RuntimeContextVariable
  remove(ctx: RuntimeVariableContext, input: RuntimeVariableSetInput): Promise<RuntimeContextVariable> | RuntimeContextVariable
  delete(ctx: RuntimeVariableContext, name: string, scope?: VariableScope): Promise<void> | void
}

export interface VariableToolAdapters {
  getRegistry(): RuntimeVariableRegistry
  isVariableError?(error: unknown): boolean
}

export const VariableInputSchema = z.object({
  action: z.enum(['list', 'get', 'keys', 'set', 'append', 'remove', 'delete']).describe(
    'list: show every variable with its value. get: one variable, value in full. keys: names only (what exists, without paying to read it). set: create or replace a value. append/remove: add or drop an element of a collection variable (or a workdir sandbox root). delete: drop the whole variable.',
  ),
  name: z.string().optional().describe('Variable name (required for get/set/append/remove/delete).'),
  value: z.string().optional().describe(
    'Variable value (required for set/append/remove). Collections take compact JSON on set; append/remove take a single element (JSON, or plain text for a string element) - map append merges a JSON object, map remove takes the key. Directory variables (workdir, note dirs) take an existing directory path.',
  ),
  type: z.enum(['string', 'number', 'bool', 'list', 'map', 'set']).optional().describe(
    'Value type. Defaults to the existing type, else "string". number accepts decimals; list/map hold JSON; set is a list with unique elements. append on a missing variable creates it (default list).',
  ),
  scope: z.enum(['session', 'global', 'agent', 'project']).optional().describe(
    "Where the variable lives: session (default), agent (every session of the current agent), project (the active workdir's project; requires a workdir), global (all sessions). A name lives in one scope; a write without scope follows the variable to its current scope. On keys it filters the listing instead.",
  ),
  description: z.string().optional().describe(
    'Short description shown next to the value in the prompt and the Context inspector. Sticky: omitted on later writes it is kept; "" clears it.',
  ),
  state: z.boolean().optional().describe(
    'true: you need to know this at all times — it is delivered in full in every <context-update> block from now on. false (default): it stays on the board but out of your context; read it back with get when you need it. Sticky across writes.',
  ),
})

export const VARIABLE_DESCRIPTION = `Read and manage context variables — the session's board of named runtime facts and kept settings.

The board is context to read, not a place to park your own working state: write only when the user asks for something to be kept or changed, or when operating a lever the board owns (e.g. workdir) — never for progress, findings or intermediate results. System variables (workdir, note dirs, background_jobs, git_branch, ...) explain themselves via their description in list output.

state=true puts a variable in front of you (it arrives in full in every <context-update>); everything else stays on the board until you read it — keys lists names, get reads one in full. Values are typed (string, number, bool, list, map, set; collections support append/remove) with an optional description, in one of four scopes: session, agent, project, global. Custom names are non-reserved snake_case.`

const VariableContract = defineInput(VariableInputSchema)

export type VariableInput = z.infer<typeof VariableInputSchema>

export class VariableTool extends Tool<VariableInput, VariableInput> {
  private readonly adapters: VariableToolAdapters

  readonly spec: ToolSpec = {
    id: 'variable',
    title: 'Variable',
    description: VARIABLE_DESCRIPTION,
    input: VariableContract.schema,
    effects: ['capability_change'],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'sequential',
    prompt: VARIABLE_TOOL_PROMPT,
  }

  constructor(adapters: VariableToolAdapters) {
    super()
    this.adapters = adapters
  }

  /**
   * 普通变量是会话上下文板上的一条,无摩擦 —— 无效果、不打扰任何人。能力变量不同:
   * 它的值是一个系统会照着动手的目录,所以重指它是一个**提议**,由用户批准。
   */
  async plan(input: VariableInput, _ctx: PlanContext): Promise<Intent<VariableInput>> {
    const name = input.name?.trim()
    if (!name || VARIABLE_READ_ACTIONS.has(input.action) || !isCapabilityVariable(name)) {
      return Intent.none(input)
    }

    const value = input.value?.trim()
    const title = input.action === 'delete'
      ? `Reset ${name} to its default`
      : `Repoint ${name} to: ${value || ''}`

    return Intent.of({
      effects: [makeEffect('capability_change', value ? [value] : [name], {
        barrier: true,
        metadata: { variable: name, value, action: input.action },
      })],
      preview: { title, metadata: { variable: name, value } },
      payload: input,
    })
  }

  async apply(intent: Intent<VariableInput>, ctx: RunContext): Promise<Result> {
    const args = intent.payload
    const registry = this.adapters.getRegistry()
    const variableCtx: RuntimeVariableContext = {
      sessionId: ctx.invocation.sessionId,
      messageId: ctx.invocation.messageId,
      toolCallId: ctx.invocation.callId,
    }
    const action: VariableAction = args.action

    try {
      if (action === 'set' || action === 'append' || action === 'remove') {
        if (!args.name) throw new Error(`name is required for ${action}`)
        if (args.value === undefined) throw new Error(`value is required for ${action}`)
        const input: RuntimeVariableSetInput = {
          name: args.name,
          value: args.value,
          scope: args.scope,
          type: args.type,
          description: args.description,
          state: args.state,
        }
        if (action === 'set') await registry.set(variableCtx, input)
        else if (action === 'append') await registry.append(variableCtx, input)
        else await registry.remove(variableCtx, input)
      } else if (action === 'delete') {
        if (!args.name) throw new Error('name is required for delete')
        await registry.delete(variableCtx, args.name, args.scope)
      }

      const snapshot = await registry.list(variableCtx)
      const variables = summarizeForMetadata(snapshot)
      const output = renderOutputForAction(action, snapshot, args)
      const details = { action, name: args.name, variables }

      ctx.emit({
        type: 'partial',
        result: { content: [{ type: 'text', text: output }], details: { phase: 'ready', ...details } },
      })
      ctx.emit({ type: 'annotate', title: metadataTitleForAction(action, args.name), details })
      // 旧 ToolResult.title —— 与 metadata 的标题是两个值,渲染器两个都用。
      ctx.emit({
        type: 'annotate',
        title: VARIABLE_READ_ACTIONS.has(action) ? 'Variables' : `Variable ${action}`,
        details,
      })

      return { content: [{ type: 'text', text: output }], details }
    } catch (error) {
      throw this.normalizeError(error)
    }
  }

  /** 变量系统自己的错误带 code,拆出来拼进消息;其余原样往上抛。 */
  private normalizeError(error: unknown): unknown {
    if (this.adapters.isVariableError?.(error) && error instanceof Error) {
      const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
      const normalized = new Error(code ? `[${code}] ${error.message}` : error.message)
      normalized.name = error.name
      return normalized
    }
    return error
  }
}

export function createVariableTool(adapters: VariableToolAdapters): VariableTool {
  return new VariableTool(adapters)
}
