/**
 * R1 家族基类 —— `MutatingFileTool`(§4 的第三族,`FileTool` 的子族)。
 *
 * 这一族的模板就是 §1 那张图在文件上的具体化:
 *
 *   plan  = buildPlan(input)  → diff 预览 + `file_edit | file_write |
 *           file_destructive_edit` 效果(**还没动手**)
 *   apply = 文件级互斥队列 → 子类的 applyPlan(落盘 + 快照重校验)→ 审计 →
 *           annotate(diff/hunks)
 *
 * 队列、审计、diff 的显示截断、效果与预览的形状全部在这里一处;子类只写
 * `buildPlan`(这次要把文件变成什么样)与 `applyPlan`(怎么把它变过去)。
 *
 * 与旧 edit/write 的一个结构差异值得写下来:旧代码在 `execute` 里**第二次**跑
 * analyze(读快照、重算 diff),再和 `ctx.approvedAnalysis` 里的那份比对。新树里
 * "被批准的那份计划"就是 `intent.payload` —— 同一个对象,不需要靠 metadata 里的
 * hash 把它捞回来。重校验(文件在审批期间被改了)照旧,判据逐字不变。
 */

import { coreDiffHunksToJson, type CoreDiffHunk } from '@onething/core/tools'
import { Intent, makeEffect } from '@onething/core/toolkit'
import type { JsonObject, JsonValue } from '@onething/core'
import type { Effect, EffectClass, PlanContext, Preview, Result, RunContext } from '@onething/core/toolkit'
import { basenamePath } from '@onething/core/storage'
import { filePermissionPattern } from '../../tools/permission-effects.js'
import { withFileMutationQueue } from '../../tools/file-mutation-queue.js'
import { truncateDiffHunksForDisplay } from '../../tools/diff-hunks.js'
import { truncateDiffForDisplay } from '../../tools/replacers.js'
import { readTextFileSnapshot, type TextFileSnapshot } from '../../tools/file-snapshot.js'
import {
  recordFileMutationAudit,
  type FileMutationOperation,
  type RecordFileMutationAuditResult,
} from '../../tools/file-mutation-audit.js'
import { FileTool, type FileToolAdapters, type ResolvedFilePath } from './file.js'

/** 旧 edit/write 各抄了一份的同一个常量。 */
export const MAX_REVALIDATION_ATTEMPTS = 5

export interface MutatingFileToolAdapters extends FileToolAdapters {
  getFileMutationsDir(): string
}

/** 一次文件改动的计划。`detail` 由子类定义(写什么内容 / 打哪些补丁)。 */
export interface FileMutationPlan<Detail> {
  readonly resolved: ResolvedFilePath
  readonly effects: Effect[]
  readonly preview: Preview
  readonly detail: Detail
}

/** 子类算出来的 diff 三件套 —— 效果元数据与预览都从它推。 */
export interface FileMutationDiff {
  readonly diff: string
  readonly hunks: CoreDiffHunk[]
  readonly additions: number
  readonly deletions: number
  readonly originalContentHash: string
}

export abstract class MutatingFileTool<In, Detail> extends FileTool<In, FileMutationPlan<Detail>> {
  protected readonly mutationAdapters: MutatingFileToolAdapters

  constructor(adapters: MutatingFileToolAdapters) {
    super(adapters)
    this.mutationAdapters = adapters
  }

  async plan(input: In, ctx: PlanContext): Promise<Intent<FileMutationPlan<Detail>>> {
    const plan = await this.buildPlan(input, ctx)
    return Intent.of({ effects: plan.effects, preview: plan.preview, payload: plan })
  }

  /**
   * 文件级互斥:同一个路径上的 read/edit/write 串行,读拿共享锁。这条队列是
   * §10.1 里"diff 竞态根治"那一批留下的,原样复用。
   */
  async apply(intent: Intent<FileMutationPlan<Detail>>, ctx: RunContext): Promise<Result> {
    const plan = intent.payload
    ctx.abort.throwIfAborted()
    return await withFileMutationQueue(plan.resolved.absolute, async () => {
      ctx.abort.throwIfAborted()
      return await this.applyPlan(plan, ctx)
    })
  }

  /** 这一族要写的第一样:这次调用打算把文件变成什么样。 */
  protected abstract buildPlan(input: In, ctx: PlanContext): Promise<FileMutationPlan<Detail>>

  /** 第二样:在互斥区内把它变过去。 */
  protected abstract applyPlan(plan: FileMutationPlan<Detail>, ctx: RunContext): Promise<Result>

  // ── 家族共用件 ──────────────────────────────────────────────────────────

  protected async snapshot(path: string): Promise<TextFileSnapshot> {
    return await readTextFileSnapshot(path)
  }

  /**
   * 一条写效果。资源粒度是**所在目录**(`filePermissionPattern`),不是那一个文件
   * —— 一次「总是允许」覆盖的是这个目录下的写。
   */
  protected mutationEffect(
    kind: Extract<EffectClass, 'file_edit' | 'file_write' | 'file_destructive_edit'>,
    resolved: ResolvedFilePath,
    metadata: JsonObject,
  ): Effect {
    return makeEffect(kind, [filePermissionPattern(resolved.absolute)], {
      barrier: true,
      external: resolved.external,
      metadata: {
        path: resolved.absolute,
        ...metadata,
        isExternal: resolved.external,
        boundary: resolved.external ? resolved.boundary : undefined,
      },
    })
  }

  protected diffPreview(title: string, resolved: ResolvedFilePath, diff: FileMutationDiff): Preview {
    return {
      title,
      path: resolved.absolute,
      diff: diff.diff,
      additions: diff.additions,
      deletions: diff.deletions,
    }
  }

  /** 给渲染器/审计看的显示态 diff:行数与字节双截断,hunks 同步截。 */
  protected displayDiff(diff: FileMutationDiff): { diff: string; diffHunks: JsonValue } {
    return {
      diff: truncateDiffForDisplay(diff.diff),
      diffHunks: coreDiffHunksToJson(truncateDiffHunksForDisplay(diff.hunks)),
    }
  }

  /**
   * 取代旧 `ctx.metadata({ title, metadata })` 的那条流事件。渲染器看到的字段一个
   * 不少(见 R1 对拍的 (d) 条),只是它现在是一条事件而不是一个回调字段。
   */
  protected annotate(ctx: RunContext, title: string | undefined, details: JsonObject): void {
    ctx.emit({ type: 'annotate', title, details })
  }

  protected partial(ctx: RunContext, text: string, details: JsonObject): void {
    ctx.emit({ type: 'partial', result: { content: [{ type: 'text', text }], details } })
  }

  protected basename(resolved: ResolvedFilePath): string {
    return basenamePath(resolved.absolute)
  }

  protected async recordAudit(input: {
    ctx: RunContext
    operation: FileMutationOperation
    resolved: ResolvedFilePath
    beforeExists: boolean
    beforeContent: string
    afterContent: string
    diff: string
    metadata: JsonObject
  }): Promise<RecordFileMutationAuditResult> {
    return await recordFileMutationAudit({
      auditDir: this.mutationAdapters.getFileMutationsDir(),
      sessionId: input.ctx.invocation.sessionId,
      messageId: input.ctx.invocation.messageId ?? '',
      toolCallId: input.ctx.invocation.callId,
      operation: input.operation,
      path: input.resolved.absolute,
      beforeExists: input.beforeExists,
      beforeContent: input.beforeContent,
      afterContent: input.afterContent,
      diff: input.diff,
      metadata: input.metadata,
    })
  }
}
