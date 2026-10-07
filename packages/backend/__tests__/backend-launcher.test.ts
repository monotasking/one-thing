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
  CLI_UNANSWERED_ASK_REJECT_MS,
  declareLaunchAttendance,
  launchHostPorts,
  prepareProcessEnv,
  readBackendLauncher,
  startLaunchServices,
} from '../backend-launcher.js'
import type { OnethingBackend } from '../backend.js'
import { isHostUnattended, unansweredAskDeadlineMs } from '../permission/permission-unattended.js'

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

  it('treats none as the default launcher', () => {
    const { launcher: _unset, ...unset } = backendLaunchProfile(undefined, {})
    for (const launcher of ['none'] as const) {
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

/*
 * 第④步批 3(决策 D7):`cli` 档 = 从前 CLI 守护进程(`HeadlessBackend`)那一份。三样它独有的东西成了这一档的参数:
 * `headless` 工具档、宣告无人值守、交互卡 60 秒没人答就拒。反证:把档案里 `unattendedHost` 改成 false,
 * 下面 `declareLaunchAttendance` 那一条红。
 */
describe('the cli launcher', () => {
  it('assembles what the CLI daemon assembled and writes owner backend + launcher cli', () => {
    const profile = backendLaunchProfile('cli', {})
    expect(profile.assembly).toEqual({ toolRegistry: 'headless', collab: true, sessionSkills: true, pets: false })
    expect(profile.discoveryOwner).toBe('backend')
    expect(profile.discoveryLauncher).toBe('cli')
    expect(profile.logging).toEqual({ fileBaseName: 'app', src: 'server', consoleEcho: false })
    expect(profile.acpUnanswered).toBe('reject')
    expect(typeof profile.mcpClientFactory).toBe('function')
    expect([profile.unattendedHost, profile.unansweredAskRejectMs]).toEqual([true, CLI_UNANSWERED_ASK_REJECT_MS])
    expect([profile.loginShellEnv, profile.speechOutput, profile.userSchedulerTasks, profile.music, profile.modelRegistryRefresh])
      .toEqual([false, false, false, false, false])
  })

  it('declares an unattended host with a 60s answer deadline, and takes both back', () => {
    expect([isHostUnattended(), unansweredAskDeadlineMs()]).toEqual([false, undefined])
    const release = declareLaunchAttendance(backendLaunchProfile('cli', {}))
    expect([isHostUnattended(), unansweredAskDeadlineMs()]).toEqual([true, 60_000])
    release()
    expect([isHostUnattended(), unansweredAskDeadlineMs()]).toEqual([false, undefined])
  })

  it('declares nothing on the desktop and default launchers (a window answers the cards)', () => {
    for (const launcher of ['desktop', undefined] as const) {
      const release = declareLaunchAttendance(backendLaunchProfile(launcher, {}))
      expect([isHostUnattended(), unansweredAskDeadlineMs()]).toEqual([false, undefined])
      release()
    }
    expect(backendLaunchProfile('desktop', {}).discoveryLauncher).toBe('desktop')
    expect(backendLaunchProfile(undefined, {}).discoveryLauncher).toBeUndefined()
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
