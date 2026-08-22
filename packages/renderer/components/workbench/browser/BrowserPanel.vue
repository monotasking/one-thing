<script setup lang="ts">
/**
 * Embedded browser chrome — 单线 Monoline（docs/design/browser-ui/1-monoline.html）。
 * 整条 chrome 压成一行 32px：导航 + 标签计数芯片 + 地址 + 刷新 + 拾取。
 *
 * 没有任何「下拉」会动到几何：真正的页面是主进程的 WebContentsView，DOM 盖不住
 * 它，而下推占位 div 会让它 resize——页面当场重排、滚动位置乱跳。所以
 *  - 标签列表：藏起原生视图，列表铺满视口（rect 一动不动，关掉即原地复原）；
 *  - 地址「Enter 会做什么」：行内提示，贴在地址框右端，不撑高 chrome。
 *
 * 空 URL 的标签是「起始页」（BrowserStartPage，方案见 newtab-4up.html 案一）：
 * 主进程压根没给它挂原生视图，视口里那张 DOM 就是整张页面。
 *
 * Geometry sync 仍标 TODO(browser-geometry)：今天跟的是单 Tabs 工作台，
 * terminal P1 分屏树落地后要改用 §14.2 的共存钩子。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowLeft, ArrowRight, ChevronDown, Crosshair, Globe, Lock, Plus, RotateCw, Search, Square, X,
} from 'lucide-vue-next'
import {
  isBrowserSearchInput,
  resolveBrowserSearchEngine,
  type BrowserSearchEngine,
} from '@shared/ipc'
import { browserApi } from '@/platform/browser-client'
import { useBrowserStore } from '@/stores/browser'
import { useOverlayPresenceStore } from '@/stores/overlayPresence'
import type { MessageAttachment, PickedWebElement } from '@/types'
import BrowserStartPage from './BrowserStartPage.vue'

const props = withDefaults(defineProps<{ active: boolean; revealed?: boolean }>(), {
  revealed: true,
})

const store = useBrowserStore()
const overlayPresence = useOverlayPresenceStore()
const rootRef = ref<HTMLElement | null>(null)
const viewportRef = ref<HTMLElement | null>(null)
const urlInputRef = ref<HTMLInputElement | null>(null)
const omniboxValue = ref('')
const editingOmnibox = ref(false)
/** 标签列表是否铺开（铺开时原生视图藏起,见 shouldShow）。与地址编辑态互斥。 */
const tabListOpen = ref(false)

const activeTab = computed(() => store.activeTab)
/**
 * 空 URL = 起始页：主进程没给这个标签挂 WebContentsView（也不会显示它），
 * 视口里那张「空线」是我们自己的 DOM。刷新/拾取这些针对页面的动作此时无意义。
 */
const onStartPage = computed(() => !!activeTab.value && !activeTab.value.url)
const isHttps = computed(() => activeTab.value?.url?.startsWith('https://') ?? false)
// While editing, surface what Enter will do: search (engine query) vs navigate.
const willSearch = computed(() => editingOmnibox.value && isBrowserSearchInput(omniboxValue.value))

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`.replace(/\/$/, '')
  } catch {
    return ''
  }
}

/** 常态显示「域名 · 标题」；域名解析不出来（about:blank 等）时退回全 URL。 */
const addrHost = computed(() => hostOf(activeTab.value?.url ?? ''))
const addrTitle = computed(() => {
  const tab = activeTab.value
  if (!tab) return ''
  if (tab.loading) return '正在载入…'
  return tab.title || pathOf(tab.url)
})

// Keep the omnibox synced with the active tab's URL unless the user is editing.
watch(
  () => activeTab.value?.url,
  (url) => {
    if (!editingOmnibox.value) omniboxValue.value = url ?? ''
  },
)
watch(
  () => store.activeTabId,
  () => {
    editingOmnibox.value = false
    tabListOpen.value = false
    omniboxValue.value = activeTab.value?.url ?? ''
  },
)

/**
 * 编辑态的引擎快照，只用来渲染「Enter 会做什么」那行提示；真正的导航仍走
 * store.openFromInput（它每次提交现取选择，设置窗改了立刻生效，不吃这份快照）。
 */
const engine = ref<BrowserSearchEngine | null>(null)

const omniTarget = computed(() => {
  if (!editingOmnibox.value) return null
  const raw = omniboxValue.value.trim()
  if (!raw || raw === activeTab.value?.url) return null
  if (willSearch.value) return { hint: `Enter 用${engine.value?.name ?? '搜索引擎'}搜索` }
  return { hint: 'Enter 前往' }
})

function submitOmnibox(): void {
  // URL-vs-search normalization (and the engine choice) lives in
  // store.openFromInput — the engine table is shared with the settings picker.
  const raw = omniboxValue.value.trim()
  if (!raw) return
  editingOmnibox.value = false
  urlInputRef.value?.blur()
  void store.openFromInput(raw)
}

/** 点地址条 → 进入编辑，露出裸 URL 并全选。 */
async function beginEdit(): Promise<void> {
  tabListOpen.value = false
  editingOmnibox.value = true
  omniboxValue.value = activeTab.value?.url ?? ''
  void loadEngine()
  await nextTick()
  urlInputRef.value?.focus()
  urlInputRef.value?.select()
}

async function loadEngine(): Promise<void> {
  const res = await browserApi.getSearchEngine({})
  engine.value = resolveBrowserSearchEngine(res.success ? res.engineId : undefined)
}

function onOmniboxBlur(): void {
  editingOmnibox.value = false
  omniboxValue.value = activeTab.value?.url ?? ''
}

function toggleTabList(): void {
  editingOmnibox.value = false
  tabListOpen.value = !tabListOpen.value
}

function selectTab(id: string): void {
  tabListOpen.value = false
  void store.selectTab(id)
}

async function newTab(): Promise<void> {
  tabListOpen.value = false
  await store.openTab()
}

/**
 * 关闭当前标签。标签计数芯片只有 ≥2 个标签时才出现，抽屉里那颗 × 因此够不着
 * 单标签的情况——chrome 上必须常驻一个出口。关掉最后一个由主进程补一张起始页
 * （面板没有「零标签」态可退）。
 */
async function closeActiveTab(): Promise<void> {
  tabListOpen.value = false
  await store.closeActiveTab()
}

/**
 * 起始页提交：引擎 id 是那条线上「本次」选中的那家，作为 override 传下去
 * ——不写默认（默认只在设置页改）。URL/搜索的归一仍在 store 里那一份。
 */
function onStartPageSubmit(raw: string, engineId: string): void {
  void store.openFromInput(raw, engineId)
}

/** Esc：先撤拾取，再收编辑态/标签列表。（页面持有焦点时拾取的 Esc 由主进程处理。） */
function onEscape(): void {
  if (store.picking) {
    store.cancelPick()
    return
  }
  if (editingOmnibox.value) {
    urlInputRef.value?.blur()
    return
  }
  tabListOpen.value = false
}

function tabLabel(tab: { url: string; title: string }): string {
  return tab.title || hostOf(tab.url) || tab.url || '新标签页'
}

// ── 伪进度：Electron 没有真实加载进度事件，用缓动逼近 85% 再冲线 ──
// 起画延迟 PROGRESS_ARM_MS：加载态持续不到这个时长就不画条。缓存命中的
// 页面几十毫秒就结束，画一条完整跑完的进度条反而像"页面又重载了一次"；
// 主进程那侧已经把子框架/同文档导航的假加载滤掉了(browser/service.ts)，
// 这层是抗抖兜底——将来漏网的事件源也只会是脉冲，画不出条。
const PROGRESS_ARM_MS = 120
const progress = ref(0)
let progressArm: ReturnType<typeof setTimeout> | null = null
let progressTimer: ReturnType<typeof setInterval> | null = null
let progressFade: ReturnType<typeof setTimeout> | null = null

function clearProgressTimers(): void {
  if (progressArm !== null) {
    clearTimeout(progressArm)
    progressArm = null
  }
  if (progressTimer !== null) {
    clearInterval(progressTimer)
    progressTimer = null
  }
  if (progressFade !== null) {
    clearTimeout(progressFade)
    progressFade = null
  }
}

watch(
  () => activeTab.value?.loading ?? false,
  (loading) => {
    clearProgressTimers()
    if (loading) {
      progressArm = setTimeout(() => {
        progressArm = null
        progress.value = 8
        progressTimer = setInterval(() => {
          progress.value += (85 - progress.value) * 0.18
        }, 180)
      }, PROGRESS_ARM_MS)
      return
    }
    // 没起画过就没有条要收尾（脉冲式加载走的就是这条路）。
    if (progress.value === 0) return
    progress.value = 100
    progressFade = setTimeout(() => {
      progress.value = 0
    }, 260)
  },
)

// ── element pick → composer attachment ──
// The main process runs the overlay + screenshot; the picked element becomes a
// synthetic image MessageAttachment (screenshot + source URL + text excerpt) and
// is handed to the visible composer via a window event (BrowserPanel and the
// composer sit far apart in the tree). See docs/design/browser-v2.md §P2.
function pickedElementToAttachment(el: PickedWebElement): MessageAttachment {
  // el.image is a PNG data URL; MessageAttachment.base64Data is bare base64.
  const base64Data = el.image.includes(',') ? el.image.split(',')[1]! : ''
  // Only claim "screenshot is the visible part" when there actually is one —
  // a failed capture (base64Data === '') must not append a note about an image.
  const excerpt =
    el.clipped && el.excerpt && base64Data ? `${el.excerpt}\n[截图为可见部分]` : el.excerpt
  return {
    id: `web-element-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    fileName: 'web-element.png',
    mimeType: 'image/png',
    size: Math.floor(base64Data.length * 0.75),
    mediaType: 'image',
    base64Data,
    sourceUrl: el.sourceUrl,
    sourceTitle: el.sourceTitle,
    excerpt,
  }
}

async function togglePick(): Promise<void> {
  if (store.picking) {
    store.cancelPick()
    return
  }
  tabListOpen.value = false
  const el = await store.pickElement()
  if (!el) return
  window.dispatchEvent(
    new CustomEvent('onething:composer-attach', { detail: pickedElementToAttachment(el) }),
  )
}

// ── geometry: track the placeholder rect and push to the WebContentsView ──
// TODO(browser-geometry): rAF poll is the P0 stand-in — cheap (one rect read +
// compare) and correct through splitter translation (the tab list never resizes it),
// but should become event-driven once terminal P1 split-tree lands its
// bounds-recheck broadcast.
let rafId: number | null = null
let last = { x: -1, y: -1, width: -1, height: -1 }

function reconcileBounds(): void {
  const el = viewportRef.value
  if (el) {
    const r = el.getBoundingClientRect()
    const next = { x: r.left, y: r.top, width: r.width, height: r.height }
    if (
      next.x !== last.x || next.y !== last.y ||
      next.width !== last.width || next.height !== last.height
    ) {
      last = next
      void browserApi.setBounds({ bounds: next })
    }
  }
  rafId = requestAnimationFrame(reconcileBounds)
}

// The native view should show only when this browser tab is the active
// workbench tab (①), the panel is expanded (② collapse), and no modal overlay
// floats over it (③ occlusion). The native layer can't be CSS-clipped, so:
//  - hide immediately on any of these going false (no jutting during collapse);
//  - delay showing by one animation (~200ms) so the panel finishes expanding
//    before the view reappears at full bounds.
// ④ 标签列表铺在视口里时也必须藏：DOM 盖不住原生视图。藏起来换掉「下推」，
// 页面 rect 全程不变，关掉列表后原地复原（不 resize 就不重排、不跳滚动）。
const shouldShow = computed(
  () => props.active && props.revealed && !overlayPresence.present && !tabListOpen.value,
)
let showTimer: ReturnType<typeof setTimeout> | null = null
// True during the panel's expand transition (~160ms); showing the native view
// then would jut past the still-narrow panel (the frozen .workbench-slide rect
// is full-width). Tab-switch / overlay-close have no animation → show instantly.
let expanding = false

function applyVisibility(show: boolean): void {
  if (showTimer !== null) {
    clearTimeout(showTimer)
    showTimer = null
  }
  if (!show) {
    void browserApi.setVisible({ visible: false })
    return
  }
  const reveal = () => {
    last = { x: -1, y: -1, width: -1, height: -1 } // force a fresh setBounds
    void browserApi.setVisible({ visible: true })
  }
  if (expanding) showTimer = setTimeout(reveal, 220)
  else reveal()
}

// Declared BEFORE the shouldShow watch so, on a reveal edge, `expanding` is set
// before applyVisibility reads it (same-flush watchers run in creation order).
watch(
  () => props.revealed,
  (revealed, prev) => {
    if (revealed && !prev) {
      expanding = true
      setTimeout(() => {
        expanding = false
      }, 220)
    }
  },
)
watch(shouldShow, applyVisibility)

// ── 面板是不是「当前操作的那块」——⌘T/⌘W 的第二判据 ──
// 菜单那侧只看得见原生页面有没有焦点；用户在地址栏/起始页打字时页面并没有焦点，
// 这里补上另一半。用 document 级捕获监听：focusin 管可聚焦元素，mousedown 管点到
// 不可聚焦的空白（只听 focusin 会漏——点聊天区的死角不触发 focus 变化，标志位就
// 会一直停在 true，⌘W 于是关错了标签）。
function onDocumentInteraction(event: Event): void {
  const root = rootRef.value
  if (!root) return
  const target = event.target as Node | null
  store.setPanelFocused(!!target && root.contains(target))
}

onMounted(async () => {
  await store.ensureLoaded()
  if (store.tabs.length === 0) await store.openTab()
  applyVisibility(shouldShow.value)
  rafId = requestAnimationFrame(reconcileBounds)
  document.addEventListener('focusin', onDocumentInteraction, true)
  document.addEventListener('mousedown', onDocumentInteraction, true)
})

onBeforeUnmount(() => {
  if (rafId !== null) cancelAnimationFrame(rafId)
  if (showTimer !== null) clearTimeout(showTimer)
  clearProgressTimers()
  document.removeEventListener('focusin', onDocumentInteraction, true)
  document.removeEventListener('mousedown', onDocumentInteraction, true)
  store.setPanelFocused(false)
  void browserApi.setVisible({ visible: false })
})

// 面板被切走/折叠时键就不再归它。注意不能挂 shouldShow：它含 !tabListOpen，
// 而标签抽屉恰恰是面板自己的 DOM，开抽屉时键更应该归浏览器。
watch(
  () => props.active && props.revealed,
  (engaged) => {
    if (!engaged) store.setPanelFocused(false)
  },
)
</script>

<template>
  <section
    ref="rootRef"
    class="browser-panel"
    @keydown.esc="onEscape"
  >
    <!-- ① 单线 chrome：一行 32px -->
    <div
      class="bp-bar"
      :class="{ picking: store.picking }"
    >
      <button
        class="bp-iconbtn"
        type="button"
        aria-label="后退"
        :disabled="!activeTab?.canGoBack"
        @click="store.goBack()"
      >
        <ArrowLeft
          :size="15"
          :stroke-width="1.9"
          aria-hidden="true"
        />
      </button>
      <button
        class="bp-iconbtn"
        type="button"
        aria-label="前进"
        :disabled="!activeTab?.canGoForward"
        @click="store.goForward()"
      >
        <ArrowRight
          :size="15"
          :stroke-width="1.9"
          aria-hidden="true"
        />
      </button>

      <!-- 标签计数芯片：只有一个标签时无处可切,不占位 -->
      <button
        v-if="store.tabs.length > 1"
        class="bp-tabchip"
        :class="{ open: tabListOpen }"
        type="button"
        :aria-label="`标签列表（${store.tabs.length}）`"
        :aria-expanded="tabListOpen"
        @click="toggleTabList"
      >
        <ChevronDown
          class="bp-chev"
          :class="{ flip: tabListOpen }"
          :size="10"
          :stroke-width="2.2"
          aria-hidden="true"
        />
        {{ store.tabs.length }}
      </button>
      <!-- 新建标签常驻:抽屉里那颗只有开着抽屉才够得着,单标签时根本开不出来 -->
      <button
        class="bp-iconbtn"
        type="button"
        aria-label="新建标签"
        @click="newTab"
      >
        <Plus
          :size="15"
          :stroke-width="1.9"
          aria-hidden="true"
        />
      </button>

      <!-- 地址：常态「域名 · 标题」，聚焦才露裸 URL -->
      <form
        v-if="editingOmnibox"
        class="bp-addr is-editing"
        @submit.prevent="submitOmnibox"
      >
        <Search
          v-if="willSearch"
          class="bp-lead is-search"
          :size="11"
          :stroke-width="2.2"
          aria-hidden="true"
        />
        <Lock
          v-else-if="isHttps"
          class="bp-lead"
          :size="11"
          :stroke-width="2.2"
          aria-hidden="true"
        />
        <Globe
          v-else
          class="bp-lead is-insecure"
          :size="11"
          :stroke-width="2.2"
          aria-hidden="true"
        />
        <input
          ref="urlInputRef"
          v-model="omniboxValue"
          class="bp-url"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="搜索或输入网址"
          @blur="onOmniboxBlur"
        >
        <!-- 「Enter 会做什么」贴在输入框里,不另开一层:任何撑高 chrome 的
             提示条都会把原生视图挤矮,页面当场重排。 -->
        <span
          v-if="omniTarget"
          class="bp-hint"
          @mousedown.prevent="submitOmnibox"
        >{{ omniTarget.hint }}</span>
      </form>
      <button
        v-else
        class="bp-addr"
        type="button"
        aria-label="编辑地址"
        @click="beginEdit"
      >
        <Lock
          v-if="isHttps"
          class="bp-lead"
          :size="11"
          :stroke-width="2.2"
          aria-hidden="true"
        />
        <Globe
          v-else
          class="bp-lead is-insecure"
          :size="11"
          :stroke-width="2.2"
          aria-hidden="true"
        />
        <span
          v-if="addrHost"
          class="bp-host"
        >{{ addrHost }}</span>
        <span
          v-else
          class="bp-host is-raw"
        >{{ activeTab?.url || '新标签页' }}</span>
        <span
          v-if="addrTitle"
          class="bp-title"
        >{{ addrTitle }}</span>
      </button>

      <button
        class="bp-iconbtn"
        type="button"
        :aria-label="activeTab?.loading ? '停止' : '刷新'"
        :disabled="onStartPage && !activeTab?.loading"
        @click="activeTab?.loading ? store.stop() : store.reload()"
      >
        <Square
          v-if="activeTab?.loading"
          :size="12"
          :stroke-width="2.2"
          aria-hidden="true"
        />
        <RotateCw
          v-else
          :size="14"
          :stroke-width="1.9"
          aria-hidden="true"
        />
      </button>
      <button
        class="bp-iconbtn bp-pick"
        :class="{ active: store.picking }"
        type="button"
        :aria-label="store.picking ? '取消拾取（Esc）' : '拾取页面元素带入对话'"
        :disabled="!activeTab || onStartPage"
        @click="togglePick"
      >
        <Crosshair
          :size="14"
          :stroke-width="1.9"
          aria-hidden="true"
        />
      </button>
      <!-- 关闭当前标签：行末常驻。标签芯片 <2 个标签时不出现,抽屉里那颗 × 够不着 -->
      <button
        class="bp-iconbtn bp-close"
        type="button"
        aria-label="关闭当前标签"
        :disabled="!activeTab"
        @click="closeActiveTab"
      >
        <X
          :size="14"
          :stroke-width="1.9"
          aria-hidden="true"
        />
      </button>

      <!-- 加载：底边一条走线，不用转圈 -->
      <div
        v-if="progress > 0"
        class="bp-progress"
        :style="{ width: `${progress}%` }"
      />
    </div>

    <!-- ③ viewport placeholder (WebContentsView overlays this rect) -->
    <div
      ref="viewportRef"
      class="bp-viewport"
    >
      <!-- 起始页「空线」：空 URL 的标签没有原生视图，这块 DOM 就是整张页面。
           按 tab id 立 key,换标签即重挂——光标回到线上、上一条输入不串台。 -->
      <BrowserStartPage
        v-if="onStartPage && !tabListOpen"
        :key="activeTab!.id"
        @submit="onStartPageSubmit"
      />
      <!-- 标签列表：铺在视口里,不是下推层——占位 div 的 rect 一动,原生视图就
           得 resize,页面跟着重排、滚动位置乱跳。开列表时改为藏起原生视图
           (shouldShow 已含 !tabListOpen),几何完全不动。 -->
      <div
        v-if="tabListOpen"
        class="bp-tablist"
      >
        <div class="bp-tablist-legend">
          打开的标签 · {{ store.tabs.length }}
        </div>
        <div class="bp-tablist-rows">
          <button
            v-for="(tab, i) in store.tabs"
            :key="tab.id"
            class="bp-row"
            :class="{ current: tab.id === store.activeTabId }"
            type="button"
            @click="selectTab(tab.id)"
          >
            <span class="bp-row-num">{{ i + 1 }}</span>
            <img
              v-if="tab.favicon"
              class="bp-favicon"
              :src="tab.favicon"
              alt=""
            >
            <Globe
              v-else
              class="bp-favicon-fallback"
              :size="11"
              :stroke-width="2"
              aria-hidden="true"
            />
            <span class="bp-row-name">{{ tabLabel(tab) }}</span>
            <span class="bp-row-host">{{ hostOf(tab.url) }}</span>
            <span
              class="bp-row-close"
              role="button"
              aria-label="关闭标签"
              @click.stop="store.closeTab(tab.id)"
            >
              <X
                :size="11"
                :stroke-width="2"
                aria-hidden="true"
              />
            </span>
          </button>
        </div>
        <button
          class="bp-tablist-foot"
          type="button"
          @click="newTab"
        >
          <Plus
            :size="12"
            :stroke-width="2"
            aria-hidden="true"
          />
          新建标签
        </button>
      </div>

      <div
        v-if="activeTab?.crashed"
        class="bp-crash"
      >
        <div class="bp-crash-legend">
          页面已崩溃
        </div>
        <div class="bp-crash-msg">
          该标签的渲染进程意外退出。
        </div>
        <button
          class="bp-crash-reload"
          type="button"
          @click="store.reload()"
        >
          重新加载
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.browser-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--ui-surface-panel-bg);
}

/* ① 单线 chrome */
.bp-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 32px;
  flex: none;
  padding: 0 4px 0 2px;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-border-default-border) 55%, transparent);
}
/* 拾取激活：整条 chrome 左缘立起朱砂线 */
.bp-bar.picking {
  box-shadow: inset 2px 0 0 var(--ui-accent-primary-fg);
}

.bp-iconbtn {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
}
.bp-iconbtn:hover:not(:disabled) { color: var(--ui-text-primary-fg); }
.bp-iconbtn:disabled { color: var(--ui-text-faint-fg); cursor: default; }
.bp-iconbtn.active { color: var(--ui-accent-primary-fg); }

/* 标签计数芯片 */
.bp-tabchip {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: none;
  height: 20px;
  padding: 0 5px 0 4px;
  margin-right: 3px;
  border: 1px solid color-mix(in srgb, var(--ui-border-strong-border) 40%, transparent);
  border-radius: 2px;
  background: transparent;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
}
.bp-tabchip:hover {
  color: var(--ui-text-primary-fg);
  border-color: var(--ui-border-strong-border);
}
.bp-tabchip.open {
  color: var(--ui-text-primary-fg);
  border-color: var(--ui-accent-primary-fg);
}
.bp-chev { transition: transform var(--duration-fast) var(--ease-default); }
.bp-chev.flip { transform: rotate(180deg); }

/* 地址条：常态无框，悬停才有底纹 */
.bp-addr {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 2px;
  background: transparent;
  text-align: left;
  cursor: text;
}
.bp-addr:hover { background: color-mix(in srgb, var(--ui-text-muted-fg) 7%, transparent); }
.bp-addr.is-editing {
  background: var(--ui-surface-input-bg);
  border-color: var(--ui-accent-primary-fg);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ui-accent-primary-fg) 26%, transparent);
  cursor: auto;
}
.bp-lead { color: var(--ui-status-success-fg); flex: none; }
.bp-lead.is-insecure { color: var(--ui-text-faint-fg); }
.bp-lead.is-search { color: var(--ui-accent-primary-fg); }
.bp-host {
  flex: none;
  max-width: 60%;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-primary-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bp-host.is-raw {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 400;
  color: var(--ui-text-muted-fg);
}
.bp-title {
  min-width: 0;
  font-size: 12px;
  color: var(--ui-text-muted-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bp-title::before {
  content: '·';
  margin: 0 6px;
  color: var(--ui-text-faint-fg);
}
.bp-url {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ui-text-primary-fg);
}
.bp-url::placeholder { color: var(--ui-text-placeholder-fg); }

/* 关闭：行末唯一的破坏性动作,悬停才亮朱砂 */
.bp-close:hover:not(:disabled) { color: var(--ui-accent-primary-fg); }

/* 加载走线 */
.bp-progress {
  position: absolute;
  left: 0;
  bottom: -1px;
  height: 1.5px;
  background: var(--ui-accent-primary-fg);
  transition: width var(--duration-normal) linear;
}

/* ② 行内提示 + 标签列表 */
/* 「Enter 会做什么」的行内提示,贴在地址框右端 */
.bp-hint {
  flex: none;
  max-width: 45%;
  padding: 1px 4px;
  border: 1px solid color-mix(in srgb, var(--ui-border-default-border) 60%, transparent);
  border-radius: 2px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--ui-text-muted-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.bp-hint:hover {
  color: var(--ui-accent-primary-fg);
  border-color: color-mix(in srgb, var(--ui-accent-primary-fg) 55%, transparent);
}

/* ④ 标签列表：铺满视口(此时原生视图已藏),不改任何几何 */
.bp-tablist {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--ui-surface-panel-bg);
}
.bp-tablist-legend {
  flex: none;
  padding: 7px 10px 4px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ui-text-faint-fg);
}
.bp-tablist-rows {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.bp-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 10px 0 8px;
  border: none;
  background: transparent;
  text-align: left;
  font-size: 12px;
  color: var(--ui-text-secondary-fg);
  cursor: pointer;
}
.bp-row:hover { background: color-mix(in srgb, var(--ui-text-muted-fg) 8%, transparent); }
.bp-row.current {
  color: var(--ui-text-primary-fg);
  box-shadow: inset 2px 0 0 var(--ui-accent-primary-fg);
}
.bp-row-num {
  flex: none;
  width: 12px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ui-text-faint-fg);
}
.bp-favicon { width: 12px; height: 12px; border-radius: 2px; flex: none; }
.bp-favicon-fallback { color: var(--ui-text-faint-fg); flex: none; }
.bp-row-name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bp-row-host {
  margin-left: auto;
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ui-text-faint-fg);
}
.bp-row-close {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: 2px;
  color: var(--ui-text-faint-fg);
  opacity: 0;
  transition: opacity var(--duration-fast);
}
.bp-row:hover .bp-row-close { opacity: 1; }
.bp-row-close:hover { color: var(--ui-accent-primary-fg); }
.bp-tablist-foot {
  flex: none;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-top: 1px dotted color-mix(in srgb, var(--ui-border-default-border) 60%, transparent);
  background: transparent;
  font-size: 11.5px;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
}
.bp-tablist-foot:hover { color: var(--ui-accent-primary-fg); }

/* ③ viewport */
.bp-viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  background: var(--ui-surface-app-bg);
}
.bp-crash {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 6px;
  padding: 0 24px;
  border-left: 2px solid var(--ui-status-danger-fg);
  margin: 24px;
}
.bp-crash-legend {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  font-weight: 600;
  color: var(--ui-status-danger-fg);
}
.bp-crash-msg { font-size: 13px; color: var(--ui-text-primary-fg); }
.bp-crash-reload {
  margin-top: 8px;
  padding: 5px 12px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-primary-fg) 45%, transparent);
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--ui-accent-primary-fg);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
}
</style>
