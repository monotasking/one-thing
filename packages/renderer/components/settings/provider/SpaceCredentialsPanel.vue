<template>
  <SettingsSection
    v-if="spacesStore.available"
    title="空间凭证"
    description="非默认空间用自己的密钥。默认空间的凭证就是上面这张表 —— 空间之间严格隔离,不回落。"
  >
    <SettingsGroup>
      <div class="space-creds">
        <div class="scope-row">
          <span class="scope-label">空间</span>
          <Select
            v-bind="LEDGER_SELECT"
            class="scope-select"
            :model-value="spaceId"
            :options="spaceOptions"
            aria-label="选择要编辑凭证的空间"
            @update:model-value="switchSpace(String($event))"
          />
        </div>

        <div class="scope-hint">
          {{ scopeHint }}
        </div>

        <div
          v-if="isDefaultScope"
          class="empty-hint"
        >
          默认空间的凭证在上面的「连接」区域编辑,这里不重复一份。
        </div>

        <div
          v-else
          class="cred-list"
        >
          <div
            v-for="row in rows"
            :key="row.id"
            class="cred-row"
            :class="{ 'is-disabled': row.oauth }"
          >
            <div class="cred-head">
              <span class="cred-name">{{ row.name }}</span>
              <span
                class="cred-state"
                :class="{ 'is-set': row.configured }"
              >{{ row.stateLabel }}</span>
            </div>

            <div
              v-if="row.oauth"
              class="cred-note"
            >
              登录授权(OAuth / 订阅)型,本空间暂不支持,请在默认空间使用。
            </div>

            <div
              v-else
              class="cred-edit"
            >
              <Input
                :model-value="draft(row.id).apiKey"
                type="password"
                show-password
                variant="ledger"
                class="cred-input"
                :placeholder="row.configured ? row.apiKeyPreview || '已配置' : '填入本空间使用的 API Key'"
                :spellcheck="false"
                :aria-label="`${row.name} API Key(本空间)`"
                @update:model-value="draft(row.id).apiKey = String($event)"
              />
              <Input
                :model-value="draft(row.id).baseUrl"
                type="text"
                variant="ledger"
                class="cred-input is-url"
                placeholder="Base URL(可选)"
                :spellcheck="false"
                :aria-label="`${row.name} Base URL(本空间)`"
                @update:model-value="draft(row.id).baseUrl = String($event)"
              />
              <Button
                unstyled
                class="cred-action"
                native-type="button"
                :disabled="busy || !draft(row.id).apiKey.trim()"
                @click="save(row.id)"
              >
                保存
              </Button>
              <Button
                unstyled
                class="cred-action is-danger"
                native-type="button"
                :disabled="busy || !row.configured"
                @click="clear(row.id)"
              >
                清除
              </Button>
            </div>
          </div>
        </div>

        <div
          v-if="error"
          class="cred-error"
        >
          {{ error }}
        </div>
      </div>
    </SettingsGroup>
  </SettingsSection>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import Button from '@/components/common/Button.vue'
import Input from '@/components/common/Input.vue'
import Select from '@/components/common/Select.vue'
import type { SelectOptionLike } from '@/components/common/select'
import type { ProviderInfo, SpaceCredentialsSummary } from '@/types'
import { DEFAULT_SPACE_ID, useSpacesStore } from '@/stores/spaces'
import { SettingsGroup, SettingsSection } from '../settings-primitives'

/**
 * per-space provider 凭证的最小编辑面(批 B3)。
 *
 * **为什么另起一段而不是嵌进上面的连接卡片**:连接区(`ConnectionsSection`,
 * 1100 行)编辑的是 `settings.ai` —— 那正是**默认空间**的凭证层。在它内部再插一个
 * 空间维度,等于让同一组输入框在两种落盘通道之间切换(settings 的 update:settings
 * vs spaces IPC),保存失败时没法说清哪一层没写进去。分开画,两层各自诚实。
 *
 * 密钥原文永不回读:后端只回 `hasApiKey` + 预览,保存永远是整条覆盖写。
 */
const props = defineProps<{
  providers: ProviderInfo[]
}>()

const LEDGER_SELECT = {
  variant: 'ledger',
  size: 'small',
  teleported: true,
  fitInputWidth: true,
} as const

const spacesStore = useSpacesStore()

const spaceId = ref<string>(DEFAULT_SPACE_ID)
const credentials = ref<SpaceCredentialsSummary>({ providers: {} })
const busy = ref(false)
const error = ref<string | null>(null)

const isDefaultScope = computed(() => spaceId.value === DEFAULT_SPACE_ID)

const spaceOptions = computed<SelectOptionLike[]>(() =>
  spacesStore.spaces.map(space => ({ value: space.id, label: space.name })),
)

const scopeHint = computed(() =>
  isDefaultScope.value
    ? '默认空间的凭证源是全局设置,原地不动。'
    : '这些密钥只在该空间生效。该空间没配的 provider 在这里就是「未配置」—— 不会去借默认空间的钥匙。',
)

const drafts = reactive<Record<string, { apiKey: string; baseUrl: string }>>({})

function draft(providerId: string): { apiKey: string; baseUrl: string } {
  if (!drafts[providerId]) drafts[providerId] = { apiKey: '', baseUrl: '' }
  return drafts[providerId]
}

interface CredentialRow {
  id: string
  name: string
  oauth: boolean
  configured: boolean
  apiKeyPreview?: string
  stateLabel: string
}

const rows = computed<CredentialRow[]>(() =>
  props.providers.map(provider => {
    const entry = credentials.value.providers[provider.id]?.entries[0]
    const configured = Boolean(entry?.hasApiKey)
    const oauth = provider.requiresOAuth === true
    return {
      id: provider.id,
      name: provider.name,
      oauth,
      configured,
      apiKeyPreview: entry?.apiKeyPreview,
      stateLabel: oauth ? '本空间暂不支持' : configured ? '已配置' : '未配置',
    }
  }),
)

async function reload(): Promise<void> {
  if (isDefaultScope.value) {
    credentials.value = { providers: {} }
    return
  }
  credentials.value = await spacesStore.getCredentials(spaceId.value)
}

onMounted(async () => {
  // 设置窗是独立 window,空间列表得自己拉一次。
  await spacesStore.load()
  spaceId.value = spacesStore.currentSpaceId
  await reload()
})

async function switchSpace(next: string): Promise<void> {
  if (next === spaceId.value) return
  spaceId.value = next
  error.value = null
  for (const key of Object.keys(drafts)) delete drafts[key]
  await reload()
}

async function save(providerId: string): Promise<void> {
  const input = draft(providerId)
  if (!input.apiKey.trim()) return
  busy.value = true
  error.value = null
  try {
    const next = await spacesStore.setCredential({
      id: spaceId.value,
      providerId,
      apiKey: input.apiKey.trim(),
      baseUrl: input.baseUrl.trim() || undefined,
    })
    if (!next) {
      error.value = spacesStore.lastError || '保存失败'
      return
    }
    credentials.value = next
    // 保存成功就清掉草稿:输入框里留着明文没有任何用处。
    input.apiKey = ''
  } finally {
    busy.value = false
  }
}

async function clear(providerId: string): Promise<void> {
  busy.value = true
  error.value = null
  try {
    const next = await spacesStore.clearCredential({ id: spaceId.value, providerId })
    if (!next) {
      error.value = spacesStore.lastError || '清除失败'
      return
    }
    credentials.value = next
    draft(providerId).apiKey = ''
    draft(providerId).baseUrl = ''
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.space-creds {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  gap: var(--ui-space-2);
}

.scope-row {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
}

.scope-label {
  font-size: var(--ui-font-size-sm);
  color: var(--ui-text-secondary);
}

.scope-select {
  min-width: 180px;
}

.scope-hint,
.empty-hint {
  font-size: var(--ui-font-size-sm);
  color: var(--ui-text-tertiary);
  line-height: 1.6;
}

.cred-list {
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-2);
}

.cred-row {
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-1);
  padding: var(--ui-space-2) 0;
  border-top: var(--ui-border-width-thin) solid var(--ui-border-subtle);
}

.cred-row.is-disabled {
  opacity: 0.55;
}

.cred-head {
  display: flex;
  align-items: baseline;
  gap: var(--ui-space-2);
}

.cred-name {
  font-size: var(--ui-font-size-sm);
  color: var(--ui-text-primary);
}

.cred-state {
  font-size: var(--ui-font-size-xs);
  color: var(--ui-text-tertiary);
}

.cred-state.is-set {
  color: var(--ui-text-secondary);
}

.cred-note {
  font-size: var(--ui-font-size-xs);
  color: var(--ui-text-tertiary);
}

.cred-edit {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  flex-wrap: wrap;
}

.cred-input {
  flex: 1 1 200px;
  min-width: 0;
}

.cred-input.is-url {
  flex: 1 1 160px;
}

.cred-action {
  padding: var(--ui-space-1) var(--ui-space-2);
  font-size: var(--ui-font-size-xs);
  color: var(--ui-text-secondary);
  border: var(--ui-border-width-thin) solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-sm);
  background: transparent;
  cursor: pointer;
  transition: color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard);
}

.cred-action:hover:not(:disabled) {
  color: var(--ui-text-primary);
  border-color: var(--ui-border-default);
}

.cred-action:disabled {
  opacity: 0.45;
  cursor: default;
}

.cred-action.is-danger:hover:not(:disabled) {
  color: var(--ui-status-danger-fg);
  border-color: var(--ui-status-danger-fg);
}

.cred-action:focus-visible {
  outline: var(--ui-focus-ring-width) solid var(--ui-focus-ring-color);
  outline-offset: var(--ui-focus-ring-offset);
}

.cred-error {
  font-size: var(--ui-font-size-sm);
  color: var(--ui-status-danger-fg);
}
</style>
