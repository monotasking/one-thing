<template>
  <section class="conn-section">
    <div class="section-header-row">
      <h3 class="section-label">
        Connections
      </h3>
      <Button
        unstyled
        class="primary-action"
        native-type="button"
        @click="$emit('add-custom-provider')"
      >
        <span>+</span>
        Add provider
      </Button>
    </div>
    <!-- C2:自定义 provider 的**定义**也是这个空间自己的了(用户 08-18:
         「provider 设置应该是完整的、独立的两套」);钥匙同样跟着空间走,
         落在下面的凭证池里。全局只剩 models.dev 的目录缓存。 -->
    <p class="section-scope-note">
      provider 设置与密钥都按空间各自配置;模型目录缓存全空间共享。
    </p>

    <div class="conn-rows">
      <div
        v-for="card in connCards"
        :key="card.key"
        class="conn-row-block"
      >
        <div
          :class="['conn-row', { active: expandedKey === card.key }]"
          role="button"
          tabindex="0"
          :aria-expanded="expandedKey === card.key"
          @click="toggleCard(card)"
          @keydown.enter.prevent="toggleCard(card)"
          @keydown.space.prevent="toggleCard(card)"
        >
          <span class="conn-icon-tile">
            <ProviderIcon
              :provider="card.iconId"
              :size="16"
            />
            <span
              class="conn-status-dot"
              :class="isCardConnected(card) ? 'on' : 'off'"
            />
          </span>

          <span class="conn-main">
            <span class="conn-title">
              <span class="conn-name">{{ card.label }}</span>
              <span
                v-if="!card.family && card.members[0].requiresOAuth"
                class="conn-pill"
              >subscription</span>
              <span
                v-if="!card.family && providerSettings.isUserCustomProvider(card.members[0].id)"
                class="conn-pill"
              >custom</span>
            </span>
            <span class="conn-summary">{{ cardSummary(card) }}</span>
            <!-- 批 B9-0:把已有摘要('本空间未配置' / '本空间未登录')连到它的
                 可见性后果上 —— 模型选择器的三道闸对用户是静默的,开着却不出现
                 是最难自查的一种。 -->
            <span
              v-if="showsMissingCredentialNote(card)"
              class="conn-consequence"
            >本空间未配置凭证,不会出现在模型选择器</span>
          </span>

          <Button
            unstyled
            class="conn-action"
            native-type="button"
            :aria-label="`${expandedKey === card.key ? 'Collapse' : 'Expand'} ${card.label} settings`"
            @click.stop="toggleCard(card)"
          >
            Manage models
            <ChevronDown
              class="conn-action-icon"
              :class="{ expanded: expandedKey === card.key }"
              :size="13"
            />
          </Button>

          <Button
            v-if="!card.family && providerSettings.isUserCustomProvider(card.members[0].id)"
            unstyled
            class="conn-action"
            native-type="button"
            @click.stop="$emit('edit-custom-provider', card.members[0].id)"
          >
            Edit
          </Button>

          <Switch
            :model-value="isCardEnabled(card)"
            size="small"
            :aria-label="`${card.label} enabled`"
            @click.stop
            @change="toggleCardEnabled(card)"
          />
        </div>

        <Transition name="conn-detail">
          <div
            v-if="expandedKey === card.key && isViewingMember(card)"
            class="conn-detail"
            @click.stop
          >
            <!-- Family card: switch between the API and subscription channels.
                 Everything below keys off viewingProvider, so flipping the
                 channel re-scopes credentials and the model catalog. -->
            <div
              v-if="card.members.length > 1"
              class="channel-tabs"
              role="tablist"
              :aria-label="`${card.label} channels`"
            >
              <button
                v-for="member in card.members"
                :key="member.id"
                type="button"
                class="channel-tab"
                :class="{ active: providerSettings.viewingProvider.value === member.id }"
                role="tab"
                :aria-selected="providerSettings.viewingProvider.value === member.id"
                @click="switchChannel(member.id)"
              >
                {{ channelLabel(card, member) }}
                <span
                  v-if="isConnected(member.id)"
                  class="channel-tab-check"
                >✓</span>
              </button>
            </div>
            <!-- 非默认空间:凭证区换成本空间的凭证池(批 B7)。单条时它长得和
                 默认空间那两个输入框一样,多条才展开顺序/策略;OAuth 型画的是
                 「在本空间登录」。ACP / 本地 agent 不问凭证,不走这一支。 -->
            <div
              v-if="usesSpacePool && !providerSettings.isACPProvider?.value && !isLocalAgentProvider(activeMember(card).id)"
              class="settings-group"
            >
              <SpaceCredentialPool
                :provider-id="activeMember(card).id"
                :provider-name="activeMember(card).name"
                :oauth="providerSettings.isOAuthProvider.value"
              />

              <ProviderUsageCard
                v-if="providerUsage.shouldShow.value"
                :response="providerUsage.response.value"
                :is-loading="providerUsage.isLoading.value"
                :error="providerUsage.error.value"
                @refresh="providerUsage.refresh(true)"
              />
            </div>

            <!-- OAuth Provider Login -->
            <div
              v-else-if="providerSettings.isOAuthProvider.value"
              class="oauth-config-stack"
            >
              <AuthCard
                :provider-id="providerSettings.viewingProvider.value"
                :provider-name="activeMember(card).name"
                :oauth-status="providerSettings.oauthStatus.value"
                :is-loading="providerSettings.isOAuthLoading.value"
                :device-flow-info="providerSettings.deviceFlowInfo.value"
                :code-entry-info="providerSettings.codeEntryInfo.value"
                :manual-code="providerSettings.manualCode.value"
                :is-submitting-code="providerSettings.isSubmittingCode.value"
                :code-entry-error="providerSettings.codeEntryError.value"
                @start-login="providerSettings.startOAuthLogin"
                @logout="providerSettings.logoutOAuth"
                @update:manual-code="providerSettings.manualCode.value = $event"
                @submit-code="providerSettings.submitManualCode"
              />

              <ProviderUsageCard
                v-if="providerUsage.shouldShow.value"
                :response="providerUsage.response.value"
                :is-loading="providerUsage.isLoading.value"
                :error="providerUsage.error.value"
                @refresh="providerUsage.refresh(true)"
              />
            </div>

            <!-- ACP Agent Configuration -->
            <div
              v-else-if="providerSettings.isACPProvider?.value"
              class="settings-group"
            >
              <div class="settings-row">
                <span class="row-label">Connection</span>
                <div class="acp-connection-row">
                  <span
                    class="conn-pill"
                    :class="providerSettings.currentACPAgentState.value?.status === 'connected' ? 'green' : providerSettings.currentACPAgentState.value?.status === 'error' ? 'red' : ''"
                  >
                    {{ providerSettings.currentACPAgentState.value?.status || 'disconnected' }}
                  </span>
                  <Button
                    unstyled
                    class="mini-action"
                    native-type="button"
                    @click="providerSettings.connectACPAgent"
                  >
                    Connect
                  </Button>
                  <Button
                    unstyled
                    class="mini-action"
                    native-type="button"
                    @click="providerSettings.disconnectACPAgent"
                  >
                    Disconnect
                  </Button>
                  <Button
                    unstyled
                    class="mini-action"
                    native-type="button"
                    @click="providerSettings.refreshACPAgent"
                  >
                    Refresh
                  </Button>
                </div>
              </div>
              <div
                v-if="providerSettings.currentACPAgentState.value?.error"
                class="settings-row"
              >
                <span class="row-label">Error</span>
                <span class="row-note is-error">{{ providerSettings.currentACPAgentState.value.error }}</span>
              </div>
              <template v-if="providerSettings.currentACPAgent.value">
                <div class="settings-row">
                  <span class="row-label">Command</span>
                  <Input
                    :model-value="providerSettings.currentACPAgent.value.command"
                    type="text"
                    variant="ledger"
                    class="row-input"
                    :spellcheck="false"
                    aria-label="ACP command"
                    @update:model-value="providerSettings.updateACPAgent({ command: String($event) })"
                  />
                </div>
                <div class="settings-row">
                  <span class="row-label">Arguments</span>
                  <Input
                    :model-value="(providerSettings.currentACPAgent.value.args || []).join(' ')"
                    type="text"
                    variant="ledger"
                    class="row-input"
                    :spellcheck="false"
                    aria-label="ACP command arguments"
                    @update:model-value="providerSettings.updateACPArgs(String($event))"
                  />
                </div>
                <div class="settings-row">
                  <span class="row-label">Working dir</span>
                  <Input
                    :model-value="providerSettings.currentACPAgent.value.cwd || ''"
                    type="text"
                    variant="ledger"
                    class="row-input"
                    :spellcheck="false"
                    aria-label="ACP working directory"
                    @update:model-value="providerSettings.updateACPAgent({ cwd: String($event) })"
                  />
                </div>
                <div class="settings-row">
                  <span class="row-label">Permission</span>
                  <Select
                    variant="ledger"
                    size="small"
                    teleported
                    fit-input-width
                    class="row-select"
                    :model-value="providerSettings.currentACPAgent.value.permissionMode || 'allow'"
                    :options="ACP_PERMISSION_OPTIONS"
                    aria-label="ACP permission mode"
                    @update:model-value="providerSettings.updateACPAgent({ permissionMode: $event === 'reject' ? 'reject' : 'allow' })"
                  />
                </div>
                <div class="settings-row compact-toggle-row">
                  <span class="row-label">Client FS</span>
                  <Switch
                    :model-value="providerSettings.currentACPAgent.value.allowFileSystemAccess === true"
                    size="small"
                    aria-label="ACP file system access"
                    @change="providerSettings.updateACPAgent({ allowFileSystemAccess: Boolean($event) })"
                  />
                </div>
                <div class="settings-row compact-toggle-row">
                  <span class="row-label">Client terminal</span>
                  <Switch
                    :model-value="providerSettings.currentACPAgent.value.allowTerminalAccess === true"
                    size="small"
                    aria-label="ACP terminal access"
                    @change="providerSettings.updateACPAgent({ allowTerminalAccess: Boolean($event) })"
                  />
                </div>
              </template>
            </div>

            <!-- Local agent provider: no credentials, drives a local CLI -->
            <div
              v-else-if="isLocalAgentProvider(activeMember(card).id)"
              class="settings-group"
            >
              <div class="settings-row">
                <span class="row-label">Connection</span>
                <span class="row-note">Local CLI agent — uses your existing CLI login; no API key needed.</span>
              </div>
            </div>

            <!-- Traditional API Key Input.
                 行组本身住在 ProviderCredentialRows —— **非默认空间的凭证池渲染的是
                 同一个组件**(用户 08-18:「切空间只换数据、不换外观」)。 -->
            <div
              v-else
              class="settings-group"
            >
              <ProviderCredentialRows
                :provider-id="activeMember(card).id"
                :api-key="providerApiKeyInputValue(activeMember(card).id)"
                :api-key-placeholder="providerApiKeyPlaceholder(activeMember(card).id, activeMember(card).name)"
                :base-url="settings.ai.providers?.[activeMember(card).id]?.baseUrl || ''"
                :base-url-placeholder="providerSettings.getDefaultBaseUrl()"
                :api-mode="dialApiMode(activeMember(card).id)"
                :region="dialRegion(activeMember(card).id)"
                :env-badge="envBadge"
                @update:api-key="providerSettings.updateProviderApiKey"
                @update:base-url="providerSettings.updateProviderBaseUrl"
                @update:api-mode="updateDialApiMode(activeMember(card).id, $event)"
                @update:region="updateDialRegion(activeMember(card).id, $event)"
              />
            </div>

            <!-- Model catalog for this provider: checked models feed the ledger above -->
            <ProviderModels
              :models="providerSettings.availableModels.value"
              :filtered-models="providerSettings.filteredModels.value"
              :selected-count="providerSettings.currentSelectedModels.value.length"
              :selected-models-list="providerSettings.currentSelectedModels.value"
              :search-query="providerSettings.modelSearchQuery.value"
              :new-model-input="providerSettings.newModelInput.value"
              :is-loading="providerSettings.isLoadingModels.value"
              :error="providerSettings.modelError.value"
              :max-outputs="providerSettings.currentProviderMaxOutputs.value"
              :context-lengths="providerSettings.currentProviderContextLengths.value"
              :model-capabilities="providerSettings.currentProviderModelCapabilities.value"
              :rename-model="providerSettings.renameModel"
              :active-model-id="providerSettings.activeModelId.value"
              :is-model-selected="providerSettings.isModelSelected"
              :has-vision="providerSettings.hasVision"
              :has-image-generation="providerSettings.hasImageGeneration"
              :has-tools="providerSettings.hasTools"
              :has-reasoning="providerSettings.hasReasoning"
              :format-context-length="providerSettings.formatContextLength"
              @refresh="providerSettings.fetchModels(true)"
              @toggle="providerSettings.toggleModelSelection"
              @update:search-query="providerSettings.modelSearchQuery.value = $event"
              @update:new-model-input="providerSettings.newModelInput.value = $event"
              @add-custom="providerSettings.addCustomModel"
              @update-max-output="providerSettings.updateModelMaxOutput"
              @update-context-length="providerSettings.updateModelContextLength"
              @update-capability="providerSettings.updateModelCapability"
              @reset-capabilities="providerSettings.resetModelCapabilities"
              @select-active="providerSettings.setActiveModel"
            />
          </div>
        </Transition>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import Button from '@/components/common/Button.vue'
import Input from '@/components/common/Input.vue'
import Select from '@/components/common/Select.vue'
import Switch from '@/components/common/Switch.vue'

/* zhipu/qwen/kimi 的旋钮选项表搬进了 `provider-dials.ts` —— 那是全仓唯一一张,
   default 与空间凭证池共读(批 B10)。这里只留 ACP 自己那一格。 */
const ACP_PERMISSION_OPTIONS = [
  { value: 'allow', label: 'Allow' },
  { value: 'reject', label: 'Reject' },
]
import type { AppSettings, ProviderInfo } from '@/types'
import { providerFamilyOf, type ProviderFamily } from '@shared/provider-families'
import ProviderIcon from '../ProviderIcon.vue'
import AuthCard from './AuthCard.vue'
import ProviderUsageCard from './ProviderUsageCard.vue'
import ProviderModels from './ProviderModels.vue'
import ProviderCredentialRows from './ProviderCredentialRows.vue'
import SpaceCredentialPool from './SpaceCredentialPool.vue'
import { useProviderSettings } from './useProviderSettings'
import { useProviderUsage } from './useProviderUsage'

const props = defineProps<{
  settings: AppSettings
  providers: ProviderInfo[]
}>()

const emit = defineEmits<{
  'update:settings': [settings: AppSettings]
  'add-custom-provider': []
  'edit-custom-provider': [providerId: string]
}>()

const providerSettings = useProviderSettings(props, (event, value) => emit(event, value))

/**
 * 「当前空间的 provider 视图」(批 B7)—— 连接区不再直读 `settings.ai.providers[*]`
 * 的凭证字段。**连接区本身就是「当前空间的」连接区**:切到空间 B 打开设置,
 * 看到的就是 B 的 key / B 的登录态。用户 08-15 推翻了 B3 的独立面板路线
 * (「不是一个多余的新表单让你填,而是我切换 workspace 的时候它就自动切换过去了」)。
 *
 * C1 起视图只有一条数据路(default 也是普通空间),连接区因此不再有
 * `isDefaultSpace ? A : B`。
 */
const spaceView = providerSettings.spaceView

/**
 * 凭证区一律用池编辑器(C1)。唯一的例外是**后端答不上话**(web 端降级):
 * 那时没有空间维度可言,画一个永远写不进去的池编辑器比画不出来更糟。
 */
const usesSpacePool = computed(() => spaceView.spaceAvailable.value)

/**
 * 用量卡(批 B10 移交项 2)。C1 之前它只画在 OAuth 那一支里,而那一支在非默认
 * 空间根本不渲染 —— 于是切个空间用量卡就静默消失了。现在它按**本空间池里的
 * codex 账号**判定并查询。
 */
const providerUsage = useProviderUsage(
  providerSettings.viewingProvider,
  providerSettings.oauthStatus,
  {
    id: computed(() => spaceView.spaceId.value),
    loggedIn: computed(
      () => spaceView.credentialOf(providerSettings.viewingProvider.value).configured
        && spaceView.credentialOf(providerSettings.viewingProvider.value).oauth,
    ),
  },
)

/**
 * 三家旋钮的读/写适配(批 B10)。判据与写路仍是 `useProviderSettings` 里那三对
 * (它们顺手把派生出来的 baseUrl 一起落盘,这里不重复那件事);这一层只是把
 * 「哪个 provider 用哪一对」从模板里的三段 `v-if` 收成两个 switch。
 */
function dialApiMode(providerId: string): string | undefined {
  if (providerId === 'zhipu') return providerSettings.currentZhipuApiMode.value
  if (providerId === 'qwen') return providerSettings.currentQwenApiMode.value
  if (providerId === 'kimi') return providerSettings.currentKimiApiMode.value
  return undefined
}

function dialRegion(providerId: string): string | undefined {
  if (providerId === 'qwen') return providerSettings.currentQwenRegion.value
  if (providerId === 'kimi') return providerSettings.currentKimiRegion.value
  return undefined
}

function updateDialApiMode(providerId: string, value: unknown): void {
  const mode = String(value)
  if (providerId === 'zhipu') providerSettings.updateZhipuApiMode(mode)
  else if (providerId === 'qwen') providerSettings.updateQwenApiMode(mode)
  else if (providerId === 'kimi') providerSettings.updateKimiApiMode(mode)
}

function updateDialRegion(providerId: string, value: unknown): void {
  const region = String(value)
  if (providerId === 'qwen') providerSettings.updateQwenRegion(region)
  else if (providerId === 'kimi') providerSettings.updateKimiRegion(region)
}

/** 「这把 key 来自环境变量」的徽章。**只有 default 空间给得出** —— env 是机器级的,
    非默认空间严格隔离不吃它(B3 决策,B10 勘误 1 复核)。 */
const envBadge = computed(() =>
  providerSettings.currentProviderUsesEnvApiKey.value
    ? {
        varName: providerSettings.currentProviderEnvVarName.value,
        keyPreview: providerSettings.currentProviderEnvKeyPreview.value,
      }
    : null,
)

onMounted(() => {
  providerSettings.initialize()
})

onUnmounted(() => {
  providerSettings.cleanup()
})

const expandedKey = ref<string | null>(null)
const SERVER_REDACTED_SECRET = '__onething_server_secret_set__'

function isRedactedServerSecret(value: unknown): boolean {
  return value === SERVER_REDACTED_SECRET
}

/**
 * One row per vendor: family members (API + subscription channels of the same
 * vendor) collapse into a single card at the first member's list position.
 * Routing, billing, and persistence still see two providers — the merge is
 * purely presentational (see @shared/provider-families.ts).
 */
interface ConnCard {
  key: string
  label: string
  iconId: string
  members: ProviderInfo[]
  family: ProviderFamily | null
}

const connCards = computed<ConnCard[]>(() => {
  const cards: ConnCard[] = []
  const seen = new Set<string>()
  for (const provider of props.providers) {
    if (seen.has(provider.id)) continue
    const family = providerFamilyOf(provider.id)
    if (family) {
      const members = [family.apiProviderId, family.subscriptionProviderId]
        .map(id => props.providers.find(p => p.id === id))
        .filter((p): p is ProviderInfo => Boolean(p))
      if (members.length > 1) {
        for (const member of members) seen.add(member.id)
        cards.push({
          key: family.id,
          label: family.label,
          iconId: family.apiProviderId,
          members,
          family,
        })
        continue
      }
    }
    seen.add(provider.id)
    cards.push({
      key: provider.id,
      label: provider.name,
      iconId: provider.id,
      members: [provider],
      family: null,
    })
  }
  return cards
})

function channelLabel(card: ConnCard, member: ProviderInfo): string {
  if (!card.family) return member.name
  return member.requiresOAuth ? card.family.subscriptionTag : 'API'
}

function isCardConnected(card: ConnCard): boolean {
  return card.members.some(member => isConnected(member.id))
}

function isCardEnabled(card: ConnCard): boolean {
  return card.members.some(member => providerSettings.isProviderEnabled(member.id))
}

function toggleCardEnabled(card: ConnCard) {
  providerSettings.setProvidersEnabled(
    card.members.map(member => member.id),
    !isCardEnabled(card),
  )
}

function cardSummary(card: ConnCard): string {
  if (!card.family) return connectionSummary(card.members[0].id)
  return card.members
    .map(member => `${channelLabel(card, member)} ${isConnected(member.id) ? '✓' : '—'}`)
    .join(' · ')
}

/**
 * 「开着,但这个空间没凭证」——只有非 default 空间才谈得上(default 空间的
 * 凭证源就是 settings.ai,没有「本空间未配置」这一态)。
 */
function showsMissingCredentialNote(card: ConnCard): boolean {
  if (!usesSpacePool.value) return false
  return isCardEnabled(card) && !isCardConnected(card)
}

function isViewingMember(card: ConnCard): boolean {
  return card.members.some(member => member.id === providerSettings.viewingProvider.value)
}

function activeMember(card: ConnCard): ProviderInfo {
  return (
    card.members.find(member => member.id === providerSettings.viewingProvider.value) ??
    card.members[0]
  )
}

async function toggleCard(card: ConnCard) {
  if (expandedKey.value === card.key) {
    expandedKey.value = null
    return
  }
  const target =
    card.members.find(member => member.id === providerSettings.viewingProvider.value) ??
    card.members.find(member => isConnected(member.id)) ??
    card.members[0]
  await providerSettings.switchViewingProvider(target.id)
  expandedKey.value = card.key
}

async function switchChannel(memberId: string) {
  if (providerSettings.viewingProvider.value === memberId) return
  await providerSettings.switchViewingProvider(memberId)
}

/** Credential-free local agent providers (claude-code-agent, …): the CLI
 * carries its own login, so the card never asks for an API key. */
function isLocalAgentProvider(providerId: string): boolean {
  if (providerId === 'acp') return false
  const provider = props.providers.find(p => p.id === providerId)
  return Boolean(provider && provider.requiresApiKey === false && !provider.requiresOAuth)
}

/**
 * 「配好了没有」——**当前空间**口径。default 空间下视图内部就是今天那套判据
 * (key / env / baseUrl / OAuth),非 default 空间问的是凭证池里有没有可用条目。
 */
function isConnected(providerId: string): boolean {
  return spaceView.isConfigured(providerId)
}

function connectionSummary(providerId: string): string {
  // 非默认空间:摘要来自凭证池(几把密钥 / 哪个账号 / 未配置),不看 settings。
  if (usesSpacePool.value) return spaceView.credentialOf(providerId).summary
  const config = props.settings.ai.providers?.[providerId]
  const provider = props.providers.find(p => p.id === providerId)
  const key = config?.apiKey?.trim()
  const envStatus = providerSettings.getProviderEnvStatus(providerId)
  const envVar = envStatus?.resolvedEnvVar
  const envPreview = envStatus?.keyPreview

  if (providerId === 'acp' || isLocalAgentProvider(providerId)) return 'Local agent'
  if (provider?.requiresOAuth) return 'Subscription · OAuth'
  if (isRedactedServerSecret(key)) return 'Key saved'
  if (providerSettings.providerUsesEnvApiKey(providerId)) {
    if (!envVar) return 'Env missing'
    return envPreview ? `Env ${envVar} · ${envPreview}` : `Env ${envVar}`
  }
  if (key) {
    const head = key.slice(0, Math.min(6, key.length))
    const tail = key.length > 10 ? key.slice(-4) : ''
    return tail ? `${head}••••${tail}` : `${head}••••`
  }
  if (config?.baseUrl) return 'Base URL set'
  return 'Not connected — expand to set up'
}

function providerApiKeyInputValue(providerId: string): string {
  const key = props.settings.ai.providers?.[providerId]?.apiKey || ''
  return isRedactedServerSecret(key) ? '' : key
}

function providerApiKeyPlaceholder(providerId: string, providerName: string): string {
  const key = props.settings.ai.providers?.[providerId]?.apiKey
  if (isRedactedServerSecret(key)) {
    return 'Existing key is saved on the server. Enter a new key to replace it.'
  }
  return `Enter ${providerName} key...`
}
</script>

<style scoped>
.conn-section {
  min-width: 0;
}

.section-header-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}

.section-header-row .section-label {
  flex: 1;
  margin: 0;
}

/* Layout only — the settings :deep() layer draws .primary-action as an accent-outlined block. */
.primary-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font: inherit;
  cursor: pointer;
}

.conn-rows {
  border-top: 2px solid var(--settings-ink, var(--ui-text-primary-fg));
  min-width: 0;
}

.conn-row-block + .conn-row-block {
  border-top: 1px solid var(--settings-rule-soft, var(--ui-border-subtle-border));
}

.conn-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 14px;
  width: 100%;
  min-height: 54px;
  padding: 10px 2px;
  cursor: pointer;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  transition: background var(--duration-fast) var(--ease-default);
}

.conn-row:hover {
  background: color-mix(in srgb, var(--settings-ink, var(--ui-text-primary-fg)) 4%, transparent);
}

.conn-row:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--settings-ink, var(--ui-text-primary-fg)) 24%, transparent);
  outline-offset: -2px;
}

.conn-icon-tile {
  position: relative;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  color: var(--settings-ink-2, var(--ui-text-secondary-fg));
}

/* Status dot: hollow ring when off, filled dot when connected (paper halo masks the tile edge). */
.conn-status-dot {
  position: absolute;
  right: -4px;
  bottom: -4px;
  width: 8px;
  height: 8px;
  border: 1px solid var(--settings-ink-4, var(--ui-text-muted-fg));
  border-radius: 50%;
  background: var(--settings-paper, var(--ui-surface-app-bg));
  box-shadow: 0 0 0 2px var(--settings-paper, var(--ui-surface-app-bg));
}

.conn-status-dot.on {
  border-color: var(--ui-status-success-fg);
  background: var(--ui-status-success-fg);
}

.conn-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.conn-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.conn-name {
  overflow: hidden;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-size: 13.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conn-pill {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  border-radius: 999px;
  background: transparent;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  line-height: 1.5;
  padding: 0 8px 1px;
  white-space: nowrap;
}

.conn-pill.green {
  border-color: var(--ui-status-success-border, var(--ui-status-success-fg));
  color: var(--ui-status-success-fg);
}

.conn-pill.red {
  border-color: var(--ui-status-danger-border, var(--ui-status-danger-fg));
  color: var(--ui-status-danger-fg, var(--color-danger));
}

.conn-summary {
  overflow: hidden;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conn-consequence {
  overflow: hidden;
  color: var(--ui-status-warning-fg, var(--settings-ink-4));
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Row actions as text: mono rhythm, hover pulls an accent underline. */
.conn-action,
.mini-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default);
}

.conn-action:hover,
.mini-action:hover {
  color: var(--settings-ink, var(--ui-text-primary-fg));
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--settings-accent, var(--ui-accent-primary-fg));
}

.conn-action:focus-visible,
.mini-action:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--settings-ink, var(--ui-text-primary-fg)) 24%, transparent);
  outline-offset: 2px;
}

.conn-action-icon {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  transition: transform var(--duration-fast) var(--ease-default);
}

.conn-action-icon.expanded {
  transform: rotate(180deg);
}

.conn-detail {
  padding: 12px 0 18px 16px;
  border-top: 1px dashed var(--settings-rule-soft, var(--ui-border-subtle-border));
}

/* Family channel switcher: mono text tabs on a hairline, active gets the accent underline. */
.channel-tabs {
  display: flex;
  gap: 20px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--settings-rule-soft, var(--ui-border-subtle-border));
}

.channel-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-bottom: -1px;
  padding: 2px 0 7px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default), border-color var(--duration-fast) var(--ease-default);
}

.channel-tab:hover {
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

.channel-tab.active {
  color: var(--settings-ink, var(--ui-text-primary-fg));
  border-bottom-color: var(--settings-accent, var(--ui-accent-primary-fg));
}

.channel-tab:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--settings-ink, var(--ui-text-primary-fg)) 24%, transparent);
  outline-offset: 2px;
}

.channel-tab-check {
  color: var(--ui-status-success-fg);
}

.conn-detail-enter-active,
.conn-detail-leave-active {
  overflow: hidden;
  transition: opacity var(--duration-normal) var(--ease-default), max-height var(--duration-normal) var(--ease-default), transform var(--duration-normal) var(--ease-default);
}

.conn-detail-enter-from,
.conn-detail-leave-to {
  max-height: 0;
  opacity: 0;
  transform: translateY(-6px);
}

.conn-detail-enter-to,
.conn-detail-leave-from {
  max-height: 2400px;
  opacity: 1;
  transform: translateY(0);
}

.oauth-config-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 14px;
}

/* .settings-group chrome (border/fill/radius) is zeroed by the settings :deep() layer. */
.settings-row {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) minmax(0, 2fr);
  align-items: center;
  gap: 24px;
}

.row-label {
  font-size: 14px;
  color: var(--settings-ink-2, var(--ui-text-primary-fg));
  flex-shrink: 0;
  font-weight: 520;
}

/* API Key 行与 env 徽章的样式随模板一起搬进了 ProviderCredentialRows。 */

.row-input {
  width: 100%;
  min-width: 0;
}

.row-select {
  width: 100%;
  min-width: 0;
}
/* Full-width note under the two selects it warns about. Deliberately NOT a
   settings-row: the row grid's control column inherits single-line ellipsis,
   which silently truncated this sentence mid-word. */
.row-note {
  overflow: visible;
  margin: 0;
  color: var(--settings-ink-3, var(--ui-text-secondary-fg));
  font-size: 12px;
  line-height: 1.5;
  text-overflow: clip;
  white-space: normal;
}

.acp-connection-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.row-note {
  min-width: 0;
  overflow: hidden;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-note.is-error {
  color: var(--ui-status-danger-fg, var(--color-danger));
}

.settings-row.compact-toggle-row {
  min-height: 44px;
  padding: 8px 0;
}

/*
 * common/Switch (.app-switch) is shared with non-settings surfaces (SchedulerPanelContent),
 * so its pill visuals are overridden here instead of in Switch.vue.
 * Ledger toggle: dashed rail + hollow ring when off; solid accent rail + filled dot when on.
 */
:deep(.app-switch .app-switch-core) {
  border: 0;
  border-radius: 0;
  background: transparent;
}

:deep(.app-switch .app-switch-core)::after {
  content: '';
  position: absolute;
  left: 1px;
  right: 1px;
  top: 50%;
  height: 0;
  border-top: 1px dashed var(--settings-rule, var(--ui-border-default-border));
  transition: border-color var(--duration-fast) var(--ease-default);
}

:deep(.app-switch.is-checked .app-switch-core) {
  border: 0;
  background: transparent;
}

:deep(.app-switch.is-checked .app-switch-core)::after {
  border-top-style: solid;
  border-top-color: color-mix(in srgb, var(--settings-accent, var(--ui-accent-primary-fg)) 65%, transparent);
}

:deep(.app-switch .app-switch-action) {
  left: 1px;
  width: 10px;
  height: 10px;
  border: 1px solid var(--settings-ink-4, var(--ui-text-muted-fg));
  border-radius: 50%;
  background: var(--settings-paper, var(--ui-surface-app-bg));
  box-shadow: none;
  overflow: hidden;
  z-index: 1;
}

:deep(.app-switch.is-checked .app-switch-action) {
  border-color: var(--settings-accent, var(--ui-accent-primary-fg));
  background: var(--settings-accent, var(--ui-accent-primary-fg));
  color: var(--settings-paper, var(--ui-surface-app-bg));
  transform: translate(calc(var(--app-switch-width) - 14px), -50%);
}

:deep(.app-switch .app-switch-core:focus-visible) {
  box-shadow: none;
  outline: 2px solid color-mix(in srgb, var(--settings-ink, var(--ui-text-primary-fg)) 24%, transparent);
  outline-offset: 2px;
}
.section-scope-note {
  margin: -2px 0 10px;
  font-size: 11px;
  color: var(--ui-text-muted);
}

</style>
