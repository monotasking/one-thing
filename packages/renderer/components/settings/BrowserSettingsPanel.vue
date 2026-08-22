<script setup lang="ts">
/**
 * Browser profiles settings — Chrome-style isolated logins for the embedded
 * browser. Source of truth is the main process (profiles.json); this panel is a
 * thin view over the browserProfiles mirror store. 画线风 per the settings
 * ledger idiom (no cards; state lives in the line). See docs/design/browser-v2.md.
 */
import { onMounted, ref } from 'vue'
import { Check } from 'lucide-vue-next'
import Input from '@/components/common/Input.vue'
import { BROWSER_SEARCH_ENGINES, DEFAULT_BROWSER_SEARCH_ENGINE_ID } from '@shared/ipc'
import { platformApi } from '@/platform'
import { browserApi } from '@/platform/browser-client'
import { useBrowserProfilesStore } from '@/stores/browserProfiles'

const store = useBrowserProfilesStore()
const newName = ref('')
const confirmingRemoveId = ref<string | null>(null)

// The embedded browser (and thus these settings) is Electron-only; on the web
// host every browser platform method is a {success:false} stub — rendering the
// ledgers there would be dead-interactive UI asserting state no backend holds.
const supported = platformApi.capabilities.embeddedBrowser

// Search-engine selection — source of truth is the main process
// (browser/search-engine.json); this is a fetch-on-mount local mirror.
const searchEngines = BROWSER_SEARCH_ENGINES
const searchEngineId = ref<string>(DEFAULT_BROWSER_SEARCH_ENGINE_ID)

onMounted(() => {
  if (!supported) return
  void store.load()
  void browserApi.getSearchEngine({}).then((res) => {
    if (res.success) searchEngineId.value = res.engineId
  })
})

async function selectEngine(id: string): Promise<void> {
  if (id === searchEngineId.value) return
  const res = await browserApi.setSearchEngine({ engineId: id })
  if (res.success) searchEngineId.value = res.engineId
}

function engineHost(homeUrl: string): string {
  try {
    return new URL(homeUrl).hostname
  } catch {
    return homeUrl
  }
}

async function addProfile(): Promise<void> {
  const name = newName.value.trim()
  if (!name) return
  await store.add(name)
  newName.value = ''
}

function onRemoveClick(id: string): void {
  if (confirmingRemoveId.value === id) {
    void store.remove(id)
    confirmingRemoveId.value = null
  } else {
    confirmingRemoveId.value = id
  }
}
</script>

<template>
  <div
    v-if="!supported"
    class="browser-settings"
  >
    <header class="bs-header">
      <h2 class="bs-title">
        浏览器
      </h2>
      <p class="bs-sub">
        内嵌浏览器仅在桌面端可用，请在桌面应用中调整这些设置。
      </p>
    </header>
  </div>
  <div
    v-else
    class="browser-settings"
  >
    <header class="bs-header">
      <h2 class="bs-title">
        搜索引擎
      </h2>
      <p class="bs-sub">
        地址栏与起始页默认使用的引擎。新标签页只打开本地起始页，不加载任何引擎首页；
        在起始页按 Tab 可临时换一家搜，不影响这里的默认。
      </p>
    </header>

    <div class="bs-ledger">
      <button
        v-for="engine in searchEngines"
        :key="engine.id"
        class="bs-row"
        :class="{ active: engine.id === searchEngineId }"
        type="button"
        @click="selectEngine(engine.id)"
      >
        <span
          class="bs-dot"
          :class="{ on: engine.id === searchEngineId }"
        >
          <Check
            v-if="engine.id === searchEngineId"
            :size="11"
            :stroke-width="3"
            aria-hidden="true"
          />
        </span>
        <span class="bs-name">{{ engine.name }}</span>
        <span
          v-if="engine.id === searchEngineId"
          class="bs-tag"
        >当前</span>
        <span class="bs-spacer" />
        <span class="bs-host">{{ engineHost(engine.homeUrl) }}</span>
      </button>
    </div>

    <header class="bs-header">
      <h2 class="bs-title">
        浏览器配置
      </h2>
      <p class="bs-sub">
        每个配置是一套独立的登录环境（cookie / 本地存储互不干扰），可分别登录不同的谷歌账号。
        切换配置会在浏览器面板重开一个干净的标签页；删除配置会清除该环境的登录数据。
      </p>
    </header>

    <div class="bs-ledger">
      <button
        v-for="p in store.profiles"
        :key="p.id"
        class="bs-row"
        :class="{ active: p.id === store.activeProfileId }"
        type="button"
        @click="store.switchTo(p.id)"
      >
        <span
          class="bs-dot"
          :class="{ on: p.id === store.activeProfileId }"
        >
          <Check
            v-if="p.id === store.activeProfileId"
            :size="11"
            :stroke-width="3"
            aria-hidden="true"
          />
        </span>
        <span class="bs-name">{{ p.name }}</span>
        <span
          v-if="p.id === store.activeProfileId"
          class="bs-tag"
        >当前</span>
        <span class="bs-spacer" />
        <span
          v-if="p.id !== 'default'"
          class="bs-remove"
          :class="{ confirming: confirmingRemoveId === p.id }"
          role="button"
          @click.stop="onRemoveClick(p.id)"
        >{{ confirmingRemoveId === p.id ? '确认删除？' : '删除' }}</span>
      </button>

      <div class="bs-add">
        <Input
          v-model="newName"
          variant="ledger"
          class="bs-add-input"
          spellcheck="false"
          placeholder="新配置名称（如：工作、个人）"
          @keydown.enter="addProfile"
        />
        <button
          class="bs-add-btn"
          type="button"
          :disabled="!newName.trim()"
          @click="addProfile"
        >
          + 添加配置
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 画线风: no background fills, no radii on rows — state lives in the line. */
.browser-settings { display: flex; flex-direction: column; gap: 18px; }
.bs-header { display: flex; flex-direction: column; gap: 6px; }
.bs-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--ui-text-primary-fg); }
.bs-sub {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--ui-text-muted-fg, var(--ui-text-secondary-fg));
  max-width: 56ch;
}

.bs-ledger { position: relative; display: flex; flex-direction: column; padding-left: 14px; }
.bs-ledger::before {
  content: '';
  position: absolute;
  left: 0; top: 4px; bottom: 4px;
  width: 1px;
  background: color-mix(in srgb, var(--ui-border-strong-border, var(--ui-border-default-border)) 45%, transparent);
}

.bs-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 8px 9px 14px;
  border: none;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-border-default-border) 45%, transparent);
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.bs-row::before {
  content: '';
  position: absolute;
  left: -14px; top: 50%;
  width: 10px; height: 1px;
  background: color-mix(in srgb, var(--ui-border-strong-border, var(--ui-border-default-border)) 45%, transparent);
}
.bs-row:hover .bs-name { color: var(--ui-text-primary-fg); }

.bs-dot {
  display: grid;
  place-items: center;
  width: 16px; height: 16px;
  border-radius: 50%;
  border: 1.5px dashed color-mix(in srgb, var(--ui-text-faint-fg, var(--text-tertiary)) 70%, transparent);
  color: var(--ui-accent-primary-fg);
  flex: none;
}
.bs-dot.on { border: 1.5px solid var(--ui-accent-primary-fg); }

.bs-name { font-size: 13.5px; color: var(--ui-text-secondary-fg); }
.bs-row.active .bs-name { color: var(--ui-text-primary-fg); font-weight: 500; }
.bs-tag {
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ui-accent-primary-fg);
}
.bs-spacer { flex: 1; }
.bs-host {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--ui-text-faint-fg, var(--text-tertiary));
}
.bs-remove {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--ui-text-faint-fg, var(--text-tertiary));
  opacity: 0;
  transition: opacity var(--duration-fast), color var(--duration-fast);
}
.bs-row:hover .bs-remove { opacity: 1; }
.bs-remove:hover,
.bs-remove.confirming { opacity: 1; color: var(--ui-status-danger-fg); text-decoration: underline; }

.bs-add {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 8px 4px 14px;
}
.bs-add::before {
  content: '';
  position: absolute;
  left: -14px; top: 20px;
  width: 10px; height: 1px;
  background: color-mix(in srgb, var(--ui-border-strong-border, var(--ui-border-default-border)) 45%, transparent);
}
/* Add-profile field: `<Input variant="ledger">` owns the paint; only the
   flex layout lives here. */
.bs-add-input {
  flex: 1;
  min-width: 0;
}
.bs-add-btn {
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  color: var(--ui-accent-primary-fg);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px 2px;
  white-space: nowrap;
}
.bs-add-btn:hover:not(:disabled) { text-decoration: underline; }
.bs-add-btn:disabled { color: var(--ui-text-faint-fg, var(--text-tertiary)); cursor: default; }
</style>
