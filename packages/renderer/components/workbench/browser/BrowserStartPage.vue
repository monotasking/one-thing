<script setup lang="ts">
/**
 * 起始页「空线」— docs/design/browser-ui/newtab-4up.html 案一。
 *
 * 新标签不再打开搜索引擎首页（那是一次纯粹的网络等待），tab.url 为空时主进程
 * 不挂 WebContentsView，这块 DOM 就是整张页面：一条墨线 + 一枚引擎字母。
 *
 * 引擎有两本账，别混：
 *  - 默认引擎 = 设置页那份持久化（browser/search-engine.json），主进程为准；
 *  - 这里 Tab 换的是**本次搜索**的引擎，一次性的，不写盘、不影响下一个新标签。
 * 所以提交时把选中的 id 一路传给 store.openFromInput 当 override，而不是去改默认。
 */
import { computed, onMounted, ref } from 'vue'
import {
  BROWSER_SEARCH_ENGINES,
  isBrowserSearchInput,
  resolveBrowserSearchEngine,
} from '@shared/ipc'
import { browserApi } from '@/platform/browser-client'

const emit = defineEmits<{ submit: [raw: string, engineId: string] }>()

const inputRef = ref<HTMLInputElement | null>(null)
const query = ref('')
/** 引擎环是否露出。Tab 或点字母芯片展开；Esc / 提交后收起。 */
const ringOpen = ref(false)
const engineIndex = ref(0)

const engine = computed(() => BROWSER_SEARCH_ENGINES[engineIndex.value]!)
const willSearch = computed(() => isBrowserSearchInput(query.value))
const enterHint = computed(() => {
  if (!query.value.trim()) return ''
  return willSearch.value ? `⏎ ${engine.value.shortName}搜索` : '⏎ 前往'
})

function focusInput(): void {
  inputRef.value?.focus()
}

/** Tab 轮转（Shift+Tab 反向）。展开引擎环，让轮到谁一目了然。 */
function cycleEngine(step: number): void {
  const count = BROWSER_SEARCH_ENGINES.length
  engineIndex.value = (engineIndex.value + step + count) % count
  ringOpen.value = true
}

function pickEngine(index: number): void {
  engineIndex.value = index
  focusInput()
}

function submit(): void {
  const raw = query.value.trim()
  if (!raw) return
  ringOpen.value = false
  emit('submit', raw, engine.value.id)
}

/** Esc：先收引擎环，再清输入（清空后仍不失焦，接着打就是）。 */
function onEscape(): void {
  if (ringOpen.value) {
    ringOpen.value = false
    return
  }
  query.value = ''
}

onMounted(async () => {
  focusInput()
  // 默认引擎是主进程那份持久化，每次开页现取——设置窗是独立窗口独立 Pinia，
  // 镜像会跨窗口过期（omnibox 提交同理，见 stores/browser.ts）。
  const res = await browserApi.getSearchEngine({})
  const current = resolveBrowserSearchEngine(res.success ? res.engineId : undefined)
  const index = BROWSER_SEARCH_ENGINES.findIndex(e => e.id === current.id)
  if (index >= 0) engineIndex.value = index
})
</script>

<template>
  <!-- 点空白处也回到线上：整页只有一个可输入的地方 -->
  <div
    class="bsp"
    @mousedown.self="focusInput"
  >
    <div class="bsp-mark">
      新 标 签
    </div>

    <form
      class="bsp-line"
      :class="{ picking: ringOpen }"
      @submit.prevent="submit"
    >
      <!-- 字母芯片：这条线归哪家引擎 -->
      <button
        class="bsp-token"
        :class="{ hot: ringOpen }"
        type="button"
        :aria-label="`搜索引擎：${engine.name}（Tab 切换）`"
        @click="ringOpen = !ringOpen"
      >
        {{ engine.token }}
      </button>
      <input
        ref="inputRef"
        v-model="query"
        class="bsp-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        aria-label="搜索或输入网址"
        placeholder="搜索或输入网址"
        @keydown.tab.exact.prevent="cycleEngine(1)"
        @keydown.tab.shift.prevent="cycleEngine(-1)"
        @keydown.esc.prevent="onEscape"
      >
    </form>

    <div class="bsp-hint">
      <span>Tab 换引擎</span>
      <span :class="{ live: !!enterHint }">{{ enterHint || '本次有效' }}</span>
    </div>

    <div
      v-if="ringOpen"
      class="bsp-ring"
    >
      <button
        v-for="(item, i) in BROWSER_SEARCH_ENGINES"
        :key="item.id"
        class="bsp-ring-item"
        :class="{ on: i === engineIndex }"
        type="button"
        :aria-pressed="i === engineIndex"
        @click="pickEngine(i)"
      >
        <span class="bsp-ring-name">{{ item.shortName }}</span>
        <span class="bsp-ring-key">{{ item.token }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.bsp {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
  background: var(--ui-surface-panel-bg);
  /* 起始页是这块视口里唯一的内容，盖住占位 div（原生视图此时并未挂出） */
  z-index: 1;
}

.bsp-mark {
  margin-bottom: 26px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ui-text-faint-fg);
}

.bsp-line {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(76%, 420px);
  padding-bottom: 7px;
  border-bottom: 1.5px solid var(--ui-border-strong-border);
}
.bsp-line.picking {
  border-bottom-color: var(--ui-accent-primary-fg);
}

.bsp-token {
  flex: none;
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--ui-border-strong-border) 45%, transparent);
  border-radius: 2px;
  background: transparent;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
}
.bsp-token:hover {
  color: var(--ui-text-primary-fg);
  border-color: var(--ui-border-strong-border);
}
.bsp-token.hot {
  color: var(--ui-accent-primary-fg);
  border-color: var(--ui-accent-primary-fg);
}

.bsp-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font-family: inherit;
  font-size: 13px;
  color: var(--ui-text-primary-fg);
}
.bsp-input::placeholder {
  color: var(--ui-text-placeholder-fg);
}

.bsp-hint {
  display: flex;
  justify-content: space-between;
  width: min(76%, 420px);
  margin-top: 9px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ui-text-faint-fg);
}
.bsp-hint .live {
  color: var(--ui-accent-primary-fg);
}

.bsp-ring {
  display: flex;
  gap: 6px;
  width: min(76%, 420px);
  margin-top: 16px;
}
.bsp-ring-item {
  flex: 1;
  padding: 5px 0;
  border: 1px solid color-mix(in srgb, var(--ui-border-default-border) 55%, transparent);
  border-radius: 2px;
  background: transparent;
  font-size: 11.5px;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
}
.bsp-ring-item:hover {
  color: var(--ui-text-primary-fg);
  border-color: var(--ui-border-strong-border);
}
.bsp-ring-item.on {
  border-color: var(--ui-accent-primary-fg);
  color: var(--ui-accent-primary-fg);
  background: color-mix(in srgb, var(--ui-accent-primary-fg) 7%, transparent);
}
.bsp-ring-name {
  display: block;
}
.bsp-ring-key {
  display: block;
  margin-top: 2px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--ui-text-faint-fg);
}
.bsp-ring-item.on .bsp-ring-key {
  color: var(--ui-accent-primary-fg);
}
</style>
