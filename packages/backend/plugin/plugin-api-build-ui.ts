/**
 * 插件 API 的界面面:工作区面板、锚点块、命名空间事件、流状态、背景层调参,以及 `ui`(通知与两个布局动词,共用 `runLayoutVerb` 那一道闸)。
 *
 * 从 `plugin-api-builder.ts` 按面拆出(大文件拆分批 2,2026-10-04):每一格的方法正文与拆分前一字不差,
 * 从前读闭包变量的地方,现在读开头从上下文(`plugin-api-context.ts`)解构出来的同名局部量。
 * 键的顺序不在这里定 —— `createCorePluginAPI` 按拆分前那只对象字面量的顺序拼。
 */
import {
  clampPluginBackgroundParamsPatch,
  describePluginRuntimeBackgroundImageProblem,
  type PluginBackgroundParamsPatch,
  PLUGIN_PANEL_INIT_ACTION,
  PLUGIN_PANEL_INVOKE_ACTION,
  PLUGIN_PANEL_RENDER_ACTION,
  type CorePluginPanelContext,
  type CorePluginPanelRegistration,
  PLUGIN_LAYOUT_GESTURE_WINDOW_MS,
  PLUGIN_UI_INVOKE_ACTION,
  PLUGIN_UI_RENDER_ACTION,
  hasFreshUiActionGesture,
  isUiAnchor,
  isUiDrawerRenderState,
  noteUiActionGesture,
  uiSlotAddress,
  uiSlotSurfaceId,
  type CorePluginUiSlotContext,
  type CorePluginUiSlotRegistration,
  type PluginLayoutResult,
  type PluginLayoutVerb,
  pluginScope,
  assertPluginPayloadSerializable,
  type CorePluginRequestContext,
} from '@onething/backend/plugin-contract'
import {
  PLUGIN_NOTIFY_SOUNDS,
  normalizePluginNotifySound,
  type PluginNotifyOptions,
} from '@shared/plugins/notify-sound.js'
import type { CorePluginAPITypeArgs, PluginApiBuildContext } from './plugin-api-context.js'

export function buildPluginApiUi<T extends CorePluginAPITypeArgs>(ctx: PluginApiBuildContext<T>) {
  const { pluginId, options, host, logger, requestHandlers, reportFailure, rejectLateCall } = ctx

  /**
   * 布局动词的**唯一**闸(I 期)。
   *
   * 三条判据按代价排序,全部是**规则拒绝**,一条都不计熔断 ——
   * 与声明门同规:插件没坏,是规则不让它这么干。
   *
   *  1. 拆除之后的晚到调用:静默丢(rejectLateCall 已经记过一条日志);
   *  2. 宿主没接这条线(CLI daemon / headless server 没有窗口):`unsupported`;
   *  3. 不在手势窗口里:`gesture-required`。
   *
   * 治理为什么是手势而不是 manifest 权限:一句"我要能开合侧栏"用户读不出
   * 它会在**什么时候**动;而"你刚点了它、它才动得了"是用户当场就能验证的
   * 因果 —— 把授权从一次性的申报挪到每一次的互动。
   */
  async function runLayoutVerb(
    verb: PluginLayoutVerb,
    panelId?: string,
  ): Promise<PluginLayoutResult> {
    if (rejectLateCall(`ui.${verb}`)) {
      return { ok: false, error: 'unsupported', reason: 'plugin was torn down' }
    }
    if (!host.applyLayoutVerb) {
      return { ok: false, error: 'unsupported', reason: 'this host has no window layout' }
    }
    if (!hasFreshUiActionGesture(pluginId)) {
      logger.error(
        `[Plugin:${pluginId}] ui.${verb} was refused: layout verbs only work within `
        + `${PLUGIN_LAYOUT_GESTURE_WINDOW_MS}ms of the user interacting with one of your `
        + 'ui slots (gesture anchoring). Call it from a ui slot onAction, not on a timer.',
        undefined,
      )
      return {
        ok: false,
        error: 'gesture-required',
        reason: `no user gesture on this plugin within ${PLUGIN_LAYOUT_GESTURE_WINDOW_MS}ms`,
      }
    }
    try {
      host.applyLayoutVerb(pluginId, verb, panelId)
      return { ok: true }
    } catch (error) {
      // 投递失败是**宿主侧**的故障,不是规则拒绝 —— 但也不该炸掉插件:
      // 与 notify 同规,记一条日志、回一份失败结果。
      logger.error(`[Plugin:${pluginId}] ui.${verb} failed:`, undefined, error)
      return { ok: false, error: 'unsupported', reason: 'host refused the layout command' }
    }
  }

  return {
    /**
     * 面板注册 —— 只绑行为,不带存在感。
     *
     * id 必须匹配 manifest 的 contributes.panels:不匹配就报错而不是默默注册一个
     * 谁也进不去的面板(插件侧那句"注册成功了"是最难查的一类假象)。
     * 落地方式是把 render/onAction 挂到统一请求通道上 —— 于是它们免费拿到
     * R2 的超时预算、abort、progress 与 `request:<action>` 熔断账,不另起一套。
     */
    registerWorkspacePanel(registration: CorePluginPanelRegistration): void {
      if (rejectLateCall('registerWorkspacePanel')) return
      const panelId = String(registration?.id ?? '').trim()
      if (!panelId) {
        logger.error(`[Plugin:${pluginId}] registerWorkspacePanel needs an id`, undefined)
        return
      }
      const declared = options.declaredPanelIds ?? []
      if (!declared.includes(panelId)) {
        logger.error(
          `[Plugin:${pluginId}] registerWorkspacePanel("${panelId}") does not match any panel declared in `
          + `contributes.panels (declared: ${declared.length ? declared.join(', ') : 'none'}). `
          + 'Declare it in plugin.json first — the host renders the entry from the manifest.',
          undefined,
        )
        reportFailure(pluginScope.registration('WorkspacePanel'), new Error(`undeclared panel "${panelId}"`))
        return
      }
      if (typeof registration.render !== 'function') {
        logger.error(`[Plugin:${pluginId}] registerWorkspacePanel("${panelId}") needs a render function`, undefined)
        return
      }
      /*
       * webview 面板的 render 挂在**另一个 action 名**上(C 期)。
       *
       * 插件侧的写法不变(还是 `registerWorkspacePanel({ id, render, onAction })`),
       * 变的是 render 的**返回值契约**:webview 面板的内容由静态文件提供,
       * render 交出的是给 iframe 的初始化数据(任意可序列化 JSON),宿主不解释它。
       * 换个 action 名,通道守卫按前缀就知道该用哪套校验 —— 不必反查"这个面板
       * 是哪一种",也就不会有那份反查漂移之后的两类事故。
       *
       * **零代码的纯静态面板是合法的**:manifest 声明 view+entry 就够,
       * 插件完全可以不调 registerWorkspacePanel —— 声明先于代码,宿主凭清单
       * 就能把 iframe 挂起来(renderer 据 requestActions 判断有没有初始化数据可拉)。
       */
      const renderAction = (options.declaredWebviewPanelIds ?? []).includes(panelId)
        ? PLUGIN_PANEL_INIT_ACTION
        : PLUGIN_PANEL_RENDER_ACTION

      // 同一个 id 注册两次:静默覆盖会让"我明明注册了"与"点开是另一个面板"
      // 同时成立,这是最难查的一类。清单里一个 id 就是一个面板,重复即错。
      if (requestHandlers.has(`${renderAction}:${panelId}`)) {
        logger.error(
          `[Plugin:${pluginId}] registerWorkspacePanel("${panelId}") was already registered; `
          + 'one manifest panel id binds exactly one implementation.',
          undefined,
        )
        reportFailure(pluginScope.registration('WorkspacePanel'), new Error(`duplicate panel "${panelId}"`))
        return
      }

      const panelContext = (ctx: CorePluginRequestContext): CorePluginPanelContext => ({
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
        // 主动刷新走**通知通道**而不是 progress:progress 只在请求在飞期间有效
        // (R2 已裁决 abort/settle 之后一律丢弃),而真实的刷新几乎都发生在
        // 请求之外(日志文件变了、定时器到点了)。复用既有通知轨,不另开一条
        // (§5.2 第 4 条:R5 需要投递面时用现成的)。
        refresh: () => host.emitPanelRefresh?.(pluginId, panelId),
      })

      // 形状校验不在这里做:通道层(manager.handleRequest)对所有 panel:* 结果
      // 统一执行,包装可以被绕开而通道不能。这里只做包装自己的事。
      requestHandlers.set(`${renderAction}:${panelId}`, (_payload, ctx) =>
        registration.render(panelContext(ctx)))

      requestHandlers.set(`${PLUGIN_PANEL_INVOKE_ACTION}:${panelId}`, async (payload, ctx) => {
        if (!registration.onAction) return { refresh: false }
        const input = (payload ?? {}) as { actionId?: unknown; payload?: unknown }
        const actionId = String(input.actionId ?? '')
        if (!actionId) throw new Error(`Panel "${panelId}" received an action without an actionId`)
        const result = await registration.onAction({ actionId, payload: input.payload }, panelContext(ctx))
        return result ?? { refresh: false }
      })

      logger.debug(`[Plugin:${pluginId}] Registered workspace panel: ${panelId}`)
    },

    /**
     * 锚点块注册(R5.x)—— 与 registerWorkspacePanel 同构,只绑行为。
     *
     * (anchor, id) 必须匹配 manifest 的 contributes.uiSlots;render 返回的是同一套
     * 描述树协议(块只是"小面板",协议不因位置而分叉)。落地方式同样是把
     * render/onAction 挂到统一请求通道上(`ui:render:<anchor>:<id>` /
     * `ui:action:<anchor>:<id>`),免费继承超时预算、abort、progress 与熔断账。
     */
    registerUiSlot(registration: CorePluginUiSlotRegistration): void {
      if (rejectLateCall('registerUiSlot')) return
      const slotAnchor = String(registration?.anchor ?? '').trim()
      const slotId = String(registration?.id ?? '').trim()
      if (!slotAnchor || !slotId) {
        logger.error(`[Plugin:${pluginId}] registerUiSlot needs an anchor and an id`, undefined)
        return
      }
      // 未知锚点在这里是**代码错误**(与 manifest 层的"降级为 unsupported"不同:
      // 到了注册期,插件在代码里指名道姓要一个宿主没有的位置,没有歧义可容)。
      if (!isUiAnchor(slotAnchor)) {
        logger.error(
          `[Plugin:${pluginId}] registerUiSlot("${slotAnchor}") is refused: unknown anchor. `
          + 'Anchors are a host-defined set (UI_ANCHORS); a plugin cannot invent one.',
          undefined,
        )
        reportFailure(pluginScope.registration('UiSlot'), new Error(`unknown anchor "${slotAnchor}"`))
        return
      }
      const declared = options.declaredUiSlots ?? []
      if (!declared.some(slot => slot.anchor === slotAnchor && slot.id === slotId)) {
        logger.error(
          `[Plugin:${pluginId}] registerUiSlot("${slotId}") does not match any ui slot declared in `
          + `contributes.uiSlots for anchor "${slotAnchor}" (declared: ${
            declared.length ? declared.map(slot => `${slot.anchor}/${slot.id}`).join(', ') : 'none'
          }). Declare it in plugin.json first — the host renders the block from the manifest.`,
          undefined,
        )
        reportFailure(pluginScope.registration('UiSlot'), new Error(`undeclared ui slot "${slotId}"`))
        return
      }
      if (typeof registration.render !== 'function') {
        logger.error(`[Plugin:${pluginId}] registerUiSlot("${slotId}") needs a render function`, undefined)
        return
      }
      const address = uiSlotAddress(slotAnchor, slotId)
      if (requestHandlers.has(`${PLUGIN_UI_RENDER_ACTION}:${address}`)) {
        logger.error(
          `[Plugin:${pluginId}] registerUiSlot("${slotId}") was already registered; `
          + 'one manifest ui slot id binds exactly one implementation.',
          undefined,
        )
        reportFailure(pluginScope.registration('UiSlot'), new Error(`duplicate ui slot "${slotId}"`))
        return
      }

      const slotContext = (ctx: CorePluginRequestContext): CorePluginUiSlotContext => ({
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
        // 与面板同一条通知轨:panelId 字段带 `ui:<anchor>:<id>` 形式的 surface id,
        // renderer 按它与块对号入座。
        refresh: () => host.emitPanelRefresh?.(pluginId, uiSlotSurfaceId(slotAnchor, slotId)),
        anchor: slotAnchor,
        sessionId: null,
      })
      /** sessionId 由调用方(renderer)随 payload 传入 —— 宿主在会话切换时重拉。 */
      const withSession = (base: CorePluginUiSlotContext, payload: unknown): CorePluginUiSlotContext => {
        const raw = (payload as { sessionId?: unknown } | undefined)?.sessionId
        // messageId 同理(消息级锚点):宿主按消息实例挂载时随 payload 传入,
        // 会话级锚点不带这个字段。
        const rawMessageId = (payload as { messageId?: unknown } | undefined)?.messageId
        // drawerState 同理(抽屉块,F 期):宿主按当前档随 payload 传入,插件
        // 据此返回不同的树。只认会渲染的两档 —— 'collapsed' 与任何未知值都
        // 读成"不带这个字段",非抽屉块看到的 ctx 一字不变(append-only)。
        const rawDrawerState = (payload as { drawerState?: unknown } | undefined)?.drawerState
        return {
          ...base,
          sessionId: typeof raw === 'string' && raw ? raw : null,
          ...(typeof rawMessageId === 'string' && rawMessageId ? { messageId: rawMessageId } : {}),
          ...(isUiDrawerRenderState(rawDrawerState) ? { drawerState: rawDrawerState } : {}),
        }
      }

      requestHandlers.set(`${PLUGIN_UI_RENDER_ACTION}:${address}`, (payload, ctx) =>
        registration.render(withSession(slotContext(ctx), payload)))

      requestHandlers.set(`${PLUGIN_UI_INVOKE_ACTION}:${address}`, async (payload, ctx) => {
        // **手势锚定的记账点**(I 期):宿主把一次用户点击派发给了这个插件。
        // 记在 onAction 之前,插件才能在 onAction 里同步地请求布局动词。
        // 记的是"用户刚刚在跟这个插件互动",不是"哪一次互动" —— 因此
        // 连没登记 onAction 的块也照记:用户确实点了它。
        noteUiActionGesture(pluginId)
        if (!registration.onAction) return { refresh: false }
        const input = (payload ?? {}) as { actionId?: unknown; payload?: unknown }
        const actionId = String(input.actionId ?? '')
        if (!actionId) throw new Error(`Ui slot "${slotId}" received an action without an actionId`)
        const result = await registration.onAction(
          { actionId, payload: input.payload },
          withSession(slotContext(ctx), payload),
        )
        return result ?? { refresh: false }
      })

      logger.debug(`[Plugin:${pluginId}] Registered ui slot: ${address}`)
    },

    events: {
      /**
       * 发一条命名空间事件。投递名 = `plugin:<pluginId>:<name>`,
       * 任何插件都能用 api.on 订阅它。payload 过线,必须 JSON-可序列化。
       */
      emit(eventName: string, payload?: unknown): void {
        if (rejectLateCall('events.emit')) return
        const name = String(eventName || '').trim()
        if (!name) {
          logger.error(`[Plugin:${pluginId}] events.emit needs a non-empty event name`, undefined)
          return
        }
        try {
          assertPluginPayloadSerializable(payload, `plugin event "${name}" payload`)
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] events.emit rejected:`, undefined, error)
          reportFailure(pluginScope.eventEmit(name), error)
          return
        }
        try {
          host.emitPluginEvent?.(pluginId, name, payload)
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] events.emit failed:`, undefined, error)
          reportFailure(pluginScope.eventEmit(name), error)
        }
      },
    },

    /**
     * 流状态(R6)。
     *
     * 纳入 disposed 闩:插件被拆除之后再 show 一条状态,等于在一个没人再会来
     * 清扫的账上挂东西 —— 停用之后气泡里多出一个永远转圈的指示器,而它的主人
     * 已经不在了。
     */
    status: {
      show(sessionId: string, status: { id: string; label: string }): void {
        if (rejectLateCall('status.show')) return
        const registry = options.statusRegistry
        if (!registry) return
        // 地址与账本键用**同一份** trim 过的值:一边 trim 一边不 trim 的话,
        // 状态会 show 到一个地址、clear 到另一个,谁也撤不下来。
        const address = String(sessionId ?? '').trim()
        const part = registry.show({
          pluginId,
          sessionId: address,
          id: String(status?.id ?? ''),
          label: String(status?.label ?? ''),
        })
        // null 表示"不必投递":被拒(不合法/不在流内/超配额)或纯粹没变化(频控)。
        // 一律不抛 —— 一个写错 label 的插件不该让它正在跑的那次调用失败。
        if (!part) {
          // 被合并窗压住的变化要让宿主排一次补发,否则最终状态会丢。
          host.notePluginStatusPending?.()
          return
        }
        host.emitPluginStatus?.(pluginId, address, part)
      },
      clear(sessionId: string, id: string): void {
        if (rejectLateCall('status.clear')) return
        const registry = options.statusRegistry
        if (!registry) return
        const address = String(sessionId ?? '').trim()
        const part = registry.clear({ pluginId, sessionId: address, id: String(id ?? '') })
        if (!part) return
        host.emitPluginStatus?.(pluginId, address, part)
      },
    },

    /**
     * 外观面(G 期,L2.5)。今天只有背景层这一格。
     *
     * 三道闸,顺序有意义:
     *  1. **拆除闩** —— 停用之后再调,等于往一张已经撤掉的层上写参数;
     *  2. **声明门** —— manifest 没声明 background 就没有可调的东西。记一条 error
     *     日志然后拒绝,**不计熔断**:开一个熔断面意味着一次笔误能连坐整个插件,
     *     而这条调用本身没有任何副作用可言(与未声明的 panel id 不同 —— 那个会
     *     留下一个画不出来的入口);
     *  3. **图源门**(B 期,用户壁纸)—— `image` 只收 `storage:` 寻址。非法
     *     图源**拒掉整条调用**而不是丢一个字段:插件明说了"把背景换成这张",
     *     半条命令(换了透明度没换图)比什么也不做更难解释。同样不计熔断 ——
     *     它是作者写错了寻址,与未声明 background 同规;
     *  4. **钳制** —— 越界数字钳进区间、未知 fit 忽略。用户拖滑杆的结果不该
     *     把控件卡住。
     */
    theme: {
      updateBackground(patch: PluginBackgroundParamsPatch): void {
        if (rejectLateCall('theme.updateBackground')) return
        if (!options.declaredBackground) {
          logger.error(
            `[Plugin:${pluginId}] theme.updateBackground requires contributes.theme.background in plugin.json`,
            undefined,
          )
          return
        }
        const requestedImage = (patch as { image?: unknown } | null | undefined)?.image
        // `null` 是**撤回**,不是一个坏图源:它绕过图源门(没有图可判),
        // 背景回落 manifest 声明的缺省图(darkImage 一并恢复)。
        // `undefined` 仍然是"这次不动 image" —— 两者不能合流,否则一个漏写的
        // 可选字段会静默把用户选的壁纸撤掉。
        if (requestedImage !== undefined && requestedImage !== null) {
          const problem = describePluginRuntimeBackgroundImageProblem(requestedImage)
          if (problem) {
            logger.error(`[Plugin:${pluginId}] theme.updateBackground rejected: ${problem}`, undefined)
            return
          }
        }
        const clamped = clampPluginBackgroundParamsPatch(patch)
        // 空补丁不广播:插件传了一堆非法值,等于什么也没说。
        if (!Object.keys(clamped).length) return
        try {
          host.updatePluginBackground?.(pluginId, clamped)
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] theme.updateBackground failed:`, undefined, error)
        }
      },
    },

    ui: {
      /**
       * 静默横幅 + 可选提示音(M1)。
       *
       * 第二参有两种长相,**加法而不是改法**:
       * - `notify(msg)` / `notify(msg, 'warn')` —— 老签名,逐字节等价于从前(不出声);
       * - `notify(msg, { level: 'warn', sound: 'chime' })` —— 新形态。
       *
       * sound 缺省 `'none'`;名字不在 `PLUGIN_NOTIFY_SOUNDS` 里就降级 none 并记一条
       * 日志(不抛错 —— 一个错音名不该把这条通知整个打掉)。真正决定响不响的是
       * 宿主:静音开关与限频闸都在装配层,core 这里只做形状归一。
       */
      notify(message: string, levelOrOptions: 'info' | 'warn' | 'error' | PluginNotifyOptions = 'info'): void {
        if (rejectLateCall('ui.notify')) return
        const isOptions = typeof levelOrOptions === 'object' && levelOrOptions !== null
        const level = (isOptions ? levelOrOptions.level : levelOrOptions) ?? 'info'
        const normalized = normalizePluginNotifySound(isOptions ? levelOrOptions.sound : undefined)
        if (normalized.unknown) {
          logger.error(
            `[Plugin:${pluginId}] ui.notify: unknown sound ${JSON.stringify(
              (levelOrOptions as PluginNotifyOptions).sound,
            )} — falling back to silence. Allowed: ${PLUGIN_NOTIFY_SOUNDS.join(', ')}`,
          )
        }
        try {
          host.notify(pluginId, message, level, normalized.sound)
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] notify error:`, undefined, error)
        }
      },

      /**
       * 布局动词(I 期)。两个动词共用一条闸,闸在 `runLayoutVerb` 里 ——
       * 两处各写一遍判据就是两份口径的开始。
       */
      toggleSidebar(): Promise<PluginLayoutResult> {
        return runLayoutVerb('toggle-sidebar')
      },
      openWorkbench(panelId?: string): Promise<PluginLayoutResult> {
        const target = String(panelId ?? '').trim()
        return runLayoutVerb('open-workbench', target || undefined)
      },
    },
  }
}
