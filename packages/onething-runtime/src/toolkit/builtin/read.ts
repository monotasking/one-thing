/**
 * R1 移植 —— `read`。`FileTool` 一族:plan 只做"路径 → 效果",apply 只做"读"。
 *
 * 与旧 `tools/builtin/read.ts` 的差别只有形状:沙箱解析与效果面搬到了家族基类,
 * 内容判定搬到了 `read-content.ts`,`ctx.metadata` / `ctx.updateResult` 变成两条
 * 事件。判据、文案、截断阈值逐字不变(对拍钉住)。
 */

import { z } from 'zod'
import { toJsonObject } from '@onething/core'
import type { JsonObject } from '@onething/core'
import { Intent } from '@onething/core/toolkit'
import type { PlanContext, Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import { basenamePath, readBinaryFile, statPath } from '@onething/core/storage'
import { withFileReadAccess } from '../../tools/file-mutation-queue.js'
import { defineInput, listZodIssues } from '../contract.js'
import { FileTool, type FileToolAdapters, type ResolvedFilePath } from '../families/file.js'
import {
  composeTextRead,
  DEFAULT_LIMIT,
  DEFAULT_MAX_BYTES,
  isBinaryBuffer,
  isPdfFile,
  supportedImageMimeType,
} from './read-content.js'

export const ReadInputSchema = z.object({
  path: z.string().describe('Path to the file to read (relative or absolute)'),
  offset: z.number().optional().describe('Line number to start reading from (1-indexed)'),
  limit: z.number().optional().describe('Maximum number of lines to read'),
})

export const READ_DESCRIPTION = `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_LIMIT} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`

const ReadContract = defineInput(ReadInputSchema, {
  formatError: error =>
    `Invalid read parameters:\n${listZodIssues(error)}\n\nUsage: read({ path: string, offset?: number, limit?: number }). The path field is required.`,
})

export type ReadInput = z.infer<typeof ReadInputSchema>
export type ReadToolAdapters = FileToolAdapters

interface ReadPayload {
  readonly resolved: ResolvedFilePath
  readonly offset: number
  readonly limit?: number
}

export class ReadTool extends FileTool<ReadInput, ReadPayload> {
  readonly spec: ToolSpec = {
    id: 'read',
    title: 'Read',
    description: READ_DESCRIPTION,
    input: ReadContract.schema,
    effects: ['read', 'external_directory', 'sensitive_file_read'],
    presentation: { kind: 'file', shell: 'default' },
    concurrency: 'parallel',
    // 这个工具**自己**已经把输出截到 2000 行 / 50KB 并附了续读提示,内核预算在这里
    // 只是兜底 —— 留出提示行的余量,否则末尾那句 "Use offset=… to continue" 会被
    // 第二把尺子剪掉。
    budget: { maxLines: DEFAULT_LIMIT + 48, maxBytes: 128 * 1024 },
  }

  async plan(input: ReadInput, ctx: PlanContext): Promise<Intent<ReadPayload>> {
    const resolved = this.resolvePath(input.path, ctx, 'read')
    return Intent.of({
      effects: this.readEffects(resolved),
      preview: this.readPreview(resolved),
      payload: { resolved, offset: input.offset ?? 1, limit: input.limit },
    })
  }

  async apply(intent: Intent<ReadPayload>, ctx: RunContext): Promise<Result> {
    const { resolved, offset, limit } = intent.payload
    const path = resolved.absolute
    ctx.abort.throwIfAborted()

    ctx.emit({
      type: 'partial',
      result: {
        content: [{ type: 'text', text: `Reading ${path}...` }],
        details: toJsonObject({ phase: 'reading', path, offset, limit }),
      },
    })
    ctx.emit({
      type: 'annotate',
      title: `Reading ${basenamePath(path)}`,
      details: toJsonObject({
        path, lineCount: 0, offset, limit,
        truncated: false, isBinary: false, fileSize: 0, sensitive: resolved.sensitive,
      }),
    })

    // 共享锁:等掉这条路径上在飞的 edit/write,读到的才是改后的字节。
    const stats = await withFileReadAccess(path, () => statPath(path))
    if (!stats) throw new Error(`File not found: ${path}`)
    ctx.abort.throwIfAborted()
    if (stats.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${path}. Use ls command via Bash tool to list directory contents.`)
    }

    if (isPdfFile(path)) {
      const metadata = this.fixedMetadata(path, stats.size)
      return this.finish(ctx, `PDF: ${basenamePath(path)}`, metadata, [
        { type: 'text', text: `[PDF file: ${path}]\nSize: ${stats.size} bytes\nThis is a PDF file. Use a PDF viewer to read its contents.` },
        { type: 'file', path },
      ])
    }

    const buffer = await withFileReadAccess(path, () => readBinaryFile(path))
    ctx.abort.throwIfAborted()

    const imageMimeType = supportedImageMimeType(path, buffer)
    if (imageMimeType) {
      const data = buffer.toString('base64')
      const text = `[Image file: ${path}]\nSize: ${stats.size} bytes\nMIME type: ${imageMimeType}\nThis image was attached for vision-capable models. Content cannot be displayed as text.`
      const metadata = { ...this.fixedMetadata(path, stats.size), mimeType: imageMimeType }
      return this.finish(ctx, `Image: ${basenamePath(path)}`, metadata, [
        { type: 'text', text },
        { type: 'image', path, data, mimeType: imageMimeType },
      ])
    }

    if (isBinaryBuffer(buffer)) {
      const metadata = this.fixedMetadata(path, stats.size)
      return this.finish(ctx, `Binary: ${basenamePath(path)}`, metadata, [
        { type: 'text', text: `[Binary file: ${path}]\nSize: ${stats.size} bytes\nThis appears to be a binary file. Content cannot be displayed as text.` },
      ])
    }

    return this.readText(ctx, intent.payload, buffer.toString('utf-8'), stats.size)
  }

  /** PDF / 图片 / 二进制三条分支共用的那份"没有行"的元数据。 */
  private fixedMetadata(path: string, fileSize: number): JsonObject {
    return { path, lineCount: 0, offset: 0, limit: 0, truncated: false, isBinary: true, fileSize }
  }

  private readText(ctx: RunContext, payload: ReadPayload, content: string, fileSize: number): Result {
    const composed = composeTextRead({
      path: payload.resolved.absolute,
      inputPath: payload.resolved.input,
      content,
      offset: payload.offset,
      limit: payload.limit,
      fileSize,
    })
    const metadata = toJsonObject(composed.metadata)
    return this.finish(
      ctx,
      `${basenamePath(payload.resolved.absolute)} (${composed.lineCount} lines)`,
      metadata,
      [{ type: 'text', text: composed.output }],
    )
  }

  private finish(ctx: RunContext, title: string, metadata: JsonObject, content: Result['content']): Result {
    ctx.emit({ type: 'partial', result: { content, details: toJsonObject({ phase: 'ready', ...metadata }) } })
    ctx.emit({ type: 'annotate', title, details: metadata })
    return { content, details: metadata }
  }
}

export function createReadTool(adapters: ReadToolAdapters = {}): ReadTool {
  return new ReadTool(adapters)
}
