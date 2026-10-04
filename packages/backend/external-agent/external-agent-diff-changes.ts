/**
 * 外部 agent 改文件时给卡片 / 工具卡看的那份 diff(显示态)。
 *
 * 两处要它:Claude SDK 路从工具入参合成改动(`claude-code-connector.ts` 的
 * `fileChangeMetadata`),ACP 的 `fs/write_text_file` 在落盘前算「旧文 → 新文」
 * (`backend/acp/acp-fs-bridge.ts`,A3-b)。判据与本地 edit / write 工具同一套:
 * `trimDiff` 收紧上下文、`truncateDiffForDisplay` 按行数与字节双截断 —— 同一份改动
 * 在三条路上长一个样,所以只写一处。
 */
import { createTwoFilesPatch } from 'diff'
import { countLineChanges, trimDiff, truncateDiffForDisplay } from '../tool/tool.js'

export interface TextDiffChange {
  path: string
  diff: string
  additions: number
  deletions: number
}

/** 前后一样答 `null`(没有改动就没有 diff 可画)。 */
export function buildTextDiffChange(path: string, before: string, after: string): TextDiffChange | null {
  if (before === after) return null
  const diff = truncateDiffForDisplay(trimDiff(createTwoFilesPatch(path, path, before, after)))
  const { additions, deletions } = countLineChanges(before, after)
  return { path, diff, additions, deletions }
}
