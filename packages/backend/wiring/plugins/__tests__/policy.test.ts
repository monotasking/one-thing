/**
 * R7 验收:两张策略表。
 *
 * 它们治的是同一个病 —— **判据撒在各个上报点上就必然漂移**。这条战役里同一个
 * 病出现过四次(熔断计数的粒度、transient 的两类、终止事件名单、白名单的补集),
 * 每次的修法都是同一句话:收进一张表,并让"漏登记"在编译期或测试里变红。
 *
 * 所以这里的断言分两层:
 *  - **行为层**:面板连败降级面板、promptContext 连败禁用插件;
 *  - **完备层**:代码里真实出现过的每一个 scope 都必须能归到某个家族,
 *    每个开放的注册表都必须在拆除语义表里有条目。第二层才是防漂移的那一半。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CorePluginHealthTracker,
  PLUGIN_DEFERRED_REGISTRIES,
  PLUGIN_DEFERRED_REGISTRY_IDS,
  PLUGIN_OPEN_REGISTRIES,
  PLUGIN_REGISTRY_POLICY,
  PLUGIN_SCOPE_FAMILIES,
  PLUGIN_SEVERITY_TABLE,
  classifyPluginScope,
  describePluginSurface,
  pluginLoadLabel,
  pluginScope,
  resolvePluginScopeSeverity,
} from '@onething/core/plugins'

const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))

/** 目录遍历,不再硬编码文件清单(上一版只看五个文件,npm-install 就那样漏了)。 */
function readSourceFiles(roots: string[]): string[] {
  const chunks: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (full.endsWith('.ts')) chunks.push(fs.readFileSync(full, 'utf-8'))
    }
  }
  for (const root of roots) walk(root)
  return chunks
}

/**
 * 抵达判决的出口名。
 *
 * 除了直接的 recordFailure/上报函数,还要认宿主转发口 `onRequestFailure` /
 * `onPluginFailure` —— core 不认识健康账本,请求通道与 api 层的失败都是经它们
 * 转出去的,漏掉就会把两条真活着的车道误判成死规则。
 */
const FAILURE_SINKS = [
  'reportFailure',
  'reportPluginRuntimeFailure',
  'recordFailure',
  'onRequestFailure',
  'onPluginFailure',
]

/**
 * 这个工厂的产出**有没有一条路径抵达 recordFailure**。
 *
 * 两种形态都要认:
 *  a) 直接内联进上报调用 —— `reportFailure(pluginScope.steer(), error)`;
 *  b) 先存进变量再上报 —— `const scope = pluginScope.event(t)` … `reportFailure(scope, …)`。
 * 逐文件判断(变量作用域只在文件内才说得通)。
 */
function reachesJudgement(factory: string, files: string[]): boolean {
  const call = new RegExp(`pluginScope\\.${factory}\\(`, 'g')
  for (const file of files) {
    for (const match of file.matchAll(call)) {
      const before = file.slice(Math.max(0, match.index - 200), match.index)
      // 可选链调用也算:`this.host.onRequestFailure?.(…)`。
      if (FAILURE_SINKS.some(sink => before.includes(`${sink}(`) || before.includes(`${sink}?.(`))) return true

      // 形态 b:抓住 `const <name> = pluginScope.X(`,再看该变量是否进过上报口。
      const assign = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before)
      if (!assign) continue
      const variable = assign[1]
      const passed = new RegExp(`(?:${FAILURE_SINKS.join('|')})\\??\\.?\\([^)]*\\b${variable}\\b`)
      if (passed.test(file)) return true
    }
  }
  return false
}

describe('R7 severity table — 罚则来自表,不在上报点上判', () => {
  it('degrades the panel and leaves the plugin alone after repeated UI failures', () => {
    const tripped: string[] = []
    const degraded: Array<{ pluginId: string; surface: string }> = []
    const tracker = new CorePluginHealthTracker({
      onTrip: pluginId => tripped.push(pluginId),
      onDegradeSurface: (pluginId, surface) => degraded.push({ pluginId, surface }),
    })

    // 面板动作连败 3 次。
    for (let i = 0; i < 3; i += 1) {
      tracker.recordFailure('notes', pluginScope.panelAction('inbox'), new Error('boom'))
    }

    // **插件没有被禁用** —— 它的工具/命令/提示词/定时任务照常。
    expect(tripped).toEqual([])
    expect(tracker.get('notes')?.status).not.toBe('disabled')
    // 只有那一个面板被标记。
    expect(degraded).toEqual([{ pluginId: 'notes', surface: 'panel:inbox' }])
    expect(tracker.isSurfaceDegraded('notes', 'panel:inbox')).toBe(true)
    // 同一个插件的另一个面板不受连坐。
    expect(tracker.isSurfaceDegraded('notes', 'panel:archive')).toBe(false)
  })

  it('still disables the whole plugin when a per-turn hook keeps failing', () => {
    const tripped: string[] = []
    const tracker = new CorePluginHealthTracker({ onTrip: pluginId => tripped.push(pluginId) })

    for (let i = 0; i < 3; i += 1) {
      tracker.recordFailure('notes', pluginScope.promptContext('notes'), new Error('hung'))
    }

    // 既有行为不变:每轮都跑的东西坏了会拖垮全应用,禁用是较小的伤害。
    expect(tripped).toEqual(['notes'])
    expect(tracker.get('notes')?.status).toBe('disabled')
  })

  it('brings a degraded surface back on the first success — the user pressed Retry', () => {
    const degraded: string[] = []
    const tracker = new CorePluginHealthTracker({ onDegradeSurface: (_id, surface) => degraded.push(surface) })

    for (let i = 0; i < 3; i += 1) tracker.recordFailure('notes', pluginScope.panelRender('inbox'), new Error('boom'))
    expect(tracker.isSurfaceDegraded('notes', 'panel:inbox')).toBe(true)

    tracker.recordSuccess('notes', pluginScope.panelRender('inbox'))
    expect(tracker.isSurfaceDegraded('notes', 'panel:inbox')).toBe(false)
    expect(tracker.get('notes')?.degradedSurfaces).toBeUndefined()
  })

  it('fires the degrade callback once, not on every subsequent failure', () => {
    const degraded: string[] = []
    const tracker = new CorePluginHealthTracker({ onDegradeSurface: (_id, surface) => degraded.push(surface) })
    for (let i = 0; i < 8; i += 1) tracker.recordFailure('notes', pluginScope.panelAction('inbox'), new Error('boom'))
    expect(degraded).toEqual(['panel:inbox'])
  })

  it('treats a registration violation as a code error — threshold 1, no retry budget', () => {
    const tripped: string[] = []
    const tracker = new CorePluginHealthTracker({ onTrip: pluginId => tripped.push(pluginId) })
    // 未声明的面板 id / 抢占保留命名空间不是运行期抖动,重试没有意义。
    tracker.recordFailure('notes', pluginScope.registration('WorkspacePanel'), new Error('undeclared panel'))
    expect(tripped).toEqual(['notes'])
  })

  it('degrades a connector without taking the plugin down with it', () => {
    const tripped: string[] = []
    const degraded: string[] = []
    const tracker = new CorePluginHealthTracker({
      onTrip: id => tripped.push(id),
      onDegradeSurface: (_id, surface) => degraded.push(surface),
    })
    for (let i = 0; i < 3; i += 1) tracker.recordFailure('wechat', pluginScope.connector('wechat-main'), new Error('socket closed'))
    // 一条渠道坏掉不该放大成插件故障。
    expect(tripped).toEqual([])
    expect(degraded).toEqual(['connector:wechat-main'])
  })

  it('half-opens a degraded surface after the cooldown, and throttles the probe', () => {
    let clock = 1_000_000
    const tracker = new CorePluginHealthTracker({ now: () => clock })
    for (let i = 0; i < 3; i += 1) tracker.recordFailure('wechat', pluginScope.connector('main'), new Error('down'))
    expect(tracker.isSurfaceDegraded('wechat', 'connector:main')).toBe(true)

    // 冷却期内不放行。
    expect(tracker.probeDegradedSurface('wechat', 'connector:main', 60_000)).toBe(false)

    // 满一个间隔放行一次;放行会把计时推到现在,所以探测本身有节流。
    clock += 60_000
    expect(tracker.probeDegradedSurface('wechat', 'connector:main', 60_000)).toBe(true)
    expect(tracker.probeDegradedSurface('wechat', 'connector:main', 60_000)).toBe(false)

    // 没降级的界面一律放行(闸只在降级时存在)。
    expect(tracker.probeDegradedSurface('wechat', 'connector:other', 60_000)).toBe(true)
  })

  it('maps panel scopes to a surface a user can recognise', () => {
    expect(describePluginSurface('request:panel:render:logs')).toBe('panel:logs')
    expect(describePluginSurface('request:panel:action:logs')).toBe('panel:logs')
    expect(describePluginSurface('request:search')).toBe('request:search')
  })

  it('classifies panel requests before plain requests — order matters', () => {
    expect(classifyPluginScope('request:panel:render:x')).toBe('ui-request')
    expect(classifyPluginScope('request:search')).toBe('plugin-request')
  })

  it('gives every declared family a rule and a stated rationale', () => {
    for (const family of PLUGIN_SCOPE_FAMILIES) {
      const rule = PLUGIN_SEVERITY_TABLE[family]
      expect(rule, family).toBeTruthy()
      expect(rule.threshold, family).toBeGreaterThan(0)
      // 理由是给下一个人看的:改罚则之前先读懂为什么是这个罚则。
      expect(rule.rationale.length, family).toBeGreaterThan(20)
    }
  })

  it('classifies the output of every scope factory — the factories are the vocabulary', () => {
    // **这才是完备性的执行点。** scope 是品牌类型,只能由工厂产出,所以"所有
    // 合法 scope"就等于"所有工厂的产出"。上一版靠正则反查五个硬编码文件,
    // 于是 npm-install 从缝里漏了过去,而 `literals.size > 5` 永远是绿的。
    const samples = [
      pluginScope.promptContext('notes'),
      pluginScope.beforeContextCompact('h'),
      pluginScope.afterAssistantResponse('h'),
      pluginScope.lifecycleHook('beforeContextCompact', 'h'),
      pluginScope.event('message:created'),
      pluginScope.eventEmit('ping'),
      pluginScope.request('search'),
      pluginScope.panelRender('logs'),
      pluginScope.panelAction('logs'),
      pluginScope.uiSlotRender('composer.above:plan-status'),
      pluginScope.uiSlotAction('composer.above:plan-status'),
      pluginScope.storage('writeJson'),
      pluginScope.settingsChange(),
      pluginScope.steer(),
      pluginScope.followUp(),
      pluginScope.sendMessage(),
      pluginScope.inputIntercept('big-macro'),
      pluginScope.toolCallIntercept('guard'),
      pluginScope.toolResultIntercept('redact'),
      pluginScope.registration('WorkspacePanel'),
      pluginScope.connector('wechat'),
      pluginScope.searchProvide('emoji'),
      pluginScope.deepLinkAction('plugin:trans:translate'),
      pluginScope.credentialStrategy('plugin:b:least-used'),
      pluginScope.resourceCall('session'),
    ]
    // 工厂数量与样本数量对齐 —— 加了工厂却忘了在这里取样,这条会红。
    expect(samples).toHaveLength(Object.keys(pluginScope).length)
    // 加载期标签是另一套词汇:它**不该**归族(见 markLoadError 不查表)。
    for (const label of Object.values(pluginLoadLabel)) {
      expect(classifyPluginScope(label()), label()).toBeNull()
    }
    const unclassified = samples.filter(scope => classifyPluginScope(scope) === null)
    expect(unclassified, `unclassified: ${unclassified.join(', ')}`).toEqual([])
  })

  it('leaves no family without a real producer — no dead rules parked in the table', () => {
    /*
     * 表里不该停放没有生产者的规则。R7 第一版的 `entry` 家族就是死的(加载失败
     * 全写进 CorePluginInfo.error,从不进熔断账),而最能证明"降级而非禁用"
     * 那条拍板的 `connector` 家族当时也只有注册期生产者。
     *
     * 判据分两步:
     *  1. 每个工厂声明它**能产出哪些家族**(样本 → 归族,由断言验证声明无误);
     *  2. 遍历产品与装配层源码,看这个工厂**是否真的被调用**;
     * 两步合起来:每个家族都要能被某个真的被调用的工厂产出。
     */
    const SAMPLES: Array<{ factory: keyof typeof pluginScope; scope: string; family: string }> = [
      { factory: 'promptContext', scope: pluginScope.promptContext('notes'), family: 'prompt-context' },
      { factory: 'beforeContextCompact', scope: pluginScope.beforeContextCompact('h'), family: 'lifecycle-hook' },
      { factory: 'afterAssistantResponse', scope: pluginScope.afterAssistantResponse('h'), family: 'lifecycle-hook' },
      { factory: 'lifecycleHook', scope: pluginScope.lifecycleHook('beforeContextCompact', 'h'), family: 'lifecycle-hook' },
      { factory: 'event', scope: pluginScope.event('message:created'), family: 'event-handler' },
      { factory: 'eventEmit', scope: pluginScope.eventEmit('ping'), family: 'event-emit' },
      { factory: 'request', scope: pluginScope.request('search'), family: 'plugin-request' },
      // 面板请求在生产里也走 request()(action 已经是 `panel:render:<id>`),
      // 所以 ui-request 这一族的真实生产者就是 request 工厂。
      { factory: 'request', scope: pluginScope.request('panel:render:logs'), family: 'ui-request' },
      { factory: 'panelRender', scope: pluginScope.panelRender('logs'), family: 'ui-request' },
      { factory: 'panelAction', scope: pluginScope.panelAction('logs'), family: 'ui-request' },
      // 锚点块同族(R5.x):render 与 action 折叠为同一 surface,与面板同一条账。
      { factory: 'uiSlotRender', scope: pluginScope.uiSlotRender('composer.above:x'), family: 'ui-request' },
      { factory: 'uiSlotAction', scope: pluginScope.uiSlotAction('composer.above:x'), family: 'ui-request' },
      { factory: 'storage', scope: pluginScope.storage('writeJson'), family: 'storage' },
      { factory: 'settingsChange', scope: pluginScope.settingsChange(), family: 'settings-change' },
      { factory: 'steer', scope: pluginScope.steer(), family: 'conversation-control' },
      { factory: 'followUp', scope: pluginScope.followUp(), family: 'conversation-control' },
      // N1:跨会话投递就是那两条队列的上层门面,同族。
      { factory: 'sendMessage', scope: pluginScope.sendMessage(), family: 'conversation-control' },
      // N2:发送前拦截自成一族 —— 它 fail-open(失败对用户无害),所以罚则是
      // 停掉这一个干预面而不是整体禁用,与 conversation-control 分开。
      { factory: 'inputIntercept', scope: pluginScope.inputIntercept('big-macro'), family: 'input-intercept' },
      // N4:工具调用拦截自成一族 —— 它 fail-closed(失败会挡住一次工具执行),
      // 罚则的职责因此与 input-intercept 相反:降级是这条链唯一的逃生口。
      { factory: 'toolCallIntercept', scope: pluginScope.toolCallIntercept('guard'), family: 'toolcall-intercept' },
      // N5:工具结果改写自成一族 —— 它 fail-open(失败 = 放行原结果,无害),
      // 罚则的职责因此与 toolcall-intercept 相反:降级只是省预算,不是逃生口。
      { factory: 'toolResultIntercept', scope: pluginScope.toolResultIntercept('redact'), family: 'toolresult-intercept' },
      { factory: 'registration', scope: pluginScope.registration('WorkspacePanel'), family: 'registration' },
      { factory: 'connector', scope: pluginScope.connector('wechat'), family: 'connector' },
      // M2:搜索供给方自成一族 —— 一个供给方超时/抛错只影响它自己那一组结果,
      // 降级停这一个供给方,不连坐插件其余能力。生产者在聚合器(app/search)。
      { factory: 'searchProvide', scope: pluginScope.searchProvide('emoji'), family: 'search-provide' },
      // H4:深链动作自成一族 —— 一个动作抛错/超时只影响那一个入口,`onething://ask`
      // 与插件其余动作照常。生产者在派发口(app/deeplink/registry)。
      { factory: 'deepLinkAction', scope: pluginScope.deepLinkAction('plugin:trans:translate'), family: 'deep-link' },
      // 批 E:凭证策略自成一族 —— 它坐在**起流的关键路径**上,而"挑哪把钥匙"
      // 从来就有一个可用的默认答案(内置 priority-failover),所以罚则只能是
      // 降级、绝不能是整体禁用。生产者在策略调用口(app/providers/credential-strategy)。
      { factory: 'credentialStrategy', scope: pluginScope.credentialStrategy('plugin:b:least-used'), family: 'credential-strategy' },
      // 原子 K4-b:插件对一个命名空间的读 / 做自成一族 —— 记的只有「压根没拿到
      // 结局」那种失败(内核回的 failed / denied / invalid 是**答案**,不是故障),
      // 罚则只停这一个命名空间。生产者在调用口(backend/wiring/plugins/resources.ts)。
      { factory: 'resourceCall', scope: pluginScope.resourceCall('session'), family: 'resource-call' },
    ]

    // 声明本身要对。
    for (const sample of SAMPLES) {
      expect(classifyPluginScope(sample.scope), sample.scope).toBe(sample.family)
    }
    // 每个工厂都要在样本表里出现 —— 加了工厂却忘了取样,这条会红。
    expect(new Set(SAMPLES.map(entry => entry.factory)).size).toBe(Object.keys(pluginScope).length)

    const files = readSourceFiles([
      path.join(REPO_ROOT, 'packages/core/plugins'),
      path.join(REPO_ROOT, 'packages/backend'),
      // P3'c:health / 四个 `*-bound` / `lifecycle.wiring` 的判决路径搬进了产品层,
      // 三棵树一起扫才还是同一条判据。
      path.join(REPO_ROOT, 'packages/onething-runtime/src/plugins'),
      // P3'e-A2b:`prompt-context` 家族的判决路径(插件提示词 provider 的
      // 超时/异常记一次失败)随 `prompt/plugin-context.ts` 进了产品层的
      // `prompts/plugin-context.wiring.ts`,不加这一棵它会被误报成死规则。
      path.join(REPO_ROOT, 'packages/onething-runtime/src/prompts'),
    ])

    /*
     * 判据是"该 scope 至少有一条路径**抵达 recordFailure**",不是"工厂被调用过"。
     *
     * 后者对一种死法完全失明:R7 第一版的 `install` 家族,工厂确实被调用了
     * (markLoadError),但 markLoadError 从不查严重度表 —— 阈值与罚则永远不生效,
     * 而守卫是绿的。那是同一个病的第三次,所以判据必须钉在判决路径上。
     */
    const judgedFactories = new Set(Object.keys(pluginScope).filter(name => reachesJudgement(name, files)))
    const producedFamilies = new Set(
      SAMPLES.filter(sample => judgedFactories.has(sample.factory)).map(sample => sample.family),
    )

    const dead = PLUGIN_SCOPE_FAMILIES.filter(family => !producedFamilies.has(family))
    expect(dead, `these families never reach recordFailure: ${dead.join(', ')}`).toEqual([])

    // 反过来钉住上一次的死法:加载期标签是**另一套词汇**,它不进判决路径,
    // 所以严重度表里不该有它的家族。
    expect(classifyPluginScope(pluginLoadLabel.entry())).toBeNull()
    expect(PLUGIN_SCOPE_FAMILIES as readonly string[]).not.toContain('install')
    expect(PLUGIN_SCOPE_FAMILIES as readonly string[]).not.toContain('entry')
  })

  it('falls back to the safest remedy for a scope nobody registered', () => {
    // 未登记 = 按既有行为整体禁用。宁可过严也不要静默放行一个没人想过的失败面。
    const resolved = resolvePluginScopeSeverity('something-nobody-declared')
    expect(resolved.family).toBeNull()
    expect(resolved.remedy).toBe('disable-plugin')
  })
})

describe('R7 registry teardown table — 每个开放的注册表都要回答"在飞的怎么办"', () => {
  it('declares a teardown policy for every open registry', () => {
    expect([...PLUGIN_OPEN_REGISTRIES]).toEqual(['im-connector', 'search-provider', 'deep-link-action', 'credential-strategy'])
    for (const registry of PLUGIN_OPEN_REGISTRIES) {
      const policy = PLUGIN_REGISTRY_POLICY[registry]
      expect(policy, registry).toBeTruthy()
      expect(['reject-disable', 'degrade-to-default', 'fail-open']).toContain(policy.teardown)
      expect(policy.inFlight.length, registry).toBeGreaterThan(20)
      expect(policy.hostDivergence.length, registry).toBeGreaterThan(20)
      // 试点期没有真实流量就必须说出来 —— 否则文档与报告读起来像它已经在工作。
      expect(typeof policy.hasProductionTraffic).toBe('boolean')
      expect(policy.trafficNote.length, registry).toBeGreaterThan(20)
    }
  })

  it('binds the teardown label to actual behaviour, not just to a string', async () => {
    /*
     * 标签必须能被行为验证。R7 第一版把 im-connector 标成 degrade-to-default 而
     * 实现是 throw,当时的测试只断言"理由字符串长度 > 20" —— 标签与实现完全没有
     * 绑定,第一条数据就是错的。
     */
    const registry = await import('../../../channel/connector-registry.js')
    const teardown = PLUGIN_REGISTRY_POLICY['im-connector'].teardown

    const unregister = registry.registerIMConnector({
      id: 'label-check',
      sendReply: async () => {},
      normalizeIncoming: async () => ({ content: '', origin: {} as never }),
    } as never)
    unregister()

    const call = registry.sendIMReply(
      { connector: 'label-check', conversationId: 'c' } as never,
      { text: 'x', sessionId: 's', messageId: 'm' },
    )
    if (teardown === 'fail-open') {
      // fail-open = 说得清地失败,由调用方自理。
      await expect(call).rejects.toThrow(/not registered/)
    } else if (teardown === 'degrade-to-default') {
      // degrade-to-default = 回落宿主默认路径,**调用仍然成功**。
      await expect(call).resolves.toBeUndefined()
    } else {
      // reject-disable = 压根不该允许拆到这一步。
      throw new Error('reject-disable is not exercised by this pilot')
    }
  })

  it('keeps the open-registry list in step with the host forwarding ports', () => {
    /*
     * 拆除快照号称"自动覆盖新成员",其实 imConnectorIds 是手写加进去的两处 ——
     * 又一句自己不兑现的承诺。这条守卫补上真正的联动:core 的 CorePluginAPIHost
     * 上每多一个 `register*(pluginId` 转发口,就必须在 PLUGIN_OPEN_REGISTRIES
     * 里有对应成员,否则一个开放了却没有拆除语义声明的注册表会悄悄溜过去。
     */
    const hostSource = fs.readFileSync(path.join(REPO_ROOT, 'packages/core/plugins/api-builder.ts'), 'utf-8')
    const interfaceStart = hostSource.indexOf('export interface CorePluginAPIHost')
    const interfaceEnd = hostSource.indexOf('\n}', interfaceStart)
    const body = hostSource.slice(interfaceStart, interfaceEnd)

    // 形如 `registerIMConnector?(pluginId: string, …)` 的转发口。
    const forwarders = [...body.matchAll(/\bregister([A-Z][A-Za-z]*)\??\(\s*pluginId/g)].map(m => m[1])
    // 已知的**非注册表**转发口(它们是能力面,不是可被插件占用的既有注册表)。
    // `InputInterceptHook`(N2)与两个生命周期钩子同类:它是一个**能力面**
    // (宿主开的一个新钩子点),不是一个"插件可以占用、拆除时要问在飞怎么办"的
    // 既有注册表 —— 它的在飞语义由 fail-open 与 lifecycleUnsubs 回答。
    const NOT_REGISTRIES = new Set(['Tool', 'PromptContextProvider', 'BeforeContextCompactHook', 'AfterAssistantResponseHook', 'InputInterceptHook', 'ToolCallInterceptHook', 'ToolResultInterceptHook', 'SkillRoot'])

    const registryPorts = forwarders.filter(name => !NOT_REGISTRIES.has(name))
    const expected = registryPorts.map(name => name
      .replace(/^IM/, 'im-')
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase())

    expect(expected.sort(), `host forwarders: ${registryPorts.join(', ')}`)
      .toEqual([...PLUGIN_OPEN_REGISTRIES].sort())
  })

  it('keeps every deferred registry documented with a structured reason', () => {
    // 纪律:一次只开一个。**不开**的那些要把理由留在代码里,否则下一个人会从零
    // 重新论证一遍,并且很可能论证成"看起来没问题"。
    // 键从 as const 数组派生 —— 拼错 key 会 typecheck 红(上一版是
    // Record<string,string>,拼错了谁也不知道),这里逐条钉**全部**五条。
    expect(PLUGIN_DEFERRED_REGISTRY_IDS.length).toBe(5)
    for (const id of PLUGIN_DEFERRED_REGISTRY_IDS) {
      const entry = PLUGIN_DEFERRED_REGISTRIES[id]
      expect(entry, id).toBeTruthy()
      expect(entry.reason.length, id).toBeGreaterThan(30)
      expect(entry.revisitWhen.length, id).toBeGreaterThan(5)
      expect(entry.ref.length, id).toBeGreaterThan(3)
    }
    // 开放与推迟不能同时成立。
    for (const registry of PLUGIN_OPEN_REGISTRIES) {
      expect((PLUGIN_DEFERRED_REGISTRY_IDS as readonly string[])).not.toContain(registry)
    }
  })
})
