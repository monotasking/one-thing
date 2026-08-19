<template>
  <!-- 全窗氛围层(G2)。position:fixed + inset:0 + pointer-events:none —— 纯视觉,
       点击**穿透**到真 UI(这是对"画假 UI 诱导点击"的结构性封堵)。z 位插在
       内容层与浮层之间(--z-ambient = 50):雪飘在消息/输入框上方,但在下拉/
       菜单/对话框/权限账页/tooltip 之下。 -->
  <div class="plugin-ambient-layer">
    <iframe
      ref="frameEl"
      class="plugin-ambient-frame"
      :src="src"
      title="Plugin ambient effects"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      aria-hidden="true"
      tabindex="-1"
      @load="onFrameLoad"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 氛围层容器(G2 —— 全窗动画覆盖)。
 *
 * webview 的**第三个住址**(面板 → 围栏 → 全窗覆盖)。它复用 C 期 webview
 * 面板那一整套安全面(独立 origin + CSP + postMessage + 一次性 token 握手 ——
 * 见 `PluginWebviewFrame.vue`),只有三处不同:
 *
 *  1. **挂载位置与 z 位**:全窗、`pointer-events:none`、`--z-ambient`(内容之上、
 *     每一层可交互浮层之下)。
 *  2. **消息集**:氛围层是纯视觉,没有 invoke/result(它永远不回调宿主),多了
 *     `vocabulary`(地标词表,握手后一次)、`geometry`(枚举地标矩形)与
 *     `pause`/`resume`(窗口失焦/隐藏即停)。
 *  3. **失败静默**:氛围是装饰,握手不回来就当它没有 —— 不弹错误页(那是内容
 *     面板才需要的),只在控制台留一句。
 *
 * **性能红线(透明窗丢帧判例在案 —— project_transparent_window_jank)**:
 * 动画全在 iframe 自己的 rAF,宿主一帧都不掺和。宿主只做两件轻活:窗口失焦/隐藏
 * 时推 `pause`(让 iframe 停 rAF),以及在 resize/布局变化时**节流**推几何
 * (rAF 合并,不是每帧)。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PLUGIN_AMBIENT_ANCHORS, PLUGIN_AMBIENT_MESSAGE } from '@/workspace/plugin-panel-types'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.plugin-ambient')

const props = defineProps<{
  /** `onething-plugin://<id>/<entry>` —— 胜出氛围层的入口(裁决已在主进程做完)。 */
  entryUrl: string
}>()

/**
 * 宿主枚举的几何地标(词表在 `@/workspace/plugin-panel-types`,append-only)。
 * 地标靠 `data-ambient-anchor` 显式标注,**不暴露任意 DOM** —— 插件拿到的只有
 * 这几块矩形 + 词表里的 kind/cardinality。
 *
 * 键序即测量序,surfaces 数组按它出场。
 */
const AMBIENT_ANCHOR_ENTRIES = Object.entries(PLUGIN_AMBIENT_ANCHORS)

/**
 * 握手预算。给得宽:iframe 要起 canvas、建粒子系统。超时不是"慢",是"这一页
 * 大概率没起来" —— 装饰层里这只意味着"这次没有氛围",静默即可。
 */
const HANDSHAKE_BUDGET_MS = 10_000

const frameEl = ref<HTMLIFrameElement | null>(null)
const reloadNonce = ref(0)

const src = computed(() => {
  const url = props.entryUrl
  return reloadNonce.value ? `${url}?r=${reloadNonce.value}` : url
})

/** 一次性 token —— 每一代 iframe 一个新的(换 entry / 重载都换)。 */
let token = ''
let handshakeTimer: ReturnType<typeof setTimeout> | undefined
let handshakeDone = false
/** 当前是否应当运行(窗口可见且聚焦)。失焦/隐藏 → false → 推 pause。 */
let running = true
let rafHandle = 0
let resizeObserver: ResizeObserver | null = null
/** 此刻被 ResizeObserver 盯着的地标元素集合(每次测量后 diff 重对准)。 */
let observedAnchors = new Set<Element>()
let mutationObserver: MutationObserver | null = null
/** 本代 iframe 是否已经收到过词表(静态表只发一次)。 */
let vocabularySent = false

function newToken(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function post(message: Record<string, unknown>): void {
  // opaque origin 只能用 '*';身份靠 token,不靠 targetOrigin(与 webview 同规)。
  frameEl.value?.contentWindow?.postMessage({ ...message, token }, '*')
}

type AmbientRect = Record<string, number>

interface AmbientSurface {
  name: string
  /** 同名多实例的序号(按文档序);singleton 恒为 0。 */
  index: number
  rect: AmbientRect
}

/** 读取一个元素的视口矩形。iframe 全窗定位,视口坐标即 canvas 坐标。 */
function readRect(el: Element): AmbientRect | null {
  const r = el.getBoundingClientRect()
  // 零尺寸(v-show 关掉、`:empty` 自隐时可能出现)= 不在场,当作没有。
  if (r.width <= 0 || r.height <= 0) return null
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
}

/**
 * 扫一遍词表,量出此刻在场的全部地标。
 *
 * - `anchors`:**只承载 singleton**(v1 的 map 语义一字不改,null = 离场);
 * - `surfaces`:所有在场地标(含 singleton),**在列即在场,离场即缺席** ——
 *   数组天然表达进出场,不需要 null 占位;
 * - `present`:这一轮在场的元素,交给 ResizeObserver 重对准。
 */
function collectGeometry(): { anchors: Record<string, AmbientRect | null>; surfaces: AmbientSurface[]; present: Element[] } {
  const anchors: Record<string, AmbientRect | null> = {}
  const surfaces: AmbientSurface[] = []
  const present: Element[] = []

  for (const [name, spec] of AMBIENT_ANCHOR_ENTRIES) {
    const selector = `[data-ambient-anchor="${name}"]`
    if (spec.cardinality === 'singleton') {
      // 取**第一个在场的**那一个,而不是第一个匹配的:分屏/多房面时 DOM 里
      // 可能同时挂着几份(非活动的那份 v-show 关着、矩形为零),死取第一个会
      // 把"有一个活着的输入框"报成离场。
      let hit: { el: Element; rect: AmbientRect } | null = null
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const rect = readRect(el)
        if (!rect) continue
        hit = { el, rect }
        break
      }
      anchors[name] = hit?.rect ?? null
      if (hit) {
        present.push(hit.el)
        surfaces.push({ name, index: 0, rect: hit.rect })
      }
      continue
    }
    let index = 0
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const rect = readRect(el)
      if (!rect) continue
      present.push(el)
      surfaces.push({ name, index, rect })
      index += 1
    }
  }

  return { anchors, surfaces, present }
}

/** 立刻测量并推一次几何(枚举地标 + viewport)。 */
function measure(): void {
  if (!handshakeDone) return
  const { anchors, surfaces, present } = collectGeometry()
  post({
    type: PLUGIN_AMBIENT_MESSAGE.geometry,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    // v1 字段照发:snow 1.0 一行不改照跑(兼容责任在宿主,设计文档 §8)。
    composerRect: anchors.composer,
    anchors,
    // v2:同名多实例装得下的那一份。
    surfaces,
  })
  syncObservation(present)
}

/** rAF 合并的节流测量 —— resize/布局变化时调它,不是每帧。 */
function scheduleMeasure(): void {
  if (rafHandle) return
  const raf = window.requestAnimationFrame ?? ((cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 16))
  rafHandle = raf(() => {
    rafHandle = 0
    measure()
  })
}

/**
 * 地标元素会随会话切换 / chip 出没换人 —— 观察集合每轮 diff 重对准
 * (v1 "只盯一个 composer" 的泛化版)。
 */
function syncObservation(present: readonly Element[]): void {
  if (!resizeObserver) return
  const next = new Set(present)
  for (const el of observedAnchors) {
    if (!next.has(el)) resizeObserver.unobserve(el)
  }
  for (const el of next) {
    if (!observedAnchors.has(el)) resizeObserver.observe(el)
  }
  observedAnchors = next
}

/**
 * 进出场侦测:chip / 块 v-if 掉的那一刻,旧元素的 ResizeObserver 不会响
 * (它是被删掉,不是变尺寸)。
 *
 * MO 必须常驻 `document.body`,不能挂在 composer 容器上 —— 那个方案有两个
 * 对称的洞,真机双双踩中(2026-08-10):空态启动时容器不存在,MO 无处可挂,
 * 之后新建会话、composer 挂载,**没有任何信号触发重测**,surfaces 永远停在
 * 空态那帧(雪只认窗底);反向同理,容器卸载发生在它父节点的 childList 上,
 * 挂在容器自己身上的 MO 看不见,surfaces 滞留成死矩形。body 上 childList+
 * subtree 常驻,两个方向都看得见;回调过滤掉纯文本变更(流式输出的字符增量
 * 不必触发),元素级变更才汇进 rAF 合并的测量 —— querySelectorAll 只返回
 * 在文档里的元素,重测一次即归位。
 */
function hasElementMutation(mutations: MutationRecord[]): boolean {
  for (const mutation of mutations) {
    for (const list of [mutation.addedNodes, mutation.removedNodes]) {
      for (const node of list) {
        if (node.nodeType === 1) return true
      }
    }
  }
  return false
}

function armHandshake(): void {
  clearTimeout(handshakeTimer)
  handshakeDone = false
  handshakeTimer = setTimeout(() => {
    if (handshakeDone) return
    // 装饰层:握手没回来就当它没有,不打扰用户。
    log.warn('ambient page did not acknowledge the handshake, no effects shown')
  }, HANDSHAKE_BUDGET_MS)
}

function onFrameLoad(): void {
  post({ type: PLUGIN_AMBIENT_MESSAGE.init })
}

function setRunning(next: boolean): void {
  if (running === next) return
  running = next
  if (!handshakeDone) return
  post({ type: next ? PLUGIN_AMBIENT_MESSAGE.resume : PLUGIN_AMBIENT_MESSAGE.pause })
}

/** 窗口是否此刻该跑动画:可见即可(聚焦与否不影响可见性下的观感)。 */
function computeRunning(): boolean {
  return document.visibilityState !== 'hidden'
}

function onVisibility(): void {
  setRunning(computeRunning())
}
function onWindowBlur(): void {
  // 失焦(切到别的 app / 别的窗口)即停 —— 背景里飘雪白烧 CPU。
  setRunning(false)
}
function onWindowFocus(): void {
  setRunning(computeRunning())
}
function onResize(): void {
  scheduleMeasure()
}

function onMessage(event: MessageEvent): void {
  const frame = frameEl.value
  // 两道闸:source 挡别的 frame 冒充,token 挡同一 frame 的旧世代。
  if (!frame || event.source !== frame.contentWindow) return
  const data = event.data as { token?: unknown; type?: unknown } | null
  if (!data || typeof data !== 'object') return
  if (!token || data.token !== token) return

  if (data.type === PLUGIN_AMBIENT_MESSAGE.ready) {
    // 一代 iframe 只握一次手:重复的 ready 不再重发词表(静态表只发一次)。
    if (handshakeDone) return
    handshakeDone = true
    clearTimeout(handshakeTimer)
    // 词表在几何之前:插件读到第一批矩形时,已经知道每个名字是什么种类。
    if (!vocabularySent) {
      vocabularySent = true
      post({ type: PLUGIN_AMBIENT_MESSAGE.vocabulary, anchors: PLUGIN_AMBIENT_ANCHORS })
    }
    // 首帧几何 + 当前运行态一起过去,iframe 不必再往返一次要。
    measure()
    if (!running) post({ type: PLUGIN_AMBIENT_MESSAGE.pause })
  }
}

/** 换了一层氛围(赢家变了)= 换一代 iframe:新 token、重取一次。 */
function reset(): void {
  token = newToken()
  handshakeDone = false
  // 新一代 iframe 什么都不知道:词表要重发一次。
  vocabularySent = false
  running = computeRunning()
  reloadNonce.value += 1
  armHandshake()
}

onMounted(() => {
  token = newToken()
  running = computeRunning()
  window.addEventListener('message', onMessage)
  window.addEventListener('resize', onResize)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('focus', onWindowFocus)
  document.addEventListener('visibilitychange', onVisibility)
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => scheduleMeasure())
    // document 根:窗口/侧栏一类的布局变化(composer 列尺寸随之改)在这里兜底。
    resizeObserver.observe(document.documentElement)
  }
  if (typeof MutationObserver !== 'undefined') {
    mutationObserver = new MutationObserver((mutations) => {
      if (hasElementMutation(mutations)) scheduleMeasure()
    })
    mutationObserver.observe(document.body, { childList: true, subtree: true })
  }
  // 观察对象先对准此刻在场的地标(几何本身要等握手,measure 自己把关)。
  syncObservation(collectGeometry().present)
  armHandshake()
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('blur', onWindowBlur)
  window.removeEventListener('focus', onWindowFocus)
  document.removeEventListener('visibilitychange', onVisibility)
  clearTimeout(handshakeTimer)
  if (rafHandle) {
    const cancel = window.cancelAnimationFrame ?? window.clearTimeout
    cancel(rafHandle)
    rafHandle = 0
  }
  resizeObserver?.disconnect()
  resizeObserver = null
  observedAnchors = new Set()
  mutationObserver?.disconnect()
  mutationObserver = null
})

// 赢家换人(entryUrl 变)→ 换一代 iframe。同一 URL 不重置(避免无谓重载)。
watch(() => props.entryUrl, () => reset())
</script>

<style scoped>
.plugin-ambient-layer {
  position: fixed;
  inset: 0;
  /* 纯视觉:点击穿透到真 UI。这一条是氛围层"永远收不到交互"的执行点。 */
  pointer-events: none;
  /* 内容之上、每一层可交互浮层之下(层级表见 docs/design/ui-system.md §3)。 */
  z-index: var(--z-ambient);
  overflow: hidden;
}

.plugin-ambient-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  pointer-events: none;
}
</style>
