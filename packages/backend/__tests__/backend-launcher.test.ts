/**
 * 后端进程的档位(`backend-launcher.ts`,第④步批 2a)。
 *
 * 钉三件事:①读法只有一处、认不出的值不静默退回缺省档;②缺省档的每一格就是批 2a 之前写死在
 * `createRealServerBackend` 与进程入口里的值(「缺省档逐字不变」的那一半由 `server:build` 产物对照证,
 * 这一半由这里证);③装配之后起的几件按档位起、每一件都在起点 `own()`,缺省档一件不起。
 * 桌面档的装配开关与桌面进程内那份逐格相同,那条对比在 `apps/desktop-react/electron/__tests__/own-core-options.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import {
  backendLaunchProfile,
  launchHostPorts,
  prepareProcessEnv,
  readBackendLauncher,
  startLaunchServices,
} from '../backend-launcher.js'
import type { OnethingBackend } from '../backend.js'

describe('readBackendLauncher', () => {
  it('reads unset and empty as the default launcher', () => {
    expect(readBackendLauncher({})).toEqual({ ok: true, launcher: undefined })
    expect(readBackendLauncher({ ONETHING_BACKEND_LAUNCHER: '' })).toEqual({ ok: true, launcher: undefined })
  })

  it('accepts the three named launchers', () => {
    for (const launcher of ['desktop', 'cli', 'none'] as const) {
      expect(readBackendLauncher({ ONETHING_BACKEND_LAUNCHER: launcher })).toEqual({ ok: true, launcher })
    }
  })

  it('refuses an unknown value instead of falling back to the default launcher', () => {
    expect(readBackendLauncher({ ONETHING_BACKEND_LAUNCHER: 'Desktop' })).toEqual({ ok: false, value: 'Desktop' })
  })
})

describe('backendLaunchProfile', () => {
  it('keeps the default launcher exactly as server:start was before batch 2a', () => {
    const profile = backendLaunchProfile(undefined, {})
    expect(profile.assembly).toEqual({ toolRegistry: 'full', sessionSkills: true, pets: true })
    expect(profile.logging).toEqual({ fileBaseName: 'server', src: 'server', consoleEcho: 'pretty' })
    expect(profile.discoveryOwner).toBe('server')
    expect(profile.processTitle).toBeNull()
    expect(profile.acpUnanswered).toBe('reject')
    expect(profile.mcpClientFactory).toBeUndefined()
    expect([profile.loginShellEnv, profile.speechOutput, profile.userSchedulerTasks, profile.music, profile.modelRegistryRefresh])
      .toEqual([false, false, false, false, false])
  })

  it('still degrades the default launcher with ONETHING_SERVER_TOOLS=readonly', () => {
    expect(backendLaunchProfile(undefined, { ONETHING_SERVER_TOOLS: 'readonly' }).assembly.toolRegistry).toBe('readonly')
  })

  it('treats none and (until batch 3) cli as the default launcher', () => {
    const { launcher: _unset, ...unset } = backendLaunchProfile(undefined, {})
    for (const launcher of ['none', 'cli'] as const) {
      const { launcher: named, ...rest } = backendLaunchProfile(launcher, {})
      expect(named).toBe(launcher)
      expect(rest).toEqual(unset)
    }
  })

  it('turns on every desktop service, the backend owner and the quiet log on the desktop launcher', () => {
    const profile = backendLaunchProfile('desktop', {})
    expect(profile.discoveryOwner).toBe('backend')
    expect(profile.processTitle).toBe('onething-backend')
    expect(profile.logging).toEqual({ fileBaseName: 'app', src: 'server', consoleEcho: false })
    expect(profile.acpUnanswered).toBe('wait')
    expect(typeof profile.mcpClientFactory).toBe('function')
    expect([profile.loginShellEnv, profile.speechOutput, profile.userSchedulerTasks, profile.music, profile.modelRegistryRefresh])
      .toEqual([true, true, true, true, true])
  })
})

describe('launchHostPorts', () => {
  it('answers {} and no speech output on the default launcher, as before', () => {
    expect(launchHostPorts(backendLaunchProfile(undefined, {}), {})).toEqual({ storePath: {}, speechOutput: null })
  })

  it('reads the packaged resources directory from ONETHING_RESOURCES_PATH', () => {
    const ports = launchHostPorts(backendLaunchProfile(undefined, {}), { ONETHING_RESOURCES_PATH: '/Applications/onething.app/Contents/Resources' })
    expect(ports.storePath).toEqual({ isPackaged: true, resourcesPath: '/Applications/onething.app/Contents/Resources' })
  })

  it('hands the desktop launcher its own process speech output', () => {
    const ports = launchHostPorts(backendLaunchProfile('desktop', {}), {})
    expect(typeof ports.speechOutput?.play).toBe('function')
  })
})

describe('prepareProcessEnv', () => {
  it('does nothing on the default launcher', async () => {
    await expect(prepareProcessEnv(backendLaunchProfile(undefined, {}))).resolves.toBeUndefined()
  })
})

describe('startLaunchServices', () => {
  function fakeBackend() {
    const owned: string[] = []
    const disposers: Array<() => void> = []
    const calls: string[] = []
    const backend = {
      own(disposer: () => void, label: string) { owned.push(label); disposers.push(disposer) },
      music: { start() { calls.push('music.start') } },
      runTask(label: string) { calls.push(`runTask:${label}`); return Promise.resolve() },
    } as unknown as OnethingBackend
    // 真的跑一遍登记下来的拆除:定时任务那一只把模块里的「已初始化」放回去,不留给同一 worker 里的下一只测试。
    const dispose = () => { for (const disposer of disposers.reverse()) disposer() }
    return { backend, owned, calls, dispose }
  }

  it('starts nothing on the default launcher', () => {
    const { backend, owned, calls } = fakeBackend()
    expect(startLaunchServices(backend, backendLaunchProfile(undefined, {}))).toEqual([])
    expect(owned).toEqual([])
    expect(calls).toEqual([])
  })

  it('starts the three desktop services and owns each where it starts', () => {
    const { backend, owned, calls, dispose } = fakeBackend()
    try {
      expect(startLaunchServices(backend, backendLaunchProfile('desktop', {})))
        .toEqual(['userSchedulerTasks', 'music', 'modelRegistryRefresh'])
      expect(owned).toEqual(['userSchedulerTasks', 'modelRegistryRefresh'])
      expect(calls).toEqual(['music.start', 'runTask:backend:model-registry'])
    } finally {
      dispose()
    }
  })
})
