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
 *
 * K3-c' 的写面又加六句:
 *   ⑨ `createDirectory` 报一格 `file_write`、真把目录建出来、`created` 发在**父目录**
 *      的地址上;而且**不按主体分档** —— 换成 agent 主体,那一格效果逐字相同;
 *   ⑩ `rename` **按参数分档**:空地上一格,盖在已经存在的东西上两格
 *      (反证①:把那一支拆成恒 `file_write`,这一条红);
 *   ⑪ `delete` 删得掉空目录并发 `deleted`,非空目录被底下那层拒(不递归);
 *   ⑫ 参数形状:`name` 不许是路径,`to` 必须是绝对路径;
 *   ⑬ 三条写面都判**写根**,越界 / 敏感照拒;
 *   ⑭ **读根之内、写根之外:列得出,但写不进**(反证②:把写面判据改问 `readable`,
 *      这一条红)—— 用户接入一个目录是让助手看见它,不是把它交出去随便改。
 */

import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PlanContext, RunContext, SandboxPolicy } from '@onething/core/toolkit'
import { ResourceEventHub } from '@onething/core/resource'
import type { ResourceEvent, ResourceReadContext } from '@onething/core/resource'
import { isCorePathContained, resolveCoreToolPath } from '@onething/runtime/tools/sandbox'
import { classifySensitiveFile } from '@onething/runtime/tools/sensitive-files'
import { configureShellHost, resetShellHost } from '@onething/runtime/shell/host-ports'
import {
  DirOperationFailedError,
  DirOutsideSandboxError,
  DirResourceProvider,
  DirShellUnavailableError,
} from '../dir-provider.js'
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

/** plan 只读 `ctx.sandbox`(与 `ctx.invocation.sessionId`);别的格子给它一个够用的壳。 */
function planContext(sandbox?: SandboxPolicy, principal: unknown = { kind: 'user', userId: 'local' }): PlanContext {
  return {
    invocation: { callId: 'c1', toolId: 'dir', input: {}, sessionId: 'test-session', principal },
    abort: { signal: new AbortController().signal },
    principal,
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

  /**
   * 写面(K3-c')。每个用例自己起一棵新的工作树 —— 它们真的在动 fs,共用一棵会让
   * 「上一个用例删干净了没有」变成这一个用例的隐含前提。
   */
  const workAt = (name: string): string => {
    const dir = path.join(root, 'work', name)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 挂一条真的事件总线,收下这一段里发生的每一件事。 */
  const listen = (): ResourceEvent[] => {
    const hub = new ResourceEventHub()
    const seen: ResourceEvent[] = []
    provider.attach(hub)
    hub.watch('dir:', fact => seen.push(fact))
    return seen
  }

  it('⑨ createDirectory:一格 file_write、真建出来、created 发在父目录上,而且不按主体分档', async () => {
    const parent = workAt('create')
    const ref = { scheme: 'dir', path: parent }
    const sandbox = sandboxAt(root)
    const target = path.join(parent, 'notes')

    const intent = await provider.plan('createDirectory', ref, { name: 'notes' }, planContext(sandbox))
    expect(intent.effects.map(effect => effect.kind)).toEqual(['file_write'])
    expect(intent.effects[0]?.resources).toEqual([`dir:${parent}`])
    expect(intent.payload).toEqual({ op: 'createDirectory', path: target, parent })

    // **不按主体分档**:换成 agent 主体,那一格效果逐字相同。文件写面对界面上那个
    // 人也照旧问(与 `write` / `edit` 工具同一口径)—— 会话那一族的 `planByPrincipal`
    // 是关于「这个人自己的会话数据」的裁定,搬不到文件上。
    const asAgent = await provider.plan(
      'createDirectory',
      ref,
      { name: 'notes' },
      planContext(sandbox, { kind: 'agent', agentId: 'a1' }),
    )
    expect(asAgent.effects.map(effect => effect.kind)).toEqual(['file_write'])

    const seen = listen()
    await provider.apply('createDirectory', intent, {} as RunContext)
    expect(fs.statSync(target).isDirectory()).toBe(true)
    expect(seen).toEqual([{ ref: `dir:${parent}`, event: 'created', payload: { path: target } }])

    // 再来一次:`mkdir` 不覆盖,已经在了就是失败,不是一次静默的成功。
    await expect(provider.apply('createDirectory', intent, {} as RunContext))
      .rejects.toThrowError(DirOperationFailedError)
  })

  it('⑩ rename 按参数分档:空地上一格,盖在已经存在的东西上两格(反证①)', async () => {
    const dir = workAt('rename')
    const from = path.join(dir, 'a.txt')
    const fresh = path.join(dir, 'b.txt')
    const taken = path.join(dir, 'taken.txt')
    fs.writeFileSync(from, 'a\n')
    fs.writeFileSync(taken, 'x\n')
    const ref = { scheme: 'dir', path: from }
    const sandbox = sandboxAt(root)

    const plain = await provider.plan('rename', ref, { to: fresh }, planContext(sandbox))
    expect(plain.effects.map(effect => effect.kind)).toEqual(['file_write'])
    expect(plain.preview?.title).toBe(`Rename ${from} to ${fresh}`)

    const clobber = await provider.plan('rename', ref, { to: taken }, planContext(sandbox))
    expect(clobber.effects.map(effect => effect.kind)).toEqual(['file_write', 'file_destructive_edit'])
    expect(clobber.preview?.title).toContain('replacing what is there')

    const seen = listen()
    await provider.apply('rename', plain, {} as RunContext)
    expect(fs.existsSync(from)).toBe(false)
    expect(fs.readFileSync(fresh, 'utf-8')).toBe('a\n')
    expect(seen).toEqual([{ ref: `dir:${from}`, event: 'renamed', payload: { path: fresh } }])
  })

  it('⑪ delete:空目录删得掉并发 deleted;非空目录被拒 —— 不递归', async () => {
    const dir = workAt('delete')
    const empty = path.join(dir, 'empty')
    const full = path.join(dir, 'full')
    fs.mkdirSync(empty)
    fs.mkdirSync(full)
    fs.writeFileSync(path.join(full, 'x.txt'), 'x\n')
    const sandbox = sandboxAt(root)

    const seen = listen()

    const removeEmpty = await provider.plan('delete', { scheme: 'dir', path: empty }, {}, planContext(sandbox))
    expect(removeEmpty.effects.map(effect => effect.kind)).toEqual(['file_destructive_edit'])
    await provider.apply('delete', removeEmpty, {} as RunContext)
    expect(fs.existsSync(empty)).toBe(false)
    expect(seen).toEqual([{ ref: `dir:${empty}`, event: 'deleted', payload: { path: empty } }])

    // 非空目录:底下那层答 `ENOTEMPTY`,而那棵树一根头发都没少。
    const removeFull = await provider.plan('delete', { scheme: 'dir', path: full }, {}, planContext(sandbox))
    await expect(provider.apply('delete', removeFull, {} as RunContext))
      .rejects.toThrowError(DirOperationFailedError)
    expect(fs.existsSync(path.join(full, 'x.txt'))).toBe(true)
    // 那一次失败没有发出「删掉了」这个事实。
    expect(seen).toHaveLength(1)

    // 单个文件删得掉(`rm`,不是 `rmdir`)。
    const file = path.join(full, 'x.txt')
    const removeFile = await provider.plan('delete', { scheme: 'dir', path: file }, {}, planContext(sandbox))
    await provider.apply('delete', removeFile, {} as RunContext)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('⑫ 参数形状:name 不许是路径,to 必须是绝对路径', async () => {
    const parent = workAt('params')
    const sandbox = sandboxAt(root)
    const ref = { scheme: 'dir', path: parent }

    for (const name of ['', '..', 'a/b', 'a\\b']) {
      await expect(provider.plan('createDirectory', ref, { name }, planContext(sandbox)))
        .rejects.toThrowError(TypeError)
    }

    const file = path.join(parent, 'a.txt')
    fs.writeFileSync(file, 'a\n')
    // 相对路径不许 —— 「相对于父目录」与「相对于工作目录」两种解释都成立,而一个
    // 悄悄搬去别处的 rename 不会有任何东西红。
    await expect(provider.plan('rename', { scheme: 'dir', path: file }, { to: 'b.txt' }, planContext(sandbox)))
      .rejects.toThrowError(TypeError)
  })

  it('⑬ 写面判写根:越界拒、敏感拒、没有沙箱拒', async () => {
    const dir = workAt('bounds')
    const outsideSandbox = sandboxAt(path.join(dir, 'inner'))
    fs.mkdirSync(path.join(dir, 'inner'))

    // 沙箱根收到 `inner`,于是它的父目录在界外。
    await expect(provider.plan('delete', { scheme: 'dir', path: dir }, {}, planContext(outsideSandbox)))
      .rejects.toMatchObject({ name: 'DirOutsideSandboxError', reason: 'outside' })

    const sandbox = sandboxAt(root)
    await expect(provider.plan(
      'createDirectory',
      { scheme: 'dir', path: path.join(root, 'project') },
      { name: '.env' },
      planContext(sandbox),
    )).rejects.toMatchObject({ name: 'DirOutsideSandboxError', reason: 'sensitive' })

    await expect(provider.plan('delete', { scheme: 'dir', path: dir }, {}, planContext()))
      .rejects.toMatchObject({ name: 'DirOutsideSandboxError', reason: 'no-sandbox' })
  })

  it('⑭ 读根之内、写根之外:列得出,但写不进(反证②)', async () => {
    const connected = path.join(root, 'connected')
    // 写根收到 `project/src`;`connected` 只在读根那张表里 —— 与⑧同一台沙箱。
    const sandbox = sandboxAt(path.join(root, 'project', 'src'), [connected])
    const ctx = planContext(sandbox)

    // 前提:它读得到(⑧ 证过),所以下面三条拒的不是「看不见」。
    expect(sandbox.readable(connected)).toBe(true)
    expect(sandbox.contains(connected)).toBe(false)

    await expect(provider.plan('createDirectory', { scheme: 'dir', path: connected }, { name: 'x' }, ctx))
      .rejects.toMatchObject({ name: 'DirOutsideSandboxError', reason: 'outside' })
    await expect(provider.plan('delete', { scheme: 'dir', path: path.join(connected, 'notes.md') }, {}, ctx))
      .rejects.toMatchObject({ name: 'DirOutsideSandboxError', reason: 'outside' })
    await expect(provider.plan(
      'rename',
      { scheme: 'dir', path: path.join(connected, 'notes.md') },
      { to: path.join(connected, 'renamed.md') },
      ctx,
    )).rejects.toMatchObject({ name: 'DirOutsideSandboxError', reason: 'outside' })

    // 那个文件还在。
    expect(fs.existsSync(path.join(connected, 'notes.md'))).toBe(true)
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
