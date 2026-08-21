/**
 * R5.x-a 验收:锚点地基。
 *
 * 钉住的东西:
 *  1. **锚点清单是宿主编译期常量** —— 插件注册未知锚点/未声明 id/重复 id/
 *     抢占 `ui:` 前缀,四类违规全部被拒且计 registration 熔断;manifest 里
 *     声明未知锚点则是**降级**(unsupported),不是加载错误。
 *  2. **同一套协议与通道** —— `ui:render:` / `ui:action:` 走统一请求通道,
 *     结果过同一套描述树校验,熔断归入 `ui-request` 家族,render 与 action
 *     折叠为同一个 surface(不许出现"画得出来但点不动")。
 *  3. **render ctx 带 anchor 与 sessionId** —— 会话作用域是协议的一部分,
 *     不是二期补丁。
 */
import { describe, expect, it } from 'vitest'
import {
  CorePluginManager,
  PLUGIN_PANEL_PROTOCOL_VERSION,
  PLUGIN_UI_INVOKE_ACTION,
  PLUGIN_UI_RENDER_ACTION,
  UI_ANCHORS,
  UI_ANCHOR_CAPACITY,
  UI_SLOT_DEFAULT_SIDE,
  assertUiAnchorRegistryConsistency,
  classifyPluginScope,
  createCorePluginAPI,
  describePluginSurface,
  disposeCorePluginState,
  isEffectiveUiDrawerSlot,
  isIgnoredUiDrawerDeclaration,
  isIgnoredUiSlotSideDeclaration,
  isTriggerUiAnchor,
  isUiAnchor,
  isUiSlotSide,
  pluginScope,
  resolveUiSlotSide,
  supportsUiDrawer,
  supportsUiSlotSide,
  uiDrawerExpandedMaxHeight,
  uiAnchorKind,
  uiSlotMaxWidth,
  uiSlotSurfaceId,
  validatePluginContributes,
  type CorePluginDefinition,
  type CorePluginManagerHost,
  type CorePluginRequestHandler,
  type CorePluginStateLike,
  type CorePluginUiSlotRegistration,
  type CorePluginUiSlotContext,
  type PluginPanelTree,
  type UiAnchor,
} from '@onething/core/plugins'
import { projectOnethingPluginsForRenderer } from '../plugin-list.js'

interface TestAPI {
  registerUiSlot(registration: CorePluginUiSlotRegistration): void
  registerRequestHandler(action: string, handler: CorePluginRequestHandler): void
}
type TestEntry = (api: TestAPI) => void | Promise<void>
type TestDefinition = CorePluginDefinition<TestEntry>
interface TestCommand { name: string }
interface TestState extends CorePluginStateLike<TestCommand> {
  requestHandlers: Map<string, CorePluginRequestHandler>
  disposed?: boolean
}

function silentLogger() {
  return { log: () => {}, error: () => {} }
}

function createManager(
  definitions: TestDefinition[],
  hostOverrides: Partial<CorePluginManagerHost<TestDefinition, TestEntry, TestAPI, TestState, TestCommand, { ready: true }>> = {},
) {
  const errors: string[] = []
  const failures: Array<{ pluginId: string; scope: string }> = []
  const refreshes: Array<{ pluginId: string; panelId: string }> = []

  const host: CorePluginManagerHost<TestDefinition, TestEntry, TestAPI, TestState, TestCommand, { ready: true }> = {
    ensurePluginDirs() {},
    scanPlugins: () => definitions,
    loadPluginEntry: async definition => definition.entry ?? null,
    createPluginAPI(pluginId) {
      // 声明来自 manifest —— 与 app 层 manager 的取法逐字相同。
      const declaredUiSlots = definitions
        .find(item => item.id === pluginId)
        ?.manifest.contributes?.uiSlots ?? []
      const created = (createCorePluginAPI as any)({
        pluginId,
        declaredUiSlots,
        scheduler: { schedule: () => {}, cancel: () => {} } as any,
        store: { get: () => undefined, set: () => {}, delete: () => {}, keys: () => [] } as any,
        host: {
          emitPanelRefresh(id: string, panelId: string) {
            refreshes.push({ pluginId: id, panelId })
          },
        } as any,
        logger: { log: () => {}, error: (message: string) => errors.push(message) },
        onPluginFailure: (input: { pluginId: string; scope: string }) =>
          failures.push({ pluginId: input.pluginId, scope: input.scope }),
      })
      return { state: created.state as unknown as TestState, api: created.api as unknown as TestAPI }
    },
    disposePlugin(state) {
      disposeCorePluginState(state as any)
    },
    setPluginEnabled() {},
    ...hostOverrides,
  }

  const manager = new CorePluginManager<TestAPI, TestEntry, TestCommand, TestState, TestDefinition, { ready: true }>(
    host,
    silentLogger(),
  )
  return { manager, errors, failures, refreshes }
}

function definition(
  id: string,
  entry: TestEntry,
  uiSlots: Array<{ anchor: string; id: string; label: string; drawer?: boolean }>,
): TestDefinition {
  return {
    id,
    manifest: { name: id, version: '1.0.0', contributes: { uiSlots } },
    dirPath: `/plugins/${id}`,
    entryPath: `/plugins/${id}/plugin-entry.js`,
    enabled: true,
    entry,
  }
}

function simpleTree(text: string): PluginPanelTree {
  return {
    version: PLUGIN_PANEL_PROTOCOL_VERSION,
    body: { type: 'row', children: [{ type: 'markdown', text }] },
  }
}

async function boot(manager: CorePluginManager<any, any, any, any, any, { ready: true }>) {
  await manager.initialize({ ready: true })
}

// ── 清单守卫 ─────────────────────────────────

describe('UI anchor registry', () => {
  it('capacity 键集合与 UI_ANCHORS 产出集合相等(运行时断言)', () => {
    expect(() => assertUiAnchorRegistryConsistency()).not.toThrow()
    for (const anchor of Object.values(UI_ANCHORS)) {
      expect(UI_ANCHOR_CAPACITY[anchor]).toBeDefined()
      expect(isUiAnchor(anchor)).toBe(true)
    }
  })

  it('未知锚点不是锚点', () => {
    expect(isUiAnchor('composer.dock')).toBe(false)
    expect(isUiAnchor('chat.header')).toBe(false)
  })

  /**
   * D 期:kind 轴。锚点表新增两个**触发式**锚点(§9.2 地址地图),
   * kind 由宿主锚点表决定 —— 插件的声明形状一字不改。
   */
  it('kind 轴:两个触发式锚点已开,既有三个仍是常显块(append-only)', () => {
    expect(isUiAnchor('message.actions')).toBe(true)
    expect(isUiAnchor('composer.actions')).toBe(true)
    expect(uiAnchorKind('message.actions')).toBe('trigger')
    expect(uiAnchorKind('composer.actions')).toBe('trigger')
    expect(isTriggerUiAnchor('message.actions')).toBe(true)
    expect(isTriggerUiAnchor('composer.above')).toBe(false)
    expect(uiAnchorKind('chat.header')).toBeUndefined()

    // 已发布锚点的 kind 永不变更(§9.4:address/kind/context 只加不改)。
    for (const anchor of ['composer.above', 'chat.status-bar', 'message.footer'] as const) {
      expect(UI_ANCHOR_CAPACITY[anchor].kind).toBe('block')
    }
    // 容量数字可放宽不可收紧 —— 触发式锚点 3 个入口,超出折叠。
    expect(UI_ANCHOR_CAPACITY['message.actions'].maxBlocks).toBe(3)
    expect(UI_ANCHOR_CAPACITY['composer.actions'].maxBlocks).toBe(3)
  })

  /**
   * F 期:抽屉是 block 在 composer.above 上的**能力扩展**,不是新 kind ——
   * kind 轴一个字没动,多的是容量表上的两个可选字段。
   */
  it('抽屉能力只开在 composer.above,且没有变成新的 kind', () => {
    expect(supportsUiDrawer('composer.above')).toBe(true)
    expect(UI_ANCHOR_CAPACITY['composer.above'].kind).toBe('block')
    expect(uiDrawerExpandedMaxHeight('composer.above')).toBe(240)
    for (const anchor of [
      'chat.status-bar', 'message.footer', 'message.actions', 'composer.actions',
      // I 期两个新锚点同样不开抽屉 —— 能力扩展不随新锚点自动继承。
      'composer.aside', 'composer.below',
    ]) {
      expect(supportsUiDrawer(anchor)).toBe(false)
      // 没开抽屉的锚点问展开高度 = 回落到它自己的 maxHeight(不是 undefined,
      // 也不是 240):调用方永远拿得到一个能用的数。
      expect(uiDrawerExpandedMaxHeight(anchor)).toBe(UI_ANCHOR_CAPACITY[anchor as UiAnchor].maxHeight)
    }
    expect(supportsUiDrawer('composer.dock')).toBe(false)
    expect(uiDrawerExpandedMaxHeight('composer.dock')).toBeUndefined()
  })

  /**
   * I 期:两个新锚点。§9.4 的"开新锚点 = 9.2 表加一行 + 五处代码"在这里
   * 兑现其中两处(容量表 + UI_ANCHORS 的一致性守卫已由上面那条用例覆盖);
   * 本用例钉的是**语义**:kind/容量/分侧,以及既有五个锚点一字未动。
   */
  it('I 期两个新锚点已开,既有五个锚点的语义一字未动(append-only)', () => {
    expect(isUiAnchor('composer.aside')).toBe(true)
    expect(isUiAnchor('composer.below')).toBe(true)
    expect(uiAnchorKind('composer.aside')).toBe('block')
    expect(uiAnchorKind('composer.below')).toBe('block')
    // 两翼:每侧 1 块、宽 48px、高 ≤ 输入框(160px 兜底)。
    expect(UI_ANCHOR_CAPACITY['composer.aside'].maxBlocks).toBe(1)
    expect(UI_ANCHOR_CAPACITY['composer.aside'].maxWidth).toBe(48)
    expect(uiSlotMaxWidth('composer.aside')).toBe(48)
    // 后勤带:2 块 / 24px,宽随输入框(没有 maxWidth 这个概念)。
    expect(UI_ANCHOR_CAPACITY['composer.below'].maxBlocks).toBe(2)
    expect(UI_ANCHOR_CAPACITY['composer.below'].maxHeight).toBe(24)
    expect(uiSlotMaxWidth('composer.below')).toBeUndefined()
    // 既有五个锚点:kind 与容量数字都不许被 I 期改写。
    expect(UI_ANCHOR_CAPACITY['composer.above'].maxBlocks).toBe(3)
    expect(UI_ANCHOR_CAPACITY['chat.status-bar'].maxBlocks).toBe(8)
    expect(UI_ANCHOR_CAPACITY['message.footer'].maxBlocks).toBe(6)
  })

  it('分侧只在 composer.aside 上开;缺省 right,未知值归缺省,别处声明被忽略并标记', () => {
    expect(supportsUiSlotSide('composer.aside')).toBe(true)
    expect(UI_SLOT_DEFAULT_SIDE).toBe('right')
    expect(resolveUiSlotSide('composer.aside', 'left')).toBe('left')
    expect(resolveUiSlotSide('composer.aside', 'right')).toBe('right')
    expect(resolveUiSlotSide('composer.aside', undefined)).toBe('right')
    // 未来的第三个侧位值在今天的宿主上归缺省侧,不拒载(与未知锚点同规)。
    expect(resolveUiSlotSide('composer.aside', 'top')).toBe('right')
    for (const anchor of [
      'composer.above', 'chat.status-bar', 'message.footer', 'message.actions',
      'composer.actions', 'composer.below',
    ]) {
      expect(supportsUiSlotSide(anchor)).toBe(false)
      // 不分侧的锚点上没有"侧"这个概念 —— 不是缺省 right,是 undefined。
      expect(resolveUiSlotSide(anchor, 'left')).toBeUndefined()
      // "被忽略"要说得出来(投影层据此标记,设置页可解释)。
      expect(isIgnoredUiSlotSideDeclaration(anchor, 'left')).toBe(true)
      expect(isIgnoredUiSlotSideDeclaration(anchor, undefined)).toBe(false)
    }
    expect(isIgnoredUiSlotSideDeclaration('composer.aside', 'left')).toBe(false)
    expect(isUiSlotSide('left')).toBe(true)
    expect(isUiSlotSide('top')).toBe(false)
  })

  it('drawer 的裁决判据只有一处:锚点开了能力 + 这条声明了它', () => {
    expect(isEffectiveUiDrawerSlot('composer.above', true)).toBe(true)
    expect(isEffectiveUiDrawerSlot('composer.above', false)).toBe(false)
    expect(isEffectiveUiDrawerSlot('composer.above', undefined)).toBe(false)
    expect(isEffectiveUiDrawerSlot('chat.status-bar', true)).toBe(false)
    // "被忽略"要说得出来(投影层据此标记,设置页可解释)。
    expect(isIgnoredUiDrawerDeclaration('chat.status-bar', true)).toBe(true)
    expect(isIgnoredUiDrawerDeclaration('composer.above', true)).toBe(false)
    expect(isIgnoredUiDrawerDeclaration('chat.status-bar', undefined)).toBe(false)
  })
})

// ── manifest 校验:形状管,位置不管 ───────────────

describe('contributes.uiSlots manifest validation', () => {
  it('合法声明通过(含宿主认识的锚点)', () => {
    expect(validatePluginContributes({
      uiSlots: [{ anchor: 'composer.above', id: 'plan-status', label: 'Plan' }],
    })).toBeNull()
  })

  it('未知锚点**不是**加载期错误(降级为 unsupported 是投影层的职责)', () => {
    expect(validatePluginContributes({
      uiSlots: [{ anchor: 'composer.dock', id: 'x', label: 'X' }],
    })).toBeNull()
  })

  it.each([
    [{ uiSlots: 'nope' }, 'must be an array'],
    [{ uiSlots: [{ id: 'x', label: 'X' }] }, 'anchor must be a non-empty string'],
    [{ uiSlots: [{ anchor: 'composer.above', label: 'X' }] }, 'id must be a non-empty string'],
    [{ uiSlots: [{ anchor: 'composer.above', id: 'x' }] }, 'label must be a non-empty string'],
    [{ uiSlots: [{ anchor: 'composer.above', id: 'x', label: 'X', lifetime: 42 }] }, 'lifetime must be a string'],
    [{ uiSlots: [{ anchor: 'composer.above', id: 'x', label: 'X', drawer: 'yes' }] }, 'drawer must be a boolean'],
    [{ uiSlots: [{ anchor: 'composer.aside', id: 'x', label: 'X', side: 3 }] }, 'side must be a string'],
  ])('形状非法被拒: %j', (contributes, message) => {
    expect(validatePluginContributes(contributes)).toContain(message)
  })

  it('触发式锚点的声明形状与常显块一字不差(kind 在宿主表里,插件不声明)', () => {
    expect(validatePluginContributes({
      uiSlots: [
        { anchor: 'message.actions', id: 'tps-usage', label: 'Token usage' },
        { anchor: 'composer.actions', id: 'plan-detail', label: 'Plan detail' },
      ],
    })).toBeNull()
    // 插件即使自作主张写 kind 也不成立 —— 未知键被忽略,呈现权始终在宿主。
    expect(validatePluginContributes({
      uiSlots: [{ anchor: 'message.actions', id: 'x', label: 'X', kind: 'block' }],
    })).toBeNull()
  })

  it.each(['message.actions', 'composer.actions'])(
    '触发式锚点 %s 同样整体拒 webview(弹层内容也只画描述树)',
    anchor => {
      expect(validatePluginContributes({
        uiSlots: [{ anchor, id: 'x', label: 'X', view: 'webview' }],
      })).toContain('view is not supported')
    },
  )

  it('drawer 声明在任何锚点上都不拒载(不支持的锚点上是"被忽略",不是错)', () => {
    expect(validatePluginContributes({
      uiSlots: [{ anchor: 'composer.above', id: 'x', label: 'X', drawer: true }],
    })).toBeNull()
    expect(validatePluginContributes({
      uiSlots: [
        { anchor: 'chat.status-bar', id: 'y', label: 'Y', drawer: true },
        { anchor: 'message.actions', id: 'z', label: 'Z', drawer: true },
        { anchor: 'composer.below', id: 'w', label: 'W', drawer: true },
      ],
    })).toBeNull()
  })

  it('lifetime 合法值通过;未知的未来值也不拒载(闸门读 === persistent,天然降级)', () => {
    expect(validatePluginContributes({
      uiSlots: [{ anchor: 'message.footer', id: 'x', label: 'X', lifetime: 'persistent' }],
    })).toBeNull()
    expect(validatePluginContributes({
      uiSlots: [{ anchor: 'message.footer', id: 'x', label: 'X', lifetime: 'ephemeral' }],
    })).toBeNull()
    expect(validatePluginContributes({
      uiSlots: [{ anchor: 'message.footer', id: 'x', label: 'X', lifetime: 'synced' }],
    })).toBeNull()
  })
})

// ── 注册纪律 ─────────────────────────────────

describe('registerUiSlot', () => {
  it('声明匹配的块注册成功,render 经通道可拉取且 ctx 带 anchor/sessionId', async () => {
    let seenCtx: CorePluginUiSlotContext | null = null
    const def = definition('plan-status', api => {
      api.registerUiSlot({
        anchor: 'composer.above',
        id: 'plan-status',
        render(ctx) {
          seenCtx = ctx
          return simpleTree('steps 3/5')
        },
      })
    }, [{ anchor: 'composer.above', id: 'plan-status', label: 'Plan' }])

    const { manager, failures } = createManager([def])
    await boot(manager)

    const result = await manager.handleRequest({
      pluginId: 'plan-status',
      action: `${PLUGIN_UI_RENDER_ACTION}:composer.above:plan-status`,
      payload: { sessionId: 'session-1' },
    })
    expect(result.success).toBe(true)
    expect((result as any).result.body.type).toBe('row')
    expect(failures).toEqual([])
    expect(seenCtx).not.toBeNull()
    expect(seenCtx!.anchor).toBe('composer.above')
    expect(seenCtx!.sessionId).toBe('session-1')
  })

  it('消息级锚点:render payload 带 messageId 时 ctx.messageId 随之过线', async () => {
    let seenCtx: CorePluginUiSlotContext | null = null
    const def = definition('tps-meter', api => {
      api.registerUiSlot({
        anchor: 'message.footer',
        id: 'tps-meter',
        render(ctx) {
          seenCtx = ctx
          return simpleTree('42 tok/s')
        },
      })
    }, [{ anchor: 'message.footer', id: 'tps-meter', label: 'TPS' }])

    const { manager, failures } = createManager([def])
    await boot(manager)

    const result = await manager.handleRequest({
      pluginId: 'tps-meter',
      action: `${PLUGIN_UI_RENDER_ACTION}:message.footer:tps-meter`,
      payload: { sessionId: 'session-1', messageId: 'msg-42' },
    })
    expect(result.success).toBe(true)
    expect(failures).toEqual([])
    expect(seenCtx).not.toBeNull()
    expect(seenCtx!.anchor).toBe('message.footer')
    expect(seenCtx!.sessionId).toBe('session-1')
    expect(seenCtx!.messageId).toBe('msg-42')
  })

  /**
   * F 期:抽屉块的 render ctx 多一个 `drawerState`。它是**可序列化的、只加不改**
   * 的一个字段:宿主按当前档随 payload 传入,插件据此返回两档不同的树。
   * 取值域只有会渲染的两档 —— 'collapsed' 与任何未知值都读成"不带这个字段"
   * (全收的块根本不会被拉)。
   */
  it('抽屉块:render payload 带 drawerState 时 ctx.drawerState 随之过线', async () => {
    const seen: Array<CorePluginUiSlotContext['drawerState']> = []
    const def = definition('plan-status', api => {
      api.registerUiSlot({
        anchor: 'composer.above',
        id: 'plan-status',
        render(ctx) {
          seen.push(ctx.drawerState)
          return simpleTree(ctx.drawerState === 'expanded' ? '整块' : '一行')
        },
      })
    }, [{ anchor: 'composer.above', id: 'plan-status', label: 'Plan', drawer: true }])

    const { manager, failures } = createManager([def])
    await boot(manager)

    const pull = (drawerState?: unknown) => manager.handleRequest({
      pluginId: 'plan-status',
      action: `${PLUGIN_UI_RENDER_ACTION}:composer.above:plan-status`,
      payload: { sessionId: 'session-1', ...(drawerState === undefined ? {} : { drawerState }) },
    })

    const peek = await pull('peek')
    const expanded = await pull('expanded')
    await pull('collapsed')
    await pull('future-state')
    await pull()

    expect(failures).toEqual([])
    expect((peek as any).result.body.children[0].text).toBe('一行')
    expect((expanded as any).result.body.children[0].text).toBe('整块')
    // 后三次:全收 / 未知值 / 不带 —— 插件一律看不到这个字段。
    expect(seen).toEqual(['peek', 'expanded', undefined, undefined, undefined])
  })

  /**
   * D 期:触发式锚点的注册面与常显块**逐字相同** —— 声明形状不变、通道不变、
   * ctx 不变。"点击才拉"是 renderer 的时序,不是协议的分叉(§9.3 第 5 条)。
   */
  it('触发式锚点 message.actions:声明/注册/render 与常显块同规,ctx 带 messageId', async () => {
    let seenCtx: CorePluginUiSlotContext | null = null
    const def = definition('tps-meter', api => {
      api.registerUiSlot({
        anchor: 'message.actions',
        id: 'tps-usage',
        render(ctx) {
          seenCtx = ctx
          return simpleTree('42 tok/s · 523 tokens')
        },
      })
    }, [{ anchor: 'message.actions', id: 'tps-usage', label: 'Token usage' }])

    const { manager, failures } = createManager([def])
    await boot(manager)

    const result = await manager.handleRequest({
      pluginId: 'tps-meter',
      action: `${PLUGIN_UI_RENDER_ACTION}:message.actions:tps-usage`,
      payload: { sessionId: 'session-1', messageId: 'msg-7' },
    })
    expect(result.success).toBe(true)
    expect(failures).toEqual([])
    expect(seenCtx!.anchor).toBe('message.actions')
    expect(seenCtx!.sessionId).toBe('session-1')
    expect(seenCtx!.messageId).toBe('msg-7')
    // 降级 surface 仍折叠为 ui:<anchor>:<id> —— 触发式没有自己的熔断家族。
    expect(describePluginSurface(pluginScope.uiSlotRender('message.actions:tps-usage')))
      .toBe(uiSlotSurfaceId('message.actions', 'tps-usage'))
  })

  it('触发式锚点 composer.actions:会话级 ctx(带 sessionId,不带 messageId)', async () => {
    let seenCtx: CorePluginUiSlotContext | null = null
    const def = definition('plan-status', api => {
      api.registerUiSlot({
        anchor: 'composer.actions',
        id: 'plan-detail',
        render(ctx) {
          seenCtx = ctx
          return simpleTree('steps 3/5')
        },
      })
    }, [{ anchor: 'composer.actions', id: 'plan-detail', label: 'Plan detail' }])

    const { manager, failures } = createManager([def])
    await boot(manager)

    const result = await manager.handleRequest({
      pluginId: 'plan-status',
      action: `${PLUGIN_UI_RENDER_ACTION}:composer.actions:plan-detail`,
      payload: { sessionId: 'session-9' },
    })
    expect(result.success).toBe(true)
    expect(failures).toEqual([])
    expect(seenCtx!.anchor).toBe('composer.actions')
    expect(seenCtx!.sessionId).toBe('session-9')
    expect(seenCtx!.messageId).toBeUndefined()
  })

  it('render payload 不带 messageId 时 ctx.messageId 缺席(会话级锚点不变)', async () => {
    let seenCtx: CorePluginUiSlotContext | null = null
    const def = definition('tps-meter', api => {
      api.registerUiSlot({
        anchor: 'message.footer',
        id: 'tps-meter',
        render(ctx) {
          seenCtx = ctx
          return simpleTree('x')
        },
      })
    }, [{ anchor: 'message.footer', id: 'tps-meter', label: 'TPS' }])

    const { manager } = createManager([def])
    await boot(manager)

    await manager.handleRequest({
      pluginId: 'tps-meter',
      action: `${PLUGIN_UI_RENDER_ACTION}:message.footer:tps-meter`,
      payload: { sessionId: 'session-1' },
    })
    expect(seenCtx!.messageId).toBeUndefined()
  })

  it('render payload 不带 sessionId 时 ctx.sessionId 为 null(全局块)', async () => {
    let seenCtx: CorePluginUiSlotContext | null = null
    const def = definition('plan-status', api => {
      api.registerUiSlot({
        anchor: 'composer.above',
        id: 'plan-status',
        render(ctx) {
          seenCtx = ctx
          return simpleTree('idle')
        },
      })
    }, [{ anchor: 'composer.above', id: 'plan-status', label: 'Plan' }])

    const { manager } = createManager([def])
    await boot(manager)
    await manager.handleRequest({
      pluginId: 'plan-status',
      action: `${PLUGIN_UI_RENDER_ACTION}:composer.above:plan-status`,
    })
    expect(seenCtx!.sessionId).toBeNull()
  })

  it('ctx.refresh() 走 panel-refresh 通知轨,panelId 带 ui: 前缀的 surface id', async () => {
    const def = definition('plan-status', api => {
      api.registerUiSlot({
        anchor: 'composer.above',
        id: 'plan-status',
        render: () => simpleTree('x'),
        onAction(_input, ctx) {
          ctx.refresh()
          return { refresh: false }
        },
      })
    }, [{ anchor: 'composer.above', id: 'plan-status', label: 'Plan' }])

    const { manager, refreshes } = createManager([def])
    await boot(manager)
    await manager.handleRequest({
      pluginId: 'plan-status',
      action: `${PLUGIN_UI_INVOKE_ACTION}:composer.above:plan-status`,
      payload: { actionId: 'poke' },
    })
    expect(refreshes).toEqual([{
      pluginId: 'plan-status',
      panelId: uiSlotSurfaceId('composer.above', 'plan-status'),
    }])
  })

  it('未声明的 id 被拒且计 registration 熔断', async () => {
    const def = definition('plan-status', api => {
      api.registerUiSlot({
        anchor: 'composer.above',
        id: 'not-declared',
        render: () => simpleTree('x'),
      })
    }, [{ anchor: 'composer.above', id: 'plan-status', label: 'Plan' }])

    const { manager, errors, failures } = createManager([def])
    await boot(manager)
    expect(errors.some(message => message.includes('does not match'))).toBe(true)
    expect(failures).toEqual([{ pluginId: 'plan-status', scope: pluginScope.registration('UiSlot') }])
    await expect(manager.handleRequest({
      pluginId: 'plan-status',
      action: `${PLUGIN_UI_RENDER_ACTION}:composer.above:not-declared`,
    })).resolves.toMatchObject({ success: false })
  })

  it('未知锚点在注册期是代码错误(与 manifest 层的降级不同)', async () => {
    const def = definition('plan-status', api => {
      api.registerUiSlot({
        anchor: 'composer.dock',
        id: 'plan-status',
        render: () => simpleTree('x'),
      })
    }, [{ anchor: 'composer.dock', id: 'plan-status', label: 'Plan' }])

    const { manager, errors, failures } = createManager([def])
    await boot(manager)
    expect(errors.some(message => message.includes('unknown anchor'))).toBe(true)
    expect(failures).toEqual([{ pluginId: 'plan-status', scope: pluginScope.registration('UiSlot') }])
  })

  it('重复注册被拒且计熔断', async () => {
    const def = definition('plan-status', api => {
      const registration = {
        anchor: 'composer.above',
        id: 'plan-status',
        render: () => simpleTree('x'),
      }
      api.registerUiSlot(registration)
      api.registerUiSlot(registration)
    }, [{ anchor: 'composer.above', id: 'plan-status', label: 'Plan' }])

    const { manager, errors, failures } = createManager([def])
    await boot(manager)
    expect(errors.some(message => message.includes('already registered'))).toBe(true)
    expect(failures).toEqual([{ pluginId: 'plan-status', scope: pluginScope.registration('UiSlot') }])
  })

  it('插件直接抢占 ui: 前缀的 handler 被拒', async () => {
    const def = definition('plan-status', api => {
      api.registerRequestHandler(`${PLUGIN_UI_RENDER_ACTION}:composer.above:plan-status`, () => simpleTree('fake'))
    }, [{ anchor: 'composer.above', id: 'plan-status', label: 'Plan' }])

    const { manager, errors, failures } = createManager([def])
    await boot(manager)
    expect(errors.some(message => message.includes('namespace'))).toBe(true)
    expect(failures).toEqual([{ pluginId: 'plan-status', scope: pluginScope.registration('RequestHandler') }])
  })
})

// ── 通道守卫:同一套描述树校验 ────────────────────

describe('ui: channel guard', () => {
  it('ui:render 返回带函数成员的树被通道当场拒绝', async () => {
    const def = definition('plan-status', api => {
      api.registerUiSlot({
        anchor: 'composer.above',
        id: 'plan-status',
        render: () => ({
          version: PLUGIN_PANEL_PROTOCOL_VERSION,
          body: { type: 'row', children: [{ type: 'button', label: 'x', actionId: 'a', onClick: () => {} }] },
        } as unknown as PluginPanelTree),
      })
    }, [{ anchor: 'composer.above', id: 'plan-status', label: 'Plan' }])

    const { manager } = createManager([def])
    await boot(manager)
    const result = await manager.handleRequest({
      pluginId: 'plan-status',
      action: `${PLUGIN_UI_RENDER_ACTION}:composer.above:plan-status`,
    })
    expect(result.success).toBe(false)
    // 序列化浅校验先于形状校验命中 —— 两道口都在通道上,拒绝即达标。
    expect((result as any).error).toContain('onClick is a function')
  })
})

// ── 熔断归族与 surface 折叠 ──────────────────────

describe('ui: scope classification & surface folding', () => {
  it('request:ui:* 归入 ui-request 家族(用户主动触发,降级不连坐)', () => {
    expect(classifyPluginScope(pluginScope.uiSlotRender('composer.above:plan-status'))).toBe('ui-request')
    expect(classifyPluginScope(pluginScope.uiSlotAction('composer.above:plan-status'))).toBe('ui-request')
  })

  it('同一块的 render 与 action 折叠为同一个 surface', () => {
    const renderScope = pluginScope.uiSlotRender('composer.above:plan-status')
    const actionScope = pluginScope.uiSlotAction('composer.above:plan-status')
    expect(describePluginSurface(renderScope)).toBe('ui:composer.above:plan-status')
    expect(describePluginSurface(actionScope)).toBe('ui:composer.above:plan-status')
  })

  it('降级闸按折叠后的 surface 短路:render 与 action 同生共死', async () => {
    const degraded = new Set<string>(['ui:composer.above:plan-status'])
    let renderCalls = 0
    let actionCalls = 0
    const def = definition('plan-status', api => {
      api.registerUiSlot({
        anchor: 'composer.above',
        id: 'plan-status',
        render: () => {
          renderCalls += 1
          return simpleTree('x')
        },
        onAction: () => {
          actionCalls += 1
          return { refresh: false }
        },
      })
    }, [{ anchor: 'composer.above', id: 'plan-status', label: 'Plan' }])

    const { manager } = createManager([def], {
      isSurfaceDegraded: (pluginId, surface) => degraded.has(surface),
      describeDegradedSurface: () => 'too many failures',
    })
    await boot(manager)

    const render = await manager.handleRequest({
      pluginId: 'plan-status',
      action: `${PLUGIN_UI_RENDER_ACTION}:composer.above:plan-status`,
    })
    const action = await manager.handleRequest({
      pluginId: 'plan-status',
      action: `${PLUGIN_UI_INVOKE_ACTION}:composer.above:plan-status`,
      payload: { actionId: 'poke' },
    })
    expect(render).toMatchObject({ success: false, degraded: true, surface: 'ui:composer.above:plan-status' })
    expect(action).toMatchObject({ success: false, degraded: true, surface: 'ui:composer.above:plan-status' })
    // 短路在进插件之前 —— 降级不是"少罚一点",是这块界面不再被调用。
    expect(renderCalls).toBe(0)
    expect(actionCalls).toBe(0)

    // bypassDegraded 是显式"再试一次"的逃生口,与面板同规。
    const retry = await manager.handleRequest({
      pluginId: 'plan-status',
      action: `${PLUGIN_UI_RENDER_ACTION}:composer.above:plan-status`,
      bypassDegraded: true,
    })
    expect(retry.success).toBe(true)
    expect(renderCalls).toBe(1)
  })
})

// ── 清单投影:unsupported 标记 ─────────────────────

describe('renderer projection', () => {
  it('未知锚点的块在投影里标记 unsupported,认识的锚点不标', () => {
    const [plugin] = projectOnethingPluginsForRenderer([{
      definition: {
        id: 'plan-status',
        source: 'user',
        enabled: true,
        dirPath: '/plugins/plan-status',
        manifest: {
          name: 'plan-status',
          version: '1.0.0',
          contributes: {
            uiSlots: [
              { anchor: 'composer.above', id: 'a', label: 'A' },
              { anchor: 'composer.dock', id: 'b', label: 'B' },
            ],
          },
        },
      },
      loaded: true,
      commands: [],
    }])
    expect(plugin.contributes.uiSlots).toEqual([
      { anchor: 'composer.above', id: 'a', label: 'A', unsupported: false, lifetime: '', drawer: false, drawerIgnored: false, side: '', sideIgnored: false },
      { anchor: 'composer.dock', id: 'b', label: 'B', unsupported: true, lifetime: '', drawer: false, drawerIgnored: false, side: '', sideIgnored: false },
    ])
  })

  /**
   * F 期:drawer 是**声明门控**,且只在开了抽屉能力的锚点上算数。别的锚点上
   * 声明它 = 该字段被忽略并标记(不拒载)——与未知锚点同规。
   */
  it('drawer 只在 composer.above 上生效;别处声明被忽略并标记', () => {
    const [plugin] = projectOnethingPluginsForRenderer([{
      definition: {
        id: 'plan-status',
        source: 'user',
        enabled: true,
        dirPath: '/plugins/plan-status',
        manifest: {
          name: 'plan-status',
          version: '1.2.0',
          contributes: {
            uiSlots: [
              { anchor: 'composer.above', id: 'drawer', label: 'D', drawer: true },
              { anchor: 'composer.above', id: 'plain', label: 'P' },
              { anchor: 'chat.status-bar', id: 'nope', label: 'N', drawer: true },
              { anchor: 'message.footer', id: 'also-nope', label: 'M', drawer: true },
              { anchor: 'composer.dock', id: 'alien', label: 'X', drawer: true },
            ],
          },
        },
      },
      loaded: true,
      commands: [],
    }])
    expect(plugin.contributes.uiSlots.map(slot => [slot.id, slot.drawer, slot.drawerIgnored])).toEqual([
      ['drawer', true, false],
      ['plain', false, false],
      ['nope', false, true],
      ['also-nope', false, true],
      // 未知锚点更谈不上抽屉 —— 两条降级叠在一起,还是不拒载。
      ['alien', false, true],
    ])
  })

  it('lifetime 原样流出(不归一成布尔)—— 装前确认页据此披露持久内容', () => {
    const [plugin] = projectOnethingPluginsForRenderer([{
      definition: {
        id: 'tps-meter',
        source: 'user',
        enabled: true,
        dirPath: '/plugins/tps-meter',
        manifest: {
          name: 'tps-meter',
          version: '1.0.2',
          contributes: {
            uiSlots: [
              { anchor: 'message.footer', id: 'tps', label: 'TPS', lifetime: 'persistent' },
              { anchor: 'composer.above', id: 'hint', label: 'Hint', lifetime: 'ephemeral' },
              { anchor: 'composer.above', id: 'future', label: 'F', lifetime: 'synced' },
            ],
          },
        },
      },
      loaded: true,
      commands: [],
    }])
    expect(plugin.contributes.uiSlots.map(slot => slot.lifetime))
      .toEqual(['persistent', 'ephemeral', 'synced'])
  })
})
