/**
 * R1 对拍 —— `edit`。旧 `tools/builtin/edit.ts` vs 新 `toolkit/builtin/edit.ts`。
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { Decision, Outcome } from '@onething/core/toolkit'
import type { Authorizer } from '@onething/core/toolkit'
import { createEditTool as createLegacyEditTool } from '../../../tools/builtin/edit.js'
import { zodToJsonSchema } from '../../../tools/tool.js'
import { createEditTool, EditInputSchema } from '../../builtin/edit.js'
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-edit-'))
  dirs.push(await fs.realpath(dir))
  return dirs[dirs.length - 1]
}

async function fixture() {
  const dir = await tempDir()
  const auditDir = await tempDir()
  const adapters = { getFileMutationsDir: () => auditDir }
  return { dir, legacyTool: createLegacyEditTool(adapters), newTool: createEditTool(adapters) }
}

/** 两边都跑一遍(旧的每次跑前把文件恢复原状,免得第二次跑在改过的内容上)。 */
async function bothRuns(input: {
  dir: string
  file: string
  original: string
  args: Record<string, unknown>
  legacyTool: ReturnType<typeof createLegacyEditTool>
  newTool: ReturnType<typeof createEditTool>
}) {
  const target = path.join(input.dir, input.file)
  const options = { workingDirectory: input.dir, workingDirectoryRoots: [input.dir] }

  await fs.writeFile(target, input.original)
  const { ctx, record } = legacyContext(options)
  const legacy = await (async () => {
    try {
      const analysis = await input.legacyTool.analyze!(input.args as never, ctx as never)
      ctx.approvedAnalysis = analysis
      const result = await input.legacyTool.execute(input.args as never, ctx as never)
      return { analysis, result, error: undefined }
    } catch (error) {
      return { analysis: undefined, result: undefined, error: error as Error }
    }
  })()
  const legacyContentAfter = await fs.readFile(target, 'utf-8').catch(() => undefined)

  await fs.writeFile(target, input.original)
  const run = await runNewTool(input.newTool, input.args, options)
  const newContentAfter = await fs.readFile(target, 'utf-8').catch(() => undefined)

  return { legacy, record, run, legacyContentAfter, newContentAfter, target }
}

describe('parity: edit', () => {
  it('spec is pinned to the legacy tool', async () => {
    const { legacyTool, newTool } = await fixture()
    expect(newTool.spec.description).toBe(legacyTool.description)
    expect(newTool.spec.input).toEqual(zodToJsonSchema(EditInputSchema))
    expect(newTool.spec.input).toEqual(zodToJsonSchema(legacyTool.parameters))
    expect(newTool.spec.concurrency).toBe('sequential')
    expect(newTool.spec.presentation.kind).toBe('diff')
    expect([...newTool.spec.effects].sort())
      .toEqual(['external_directory', 'file_destructive_edit', 'file_edit'])
    // R2a 决定②:提示词贡献回到 spec 上,与旧工具的 `prompt` 逐字相同。
    expect(newTool.spec.prompt).toEqual(legacyTool.prompt)
  })

  it('normal: one replacement — same output, effects, preview and file bytes', async () => {
    const { dir, legacyTool, newTool } = await fixture()
    const bundle = await bothRuns({
      dir, file: 'a.ts', original: 'const a = 1\nconst b = 2\n',
      args: { path: 'a.ts', edits: [{ oldText: 'const b = 2', newText: 'const b = 3' }] },
      legacyTool, newTool,
    })

    expect(modelTextOf(bundle.run.outcome)).toBe(bundle.legacy.result!.output)
    expect(normalizeEffects(bundle.run.intent.effects)).toEqual(normalizeEffects(bundle.legacy.analysis!.effects))
    expect(bundle.run.intent.preview).toEqual(bundle.legacy.analysis!.preview)
    expect(bundle.newContentAfter).toBe(bundle.legacyContentAfter)
    expect(bundle.legacy.analysis!.effects[0]?.kind).toBe('file_edit')
    expect(attachmentsOf(bundle.run.outcome.kind === 'ok' ? bundle.run.outcome.result : { content: [] }))
      .toEqual([{ type: 'file', path: bundle.target }])
    // (d) 渲染信息:最后一次 metadata 的字段一个不少
    const finalDetails = annotationsOf(bundle.run).at(-1)?.details ?? {}
    for (const key of Object.keys(bundle.record.metadataCalls.at(-1)?.metadata ?? {})) {
      expect(Object.keys(finalDetails)).toContain(key)
    }
  })

  it('boundary: replaceAll across repeated blocks', async () => {
    const { dir, legacyTool, newTool } = await fixture()
    const bundle = await bothRuns({
      dir, file: 'b.ts', original: 'x\nx\nx\n',
      args: { path: 'b.ts', edits: [{ oldText: 'x', newText: 'y', replaceAll: true }] },
      legacyTool, newTool,
    })
    expect(modelTextOf(bundle.run.outcome)).toBe(bundle.legacy.result!.output)
    expect(bundle.newContentAfter).toBe(bundle.legacyContentAfter)
    expect(bundle.newContentAfter).toBe('y\ny\ny\n')
  })

  it('boundary: a large deletion escalates to file_destructive_edit identically', async () => {
    const { dir, legacyTool, newTool } = await fixture()
    const original = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    const bundle = await bothRuns({
      dir, file: 'c.ts', original,
      args: { path: 'c.ts', edits: [{ oldText: original, newText: 'line 0' }] },
      legacyTool, newTool,
    })
    expect(normalizeEffects(bundle.run.intent.effects)).toEqual(normalizeEffects(bundle.legacy.analysis!.effects))
    expect(bundle.legacy.analysis!.effects[0]?.kind).toBe('file_destructive_edit')
    expect(bundle.legacy.analysis!.effects[0]?.metadata?.risk).toBe('large_deletion')
  })

  it('error: a non-matching oldText yields the same teaching text', async () => {
    const { dir, legacyTool, newTool } = await fixture()
    const bundle = await bothRuns({
      dir, file: 'd.ts', original: 'alpha\nbeta\n',
      args: { path: 'd.ts', edits: [{ oldText: 'gamma', newText: 'delta' }] },
      legacyTool, newTool,
    })
    expect(bundle.legacy.error).toBeInstanceOf(Error)
    expect(bundle.run.outcome.kind).toBe('failed')
    expect(bundle.run.outcome.kind === 'failed' && bundle.run.outcome.message)
      .toBe(bundle.legacy.error!.message)
    expect(bundle.legacy.error!.message).toContain('Edit failed')
  })

  it('error: a missing file yields the same message', async () => {
    const { dir, legacyTool, newTool } = await fixture()
    const args = { path: 'ghost.ts', edits: [{ oldText: 'a', newText: 'b' }] }
    const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }
    const { ctx } = legacyContext(options)
    const legacyError = await Promise.resolve(legacyTool.analyze!(args as never, ctx as never)).then(
      () => undefined,
      (error: Error) => error,
    )
    const run = await runNewTool(newTool, args, options)

    expect(legacyError).toBeInstanceOf(Error)
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toBe(legacyError!.message)
    expect(legacyError!.message).toContain('File not found')
  })

  it('error: illegal arguments reuse the tool-specific wording', async () => {
    const { dir, legacyTool, newTool } = await fixture()
    const parsed = legacyTool.parameters.safeParse({ path: 'a.ts', edits: [] })
    const legacyMessage = legacyTool.formatValidationError!(parsed.success ? (undefined as never) : parsed.error)

    const run = await runNewTool(newTool, { path: 'a.ts', edits: [] }, { workingDirectory: dir })
    expect(run.outcome.kind).toBe('invalid')
    // R2a 决定③:invalid 的模型文本就是工具自己的文案,内核不再加
    // `Invalid tool input: ` 前缀 —— 所以这里比的是 toModelText,不是 message。
    expect(Outcome.toModelText(run.outcome)).toBe(legacyMessage)
    expect(legacyMessage).toContain('Invalid edit parameters:')
  })

  it('error: the file changing during approval yields the same message', async () => {
    const { dir, legacyTool, newTool } = await fixture()
    const target = path.join(dir, 'e.ts')
    const args = { path: 'e.ts', edits: [{ oldText: 'beta', newText: 'BETA' }] }
    const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }

    await fs.writeFile(target, 'alpha\nbeta\n')
    const { ctx } = legacyContext(options)
    ctx.approvedAnalysis = await legacyTool.analyze!(args as never, ctx as never)
    await fs.writeFile(target, 'alpha\nbeta\ngamma\ndelta\n')
    const legacyError = await legacyTool.execute(args as never, ctx as never).then(
      () => undefined,
      (error: Error) => error,
    )
    expect(legacyError).toBeInstanceOf(Error)

    await fs.writeFile(target, 'alpha\nbeta\n')
    const meddling: Authorizer = {
      async decide() {
        await fs.writeFile(target, 'alpha\nbeta\ngamma\ndelta\n')
        return Decision.allow()
      },
    }
    const run = await runNewTool(newTool, args, { ...options, authorizer: meddling })
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toBe(legacyError!.message)
  })

  it('cancels: an already-aborted signal yields `aborted` and leaves the file alone', async () => {
    const { dir, newTool } = await fixture()
    const target = path.join(dir, 'f.ts')
    await fs.writeFile(target, 'alpha\n')
    const controller = new AbortController()
    controller.abort()

    const run = await runNewTool(newTool, { path: 'f.ts', edits: [{ oldText: 'alpha', newText: 'omega' }] }, {
      workingDirectory: dir,
      workingDirectoryRoots: [dir],
      signal: controller.signal,
    })
    expect(run.outcome.kind).toBe('aborted')
    expect(await fs.readFile(target, 'utf-8')).toBe('alpha\n')
  })
})
