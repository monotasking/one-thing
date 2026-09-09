/**
 * R2a —— 装配的冒烟:三档目录装得起来,`createAppToolRunner` 造出来的 runner
 * 把六只工具各跑一遍正常路径。
 *
 * 这里刻意**注入**授权者与 job 端口(真权限核会去问人;真后台表会 spawn 进程),
 * 但目录、契约、观察者、spill、会话快照走的都是成品那一份 —— 冒烟要证明的是
 * "这堆零件装得起来并且真能跑完一次调用",不是再测一遍每只工具。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installStoreSessionLayerForTest } from '../../../session/testing/store-layer.js'
import { Decision } from '@onething/core/toolkit'
import type { Authorizer, Invocation } from '@onething/core/toolkit'
import type { BashOperations } from '@onething/runtime/tools/bash-executor'
import {
  bashAdapters,
  createCatalogForTier,
  createDesktopCatalog,
  createHeadlessCatalog,
  createReadonlyCatalog,
  mutatingFileAdapters,
  readAdapters,
  variableAdapters,
} from '../catalog.js'
import { IpcProjector } from '@onething/runtime/toolkit/ipc-observer.wiring'
import { AuditProjector, type ToolAuditRecord } from '@onething/runtime/toolkit/audit-observer'
import { createAppToolRunner } from '../runner.js'

const dirs: string[] = []
let sessionFixture: Awaited<ReturnType<typeof installStoreSessionLayerForTest>>

beforeEach(async () => {
  sessionFixture = await installStoreSessionLayerForTest()
})

afterEach(async () => {
  await sessionFixture.dispose()
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-toolkit-runner-'))
  dirs.push(await fs.realpath(dir))
  return dirs[dirs.length - 1]
}

const allowAll: Authorizer = { async decide() { return Decision.allow() } }

function invocationFor(toolId: string, input: unknown, dir: string): Invocation {
  return {
    callId: `call-${toolId}`,
    toolId,
    input,
    sessionId: 'smoke-session',
    messageId: 'smoke-message',
    principal: { kind: 'user', userId: 'local' },
    cwd: dir,
    workspaceRoot: dir,
    workingDirectoryRoots: [dir],
  }
}

describe('三档目录', () => {
  // K3-b:full 档少一只 `radio`(音乐退成 `music` 这个资源 scheme,它的工具由
  // 注册表对账进目录,不是这一档手写注册的)。
  it('桌面 / headless / readonly 各装得起来(R3a 二十只 + S6 的 search − K3-b 的 radio)', () => {
    expect(createDesktopCatalog().all().map(tool => tool.spec.id).sort())
      .toEqual([
        'ask_user', 'bash', 'board', 'edit', 'goal', 'history', 'notebook', 'practice',
        'read', 'search', 'send_message', 'task', 'time', 'variable', 'web_open',
        'web_search', 'write',
      ])
    expect(createHeadlessCatalog().all().map(tool => tool.spec.id).sort())
      .toEqual([
        'bash', 'board', 'edit', 'history', 'read', 'search', 'send_message', 'time',
        'variable', 'web_open', 'web_search', 'write',
      ])
    // 降级档:对本机零副作用。没有 bash / write / edit,也没有能重指工作目录的 variable。
    expect(createReadonlyCatalog().all().map(tool => tool.spec.id).sort())
      .toEqual(['read', 'search', 'time', 'web_open', 'web_search'])
  })

  it('createCatalogForTier 三个档位都对得上,未知档位退回 headless', () => {
    expect(createCatalogForTier('full').size).toBe(17)
    expect(createCatalogForTier('headless').size).toBe(12)
    expect(createCatalogForTier('readonly').size).toBe(5)
  })

  it('成品适配器造得出来(不调它们就没读过 store —— 这几个是 lazy 的闭包)', () => {
    expect(typeof readAdapters().getDefaultReadRoots).toBe('function')
    expect(typeof mutatingFileAdapters().getFileMutationsDir).toBe('function')
    expect(typeof bashAdapters().createOperations).toBe('function')
    expect(typeof variableAdapters().getRegistry).toBe('function')
  })
})

describe('createAppToolRunner 冒烟:六只工具各跑一次正常路径', () => {
  it('read / write / edit / time / variable / bash 全部 ok,并各留下一条审计', async () => {
    const dir = await tempDir()
    const audit: ToolAuditRecord[] = []
    const projector = new IpcProjector()

    const ops: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.from('hello\n'))
        return { exitCode: 0 }
      },
    }

    const catalog = createDesktopCatalog({
      read: readAdapters(),
      mutatingFile: { getFileMutationsDir: () => path.join(dir, '.audit') },
      bash: { getToolOutputsDir: () => dir, createOperations: () => ops },
      variable: {
        getRegistry: () => ({
          list: () => [{ name: 'topic', value: 'toolkit', scope: 'session' as const }],
          set: (_ctx, input) => ({ name: input.name, value: input.value }),
          append: (_ctx, input) => ({ name: input.name, value: input.value }),
          remove: (_ctx, input) => ({ name: input.name, value: input.value }),
          delete: () => {},
        }),
      },
    })

    const runner = createAppToolRunner({
      observer: projector,
      audit: record => audit.push(record),
      authorizer: allowAll,
      // 会话快照:冒烟不起 store。
      session: invocation => ({ id: invocation.sessionId, workspaceRoot: dir }),
      // 溢出落盘落在临时目录,不碰用户的 store。
      spill: () => path.join(dir, 'spill.txt'),
    })

    const cases: Array<[string, unknown]> = [
      ['time', { action: 'now', timezone: 'UTC' }],
      ['variable', { action: 'list' }],
      ['write', { path: 'a.txt', content: 'hello\n' }],
      ['edit', { path: 'a.txt', edits: [{ oldText: 'hello', newText: 'world' }] }],
      ['read', { path: 'a.txt' }],
      ['bash', { command: 'echo hello' }],
    ]

    for (const [toolId, input] of cases) {
      const tool = catalog.get(toolId)
      expect(tool, toolId).toBeDefined()
      const outcome = await runner.run(tool!, invocationFor(toolId, input, dir))
      expect(outcome.kind, `${toolId}: ${JSON.stringify(outcome)}`).toBe('ok')
    }

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf-8')).toBe('world\n')
    expect(audit.map(record => [record.toolId, record.outcome]))
      .toEqual([
        ['time', 'ok'], ['variable', 'ok'], ['write', 'ok'],
        ['edit', 'ok'], ['read', 'ok'], ['bash', 'ok'],
      ])
    // 写与改文件报的是 file_* 效果,读报 read —— 审计索引读得出这次调用碰了什么。
    expect(audit.find(record => record.toolId === 'write')?.effects).toEqual(['file_write'])
    expect(audit.find(record => record.toolId === 'edit')?.effects).toEqual(['file_edit'])
    expect(audit.find(record => record.toolId === 'read')?.effects).toEqual(['read'])
  }, 20_000)
})

describe('AuditProjector 与观察者的合成', () => {
  it('审计不给时不合成第二个观察者(少一层转发)', async () => {
    const dir = await tempDir()
    const projector = new IpcProjector()
    const runner = createAppToolRunner({ observer: projector, authorizer: allowAll, session: () => undefined })
    const outcome = await runner.run(
      createDesktopCatalog().get('time')!,
      invocationFor('time', { action: 'now', timezone: 'UTC' }, dir),
    )
    expect(outcome.kind).toBe('ok')
    expect(projector.title).toBeDefined()
  })

  it('AuditProjector 可以独立组合进任何观察者链', () => {
    const records: ToolAuditRecord[] = []
    expect(new AuditProjector(record => records.push(record))).toBeInstanceOf(AuditProjector)
  })
})
