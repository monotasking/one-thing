/**
 * **外部工具的副作用面**(P0-4,`docs/audit/claude-code-sdk-audit-2026-08-11.md`)。
 *
 * 在此之前,SDK 会话里的每一次工具调用只合成**一个**以工具名为资源的
 * `external-agent` effect:审批卡上写「Claude Code: Bash」,grant 记的也是
 * 「Bash」。于是一次「总是允许 Bash」等于此后**任何命令**免审 —— 而同一条
 * `rm -rf ./dist` 在本地会话里是按 `rm *` 记的。粒度差一档,信任面就差一个量级。
 *
 * 这里做的事只有一件:把 SDK 的 `(toolName, input)` 翻成与**本地工具逐字同形**的
 * effect,交给同一扇策略门。命令分析不在这里重写,而是调本地 bash 工具用的那一个
 * (`../tools/permission-effects.js` 的 `analyzeBashPermission`);文件工具的越界位
 * (`external`)也用本地那套沙箱判据算出来 —— 批 1 刚修的 auto-accept 判据正是只
 * 看这一位(`runtime/permissions/permission-policy.ts:146`),立不起来就等于外部会话的
 * 越界写在 `auto-accept-edits` 下一张卡都不弹。
 *
 * **认不出的工具名维持现状**:返回 `undefined`,调用方回落到工具名粒度的
 * `external-agent` effect。不认识不等于放行 —— 这里没有 fail-open 的分支。
 *
 * 工具名与 input 形状当年核自 Claude SDK 的 `sdk-tools.d.ts`(SDK 连接器 A6-b 退役;今天
 * 的调用方是 `describeAcpToolPermission`,它把 ACP 的 `kind` 归一成这几个名字):
 * `BashInput.command`、`FileReadInput/FileWriteInput/FileEditInput.file_path`、
 * `NotebookEditInput.notebook_path`。`MultiEdit` 在当前这版 d.ts 里已经没有独立的
 * input 类型(`Edit` 用 `replace_all` 吸收了它),这里仍留一行:老版本 CLI 还会发
 * 这个名字,而它的 `file_path` 位置是一样的。
 */

import { basenamePath, joinPaths, dirnamePath } from '@onething/backend/runtime/storage/storage-primitives'
import type { ToolEffect, ToolPreview } from '@onething/backend/runtime/tools/tool-helpers'
import type { Effect } from '@shared/toolkit/effects'
import type { JsonObject, JsonValue } from '@shared/json'
import {
  analyzeBashPermission,
  filePermissionPattern,
} from '../tools/permission-effects.js'
import {
  findCoreReadSandboxRootForPath,
  findCoreSandboxRootForPath,
  getCoreSandboxBoundary,
  getCoreSandboxRoots,
  resolveCoreToolPath,
} from '../tools/sandbox.js'
import { classifySensitiveFile } from '../tools/sensitive-files.js'

export interface ExternalToolPermissionInput {
  /** SDK 侧的工具名,未归一化(宿主工具不会走到这里,它们在连接器里就分家了)。 */
  toolName: string
  input: unknown
  /** 这次外部会话的工作目录;缺席时退回进程 cwd(与本地工具同一条兜底)。 */
  cwd?: string
}

export interface ExternalToolPermissionShape {
  effects: ToolEffect[]
  /**
   * 缺席是有意的:`titleForEffect` 会按 effect 种类给出与本地同款的标题
   * (`Write file: …` / `Read sensitive file: …` / `Access directory outside project: …`)。
   * 只有 bash 例外 —— 本地卡的标题是命令原文,这里照抄。
   */
  preview?: ToolPreview
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readStringField(input: unknown, ...names: string[]): string | undefined {
  const record = asRecord(input)
  if (!record) return undefined
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

export function describeExternalToolPermission(
  input: ExternalToolPermissionInput,
): ExternalToolPermissionShape | undefined {
  const sandbox = { workingDirectory: input.cwd }

  switch (input.toolName) {
    case 'Bash': {
      const command = readStringField(input.input, 'command')
      if (!command) return undefined
      return analyzeBashPermission({
        command,
        workingDirectory: getCoreSandboxBoundary(sandbox),
        sandboxRoots: getCoreSandboxRoots(sandbox),
      })
    }

    case 'Read': {
      const path = readStringField(input.input, 'file_path')
      return path ? describeRead(resolveCoreToolPath(path, sandbox), sandbox) : undefined
    }

    case 'Write': {
      const path = readStringField(input.input, 'file_path')
      return path
        ? describeFileMutation('file_write', resolveCoreToolPath(path, sandbox), sandbox)
        : undefined
    }

    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const path = readStringField(input.input, 'file_path', 'notebook_path')
      return path
        ? describeFileMutation('file_edit', resolveCoreToolPath(path, sandbox), sandbox)
        : undefined
    }

    default:
      return undefined
  }
}

/** 与 `tools/builtin/read.ts` 的 analyze 逐条对齐(越界目录 + 敏感文件两位)。 */
function describeRead(
  resolvedPath: string,
  sandbox: { workingDirectory?: string },
): ExternalToolPermissionShape {
  const boundary = getCoreSandboxBoundary(sandbox)
  const matchedRoot = findCoreReadSandboxRootForPath(resolvedPath, sandbox)
  const sensitivity = classifySensitiveFile(resolvedPath)
  const effects: ToolEffect[] = []

  if (!matchedRoot) {
    effects.push({
      kind: 'external_directory',
      resources: [joinPaths(dirnamePath(resolvedPath), '*')],
      barrier: true,
      external: true,
      metadata: {
        path: resolvedPath,
        boundary,
        operation: 'Read file',
        targetType: 'file',
      },
    })
  }

  effects.push({
    kind: sensitivity.sensitive ? 'sensitive_file_read' : 'read',
    resources: [resolvedPath],
    barrier: sensitivity.sensitive,
    sensitive: sensitivity.sensitive,
    metadata: sensitivity.sensitive
      ? { path: resolvedPath, category: sensitivity.category, reason: sensitivity.reason }
      : { path: resolvedPath },
  })

  return {
    effects,
    preview: {
      title: sensitivity.sensitive
        ? `Read sensitive file: ${basenamePath(resolvedPath)}`
        : `Read ${basenamePath(resolvedPath)}`,
      path: resolvedPath,
    },
  }
}

/**
 * 与 `tools/builtin/write.ts` / `edit.ts` 的 analyze 同形:资源粒度是**所在目录**,
 * `external` 位由沙箱根算出。
 *
 * 少的只有 diff 那一层(additions / deletions / originalContentHash):那几个字段
 * 来自本地工具**自己算出来的那份改动计划**,而这一次改动是 CLI 进程去做的,我们
 * 手里没有计划。凭一次自己的读盘去补一份可能与实际不符的 diff,是把「看得见」换成
 * 「看错了」—— 不补。
 */
function describeFileMutation(
  kind: 'file_write' | 'file_edit' | 'file_destructive_edit',
  resolvedPath: string,
  sandbox: { workingDirectory?: string },
): ExternalToolPermissionShape {
  const boundary = getCoreSandboxBoundary(sandbox)
  const matchedRoot = findCoreSandboxRootForPath(resolvedPath, sandbox)
  return {
    effects: [{
      kind,
      resources: [filePermissionPattern(resolvedPath)],
      barrier: true,
      external: !matchedRoot,
      metadata: {
        path: resolvedPath,
        isExternal: !matchedRoot,
        ...(matchedRoot ? {} : { boundary }),
      },
    }],
  }
}

// ── ACP:`session/request_permission` 的工具 → 同一套分析(A3-a,方案 §3.5 / §11.3)────────

export interface AcpToolPermissionInput {
  /** ACP `ToolKind`(`read` / `edit` / `delete` / `move` / `search` / `execute` / `think` / `fetch` / `switch_mode` / `other`)。 */
  kind?: string
  /** agent 给的工具标题(`toolCall.title`);只进兜底 effect 的 metadata。 */
  name?: string
  rawInput?: unknown
  /** `toolCall.locations`:agent 自己声明的受影响路径,比 rawInput 里猜字段可靠,先看它。 */
  locations?: ReadonlyArray<{ path?: string | null }>
  cwd?: string
  agentId: string
  agentName?: string
}

/**
 * ACP 没有工具名,只有 `kind` + `rawInput` + `locations`。先按 `kind` 归一成 Claude 路认得的
 * SDK 工具名,再交给 `describeExternalToolPermission` —— **命令 / 路径分析只有一份**,这里只做
 * 「字段从哪取」。
 *
 * 认不出的 kind(`search` / `fetch` / `think` / `switch_mode` / `other`)与取不到字段的,
 * 一律退回 A0 那条 `external-agent` effect(资源 `agentId:kind`)。它不是放行:那一行在策略表里
 * 是 ask。这里也没有 fail-open 的分支 —— 返回值永远至少有一条会弹卡的 effect,除非分析本身
 * 判定为白名单(`ls` / 界内的普通读),那与本地工具不弹卡是同一件事。
 */
export interface AcpToolPermissionShape {
  /** 内核 `Effect`(不是 `ToolEffect`):兜底那条 `external-agent` 只在内核效果表里有一行。 */
  effects: Effect[]
  preview?: ToolPreview
}

export function describeAcpToolPermission(input: AcpToolPermissionInput): AcpToolPermissionShape {
  const described = describeAcpKnownKind(input)
  // `ToolEffect` 与内核 `Effect` 字段同名同义(Claude 路 `runtime/external-agents` 同一个转手)。
  if (described) return { effects: described.effects as Effect[], ...(described.preview ? { preview: described.preview } : {}) }
  const kind = input.kind || 'tool'
  return {
    effects: [{
      kind: 'external-agent',
      resources: [`${input.agentId}:${kind}`],
      barrier: true,
      external: true,
      metadata: {
        agentId: input.agentId,
        ...(input.agentName ? { agentName: input.agentName } : {}),
        toolKind: input.kind ?? null,
        toolTitle: input.name ?? null,
        rawInput: toSafeJsonValue(input.rawInput),
      } as JsonObject,
    }],
  }
}

function describeAcpKnownKind(input: AcpToolPermissionInput): ExternalToolPermissionShape | undefined {
  const sandbox = { workingDirectory: input.cwd }
  switch (input.kind) {
    case 'execute': {
      const command = acpCommandLine(input.rawInput)
      return command
        ? describeExternalToolPermission({ toolName: 'Bash', input: { command }, cwd: input.cwd })
        : undefined
    }
    case 'read': {
      const path = acpPath(input, 0)
      return path
        ? describeExternalToolPermission({ toolName: 'Read', input: { file_path: path }, cwd: input.cwd })
        : undefined
    }
    case 'edit': {
      const path = acpPath(input, 0)
      return path
        ? describeExternalToolPermission({ toolName: 'Edit', input: { file_path: path }, cwd: input.cwd })
        : undefined
    }
    case 'delete': {
      // 删文件在本地效果表里就是 `file_destructive_edit`(改不回来的那一档),不借 `Edit` 的 file_edit。
      const path = acpPath(input, 0)
      return path
        ? describeFileMutation('file_destructive_edit', resolveCoreToolPath(path, sandbox), sandbox)
        : undefined
    }
    case 'move': {
      // 两个路径各一条:源头从原处消失 = 破坏性,目的地是一次写。缺任一个就认不出,整条退回兜底。
      const from = acpPath(input, 0, ['source', 'from', 'old_path', 'oldPath', 'src'])
      const to = acpPath(input, 1, ['destination', 'to', 'new_path', 'newPath', 'dest', 'target'])
      if (!from || !to) return undefined
      const source = describeFileMutation('file_destructive_edit', resolveCoreToolPath(from, sandbox), sandbox)
      const target = describeFileMutation('file_write', resolveCoreToolPath(to, sandbox), sandbox)
      return { effects: [...source.effects, ...target.effects] }
    }
    default:
      return undefined
  }
}

/** `rawInput.command`:字符串原样;`[cmd, ...args]` 用空格拼(只供分析,不拿去执行)。 */
function acpCommandLine(rawInput: unknown): string | undefined {
  const record = asRecord(rawInput)
  const command = record?.command
  if (typeof command === 'string') {
    const args = Array.isArray(record?.args) ? record.args.filter(arg => typeof arg === 'string') : []
    const line = [command, ...args].join(' ').trim()
    return line.length > 0 ? line : undefined
  }
  if (Array.isArray(command)) {
    const line = command.filter(part => typeof part === 'string').join(' ').trim()
    return line.length > 0 ? line : undefined
  }
  return undefined
}

/**
 * 路径:`locations[index].path` 优先(agent 自己声明的),再 rawInput 的常见字段。
 * 下标 0 额外认 `path` / `file_path`(方案 §11.3 那两格)。
 */
function acpPath(input: AcpToolPermissionInput, index: number, fields: string[] = []): string | undefined {
  const located = input.locations?.[index]?.path
  if (typeof located === 'string' && located.trim().length > 0) return located
  const names = index === 0 ? ['path', 'file_path', 'filePath', ...fields] : fields
  return names.length > 0 ? readStringField(input.rawInput, ...names) : undefined
}

function toSafeJsonValue(value: unknown): JsonValue {
  if (value === undefined || value === null) return null
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    return String(value)
  }
}
