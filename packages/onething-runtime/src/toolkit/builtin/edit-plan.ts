/**
 * R1 —— `edit` 的**计划计算**纯函数(替换预览 → diff → 风险判定)。
 *
 * 与 `read-content.ts` / `variable-render.ts` 同一个理由:它今天长在
 * `tools/builtin/edit.ts` 的模块私有作用域里,而那个文件整只在删除清单上。它是一段
 * 可以脱离 ctx / fs / 权限独立测试的计算,搬成独立模块而不是复制进工具壳。
 *
 * 匹配引擎本身(九个 replacer)在 `tools/edit-engine.ts`,一行都不重写。
 */

import { createTwoFilesPatch } from 'diff'
import { basenamePath } from '@onething/core/storage'
import { computeDiffHunks, trimDiffHunks } from '../../tools/diff-hunks.js'
import { countLineChanges, type TextFileSnapshot } from '../../tools/file-snapshot.js'
import { editFailureError, prepareExactEditPreview, type ExactEdit } from '../../tools/edit-engine.js'
import { trimDiff } from '../../tools/replacers.js'
import type { FileMutationDiff } from '../families/mutating-file.js'

/** 大段删除的两条判据。阈值与旧 `getEditRisk` 逐字相同。 */
const LARGE_DELETION_MIN_LINES = 6
const LARGE_DELETION_RATIO = 5

export interface EditRisk {
  requiresExplicitPermission: boolean
  kind?: 'large_deletion'
  reason?: string
}

export interface EditComputation {
  contentNew: string
  diff: FileMutationDiff
  risk: EditRisk
}

/**
 * 一次替换计划的全部计算。文件不存在在这里就变成教学文本 —— 计划阶段说不清楚要
 * 做什么,就不该走到施行阶段。
 */
export function computeEdit(
  path: string,
  edits: ExactEdit[],
  snapshot: TextFileSnapshot,
): EditComputation {
  if (!snapshot.exists) {
    throw editFailureError(
      `Edit failed: file not found: ${basenamePath(path)}`,
      `File not found: ${path}`,
    )
  }

  // 引擎已经产出"短原因 + 细节",这里不再包第三层。
  const preview = prepareExactEditPreview(snapshot.content, edits, path)
  const { additions, deletions } = countLineChanges(preview.baseContent, preview.newContent)
  const diff: FileMutationDiff = {
    diff: trimDiff(createTwoFilesPatch(path, path, preview.baseContent, preview.newContent)),
    hunks: trimDiffHunks(computeDiffHunks(path, preview.baseContent, preview.newContent)),
    additions,
    deletions,
    originalContentHash: snapshot.hash,
  }
  const risk: EditRisk =
    deletions >= LARGE_DELETION_MIN_LINES || deletions >= additions * LARGE_DELETION_RATIO
      ? {
          requiresExplicitPermission: true,
          kind: 'large_deletion',
          reason: `Edit removes ${deletions} lines and adds ${additions} lines.`,
        }
      : { requiresExplicitPermission: false }

  return { contentNew: preview.finalContent, diff, risk }
}
