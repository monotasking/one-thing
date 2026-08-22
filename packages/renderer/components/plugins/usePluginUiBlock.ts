/**
 * "一个可寻址的插件 UI 块"的共享内核(R5.x-c)。
 *
 * PluginPanelHost(工作区面板)与 UiSlotBlock(锚点块)是同一套渲染逻辑的
 * 两层壳:loading / error / degraded / tree 四态、latest-wins render token、
 * trailing debounce、请求通道调用、refresh 合流、树级轮询 —— 全部住在这里。
 * **抽壳不改语义**:既有 PluginPanelHost 的全部行为由它自己的测试钉住,
 * 重构期间那些测试必须一直绿。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { platformApi } from '@/platform'
import { pluginsApi } from '@/platform/plugins-client'
import { toast } from '@/composables/useToast'
import type { PluginPanelTreeData } from '@/workspace/plugin-panel-types'

export interface PluginUiBlockSource {
  pluginId: string
  /** render 的通道 action(`panel:render:<id>` / `ui:render:<anchor>:<id>`)。 */
  renderAction: string
  /** action 的通道 action。 */
  invokeAction: string
  /**
   * 通知轨上用于对号入座的 id:面板是 panelId,锚点块是 `ui:<anchor>:<id>`
   * 形式的 surface id。
   */
  notificationId: string
  /** render 的附加 payload(锚点块带 sessionId;会话切换时调用方重拉)。 */
  renderPayload?: () => Record<string, unknown> | undefined
  /**
   * 多实例去重(锚点块):同一块被主窗与浮层两个宿主同时拉时,后到的共享
   * 在飞的那一次。**面板不传** —— 面板是单实例,且它的最新胜出语义要求
   * 每次拉取都是真实请求。
   */
  shareInflight?: boolean
  /** 不拉取的条件(web 端、插件未加载)。 */
  enabled: boolean
}

/** 插件连打 refresh 时的合流窗口 —— main 侧已去重一层,这里兜住剩下的。 */
const REFRESH_DEBOUNCE_MS = 150

/**
 * 多实例去重:同一个块同时被两个宿主拉(主窗 + 浮层各挂一个 UiSlotHost)时,
 * 后到的拉取**共享**在飞的那一次,不重复打请求通道。
 * 键含 action 与 payload(sessionId 不同就是不同的请求)。
 */
const inflightRenders = new Map<string, Promise<Awaited<ReturnType<typeof pluginsApi.pluginRequest>>>>()

function sharedRenderRequest(input: {
  pluginId: string
  action: string
  payload?: Record<string, unknown>
  bypassDegraded?: boolean
}) {
  // bypassDegraded 是用户显式的"再试一次" —— 它必须真的再试,不共享在飞。
  if (input.bypassDegraded) return pluginsApi.pluginRequest(input)
  const key = `${input.action}::${JSON.stringify(input.payload ?? null)}`
  const existing = inflightRenders.get(key)
  if (existing) return existing
  const request = pluginsApi.pluginRequest(input)
  inflightRenders.set(key, request)
  // 用 then/catch 手动清,不用 finally:finally 返回新 promise,会把共享语义弄丢。
  request.then(
    () => inflightRenders.delete(key),
    () => inflightRenders.delete(key),
  )
  return request
}

/**
 * 把 payload 脱成纯数据再过线(历史教训:ref 的深层响应式会让 Electron 的
 * structured clone 直接 DataCloneError;JSON 往返同时保证两个传输面看到同一份)。
 */
function toPlainPayload(value: unknown): unknown {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

export function usePluginUiBlock(getSource: () => PluginUiBlockSource) {
  const tree = ref<PluginPanelTreeData | null>(null)
  const error = ref('')
  /** 这个块已被降级闸关掉(R7)。与普通错误分开呈现。 */
  const degraded = ref(false)
  const degradedReason = ref('')
  const loading = ref(false)

  /**
   * latest-wins 的判据:两次 render 并发时,先发的那次后到就会用旧树盖新树。
   * 每次发请求领一个号,只有最后领号的那次有资格写 tree/error。
   */
  let renderToken = 0

  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let hostVisible = true
  let visibilityObserver: IntersectionObserver | undefined

  function clearPoll(): void {
    clearTimeout(pollTimer)
    pollTimer = undefined
  }

  /** 每次成功拿到新树后调用一次:按新树的 refreshIntervalMs 重新武装下一轮。 */
  function armPoll(): void {
    clearPoll()
    const interval = tree.value?.refreshIntervalMs
    if (!interval || error.value || degraded.value || !hostVisible) return
    pollTimer = setTimeout(() => { void render() }, interval)
  }

  /**
   * render / action 都走 R2 的统一请求通道 —— 免费拿到 30s 预算、abort、以及
   * `request:<action>` 的熔断账。这里刻意不另起一套超时:两套超时语义迟早打架。
   */
  async function render(options: { bypassDegraded?: boolean } = {}): Promise<void> {
    const source = getSource()
    if (!source.enabled) return
    const token = ++renderToken
    loading.value = true
    error.value = ''
    try {
      const requestInput = {
        pluginId: source.pluginId,
        action: source.renderAction,
        ...(source.renderPayload ? { payload: source.renderPayload() } : {}),
        // 只有用户点"再试一次"才带 —— 自动重拉、通知触发的刷新都不带,
        // 否则降级闸形同虚设。
        ...(options.bypassDegraded ? { bypassDegraded: true } : {}),
      }
      const result = source.shareInflight
        ? await sharedRenderRequest(requestInput)
        : await pluginsApi.pluginRequest(requestInput)
      if (token !== renderToken) return
      if (result?.success) {
        tree.value = result.result as PluginPanelTreeData
        degraded.value = false
        degradedReason.value = ''
        armPoll()
      } else if (result?.degraded) {
        // 被闸短路:插件根本没被调用。
        degraded.value = true
        degradedReason.value = result.error || ''
        tree.value = null
        clearPoll()
      } else {
        error.value = result?.error || 'The plugin could not render this block.'
        clearPoll()
      }
    } catch (e: any) {
      if (token !== renderToken) return
      error.value = e?.message || 'The plugin could not render this block.'
    } finally {
      if (token === renderToken) loading.value = false
    }
  }

  /** 合流后的重拉 —— 通知触发的刷新都走它,不直接调 render。 */
  function scheduleRender(): void {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => { void render() }, REFRESH_DEBOUNCE_MS)
  }

  /**
   * 一次 action 的结局。
   *
   * 描述树的调用方(`@action="invoke"`)不看返回值 —— 树的更新已经在这里做完了。
   * webview 容器要看:iframe 那边在等一条 `result` 回帖,宿主必须把成功/失败
   * 原样带回去,而不是只弹个 toast 就算了(iframe 里的 await 会永远挂着)。
   */
  async function invoke(
    input: { actionId: string; payload?: unknown },
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const source = getSource()
    try {
      const result = await pluginsApi.pluginRequest({
        pluginId: source.pluginId,
        action: source.invokeAction,
        payload: { actionId: input.actionId, payload: toPlainPayload(input.payload) },
      })
      if (!result?.success) {
        if (result?.degraded) {
          degraded.value = true
          degradedReason.value = result.error || ''
          tree.value = null
          clearPoll()
          return { ok: false, error: result.error || 'This surface is switched off after repeated failures.' }
        }
        toast.error(result?.error || 'The plugin could not handle that action.')
        return { ok: false, error: result?.error || 'The plugin could not handle that action.' }
      }
      const outcome = (result.result ?? {}) as { refresh?: boolean; tree?: PluginPanelTreeData; notice?: string }
      if (outcome.notice) toast.info(outcome.notice)
      // 插件可以直接给新树(省一次往返),也可以只说"重拉一次"。
      // 直接给树也要领号,否则一次在飞的 render 回来会把它盖掉。
      if (outcome.tree) {
        renderToken += 1
        tree.value = outcome.tree
        error.value = ''
        armPoll()
      } else if (outcome.refresh) {
        // 用户刚点了按钮,这一次不 debounce —— 等 150ms 会显得没反应。
        await render()
      }
      return { ok: true, result: outcome }
    } catch (e: any) {
      toast.error(e?.message || 'The plugin could not handle that action.')
      return { ok: false, error: e?.message || 'The plugin could not handle that action.' }
    }
  }

  /**
   * 插件主动刷新:走既有的 plugin:notification 轨(kind = 'panel-refresh')。
   * 不另开一条投递轨。
   */
  let unsubscribe: (() => void) | undefined

  onMounted(() => {
    void render()
    unsubscribe = platformApi.onPluginNotification?.((payload: any) => {
      if (payload?.kind !== 'panel-refresh') return
      const source = getSource()
      if (payload.pluginId !== source.pluginId) return
      if (payload.panelId && payload.panelId !== source.notificationId) return
      scheduleRender()
    })
  })

  onBeforeUnmount(() => {
    unsubscribe?.()
    clearTimeout(refreshTimer)
    clearPoll()
    visibilityObserver?.disconnect()
  })

  /** 挂到宿主元素的可见性观察:不可见时轮询停摆,重新可见时按当前树重新武装。 */
  function observeVisibility(el: HTMLElement | null): void {
    visibilityObserver?.disconnect()
    if (typeof IntersectionObserver === 'undefined' || !el) return
    visibilityObserver = new IntersectionObserver(entries => {
      hostVisible = entries.some(entry => entry.isIntersecting)
      if (hostVisible) armPoll()
      else clearPoll()
    })
    visibilityObserver.observe(el)
  }

  return {
    tree,
    error,
    degraded,
    degradedReason,
    loading,
    render,
    invoke,
    observeVisibility,
  }
}
