<template>
  <div class="tab-content">
    <SettingsSection
      :title="store.activeProvider?.label ?? '网易云音乐'"
      description="配置完成后，直接在对话里让 AI 放歌、切歌、找歌。凭证只写入 CLI 自己的加密配置，本应用不保存。"
    >
      <SettingsGroup>
        <SettingRow
          label="启用音乐电台"
          description="总开关。关闭后电台完全休眠:不自动接续、不唤醒 DJ、AI 也开不了台。"
        >
          <Switch
            variant="ledger"
            :model-value="musicEnabled"
            aria-label="启用音乐电台"
            @update:model-value="onMusicEnabled(Boolean($event))"
          />
        </SettingRow>

        <SettingRow
          v-if="store.providers.length > 1"
          label="音乐服务"
          description="切换后当前电台节目单会清空，需按向导重新完成配置。"
        >
          <Select
            v-bind="LEDGER_SELECT"
            class="model-setting-select"
            :model-value="store.activeProviderId"
            :options="musicProviderOptions"
            :disabled="store.busy"
            aria-label="音乐服务"
            @update:model-value="onProviderChange(String($event))"
          />
        </SettingRow>

        <div class="music-status">
          <span
            class="state-pill"
            :class="{ on: store.isReady }"
          >{{ store.isReady ? '已就绪' : '未完成配置' }}</span>
          <p class="status-copy">
            {{ statusCopy }}
          </p>
        </div>

        <ol class="steps">
          <li
            v-for="step in steps"
            :key="step.id"
            :class="['step', { done: step.done, active: step.id === store.setupStage }]"
          >
            <span class="step-mark">{{ step.done ? '✓' : step.index }}</span>
            <span class="step-label">{{ step.label }}</span>
          </li>
        </ol>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection
      title="播放器"
      description="由谁真正出声。"
    >
      <SettingsGroup>
        <RadioGroup
          v-model="player"
          class="player-group"
          :disabled="store.busy"
          aria-label="播放器"
          @change="store.setPlayer($event as MusicPlayerBackend)"
        >
          <Radio
            class="player-row"
            value="mpv"
          >
            <strong>内置播放器（mpv）<span class="tag">推荐</span></strong>
            <template #description>
              由应用自己播。能读到播放进度，所以 AI 知道一首歌什么时候放完，可以接着聊、接着放。全平台可用。
            </template>
          </Radio>
          <Radio
            class="player-row"
            value="orpheus"
          >
            <strong>网易云音乐 App</strong>
            <template #description>
              交给本机的云音乐 App 播放。仅 macOS。队列归 App 管，所以应用里看不到播放进度，AI 也不知道当前放到哪。
            </template>
          </Radio>
        </RadioGroup>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection
      title="电台编排"
      description="DJ 编排回合（选歌、写串词）用哪个模型。这是后台工作，思考开关独立于对话。"
    >
      <SettingsGroup>
        <SettingRow label="Provider">
          <Select
            v-bind="LEDGER_SELECT"
            class="model-setting-select"
            :model-value="radioDjProvider"
            :options="radioDjProviderOptions"
            aria-label="电台编排 Provider"
            @update:model-value="onRadioDjProvider(String($event))"
          />
        </SettingRow>

        <SettingRow
          v-if="radioDjProvider"
          label="Model"
        >
          <Select
            v-bind="LEDGER_SELECT"
            class="model-setting-select"
            :model-value="radioDjModel"
            :options="radioDjModelOptions"
            :disabled="radioDjModels.length === 0"
            aria-label="电台编排 Model"
            @update:model-value="onRadioDjModel(String($event))"
          />
        </SettingRow>

        <SettingRow
          v-if="radioDjProvider"
          label="Think Mode"
          description="独立于对话的思考开关。编排不赶时间，开了串词通常更讲究。"
        >
          <Switch
            variant="ledger"
            :model-value="radioDjThinking"
            :disabled="!radioDjModel"
            aria-label="电台编排 Think Mode"
            @update:model-value="onRadioDjThinking(Boolean($event))"
          />
        </SettingRow>

        <SettingRow
          v-if="radioDjProvider && radioDjThinking"
          label="Thinking Effort"
        >
          <Select
            v-bind="LEDGER_SELECT"
            class="model-setting-select"
            :model-value="radioDjEffort"
            :options="thinkingEffortSelectOptions"
            aria-label="电台编排 Thinking Effort"
            @update:model-value="onRadioDjEffort(String($event) as ThinkingEffort)"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection
      v-if="store.setupStage === 'env'"
      title="运行环境"
      description="播放由音乐服务的官方命令行工具驱动。"
    >
      <SettingsGroup>
        <div
          v-for="tool in wizardTools"
          :key="tool.id"
          class="tool-row"
        >
          <span class="tool-name">{{ tool.label }}</span>
          <span
            v-if="env?.tools[tool.id]?.installed"
            class="tool-ok"
          >已安装 {{ env?.tools[tool.id]?.version }}</span>
          <button
            v-else
            class="link-btn"
            type="button"
            :disabled="store.busy || !installChannelAvailable(tool)"
            @click="store.installTool(tool.id)"
          >
            {{ installButtonLabel(tool) }}
          </button>
        </div>
        <pre
          v-if="store.installOutput"
          class="console"
        >{{ tailLines(store.installOutput, 6) }}</pre>
        <button
          class="primary-btn"
          type="button"
          :disabled="store.busy"
          @click="store.checkEnv()"
        >
          重新检测
        </button>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection
      v-else-if="store.setupStage === 'credentials'"
      title="服务凭证"
      description="在音乐服务的开放平台控制台获取（网易云:开放平台应用详情页）。"
    >
      <SettingsGroup>
        <label
          v-for="field in credentialFields"
          :key="field.key"
          class="field"
        >
          <span class="field-label">{{ field.label }}</span>
          <Input
            v-if="field.secret"
            v-model="credentialValues[field.key]"
            type="textarea"
            variant="ledger"
            class="field-textarea"
            spellcheck="false"
            :placeholder="field.placeholder"
          />
          <Input
            v-else
            v-model="credentialValues[field.key]"
            variant="ledger"
            spellcheck="false"
            :placeholder="field.placeholder"
          />
        </label>
        <button
          class="primary-btn"
          type="button"
          :disabled="store.busy || !credentialsComplete"
          @click="submitCredentials"
        >
          保存凭证
        </button>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection
      v-else-if="store.setupStage === 'login'"
      id="music-login-section"
      title="登录"
      :description="loginKind === 'qr-stdout' ? '用对应的音乐 App 扫描二维码。' : '完成音乐服务的登录。'"
    >
      <SettingsGroup>
        <!-- qr-stdout: the CLI hands us a login URL (via --background json);
             we draw the QR ourselves. Other login kinds are contract stubs. -->
        <template v-if="loginKind === 'qr-stdout'">
          <img
            v-if="qrDataUrl"
            class="qr-img"
            :src="qrDataUrl"
            alt="扫码登录"
          >
          <p
            v-else-if="store.loginStarting"
            class="hint"
          >
            正在生成二维码…
          </p>
          <p
            v-if="loginHint"
            class="hint login-hint"
          >
            {{ loginHint }}
          </p>
          <button
            v-if="loginClickableUrl"
            class="link-btn"
            type="button"
            @click="openLoginUrl"
          >
            扫码不便?在浏览器打开登录
          </button>
          <div class="btn-row">
            <button
              class="primary-btn"
              type="button"
              :disabled="store.busy"
              @click="store.startLogin()"
            >
              {{ qrDataUrl ? '重新生成' : '开始登录' }}
            </button>
            <button
              class="link-btn"
              type="button"
              @click="store.checkLogin()"
            >
              我已扫码
            </button>
          </div>
        </template>
        <template v-else>
          <div class="btn-row">
            <button
              class="primary-btn"
              type="button"
              :disabled="store.busy"
              @click="store.startLogin()"
            >
              开始登录
            </button>
            <button
              class="link-btn"
              type="button"
              @click="store.checkLogin()"
            >
              我已完成登录
            </button>
          </div>
        </template>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection
      v-else
      title="用法"
      description="电台由 AI 驱动，没有独立的播放器界面。"
    >
      <SettingsGroup>
        <ul class="usage">
          <li>「放首周杰伦的晴天」</li>
          <li>「来点适合写代码的音乐」</li>
          <li>「下一首」「暂停」「音量调到 30」</li>
          <li>「这首歌讲的是什么？」</li>
        </ul>
        <p class="hint">
          搜歌、推荐、歌词每天共 5000 次请求，播放控制不计入，正常听歌远够用。
        </p>
        <div class="btn-row">
          <button
            class="link-btn"
            type="button"
            :disabled="store.busy"
            @click="store.logout()"
          >
            退出登录
          </button>
        </div>
      </SettingsGroup>
    </SettingsSection>

    <ErrorNote
      v-if="store.lastError"
      class="error"
      :message="store.lastError"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { toDataURL } from 'qrcode'
import ErrorNote from '@/components/common/ErrorNote.vue'
import Radio from '@/components/common/Radio.vue'
import RadioGroup from '@/components/common/RadioGroup.vue'
import Select from '@/components/common/Select.vue'
import Input from '@/components/common/Input.vue'
import Switch from '@/components/common/Switch.vue'
import SettingsSection from './SettingsSection.vue'
import SettingsGroup from './SettingsGroup.vue'
import { SettingRow } from './settings-primitives'
import type { SelectOptionLike } from '@/components/common/select'
import type { MusicPlayerBackend } from '@/types'
import type { ThinkingEffort } from '@shared/ipc/providers'
import type { ToolCallModelSettings } from '@shared/ipc/tools'
import { shellApi } from '@/platform/shell-domain-client'
import { useMusicStore } from '@/stores/music'
import { useSettingsStore } from '@/stores/settings'
import { isProviderEnabledIn } from '@/stores/helpers/provider-model'

const store = useMusicStore()
const settingsStore = useSettingsStore()
/** 批 B9:provider 开关的空间覆盖(default 空间恒 undefined)。 */

// ---------------------------------------------------------------------------
// 电台编排模型(settings.music.radioDj):toolCallModel 的形制 —— 独立的
// provider/model/think。空 provider = 跟随会话默认。
// ---------------------------------------------------------------------------

/** Settings-area dropdown spelling; teleported because the tab body scrolls. */
const LEDGER_SELECT = {
  variant: 'ledger',
  size: 'small',
  teleported: true,
  fitInputWidth: true,
} as const

const thinkingEffortOptions: Array<{ value: ThinkingEffort; label: string }> = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X High' },
  { value: 'max', label: 'Max' },
]

const thinkingEffortSelectOptions: SelectOptionLike[] = [...thinkingEffortOptions]

const radioDj = computed(() => settingsStore.settings.music?.radioDj)

const musicEnabled = computed(() => settingsStore.settings.music?.enabled === true)

async function onMusicEnabled(enabled: boolean) {
  const current = settingsStore.settings
  const music = current.music ?? { enabled: false, provider: 'ncm-cli', source: 'fm' as const, configured: false }
  await settingsStore.saveSettings({ ...current, music: { ...music, enabled } })
}

function providerModelIds(providerId: string): string[] {
  if (!providerId) return []
  const config = settingsStore.settings.ai.providers[providerId]
  if (!config) return []
  if (config.selectedModels?.length) return config.selectedModels
  return config.model ? [config.model] : []
}

const configuredProviders = computed(() =>
  settingsStore.availableProviders.filter(provider => {
    // 批 B9:开关 per-space(第三参 = 空间覆盖,default 空间恒 undefined)。
    return isProviderEnabledIn(settingsStore.settings.ai.providers, provider.id)
      && providerModelIds(provider.id).length > 0
  }),
)

const radioDjProvider = computed(() => {
  const configured = radioDj.value?.providerId
  return configured && configuredProviders.value.some(provider => provider.id === configured)
    ? configured
    : ''
})

const radioDjModels = computed(() => providerModelIds(radioDjProvider.value))

/* Empty-state rows stay real options (they were `<option value="">` before), so
   the closed control keeps reading the same sentence when nothing is set up. */
const musicProviderOptions = computed<SelectOptionLike[]>(() => (
  store.providers.map(descriptor => ({ value: descriptor.id, label: descriptor.label }))
))

const radioDjProviderOptions = computed<SelectOptionLike[]>(() => [
  { value: '', label: '跟随会话默认' },
  ...configuredProviders.value.map(provider => ({ value: provider.id, label: provider.name })),
])

const radioDjModelOptions = computed<SelectOptionLike[]>(() => (
  radioDjModels.value.length === 0
    ? [{ value: '', label: '该 Provider 没有已选模型' }]
    : radioDjModels.value.map(model => ({
      value: model,
      label: settingsStore.getModelDisplayName(model) || model,
    }))
))

const radioDjModel = computed(() => {
  const configured = radioDj.value?.model
  if (configured && radioDjModels.value.includes(configured)) return configured
  return radioDjModels.value[0] || ''
})

const radioDjThinking = computed(() => radioDj.value?.thinking === true)

const radioDjEffort = computed<ThinkingEffort>(() => {
  const effort = radioDj.value?.thinkingEffort
  return thinkingEffortOptions.some(option => option.value === effort)
    ? (effort as ThinkingEffort)
    : 'medium'
})

async function updateRadioDj(patch: Partial<ToolCallModelSettings>) {
  const current = settingsStore.settings
  const music = current.music ?? { enabled: false, provider: 'ncm-cli', source: 'fm' as const, configured: false }
  await settingsStore.saveSettings({
    ...current,
    music: {
      ...music,
      radioDj: { ...music.radioDj, ...patch },
    },
  })
}

function onRadioDjProvider(providerId: string) {
  const models = providerModelIds(providerId)
  const providerConfig = settingsStore.settings.ai.providers[providerId]
  const model =
    providerConfig?.model && models.includes(providerConfig.model)
      ? providerConfig.model
      : models[0] || ''
  void updateRadioDj({ providerId, model: providerId ? model : '' })
}

function onRadioDjModel(model: string) {
  void updateRadioDj({ providerId: radioDjProvider.value, model })
}

function onRadioDjThinking(thinking: boolean) {
  void updateRadioDj({
    providerId: radioDjProvider.value,
    model: radioDjModel.value,
    thinking,
    thinkingEffort: radioDjEffort.value,
  })
}

function onRadioDjEffort(effort: ThinkingEffort) {
  void updateRadioDj({ thinkingEffort: effort })
}

const env = computed(() => store.state.env)

/** Mirrors the store so the radio reflects an externally changed config. */
const player = ref(store.playerBackend)
watch(() => store.playerBackend, value => { player.value = value })

// ---------------------------------------------------------------------------
// Descriptor-driven wizard: stages, tools, and credential fields all come
// from the active provider's descriptor; at N=1 this renders exactly the old
// NetEase wizard.
// ---------------------------------------------------------------------------

const STAGE_LABELS: Record<string, string> = {
  env: '环境',
  credentials: '凭证',
  login: '登录',
}

const wizardStages = computed(() =>
  (store.activeProvider?.setupStages ?? ['env', 'credentials', 'login', 'ready']).filter(
    stage => stage !== 'ready',
  ),
)

const wizardTools = computed(() =>
  (store.activeProvider?.tools ?? []).filter(
    tool => !tool.requiredWhenPlayerBackend || tool.requiredWhenPlayerBackend === player.value,
  ),
)

function installChannelAvailable(tool: { install: { npm?: string[]; brew?: string[] } }): boolean {
  if (tool.install.npm) return env.value?.npmAvailable === true
  if (tool.install.brew) return env.value?.brewAvailable === true
  return false
}

function installButtonLabel(tool: { install: { npm?: string[]; brew?: string[] } }): string {
  if (tool.install.npm) return env.value?.npmAvailable ? '安装' : '需要 npm'
  if (tool.install.brew) return env.value?.brewAvailable ? '安装' : '需要 Homebrew'
  return '手动安装'
}

const credentialFields = computed(() => store.activeProvider?.credentialFields ?? [])
const loginKind = computed(() => store.activeProvider?.loginKind ?? 'qr-stdout')
const credentialValues = ref<Record<string, string>>({})
const credentialsComplete = computed(() =>
  credentialFields.value.every(field => (credentialValues.value[field.key] ?? '').trim() !== ''),
)

const steps = computed(() => {
  const stage = store.setupStage
  const order = [...wizardStages.value, 'ready']
  const reached = order.indexOf(stage)
  return wizardStages.value.map((id, index) => ({
    id,
    index: index + 1,
    label: STAGE_LABELS[id] ?? id,
    done: order.indexOf(id) < reached,
  }))
})

async function onProviderChange(providerId: string) {
  if (providerId === store.activeProviderId) return
  await store.setProvider(providerId)
  credentialValues.value = {}
  await store.checkEnv()
}

const statusCopy = computed(() => {
  switch (store.setupStage) {
    case 'env':
      return '还需要安装 ncm-cli 与 mpv。'
    case 'credentials':
      return '还需要填入服务凭证。'
    case 'login':
      return '还需要扫码登录网易云音乐。'
    default:
      return '可以直接在对话里让 AI 放歌了。'
  }
})

/**
 * `login --background --output json` gives us `{qrCodeUrl, clickableUrl,
 * message}` as one JSON blob in loginOutput — we draw the QR from the URL
 * rather than scraping the CLI's (now TTY-only, ANSI-colour) terminal art.
 */
const loginPayload = computed<{ qrCodeUrl?: string; clickableUrl?: string; message?: string } | null>(() => {
  const output = store.loginOutput.trim()
  if (!output) return null
  try {
    return JSON.parse(output)
  } catch {
    return null
  }
})

const loginClickableUrl = computed(() => loginPayload.value?.clickableUrl || loginPayload.value?.qrCodeUrl || '')
const loginHint = computed(() => loginPayload.value?.message ?? '')

const qrDataUrl = ref('')
watch(
  () => loginPayload.value?.qrCodeUrl,
  async url => {
    if (!url) {
      qrDataUrl.value = ''
      return
    }
    try {
      qrDataUrl.value = await toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 208 })
    } catch {
      qrDataUrl.value = ''
    }
  },
)

function openLoginUrl() {
  const url = loginClickableUrl.value
  if (url) void shellApi.openExternal({ url })
}

/**
 * Background login finishes silently in a detached poller, so poll
 * `login --check` while the wizard sits on the login step; stop once it
 * advances (ready) or the tab unmounts. Arriving at the step also
 * generates the QR unprompted (the user came here to log in — making them
 * find a "开始登录" button first was field-reported as "the QR never came")
 * and scrolls the login section into view, since it sits below the fold.
 */
let loginPollTimer: ReturnType<typeof setInterval> | null = null
watch(
  () => store.setupStage,
  async stage => {
    if (loginPollTimer) {
      clearInterval(loginPollTimer)
      loginPollTimer = null
    }
    if (stage === 'login') {
      loginPollTimer = setInterval(() => {
        void store.checkLogin()
      }, 3_000)
      if (loginKind.value === 'qr-stdout' && !qrDataUrl.value && !store.loginStarting) {
        void store.startLogin()
      }
      await nextTick()
      document.getElementById('music-login-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  },
  { immediate: true },
)

function tailLines(text: string, count: number): string {
  return text.split('\n').filter(Boolean).slice(-count).join('\n')
}

async function submitCredentials() {
  // The wire keeps ncm's (appId, privateKey) shape — the descriptor renders
  // the fields, and today's only provider maps onto exactly these two keys.
  // A provider with a different credential shape extends the setup request
  // when it lands; inventing a generic envelope now would be guessing.
  const response = await store.setCredentials(
    (credentialValues.value.appId ?? '').trim(),
    (credentialValues.value.privateKey ?? '').trim(),
  )
  if (response.success) {
    // Never leave the key sitting in a DOM node once the CLI has taken it.
    credentialValues.value = {}
  }
}

onMounted(() => {
  void store.initialize().then(() => store.checkEnv())
})

onBeforeUnmount(() => {
  if (loginPollTimer) clearInterval(loginPollTimer)
})
</script>

<style scoped>
.tab-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-5, 20px);
}

.music-status {
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
}

.state-pill {
  align-self: flex-start;
  padding: 2px 8px;
  border: 1px solid var(--ui-border-default-border);
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.state-pill.on {
  border-color: var(--ui-status-success-fg, var(--color-success));
  color: var(--ui-status-success-fg, var(--color-success));
}

.status-copy {
  margin: 0;
  font-size: 13px;
  color: var(--ui-text-secondary-fg);
}

.steps {
  display: flex;
  gap: var(--space-4, 16px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.step.active {
  color: var(--ui-text-primary-fg);
}

.step.done {
  color: var(--ui-text-secondary-fg);
}

.step-mark {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-size: 10px;
}

/* Layout-only class on the Select roots — the paint is the ledger variant's. */
.model-setting-select {
  max-width: min(360px, 100%);
  min-width: 0;
}

/* P3: the two player choices are `<Radio>` inside a `<RadioGroup>` — the ring,
   the description ink and the disabled state are the component's. What is left
   here is row rhythm and the copy this file itself writes into the slots. */
.player-group {
  gap: 0;
}

.player-row {
  padding: 6px 0;
}

.player-row strong {
  font-weight: 500;
  color: var(--ui-text-primary-fg);
}

.tag {
  margin-left: 6px;
  padding: 1px 5px;
  border: 1px solid var(--ui-border-default-border);
  border-radius: 999px;
  font-size: 10px;
  font-weight: 400;
  color: var(--text-tertiary);
}

.tool-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  padding: 6px 0;
  font-size: 13px;
}

.tool-name {
  font-family: var(--font-mono);
  color: var(--ui-text-primary-fg);
}

.tool-ok {
  font-size: 12px;
  color: var(--text-tertiary);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 0;
}

.field-label {
  font-size: 12px;
  color: var(--ui-text-secondary-fg);
}

/* Credential fields: `<Input variant="ledger">` owns the paint; the secret
   textarea keeps its mono face locally. */
.field-textarea :deep(.app-input-textarea) {
  min-height: 96px;
  font-family: var(--font-mono);
  font-size: 11px;
}

.qr,
.console {
  margin: 0;
  padding: var(--space-2, 8px);
  overflow-x: auto;
  border: 1px solid var(--ui-border-subtle-border);
  border-radius: var(--radius-sm, 4px);
  font-family: var(--font-mono);
  white-space: pre;
}

.qr {
  font-size: 6px;
  line-height: 1;
}

/* No background/padding: the generated QR bakes in its own white quiet-zone
   (margin + light color), and a raw color here would break the semantic-token
   rule. */
.qr-img {
  display: block;
  width: 208px;
  height: 208px;
  border: 1px solid var(--ui-border-subtle-border);
  border-radius: var(--radius-sm, 4px);
}

.console {
  font-size: 11px;
  color: var(--text-tertiary);
}

.usage {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  color: var(--ui-text-secondary-fg);
}

.usage li {
  padding: 2px 0;
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

.login-hint {
  color: var(--ui-text-secondary-fg);
}

.btn-row {
  display: flex;
  gap: var(--space-2, 8px);
  align-items: center;
}

.primary-btn {
  align-self: flex-start;
  padding: 6px 12px;
  border: 1px solid var(--ui-border-strong-border);
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--ui-text-primary-fg);
  font-size: 13px;
  cursor: pointer;
}

.primary-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.link-btn {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ui-text-link-fg, var(--ui-text-secondary-fg));
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}

.link-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.error {
  margin: 0;
}
</style>
