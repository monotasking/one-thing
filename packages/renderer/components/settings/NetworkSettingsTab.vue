<template>
  <div class="tab-content">
    <SettingsSection
      title="Network Proxy"
      description="Route outbound app traffic through a shared proxy when needed."
    >
      <SettingsGroup>
        <SettingRow
          label="Enable global proxy"
          description="Route AI requests, model refresh, web search, and login token requests through one proxy."
        >
          <Switch
            variant="ledger"
            :model-value="proxy.enabled"
            aria-label="Enable global proxy"
            @update:model-value="updateProxy({ enabled: Boolean($event) })"
          />
        </SettingRow>

        <SettingRow
          label="Proxy URL"
          description="Supports http, https, and socks5 proxies. Authentication can be included in the URL."
        >
          <Input
            variant="ledger"
            :model-value="proxy.url"
            placeholder="http://127.0.0.1:7890 or socks5://127.0.0.1:7890"
            spellcheck="false"
            @update:model-value="updateProxy({ url: $event })"
          />
        </SettingRow>

        <SettingRow
          label="Bypass Rules"
          description="Separate hosts with semicolons or commas. Add a host here when that service should use direct connection."
        >
          <Input
            variant="ledger"
            :model-value="proxy.bypassRules || ''"
            placeholder="localhost;127.0.0.1;::1;*.local"
            spellcheck="false"
            @update:model-value="updateProxy({ bypassRules: $event })"
          />
        </SettingRow>

        <SettingRow>
          <Button
            unstyled
            class="test-btn"
            native-type="button"
            :disabled="isTesting || !proxy.enabled"
            @click="testProxy"
          >
            {{ isTesting ? 'Testing...' : 'Test Proxy' }}
          </Button>
          <span
            v-if="testMessage"
            :class="['test-result', testStatus]"
          >
            {{ testMessage }}
          </span>
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import Input from '@/components/common/Input.vue'
import Switch from '@/components/common/Switch.vue'
import { computed, ref, toRaw } from 'vue'
import type { AppSettings, ProxySettings } from '@/types'
import {
  SettingRow,
  SettingsGroup,
  SettingsSection,
} from './settings-primitives'
import { settingsApi } from '@/platform/settings-client'

const props = defineProps<{
  settings: AppSettings
}>()

const emit = defineEmits<{
  'update:settings': [settings: AppSettings]
}>()

const isTesting = ref(false)
const testMessage = ref('')
const testStatus = ref<'success' | 'error'>('success')

const proxy = computed<ProxySettings>(() => props.settings.network?.proxy ?? {
  enabled: false,
  url: '',
  bypassRules: 'localhost;127.0.0.1;::1;*.local',
})

function updateProxy(updates: Partial<ProxySettings>) {
  testMessage.value = ''
  emit('update:settings', {
    ...props.settings,
    network: {
      ...props.settings.network,
      proxy: {
        ...proxy.value,
        ...updates,
      },
    },
  })
}

async function testProxy() {
  isTesting.value = true
  testMessage.value = ''
  try {
    const plainProxy = JSON.parse(JSON.stringify(toRaw(proxy.value))) as ProxySettings
    const response = await settingsApi.testProxy(plainProxy)
    if (response.success) {
      testStatus.value = 'success'
      testMessage.value = 'Proxy connection succeeded.'
    } else {
      testStatus.value = 'error'
      testMessage.value = response.error || 'Proxy connection failed.'
    }
  } catch (error: any) {
    testStatus.value = 'error'
    testMessage.value = error.message || 'Proxy connection failed.'
  } finally {
    isTesting.value = false
  }
}
</script>

<style scoped>
/*
 * Network tab — ledger 画线风.
 * Rows, inputs, and .test-btn are drawn by the SettingsPage :deep() layer; the
 * proxy toggle is a self-drawn `<Switch variant="ledger">`. Only layout and the
 * test-result ink live here.
 */
.tab-content {
  animation: fadeIn 0.15s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.test-btn {
  flex-shrink: 0;
  padding: 6px 12px;
  cursor: pointer;
}

/* Disabled = dashed line + faint ink, not an opacity veil. */
.test-btn:disabled {
  cursor: not-allowed;
  border-style: dashed;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
}

.test-result {
  margin-left: 10px;
  min-width: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.test-result.success {
  color: var(--ui-status-success-fg, var(--success));
}

.test-result.error {
  color: var(--ui-status-danger-fg, var(--danger));
}
</style>
