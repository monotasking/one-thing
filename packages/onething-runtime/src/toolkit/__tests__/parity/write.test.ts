/**
 * R1 对拍 —— `write`。旧 `tools/builtin/write.ts` vs 新 `toolkit/builtin/write.ts`。
 *
 * 「审批期间文件被改了」那条路在新树里有了一个更诚实的复刻方式:传一个在
 * `decide()` 里动手脚的 Authorizer —— plan 与 apply 之间的那段时间**就是**审批。
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { Decision, Outcome } from '@onething/core/toolkit'
import type { Authorizer } from '@onething/core/toolkit'
import { createWriteTool as createLegacyWriteTool } from '../../../tools/builtin/write.js'
import { zodToJsonSchema } from '../../../tools/tool.js'
import { createWriteTool, WriteInputSchema } from '../../builtin/write.js'
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-write-'))
  dirs.push(await fs.realpath(dir))
  return dirs[dirs.length - 1]
}

async function fixture() {
  const dir = await tempDir()
  const auditDir = await tempDir()
  const adapters = { getFileMutationsDir: () => auditDir }
  return { dir, auditDir, legacyTool: createLegacyWriteTool(adapters), newTool: createWriteTool(adapters) }
}

describe('parity: write', () => {
  it('spec is pinned to the legacy tool', async () => {
    const { legacyTool, newTool } = await fixture()
    expect(newTool.spec.description).toBe(legacyTool.description)
    expect(newTool.spec.input).toEqual(zodToJsonSchema(WriteInputSchema))
    expect(newTool.spec.input).toEqual(zodToJsonSchema(legacyTool.parameters))
    expect(newTool.spec.concurrency).toBe('sequential')
    expect(newTool.spec.presentation.kind).toBe('diff')
    expect([...newTool.spec.effects].sort()).toEqual(['external_directory', 'file_write'])
    // R2a 决定②:提示词贡献回到 spec 上,与旧工具的 `prompt` 逐字相同。
    expect(newTool.spec.prompt).toEqual(legacyTool.prompt)
    expect(newTool.spec.prompt).toEqual({ guidelines: ['使用write来重写或创建文件'] })
  })

  it('normal: creates a file, same output / effects / preview / audit metadata', async () => {
    const { dir, legacyTool, newTool } = await fixture()
    const args = { path: path.join('nested', 'note.txt'), content: 'hello\n' }
    const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }

    const { ctx, record } = legacyContext(options)
    const analysis = await legacyTool.analyze!(args as never, ctx as never)
    ctx.approvedAnalysis = analysis
    const legacy = await legacyTool.execute(args as never, ctx as never)
    await fs.rm(path.join(dir, 'nested'), { recursive: true, force: true })

    const run = await runNewTool(newTool, args, options)
    expect(run.outcome.kind).toBe('ok')

    // (a) 模型文本
    expect(modelTextOf(run.outcome)).toBe(legacy.output)
    // (b) 权限输入
    expect(normalizeEffects(run.intent.effects)).toEqual(normalizeEffects(analysis.effects))
    expect(run.intent.preview).toEqual(analysis.preview)
    // (d) 渲染信息:附件 + 最后一次 metadata 的字段一个不少
    expect(attachmentsOf(run.outcome.kind === 'ok' ? run.outcome.result : { content: [] }))
      .toEqual([{ type: 'file', path: path.join(dir, 'nested', 'note.txt') }])
    const finalDetails = annotationsOf(run).at(-1)?.details ?? {}
    const legacyFinal = record.metadataCalls.at(-1)?.metadata ?? {}
    for (const key of Object.keys(legacyFinal)) expect(Object.keys(finalDetails)).toContain(key)
    expect(await fs.readFile(path.join(dir, 'nested', 'note.txt'), 'utf-8')).toBe('hello\n')
  })

  it('boundary: overwriting an existing file yields the same diff counts', async () => {
    const { dir, legacyTool, newTool } = await fixture()
    const target = path.join(dir, 'note.txt')
    await fs.writeFile(target, 'one\ntwo\nthree\n')
    const args = { path: 'note.txt', content: 'one\ntwo changed\n' }
    const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }

    const { ctx } = legacyContext(options)
    const analysis = await legacyTool.analyze!(args as never, ctx as never)
    const run = await runNewTool(newTool, args, options)

    expect(normalizeEffects(run.intent.effects)).toEqual(normalizeEffects(analysis.effects))
    expect(run.intent.preview).toEqual(analysis.preview)
    expect(analysis.preview?.title).toBe('Overwrite note.txt')
    expect(await fs.readFile(target, 'utf-8')).toBe('one\ntwo changed\n')
  })

  it('permission input: an out-of-sandbox target is flagged external identically', async () => {
    const { dir, legacyTool, newTool } = await fixture()
    const outside = await tempDir()
    const args = { path: path.join(outside, 'x.txt'), content: 'x' }
    const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }

    const { ctx } = legacyContext(options)
    const analysis = await legacyTool.analyze!(args as never, ctx as never)
    const run = await runNewTool(newTool, args, options)

    expect(normalizeEffects(run.intent.effects)).toEqual(normalizeEffects(analysis.effects))
    expect(analysis.effects[0]?.external).toBe(true)
  })

  it('error: illegal arguments reuse the tool-specific wording', async () => {
    const { dir, legacyTool, newTool } = await fixture()
    const parsed = legacyTool.parameters.safeParse({ path: 'a.txt' })
    const legacyMessage = legacyTool.formatValidationError!(parsed.success ? (undefined as never) : parsed.error)

    const run = await runNewTool(newTool, { path: 'a.txt' }, { workingDirectory: dir })
    expect(run.outcome.kind).toBe('invalid')
    // R2a 决定③:invalid 的模型文本就是工具自己的文案,内核不再加
    // `Invalid tool input: ` 前缀 —— 所以这里比的是 toModelText,不是 message。
    expect(Outcome.toModelText(run.outcome)).toBe(legacyMessage)
    expect(legacyMessage).toContain('Invalid write parameters:')
  })

  it('error: the file changing during approval aborts the write with the same message', async () => {
    const { dir, legacyTool, newTool } = await fixture()
    const target = path.join(dir, 'note.txt')
    const args = { path: 'note.txt', content: 'new content\n' }
    const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }

    await fs.writeFile(target, 'original\n')
    const { ctx } = legacyContext(options)
    ctx.approvedAnalysis = await legacyTool.analyze!(args as never, ctx as never)
    await fs.writeFile(target, 'changed by someone else\n')
    const legacyError = await legacyTool.execute(args as never, ctx as never).then(
      () => undefined,
      (error: Error) => error,
    )
    expect(legacyError).toBeInstanceOf(Error)

    await fs.writeFile(target, 'original\n')
    const meddling: Authorizer = {
      async decide() {
        await fs.writeFile(target, 'changed by someone else\n')
        return Decision.allow()
      },
    }
    const run = await runNewTool(newTool, args, { ...options, authorizer: meddling })
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toBe(legacyError!.message)
  })

  it('error: an unwritable target fails the same way on both paths', async () => {
    const { dir, legacyTool, newTool } = await fixture()
    await fs.mkdir(path.join(dir, 'blocked'))
    const args = { path: 'blocked', content: 'x' }
    const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }

    // 旧路在 **analyze** 就炸了(目标是目录);新路同一句话落在 plan 上。两边都
    // 走失败,消息逐字相同 —— 差别只在"哪一阶段",而那正是两阶段协议的重点。
    const { ctx } = legacyContext(options)
    const legacyError = await (async () => {
      try {
        ctx.approvedAnalysis = await legacyTool.analyze!(args as never, ctx as never)
        await legacyTool.execute(args as never, ctx as never)
        return undefined
      } catch (error) {
        return error as Error
      }
    })()
    const run = await runNewTool(newTool, args, options)

    expect(legacyError).toBeInstanceOf(Error)
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toBe(legacyError!.message)
  })

  it('cancels: an already-aborted signal yields `aborted` and writes nothing', async () => {
    const { dir, newTool } = await fixture()
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(newTool, { path: 'note.txt', content: 'x' }, {
      workingDirectory: dir,
      workingDirectoryRoots: [dir],
      signal: controller.signal,
    })
    expect(run.outcome.kind).toBe('aborted')
    await expect(fs.readFile(path.join(dir, 'note.txt'), 'utf-8')).rejects.toThrow()
  })
})
