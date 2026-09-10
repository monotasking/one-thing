/**
 * K3-c —— 目录 provider 与它那只读守卫。
 *
 * 跑的是**真** fs(一个临时目录)与**真**判据(沙箱那三只函数、敏感文件分类器都是
 * 产品层那一份),假的只有「沙箱根在哪」—— 因为那正是这只测试要摆布的那一格。
 *
 * 证的七句话:
 *   ① `list` 交出的是自述说的那个形状(`kind: 'file' | 'dir'`,目录在前),而
 *      `node_modules` / `.git` 由共用那只列目录函数跳过 —— 这一条同时是「没有复制
 *      一份列目录代码」的证据:那两个名字这只 provider 里一个字都没写;
 *   ② `stat` 一个文件答 `kind: 'file'` 且带回展开后的绝对路径;
 *   ③ 越界拒(反证①:拆掉 provider 的 `readable` 判,这一条红);
 *   ④ 敏感路径拒(`.env`,判据是产品层那只分类器);
 *   ⑤ **没有沙箱一律拒** —— 缺席不是放行(反证②在装配那一层:
 *      `packages/backend/__tests__/resource-dir.test.ts`);
 *   ⑥ 没有外壳宿主时 `reveal` 在 **plan** 期就结构化降级(不是等到 apply);
 *   ⑦ 守卫两条:本机可信放行 / 不可信拒,而名单外的 scheme 它不管;
 *   ⑧ **写根之外、读根之内的目录列得出**(2026-09-10 的读根那一格):真装配里
 *      那批是接入目录 / 笔记根 / 下载目录 —— 用户亲手接入的目录一直**能改**,
 *      却因为判的是写根而列不出来。这一条同时钉住 `contains` 没有跟着放宽。
 */

import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PlanContext, RunContext, SandboxPolicy } from '@onething/core/toolkit'
import type { ResourceReadContext } from '@onething/core/resource'
import { isCorePathContained, resolveCoreToolPath } from '@onething/runtime/tools/sandbox'
import { classifySensitiveFile } from '@onething/runtime/tools/sensitive-files'
import { configureShellHost, resetShellHost } from '@onething/runtime/shell/host-ports'
import { DirOutsideSandboxError, DirResourceProvider, DirShellUnavailableError } from '../dir-provider.js'
import { createLocalOnlyReadGuard } from '../read-guard.js'

let root: string

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-dir-resource-')))
  fs.mkdirSync(path.join(root, 'project', 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'project', 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(root, 'project', 'readme.md'), '# hi\n')
  fs.writeFileSync(path.join(root, 'project', '.env'), 'SECRET=1\n')
  // 写根之外的一棵树 —— 真装配里它是用户在设置里接入的那种目录。
  fs.mkdirSync(path.join(root, 'connected'), { recursive: true })
  fs.writeFileSync(path.join(root, 'connected', 'notes.md'), 'hello\n')
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  resetShellHost()
})

/**
 * 沙箱:**产品层那三只函数**,只把根换成这个临时目录。假的只有「根在哪」——
 * 判据要是也假的,这只测试就只在证明自己写的那几行 if。
 */
function sandboxAt(boundary: string, readRoots: readonly string[] = []): SandboxPolicy {
  const inside = (rootPath: string, target: string) => isCorePathContained(rootPath, target)
  return {
    root: () => boundary,
    resolve: target => resolveCoreToolPath(target, { workingDirectory: boundary }),
    // 写根:单根,一个字没动。
    contains: target => inside(boundary, target),
    // 读根:写根 ∪ 额外读根 —— 与产品层 `getCoreReadSandboxRoots` 的并法同形。
    readable: target => inside(boundary, target) || readRoots.some(rootPath => inside(rootPath, target)),
    isSensitive: target => classifySensitiveFile(target).sensitive,
  }
}

function readContext(sandbox?: SandboxPolicy): ResourceReadContext {
  return {
    principal: { kind: 'user', userId: 'local' },
    sessionId: 'test-session',
    signal: new AbortController().signal,
    ...(sandbox ? { sandbox } : {}),
    now: () => 1_700_000_000_000,
  }
}

/** plan 只读 `ctx.sandbox`;别的格子给它一个够用的壳,而不是造一台真 runner。 */
function planContext(sandbox?: SandboxPolicy): PlanContext {
  return {
    invocation: { callId: 'c1', toolId: 'dir', input: {}, sessionId: 'test-session', principal: { kind: 'user', userId: 'local' } },
    abort: { signal: new AbortController().signal },
    principal: { kind: 'user', userId: 'local' },
    ...(sandbox ? { sandbox } : {}),
    now: () => 1_700_000_000_000,
  } as unknown as PlanContext
}

interface DirEntryView {
  name: string
  path: string
  kind: string
  size?: number
  mtimeMs?: number
}

describe('dir provider(K3-c)', () => {
  const provider = new DirResourceProvider()

  it('① list 交出自述那个形状,目录在前,node_modules 不在里面', async () => {
    const target = path.join(root, 'project')
    const value = await provider.read('list', { scheme: 'dir', path: target }, {}, readContext(sandboxAt(root)))
    const entries = (value as { entries: DirEntryView[] }).entries

    expect(entries.map(entry => entry.name)).toEqual(['src', '.env', 'readme.md'])
    expect(entries[0]).toMatchObject({ name: 'src', kind: 'dir', path: path.join(target, 'src') })
    const readme = entries.find(entry => entry.name === 'readme.md')
    expect(readme?.kind).toBe('file')
    expect(readme?.size).toBe(5)
    expect(typeof readme?.mtimeMs).toBe('number')
  })

  it('② stat 一个文件:kind file + 绝对路径', async () => {
    const target = path.join(root, 'project', 'readme.md')
    const value = await provider.read('stat', { scheme: 'dir', path: target }, {}, readContext(sandboxAt(root)))
    expect(value).toMatchObject({ path: target, kind: 'file', size: 5 })
  })

  it('③ 越界的路径拒(反证①:拆掉 provider 的 readable 判,这一条红)', async () => {
    const outside = path.join(root, 'project')
    // 沙箱根收到 `project/src`,于是它的父目录就在界外了。
    const sandbox = sandboxAt(path.join(root, 'project', 'src'))
    await expect(provider.read('list', { scheme: 'dir', path: outside }, {}, readContext(sandbox)))
      .rejects.toThrowError(DirOutsideSandboxError)
    await expect(provider.read('list', { scheme: 'dir', path: outside }, {}, readContext(sandbox)))
      .rejects.toMatchObject({ reason: 'outside' })
  })

  it('④ 敏感路径拒,即便它在界内', async () => {
    const secret = path.join(root, 'project', '.env')
    await expect(provider.read('stat', { scheme: 'dir', path: secret }, {}, readContext(sandboxAt(root))))
      .rejects.toMatchObject({ name: 'DirOutsideSandboxError', reason: 'sensitive' })
  })

  it('⑤ 没有沙箱一律拒 —— 缺席不是放行', async () => {
    await expect(provider.read('list', { scheme: 'dir', path: path.join(root, 'project') }, {}, readContext()))
      .rejects.toMatchObject({ name: 'DirOutsideSandboxError', reason: 'no-sandbox' })
  })

  it('⑥ reveal:没有外壳宿主时 plan 期就降级,有宿主时 apply 真的调它', async () => {
    const target = path.join(root, 'project')
    const ref = { scheme: 'dir', path: target }

    await expect(provider.plan('reveal', ref, {}, planContext(sandboxAt(root))))
      .rejects.toThrowError(DirShellUnavailableError)

    const revealed: string[] = []
    configureShellHost({ revealPath: targetPath => { revealed.push(targetPath) } })

    const intent = await provider.plan('reveal', ref, {}, planContext(sandboxAt(root)))
    // 效果表里一格都没有:定位不改这台机器上的任何东西。
    expect(intent.effects).toEqual([])
    expect(intent.payload).toEqual({ op: 'reveal', path: target })

    const result = await provider.apply('reveal', intent, {} as RunContext)
    expect(revealed).toEqual([target])
    expect(result.content[0]).toMatchObject({ type: 'text' })

    // 越界的 reveal 仍然是越界文案,不是「这台宿主没有外壳能力」(先夹后降级)。
    await expect(provider.plan('reveal', ref, {}, planContext(sandboxAt(path.join(root, 'project', 'src')))))
      .rejects.toThrowError(DirOutsideSandboxError)
  })

  it('⑧ 写根之外、读根之内的目录列得出,而写根本身没有跟着放宽', async () => {
    const connected = path.join(root, 'connected')
    // 写根收到 `project/src`;`connected` 只在读根那张表里。
    const sandbox = sandboxAt(path.join(root, 'project', 'src'), [connected])

    // 前提:这个路径**不在写根里** —— 否则这一条证不到读根那一格。
    expect(sandbox.contains(path.join(connected, 'notes.md'))).toBe(false)
    expect(sandbox.readable(path.join(connected, 'notes.md'))).toBe(true)

    const value = await provider.read('list', { scheme: 'dir', path: connected }, {}, readContext(sandbox))
    expect((value as { entries: DirEntryView[] }).entries.map(entry => entry.name)).toEqual(['notes.md'])

    // 定位同一把尺子:列得出的目录在访达里指得出来。
    configureShellHost({ revealPath: () => {} })
    const intent = await provider.plan('reveal', { scheme: 'dir', path: connected }, {}, planContext(sandbox))
    expect(intent.payload).toEqual({ op: 'reveal', path: connected })
  })
})

describe('本机限定的读守卫(K3-c)', () => {
  const ref = { scheme: 'dir', path: '/tmp' }
  const principal = { kind: 'user', userId: 'local' } as const

  it('本机可信 → 放行;不可信 → 拒,而且说得出这是过渡', async () => {
    const trusted = createLocalOnlyReadGuard({ schemes: ['dir'], isTrusted: () => true })
    expect(await trusted.decide(ref, 'list', principal)).toEqual({ kind: 'allow' })

    const untrusted = createLocalOnlyReadGuard({ schemes: ['dir'], isTrusted: () => false })
    const verdict = await untrusted.decide(ref, 'list', principal)
    expect(verdict.kind).toBe('deny')
    expect(verdict.kind === 'deny' && verdict.reason).toContain('local-only')
  })

  it('名单外的 scheme 它不管 —— 守卫自己不认识任何一个命名空间', async () => {
    const guard = createLocalOnlyReadGuard({ schemes: ['dir'], isTrusted: () => false })
    expect(await guard.decide({ scheme: 'session', path: 'abc' }, 'get', principal)).toEqual({ kind: 'allow' })
  })
})
