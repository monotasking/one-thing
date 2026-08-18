/**
 * R1 移植 —— `write`。`MutatingFileTool` 一族:整只工具只剩 `buildPlan`(算 diff)
 * 与 `applyPlan`(重校验 + 落盘 + 审计)。
 *
 * 队列、审计落盘、diff 显示截断、效果/预览形状都在家族基类;审批不再是 execute
 * 里的一个 `beforeSideEffect()` 回调,而是 plan 与 apply 之间那道天然的缝。
 */

import { z } from 'zod'
import { createTwoFilesPatch } from 'diff'
import { toJsonObject } from '@onething/core'
import type { CoreToolPromptContribution } from '@onething/core/engine'
import type { PlanContext, Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import { dirnamePath, ensureDirAsync, writeTextFileAsync } from '@onething/core/storage'
import { computeDiffHunks, trimDiffHunks } from '../../tools/diff-hunks.js'
import { countLineChanges, type TextFileSnapshot } from '../../tools/file-snapshot.js'
import { trimDiff } from '../../tools/replacers.js'
import { defineInput, listZodIssues } from '../contract.js'
import {
  MAX_REVALIDATION_ATTEMPTS,
  MutatingFileTool,
  type FileMutationDiff,
  type FileMutationPlan,
  type MutatingFileToolAdapters,
} from '../families/mutating-file.js'

export const WriteInputSchema = z.object({
  path: z.string().describe('Path to the file to write (relative or absolute)'),
  content: z.string().describe('Content to write to the file'),
})

export const WRITE_DESCRIPTION =
  "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories."

/**
 * `Tool Guidelines:` 里由 write 带上来的那一条,逐字沿用旧 `WRITE_TOOL_PROMPT`。
 *
 * R2a 决定②:它回到了 `spec.prompt` 上。内核那一格现在就是
 * `CoreToolPromptContribution`(三类俱全),所以不再有"硬映射会丢信息"的理由 ——
 * 注册工具,提示词就跟着走,不需要第二本账。
 */
export const WRITE_TOOL_PROMPT: CoreToolPromptContribution = { guidelines: ['使用write来重写或创建文件'] }

const WriteContract = defineInput(WriteInputSchema, {
  formatError: error => `Invalid write parameters:\n${listZodIssues(error)}`,
})

export type WriteInput = z.infer<typeof WriteInputSchema>
export type WriteToolAdapters = MutatingFileToolAdapters

interface WriteDetail {
  readonly inputPath: string
  readonly content: string
  readonly bytesWritten: number
  readonly lineCount: number
  readonly created: boolean
  readonly snapshot: TextFileSnapshot
  readonly diff: FileMutationDiff
}

function buildWriteDiff(path: string, snapshot: TextFileSnapshot, content: string): FileMutationDiff {
  // trimDiff 与 edit 用同一个,两边的 diff 视图密度因此一致。
  const diff = trimDiff(createTwoFilesPatch(path, path, snapshot.content, content))
  const { additions, deletions } = countLineChanges(snapshot.content, content)
  return {
    diff,
    hunks: trimDiffHunks(computeDiffHunks(path, snapshot.content, content)),
    additions,
    deletions,
    originalContentHash: snapshot.hash,
  }
}

export class WriteTool extends MutatingFileTool<WriteInput, WriteDetail> {
  readonly spec: ToolSpec = {
    id: 'write',
    title: 'Write',
    description: WRITE_DESCRIPTION,
    input: WriteContract.schema,
    effects: ['file_write', 'external_directory'],
    presentation: { kind: 'diff', shell: 'default' },
    concurrency: 'sequential',
    prompt: WRITE_TOOL_PROMPT,
  }

  protected async buildPlan(input: WriteInput, ctx: PlanContext): Promise<FileMutationPlan<WriteDetail>> {
    const resolved = this.resolvePath(input.path, ctx, 'write')
    const snapshot = await this.snapshot(resolved.absolute)
    const diff = buildWriteDiff(resolved.absolute, snapshot, input.content)
    const created = !snapshot.exists

    return {
      resolved,
      effects: [this.mutationEffect('file_write', resolved, {
        created,
        additions: diff.additions,
        deletions: diff.deletions,
        originalContentHash: diff.originalContentHash,
      })],
      preview: this.diffPreview(`${created ? 'Create' : 'Overwrite'} ${this.basename(resolved)}`, resolved, diff),
      detail: {
        inputPath: input.path,
        content: input.content,
        bytesWritten: Buffer.byteLength(input.content, 'utf-8'),
        lineCount: input.content.split('\n').length,
        created,
        snapshot,
        diff,
      },
    }
  }

  protected async applyPlan(plan: FileMutationPlan<WriteDetail>, ctx: RunContext): Promise<Result> {
    const { resolved } = plan
    const path = resolved.absolute
    const { content, bytesWritten, lineCount } = plan.detail

    this.partial(ctx, `Preparing write to ${path}...`, { phase: 'preparing', path, bytesWritten, lineCount })
    this.annotate(ctx, this.basename(resolved), { path, bytesWritten, lineCount })
    ctx.abort.throwIfAborted()

    const emitPlan = (created: boolean, diff: FileMutationDiff) => {
      const display = this.displayDiff(diff)
      this.partial(ctx, display.diff || `Preparing ${path}`, {
        phase: 'preview', path, bytesWritten, lineCount,
        created, additions: diff.additions, deletions: diff.deletions,
      })
      this.annotate(ctx, this.basename(resolved), {
        path, bytesWritten, lineCount, created,
        diff: display.diff, diffHunks: display.diffHunks,
        additions: diff.additions, deletions: diff.deletions,
        originalContentHash: diff.originalContentHash,
      })
    }

    // 审批期间文件被改过没有。判据与旧的逐字一致:hash 变了但 diff 没变 → 放行。
    const snapshot = await this.snapshot(path)
    const approved = buildWriteDiff(path, snapshot, content)
    const created = !snapshot.exists
    ctx.abort.throwIfAborted()

    if (approved.originalContentHash !== plan.detail.diff.originalContentHash
      && plan.detail.diff.diff && approved.diff !== plan.detail.diff.diff) {
      emitPlan(created, approved)
      throw new Error(`File changed after permission approval and the resulting write diff changed: ${path}. Please retry the write.`)
    }
    emitPlan(created, approved)

    let attempts = 0
    for (;;) {
      const latest = await this.snapshot(path)
      ctx.abort.throwIfAborted()
      if (latest.hash === approved.originalContentHash) break

      attempts++
      if (attempts > MAX_REVALIDATION_ATTEMPTS) {
        throw new Error(`File changed repeatedly after write approval: ${path}. Please retry the write.`)
      }
      emitPlan(!latest.exists, buildWriteDiff(path, latest, content))
      throw new Error(`File changed after permission approval and the resulting write diff changed: ${path}. Please retry the write.`)
    }

    await ensureDirAsync(dirnamePath(path))
    ctx.abort.throwIfAborted()
    await writeTextFileAsync(path, content)
    ctx.abort.throwIfAborted()

    const audit = await this.recordAudit({
      ctx,
      operation: created ? 'write_create' : 'write_overwrite',
      resolved,
      beforeExists: snapshot.exists,
      beforeContent: snapshot.content,
      afterContent: content,
      diff: approved.diff,
      metadata: { bytesWritten, lineCount, additions: approved.additions, deletions: approved.deletions },
    })

    const display = this.displayDiff(approved)
    const metadata = toJsonObject({
      path, bytesWritten, lineCount, created,
      diff: display.diff, diffHunks: display.diffHunks,
      additions: approved.additions, deletions: approved.deletions,
      originalContentHash: approved.originalContentHash,
      auditId: audit.id, auditPath: audit.path, afterContentHash: audit.afterHash,
    })
    this.annotate(ctx, undefined, metadata)

    const output = `Successfully wrote ${content.length} bytes to ${plan.detail.inputPath}`
    const result: Result = {
      content: [{ type: 'text', text: output }, { type: 'file', path }],
      details: metadata,
    }
    ctx.emit({ type: 'partial', result: { ...result, details: toJsonObject({ phase: 'ready', ...metadata }) } })
    return result
  }
}

export function createWriteTool(adapters: WriteToolAdapters): WriteTool {
  return new WriteTool(adapters)
}
