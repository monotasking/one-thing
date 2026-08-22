<template>
  <div class="tab-content">
    <SettingsSection
      title="Channels"
      description="Connect IM channels to onething sessions."
    >
      <SettingsGroup>
        <SettingRow
          label="WeChat"
          description="Incoming WeChat messages are routed through the normal onething session runtime."
        >
          <Switch
            variant="ledger"
            :model-value="wechatEnabled"
            aria-label="WeChat"
            @update:model-value="setWechatEnabled(Boolean($event))"
          />
        </SettingRow>

        <SettingRow
          layout="stack"
          label="WeChat accounts"
          :description="runtimeDescription"
        >
          <div class="wechat-account-settings">
            <div class="runtime-controls">
              <div class="channel-status">
                <span
                  class="status-pill"
                  :class="statusTone"
                >
                  {{ statusLabel }}
                </span>
                <span class="account-label">
                  {{ wechatAccounts.length }} account{{ wechatAccounts.length === 1 ? '' : 's' }}
                </span>
              </div>

              <div class="channel-actions">
                <Button
                  unstyled
                  class="channel-action primary"
                  native-type="button"
                  :disabled="isBusy"
                  @click="addWechatAccount"
                >
                  <UserPlus class="action-icon" />
                  <span>Add WeChat</span>
                </Button>
                <Button
                  unstyled
                  class="channel-action"
                  native-type="button"
                  :disabled="!isRunning && !isStarting"
                  @click="stopGateway"
                >
                  <Power class="action-icon" />
                  <span>Stop all</span>
                </Button>
                <Tooltip text="Refresh status">
                  <Button
                    unstyled
                    class="icon-action"
                    native-type="button"
                    :disabled="isBusy"
                    aria-label="Refresh status"
                    @click="loadStatus"
                  >
                    <RefreshCw class="action-icon" />
                  </Button>
                </Tooltip>
              </div>

              <p
                v-if="statusMessage"
                class="channel-message"
                :class="{ error: Boolean(status?.lastError) }"
              >
                {{ statusMessage }}
              </p>
            </div>

            <div class="wechat-account-list">
              <div
                v-for="account in wechatAccounts"
                :key="account.id"
                class="wechat-account-row"
              >
                <div class="wechat-account-header">
                  <div class="wechat-account-main">
                    <div class="wechat-account-title-row">
                      <span class="wechat-account-name">{{ accountLabel(account) }}</span>
                      <span
                        class="status-pill"
                        :class="accountStatusTone(account)"
                      >
                        {{ accountStatusLabel(account) }}
                      </span>
                    </div>
                    <div class="wechat-account-meta">
                      <span class="mono">{{ account.id }}</span>
                      <span v-if="account.botId">bot {{ account.botId }}</span>
                    </div>
                  </div>

                  <div class="channel-actions account-actions">
                    <Button
                      v-if="account.running"
                      unstyled
                      class="channel-action"
                      native-type="button"
                      :disabled="isBusy"
                      @click="stopWechatAccount(account.id)"
                    >
                      <Power class="action-icon" />
                      <span>Stop</span>
                    </Button>
                    <Button
                      v-else
                      unstyled
                      class="channel-action"
                      native-type="button"
                      :disabled="isBusy"
                      @click="startWechat(account.id)"
                    >
                      <Play class="action-icon" />
                      <span>Start</span>
                    </Button>
                    <Button
                      unstyled
                      class="channel-action"
                      native-type="button"
                      :disabled="isBusy"
                      @click="logoutWechat(account.id)"
                    >
                      <LogOut class="action-icon" />
                      <span>Re-scan</span>
                    </Button>
                    <Tooltip
                      v-if="account.id !== defaultWechatAccountId"
                      text="Remove account"
                    >
                      <Button
                        unstyled
                        class="icon-action danger"
                        native-type="button"
                        :disabled="isBusy"
                        aria-label="Remove account"
                        @click="removeWechatAccount(account.id)"
                      >
                        <Trash2 class="action-icon" />
                      </Button>
                    </Tooltip>
                  </div>
                </div>

                <p
                  v-if="accountStatusMessage(account)"
                  class="channel-message"
                  :class="{ error: Boolean(account.lastError || qrRenderErrors[account.id]) }"
                >
                  {{ accountStatusMessage(account) }}
                </p>

                <div
                  v-if="account.qrUrl"
                  class="qr-login-row"
                >
                  <div class="qr-code-box">
                    <img
                      v-if="qrDataUrls[account.id]"
                      class="qr-code-image"
                      :src="qrDataUrls[account.id]"
                      alt="WeChat login QR code"
                    >
                    <RefreshCw
                      v-else
                      class="qr-code-placeholder"
                    />
                  </div>
                  <div class="qr-url-row">
                    <Input
                      variant="ledger"
                      class="qr-url-input"
                      readonly
                      :model-value="account.qrUrl"
                    />
                    <Tooltip text="Copy login URL">
                      <Button
                        unstyled
                        class="icon-action"
                        native-type="button"
                        aria-label="Copy login URL"
                        @click="copyQrUrl(account)"
                      >
                        <Copy class="action-icon" />
                      </Button>
                    </Tooltip>
                    <Tooltip text="Open login URL">
                      <Button
                        unstyled
                        class="icon-action"
                        native-type="button"
                        aria-label="Open login URL"
                        @click="openQrUrl(account)"
                      >
                        <ExternalLink class="action-icon" />
                      </Button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection
      title="Profiles"
      description="Map channel users to memory profiles."
    >
      <SettingsGroup>
        <SettingRow
          layout="stack"
          label="User profiles"
          description="Each profile has its own memory workspace and last sent time."
        >
          <div class="profile-settings-content">
            <div class="profile-toolbar">
              <Input
                v-model="newProfileName"
                variant="ledger"
                class="profile-name-input"
                placeholder="New profile name"
                spellcheck="false"
                @keydown.enter.prevent="createProfile"
              />
              <Button
                unstyled
                class="channel-action"
                native-type="button"
                :disabled="profileBusy || !newProfileName.trim()"
                @click="createProfile"
              >
                <UserPlus class="action-icon" />
                <span>Create</span>
              </Button>
              <Button
                unstyled
                class="icon-action"
                native-type="button"
                :disabled="profileBusy"
                aria-label="Refresh profiles"
                @click="loadProfiles"
              >
                <RefreshCw class="action-icon" />
              </Button>
            </div>

            <div class="profile-list">
              <div
                v-for="profile in profiles"
                :key="profile.id"
                class="profile-row"
              >
                <div class="profile-main">
                  <div class="profile-title-row">
                    <span class="profile-name">{{ profile.name }}</span>
                    <span
                      v-if="profile.isMain"
                      class="status-pill success"
                    >
                      Main
                    </span>
                  </div>
                  <div class="profile-meta">
                    <span class="mono">{{ profile.id }}</span>
                    <span>{{ formatLastSent(profile.lastSentAt) }}</span>
                  </div>
                </div>
                <Tooltip text="Set as main profile">
                  <Button
                    unstyled
                    class="icon-action"
                    native-type="button"
                    :disabled="profileBusy || profile.isMain"
                    aria-label="Set as main profile"
                    @click="setMainProfile(profile.id)"
                  >
                    <Star class="action-icon" />
                  </Button>
                </Tooltip>
              </div>
            </div>
          </div>
        </SettingRow>

        <SettingRow
          layout="stack"
          label="Channel bindings"
          description="Bind a connector user id to a profile. New unbound channel users create their own profile automatically."
        >
          <div class="binding-settings-content">
            <div class="binding-form">
              <Select
                v-bind="LEDGER_SELECT"
                class="binding-select binding-profile-select"
                :model-value="binding.clientUserId"
                :options="profileOptions"
                aria-label="Binding profile"
                @update:model-value="binding.clientUserId = String($event)"
              />
              <Select
                v-bind="LEDGER_SELECT"
                class="binding-select connector-select"
                :model-value="binding.connector"
                :options="CONNECTOR_OPTIONS"
                aria-label="Binding connector"
                @update:model-value="binding.connector = String($event)"
              />
              <Select
                v-bind="LEDGER_SELECT"
                class="binding-select binding-small-input"
                :model-value="binding.workspaceId"
                :options="workspaceSelectOptions"
                aria-label="Binding workspace"
                @update:model-value="binding.workspaceId = String($event)"
              />
              <Select
                v-bind="LEDGER_SELECT"
                class="binding-select binding-user-input"
                :model-value="binding.externalUserId"
                :options="channelUserSelectOptions"
                :disabled="!channelUserOptions.length"
                aria-label="Binding channel user"
                @update:model-value="binding.externalUserId = String($event)"
              />
              <Button
                unstyled
                class="channel-action"
                native-type="button"
                :disabled="profileBusy || !binding.clientUserId || !binding.externalUserId.trim()"
                @click="createBinding"
              >
                <Link2 class="action-icon" />
                <span>Bind</span>
              </Button>
            </div>

            <div class="binding-list">
              <div
                v-for="link in links"
                :key="link.id"
                class="binding-row"
              >
                <div class="binding-main">
                  <span class="binding-title">
                    {{ profileName(link.clientUserId) }}
                  </span>
                  <span class="binding-meta">
                    {{ link.connector }} / {{ link.workspaceId || 'default' }} / <span class="mono">{{ link.externalUserId }}</span>
                  </span>
                </div>
                <Tooltip text="Remove binding">
                  <Button
                    unstyled
                    class="icon-action"
                    native-type="button"
                    :disabled="profileBusy"
                    aria-label="Remove binding"
                    @click="deleteBinding(link.id)"
                  >
                    <Trash2 class="action-icon" />
                  </Button>
                </Tooltip>
              </div>
              <p
                v-if="!links.length"
                class="channel-message empty-message"
              >
                No channel bindings yet.
              </p>
            </div>

            <p
              v-if="profileMessage"
              class="channel-message"
            >
              {{ profileMessage }}
            </p>
          </div>
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection
      title="Sessions"
      description="Gateway chats use stable session IDs and appear with the rest of your chat history."
    >
      <SettingsGroup>
        <SettingRow
          label="Session name"
          description="New WeChat contacts are created as WeChat - user_id in the normal session list."
        >
          <span class="session-pattern">gateway:wechat:*</span>
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import Input from '@/components/common/Input.vue'
import Select from '@/components/common/Select.vue'
import Switch from '@/components/common/Switch.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SelectOptionLike } from '@/components/common/select'
import {
  Copy,
  ExternalLink,
  Link2,
  LogOut,
  Play,
  Power,
  RefreshCw,
  Star,
  Trash2,
  UserPlus,
} from 'lucide-vue-next'
import { toDataURL } from 'qrcode'
import type {
  AppSettings,
  ChannelUserLink,
  ChannelUserProfile,
  GatewayStatus,
} from '@/types'
import {
  SettingRow,
  SettingsGroup,
  SettingsSection,
} from './settings-primitives'
import { gatewayApi } from '@/platform/gateway-client'
import { platformApi } from '@/platform'
import { shellApi } from '@/platform/shell-domain-client'
import { channelIdentityApi } from '@/platform/channel-identity-client'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.channels')

const props = defineProps<{
  settings: AppSettings
}>()

const emit = defineEmits<{
  'update:settings': [settings: AppSettings]
}>()

const status = ref<GatewayStatus | null>(null)
const isBusy = ref(false)
const transientMessage = ref('')
const copiedQrAccountId = ref('')
const qrDataUrls = ref<Record<string, string>>({})
const qrRenderErrors = ref<Record<string, string>>({})
const profiles = ref<ChannelUserProfile[]>([])
const links = ref<ChannelUserLink[]>([])
const profileBusy = ref(false)
const profileMessage = ref('')
const newProfileName = ref('')
const binding = ref({
  connector: 'wechat',
  workspaceId: 'default',
  externalUserId: '',
  clientUserId: '',
})
let refreshTimer: ReturnType<typeof setInterval> | undefined
let copiedMessageTimer: ReturnType<typeof setTimeout> | undefined
const qrRenderIds = new Map<string, number>()
const qrRenderedForUrls = new Map<string, string>()
const qrRenderingForUrls = new Map<string, string>()
const defaultWechatAccountId = 'default'
const qrDarkColor = `#${'000000'}`
const qrLightColor = `#${'ffffff'}`
type WechatAccountStatus = NonNullable<GatewayStatus['wechatAccounts']>[number]

const wechatEnabled = computed(() => props.settings.channels?.wechat?.enabled === true)
const isStarting = computed(() => status.value?.starting === true)
const wechatAccounts = computed<WechatAccountStatus[]>(() => {
  const currentAccounts = status.value?.wechatAccounts
  if (currentAccounts?.length) {
    return currentAccounts.map(account => normalizeWechatAccountStatus(account, account.id))
  }
  if (status.value?.wechat) {
    return [normalizeWechatAccountStatus(status.value.wechat, defaultWechatAccountId)]
  }

  const configured = props.settings.channels?.wechat?.accounts
  if (configured?.length) {
    return configured.map(account => normalizeWechatAccountStatus({
      id: account.id,
      label: account.label,
      enabled: account.enabled,
      running: false,
      loginStatus: 'idle',
      loggedIn: false,
    }, account.id))
  }

  return [normalizeWechatAccountStatus({
    id: defaultWechatAccountId,
    enabled: wechatEnabled.value,
    running: false,
    loginStatus: 'idle',
    loggedIn: false,
  }, defaultWechatAccountId)]
})
const isRunning = computed(() =>
  status.value?.running === true || wechatAccounts.value.some(account => account.running),
)
const hasQrUrl = computed(() => wechatAccounts.value.some(account => Boolean(account.qrUrl)))
const hasAccountError = computed(() =>
  Boolean(status.value?.lastError || wechatAccounts.value.some(account => account.lastError)),
)

interface SelectOption {
  value: string
  label: string
}

/** Settings-area dropdown spelling; teleported because the tab body scrolls. */
const LEDGER_SELECT = {
  variant: 'ledger',
  size: 'small',
  teleported: true,
  fitInputWidth: true,
} as const

const CONNECTOR_OPTIONS: SelectOptionLike[] = [
  { value: 'wechat', label: 'WeChat' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'slack', label: 'Slack' },
]

interface ObservedChannelUser {
  connector: string
  workspaceId: string
  externalUserId: string
}

function workspaceValue(value?: string): string {
  const trimmed = value?.trim()
  return trimmed || 'default'
}

function parseChannelProfile(profile: ChannelUserProfile): ObservedChannelUser | null {
  if (!profile.connector || !profile.externalUserId) return null
  return {
    connector: profile.connector,
    workspaceId: workspaceValue(profile.workspaceId),
    externalUserId: profile.externalUserId,
  }
}

const observedChannelUsers = computed<ObservedChannelUser[]>(() => {
  const byKey = new Map<string, ObservedChannelUser>()
  const add = (user: ObservedChannelUser) => {
    byKey.set(`${user.connector}:${user.workspaceId}:${user.externalUserId}`, user)
  }

  for (const link of links.value) {
    add({
      connector: link.connector,
      workspaceId: workspaceValue(link.workspaceId),
      externalUserId: link.externalUserId,
    })
  }
  for (const profile of profiles.value) {
    const user = parseChannelProfile(profile)
    if (user) add(user)
  }
  return [...byKey.values()]
})

const workspaceOptions = computed<SelectOption[]>(() => {
  const values = new Set<string>(['default'])
  if (binding.value.connector === 'wechat') {
    for (const account of wechatAccounts.value) {
      values.add(workspaceValue(account.id))
    }
  }
  for (const user of observedChannelUsers.value) {
    if (user.connector === binding.value.connector) {
      values.add(workspaceValue(user.workspaceId))
    }
  }
  return [...values].sort((left, right) => {
    if (left === 'default') return -1
    if (right === 'default') return 1
    return left.localeCompare(right)
  }).map(value => ({
    value,
    label: value === 'default' ? 'Default' : value,
  }))
})

const channelUserOptions = computed<SelectOption[]>(() => {
  const workspaceId = workspaceValue(binding.value.workspaceId)
  return observedChannelUsers.value
    .filter(user => user.connector === binding.value.connector && workspaceValue(user.workspaceId) === workspaceId)
    .map(user => ({
      value: user.externalUserId,
      label: user.externalUserId,
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
})

/* The binding form's four dropdowns are `<Select>`; `SelectOptionLike` is the
   shape it normalizes, and the empty channel-user row stays a real option so
   the closed control still reads "No channel users". */
const profileOptions = computed<SelectOptionLike[]>(() => (
  profiles.value.map(profile => ({ value: profile.id, label: `${profile.name} (${profile.id})` }))
))

const workspaceSelectOptions = computed<SelectOptionLike[]>(() => (
  workspaceOptions.value.map(option => ({ value: option.value, label: option.label }))
))

const channelUserSelectOptions = computed<SelectOptionLike[]>(() => (
  channelUserOptions.value.length === 0
    ? [{ value: '', label: 'No channel users' }]
    : channelUserOptions.value.map(option => ({ value: option.value, label: option.label }))
))

watch([workspaceOptions, channelUserOptions], () => {
  if (!workspaceOptions.value.some(option => option.value === binding.value.workspaceId)) {
    binding.value.workspaceId = 'default'
  }
  if (!channelUserOptions.value.some(option => option.value === binding.value.externalUserId)) {
    binding.value.externalUserId = channelUserOptions.value[0]?.value || ''
  }
}, { immediate: true })

const statusLabel = computed(() => {
  const current = status.value
  if (!current) return wechatEnabled.value ? 'Unknown' : 'Off'
  if (hasAccountError.value) return 'Error'
  if (current.starting && hasQrUrl.value) return 'Waiting for scan'
  if (current.starting) return 'Starting'
  if (wechatAccounts.value.some(account => account.running && account.loggedIn)) return 'Running'
  if (wechatAccounts.value.some(account => account.running || account.qrUrl)) return 'Waiting for login'
  if (wechatAccounts.value.some(account => account.loggedIn)) return 'Logged in'
  if (!wechatEnabled.value) return 'Off'
  return 'Idle'
})

const statusTone = computed(() => {
  if (hasAccountError.value) return 'error'
  if (wechatAccounts.value.some(account => account.loggedIn || account.running)) return 'success'
  if (status.value?.starting || hasQrUrl.value) return 'pending'
  if (!wechatEnabled.value) return 'muted'
  return 'muted'
})

const runtimeDescription = computed(() => {
  if (isRunning.value) return 'WeChat is running inside the Electron gateway runtime.'
  if (!wechatEnabled.value) return 'Start will enable WeChat and request a login URL.'
  if (hasQrUrl.value) return 'Scan or open the current iLink login URL.'
  if (wechatAccounts.value.some(account => account.loggedIn)) return 'WeChat login is available for incoming messages.'
  return 'Start the runtime to request a WeChat login URL.'
})

const statusMessage = computed(() => {
  if (transientMessage.value) return transientMessage.value
  const error = status.value?.lastError
  if (error) return error
  return ''
})

watch(wechatAccounts, accounts => {
  void renderQrCodes(accounts)
}, { deep: true })

function normalizeWechatAccountStatus(
  account: Partial<WechatAccountStatus> & { id?: string; accountId?: string },
  fallbackId: string,
): WechatAccountStatus {
  const id = account.id || account.accountId || fallbackId || defaultWechatAccountId
  return {
    id,
    label: account.label,
    accountId: account.accountId || id,
    enabled: account.enabled ?? wechatEnabled.value,
    running: account.running ?? false,
    loginStatus: account.loginStatus || 'idle',
    loggedIn: account.loggedIn ?? false,
    qrUrl: account.qrUrl,
    botId: account.botId,
    baseUrl: account.baseUrl,
    lastError: account.lastError,
    lastUpdatedAt: account.lastUpdatedAt,
  }
}

function accountLabel(account: WechatAccountStatus): string {
  return account.label?.trim() || (account.id === defaultWechatAccountId ? 'Default WeChat' : account.id)
}

function accountStatusLabel(account: WechatAccountStatus): string {
  if (account.lastError) return 'Error'
  if (account.running && account.loggedIn) return 'Running'
  if (account.qrUrl || account.loginStatus === 'waiting-for-scan') return 'Waiting for scan'
  if (account.loginStatus === 'scanned') return 'Scanned'
  if (account.loginStatus === 'expired') return 'Expired'
  if (account.loggedIn) return 'Logged in'
  if (!account.enabled) return 'Off'
  return 'Idle'
}

function accountStatusTone(account: WechatAccountStatus): string {
  if (account.lastError) return 'error'
  if (account.running || account.loggedIn) return 'success'
  if (account.qrUrl || account.loginStatus === 'waiting-for-scan' || account.loginStatus === 'scanned') return 'pending'
  return 'muted'
}

function accountStatusMessage(account: WechatAccountStatus): string {
  if (account.lastError) return account.lastError
  if (qrRenderErrors.value[account.id]) return qrRenderErrors.value[account.id]
  if (copiedQrAccountId.value === account.id) return 'Login URL copied.'
  if (account.qrUrl && !qrDataUrls.value[account.id]) return 'Rendering login QR code.'
  if (account.qrUrl) return 'A login URL is ready.'
  return ''
}

async function renderQrCodes(
  accounts = wechatAccounts.value,
  options: { force?: boolean } = {},
): Promise<void> {
  const accountIds = new Set(accounts.map(account => account.id))
  for (const accountId of Object.keys(qrDataUrls.value)) {
    if (!accountIds.has(accountId)) clearQrState(accountId)
  }

  await Promise.all(accounts.map(account => {
    if (!account.qrUrl) {
      clearQrState(account.id)
      return Promise.resolve()
    }
    return renderQrCode(account.id, account.qrUrl, options)
  }))
}

async function renderQrCode(
  accountId: string,
  value: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const url = value.trim()
  if (!url) {
    clearQrState(accountId)
    return
  }

  if (!options.force && qrDataUrls.value[accountId] && qrRenderedForUrls.get(accountId) === url) return
  if (!options.force && qrRenderingForUrls.get(accountId) === url) return

  const renderId = (qrRenderIds.get(accountId) || 0) + 1
  qrRenderIds.set(accountId, renderId)
  qrRenderingForUrls.set(accountId, url)
  delete qrRenderErrors.value[accountId]
  if (qrRenderedForUrls.get(accountId) !== url) delete qrDataUrls.value[accountId]

  try {
    const dataUrl = await toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 208,
      color: {
        dark: qrDarkColor,
        light: qrLightColor,
      },
    })
    if (renderId === qrRenderIds.get(accountId)) {
      qrDataUrls.value[accountId] = dataUrl
      qrRenderedForUrls.set(accountId, url)
      qrRenderingForUrls.delete(accountId)
    }
  } catch (error) {
    if (renderId === qrRenderIds.get(accountId)) {
      delete qrDataUrls.value[accountId]
      qrRenderedForUrls.delete(accountId)
      qrRenderingForUrls.delete(accountId)
      qrRenderErrors.value[accountId] = 'Could not render the login QR code. Copy or open the login URL instead.'
    }
    log.error('wechat qr render failed', {}, error)
  }
}

function clearQrState(accountId: string): void {
  qrRenderIds.set(accountId, (qrRenderIds.get(accountId) || 0) + 1)
  delete qrDataUrls.value[accountId]
  delete qrRenderErrors.value[accountId]
  qrRenderedForUrls.delete(accountId)
  qrRenderingForUrls.delete(accountId)
}

onMounted(() => {
  void loadStatus()
  void loadProfiles()
  refreshTimer = setInterval(() => {
    void loadStatus()
  }, 2_000)
})

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  if (copiedMessageTimer) clearTimeout(copiedMessageTimer)
})

function setWechatEnabled(enabled: boolean): void {
  const accounts = getWechatSettingsAccounts().map(account => ({
    ...account,
    enabled: enabled ? account.enabled : false,
  }))
  emit('update:settings', {
    ...props.settings,
    channels: {
      ...props.settings.channels,
      wechat: {
        ...props.settings.channels?.wechat,
        enabled,
        accounts,
      },
    },
  })
}

async function loadStatus(): Promise<void> {
  const response = await gatewayApi.getStatus({})
  if (response.success && response.status) {
    status.value = response.status
    await renderQrCodes(statusAccounts(response.status))
  }
}

async function loadProfiles(): Promise<void> {
  profileBusy.value = true
  profileMessage.value = ''
  try {
    const [profileResponse, linkResponse] = await Promise.all([
      channelIdentityApi.listProfiles({}),
      channelIdentityApi.listLinks({}),
    ])
    if (profileResponse.success) {
      profiles.value = profileResponse.profiles || []
      if (!binding.value.clientUserId && profiles.value[0]) {
        binding.value.clientUserId = profiles.value[0].id
      }
    } else {
      profileMessage.value = profileResponse.error || 'Failed to load profiles.'
    }
    if (linkResponse.success) {
      links.value = linkResponse.links || []
    } else if (!profileMessage.value) {
      profileMessage.value = linkResponse.error || 'Failed to load channel bindings.'
    }
  } finally {
    profileBusy.value = false
  }
}

async function createProfile(): Promise<void> {
  const name = newProfileName.value.trim()
  if (!name) return
  profileBusy.value = true
  profileMessage.value = ''
  try {
    const response = await channelIdentityApi.createProfile({ name })
    if (!response.success) {
      profileMessage.value = response.error || 'Failed to create profile.'
      return
    }
    newProfileName.value = ''
    await loadProfiles()
  } finally {
    profileBusy.value = false
  }
}

async function setMainProfile(id: string): Promise<void> {
  profileBusy.value = true
  profileMessage.value = ''
  try {
    const response = await channelIdentityApi.updateProfile({ id, isMain: true })
    if (!response.success) {
      profileMessage.value = response.error || 'Failed to update profile.'
      return
    }
    await loadProfiles()
  } finally {
    profileBusy.value = false
  }
}

async function createBinding(): Promise<void> {
  const externalUserId = binding.value.externalUserId.trim()
  if (!binding.value.clientUserId || !externalUserId) return
  profileBusy.value = true
  profileMessage.value = ''
  try {
    const response = await channelIdentityApi.createLink({
      connector: binding.value.connector,
      workspaceId: workspaceValue(binding.value.workspaceId),
      externalUserId,
      clientUserId: binding.value.clientUserId,
    })
    if (!response.success) {
      profileMessage.value = response.error || 'Failed to create channel binding.'
      return
    }
    binding.value.externalUserId = ''
    await loadProfiles()
  } finally {
    profileBusy.value = false
  }
}

async function deleteBinding(id: string): Promise<void> {
  profileBusy.value = true
  profileMessage.value = ''
  try {
    const response = await channelIdentityApi.deleteLink({ id })
    if (!response.success) {
      profileMessage.value = response.error || 'Failed to remove channel binding.'
      return
    }
    await loadProfiles()
  } finally {
    profileBusy.value = false
  }
}

function profileName(profileId: string): string {
  return profiles.value.find(profile => profile.id === profileId)?.name || profileId
}

function formatLastSent(timestamp?: number): string {
  if (!timestamp) return 'Never sent'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function statusAccounts(nextStatus: GatewayStatus): WechatAccountStatus[] {
  if (nextStatus.wechatAccounts?.length) {
    return nextStatus.wechatAccounts.map(account => normalizeWechatAccountStatus(account, account.id))
  }
  return [normalizeWechatAccountStatus(nextStatus.wechat, defaultWechatAccountId)]
}

function getWechatSettingsAccounts(): Array<{ id: string; label?: string; enabled: boolean }> {
  const configured = props.settings.channels?.wechat?.accounts || []
  if (configured.length) {
    return configured.map(account => ({
      id: account.id || defaultWechatAccountId,
      label: account.label,
      enabled: account.enabled,
    }))
  }
  return [{
    id: defaultWechatAccountId,
    enabled: wechatEnabled.value,
  }]
}

function updateWechatSettingsAccounts(
  accounts: Array<{ id: string; label?: string; enabled: boolean }>,
  enabled = true,
): void {
  const byId = new Map<string, { id: string; label?: string; enabled: boolean }>()
  for (const account of accounts) {
    const id = workspaceValue(account.id)
    byId.set(id, {
      id,
      label: account.label,
      enabled: account.enabled,
    })
  }
  if (!byId.size) {
    byId.set(defaultWechatAccountId, {
      id: defaultWechatAccountId,
      enabled,
    })
  }

  emit('update:settings', {
    ...props.settings,
    channels: {
      ...props.settings.channels,
      wechat: {
        ...props.settings.channels?.wechat,
        enabled,
        accounts: [...byId.values()],
      },
    },
  })
}

function upsertWechatSettingsAccount(account: { id: string; label?: string }, enabled = true): void {
  const accounts = getWechatSettingsAccounts()
  const existing = accounts.find(item => item.id === account.id)
  if (existing) {
    existing.label = account.label ?? existing.label
    existing.enabled = enabled
  } else {
    accounts.push({
      id: account.id,
      label: account.label,
      enabled,
    })
  }
  updateWechatSettingsAccounts(accounts, true)
}

function setWechatSettingsAccountEnabled(accountId: string, enabled: boolean): void {
  const accounts = getWechatSettingsAccounts()
  const existing = accounts.find(item => item.id === accountId)
  if (existing) {
    existing.enabled = enabled
  } else {
    accounts.push({
      id: accountId,
      enabled,
    })
  }
  updateWechatSettingsAccounts(accounts, true)
}

function removeWechatSettingsAccount(accountId: string): void {
  updateWechatSettingsAccounts(
    getWechatSettingsAccounts().filter(account => account.id !== accountId),
    true,
  )
}

async function startWechat(accountId = defaultWechatAccountId): Promise<void> {
  upsertWechatSettingsAccount({ id: accountId }, true)
  await runGatewayAction(async () => gatewayApi.start({ channel: 'wechat', accountId }))
}

async function stopGateway(): Promise<void> {
  await runGatewayAction(async () => gatewayApi.stop({}))
}

async function stopWechatAccount(accountId: string): Promise<void> {
  setWechatSettingsAccountEnabled(accountId, false)
  await runGatewayAction(async () => gatewayApi.wechatStopAccount({ accountId }), { forceQr: true })
}

async function logoutWechat(accountId = defaultWechatAccountId): Promise<void> {
  await runGatewayAction(async () => gatewayApi.wechatLogout({ accountId }), { forceQr: true })
}

async function addWechatAccount(): Promise<void> {
  const response = await runGatewayAction(
    async () => gatewayApi.wechatAddAccount({}),
    { forceQr: true },
  )
  if (response?.success && response.account) {
    upsertWechatSettingsAccount({
      id: response.account.id,
      label: response.account.label,
    }, true)
  }
}

async function removeWechatAccount(accountId: string): Promise<void> {
  const response = await runGatewayAction(
    async () => gatewayApi.wechatRemoveAccount({ accountId }),
    { forceQr: true },
  )
  if (response?.success) {
    removeWechatSettingsAccount(accountId)
    clearQrState(accountId)
  }
}

async function runGatewayAction<T extends { success: boolean; status?: GatewayStatus; error?: string }>(
  action: () => Promise<T>,
  options: { forceQr?: boolean } = {},
): Promise<T | undefined> {
  isBusy.value = true
  transientMessage.value = ''
  try {
    const response = await action()
    if (response.status) {
      status.value = response.status
      await renderQrCodes(statusAccounts(response.status), { force: options.forceQr })
    }
    if (!response.success) transientMessage.value = response.error || 'Gateway request failed.'
    return response
  } finally {
    isBusy.value = false
  }
}

async function copyQrUrl(account: WechatAccountStatus): Promise<void> {
  const url = account.qrUrl?.trim()
  if (!url) return
  const result = await platformApi.writeClipboardText(url)
  if (!result.success) {
    transientMessage.value = result.error || 'Failed to copy login URL.'
    return
  }
  copiedQrAccountId.value = account.id
  if (copiedMessageTimer) clearTimeout(copiedMessageTimer)
  copiedMessageTimer = setTimeout(() => {
    if (copiedQrAccountId.value === account.id) copiedQrAccountId.value = ''
  }, 1500)
}

async function openQrUrl(account: WechatAccountStatus): Promise<void> {
  const url = account.qrUrl?.trim()
  if (!url) return
  const result = await shellApi.openExternal({ url })
  if (!result.success) {
    transientMessage.value = 'Failed to open login URL.'
  }
}
</script>

<style scoped>
.runtime-controls {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  width: 100%;
}

.channel-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
  max-width: 100%;
}

/* Status rings: outlined, zero fill — the line color is the state */
.status-pill {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 9px;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  border-radius: 999px;
  background: transparent;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: var(--type-meta-size);
  line-height: 1;
  white-space: nowrap;
}

.status-pill.success {
  border-color: var(--ui-status-success-fg, var(--ui-border-default-border));
  color: var(--ui-status-success-fg, var(--ui-text-primary-fg));
}

.status-pill.pending {
  border-color: var(--ui-status-warning-fg, var(--ui-border-default-border));
  color: var(--ui-status-warning-fg, var(--ui-text-primary-fg));
}

.status-pill.error {
  border-color: var(--ui-status-danger-fg, var(--ui-border-default-border));
  color: var(--ui-status-danger-fg, var(--ui-text-primary-fg));
}

.account-label {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-muted-fg);
  font-size: var(--type-meta-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-actions,
.qr-login-row,
.qr-url-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.qr-login-row {
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 16px;
}

.channel-actions {
  flex-wrap: wrap;
  max-width: 100%;
}

.channel-action,
.icon-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 30px;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  background: transparent;
  color: var(--settings-ink-2, var(--ui-text-primary-fg));
  font-size: var(--type-meta-size);
  transition: border-color var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.channel-action:hover:not(:disabled),
.icon-action:hover:not(:disabled) {
  border-color: var(--settings-ink-3, var(--ui-text-muted-fg));
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

.channel-action {
  padding: 0 10px;
}

/* Primary = accent line + accent ink, no fill */
.channel-action.primary {
  border-color: var(--settings-accent, var(--ui-accent-primary-fg));
  color: var(--settings-accent, var(--ui-accent-primary-fg));
}

.channel-action.primary:hover:not(:disabled) {
  border-color: var(--settings-accent, var(--ui-accent-primary-fg));
  color: var(--settings-accent, var(--ui-accent-primary-fg));
  box-shadow: inset 0 -2px 0 var(--settings-accent, var(--ui-accent-primary-fg));
}

.icon-action.danger {
  color: var(--ui-status-danger-fg, var(--ui-text-primary-fg));
}

.icon-action.danger:hover:not(:disabled) {
  border-color: var(--ui-status-danger-fg, var(--ui-text-primary-fg));
  color: var(--ui-status-danger-fg, var(--ui-text-primary-fg));
}

.icon-action {
  width: 32px;
  padding: 0;
}

.channel-action:disabled,
.icon-action:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.action-icon {
  width: 15px;
  height: 15px;
}

.channel-message {
  margin: 0;
  max-width: min(620px, 100%);
  color: var(--ui-text-muted-fg);
  font-size: var(--type-meta-size);
  line-height: 1.35;
}

.channel-message.error {
  color: var(--ui-status-danger-fg, var(--ui-text-primary-fg));
}

.profile-settings-content,
.wechat-account-settings,
.binding-settings-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  width: 100%;
}

.wechat-account-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  width: 100%;
}

.wechat-account-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px 0;
  border-top: 1px solid var(--settings-rule-soft, var(--ui-border-subtle-border, var(--ui-border-default-border)));
}

.wechat-account-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
  width: 100%;
}

.wechat-account-main {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.wechat-account-title-row,
.wechat-account-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.wechat-account-name {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-primary-fg);
  font-size: var(--type-body-size);
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wechat-account-meta {
  color: var(--ui-text-muted-fg);
  font-size: var(--type-meta-size);
  line-height: 1.3;
}

.account-actions {
  justify-content: flex-end;
}

.profile-toolbar,
.profile-row,
.binding-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.profile-toolbar,
.binding-settings-content {
  min-width: 0;
}

.profile-toolbar {
  flex-wrap: wrap;
}

.profile-name-input {
  flex: 1 1 220px;
  max-width: 360px;
  min-width: 0;
}

.profile-list,
.binding-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.profile-row,
.binding-row {
  min-height: 44px;
  padding: 8px 0;
  border-top: 1px solid var(--settings-rule-soft, var(--ui-border-subtle-border, var(--ui-border-default-border)));
}

.profile-main,
.binding-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.profile-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.profile-name,
.binding-title {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-primary-fg);
  font-size: var(--type-body-size);
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-meta,
.binding-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  color: var(--ui-text-muted-fg);
  font-size: var(--type-meta-size);
  line-height: 1.3;
}

.mono {
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.binding-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  width: 100%;
}

.binding-form > * {
  min-width: 0;
  max-width: 100%;
}

.binding-form .channel-action {
  box-sizing: border-box;
  height: 40px;
  min-height: 40px;
  padding-block: 0;
  line-height: 40px;
}

/* The four dropdowns are `<Select variant="ledger">`. Height on the component
   root only — the control is its single flex child and stretches to fill, so
   the row keeps one line without reaching inside the component to repaint it. */
.binding-select {
  height: 40px;
}

.binding-form .channel-action {
  width: 100%;
}

.binding-small-input,
.binding-user-input {
  min-width: 0;
}

.empty-message {
  padding: 2px 0 0;
}

/* QR frame: square rule; the QR image carries its own light quiet zone */
.qr-code-box {
  display: grid;
  flex: 0 0 auto;
  width: min(128px, 100%);
  aspect-ratio: 1;
  place-items: center;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  background: transparent;
}

.qr-code-image {
  width: 87.5%;
  max-width: 112px;
  aspect-ratio: 1;
  object-fit: contain;
}

.qr-code-placeholder {
  width: 28px;
  height: 28px;
  color: var(--ui-text-muted-fg);
}

.qr-url-row {
  flex: 1 1 auto;
  max-width: min(560px, 100%);
}

.qr-url-input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

.session-pattern {
  color: var(--ui-text-muted-fg);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

@media (max-width: 720px) {
  .binding-form {
    grid-template-columns: minmax(0, 1fr);
  }

  .profile-toolbar {
    align-items: stretch;
  }

  .profile-toolbar > * {
    flex-basis: 100%;
  }

  .profile-name-input {
    max-width: none;
  }

  .qr-login-row {
    flex-direction: column;
  }

  .qr-url-row {
    align-items: stretch;
    flex-wrap: wrap;
    width: 100%;
  }

  .qr-url-input {
    flex-basis: 100%;
  }
}
</style>
