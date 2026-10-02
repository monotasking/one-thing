/**
 * ACP 文件桥(A3-b,方案 §3.5 / §11.3):agent 的读写走 onething 的沙箱与许可。
 * 授权者注入成桩(记下它被问了什么、答什么由用例定);根列表用空适配器 —— 根只有会话目录。
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Decision } from '@onething/backend/core/toolkit'
import type { Authorizer, Intent, Invocation } from '@onething/backend/core/toolkit'
import type { AcpClientRequestContext } from '@onething/backend/runtime/acp'
import type { ToolAuditRecord } from '@onething/backend/runtime/toolkit/audit-observer'

vi.mock('../../permission/message-anchor.js', () => ({
  resolvePermissionMessageAnchor: (_sessionId: string, preferred?: string) => preferred ?? '',
}))

const { createAcpFsBridge, ACP_FS_WRITE_TOOL_ID } = await import('../fs-bridge.js')

let root: string
let cwd: string
let outside: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'acp-fs-bridge-')))
  cwd = join(root, 'project')
  outside = join(root, 'elsewhere')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(outside, '.ssh'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function context(): AcpClientRequestContext {
  return { agentId: 'kimi', agentName: 'Kimi', localSessionId: 'session-1', messageId: 'msg-1', cwd }
}

function harness(answer: (intent: Intent) => Decision = () => Decision.allow()) {
  const asked: Array<{ intent: Intent; invocation: Invocation }> = []
  const audits: ToolAuditRecord[] = []
  const authorizer: Authorizer = {
    async decide(intent, invocation) {
      asked.push({ intent, invocation })
      return answer(intent)
    },
  }
  const bridge = createAcpFsBridge({
    authorizer: () => authorizer,
    readAdapters: () => ({}),
    writeAdapters: () => ({}),
    audit: record => audits.push(record),
    now: () => 42,
  })
  return { bridge, asked, audits }
}

const kinds = (intent: Intent) => intent.effects.map(effect => effect.kind)

describe('fs/read_text_file', () => {
  it('根内:只报一条静默的 read,按 line / limit 切片', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    const { bridge, asked } = harness()
    await expect(bridge.readTextFile(context(), { path: join(cwd, 'a.txt'), line: 2, limit: 2 }))
      .resolves.toEqual({ content: 'two\nthree' })
    expect(kinds(asked[0].intent)).toEqual(['read'])
    expect(asked[0].invocation).toMatchObject({ sessionId: 'session-1', messageId: 'msg-1', cwd })
    // 相对路径按会话目录解析。
    await expect(bridge.readTextFile(context(), { path: 'a.txt' })).resolves.toEqual({ content: 'one\ntwo\nthree\nfour\n' })
  })

  it('根外:先一条 external_directory;拒了答一句人话,不读', async () => {
    writeFileSync(join(outside, 'notes.txt'), 'secret-ish')
    const { bridge, asked } = harness(() => Decision.deny('The user rejected permission for this tool.'))
    await expect(bridge.readTextFile(context(), { path: join(outside, 'notes.txt') }))
      .rejects.toThrow(/onething denied reading .*notes\.txt/)
    expect(kinds(asked[0].intent)).toEqual(['external_directory', 'read'])
  })

  it('敏感文件是 sensitive_file_read(另一种效果,不是 read 的参数)', async () => {
    writeFileSync(join(outside, '.ssh', 'id_rsa'), 'NOT A KEY')
    const { bridge, asked } = harness(() => Decision.deny('no'))
    await expect(bridge.readTextFile(context(), { path: join(outside, '.ssh', 'id_rsa') })).rejects.toThrow(/denied/)
    expect(kinds(asked[0].intent)).toContain('sensitive_file_read')
  })

  it('准了但文件不在:带 ENOENT 往上抛(客户端答 resource_not_found)', async () => {
    const { bridge } = harness()
    await expect(bridge.readTextFile(context(), { path: join(cwd, 'missing.txt') })).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('fs/write_text_file', () => {
  it('新建:file_write,卡上带 diff;准了才写,写完落一条审计', async () => {
    const { bridge, asked, audits } = harness()
    await bridge.writeTextFile(context(), { path: join(cwd, 'sub', 'new.txt'), content: 'hello\n' })
    expect(kinds(asked[0].intent)).toEqual(['file_write'])
    expect(asked[0].intent.preview?.diff).toContain('+hello')
    expect(asked[0].intent.preview?.additions).toBe(1)
    expect(readFileSync(join(cwd, 'sub', 'new.txt'), 'utf8')).toBe('hello\n')
    expect(audits).toEqual([expect.objectContaining({
      toolId: ACP_FS_WRITE_TOOL_ID,
      sessionId: 'session-1',
      messageId: 'msg-1',
      effects: ['file_write'],
      decision: 'allow',
      outcome: 'ok',
      at: 42,
      principal: { kind: 'system', component: 'acp:kimi' },
    })])
  })

  it('改已有文件是 file_edit;根外的写带 external 位', async () => {
    writeFileSync(join(cwd, 'b.txt'), 'old\n')
    const { bridge, asked } = harness()
    await bridge.writeTextFile(context(), { path: join(cwd, 'b.txt'), content: 'new\n' })
    expect(kinds(asked[0].intent)).toEqual(['file_edit'])
    expect(asked[0].intent.effects[0].external).toBe(false)

    await bridge.writeTextFile(context(), { path: join(outside, 'c.txt'), content: 'x' })
    expect(asked[1].intent.effects[0]).toMatchObject({ kind: 'file_write', external: true })
  })

  it('拒了:不写、不审计,答 agent 一句人话', async () => {
    const { bridge, audits } = harness(() => Decision.deny('The user rejected permission for this tool.'))
    await expect(bridge.writeTextFile(context(), { path: join(cwd, 'no.txt'), content: 'x' }))
      .rejects.toThrow(/onething denied writing/)
    expect(existsSync(join(cwd, 'no.txt'))).toBe(false)
    expect(audits).toEqual([])
  })
})
