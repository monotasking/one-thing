<template>
  <div class="plugin-webview-frame">
    <!-- 握手没回来 = 这一页没起来(协议 404 会渲染一张宿主的纯文本错误页,
         它不可能回握手)。iframe 是 opaque origin,宿主读不到它的 document,
         握手是唯一能"positively know"的信号。 -->
    <ErrorNote
      v-if="handshakeFailed"
      variant="block"
      :message="handshakeError"
    >
      <template #actions>
        <Button
          unstyled
          class="webview-retry"
          @click="reload"
        >
          Reload
        </Button>
      </template>
    </ErrorNote>

    <iframe
      v-else
      ref="frameEl"
      class="plugin-webview"
      :src="src"
      :title="`${panel.label} (${panel.pluginName})`"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      @load="onFrameLoad"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * webview 面板的容器(C2 / C4)。
 *
 * 三条约束决定了这个组件的形状:
 *  1. **iframe 是 opaque origin。** `sandbox="allow-scripts"` 不带
 *     `allow-same-origin`,于是 `event.origin` 是字符串 `"null"` ——
 *     校验 origin 等于没校验。宿主认的是 `event.source === contentWindow`
 *     **加上**一次性 token:前者挡别的 frame,后者挡同一 frame 的旧世代
 *     (面板切换/重载之后,上一代 iframe 迟到的消息必须被丢掉)。
 *     同理 postMessage 出去只能用 `targetOrigin: '*'` —— opaque origin 没有
 *     字符串写法,写别的等于永远发不出去。
 *  2. **加载失败宿主看不见。** 协议 404 会返回一张宿主自己的纯文本错误页,
 *     iframe 的 `load` 照常触发、`error` 不触发,而 document 读不到。
 *     于是判据是**握手**:页面必须在预算内回一条带 token 的消息。
 *     这条契约写进了插件作者指南(一段可拷贝的 vanilla JS)。
 *  3. **不新开通道。** invoke 走既有 `panel:action:<panelId>`(30s 预算 /
 *     abort / 熔断 / describeNonSerializable 全继承),refresh 走既有
 *     `plugin:notification` 的 `panel-refresh` 轨 —— 两者都由父组件的
 *     `usePluginUiBlock` 持有,这个组件只做桥接。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from '@/components/common/Button.vue'
import ErrorNote from '@/components/common/ErrorNote.vue'
import { toPlainData } from '@/workspace/plain-data'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.plugin-webview')
import {
  PLUGIN_WEBVIEW_MESSAGE,
  pluginWebviewEntryUrl,
  type PluginWorkspacePanel,
} from '@/workspace/plugin-panel-types'

const props = defineProps<{
  panel: PluginWorkspacePanel
  /** 初始化数据(父组件从 `panel:init:<id>` 拉来);纯静态面板为 null。 */
  initData: unknown
  /** 桥到既有 action 通道 —— 结果要原样回帖给 iframe。 */
  invoke(input: { actionId: string; payload?: unknown }): Promise<{ ok: boolean; result?: unknown; error?: string }>
}>()

/**
 * 握手预算。给得宽:插件页面可能要解析一份不小的初始化数据。
 * 超时不是"慢",是"这一页大概率根本没起来"。
 */
const HANDSHAKE_BUDGET_MS = 10_000

const frameEl = ref<HTMLIFrameElement | null>(null)
const handshakeFailed = ref(false)
const handshakeError = ref('')
/** 重载计数 —— 换它就换 src 的 query,强制 iframe 真的重新取一次。 */
const reloadNonce = ref(0)

const src = computed(() => {
  const url = pluginWebviewEntryUrl(props.panel.pluginId, props.panel.entry || '')
  return reloadNonce.value ? `${url}?r=${reloadNonce.value}` : url
})

/**
 * 一次性 token。**每一代 iframe 一个新的** —— 面板切换、重载都换,
 * 于是上一代的迟到消息拿的是作废的 token,静默丢弃。
 */
let token = ''
let handshakeTimer: ReturnType<typeof setTimeout> | undefined
let handshakeDone = false
/** 被丢弃的消息计数(伪造 token / 陌生 source)—— 只记账,不打扰用户。 */
let droppedMessages = 0

function newToken(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  // jsdom / 老宿主的兜底:token 的作用是"分辨世代",不是密钥学强度。
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function post(message: Record<string, unknown>): void {
  // 出境前脱掉 Vue 响应式外壳(边界铁律,统一走 toPlainData —— 这个病在
  // postMessage 与 IPC 两个边界各犯过一次,收口治本,见 plain-data.ts)。
  const plain = toPlainData({ ...message, token })
  // opaque origin 只能用 '*';身份靠 token,不靠 targetOrigin。
  frameEl.value?.contentWindow?.postMessage(plain, '*')
}

function armHandshake(): void {
  clearTimeout(handshakeTimer)
  handshakeDone = false
  handshakeTimer = setTimeout(() => {
    if (handshakeDone) return
    handshakeFailed.value = true
    handshakeError.value = `${props.panel.label} did not load. Check that "${props.panel.entry}" exists in `
      + `the plugin's webview folder and acknowledges the host handshake.`
  }, HANDSHAKE_BUDGET_MS)
}

function onFrameLoad(): void {
  // 首帧握手:token 与初始化数据一起过去,iframe 不必再往返一次要数据。
  post({ type: PLUGIN_WEBVIEW_MESSAGE.init, data: props.initData ?? null })
}

function reload(): void {
  handshakeFailed.value = false
  handshakeError.value = ''
  token = newToken()
  reloadNonce.value += 1
  armHandshake()
}

async function handleInvoke(payload: { requestId?: unknown; actionId?: unknown; payload?: unknown }): Promise<void> {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const actionId = typeof payload.actionId === 'string' ? payload.actionId : ''
  if (!actionId) {
    post({ type: PLUGIN_WEBVIEW_MESSAGE.result, requestId, error: 'invoke needs an actionId' })
    return
  }
  const outcome = await props.invoke({ actionId, payload: payload.payload })
  post({
    type: PLUGIN_WEBVIEW_MESSAGE.result,
    requestId,
    ...(outcome.ok ? { result: outcome.result ?? null } : { error: outcome.error || 'The action failed' }),
  })
}

function onMessage(event: MessageEvent): void {
  const frame = frameEl.value
  // 两道闸,缺一不可:source 挡"别的 frame 冒充",token 挡"同一 frame 的旧世代"。
  if (!frame || event.source !== frame.contentWindow) return
  const data = event.data as { token?: unknown; type?: unknown } | null
  if (!data || typeof data !== 'object') return
  if (!token || data.token !== token) {
    droppedMessages += 1
    // 一条一条打日志会被恶意页面刷屏;只在第一条与每 100 条时说一次。
    if (droppedMessages === 1 || droppedMessages % 100 === 0) {
      log.warn('dropped webview messages without a valid token', {
        dropped: droppedMessages,
        pluginId: props.panel.pluginId,
        panelId: props.panel.panelId,
      })
    }
    return
  }

  handshakeDone = true
  clearTimeout(handshakeTimer)
  handshakeFailed.value = false

  if (data.type === PLUGIN_WEBVIEW_MESSAGE.invoke) {
    void handleInvoke(event.data as Record<string, unknown>)
  }
  // ready 只用来解除握手看门狗 —— 上面已经做了,这里没有别的动作。
}

onMounted(() => {
  token = newToken()
  window.addEventListener('message', onMessage)
  armHandshake()
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  clearTimeout(handshakeTimer)
  // token 作废:即使有一条消息已经在事件队列里,它也拿不到有效的世代号。
  token = ''
})

// 初始化数据变了(插件调了 ctx.refresh(),父组件重拉之后推来)= 推一条 refresh。
// **不重载 iframe**:重载会把页面里的滚动位置、输入状态全丢掉,而这是一次
// 数据更新,不是一次导航。
watch(() => props.initData, value => {
  if (!handshakeDone) return
  post({ type: PLUGIN_WEBVIEW_MESSAGE.refresh, data: value ?? null })
})

// 切到另一个 webview 面板:换世代、重新武装看门狗。
watch(() => `${props.panel.pluginId}:${props.panel.panelId}`, () => {
  handshakeFailed.value = false
  handshakeError.value = ''
  token = newToken()
  armHandshake()
})
</script>

<style scoped>
.plugin-webview-frame {
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.plugin-webview {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
}

.webview-retry {
  display: inline-flex;
  align-items: center;
  margin-top: 8px;
  padding: 3px 10px;
  border: 1px solid var(--ui-border-default-border);
  border-radius: 0;
  background: transparent;
  color: var(--ui-text-secondary-fg, var(--ui-text-primary-fg));
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  cursor: pointer;
}
</style>
