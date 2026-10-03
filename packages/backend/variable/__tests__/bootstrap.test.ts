import { describe, expect, it } from 'vitest'
import { registerStandardVariableProviders } from '../bootstrap.js'
import { VariableRegistry } from '../registry.js'

function makeRegistry(): VariableRegistry {
  const registry = new VariableRegistry()
  registerStandardVariableProviders(registry, {
    workdir: {
      read: () => '/nonexistent-workdir-for-test',
      readRoots: () => [],
      write: () => undefined,
      writeRoots: () => undefined,
      expandPath: (input) => input,
    },
    globalStore: {
      read: () => [],
      write: () => undefined,
    },
    sessionStore: {
      read: () => [],
      write: () => undefined,
    },
    backgroundJobs: { listJobs: () => [] },
  })
  return registry
}

describe('registerStandardVariableProviders', () => {
  it('registers the full canonical provider set without conflicts', async () => {
    const registry = makeRegistry()
    const names = (await registry.list({ sessionId: 's' })).map(v => v.name)
    // Dynamic providers that emit unconditionally must be present; providers
    // that emit conditionally (git_branch, background_jobs) are covered by
    // their own tests — here the point is that every host gets the same set.
    expect(names).toContain('workdir')
    expect(names).toContain('datetime')
    // P3:两个笔记目录变量退役,笔记库改由只读派生变量 `note_vaults` 表达
    // (它按 gateway 在不在装,与 goal / musicRadio 同款,所以不在这一条里)。
    expect(names).not.toContain('user_note_dir')
  })

  it('wires the agent self-state provider only when the host supplies its gateway', async () => {
    // 宿主没有协作子系统就不给 gateway,三个变量随之消失(与 goal/musicRadio 同款)。
    expect((await makeRegistry().list({ sessionId: 's' })).map(v => v.name))
      .not.toContain('my_rooms')

    const registry = new VariableRegistry()
    registerStandardVariableProviders(registry, {
      workdir: {
        read: () => '',
        readRoots: () => [],
        write: () => undefined,
        writeRoots: () => undefined,
        expandPath: (input) => input,
      },
      globalStore: { read: () => [], write: () => undefined },
      sessionStore: { read: () => [], write: () => undefined },
      backgroundJobs: { listJobs: () => [] },
      agentSelf: {
        read: () => ({ cards: [], rooms: [{ name: '官网改版组' }], dms: [] }),
      },
    })
    expect((await registry.list({ sessionId: 's' })).map(v => v.name)).toContain('my_rooms')
  })

  it('is the single assembly point — registering twice conflicts', () => {
    const registry = makeRegistry()
    expect(() =>
      registerStandardVariableProviders(registry, {
        workdir: {
          read: () => '',
          readRoots: () => [],
          write: () => undefined,
          writeRoots: () => undefined,
          expandPath: (input) => input,
        },
          globalStore: { read: () => [], write: () => undefined },
        sessionStore: { read: () => [], write: () => undefined },
      }),
    ).toThrow(/already registered/)
  })
})
