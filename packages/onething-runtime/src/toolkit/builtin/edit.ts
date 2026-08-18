/**
 * R1 移植 —— `edit`。与 `write` 同一族、同一个模板,差别只在 `buildPlan` 算的是
 * 「精确替换后的样子」而不是「整文件覆盖」,以及多一条风险判定(大段删除升格成
 * `file_destructive_edit`)。
 *
 * 匹配引擎(`tools/edit-engine.ts` 的九个 replacer)一行都不重写。
 */

import { z } from 'zod'
import { toJsonObject } from '@onething/core'
import type { CoreToolPromptContribution } from '@onething/core/engine'
import type { PlanContext, Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import { writeTextFileAsync } from '@onething/core/storage'
import type { TextFileSnapshot } from '../../tools/file-snapshot.js'
import { editFailureError, type ExactEdit } from '../../tools/edit-engine.js'
import { defineInput, listZodIssues } from '../contract.js'
import { computeEdit, type EditComputation, type EditRisk } from './edit-plan.js'
import {
  MAX_REVALIDATION_ATTEMPTS,
  MutatingFileTool,
  type FileMutationDiff,
  type FileMutationPlan,
  type MutatingFileToolAdapters,
} from '../families/mutating-file.js'

const ReplaceEditSchema = z.object({
  oldText: z.string().describe(
    'Exact text for one targeted replacement. It must be unique in the original file unless replaceAll is set, and must not overlap with any other edits[].oldText in the same call.',
  ),
  newText: z.string().describe('Replacement text for this targeted edit.'),
  replaceAll: z.boolean().optional().describe(
    'Replace every occurrence of oldText instead of requiring it to be unique. Use this for repeated identical blocks; prefer a longer unique oldText when you mean to change only one site.',
  ),
})

export const EditInputSchema = z.object({
  path: z.string().describe('Path to the file to edit (relative or absolute)'),
  edits: z.array(ReplaceEditSchema).min(1).describe(
    'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
  ),
})

export const EDIT_DESCRIPTION =
  'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file, unless that edit sets replaceAll: true to replace all of its occurrences. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.\n\nReading the file first with the read tool is recommended so each oldText matches the file\'s current content, but it is not required.'

/** 见 write.ts 的同名常量:R2a 决定② 之后它挂回 `spec.prompt`。 */
export const EDIT_TOOL_PROMPT: CoreToolPromptContribution = {
  guidelines: ['使用edit来修改文件，禁止使用bash工具来修改文件'],
}

const EditContract = defineInput(EditInputSchema, {
  formatError: error => `Invalid edit parameters:\n${listZodIssues(error)}`,
})

export type EditInput = z.infer<typeof EditInputSchema>
export type EditToolAdapters = MutatingFileToolAdapters

interface EditDetail {
  readonly edits: ExactEdit[]
  readonly contentNew: string
  readonly snapshot: TextFileSnapshot
  readonly diff: FileMutationDiff
  readonly risk: EditRisk
}

interface EditDetail {
  readonly edits: ExactEdit[]
  readonly contentNew: string
  readonly snapshot: TextFileSnapshot
  readonly diff: FileMutationDiff
  readonly risk: EditRisk
}

export class EditTool extends MutatingFileTool<EditInput, EditDetail> {
  readonly spec: ToolSpec = {
    id: 'edit',
    title: 'Edit',
    description: EDIT_DESCRIPTION,
    input: EditContract.schema,
    effects: ['file_edit', 'file_destructive_edit', 'external_directory'],
    presentation: { kind: 'diff', shell: 'default' },
    concurrency: 'sequential',
    prompt: EDIT_TOOL_PROMPT,
  }

  protected async buildPlan(input: EditInput, ctx: PlanContext): Promise<FileMutationPlan<EditDetail>> {
    const resolved = this.resolvePath(input.path, ctx, 'write')
    const snapshot = await this.snapshot(resolved.absolute)
    const computed = computeEdit(resolved.absolute, input.edits, snapshot)

    return {
      resolved,
      effects: [this.mutationEffect(
        computed.risk.requiresExplicitPermission ? 'file_destructive_edit' : 'file_edit',
        resolved,
        {
          additions: computed.diff.additions,
          deletions: computed.diff.deletions,
          originalContentHash: computed.diff.originalContentHash,
          risk: computed.risk.kind,
          riskReason: computed.risk.reason,
        },
      )],
      preview: this.diffPreview(`Edit ${this.basename(resolved)}`, resolved, computed.diff),
      detail: { edits: input.edits, contentNew: computed.contentNew, snapshot, diff: computed.diff, risk: computed.risk },
    }
  }

  protected async applyPlan(plan: FileMutationPlan<EditDetail>, ctx: RunContext): Promise<Result> {
    const { resolved } = plan
    const path = resolved.absolute
    const name = this.basename(resolved)
    const { edits } = plan.detail

    this.partial(ctx, `Preparing edit for ${path}...`, { phase: 'preparing', path, replacements: edits.length })
    this.annotate(ctx, `Editing ${name}`, { path, diff: '', additions: 0, deletions: 0 })
    ctx.abort.throwIfAborted()

    const emitPlan = (diff: FileMutationDiff) => {
      const display = this.displayDiff(diff)
      this.partial(ctx, display.diff || `Preparing ${path}`, {
        phase: 'preview', path, additions: diff.additions, deletions: diff.deletions, replacements: edits.length,
      })
      this.annotate(ctx, `Editing ${name}`, {
        path, diff: display.diff, diffHunks: display.diffHunks,
        additions: diff.additions, deletions: diff.deletions,
        originalContentHash: diff.originalContentHash,
      })
    }

    let snapshot = await this.snapshot(path)
    ctx.abort.throwIfAborted()
    let approved = computeEdit(path, edits, snapshot)
    ctx.abort.throwIfAborted()

    if (approved.diff.originalContentHash !== plan.detail.diff.originalContentHash
      && plan.detail.diff.diff && approved.diff.diff !== plan.detail.diff.diff) {
      emitPlan(approved.diff)
      throw editFailureError(
        `Edit failed: file changed after approval in ${name}.`,
        `${path} was modified between permission approval and execution. Re-read the file and retry with its current content as oldText.`,
      )
    }
    emitPlan(approved.diff)

    let attempts = 0
    for (;;) {
      const latest = await this.snapshot(path)
      ctx.abort.throwIfAborted()
      if (latest.hash === approved.diff.originalContentHash) {
        await writeTextFileAsync(path, approved.contentNew)
        ctx.abort.throwIfAborted()
        break
      }

      attempts++
      if (attempts > MAX_REVALIDATION_ATTEMPTS) {
        throw editFailureError(
          `Edit failed: file keeps changing in ${name}.`,
          `${path} was modified too many times during the edit. Re-read it to get the latest content, then retry.`,
        )
      }

      let revalidated: EditComputation
      try {
        revalidated = computeEdit(path, edits, latest)
      } catch (error) {
        // 引擎自己那句"短原因 + 细节"已经够用,只在前面补一行审批语境。
        throw editFailureError(
          `Edit failed: file changed after approval in ${name}.`,
          error instanceof Error ? error.message : String(error),
        )
      }

      if (revalidated.diff.diff !== approved.diff.diff) {
        emitPlan(revalidated.diff)
        throw editFailureError(
          `Edit failed: file changed after approval in ${name}, retry needed.`,
          `File changed after permission approval and the resulting edit diff changed: ${path}. Please retry the edit.`,
        )
      }
      snapshot = latest
      approved = revalidated
    }

    const audit = await this.recordAudit({
      ctx,
      operation: 'edit',
      resolved,
      beforeExists: true,
      beforeContent: snapshot.content,
      afterContent: approved.contentNew,
      diff: approved.diff.diff,
      metadata: { additions: approved.diff.additions, deletions: approved.diff.deletions, replacements: edits.length },
    })

    const display = this.displayDiff(approved.diff)
    const metadata = toJsonObject({
      path, diff: display.diff, diffHunks: display.diffHunks,
      additions: approved.diff.additions, deletions: approved.diff.deletions,
      originalContentHash: approved.diff.originalContentHash,
      auditId: audit.id, auditPath: audit.path, afterContentHash: audit.afterHash,
    })
    this.annotate(ctx, undefined, metadata)

    const output = `Successfully edited ${path} (${edits.length} replacement${edits.length === 1 ? '' : 's'})`
    const result: Result = {
      content: [{ type: 'text', text: output }, { type: 'file', path }],
      details: metadata,
    }
    ctx.emit({
      type: 'partial',
      result: {
        ...result,
        details: toJsonObject({
          phase: 'ready', path, diff: display.diff,
          additions: approved.diff.additions, deletions: approved.diff.deletions,
          replacements: edits.length, auditId: audit.id, auditPath: audit.path,
        }),
      },
    })
    this.annotate(ctx, `Edited ${name}`, metadata)
    return result
  }
}

export function createEditTool(adapters: EditToolAdapters): EditTool {
  return new EditTool(adapters)
}
