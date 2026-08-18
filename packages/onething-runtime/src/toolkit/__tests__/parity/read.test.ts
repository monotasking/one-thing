/**
 * R1 对拍 —— `read`。旧 `tools/builtin/read.ts` vs 新 `toolkit/builtin/read.ts`。
 *
 * 夹具覆盖:正常 / 边界(offset+limit、行截断、空文件)/ 三种错误(不存在、目录、
 * offset 越界、参数非法)/ 取消,外加两条**权限输入**的对拍(越界目录、敏感文件)
 * 和一条附件对拍(图片)。
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReadTool as createLegacyReadTool } from '../../../tools/builtin/read.js'
import { zodToJsonSchema } from '../../../tools/tool.js'
import { ReadInputSchema, ReadTool } from '../../builtin/read.js'
import { Outcome } from '@onething/core/toolkit'
import {
  annotationsOf,
  attachmentsOf,
  legacyContext,
  modelTextOf,
  normalizeEffects,
  runNewTool,
} from '../support.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-read-'))
  dirs.push(await fs.realpath(dir))
  return dirs[dirs.length - 1]
}

const legacyTool = createLegacyReadTool({})
const newTool = new ReadTool({})

interface Case {
  args: Record<string, unknown>
  dir: string
}

async function bothPlans({ args, dir }: Case) {
  const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }
  const { ctx } = legacyContext(options)
  const analysis = await legacyTool.analyze!(args as never, ctx as never)
  const run = await runNewTool(newTool, args, options)
  return { analysis, run }
}

async function bothRuns({ args, dir }: Case) {
  const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }
  const { ctx, record } = legacyContext(options)
  ctx.approvedAnalysis = await legacyTool.analyze!(args as never, ctx as never)
  const legacy = await legacyTool.execute(args as never, ctx as never).then(
    result => ({ result, error: undefined }),
    (error: Error) => ({ result: undefined, error }),
  )
  const run = await runNewTool(newTool, args, options)
  return { legacy, record, run }
}

describe('parity: read', () => {
  it('spec is pinned to the legacy tool', () => {
    expect(newTool.spec.description).toBe(legacyTool.description)
    expect(newTool.spec.input).toEqual(zodToJsonSchema(ReadInputSchema))
    expect(newTool.spec.input).toEqual(zodToJsonSchema(legacyTool.parameters))
    expect(newTool.spec.concurrency).toBe('parallel')
    expect(newTool.spec.presentation.kind).toBe('file')
    expect([...newTool.spec.effects].sort()).toEqual(['external_directory', 'read', 'sensitive_file_read'])
  })

  it('normal: reads a small text file', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'note.txt'), 'alpha\nbeta\ngamma\n')
    const { legacy, record, run } = await bothRuns({ args: { path: 'note.txt' }, dir })

    expect(modelTextOf(run.outcome)).toBe(legacy.result!.output)
    // (d) 渲染信息:旧的 metadata 与结果标题都还在
    expect(annotationsOf(run).map(entry => entry.title)).toContain(record.metadataCalls[0]?.title)
    expect(annotationsOf(run).at(-1)?.title).toBe(legacy.result!.title)
    expect(annotationsOf(run).at(-1)?.details).toEqual(legacy.result!.metadata)
  })

  it('boundary: offset + limit adds the same continuation footer', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'long.txt'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'))
    const { legacy, run } = await bothRuns({ args: { path: 'long.txt', offset: 5, limit: 10 }, dir })
    expect(modelTextOf(run.outcome)).toBe(legacy.result!.output)
    expect(modelTextOf(run.outcome)).toContain('more lines in file. Use offset=15 to continue.')
  })

  it('boundary: an empty file renders the same placeholder', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'empty.txt'), '')
    const { legacy, run } = await bothRuns({ args: { path: 'empty.txt' }, dir })
    expect(modelTextOf(run.outcome)).toBe(legacy.result!.output)
    expect(modelTextOf(run.outcome)).toBe(`[Empty file: ${path.join(dir, 'empty.txt')}]`)
  })

  it('boundary: line truncation at 2000 lines matches, footer included', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'huge.txt'), Array.from({ length: 2500 }, (_, i) => `l${i}`).join('\n'))
    const { legacy, run } = await bothRuns({ args: { path: 'huge.txt' }, dir })
    expect(modelTextOf(run.outcome)).toBe(legacy.result!.output)
    expect(modelTextOf(run.outcome)).toContain('Use offset=2001 to continue.')
  })

  it('error: missing file reports the same message', async () => {
    const dir = await tempDir()
    const { legacy, run } = await bothRuns({ args: { path: 'nope.txt' }, dir })
    expect(legacy.error).toBeInstanceOf(Error)
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toBe(legacy.error!.message)
  })

  it('error: a directory reports the same message', async () => {
    const dir = await tempDir()
    await fs.mkdir(path.join(dir, 'sub'))
    const { legacy, run } = await bothRuns({ args: { path: 'sub' }, dir })
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toBe(legacy.error!.message)
  })

  it('error: offset past EOF reports the same message', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'one.txt'), 'only line')
    const { legacy, run } = await bothRuns({ args: { path: 'one.txt', offset: 9 }, dir })
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toBe(legacy.error!.message)
  })

  it('error: illegal arguments reuse the tool-specific wording', async () => {
    const dir = await tempDir()
    const parsed = legacyTool.parameters.safeParse({ offset: 1 })
    expect(parsed.success).toBe(false)
    const legacyMessage = legacyTool.formatValidationError!(parsed.success ? (undefined as never) : parsed.error)

    const run = await runNewTool(newTool, { offset: 1 }, { workingDirectory: dir })
    expect(run.outcome.kind).toBe('invalid')
    // R2a 决定③:invalid 的模型文本就是工具自己的文案,内核不再加
    // `Invalid tool input: ` 前缀 —— 所以这里比的是 toModelText,不是 message。
    expect(Outcome.toModelText(run.outcome)).toBe(legacyMessage)
    expect(legacyMessage).toContain('Invalid read parameters:')
  })

  it('permission input: an out-of-sandbox path reports external_directory identically', async () => {
    const dir = await tempDir()
    const outside = await tempDir()
    const target = path.join(outside, 'secret.txt')
    await fs.writeFile(target, 'x')
    const { analysis, run } = await bothPlans({ args: { path: target }, dir })

    expect(normalizeEffects(run.intent.effects)).toEqual(normalizeEffects(analysis.effects))
    expect(run.intent.preview).toEqual(analysis.preview)
    expect(analysis.effects[0]?.kind).toBe('external_directory')
  })

  it('permission input: a sensitive file reports sensitive_file_read identically', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, '.env'), 'TOKEN=1')
    const { analysis, run } = await bothPlans({ args: { path: '.env' }, dir })

    expect(normalizeEffects(run.intent.effects)).toEqual(normalizeEffects(analysis.effects))
    expect(run.intent.preview).toEqual(analysis.preview)
    expect(analysis.effects[0]?.kind).toBe('sensitive_file_read')
  })

  it('attachments: an image lands as an image part carrying the same payload', async () => {
    const dir = await tempDir()
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    await fs.writeFile(path.join(dir, 'pic.png'), png)
    const { legacy, run } = await bothRuns({ args: { path: 'pic.png' }, dir })

    expect(modelTextOf(run.outcome)).toBe(legacy.result!.output)
    const attachment = attachmentsOf(run.outcome.kind === 'ok' ? run.outcome.result : { content: [] })[0]
    expect(attachment).toMatchObject({
      type: 'image',
      path: path.join(dir, 'pic.png'),
      mimeType: 'image/png',
      data: legacy.result!.attachments![0].content,
    })
  })

  it('cancels: an already-aborted signal yields `aborted`', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'note.txt'), 'x')
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(newTool, { path: 'note.txt' }, {
      workingDirectory: dir,
      workingDirectoryRoots: [dir],
      signal: controller.signal,
    })
    expect(run.outcome.kind).toBe('aborted')
  })
})
