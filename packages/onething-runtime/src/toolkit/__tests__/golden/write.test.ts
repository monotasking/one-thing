/**
 * `write` 的行为金标(R1 起的对拍 suite,R4b 转成金标 —— 见 time.test.ts 的
 * 头注释)。临时目录在快照里被换成 `<DIR>`。
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
import { zodToJsonSchema } from '../../contract.js'
import { createWriteTool, WriteInputSchema } from '../../builtin/write.js'
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-write-'))
  dirs.push(await fs.realpath(dir))
  return dirs[dirs.length - 1]
}

async function fixture() {
  const dir = await tempDir()
  const auditDir = await tempDir()
  const adapters = { getFileMutationsDir: () => auditDir }
  return { dir, auditDir, newTool: createWriteTool(adapters) }
}

describe('golden: write', () => {
  it('spec 钉住', async () => {
    const { newTool } = await fixture()
    expect(newTool.spec.description).toMatchSnapshot('description')
    expect(newTool.spec.input).toEqual(zodToJsonSchema(WriteInputSchema))
    expect(newTool.spec.concurrency).toBe('sequential')
    expect(newTool.spec.presentation.kind).toBe('diff')
    expect([...newTool.spec.effects].sort()).toEqual(['external_directory', 'file_write'])
    // R2a 决定②:提示词贡献回到 spec 上。
    expect(newTool.spec.prompt).toEqual({ guidelines: ['使用write来重写或创建文件'] })
  })

  it('normal: creates a file — output / effects / preview / audit metadata', async () => {
    const { dir, newTool } = await fixture()
    const args = { path: path.join('nested', 'note.txt'), content: 'hello\n' }
    const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }

    const run = await runNewTool(newTool, args, options)
    expect(run.outcome.kind).toBe('ok')

    // (a) 模型文本
    expect(redactText(modelTextOf(run.outcome), dir)).toMatchSnapshot('model text')
    // (b) 权限输入
    expect(redactPaths(run.intent.effects, dir)).toMatchSnapshot('effects')
    expect(redactPaths(run.intent.preview, dir)).toMatchSnapshot('preview')
    // (d) 渲染信息:附件 + 最后一次 metadata 的键一个不少
    expect(attachmentsOf(run.outcome.kind === 'ok' ? run.outcome.result : { content: [] }))
      .toEqual([{ type: 'file', path: path.join(dir, 'nested', 'note.txt') }])
    expect(Object.keys(annotationsOf(run).at(-1)?.details ?? {}).sort()).toMatchSnapshot('metadata keys')
    expect(await fs.readFile(path.join(dir, 'nested', 'note.txt'), 'utf-8')).toBe('hello\n')
  })

  it('boundary: overwriting an existing file yields the pinned diff counts', async () => {
    const { dir, newTool } = await fixture()
    const target = path.join(dir, 'note.txt')
    await fs.writeFile(target, 'one\ntwo\nthree\n')
    const args = { path: 'note.txt', content: 'one\ntwo changed\n' }
    const run = await runNewTool(newTool, args, { workingDirectory: dir, workingDirectoryRoots: [dir] })

    expect(redactPaths(run.intent.effects, dir)).toMatchSnapshot('effects')
    expect(redactPaths(run.intent.preview, dir)).toMatchSnapshot('preview')
    expect(run.intent.preview?.title).toBe('Overwrite note.txt')
    expect(await fs.readFile(target, 'utf-8')).toBe('one\ntwo changed\n')
  })

  it('permission input: an out-of-sandbox target is flagged external', async () => {
    const { dir, newTool } = await fixture()
    const outside = await tempDir()
    const args = { path: path.join(outside, 'x.txt'), content: 'x' }
    const run = await runNewTool(newTool, args, { workingDirectory: dir, workingDirectoryRoots: [dir] })

    expect(run.intent.effects[0]?.external).toBe(true)
    expect(redactPaths(run.intent.effects, dir, outside)).toMatchSnapshot('effects')
  })

  it('error: illegal arguments reuse the tool-specific wording', async () => {
    const { dir, newTool } = await fixture()
    const run = await runNewTool(newTool, { path: 'a.txt' }, { workingDirectory: dir })
    expect(run.outcome.kind).toBe('invalid')
    // R2a 决定③:invalid 的模型文本就是工具自己的文案,内核不再加
    // `Invalid tool input: ` 前缀 —— 所以这里钉的是 toModelText,不是 message。
    const text = Outcome.toModelText(run.outcome)
    expect(text).toContain('Invalid write parameters:')
    expect(text).toMatchSnapshot('validation wording')
  })

  it('error: the file changing during approval aborts the write', async () => {
    const { dir, newTool } = await fixture()
    const target = path.join(dir, 'note.txt')
    const args = { path: 'note.txt', content: 'new content\n' }
    const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }

    await fs.writeFile(target, 'original\n')
    const meddling: Authorizer = {
      async decide() {
        await fs.writeFile(target, 'changed by someone else\n')
        return Decision.allow()
      },
    }
    const run = await runNewTool(newTool, args, { ...options, authorizer: meddling })
    expect(run.outcome.kind).toBe('failed')
    expect(redactText(run.outcome.kind === 'failed' ? run.outcome.message : '', dir))
      .toMatchSnapshot('changed during approval')
  })

  it('error: an unwritable target fails in plan', async () => {
    const { dir, newTool } = await fixture()
    await fs.mkdir(path.join(dir, 'blocked'))
    // 旧路在 **analyze** 就炸了(目标是目录);新路同一句话落在 plan 上 —— 差别只
    // 在"哪一阶段",而那正是两阶段协议的重点。
    const run = await runNewTool(newTool, { path: 'blocked', content: 'x' }, {
      workingDirectory: dir,
      workingDirectoryRoots: [dir],
    })
    expect(run.outcome.kind).toBe('failed')
    expect(redactText(run.outcome.kind === 'failed' ? run.outcome.message : '', dir))
      .toMatchSnapshot('unwritable target')
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
