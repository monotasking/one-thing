/**
 * R1 对拍的夹具层:把**同一组输入**分别喂给旧实现(`create*Tool` + 直接调
 * `analyze` / `execute`)与新实现(`new XxxTool` + `ToolRunner.run`),再把两边的
 * 产物摆成可比较的形状。
 *
 * 端口一律用 R0 的内存 fakes(`core/toolkit/__tests__/fakes.ts`)—— 那个文件存在的
 * 意义就是"用一个假 RunContext 单测任何工具"(尺子⑤),这里是它的第一个真实用户。
 */

import { ToolRunner } from '@onething/core/toolkit'
import type {
  Authorizer,
  Intent,
  Invocation,
  JobRegistry,
  ObservedEvent,
  Outcome,
  Result,
  SessionSnapshot,
  Tool,
  ToolEvent,
} from '@onething/core/toolkit'
import { allowAuthorizer, RecordingObserver } from '../../../../core/toolkit/__tests__/fakes.js'
import { ZodValidator } from '../contract.js'

export interface RunOptions {
  /**
   * 授权者。默认恒 allow;传一个"在 decide 里动手脚"的实现,就精确复刻了
   * 「审批期间文件被改了」那个窗口 —— 那正是 plan 与 apply 之间的那段时间。
   */
  authorizer?: Authorizer
  sessionId?: string
  messageId?: string
  callId?: string
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  signal?: AbortSignal
  /** 后台执行体的注册表端口。不给 = `ctx.jobs.spawn` 会报"没绑端口"。 */
  jobs?: JobRegistry
}

export interface NewRun {
  outcome: Outcome
  observer: RecordingObserver
  /** `lifecycle:planned` 里的那个 Intent —— 权限层看到的全部输入。 */
  intent: Intent
  events: ObservedEvent[]
}

function sessionFor(options: RunOptions): SessionSnapshot {
  return {
    id: options.sessionId ?? 'test-session',
    workspaceRoot: options.workingDirectory,
  }
}

export function invocationFor(toolId: string, input: unknown, options: RunOptions = {}): Invocation {
  return {
    callId: options.callId ?? 'test-call',
    toolId,
    input,
    sessionId: options.sessionId ?? 'test-session',
    messageId: options.messageId ?? 'test-message',
    principal: { kind: 'user', userId: 'local' },
    cwd: options.workingDirectory,
    workspaceRoot: options.workingDirectory,
    // R2a 决定①:根列表是调用坐标上的一等字段,不再藏在会话快照的 metadata 里。
    workingDirectoryRoots: options.workingDirectoryRoots,
  }
}

/** 跑新实现的一次完整生命周期。 */
export async function runNewTool(
  tool: Tool,
  input: unknown,
  options: RunOptions = {},
): Promise<NewRun> {
  const observer = new RecordingObserver()
  const runner = new ToolRunner({
    authorizer: options.authorizer ?? allowAuthorizer,
    observer,
    validator: new ZodValidator(),
    jobs: options.jobs,
    session: () => sessionFor(options),
  })
  const outcome = await runner.run(tool, invocationFor(tool.spec.id, input, options), options.signal)
  const planned = observer.events
    .map(entry => entry.event)
    .find(event => event.type === 'lifecycle' && event.phase === 'planned')
  return {
    outcome,
    observer,
    intent: (planned as { intent: Intent } | undefined)?.intent as Intent,
    events: observer.events.map(entry => entry.event),
  }
}

// ── 旧实现侧 ────────────────────────────────────────────────────────────────

export interface LegacyRecord {
  metadataCalls: Array<{ title?: string; metadata?: Record<string, unknown> }>
  updates: Array<Record<string, unknown>>
}

/**
 * 复刻旧管线交给工具的那个 ctx。`analyze → approvedAnalysis` 那一跳由调用方补
 * (`ctx.approvedAnalysis = await tool.analyze(args, ctx)`)—— 那正是旧管线做的事。
 */
export function legacyContext(options: RunOptions = {}): {
  ctx: Record<string, unknown>
  record: LegacyRecord
} {
  const record: LegacyRecord = { metadataCalls: [], updates: [] }
  const ctx: Record<string, unknown> = {
    sessionId: options.sessionId ?? 'test-session',
    messageId: options.messageId ?? 'test-message',
    toolCallId: options.callId ?? 'test-call',
    workingDirectory: options.workingDirectory,
    workingDirectoryRoots: options.workingDirectoryRoots,
    abortSignal: options.signal,
    metadata(input: { title?: string; metadata?: Record<string, unknown> }) {
      record.metadataCalls.push(input)
    },
    updateResult(input: Record<string, unknown>) {
      record.updates.push(input)
    },
    async beforeSideEffect() {},
  }
  return { ctx, record }
}

// ── 投影:把两边摆成可比的形状 ────────────────────────────────────────────

/**
 * 新结果里模型看到的**文本**。
 *
 * 刻意不用 `Outcome.toModelText`:canonical `Result` 把附件折进了 `content`,而
 * `resultToText` 会给 file/image part 补一行 `[File: …]` 占位 —— 旧的 `output`
 * 字符串里没有那一行(附件走 `attachments` 字段)。R2 的 IpcProjector 必须把
 * content 拆回 output + attachments 才能保持边缘契约不变;对拍在这里比的是同一
 * 个东西:纯文本 part。
 */
export function modelTextOf(outcome: Outcome): string {
  if (outcome.kind !== 'ok') return ''
  return textPartsOf(outcome.result)
}

export function textPartsOf(result: Result): string {
  return result.content
    .filter(part => part.type === 'text')
    .map(part => part.text ?? '')
    .join('\n')
}

export function attachmentsOf(result: Result): Array<Record<string, unknown>> {
  return result.content
    .filter(part => part.type !== 'text')
    .map(part => ({ ...part }))
}

export function toolEventsOf(run: NewRun): ToolEvent[] {
  return run.events.filter((event): event is ToolEvent => event.type !== 'lifecycle')
}

export function annotationsOf(run: NewRun): Array<{ title?: string; details?: Record<string, unknown> }> {
  return toolEventsOf(run)
    .filter((event): event is Extract<ToolEvent, { type: 'annotate' }> => event.type === 'annotate')
    .map(event => ({ title: event.title, details: event.details as Record<string, unknown> | undefined }))
}

export function partialsOf(run: NewRun): Result[] {
  return toolEventsOf(run)
    .filter((event): event is Extract<ToolEvent, { type: 'partial' }> => event.type === 'partial')
    .map(event => event.result)
}

/** 新旧两边"权限层看到的东西"。effects 与 preview 是唯一的授权输入。 */
export function permissionInputOf(intent: Intent): { effects: unknown[]; preview: unknown } {
  return { effects: intent.effects.map(effect => ({ ...effect })), preview: intent.preview }
}

/** 一个所有键都在、值可比的普通对象(旧 effect 与新 Effect 的字段是同名同义的)。 */
export function normalizeEffects(effects: readonly unknown[]): unknown[] {
  return effects.map(effect => JSON.parse(JSON.stringify(effect)) as unknown)
}

/**
 * R3a 对拍用:把两边的渲染载荷摆成可比的形状。
 *
 * 两处**非语义**差异要抹掉,别的一个都不抹:
 *  1. `undefined` 值的键 —— 新树的 `details` 过一次 `toJsonObject`(它按 JSON 语义
 *     丢掉 undefined),旧的 metadata 是原样的对象。两者序列化到 IPC 之后逐字相同,
 *     所以这是一次归一化,不是一次丢失。
 *  2. 计时字段(`fetchMs` 之类)—— 它是墙钟的函数,两次调用本来就不相等。
 */
export function normalizeDetails(value: unknown, dropKeys: readonly string[] = ['fetchMs']): unknown {
  const stripped = JSON.parse(JSON.stringify(value ?? null)) as unknown
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        if (dropKeys.includes(key)) continue
        out[key] = walk(item)
      }
      return out
    }
    return node
  }
  return walk(stripped)
}

/**
 * R4b —— 金标里的临时目录归一。
 *
 * 文件类工具的输出里嵌着 `mkdtemp` 造出来的绝对路径,它每次都不一样。快照要能
 * 签下来,就得把那一段换成一个稳定的占位符。**只换这一件事** —— 别的字节一个
 * 都不动。
 */
export function redactPaths(value: unknown, ...dirs: string[]): unknown {
  const json = JSON.stringify(value ?? null)
  if (json === undefined) return value
  let out = json
  dirs.forEach((dir, index) => {
    if (!dir) return
    out = out.split(JSON.stringify(dir).slice(1, -1)).join(`<DIR${dirs.length > 1 ? index : ''}>`)
  })
  return JSON.parse(out) as unknown
}

/** 字符串版的 `redactPaths`(模型文本那一格)。 */
export function redactText(text: string, ...dirs: string[]): string {
  let out = text
  dirs.forEach((dir, index) => {
    if (!dir) return
    out = out.split(dir).join(`<DIR${dirs.length > 1 ? index : ''}>`)
  })
  return out
}
