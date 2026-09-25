/**
 * ACP agent 要读写文件(`fs/read_text_file` / `fs/write_text_file`)时的落点(A3-b,方案
 * `docs/design/acp-integration-2026-09.md` §3.5 / §11.3)。
 *
 * 从前 `ACPClient` 里有一份裸实现:只查绝对路径与 1MB 上限,写文件直接 `mkdir -p` 落盘 ——
 * 不问沙箱、不问许可、不进 UI,于是四台内置 agent 的这两格一直关着。这只桥把它换成 onething
 * 自己的那一套,与本地 read / write 工具**同一套判据**(`resolveFileToolPath` /
 * `fileReadEffects` / `fileMutationEffect` 就是那两只工具的家族件):
 *
 *  - 读:会话目录 + 读根(笔记 / 下载 / 接入目录)之内静默;之外先一条 `external_directory`,
 *    敏感文件是 `sensitive_file_read` —— 两者都问一次,拒了答 agent 一句人话。
 *  - 写:先读旧文算 diff,效果 `file_write`(新建)/ `file_edit`(改),越界是那条写效果上的
 *    `external` 位(与本地 write 工具同形,不另起一行 —— 另起一行就是两张卡);卡上带 diff;
 *    准了才 `mkdir -p` + 写,写完落一条 `tool/audit` 进会话账本。
 *
 * 读写都进本地工具那条文件级互斥队列:agent 的写与本地 edit 撞同一个文件时照样串行。
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { Principal } from '@onething/core/permission'
import type { Authorizer, Decision, Effect } from '@onething/core/toolkit'
import type { AcpClientRequestContext, AcpFsBridge } from '@onething/runtime/acp'
import { buildTextDiffChange } from '@onething/runtime/external-agents'
import {
  fileMutationEffect,
  fileReadEffects,
  fileReadPreview,
  resolveFileToolPath,
  type FileScope,
  type FileToolAdapters,
} from '@onething/runtime/toolkit'
import type { ToolAuditRecord } from '@onething/runtime/toolkit/audit-observer'
import { readTextFileSnapshot } from '@onething/runtime/tools/file-snapshot'
import { withFileMutationQueue, withFileReadAccess } from '@onething/runtime/tools/file-mutation-queue'
import { getLogger } from '../logging/index.js'
import { mutatingFileAdapters, readAdapters } from '../toolkit/file-adapters.js'
import { toolkitAuditSink } from '../toolkit/audit-sink.js'
import { authorizeAcpRequest } from './request-authorize.js'

const log = getLogger('acp.fs')

/** 读文件的上限,与裸实现时期同一个数:再大的文件 agent 该分段读,而不是一口吞进上下文。 */
export const ACP_FS_MAX_READ_BYTES = 1024 * 1024

/** 审计里这两条请求的「工具名」(per-tool 设置表与卡片 metadata 也按它认)。 */
export const ACP_FS_READ_TOOL_ID = 'acp-fs-read'
export const ACP_FS_WRITE_TOOL_ID = 'acp-fs-write'

export interface AcpFsBridgeDeps {
  /** 每次请求现取的授权者(宿主决定没人答时等还是拒)。 */
  authorizer: () => Authorizer
  /** 读根 / 写根的来处;缺省 = 本地 read / write 工具用的那两份适配器。 */
  readAdapters?: () => FileToolAdapters
  writeAdapters?: () => FileToolAdapters
  /** 写完的那条审计;缺省 = 工具审计的落盘口(会话账本 `tool/audit`)。 */
  audit?: (record: ToolAuditRecord) => void
  now?: () => number
}

function scopeOf(context: AcpClientRequestContext): FileScope {
  return {
    sessionId: context.localSessionId,
    workingDirectory: context.cwd,
    workingDirectoryRoots: [context.cwd],
  }
}

/** 这条请求里是谁在动手:外部 agent 没有 onething 主体,审计按组件记下它的来处。 */
function acpPrincipal(agentId: string): Principal {
  return { kind: 'system', component: `acp:${agentId}` }
}

function refusal(action: string, path: string, decision: Extract<Decision, { kind: 'deny' }>): Error {
  const why = decision.reason ? ` (${decision.reason})` : ''
  return new Error(`onething denied ${action} ${path}${why}.`)
}

/** 按 ACP 的 `line`(1 起)/ `limit` 切行;都缺席 = 整份。 */
function sliceLines(content: string, line: number | null | undefined, limit: number | null | undefined): string {
  if (!line && !limit) return content
  const lines = content.split(/\r?\n/)
  const start = Math.max(0, (line ?? 1) - 1)
  const end = limit ? start + limit : lines.length
  return lines.slice(start, end).join('\n')
}

function uniqueKinds(effects: readonly Effect[]): Effect['kind'][] {
  return [...new Set(effects.map(effect => effect.kind))]
}

export function createAcpFsBridge(deps: AcpFsBridgeDeps): AcpFsBridge {
  const readRoots = deps.readAdapters ?? readAdapters
  const writeRoots = deps.writeAdapters ?? mutatingFileAdapters
  const audit = deps.audit ?? toolkitAuditSink
  const now = deps.now ?? (() => Date.now())

  return {
    async readTextFile(context, params) {
      const resolved = resolveFileToolPath(params.path, scopeOf(context), readRoots(), 'read')
      const effects = fileReadEffects(resolved, 'Read file')
      const preview = {
        ...fileReadPreview(resolved),
        title: `${context.agentName}: ${fileReadPreview(resolved).title}`,
        metadata: { agentId: context.agentId, agentName: context.agentName, toolKind: 'read' },
      }
      // 根内的普通读是 `read` 一条(策略表里静默),授权者不会惊动任何人;根外 / 敏感才上卡。
      const decision = await authorizeAcpRequest(deps.authorizer(), {
        localSessionId: context.localSessionId,
        messageId: context.messageId,
        cwd: context.cwd,
        callId: `acp-fs-read-${randomUUID()}`,
        toolId: ACP_FS_READ_TOOL_ID,
        input: { path: params.path, line: params.line ?? null, limit: params.limit ?? null },
        effects,
        preview,
      })
      if (decision.kind === 'deny') throw refusal('reading', resolved.absolute, decision)

      const absolute = resolved.absolute
      return withFileReadAccess(absolute, async () => {
        const stat = await fs.stat(absolute)
        if (stat.isDirectory()) throw new Error(`${absolute} is a directory, not a file.`)
        if (stat.size > ACP_FS_MAX_READ_BYTES) {
          throw new Error(`${absolute} is larger than ${ACP_FS_MAX_READ_BYTES} bytes; read it in parts with line / limit.`)
        }
        const content = await fs.readFile(absolute, 'utf8')
        return { content: sliceLines(content, params.line, params.limit) }
      })
    },

    async writeTextFile(context, params) {
      const resolved = resolveFileToolPath(params.path, scopeOf(context), writeRoots(), 'write')
      const absolute = resolved.absolute
      const snapshot = await readTextFileSnapshot(absolute)
      const created = !snapshot.exists
      const change = buildTextDiffChange(absolute, snapshot.content, params.content)
      const effect = fileMutationEffect(created ? 'file_write' : 'file_edit', resolved, {
        created,
        additions: change?.additions ?? 0,
        deletions: change?.deletions ?? 0,
        originalContentHash: snapshot.hash,
      })
      const title = `${context.agentName}: ${created ? 'Create' : 'Overwrite'} ${absolute}`
      const preview = {
        title,
        path: absolute,
        // 卡上带 diff(权限核把它镜像进 `metadata.diff`,壳 A3-d 画)。
        ...(change ? { diff: change.diff, additions: change.additions, deletions: change.deletions } : {}),
        metadata: { agentId: context.agentId, agentName: context.agentName, toolKind: 'edit' },
      }
      const callId = `acp-fs-write-${randomUUID()}`
      // 问在锁外:等人答的那段时间不该挡住别人读这个文件(本地 write 也是 plan 时问、apply 时锁)。
      const decision = await authorizeAcpRequest(deps.authorizer(), {
        localSessionId: context.localSessionId,
        messageId: context.messageId,
        cwd: context.cwd,
        callId,
        toolId: ACP_FS_WRITE_TOOL_ID,
        input: { path: params.path, bytes: Buffer.byteLength(params.content, 'utf8') },
        effects: [effect],
        preview,
      })
      if (decision.kind === 'deny') throw refusal('writing', absolute, decision)

      await withFileMutationQueue(absolute, async () => {
        // 人看到的是那份 diff;审批期间文件被别人改过,准的就不是这一次了 —— 与本地 write 同一判据。
        const latest = await readTextFileSnapshot(absolute)
        if (latest.hash !== snapshot.hash) {
          throw new Error(`${absolute} changed while waiting for approval; read it again and retry the write.`)
        }
        await fs.mkdir(dirname(absolute), { recursive: true })
        await fs.writeFile(absolute, params.content, 'utf8')
      })

      // 审计是旁观者:它炸了不该把一次已经落盘的写变成失败。
      try {
        audit({
          callId,
          toolId: ACP_FS_WRITE_TOOL_ID,
          sessionId: context.localSessionId,
          principal: acpPrincipal(context.agentId),
          ...(context.messageId ? { messageId: context.messageId } : {}),
          effects: uniqueKinds([effect]),
          effectCount: 1,
          previewTitle: title,
          decision: decision.kind,
          ...(decision.asked !== undefined ? { asked: decision.asked } : {}),
          outcome: 'ok',
          at: now(),
        })
      } catch (error) {
        log.warn('acp fs write audit failed', { agentId: context.agentId, sessionId: context.localSessionId }, error)
      }
    },
  }
}
