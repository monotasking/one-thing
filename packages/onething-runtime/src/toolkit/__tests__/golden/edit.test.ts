/**
 * `edit` 的行为金标(R1 起的对拍 suite,R4b 转成金标 —— 见 time.test.ts 的
 * 头注释)。临时目录在快照里被换成 `<DIR>`。
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { Decision, Outcome } from '@onething/core/toolkit'
import type { Authorizer } from '@onething/core/toolkit'
import { zodToJsonSchema } from '../../contract.js'
import { createEditTool, EditInputSchema } from '../../builtin/edit.js'
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-edit-'))
  dirs.push(await fs.realpath(dir))
  return dirs[dirs.length - 1]
}

async function fixture() {
  const dir = await tempDir()
  const auditDir = await tempDir()
  const adapters = { getFileMutationsDir: () => auditDir }
  return { dir, newTool: createEditTool(adapters) }
}

async function runEdit(input: {
  dir: string
  file: string
  original: string
  args: Record<string, unknown>
  newTool: ReturnType<typeof createEditTool>
}) {
  const target = path.join(input.dir, input.file)
  await fs.writeFile(target, input.original)
  const run = await runNewTool(input.newTool, input.args, {
    workingDirectory: input.dir,
    workingDirectoryRoots: [input.dir],
  })
  const contentAfter = await fs.readFile(target, 'utf-8').catch(() => undefined)
  return { run, contentAfter, target }
}

describe('golden: edit', () => {
  it('spec 钉住', async () => {
    const { newTool } = await fixture()
    expect(newTool.spec.description).toMatchSnapshot('description')
    expect(newTool.spec.input).toEqual(zodToJsonSchema(EditInputSchema))
    expect(newTool.spec.concurrency).toBe('sequential')
    expect(newTool.spec.presentation.kind).toBe('diff')
    expect([...newTool.spec.effects].sort())
      .toEqual(['external_directory', 'file_destructive_edit', 'file_edit'])
    // R2a 决定②:提示词贡献回到 spec 上。
    expect(newTool.spec.prompt).toMatchSnapshot('prompt contribution')
  })

  it('normal: one replacement — output, effects, preview and file bytes', async () => {
    const { dir, newTool } = await fixture()
    const bundle = await runEdit({
      dir, file: 'a.ts', original: 'const a = 1\nconst b = 2\n',
      args: { path: 'a.ts', edits: [{ oldText: 'const b = 2', newText: 'const b = 3' }] },
      newTool,
    })

    expect(redactText(modelTextOf(bundle.run.outcome), dir)).toMatchSnapshot('model text')
    expect(redactPaths(bundle.run.intent.effects, dir)).toMatchSnapshot('effects')
    expect(redactPaths(bundle.run.intent.preview, dir)).toMatchSnapshot('preview')
    expect(bundle.contentAfter).toBe('const a = 1\nconst b = 3\n')
    expect(bundle.run.intent.effects[0]?.kind).toBe('file_edit')
    expect(attachmentsOf(bundle.run.outcome.kind === 'ok' ? bundle.run.outcome.result : { content: [] }))
      .toEqual([{ type: 'file', path: bundle.target }])
    // 渲染信息:最后一次 metadata 的键一个不少
    expect(Object.keys(annotationsOf(bundle.run).at(-1)?.details ?? {}).sort()).toMatchSnapshot('metadata keys')
  })

  it('boundary: replaceAll across repeated blocks', async () => {
    const { dir, newTool } = await fixture()
    const bundle = await runEdit({
      dir, file: 'b.ts', original: 'x\nx\nx\n',
      args: { path: 'b.ts', edits: [{ oldText: 'x', newText: 'y', replaceAll: true }] },
      newTool,
    })
    expect(redactText(modelTextOf(bundle.run.outcome), dir)).toMatchSnapshot('model text')
    expect(bundle.contentAfter).toBe('y\ny\ny\n')
  })

  it('boundary: a large deletion escalates to file_destructive_edit', async () => {
    const { dir, newTool } = await fixture()
    const original = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    const bundle = await runEdit({
      dir, file: 'c.ts', original,
      args: { path: 'c.ts', edits: [{ oldText: original, newText: 'line 0' }] },
      newTool,
    })
    expect(redactPaths(bundle.run.intent.effects, dir)).toMatchSnapshot('effects')
    expect(bundle.run.intent.effects[0]?.kind).toBe('file_destructive_edit')
    expect(bundle.run.intent.effects[0]?.metadata?.risk).toBe('large_deletion')
  })

  it('error: a non-matching oldText yields the teaching text', async () => {
    const { dir, newTool } = await fixture()
    const bundle = await runEdit({
      dir, file: 'd.ts', original: 'alpha\nbeta\n',
      args: { path: 'd.ts', edits: [{ oldText: 'gamma', newText: 'delta' }] },
      newTool,
    })
    expect(bundle.run.outcome.kind).toBe('failed')
    const message = bundle.run.outcome.kind === 'failed' ? bundle.run.outcome.message : ''
    expect(message).toContain('Edit failed')
    expect(redactText(message, dir)).toMatchSnapshot('no match')
  })

  it('error: a missing file', async () => {
    const { dir, newTool } = await fixture()
    const run = await runNewTool(newTool, { path: 'ghost.ts', edits: [{ oldText: 'a', newText: 'b' }] }, {
      workingDirectory: dir,
      workingDirectoryRoots: [dir],
    })
    expect(run.outcome.kind).toBe('failed')
    const message = run.outcome.kind === 'failed' ? run.outcome.message : ''
    expect(message).toContain('File not found')
    expect(redactText(message, dir)).toMatchSnapshot('missing file')
  })

  it('error: illegal arguments reuse the tool-specific wording', async () => {
    const { dir, newTool } = await fixture()
    const run = await runNewTool(newTool, { path: 'a.ts', edits: [] }, { workingDirectory: dir })
    expect(run.outcome.kind).toBe('invalid')
    // R2a 决定③:invalid 的模型文本就是工具自己的文案,内核不再加
    // `Invalid tool input: ` 前缀 —— 所以这里钉的是 toModelText,不是 message。
    const text = Outcome.toModelText(run.outcome)
    expect(text).toContain('Invalid edit parameters:')
    expect(text).toMatchSnapshot('validation wording')
  })

  it('error: the file changing during approval', async () => {
    const { dir, newTool } = await fixture()
    const target = path.join(dir, 'e.ts')
    const args = { path: 'e.ts', edits: [{ oldText: 'beta', newText: 'BETA' }] }
    const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }

    await fs.writeFile(target, 'alpha\nbeta\n')
    const meddling: Authorizer = {
      async decide() {
        await fs.writeFile(target, 'alpha\nbeta\ngamma\ndelta\n')
        return Decision.allow()
      },
    }
    const run = await runNewTool(newTool, args, { ...options, authorizer: meddling })
    expect(run.outcome.kind).toBe('failed')
    expect(redactText(run.outcome.kind === 'failed' ? run.outcome.message : '', dir))
      .toMatchSnapshot('changed during approval')
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
