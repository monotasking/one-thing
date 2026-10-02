/**
 * ACP 会话级状态的 reducer(A0-2,方案 `docs/design/acp-integration-2026-09.md` §3.3)。
 *
 * ACP 十六种 `session/update` 里,文本 / 思考 / 工具 / 压缩摘要是「这一轮说了什么」,归回合事件流
 * (`translate.ts`);其余十种是**会话的状态**,agent 可以在没有 prompt 在飞时推(`session/new`
 * 一返回就推 `available_commands_update` 是常态)。这里把后者折进一张表。
 *
 * 纯函数:同一输入同一输出,时间由调用方递进来。**没变就原样返回同一只对象** —— 客户端靠
 * 对象身份判断要不要广播,于是重复推同一份命令表不会在 SSE 上多出一帧。
 */
import { fileURLToPath } from 'node:url'
import type { SessionConfigOption, SessionModeState, SessionUpdate } from '@agentclientprotocol/sdk'
import type {
  ACPSessionOption,
  ACPSessionOptionChoice,
  AcpPlanEntry,
  AcpSessionNotice,
  AcpSessionPlan,
  AcpSessionProcess,
  AcpSessionState,
} from '@shared/contracts/acp.js'

export type { AcpSessionState } from '@shared/contracts/acp.js'

/** 通知只留最近这么多条;壳要的是「最近发生了什么」,不是一本账。 */
export const ACP_SESSION_NOTICE_LIMIT = 20

export interface AcpSessionStateSeed {
  localSessionId: string
  agentId: string
  acpSessionId?: string
  process?: AcpSessionProcess
}

export function createAcpSessionState(seed: AcpSessionStateSeed): AcpSessionState {
  return {
    localSessionId: seed.localSessionId,
    agentId: seed.agentId,
    ...(seed.acpSessionId ? { acpSessionId: seed.acpSessionId } : {}),
    configOptions: [],
    commands: [],
    notices: [],
    process: seed.process ?? { status: 'disconnected' },
  }
}

/** 这张表很小(几十格),拿序列化比对换一份不会漏字段的相等判断。 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 只在 `key` 那一格真的变了时才换新对象;`undefined` 意为删掉那一格。 */
function withField<K extends keyof AcpSessionState>(
  state: AcpSessionState,
  key: K,
  value: AcpSessionState[K] | undefined,
): AcpSessionState {
  if (same(state[key], value)) return state
  const next = { ...state }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

/**
 * ACP `configOptions` → 会话状态里的选项:`select`(分组拍平)与 `boolean` 都收。
 * 与 `projectACPConfigOptions`(只收 `select`,喂选择器与 `setConfigOption` 的回写)分开 ——
 * 那条路今天只会写字符串值,把布尔格混进去会让它写出 agent 不认的值。
 */
export function projectACPSessionStateOptions(
  configOptions: readonly SessionConfigOption[] | null | undefined,
): ACPSessionOption[] {
  const out: ACPSessionOption[] = []
  for (const option of configOptions ?? []) {
    const base = {
      id: option.id,
      name: option.name,
      ...(option.description ? { description: option.description } : {}),
      ...(option.category ? { category: option.category } : {}),
    }
    if (option.type === 'boolean') {
      out.push({
        ...base,
        type: 'boolean',
        currentValue: option.currentValue ? 'true' : 'false',
        choices: [
          { value: 'true', name: 'On' },
          { value: 'false', name: 'Off' },
        ],
      })
      continue
    }
    if (option.type !== 'select') continue
    const choices: ACPSessionOptionChoice[] = []
    for (const entry of option.options) {
      if ('group' in entry) {
        for (const choice of entry.options) choices.push(projectChoice(choice, entry.name))
      } else {
        choices.push(projectChoice(entry))
      }
    }
    out.push({ ...base, currentValue: option.currentValue, choices })
  }
  return out
}

function projectChoice(
  choice: { value: string; name: string; description?: string | null },
  group?: string,
): ACPSessionOptionChoice {
  return {
    value: choice.value,
    name: choice.name,
    ...(choice.description ? { description: choice.description } : {}),
    ...(group ? { group } : {}),
  }
}

function projectModes(modes: SessionModeState): NonNullable<AcpSessionState['modes']> {
  return {
    current: modes.currentModeId,
    available: modes.availableModes.map(mode => ({
      id: mode.id,
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
    })),
  }
}

function projectEntries(entries: ReadonlyArray<AcpPlanEntry>): AcpPlanEntry[] {
  return entries.map(entry => ({ content: entry.content, priority: entry.priority, status: entry.status }))
}

/** `file` 形计划的地址:`file:` URI 落成本机路径,别的 scheme 原样留着(读不读是投影的事)。 */
function planPath(uri: string): string {
  if (!uri.startsWith('file:')) return uri
  try {
    return fileURLToPath(uri)
  } catch {
    return uri
  }
}

function noticeSeverity(severity: string): AcpSessionNotice['severity'] {
  return severity === 'warning' || severity === 'error' ? severity : 'info'
}

/**
 * 新开 / 恢复会话的答复里带的初值(`modes` / `configOptions`)。字段缺席 = 不动那一格:
 * agent 没在答复里说,不等于它没有 —— 也许下一条 `current_mode_update` 就来。
 */
export function seedAcpSessionState(
  state: AcpSessionState,
  response: { modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null },
): AcpSessionState {
  let next = state
  if (response.modes) next = withField(next, 'modes', projectModes(response.modes))
  if (response.configOptions) next = withField(next, 'configOptions', projectACPSessionStateOptions(response.configOptions))
  return next
}

/** 承载这条会话的进程变了(连上 / 断开 / 出错 / 换 pid)。 */
export function withAcpSessionProcess(state: AcpSessionState, process: AcpSessionProcess): AcpSessionState {
  return withField(state, 'process', {
    status: process.status,
    ...(process.error ? { error: process.error } : {}),
    ...(process.pid !== undefined ? { pid: process.pid } : {}),
  })
}

/**
 * 一条 `session/update` 折进会话状态。十六种全列:回合那六种显式不动(它们归回合事件流),
 * 没见过的新种类也不动 —— 协议往前长,这张表不该因此抛。
 */
export function applySessionUpdate(state: AcpSessionState, update: SessionUpdate, now: number = Date.now()): AcpSessionState {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call':
    case 'tool_call_update':
    case 'compaction_summary_chunk':
      return state

    case 'available_commands_update':
      return withField(state, 'commands', update.availableCommands.map(command => ({
        name: command.name,
        description: command.description,
        ...(command.input?.hint ? { inputHint: command.input.hint } : {}),
      })))

    case 'current_mode_update': {
      // 模式表没随会话答复来(agent 只推当前 id):仍记下当前值,可选列表留空等下一次。
      const available = state.modes?.available ?? []
      return withField(state, 'modes', { current: update.currentModeId, available })
    }

    case 'config_option_update':
      return withField(state, 'configOptions', projectACPSessionStateOptions(update.configOptions))

    case 'session_info_update': {
      // 缺席 = 不动;`null` = agent 明说清掉。
      const info = { ...(state.info ?? {}) }
      if (update.title === null) delete info.title
      else if (update.title !== undefined) info.title = update.title
      if (update.updatedAt === null) delete info.updatedAt
      else if (update.updatedAt !== undefined) info.updatedAt = update.updatedAt
      return withField(state, 'info', Object.keys(info).length > 0 ? info : undefined)
    }

    case 'usage_update':
      return withField(state, 'usage', {
        used: update.used,
        size: update.size,
        ...(update.cost ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {}),
      })

    case 'notice': {
      const notice: AcpSessionNotice = {
        severity: noticeSeverity(update.severity),
        title: update.title,
        ...(update.description ? { description: update.description } : {}),
        at: now,
      }
      return { ...state, notices: [...state.notices, notice].slice(-ACP_SESSION_NOTICE_LIMIT) }
    }

    case 'plan':
      // 旧式整份计划:没有 id,每次整张替换。
      return withField(state, 'plan', { kind: 'items', entries: projectEntries(update.entries) })

    case 'plan_update': {
      const plan = update.plan
      let next: AcpSessionPlan
      if (plan.type === 'items') next = { kind: 'items', planId: plan.planId, entries: projectEntries(plan.entries) }
      else if (plan.type === 'markdown') next = { kind: 'markdown', planId: plan.planId, markdown: plan.content }
      else if (plan.type === 'file') next = { kind: 'file', planId: plan.planId, path: planPath(plan.uri) }
      else return state
      return withField(state, 'plan', next)
    }

    case 'plan_removed':
      // 只删 id 对得上的那份;眼前那份没有 id(旧式整份)时,agent 说删就删。
      if (!state.plan) return state
      if (state.plan.planId && state.plan.planId !== update.planId) return state
      return withField(state, 'plan', undefined)

    case 'compaction_update': {
      if (update.status === 'in_progress') {
        if (state.compaction?.status === 'in_progress') return state
        return withField(state, 'compaction', { status: 'in_progress', startedAt: now })
      }
      // completed / failed / cancelled / 扩展值:都算这一次压缩收场了。
      return withField(state, 'compaction', { status: 'done', startedAt: state.compaction?.startedAt ?? now })
    }

    default:
      return state
  }
}
