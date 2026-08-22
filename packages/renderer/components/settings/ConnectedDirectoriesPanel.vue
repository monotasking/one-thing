<template>
  <SettingsSection
    title="Connected Directories"
    description="加入的目录可被 @ 引用、搜索、直接编辑(免逐次确认)、并自动发现其中的技能(SKILL.md)。"
  >
    <SettingsGroup>
      <div class="connected-dirs">
        <div
          v-if="showScopePicker"
          class="scope-row"
        >
          <span class="scope-label">作用范围</span>
          <Select
            v-bind="LEDGER_SELECT"
            class="scope-select"
            :model-value="scope"
            :options="scopeOptions"
            aria-label="接入目录作用范围"
            @update:model-value="switchScope(String($event))"
          />
        </div>

        <div
          v-if="showScopePicker"
          class="scope-hint"
        >
          {{ scopeHint }}
        </div>

        <div
          v-if="isSpaceScope && inheritedDirectories.length > 0"
          class="inherited-list"
        >
          <div
            v-for="dir in inheritedDirectories"
            :key="`inherited-${dir}`"
            class="directory-item is-inherited"
          >
            <span class="directory-path">{{ dir }}</span>
            <span class="directory-tag">来自全局</span>
          </div>
        </div>

        <div
          v-if="directories.length > 0"
          class="directory-list"
        >
          <div
            v-for="dir in directories"
            :key="dir"
            :class="['directory-item', { 'is-missing': missingDirs.has(dir) }]"
          >
            <span class="directory-path">{{ dir }}</span>
            <span
              v-if="missingDirs.has(dir)"
              class="directory-missing"
            >目录不存在</span>
            <Button
              unstyled
              class="remove-btn"
              native-type="button"
              :aria-label="`Remove ${dir}`"
              @click="removeDirectory(dir)"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <line
                  x1="18"
                  y1="6"
                  x2="6"
                  y2="18"
                />
                <line
                  x1="6"
                  y1="6"
                  x2="18"
                  y2="18"
                />
              </svg>
            </Button>
          </div>
        </div>
        <div
          v-else
          class="empty-hint"
        >
          {{ emptyHint }}
        </div>

        <div
          v-if="overlayError"
          class="overlay-error"
        >
          {{ overlayError }}
        </div>

        <Button
          unstyled
          class="add-btn"
          native-type="button"
          :disabled="!canChooseLocalDirectory || overlayLoading"
          @click="addDirectory"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <line
              x1="12"
              y1="5"
              x2="12"
              y2="19"
            />
            <line
              x1="5"
              y1="12"
              x2="19"
              y2="12"
            />
          </svg>
          添加目录
        </Button>
      </div>
    </SettingsGroup>
  </SettingsSection>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Button from '@/components/common/Button.vue'
import Select from '@/components/common/Select.vue'
import type { SelectOptionLike } from '@/components/common/select'
import type { AppSettings } from '@/types'
import { filesApi } from '@/platform/files-client'
import { platformApi } from '@/platform'
import { spacesApi } from '@/platform/spaces-client'
import { useSpacesStore } from '@/stores/spaces'
import { SettingsGroup, SettingsSection } from './settings-primitives'

/**
 * 接入目录的两层编辑面(批 B2)。
 *
 * 全局层 = `settings.tools.connectedDirectories`(所有空间共享,历史行为不变);
 * space 层 = `workspaces/<id>/space.json` 的 overlay,是**追加集** —— 所以选中
 * 某个空间时,全局那几条以「来自全局」的只读行摆在上面:少了这一眼,用户会以为
 * 切到空间后目录消失了。
 *
 * 两层的落盘通道不同(全局走 settings 的 update:settings,space 走 spaces IPC),
 * 所以这里不把它们塞进同一个 commit —— 假装统一只会在保存失败时说谎。
 */
const props = defineProps<{
  settings: AppSettings
}>()

const emit = defineEmits<{
  'update:settings': [settings: AppSettings]
}>()

/** Settings-area dropdown spelling; teleported because the tab body scrolls. */
const LEDGER_SELECT = {
  variant: 'ledger',
  size: 'small',
  teleported: true,
  fitInputWidth: true,
} as const

const GLOBAL_SCOPE = 'global'

const spacesStore = useSpacesStore()

/** 当前编辑的是全局层还是某个 space。默认全局 —— 老用户打开设置看到的是原样。 */
const scope = ref<string>(GLOBAL_SCOPE)
const overlayDirectories = ref<string[]>([])
const overlayLoading = ref(false)
const overlayError = ref<string | null>(null)

const isSpaceScope = computed(() => scope.value !== GLOBAL_SCOPE)

/** 后端答不上话(web 宿主本切片没有 /api/spaces)就整段不画,退成纯全局层。 */
const showScopePicker = computed(() => spacesStore.available)

const scopeOptions = computed<SelectOptionLike[]>(() => [
  { value: GLOBAL_SCOPE, label: '全局(所有空间)' },
  ...spacesStore.spaces.map(space => ({ value: space.id, label: space.name })),
])

const globalDirectories = computed(() => props.settings.tools?.connectedDirectories ?? [])

const directories = computed(() =>
  isSpaceScope.value ? overlayDirectories.value : globalDirectories.value,
)

/** space 视图里全局那几条是只读的继承行(已在本空间生效,但要去全局层才能删)。 */
const inheritedDirectories = computed(() => globalDirectories.value)

const scopeHint = computed(() =>
  isSpaceScope.value
    ? '这些目录只在该空间生效,叠加在全局目录之上。'
    : '这些目录在所有空间生效。',
)

const emptyHint = computed(() =>
  isSpaceScope.value
    ? '这个空间还没有自己的接入目录。它当前只看得见全局目录。'
    : '还没有接入目录。加入之前,这五项能力的行为与没有这个功能时完全一致。',
)

const canChooseLocalDirectory = computed(() => platformApi.capabilities.localFileSystem)

/**
 * 不存在的目录只标灰,不自动删。盘可以后挂、目录可以后建 —— 替用户删掉一条他
 * 自己写下的配置,比让他看见一行灰字要糟糕得多。
 */
const missingDirs = ref(new Set<string>())

async function refreshMissing(dirs: readonly string[]): Promise<void> {
  if (!platformApi.capabilities.localFileSystem) {
    missingDirs.value = new Set()
    return
  }
  const missing = new Set<string>()
  await Promise.all(dirs.map(async dir => {
    try {
      const result = await filesApi.stat({ path: dir })
      if (!result.success || result.type !== 'directory') missing.add(dir)
    } catch {
      missing.add(dir)
    }
  }))
  missingDirs.value = missing
}

watch(directories, dirs => { void refreshMissing(dirs) }, { immediate: true })

onMounted(() => {
  // 设置窗是独立 window,空间列表得自己拉一次(左栏那次不在这个 window 里)。
  void spacesStore.load()
})

async function loadOverlay(spaceId: string): Promise<void> {
  overlayLoading.value = true
  overlayError.value = null
  try {
    const response = await spacesApi.getOverlay({ id: spaceId })
    if (response.success) {
      overlayDirectories.value = response.overlay?.connectedDirectories ?? []
    } else {
      overlayDirectories.value = []
      overlayError.value = response.error || '读不到这个空间的配置'
    }
  } catch (error) {
    overlayDirectories.value = []
    overlayError.value = error instanceof Error ? error.message : '读不到这个空间的配置'
  } finally {
    overlayLoading.value = false
  }
}

function switchScope(next: string): void {
  if (next === scope.value) return
  scope.value = next
  overlayError.value = null
  if (next === GLOBAL_SCOPE) {
    overlayDirectories.value = []
    return
  }
  void loadOverlay(next)
}

function commitGlobal(next: string[]): void {
  emit('update:settings', {
    ...props.settings,
    tools: { ...props.settings.tools, connectedDirectories: next },
  })
}

/** 写失败就回滚到写之前那份,不留下一个界面上有、盘上没有的目录。 */
async function commitOverlay(next: string[]): Promise<void> {
  const previous = overlayDirectories.value
  overlayDirectories.value = next
  overlayError.value = null
  try {
    // **先读后并**:后端那条通道是整层写(B2 勘误 3)。overlay 从批 B7 起还装着
    // `selectedModels`,只写 `connectedDirectories` 会把模型选择一起抹掉。
    const response = await spacesStore.patchOverlay(scope.value, { connectedDirectories: next })
    if (!response) {
      overlayDirectories.value = previous
      overlayError.value = spacesStore.lastError || '保存失败'
      return
    }
    overlayDirectories.value = response.connectedDirectories ?? next
  } catch (error) {
    overlayDirectories.value = previous
    overlayError.value = error instanceof Error ? error.message : '保存失败'
  }
}

function commit(next: string[]): void {
  if (isSpaceScope.value) void commitOverlay(next)
  else commitGlobal(next)
}

async function addDirectory(): Promise<void> {
  try {
    const result = await platformApi.showOpenDialog({
      title: '选择要接入的目录',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return
    const picked = result.filePaths[0]
    if (directories.value.includes(picked)) return
    commit([...directories.value, picked])
  } catch {
    // 对话框打不开(如 web 宿主):保持现状,不留下半个状态。
  }
}

function removeDirectory(dir: string): void {
  commit(directories.value.filter(item => item !== dir))
}
</script>

<style scoped>
.connected-dirs {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
}

.scope-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 7px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--settings-rule-soft, var(--ui-border-subtle-border, var(--ui-border-default-border))) 55%, transparent);
}

.scope-label {
  font-size: 12.5px;
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

.scope-select {
  min-width: 180px;
}

.scope-hint {
  width: 100%;
  padding: 8px 0 10px;
  font-size: 11.5px;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
}

.inherited-list {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.directory-list {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin-bottom: 12px;
}

.directory-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  background: transparent;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--settings-rule-soft, var(--ui-border-subtle-border, var(--ui-border-default-border))) 55%, transparent);
}

.directory-item.is-missing .directory-path {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  text-decoration: line-through;
  text-decoration-color: var(--settings-rule, var(--ui-border-default-border));
}

.directory-item.is-inherited .directory-path {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
}

.directory-path {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.directory-tag {
  flex-shrink: 0;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
}

.directory-missing {
  flex-shrink: 0;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--ui-status-warning-fg, var(--ui-text-muted-fg));
}

.overlay-error {
  width: 100%;
  margin-bottom: 12px;
  font-size: 11.5px;
  font-family: var(--font-mono, monospace);
  color: var(--ui-status-danger-fg);
}

.remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 4px;
  background: transparent;
  border: none;
  border-radius: 0;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  cursor: pointer;
  transition: color var(--duration-normal);
}

.remove-btn:hover {
  background: transparent;
  color: var(--ui-status-danger-fg);
}

.add-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: color var(--duration-normal);
}

.add-btn:hover:not(:disabled) {
  background: transparent;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--settings-accent, var(--ui-accent-primary-fg));
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.empty-hint {
  width: 100%;
  font-size: 12px;
  color: var(--settings-ink-4, var(--ui-text-faint-fg, var(--ui-text-muted-fg)));
  padding: 10px 12px;
  background: transparent;
  border: 1px dashed var(--settings-rule, var(--ui-border-default-border));
  border-radius: 0;
  margin-bottom: 12px;
}
</style>
