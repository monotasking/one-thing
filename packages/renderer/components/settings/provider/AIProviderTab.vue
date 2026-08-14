<template>
  <div class="provider-tab-wrapper">
    <!-- Model ledger: every enabled provider's selected models in one table.
         ★ = global default; per-model tuning lives in the row drawer. -->
    <ModelLedgerSection
      :settings="settings"
      :providers="providers"
      @update:settings="$emit('update:settings', $event)"
    />

    <!-- Connections: one slim row per provider; expanding manages
         credentials and the provider's model catalog. -->
    <ConnectionsSection
      :settings="settings"
      :providers="providers"
      @update:settings="$emit('update:settings', $event)"
      @add-custom-provider="$emit('add-custom-provider')"
      @edit-custom-provider="$emit('edit-custom-provider', $event)"
    />

    <!-- 空间凭证(批 B3):非默认空间的密钥住在 workspaces/<id>/credentials.json,
         与上面那张 settings.ai 的表是两层,分开画。 -->
    <SpaceCredentialsPanel :providers="providers" />
  </div>
</template>

<script setup lang="ts">
import type { AppSettings, ProviderInfo } from '@/types'
import ModelLedgerSection from './ModelLedgerSection.vue'
import ConnectionsSection from './ConnectionsSection.vue'
import SpaceCredentialsPanel from './SpaceCredentialsPanel.vue'

defineProps<{
  settings: AppSettings
  providers: ProviderInfo[]
}>()

defineEmits<{
  'update:settings': [settings: AppSettings]
  'add-custom-provider': []
  'edit-custom-provider': [providerId: string]
}>()
</script>

<style scoped>
.provider-tab-wrapper {
  display: flex;
  flex-direction: column;
  gap: 28px;
  min-width: 0;
}
</style>
