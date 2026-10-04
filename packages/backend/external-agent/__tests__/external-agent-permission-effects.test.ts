/**
 * **外部工具 → 本地同款 effect**(P0-4,`docs/audit/claude-code-sdk-audit-2026-08-11.md`)。
 *
 * 这一层的全部价值是「与本地那套分析是同一套」,所以断言逐条对着
 * `tools/builtin/{bash,read,write,edit}.ts` 的 analyze 写:同样的 kind、同样的
 * resources 粒度、同样的 external / sensitive 位。
 */
import { describe, expect, it } from 'vitest'
import { describeAcpToolPermission, describeExternalToolPermission } from '../external-agent-permission-effects.js'

const CWD = '/tmp/project'

describe('describeExternalToolPermission', () => {
  it('Bash 危险命令 → 命令级 bash effect,标题是命令原文', () => {
    const shape = describeExternalToolPermission({
      toolName: 'Bash',
      input: { command: 'rm -rf ./build', description: 'clean' },
      cwd: CWD,
    })
    expect(shape?.effects).toEqual([
      expect.objectContaining({
        kind: 'bash',
        resources: ['rm *'],
        barrier: true,
      }),
    ])
    expect(shape?.preview?.title).toBe('rm -rf ./build')
  })

  it('Bash hardDeny 命令带 hardDeny 位 —— 策略门据它当场拒,不弹卡', () => {
    const shape = describeExternalToolPermission({
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      cwd: CWD,
    })
    expect(shape?.effects[0]?.metadata).toMatchObject({ hardDeny: true })
  })

  it('白名单命令 → 空 effects(策略门直接放行,与本地 ls 同一件事)', () => {
    const shape = describeExternalToolPermission({
      toolName: 'Bash',
      input: { command: 'ls -la' },
      cwd: CWD,
    })
    expect(shape?.effects).toEqual([])
  })

  it('cd 到界外 → 与本地同款的 external_directory effect', () => {
    const shape = describeExternalToolPermission({
      toolName: 'Bash',
      input: { command: 'cd /etc && cat hosts' },
      cwd: CWD,
    })
    expect(shape?.effects).toContainEqual(
      expect.objectContaining({
        kind: 'external_directory',
        external: true,
        resources: ['/etc', '/etc/*'],
      }),
    )
  })

  it('Read 界内普通文件 → 只有 read effect(策略门不问)', () => {
    const shape = describeExternalToolPermission({
      toolName: 'Read',
      input: { file_path: `${CWD}/src/app.ts` },
      cwd: CWD,
    })
    expect(shape?.effects).toEqual([
      expect.objectContaining({ kind: 'read', resources: [`${CWD}/src/app.ts`] }),
    ])
  })

  it('Read 敏感文件 → sensitive_file_read + 越界目录两条', () => {
    const shape = describeExternalToolPermission({
      toolName: 'Read',
      input: { file_path: '/Users/someone/.ssh/id_rsa' },
      cwd: CWD,
    })
    expect(shape?.effects.map(effect => effect.kind))
      .toEqual(['external_directory', 'sensitive_file_read'])
    expect(shape?.effects[1]).toMatchObject({ sensitive: true, barrier: true })
  })

  it('Write 越界 → file_write + external 位(auto-accept 判据靠它)', () => {
    const shape = describeExternalToolPermission({
      toolName: 'Write',
      input: { file_path: '/tmp/elsewhere/notes.md', content: 'x' },
      cwd: CWD,
    })
    expect(shape?.effects).toEqual([
      expect.objectContaining({
        kind: 'file_write',
        resources: ['/tmp/elsewhere/*'],
        external: true,
      }),
    ])
  })

  it('Edit / MultiEdit / NotebookEdit 都落到 file_edit,资源粒度是所在目录', () => {
    for (const [toolName, input] of [
      ['Edit', { file_path: `${CWD}/a/x.ts`, old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: `${CWD}/a/x.ts`, edits: [] }],
      ['NotebookEdit', { notebook_path: `${CWD}/a/x.ipynb`, new_source: 'y' }],
    ] as const) {
      const shape = describeExternalToolPermission({ toolName, input, cwd: CWD })
      expect(shape?.effects[0]).toMatchObject({
        kind: 'file_edit',
        resources: [`${CWD}/a/*`],
        external: false,
      })
    }
  })

  it('认不出的工具名与认不出的 input 都返回 undefined —— 回落工具名粒度,不是放行', () => {
    expect(describeExternalToolPermission({
      toolName: 'Glob',
      input: { pattern: '**/*.ts' },
      cwd: CWD,
    })).toBeUndefined()
    // 形状不对(没有 command / file_path)也回落:这里不猜。
    expect(describeExternalToolPermission({ toolName: 'Bash', input: {}, cwd: CWD })).toBeUndefined()
    expect(describeExternalToolPermission({ toolName: 'Write', input: null, cwd: CWD })).toBeUndefined()
  })
})

/**
 * A3-a:ACP 的 `kind` + `rawInput` + `locations` → 同一套分析(方案 §11.3)。
 * 断言与上面 Claude 路那几条同形:同一条命令在两条路上长成同一条效果。
 */
describe('describeAcpToolPermission', () => {
  const AGENT = 'kimi'

  it('execute 带 rm -rf → 命令级 bash 效果,不是 agentId:execute', () => {
    const shape = describeAcpToolPermission({
      kind: 'execute', rawInput: { command: 'rm -rf ./build' }, cwd: CWD, agentId: AGENT,
    })
    expect(shape.effects).toEqual([
      expect.objectContaining({ kind: 'bash', resources: ['rm *'], barrier: true }),
    ])
    expect(shape.preview?.title).toBe('rm -rf ./build')
  })

  it('execute 的 command 是 [cmd, ...args] 时拼起来分析', () => {
    const shape = describeAcpToolPermission({
      kind: 'execute', rawInput: { command: ['rm', '-rf', './build'] }, cwd: CWD, agentId: AGENT,
    })
    expect(shape.effects).toEqual([expect.objectContaining({ kind: 'bash', resources: ['rm *'] })])
  })

  it('read ~/.ssh/id_rsa → sensitive_file_read(路径取 locations)', () => {
    const shape = describeAcpToolPermission({
      kind: 'read', locations: [{ path: '~/.ssh/id_rsa' }], rawInput: {}, cwd: CWD, agentId: AGENT,
    })
    expect(shape.effects).toContainEqual(expect.objectContaining({ kind: 'sensitive_file_read', sensitive: true }))
  })

  it('read 没有 locations 时退到 rawInput.path / file_path', () => {
    const shape = describeAcpToolPermission({
      kind: 'read', rawInput: { file_path: `${CWD}/src/a.ts` }, cwd: CWD, agentId: AGENT,
    })
    expect(shape.effects).toContainEqual(expect.objectContaining({ kind: 'read', resources: [`${CWD}/src/a.ts`] }))
  })

  it('edit → file_edit,路径取 locations[0],界内不带 external', () => {
    const shape = describeAcpToolPermission({
      kind: 'edit', locations: [{ path: `${CWD}/src/a.ts` }], rawInput: { path: '/elsewhere/b.ts' }, cwd: CWD, agentId: AGENT,
    })
    expect(shape.effects).toEqual([
      expect.objectContaining({ kind: 'file_edit', external: false, metadata: expect.objectContaining({ path: `${CWD}/src/a.ts` }) }),
    ])
  })

  it('delete → file_destructive_edit;move → 源头破坏 + 目的地写,两条', () => {
    const del = describeAcpToolPermission({
      kind: 'delete', locations: [{ path: `${CWD}/a.ts` }], cwd: CWD, agentId: AGENT,
    })
    expect(del.effects).toEqual([expect.objectContaining({ kind: 'file_destructive_edit' })])

    const move = describeAcpToolPermission({
      kind: 'move', locations: [{ path: `${CWD}/a.ts` }, { path: `${CWD}/b.ts` }], cwd: CWD, agentId: AGENT,
    })
    expect(move.effects.map(effect => effect.kind)).toEqual(['file_destructive_edit', 'file_write'])
  })

  it('认不出的 kind / 取不到字段 → 退回 external-agent(资源 agentId:kind),不是放行', () => {
    const unknown = describeAcpToolPermission({
      kind: 'fetch', name: 'Fetch url', rawInput: { url: 'https://x' }, cwd: CWD, agentId: AGENT,
    })
    expect(unknown.effects).toEqual([
      expect.objectContaining({
        kind: 'external-agent',
        resources: ['kimi:fetch'],
        barrier: true,
        metadata: expect.objectContaining({ agentId: AGENT, toolKind: 'fetch', toolTitle: 'Fetch url' }),
      }),
    ])

    const missing = describeAcpToolPermission({ kind: 'execute', rawInput: {}, cwd: CWD, agentId: AGENT })
    expect(missing.effects).toEqual([expect.objectContaining({ kind: 'external-agent', resources: ['kimi:execute'] })])

    const noKind = describeAcpToolPermission({ cwd: CWD, agentId: AGENT })
    expect(noKind.effects).toEqual([expect.objectContaining({ kind: 'external-agent', resources: ['kimi:tool'] })])
  })
})
