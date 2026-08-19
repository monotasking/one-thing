/**
 * `read` 的行为金标(R1 起的对拍 suite,R4b 转成金标 —— 见 time.test.ts 的
 * 头注释)。临时目录在快照里被 `redactText` / `redactPaths` 换成 `<DIR>`。
 *
 * 夹具覆盖:正常 / 边界(offset+limit、行截断、空文件)/ 三种错误(不存在、目录、
 * offset 越界、参数非法)/ 取消,外加两条**权限输入**的对拍(越界目录、敏感文件)
 * 和一条附件对拍(图片)。
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultValidationMessage, zodToJsonSchema } from '../../contract.js'
import { ReadInputSchema, ReadTool } from '../../builtin/read.js'
import { Outcome } from '@onething/core/toolkit'
import {
  annotationsOf,
  attachmentsOf,
  modelTextOf,
  redactPaths,
  redactText,
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

const newTool = new ReadTool({})

interface Case {
  args: Record<string, unknown>
  dir: string
}

function run({ args, dir }: Case) {
  return runNewTool(newTool, args, { workingDirectory: dir, workingDirectoryRoots: [dir] })
}

describe('golden: read', () => {
  it('spec 钉住', () => {
    expect(newTool.spec.description).toMatchSnapshot('description')
    expect(newTool.spec.input).toEqual(zodToJsonSchema(ReadInputSchema))
    expect(newTool.spec.concurrency).toBe('parallel')
    expect(newTool.spec.presentation.kind).toBe('file')
    expect([...newTool.spec.effects].sort()).toEqual(['external_directory', 'read', 'sensitive_file_read'])
  })

  it('normal: reads a small text file', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'note.txt'), 'alpha\nbeta\ngamma\n')
    const r = await run({ args: { path: 'note.txt' }, dir })

    expect(redactText(modelTextOf(r.outcome), dir)).toMatchSnapshot('model text')
    // 渲染信息:状态标题、结果标题与 metadata 都还在
    expect(redactPaths(annotationsOf(r).map(entry => entry.title), dir)).toMatchSnapshot('annotation titles')
    expect(redactPaths(annotationsOf(r).at(-1)?.details, dir)).toMatchSnapshot('metadata')
  })

  it('boundary: offset + limit adds the same continuation footer', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'long.txt'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'))
    const r = await run({ args: { path: 'long.txt', offset: 5, limit: 10 }, dir })
    expect(redactText(modelTextOf(r.outcome), dir)).toMatchSnapshot('model text')
    expect(modelTextOf(r.outcome)).toContain('more lines in file. Use offset=15 to continue.')
  })

  it('boundary: an empty file renders the same placeholder', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'empty.txt'), '')
    const r = await run({ args: { path: 'empty.txt' }, dir })
    expect(modelTextOf(r.outcome)).toBe(`[Empty file: ${path.join(dir, 'empty.txt')}]`)
  })

  it('boundary: line truncation at 2000 lines matches, footer included', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'huge.txt'), Array.from({ length: 2500 }, (_, i) => `l${i}`).join('\n'))
    const r = await run({ args: { path: 'huge.txt' }, dir })
    expect(redactText(modelTextOf(r.outcome), dir).slice(-400)).toMatchSnapshot('tail of truncated output')
    expect(modelTextOf(r.outcome)).toContain('Use offset=2001 to continue.')
  })

  it('error: missing file', async () => {
    const dir = await tempDir()
    const r = await run({ args: { path: 'nope.txt' }, dir })
    expect(r.outcome.kind).toBe('failed')
    expect(redactText(r.outcome.kind === 'failed' ? r.outcome.message : '', dir)).toMatchSnapshot('missing file')
  })

  it('error: a directory', async () => {
    const dir = await tempDir()
    await fs.mkdir(path.join(dir, 'sub'))
    const r = await run({ args: { path: 'sub' }, dir })
    expect(r.outcome.kind).toBe('failed')
    expect(redactText(r.outcome.kind === 'failed' ? r.outcome.message : '', dir)).toMatchSnapshot('directory')
  })

  it('error: offset past EOF', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'one.txt'), 'only line')
    const r = await run({ args: { path: 'one.txt', offset: 9 }, dir })
    expect(r.outcome.kind).toBe('failed')
    expect(redactText(r.outcome.kind === 'failed' ? r.outcome.message : '', dir)).toMatchSnapshot('offset past EOF')
  })

  it('error: illegal arguments reuse the tool-specific wording', async () => {
    const dir = await tempDir()
    const parsed = ReadInputSchema.safeParse({ offset: 1 })
    expect(parsed.success).toBe(false)

    const r = await runNewTool(newTool, { offset: 1 }, { workingDirectory: dir })
    expect(r.outcome.kind).toBe('invalid')
    // R2a 决定③:invalid 的模型文本就是工具自己的文案,内核不再加
    // `Invalid tool input: ` 前缀 —— 所以这里比的是 toModelText,不是 message。
    const text = Outcome.toModelText(r.outcome)
    expect(text).toContain('Invalid read parameters:')
    expect(text).not.toBe(defaultValidationMessage(parsed.success ? undefined : parsed.error))
    expect(text).toMatchSnapshot('validation wording')
  })

  it('permission input: an out-of-sandbox path reports external_directory', async () => {
    const dir = await tempDir()
    const outside = await tempDir()
    const target = path.join(outside, 'secret.txt')
    await fs.writeFile(target, 'x')
    const r = await run({ args: { path: target }, dir })

    expect(r.intent.effects[0]?.kind).toBe('external_directory')
    expect(redactPaths(r.intent.effects, dir, outside)).toMatchSnapshot('effects')
    expect(redactPaths(r.intent.preview, dir, outside)).toMatchSnapshot('preview')
  })

  it('permission input: a sensitive file reports sensitive_file_read', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, '.env'), 'TOKEN=1')
    const r = await run({ args: { path: '.env' }, dir })

    expect(r.intent.effects[0]?.kind).toBe('sensitive_file_read')
    expect(redactPaths(r.intent.effects, dir)).toMatchSnapshot('effects')
    expect(redactPaths(r.intent.preview, dir)).toMatchSnapshot('preview')
  })

  it('attachments: an image lands as an image part carrying the payload', async () => {
    const dir = await tempDir()
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    await fs.writeFile(path.join(dir, 'pic.png'), png)
    const r = await run({ args: { path: 'pic.png' }, dir })

    expect(redactText(modelTextOf(r.outcome), dir)).toMatchSnapshot('model text')
    const attachment = attachmentsOf(r.outcome.kind === 'ok' ? r.outcome.result : { content: [] })[0]
    expect(attachment).toMatchObject({
      type: 'image',
      path: path.join(dir, 'pic.png'),
      mimeType: 'image/png',
      data: png.toString('base64'),
    })
  })

  it('cancels: an already-aborted signal yields `aborted`', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'note.txt'), 'x')
    const controller = new AbortController()
    controller.abort()
    const r = await runNewTool(newTool, { path: 'note.txt' }, {
      workingDirectory: dir,
      workingDirectoryRoots: [dir],
      signal: controller.signal,
    })
    expect(r.outcome.kind).toBe('aborted')
  })
})
