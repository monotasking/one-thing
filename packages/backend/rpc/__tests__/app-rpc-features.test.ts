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
  // P4c 第五批唯一的域:sessions(26 条,含四条契约表外的字面量通道)。
  ['rpc:sessions', 'sessions'],
  // P4c 第五批的第二个域:chat(六条聊天面;第七条「工具审批后恢复流」在
  // 2026-08-22 的 #21 里连同它的 invoke 通道整条删除)。
  ['rpc:chat', 'chat'],
  // P4c 第六批第一个域:acp(八条外部 agent 面;一条推送都没有,旧的手写 IPC
  // 工厂整只删掉,`@main/ipc/acp.ts` 只剩 initialize/shutdown 两件生命周期)。
  ['rpc:acp', 'acp'],
  // P4c 第六批第二个域:mcp(十六条;本批唯一带 context 分叉的域 —— 私密字段脱敏 /
  // 合并回真值 / readConfigFile 在 http 上不读本机文件 / stdio 探测默认关闭)。
  ['rpc:mcp', 'mcp'],
  // P4c 第七批第一个域:themes(五条;零推送,插件主题覆盖的合成从 `@main` 搬进
  // 域处理者,`openFolder` 走 configureShellHost 端口)。
  ['rpc:themes', 'themes'],
  // P4c 第七批第二个域:oauth(六条数据面;两条令牌推送留在
  // `configureOAuthEventBroadcaster` 注入端口上,不在 router 的白名单里)。
  ['rpc:oauth', 'oauth'],
  // P4c 第八批第一个域:gateway(八条;零推送,八件事全走
  // `configureGatewayHost` 注入端口 —— server / CLI 未注入即结构化降级)。
  ['rpc:gateway', 'gateway'],
  // P4c 第八批第二个域:files(十四条;全仓第一个**逐方法带 http 夹紧**的域,
  // `FILE_WATCH_EVENT` 那条推送留在原地,登记簿在 wiring/files/workspace-watch)。
  ['rpc:files', 'files'],
  // P4c 第九批:tools(七条;继 files 之后第二个逐方法带 http 分叉的域,零推送)、
  // interaction(两条;零推送,channel 由宿主盖章)、music(十四条;四条推送留在
  // `broadcastVoiceHostMessage` 端口上)。
  ['rpc:tools', 'tools'],
  ['rpc:interaction', 'interaction'],
  ['rpc:music', 'music'],
  // P4c 第十批:evals(十四条,`app.isPackaged` 摘成 configureEvalsHost 端口)、
  // evalsWorkbench(十一条)。三条进度推送走同一个注入端口,不在域上。
  ['rpc:evals', 'evals'],
  ['rpc:evals-workbench', 'evalsWorkbench'],
  // P4c 第十一批:两个「无工厂的漏网 handler」——
  // settings 四条(两条 C 留宿主、一条推送走注入端口)与 voice 十一条
  // (两条推送本来就是 `configureVoiceHost` 端口一行没动;`VOICE_AUDIO_CHUNK`
  // 那条单向 PCM 上行按拍板 #10 留在手写通道上)。
  ['rpc:settings', 'settings'],
  ['rpc:voice', 'voice'],
  // P4 终态批 D2:terminal(七条请求面;两条推送留在 configureTerminalBroadcaster
  // 端口上,七条在 http 上一律结构化拒绝 —— 能力位按用户拍板保持默认关)。
  ['rpc:terminal', 'terminal'],
  // P4 终态批 C2:plugins(十九条 invoke;两条推送留在原地 —— NOTIFICATION 是
  // 总线全局事件、REQUEST_PROGRESS 走 configurePluginRequestProgressBroadcaster
  // 端口。http 上六条读/开关面走 server 那本只读镜像目录,写面按管理器在不在场)。
  ['rpc:plugins', 'plugins'],
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
