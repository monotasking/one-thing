/**
 * 二次装配门（内核收缩 K0 的验收门，
 * docs/design/kernel-shrink-builtin-plugins-2026-08.md §2）。
 *
 * `createOnethingBackend` 的 shutdown→再装配路径（测试、宿主重启、server 的
 * test-helpers）会把内置 RPC 域册整个装第二遍。域注册表的重复守卫是**会抛
 * 的**，所以「装 → 拆 → 再装」这一趟必须干净 —— K0 把注册包成 feature 之后，
 * 同一条路上又多了一层挂载表的重复守卫，它一样得跟着解绕。
 *
 * 这里不 mock 任何东西：被测对象正是真实域册的形状与它的可逆性。注册本身是
 * 纯记账（闭包进 Map），handler 的依赖是逐调用惰性求值的，所以整册装配不碰
 * 任何 I/O。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { dumpFeatures, resetFeaturesForTests } from '../../features/index.js'
import { registerAppRpcDomains } from '../index.js'
import { hasRpcDomain, resetRpcRegistryForTests } from '../registry.js'

/**
 * 名册的现状快照。顺序 = 装配顺序（包装不重排）。
 *
 * C2 起这张表里有两种行：还没迁的 `rpc:<域>` 内联包装，和已经迁成真 feature
 * 的 `trajectory`（id 说的是**功能**不是域，注册的域仍然是 `sessionEvents`）。
 * 位置一格没动 —— 迁移不许重排装配顺序。
 *
 * C4 起有了第三种：`self-evolution` **一个域都不注册**（它注册的是三个会话
 * 工具），所以域清单与 feature 清单从这一期起不再是同一张表。
 */
const EXPECTED_DOMAIN_FEATURES = [
  // L3:渲染侧日志上行排在最前(零依赖,且它接的是别人出问题时的那条上行路)。
  ['rpc:logs', 'logs'],
  ['rpc:usage', 'usage'],
  ['rpc:prompts', 'prompts'],
  ['rpc:goal', 'goal'],
  ['rpc:todo-plan', 'todo-plan'],
  ['trajectory', 'sessionEvents'],
  ['rpc:channel-identity', 'channelIdentity'],
  ['rpc:agents', 'agents'],
  ['rpc:providers', 'providers'],
  ['rpc:models', 'models'],
  ['rpc:markdown', 'markdown'],
  ['rpc:permission-grants', 'permissionGrants'],
  // P0.3:第一个从手写 IPC 工厂整只搬过来的域。
  ['rpc:spaces', 'spaces'],
  // P4a 第二个域:practice。旧线是十条裸 `ipcMain.handle`,没有工厂也没有壳适配。
  ['rpc:practice', 'practice'],
  // P4a 第三个域:collab。十五条,一条推送都没有 —— 旧的手写 IPC 文件整只删掉。
  ['rpc:collab', 'collab'],
  // P4c 第一个域:scheduler。旧线是三处镜像(手写 IPC 工厂 + 主进程壳、web REST 桩、
  // server 自己那台 per-owner Scheduler),搬完之后只剩这一格。
  ['rpc:scheduler', 'scheduler'],
  // P4c 第二个域:variables。
  ['rpc:variables', 'variables'],
  // P4c 第三个域:app-state。
  ['rpc:app-state', 'appState'],
  // P4c 第四个域:permission(活询问)。
  ['rpc:permission', 'permission'],
  // P4c 第五个域:scratchpad(四条数据面;推送留在手写 IPC 上)。
  ['rpc:scratchpad', 'scratchpad'],
  // P4c 第六个域:project-dirs。
  ['rpc:project-dirs', 'projectDirs'],
  // P4c 第二批唯一的域:skills(十二条,openDirectory 走 configureShellHost 端口)。
  ['rpc:skills', 'skills'],
  // P4c 第三批唯一的域:media(十一条数据面;另存为 / 两个开窗留在手写通道上)。
  ['rpc:media', 'media'],
  // P4c 第四批唯一的域:session-command(会话命令总线的入口,只有 emit 一条)。
  ['rpc:session-command', 'session-command'],
] as const

/**
 * 名册全景 = 域 feature（顺序在前）+ 自进化（最后一格）。
 *
 * 自进化在这条路径上的注册项**是零**，而且这不是巧合也不是坏事：它的工具注册
 * 面有一道「已经有 bash 的宿主才给」的门，而本文件刻意不装工具注册表（被测
 * 对象是域册的可逆性，不是工具）。零注册的那一行仍然必须在场 —— 它证明
 * 「装/拆/再装」这一趟连这个 feature 一起走完了。
 */
const EXPECTED_FEATURES = [
  ...EXPECTED_DOMAIN_FEATURES.map(([id, domain]) => ({
    id,
    registrations: { rpcDomain: 1, disposer: 0 },
    rpcDomains: [domain as string],
  })),
  { id: 'self-evolution', registrations: { rpcDomain: 0, disposer: 0 }, rpcDomains: [] },
]

describe('builtin RPC domains as features', () => {
  beforeEach(() => {
    resetFeaturesForTests()
    resetRpcRegistryForTests()
  })

  it('mounts every builtin domain, in assembly order', { timeout: 60_000 }, async () => {
    const dispose = await registerAppRpcDomains()

    expect(dumpFeatures()).toEqual(EXPECTED_FEATURES)
    for (const [, domain] of EXPECTED_DOMAIN_FEATURES) expect(hasRpcDomain(domain)).toBe(true)

    await dispose()
  })

  it('a second assembly after shutdown trips neither duplicate guard', { timeout: 60_000 }, async () => {
    const first = await registerAppRpcDomains()
    await first()

    expect(dumpFeatures()).toEqual([])
    for (const [, domain] of EXPECTED_DOMAIN_FEATURES) expect(hasRpcDomain(domain)).toBe(false)

    const second = await registerAppRpcDomains()

    expect(dumpFeatures()).toHaveLength(EXPECTED_FEATURES.length)
    for (const [, domain] of EXPECTED_DOMAIN_FEATURES) expect(hasRpcDomain(domain)).toBe(true)

    await second()
  })

  it('the total disposer is idempotent (a double shutdown is not an error)', { timeout: 60_000 }, async () => {
    const dispose = await registerAppRpcDomains()

    await dispose()
    await expect(dispose()).resolves.toBeUndefined()
    expect(dumpFeatures()).toEqual([])
  })
})
