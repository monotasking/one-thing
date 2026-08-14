<template>
  <div class="session-list-wrapper">
    <!-- Top scroll indicator line -->
    <div :class="['scroll-indicator-top', { visible: isOverflowing }]" />

    <div
      ref="listRef"
      class="sessions-list"
      :class="{ 'is-scrolling': isScrolling }"
      :data-suppress-anim="suppressAnim ? '' : null"
      @scroll="handleScroll"
    >
      <AppMenu
        class="sidebar-menu"
        :model-value="activeIndex"
        :default-openeds="expandedGroupMenuIndexes"
        :ellipsis="false"
        menu-trigger="click"
        @select="handleMenuSelect"
        @open="handleMenuOpen"
        @close="handleMenuClose"
      >
        <slot name="before" />

        <SubMenu
          v-for="group in groups"
          :key="group.key"
          :index="groupMenuIndex(group.key)"
          expand-icon-position="start"
          class="session-group"
        >
          <template #title>
            <!-- 项目组带一枚文件夹章(样板 ChatGPT 左栏的 `📁 Projects`)——
                 「置顶」「未归类」「Music · 电台」不是项目,不画。
                 判据读 `group.kind`,不解析 `key` 前缀。 -->
            <Folder
              v-if="group.kind === 'project'"
              class="group-folder"
              :size="14"
              :stroke-width="1.7"
              aria-hidden="true"
            />
            <span
              class="group-label"
              @contextmenu="handleGroupContextMenu($event, group)"
            >{{ group.label }}</span>
            <!-- 「＋」= 在这个项目里新建会话。
                 用 span 而不是 <button>:整个组头本身就是一颗 <button>
                 (SubMenu 的 .app-sub-menu-title),按钮套按钮是非法 HTML。
                 因此点击/键盘都要自己 stop —— 否则会顺带把组头折叠了。 -->
            <span
              v-if="group.projectPath"
              class="group-new-session"
              role="button"
              tabindex="0"
              :aria-label="`在 ${group.label} 中新建会话`"
              @click.stop="startProjectSession(group, $event)"
              @keydown.enter.stop.prevent="startProjectSession(group, $event)"
              @keydown.space.stop.prevent="startProjectSession(group, $event)"
            >
              <Plus
                :size="13"
                :stroke-width="1.9"
                aria-hidden="true"
              />
            </span>
          </template>

          <div class="session-group-items">
            <template
              v-for="session in visibleSessions(group)"
              :key="session.id"
            >
              <!-- 未归类 桶内退回时间：今天 / 昨天 / 过去 7 天 / 更早 -->
              <div
                v-if="session.sectionLabel"
                class="session-subtime"
              >
                {{ session.sectionLabel }}
              </div>
              <MenuItem
                :index="sessionMenuIndex(session.id)"
                item-as="div"
                raw
                class="session-menu-item"
                @click="(_, event) => handleSessionMenuClick(event, session)"
              >
                <SessionItem
                  :session="session"
                  :is-active="activeIndex === sessionMenuIndex(session.id)"
                  :is-generating="isSessionGenerating(session.id)"
                  :is-editing="editingSessionId === session.id"
                  :editing-name="editingName"
                  @context-menu="(e) => $emit('context-menu', e, session)"
                  @toggle-collapse="$emit('toggle-collapse', session.id)"
                  @start-rename="$emit('start-rename', session)"
                  @confirm-rename="(name) => $emit('confirm-rename', session.id, name)"
                  @cancel-rename="$emit('cancel-rename')"
                />
              </MenuItem>
            </template>
            <!-- 刚建、还没开过会话的项目:给一句旁白,而不是一个空抽屉。
                 只有项目组会空着(别的组没有会话就根本不成组)。 -->
            <div
              v-if="group.sessions.length === 0"
              class="group-empty"
            >
              还没有会话
            </div>
            <!-- 样板那行 `Show more`:一条低调的墨字,不是一颗按钮 —— 它是
                 "还有"这个事实的旁白,不该在列表里抢过会话行。 -->
            <Button
              v-if="hasMore(group)"
              text
              size="small"
              class="load-more-btn"
              @click.stop="loadMore(group.key)"
            >
              显示更多
            </Button>
          </div>
        </SubMenu>
      </AppMenu>

      <div
        v-if="groups.length === 0"
        class="empty-sessions"
      >
        <span>No chats yet</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import AppMenu from '@/components/common/Menu.vue'
import MenuItem from '@/components/common/MenuItem.vue'
import SubMenu from '@/components/common/SubMenu.vue'
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from 'vue'
import { Folder, Plus } from 'lucide-vue-next'
import SessionItem from './SessionItem.vue'
import type { SessionWithBranches, SessionGroup } from './useSessionOrganizer'

interface Props {
  groups: SessionGroup[]
  activeIndex: string
  currentSessionId: string | null
  isSessionGenerating: (sessionId: string) => boolean
  editingSessionId: string | null
  editingName: string
}

interface Emits {
  (e: 'menu-select', index: string): void
  (e: 'context-menu', event: MouseEvent, session: SessionWithBranches): void
  (e: 'toggle-collapse', sessionId: string): void
  (e: 'start-rename', session: SessionWithBranches): void
  (e: 'confirm-rename', sessionId: string, name: string): void
  (e: 'cancel-rename'): void
  (e: 'overflow-change', isOverflowing: boolean, hasContentBelow: boolean): void
  /**
   * 第三个参数是**触发事件**,只为多根项目那颗根选择菜单定位用(它得知道
   * 「＋」画在哪儿)。单根项目直通建会话,事件用不上。键盘触发时是
   * KeyboardEvent,没有 clientX/Y —— 由消费方退回元素 rect。
   */
  (e: 'new-session-in-project', projectPath: string, event: MouseEvent | KeyboardEvent): void
  (e: 'project-context-menu', event: MouseEvent, group: SessionGroup): void
}

const props = withDefaults(defineProps<Props>(), {
  activeIndex: '',
})
const emit = defineEmits<Emits>()

const listRef = ref<HTMLElement | null>(null)
const isOverflowing = ref(false)
const hasContentBelow = ref(false)

// Per-group display state (keyed by stable group.key)
const DEFAULT_VISIBLE = 5   // root sessions shown per group by default
const LOAD_STEP = 10        // additional roots revealed per "show more" click
const collapsedGroups = ref<Set<string>>(new Set())
// Groups that stay open regardless of which project is active
const ALWAYS_OPEN_GROUPS = new Set(['music', 'pinned'])
// music 组默认只露最近一次编排;show more 才翻历史
const groupLimits = ref<Record<string, number>>({ music: 1 })
const expandedGroupMenuIndexes = computed(() =>
  props.groups
    .filter(group => !collapsedGroups.value.has(group.key))
    .map(group => groupMenuIndex(group.key))
)

// Count top-level (root) sessions in a group; branches ride along with their root
function rootCount(group: SessionGroup): number {
  let n = 0
  for (const s of group.sessions) if (s.depth === 0) n++
  return n
}

function limitFor(key: string): number {
  return groupLimits.value[key] ?? DEFAULT_VISIBLE
}

// Slice the flattened list to the first N roots, keeping each root's full subtree
function visibleSessions(group: SessionGroup): SessionWithBranches[] {
  const max = limitFor(group.key)
  const result: SessionWithBranches[] = []
  let roots = 0
  for (const s of group.sessions) {
    if (s.depth === 0) {
      roots++
      if (roots > max) break
    }
    result.push(s)
  }
  return result
}

function hasMore(group: SessionGroup): boolean {
  return rootCount(group) > limitFor(group.key)
}

function loadMore(key: string) {
  groupLimits.value = { ...groupLimits.value, [key]: limitFor(key) + LOAD_STEP }
}

function sessionMenuIndex(sessionId: string): string {
  return `session:${sessionId}`
}

function groupMenuIndex(groupKey: string): string {
  return `group:${groupKey}`
}

function groupKeyFromMenuIndex(index: string): string | null {
  if (!index.startsWith('group:')) return null
  return index.slice('group:'.length)
}

function handleMenuSelect(index: string) {
  emit('menu-select', index)
}

/**
 * 组头的「＋」:在这个项目里新建会话。
 *
 * 先把组展开再报上去 —— 新草稿落在这个组里,组要是收着的,用户点完什么都
 * 看不见(方案六默认只开当前项目那一格,别的项目全收)。
 */
function startProjectSession(group: SessionGroup, event: MouseEvent | KeyboardEvent) {
  if (!group.projectPath) return
  if (collapsedGroups.value.has(group.key)) {
    const next = new Set(collapsedGroups.value)
    next.delete(group.key)
    collapsedGroups.value = next
  }
  emit('new-session-in-project', group.projectPath, event)
}

/** 组头右键 —— 只有项目组有菜单可开(移出名册);别的组沉默,不吞浏览器默认。 */
function handleGroupContextMenu(event: MouseEvent, group: SessionGroup) {
  if (!group.projectPath) return
  event.preventDefault()
  event.stopPropagation()
  emit('project-context-menu', event, group)
}

function handleMenuOpen(index: string) {
  const key = groupKeyFromMenuIndex(index)
  if (!key) return
  const next = new Set(collapsedGroups.value)
  next.delete(key)
  collapsedGroups.value = next
}

function handleMenuClose(index: string) {
  const key = groupKeyFromMenuIndex(index)
  if (!key) return
  const currentGroupKeys = new Set(props.groups.map(group => group.key))
  if (!currentGroupKeys.has(key)) return
  const next = new Set(collapsedGroups.value)
  next.add(key)
  collapsedGroups.value = next
}

// Drawer default state (方案六): only the current project drawer is open;
// every other project collapses to a single header row. 置顶 / 电台 always
// stay open. Runs once when groups first populate.
function seedCollapse() {
  const groups = props.groups
  if (groups.length === 0) return

  let activeKey: string | null = null
  const current = props.currentSessionId
  if (current) {
    for (const group of groups) {
      if (group.sessions.some(s => s.id === current)) { activeKey = group.key; break }
    }
  }
  // No active session → open the most recent project (first non-always-open group)
  if (!activeKey) {
    activeKey = groups.find(group => !ALWAYS_OPEN_GROUPS.has(group.key))?.key ?? null
  }

  const collapsed = new Set<string>()
  for (const group of groups) {
    if (ALWAYS_OPEN_GROUPS.has(group.key)) continue
    if (group.key === activeKey) continue
    collapsed.add(group.key)
  }
  collapsedGroups.value = collapsed
}

// Make sure the active session is actually rendered: expand its group and raise
// its limit far enough to include it. Runs on deliberate switches + first load.
function ensureActiveVisible() {
  const id = props.currentSessionId
  if (!id) return
  for (const group of props.groups) {
    let rootIdx = -1
    let found = false
    for (const s of group.sessions) {
      if (s.depth === 0) rootIdx++
      if (s.id === id) { found = true; break }
    }
    if (!found) continue
    if (collapsedGroups.value.has(group.key)) {
      const next = new Set(collapsedGroups.value)
      next.delete(group.key)
      collapsedGroups.value = next
    }
    if (limitFor(group.key) < rootIdx + 1) {
      groupLimits.value = { ...groupLimits.value, [group.key]: rootIdx + 1 }
    }
    break
  }
}
// Suppress CSS transitions on initial mount so collapsed branches don't visibly
// animate as the organizer settles its hierarchy / active-session expansion.
const suppressAnim = ref(true)
let suppressAnimFrame: number | null = null

let mutationObserver: MutationObserver | null = null
let resizeObserver: ResizeObserver | null = null

// Double-click detection
const lastClickInfo = ref<{ sessionId: string; time: number } | null>(null)
const DOUBLE_CLICK_THRESHOLD = 400

function checkOverflow() {
  const el = listRef.value
  if (!el) return

  // Top separator: show only when content is actually scrolled above (not at top)
  isOverflowing.value = el.scrollTop > 0
  // Bottom separator: show only when there's more content below the visible area
  const hasMore = el.scrollHeight > el.clientHeight &&
                  el.scrollHeight > Math.ceil(el.scrollTop + el.clientHeight) + 2
  hasContentBelow.value = hasMore

  emit('overflow-change', isOverflowing.value, hasContentBelow.value)
}

function checkOverflowDelayed() {
  setTimeout(checkOverflow, 350)
}

// Reveal the scrollbar only while actively scrolling
const isScrolling = ref(false)
let scrollEndTimer: number | null = null

function handleScroll() {
  checkOverflow()

  isScrolling.value = true
  if (scrollEndTimer !== null) window.clearTimeout(scrollEndTimer)
  scrollEndTimer = window.setTimeout(() => {
    scrollEndTimer = null
    isScrolling.value = false
  }, 600)
}

function handleSessionMenuClick(event: MouseEvent, session: SessionWithBranches) {
  const now = Date.now()
  const lastClick = lastClickInfo.value

  // Check if click was on session-name (which has its own @dblclick for rename)
  const target = event.target as HTMLElement
  const isOnSessionName = target.classList.contains('session-name') ||
    target.closest('.session-name') !== null

  // Check if this is a double-click (same session clicked within threshold)
  if (lastClick && lastClick.sessionId === session.id && (now - lastClick.time) < DOUBLE_CLICK_THRESHOLD) {
    // Double-click detected - toggle collapse
    lastClickInfo.value = null

    // Don't toggle collapse if clicking on session-name (let rename work)
    // Only toggle for parent sessions with branches when not on the name
    if (session.hasBranches && !isOnSessionName) {
      emit('toggle-collapse', session.id)
    }
    return
  }

  // Single click - record it. The actual selection is emitted by AppMenu.
  lastClickInfo.value = { sessionId: session.id, time: now }
}

// Watch total session count to recheck overflow
watch(
  () => props.groups.reduce((n, g) => n + g.sessions.length, 0),
  () => {
    nextTick(checkOverflow)
  }
)

// Keep the active session visible on deliberate navigation
watch(
  () => props.currentSessionId,
  () => nextTick(ensureActiveVisible)
)

// And once on the first load after groups are populated
let initialActiveApplied = false
watch(
  () => props.groups.length,
  (len) => {
    if (len > 0 && !initialActiveApplied) {
      initialActiveApplied = true
      seedCollapse()
      nextTick(ensureActiveVisible)
    }
  },
  { immediate: true }
)

onMounted(() => {
  const listElement = listRef.value

  if (listElement) {
    // MutationObserver for content changes
    mutationObserver = new MutationObserver(() => {
      checkOverflow()
    })
    mutationObserver.observe(listElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    })

    // ResizeObserver for container size changes
    resizeObserver = new ResizeObserver(() => {
      checkOverflow()
    })
    resizeObserver.observe(listElement)

    // Initial check
    checkOverflowDelayed()
  }
  // Re-enable transitions after the layout has fully settled on first paint.
  // Two RAFs is enough for the initial collapse-state pass + active-session
  // ancestor expansion to commit without animating.
  suppressAnimFrame = requestAnimationFrame(() => {
    suppressAnimFrame = requestAnimationFrame(() => {
      suppressAnimFrame = null
      suppressAnim.value = false
    })
  })
})

onUnmounted(() => {
  if (mutationObserver) {
    mutationObserver.disconnect()
    mutationObserver = null
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (suppressAnimFrame !== null) {
    cancelAnimationFrame(suppressAnimFrame)
    suppressAnimFrame = null
  }
  if (scrollEndTimer !== null) {
    window.clearTimeout(scrollEndTimer)
    scrollEndTimer = null
  }
})
</script>

<style scoped>
/* Wrapper to fill available space in flex container */
.session-list-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* Top scroll indicator line - outside scroll container */
.scroll-indicator-top {
  height: 1px;
  margin: 0 16px;
  background: var(--ui-border-subtle-border);
  opacity: 0;
  transition: opacity var(--duration-slow) var(--ease-default);
  pointer-events: none;
  flex-shrink: 0;
}

.scroll-indicator-top.visible {
  opacity: 1;
}

.sessions-list {
  --sidebar-list-meta-fg: color-mix(
    in srgb,
    var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg)) 72%,
    transparent
  );
  --sidebar-list-meta-fg-strong: color-mix(
    in srgb,
    var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg)) 84%,
    transparent
  );
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  min-width: 0;
  /* No top padding: the sticky group header must sit flush against the
     scroll container's top edge, or scrolled text shows through the gap.
     Bottom is 10px rather than 12px: the row seam (`.session-item`'s 2px
     block-end margin, ui-system.md §1) leaks past the last row, so the panel
     gives those 2px back and the list's outer edge stays where it was. */
  padding: 0 10px 10px 12px;
  contain: strict;
  content-visibility: auto;
}

/* Native scrollbar stays hidden until the user scrolls or hovers the thumb.
   The transparent thumb still occupies its 10px gutter, so :hover can hit it. */
.sessions-list::-webkit-scrollbar-thumb {
  background: transparent;
}

.sessions-list.is-scrolling::-webkit-scrollbar-thumb,
.sessions-list::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--ui-text-muted-fg) 26%, transparent);
}

.sidebar-menu {
  --app-menu-bg: transparent;
  --app-menu-border: transparent;
  --app-menu-width: 100%;
  --app-menu-padding: 0;
  --app-menu-item-height: 34px;
  /* 抽屉风（v7）：分组头圆角 8，hover 用软填充 */
  --app-menu-item-radius: 8px;
  /* MenuItem 会给二级项打内联 padding-inline-start: calc(12px + step)。
     归零 step，让所有行的包装盒都从 12px 起，行几何才可控。 */
  --app-menu-indent-step: 0px;
  --app-menu-item-fg: var(--sidebar-row-fg, var(--ui-sidebar-item-fg, var(--ui-text-secondary-fg)));
  --app-menu-item-hover-bg: var(--sidebar-row-hover-fill, var(--ui-state-hover-bg));
  --app-menu-item-hover-fg: var(--sidebar-row-ink, var(--ui-text-primary-fg, var(--ui-sidebar-item-hover-fg)));
  --app-menu-active-bg: transparent;
  --app-menu-active-fg: var(--ui-sidebar-item-active-fg, var(--ui-text-primary-fg));

  position: relative;
  gap: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.session-group {
  display: flex;
  flex-direction: column;
  overflow: visible;
}

/* 抽屉头（v7 dhead）：左侧旋转 chevron + 12px/600 标签，hover 软填充圆角。
   sticky 保留：滚动时组头钉在顶部，静置底色与列表同色所以不可见。 */
.session-group :deep(.app-sub-menu-title) {
  position: sticky;
  top: 0;
  z-index: 1;
  min-height: 0;
  height: auto;
  gap: 8px;
  /* Full-bleed opaque header: a right margin would leave an unpainted
     channel where scrolled text shows through. */
  margin-right: 0;
  padding-top: 7px;
  padding-bottom: 7px;
  padding-right: 8px;
  /* 静置不透明底：sticky 时挡住滚过的行文 */
  background: var(--ui-sidebar-surface-bg, var(--ui-surface-app-bg));
  /* 分组头用全墨：与 72% 墨的行文拉开一档，层级靠色阶不靠猜主题 */
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
  /* v7 dhead：600、无字距。字号引 sidebar 字号阶梯的 row 档(13px)——
     原来写死 12px，比全局刻度低一档，和 14px 的聊天正文并排时明显偏小。 */
  font-size: var(--sidebar-type-row);
  font-weight: var(--font-weight-semibold, 600);
  line-height: 1.35;
  letter-spacing: 0;
  transition: color var(--duration-normal) var(--ease-default), background-color var(--duration-normal) var(--ease-default);
}

/* hover 填充叠在不透明底之上（背景图层），sticky 状态下滚过的内容不会透出 */
.session-group :deep(.app-sub-menu-title:hover),
.session-group :deep(.app-sub-menu-title:focus-visible) {
  background-color: var(--ui-sidebar-surface-bg, var(--ui-surface-app-bg));
  background-image: linear-gradient(
    var(--sidebar-row-hover-fill, var(--ui-state-hover-bg)),
    var(--sidebar-row-hover-fill, var(--ui-state-hover-bg))
  );
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
  box-shadow: none;
}

.session-group :deep(.app-sub-menu-chevron-hit) {
  width: 12px;
  color: var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg));
}

.session-group :deep(.app-sub-menu-chevron) {
  width: 12px;
  height: 12px;
}

.session-group :deep(.app-sub-menu-label) {
  display: flex;
  align-items: center;
  gap: 6px;
  color: inherit;
}

.session-group :deep(.app-sub-menu-panel) {
  gap: 0;
  margin: 0;
  padding: 0;
  overflow: visible;
}

.session-group-items {
  width: 100%;
}

/* 未归类 桶内的时间子标签：比分组头更轻，缩进到与行文对齐(x=32) */
.session-subtime {
  padding: 8px 12px 3px 32px;
  font-size: var(--sidebar-type-micro);
  font-weight: var(--font-weight-normal, 400);
  letter-spacing: 0.1em;
  color: var(--sidebar-list-meta-fg, var(--ui-text-faint-fg));
  user-select: none;
}

.session-menu-item :deep(.app-menu-item) {
  outline-offset: -2px;
}

.group-folder {
  flex: 0 0 auto;
  margin-right: 6px;
  color: var(--ui-text-muted-fg);
}

.group-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 项目组头的「＋」：静置隐身，hover 组头才现身 —— 组头是一条常显的静物，
   一颗常亮的加号会把它变成一条工具栏。键盘焦点落上来同样现身(:focus-visible
   在 opacity 上生效，否则 tab 过去是一颗看不见的按钮)。 */
.group-new-session {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: 2px;
  border-radius: var(--radius-sm, 4px);
  opacity: 0;
  color: var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg));
  cursor: pointer;
  transition:
    opacity var(--duration-normal) var(--ease-default),
    color var(--duration-normal) var(--ease-default),
    background-color var(--duration-normal) var(--ease-default);
}

.session-group :deep(.app-sub-menu-title:hover) .group-new-session,
.group-new-session:focus-visible {
  opacity: 1;
}

.group-new-session:hover {
  background-color: var(--sidebar-row-hover-fill, var(--ui-state-hover-bg));
  color: var(--ui-sidebar-action-hover-fg, var(--ui-text-primary-fg));
}

.group-new-session:focus-visible {
  outline: none;
  box-shadow: var(--ui-focus-ring-shadow);
}

/* 空项目的旁白：与「显示更多」同一条缩进线(x=32)、同一档弱墨，
   但它不是控件，不给 hover / 下划线。 */
.group-empty {
  padding: 3px 12px 6px 32px;
  color: var(--sidebar-list-meta-fg, var(--ui-text-faint-fg));
  font-size: var(--sidebar-type-caption);
  user-select: none;
}

/* Show-more affordance per section — 文本行，无填充，下划线示意可点 */
.load-more-btn {
  --app-button-height: auto;
  --app-button-min-width: 0;
  --app-button-padding-x: 0;
  --app-button-font-size: var(--sidebar-type-caption);
  --app-button-hover-fill: transparent;
  --app-button-hover-fg: var(--ui-sidebar-action-hover-fg, var(--ui-text-primary-fg));
  --app-button-shadow: none;
  --app-button-hover-shadow: none;

  justify-content: flex-start;
  margin: 2px 4px 6px 32px;
  padding: 3px 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--sidebar-list-meta-fg);
  font-size: var(--sidebar-type-caption);
  text-align: left;
  cursor: pointer;
  transition: color var(--duration-normal) var(--ease-default);
}

.load-more-btn:hover {
  background: transparent;
  color: var(--ui-sidebar-action-hover-fg, var(--ui-text-primary-fg));
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--ui-accent-primary-fg);
}

/* Kill child transitions while initial state settles to avoid the
   collapsed-branch flicker users see when the active session's ancestors
   are expanded a frame after mount. */
.sessions-list[data-suppress-anim] :deep(.session-item),
.sessions-list[data-suppress-anim] :deep(.session-item *) {
  transition: none !important;
  animation: none !important;
}

.empty-sessions {
  padding: 20px;
  text-align: center;
  color: var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg));
  font-size: var(--sidebar-type-row);
}

/*
 * 「会话列表交出内部滚动」那两条(U0b 之前挂在 `data-shell-mode` 门里)已删:
 * 它们是给「会话」还是 rail 一格时准备的 —— 那时列表住在 `.sidebar-pane` 里,
 * 面板才是唯一的滚动体。U3 之后会话列表只在**对话形态**渲染,宿主是
 * `.sidebar-chat-pane`(它不滚),列表自己滚回来才对。
 */
</style>
