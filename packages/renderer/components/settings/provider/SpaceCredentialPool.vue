<template>
  <div class="space-pool">
    <!--
      单条态 = **与 default 空间同构**(用户 08-18 裁决:「同一张设置页,切空间只换
      数据、不换外观」)。同一个 `ProviderCredentialRows` / 同一个 `AuthCard`,
      同一组 aria-label,不出现「本空间」「凭证池」这类只在这一支存在的措辞 ——
      「当前是哪个空间」页面标题栏已经说过一次了。
    -->
    <template v-if="!showsPoolUi">
      <AuthCard
        v-if="oauth"
        :provider-id="providerId"
        :provider-name="providerName"
        :oauth-status="singleOAuthStatus"
        :is-loading="oauthBusy"
        :device-flow-info="authCardDeviceFlow"
        :code-entry-info="oauthCodeEntry"
        :manual-code="oauthCode"
        :is-submitting-code="busy"
        :code-entry-error="''"
        @start-login="startOAuthLogin"
        @logout="logoutSingleOAuth"
        @update:manual-code="oauthCode = String($event)"
        @submit-code="submitOAuthCode"
      />
      <ProviderCredentialRows
        v-else
        :provider-id="providerId"
        :api-key="rowsApiKey"
        :api-key-placeholder="rowsApiKeyPlaceholder"
        :base-url="rowsBaseUrl"
        base-url-placeholder="Base URL"
        :api-mode="rowsApiMode"
        :region="rowsRegion"
        :env-badge="null"
        @update:api-key="touchRow('apiKey', $event)"
        @update:base-url="touchRow('baseUrl', $event)"
        @update:api-mode="touchRow('apiMode', $event)"
        @update:region="touchRow('region', $event)"
      />

      <!-- 渐进披露:多条目/轮换是**能力**,不是必须先理解的概念。 -->
      <Button
        unstyled
        class="text-action pool-disclose"
        native-type="button"
        :disabled="busy"
        data-testid="pool-disclose"
        @click="poolExpanded = true"
      >
        {{ oauth ? '＋ 再登录一个账号' : '＋ 再添加一把 key' }}
      </Button>

      <p
        v-if="oauthMessage"
        class="pool-note"
      >
        {{ oauthMessage }}
      </p>
    </template>

    <template v-else>
      <div class="pool-head">
        <span class="pool-scope">本空间 · {{ spaceName }}</span>
        <span
          class="pool-state"
          :class="{ 'is-set': entries.length > 0 }"
        >{{ stateLabel }}</span>
        <Select
          v-if="entries.length > 1"
          v-bind="LEDGER_SELECT"
          class="pool-policy"
          :model-value="policy"
          :options="policyOptions"
          :aria-label="`${providerName} 轮换策略`"
          @update:model-value="changePolicy(String($event))"
        />
      </div>

      <p class="pool-note">
        {{ entries.length > 1 ? policyHint(policy) : scopeNote }}
      </p>

      <!--
      批 E:选中的插件策略此刻不可用(插件停用/卸载,或它被熔断降级)。
      **灰态而不是移除** —— 与触发式锚点、深链动作同规:说得清"它暂时不在",
      而不是让用户以为自己记错了。policy 字段一个字节都不改,插件回来自动生效。
    -->
      <p
        v-if="policyUnavailable"
        class="pool-note is-degraded"
        data-testid="policy-unavailable"
      >
        策略不可用,正在使用内置 failover。
      </p>

      <ul
        v-if="entries.length > 0"
        class="entry-list"
      >
        <li
          v-for="(entry, index) in entries"
          :key="entry.id"
          class="entry-row"
          :class="{ 'is-cooling': entry.cooling }"
        >
          <span
            v-if="entries.length > 1"
            class="entry-order"
          >{{ index + 1 }}</span>
          <span class="entry-label">{{ entry.label }}</span>
          <span class="entry-preview">{{ entry.preview }}</span>
          <span
            v-if="entry.cooling"
            class="entry-cooling"
          >冷却中 · {{ entry.coolingLabel }}</span>

          <span class="entry-actions">
            <Button
              v-if="entries.length > 1"
              unstyled
              class="pool-action is-icon"
              native-type="button"
              :disabled="busy || index === 0"
              aria-label="上移(顺序即优先级)"
              @click="move(entry.id, 'up')"
            >
              ↑
            </Button>
            <Button
              v-if="entries.length > 1"
              unstyled
              class="pool-action is-icon"
              native-type="button"
              :disabled="busy || index === entries.length - 1"
              aria-label="下移(顺序即优先级)"
              @click="move(entry.id, 'down')"
            >
              ↓
            </Button>
            <Button
              v-if="!oauth"
              unstyled
              class="pool-action"
              native-type="button"
              :disabled="busy"
              @click="toggleReplace(entry.id)"
            >
              {{ replacingId === entry.id ? '取消' : '换密钥' }}
            </Button>
            <Button
              unstyled
              class="pool-action is-danger"
              native-type="button"
              :disabled="busy || (!oauth && entries.length < 2)"
              @click="oauth ? logoutOAuth(entry.id) : remove(entry.id)"
            >
              {{ pendingDeleteId === entry.id
                ? (oauth ? '确认退出' : '确认删除')
                : (oauth ? '退出登录' : '删除') }}
            </Button>
          </span>

          <div
            v-if="replacingId === entry.id"
            class="entry-replace"
          >
            <Input
              :model-value="replaceDraft"
              type="password"
              show-password
              variant="ledger"
              class="pool-input"
              placeholder="新的 API Key(换 key 不换条目,账本归因不断线)"
              :spellcheck="false"
              :aria-label="`替换 ${entry.label} 的 API Key`"
              @update:model-value="replaceDraft = String($event)"
            />
            <Button
              unstyled
              class="pool-action"
              native-type="button"
              :disabled="busy || !replaceDraft.trim()"
              @click="replace(entry.id, entry.label)"
            >
              保存
            </Button>
          </div>
        </li>
      </ul>

      <!-- OAuth / 订阅型:本空间单独登录(批 B6)。token 不能跨空间复制。 -->
      <template v-if="oauth">
        <div class="pool-edit">
          <Input
            :model-value="draft.label"
            type="text"
            variant="ledger"
            class="pool-input is-label"
            placeholder="账号备注(可选)"
            :spellcheck="false"
            :aria-label="`${providerName} 新账号备注`"
            @update:model-value="draft.label = String($event)"
          />
          <Button
            unstyled
            class="pool-action"
            native-type="button"
            :disabled="busy || oauthBusy"
            @click="startOAuthLogin"
          >
            {{ oauthBusy ? '登录中…' : '登录' }}
          </Button>
        </div>

        <p
          v-if="oauthDevice"
          class="pool-note"
        >
          在打开的页面里输入验证码 <strong>{{ oauthDevice.userCode }}</strong>,完成后这里会自动刷新。
        </p>

        <div
          v-if="oauthCodeEntry"
          class="entry-replace"
        >
          <Input
            :model-value="oauthCode"
            type="text"
            variant="ledger"
            class="pool-input"
            :placeholder="oauthCodeEntry.instructions"
            :spellcheck="false"
            aria-label="粘贴授权页给出的验证码"
            @update:model-value="oauthCode = String($event)"
          />
          <Button
            unstyled
            class="pool-action"
            native-type="button"
            :disabled="busy || !oauthCode.trim()"
            @click="submitOAuthCode"
          >
            提交
          </Button>
        </div>

        <p
          v-if="oauthMessage"
          class="pool-note"
        >
          {{ oauthMessage }}
        </p>
      </template>

      <template v-else>
        <div class="pool-edit">
          <Input
            :model-value="draft.label"
            type="text"
            variant="ledger"
            class="pool-input is-label"
            placeholder="名称(可选)"
            :spellcheck="false"
            :aria-label="`${providerName} 新凭证名称`"
            @update:model-value="draft.label = String($event)"
          />
          <Input
            :model-value="draft.apiKey"
            type="password"
            show-password
            variant="ledger"
            class="pool-input"
            placeholder="添加一把本空间使用的 API Key"
            :spellcheck="false"
            :aria-label="`${providerName} API Key(本空间)`"
            @update:model-value="draft.apiKey = String($event)"
          />
          <Input
            :model-value="draft.baseUrl"
            type="text"
            variant="ledger"
            class="pool-input is-url"
            placeholder="Base URL(可选)"
            :spellcheck="false"
            :aria-label="`${providerName} Base URL(本空间)`"
            @update:model-value="draft.baseUrl = String($event)"
          />
          <Button
            unstyled
            class="pool-action"
            native-type="button"
            :disabled="busy || !draft.apiKey.trim()"
            @click="add"
          >
            {{ entries.length === 0 ? '保存' : '添加' }}
          </Button>
          <Button
            unstyled
            class="pool-action is-danger"
            native-type="button"
            :disabled="busy || entries.length === 0"
            @click="clear"
          >
            清除全部
          </Button>
        </div>
      </template>
    </template>

    <p
      v-if="error"
      class="pool-error"
    >
      {{ error }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { oauthApi } from '@/platform/oauth-client'
import Button from '@/components/common/Button.vue'
import Input from '@/components/common/Input.vue'
import Select from '@/components/common/Select.vue'
import type { SelectOptionLike } from '@/components/common/select'
import type { SpaceCredentialEntrySummary, SpaceCredentialsSummary } from '@/types'
import { useSpacesStore } from '@/stores/spaces'
import { useSpaceProvidersStore } from '@/stores/spaceProviders'
import AuthCard from './AuthCard.vue'
import ProviderCredentialRows from './ProviderCredentialRows.vue'
import type { OAuthStatus } from './useProviderAuth'

/**
 * 一个 provider 在**当前非默认空间**里的凭证池编辑器(批 B7)。
 *
 * 前身是 B3 的独立面板 `SpaceCredentialsPanel.vue`(整块表 × 全部 provider ×
 * 一个空间选择器)。用户 08-15 推翻了那条路线:
 * 「多空间的认证不是一个多余的新表单让你填,而是我切换 workspace 的时候,
 * 它就自动切换过去了」—— 所以那块面板退役,它的多条目/策略/OAuth 登录能力
 * **原样搬**进连接卡片,在非默认空间下顶替掉 settings 的那两个输入框。
 *
 * 单条时它长得就是「名称 + Key + Base URL + 保存」,与默认空间无异;
 * 多条时才展开顺序/策略那一套 —— 池是能力,不是必须先理解的概念。
 *
 * 密钥原文永不回读(B3 决策 8):排序/删除只传 id,密钥只有「添加」与「换密钥」
 * 两个入口往下走。
 */
const props = defineProps<{
  providerId: string
  providerName: string
  /** OAuth / 订阅型:画「登录」而不是 key 输入框。 */
  oauth: boolean
}>()

const LEDGER_SELECT = {
  variant: 'ledger',
  size: 'small',
  teleported: true,
  fitInputWidth: true,
} as const

/** 三种内置策略。文案要说清**语义**,不是给个英文名让人猜。 */
/** Select 的对象选项形状是带索引签名的 `SelectObjectValue`,这里跟上它。 */
interface PolicyOption { value: string; label: string; [key: string]: unknown }

const BUILTIN_POLICY_OPTIONS: PolicyOption[] = [
  { value: 'single', label: '只用第一条' },
  { value: 'priority-failover', label: '按序接力' },
  { value: 'round-robin', label: '轮流使用' },
]

const POLICY_HINTS: Record<string, string> = {
  single: '始终用最上面那条,不自动换 —— 它冷却时这个 provider 就停用。',
  'priority-failover': '从上往下取第一条可用的;配额耗尽或被限流会自动换下一条。顺序即优先级。',
  'round-robin': '每次请求轮换到下一条,把用量摊开;冷却中的条目自动跳过。',
}

function policyHint(policy: string): string {
  if (POLICY_HINTS[policy]) return POLICY_HINTS[policy]
  const strategy = spaceProviders.strategies.find(item => item.policy === policy)
  return strategy?.description
    || (strategy ? `由插件「${strategy.pluginId}」决定用哪一条(它看不到密钥内容)。` : POLICY_HINTS.single)
}

const spacesStore = useSpacesStore()
const spaceProviders = useSpaceProvidersStore()

const spaceId = computed(() => spaceProviders.spaceId)
const spaceName = computed(() => spacesStore.currentSpace.name)
const pool = computed(() => spaceProviders.poolOf(props.providerId))
const policy = computed(() => pool.value?.policy || 'single')

/**
 * 批 E:内置三条 + **注册表实时清单**里的插件策略。
 *
 * 用户存下的那条如果已经不在清单里(插件停用/卸载/被降级),仍然补一行进去 ——
 * 否则 Select 会显示成空的,用户看到的是"我的选择被吃了"。补进来的那一行带
 * 「不可用」后缀,与下面那句灰态说明一起,说得清它暂时不在。
 */
const policyOptions = computed<SelectOptionLike[]>(() => {
  const options: PolicyOption[] = [
    ...BUILTIN_POLICY_OPTIONS,
    ...spaceProviders.strategies.map(strategy => ({
      value: strategy.policy,
      label: strategy.title,
    })),
  ]
  const current = policy.value
  if (!options.some(option => option.value === current)) {
    options.push({ value: current, label: `${current}(不可用)` })
  }
  return options
})

/** 后端算好的判据(注册着 + 没被降级),渲染层不自己再判一遍。 */
const policyUnavailable = computed(() => pool.value?.policyUnavailable === true)

const busy = ref(false)
const error = ref<string | null>(null)
/** 正在改哪一条的密钥。null = 没有。 */
const replacingId = ref<string | null>(null)
const replaceDraft = ref('')
/**
 * 删除的两段式确认。密钥删掉从 UI 上找不回来,而 `window.confirm` 被 ui-gate
 * 禁掉、为一次确认起一个 Dialog 不划算 —— 就地把按钮变成「确认删除」最省。
 */
const pendingDeleteId = ref<string | null>(null)

const draft = reactive({ apiKey: '', baseUrl: '', label: '' })

/* ── 单条态(与 default 空间同构)────────────────────────────────────────────
 *
 * 用户 08-18:「同一张设置页,切空间只换数据、不换外观。」所以一把 key / 一个账号
 * 的时候,这里画的是 default 那两行(+ 旋钮行)本身 —— 同一个组件、同一组
 * aria-label。池的那一套(顺序、策略、冷却、灰态)是**渐进披露**出来的第二层。
 */

/** 用户点过「再添加一把」之后就不再收回去 —— 收回去等于把他刚打开的东西关掉。 */
const poolExpanded = ref(false)

const showsPoolUi = computed(() => poolExpanded.value || entries.value.length > 1)

const singleEntry = computed<SpaceCredentialEntrySummary | null>(() => {
  const list = pool.value?.entries ?? []
  return list.length === 1 ? list[0] : null
})

/**
 * 「用户改了但还没落盘」的那几格。**只记被碰过的字段** —— 后端那三格是 patch
 * 语义(缺席 = 沿用旧值),把没碰过的格子一起送过去,等于每存一次 key 就顺手
 * 用界面上的空值把端点清一遍。
 */
const pendingRows = reactive<{
  apiKey?: string
  baseUrl?: string
  apiMode?: string
  region?: string
}>({})

const rowsApiKey = computed(() => pendingRows.apiKey ?? '')

/** 已存的那把只报掩码 —— 密钥原文永不回读(B3 决策 8)。 */
const rowsApiKeyPlaceholder = computed(() => {
  const preview = singleEntry.value?.apiKeyPreview
  return preview ? `${preview} — 输入新的 key 可替换` : `Enter ${props.providerName} key...`
})

const rowsBaseUrl = computed(() => pendingRows.baseUrl ?? singleEntry.value?.baseUrl ?? '')
const rowsApiMode = computed(() => pendingRows.apiMode ?? singleEntry.value?.apiMode)
const rowsRegion = computed(() => pendingRows.region ?? singleEntry.value?.region)

let rowSaveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 改一格 = 攒进 `pendingRows` + 排一次落盘。**不是每个按键一次 IPC**:
 * 输入框逐字符触发,那样一把 key 能写十几次盘。
 */
function touchRow(field: 'apiKey' | 'baseUrl' | 'apiMode' | 'region', value: unknown): void {
  pendingRows[field] = String(value)
  if (rowSaveTimer) clearTimeout(rowSaveTimer)
  rowSaveTimer = setTimeout(() => {
    rowSaveTimer = null
    void flushRows()
  }, 400)
}

/**
 * 落盘。两支:已有那一条就 patch 它(**不带 key 也能改档位** —— B10 起后端
 * 允许),还没有条目就必须先等到一把 key,否则池里会多出一行永远用不了的东西。
 */
async function flushRows(): Promise<void> {
  const apiKey = pendingRows.apiKey?.trim()
  const entry = singleEntry.value
  const touched = (['apiKey', 'baseUrl', 'apiMode', 'region'] as const)
    .filter(field => pendingRows[field] !== undefined)
  if (touched.length === 0) return
  if (!entry && !apiKey) return
  const ok = await run(
    () => spacesStore.setCredential({
      id: spaceId.value,
      providerId: props.providerId,
      ...(entry ? { entryId: entry.id, label: entry.label } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(pendingRows.baseUrl !== undefined ? { baseUrl: pendingRows.baseUrl } : {}),
      ...(pendingRows.apiMode !== undefined ? { apiMode: pendingRows.apiMode } : {}),
      ...(pendingRows.region !== undefined ? { region: pendingRows.region } : {}),
    }),
    '保存失败',
  )
  if (!ok) return
  for (const field of touched) delete pendingRows[field]
}

/* AuthCard 要的那几格。B6 的登录流住在本组件里,这里只是把它的瞬时态摆成
   AuthCard 认识的形状 —— 登录卡在两种空间下是**同一张卡**。 */
const singleOAuthAccount = computed(() => (pool.value?.entries ?? [])[0])

const singleOAuthStatus = computed<OAuthStatus>(() => {
  const entry = singleOAuthAccount.value
  if (!entry?.hasOAuthToken) {
    return { isLoggedIn: false, ...(error.value ? { lastError: error.value } : {}) }
  }
  const expired = typeof entry.oauthExpiresAt === 'number' && entry.oauthExpiresAt <= Date.now()
  return {
    isLoggedIn: !expired,
    isExpired: expired,
    ...(typeof entry.oauthExpiresAt === 'number' ? { expiresAt: entry.oauthExpiresAt } : {}),
    ...(entry.oauthAccount ? { account: { email: entry.oauthAccount } } : {}),
    ...(error.value ? { lastError: error.value } : {}),
  }
})

const authCardDeviceFlow = computed(() =>
  oauthDevice.value
    ? { userCode: oauthDevice.value.userCode, verificationUri: oauthDevice.value.verificationUri }
    : null,
)

/** AuthCard 的 Disconnect 在 default 空间是**直接退**,这里也直接退(同构)。 */
async function logoutSingleOAuth(): Promise<void> {
  const entry = singleOAuthAccount.value
  if (!entry) return
  pendingDeleteId.value = entry.id
  await logoutOAuth(entry.id)
}

/* per-space OAuth 登录流的瞬时态(批 B6)。 */
const oauthBusy = ref(false)
const oauthDevice = ref<{ userCode: string; verificationUri: string; flowId?: string } | null>(null)
const oauthCodeEntry = ref<{ state: string; instructions: string } | null>(null)
const oauthCode = ref('')
const oauthMessage = ref<string | null>(null)

const scopeNote = computed(() =>
  props.oauth
    ? '登录授权(OAuth / 订阅)型 —— 账号不能跨空间复制,需要在本空间单独登录一次。'
    : '这把密钥只在本空间生效。本空间没配 = 未配置,不会去借默认空间的钥匙。',
)

interface EntryRow {
  id: string
  label: string
  preview: string
  cooling: boolean
  coolingLabel: string
}

/** 「还剩多久」——超过一天说天,免得报一个「1440 分钟」。 */
function describeRemaining(untilMs: number, now: number): string {
  const remaining = untilMs - now
  if (remaining <= 0) return '即将恢复'
  const minutes = Math.ceil(remaining / 60_000)
  if (minutes < 60) return `剩 ${minutes} 分钟`
  const hours = Math.ceil(minutes / 60)
  return hours < 24 ? `剩 ${hours} 小时` : `剩 ${Math.ceil(hours / 24)} 天`
}

function describeOAuthEntry(entry: SpaceCredentialEntrySummary, now: number): string {
  if (!entry.hasOAuthToken) return '未登录'
  const account = entry.oauthAccount ? `${entry.oauthAccount} · ` : ''
  if (typeof entry.oauthExpiresAt !== 'number') return `${account}已登录`
  return entry.oauthExpiresAt <= now
    ? `${account}已过期,需重新登录`
    : `${account}有效至 ${new Date(entry.oauthExpiresAt).toLocaleString()}`
}

const entries = computed<EntryRow[]>(() => {
  const now = Date.now()
  return (pool.value?.entries ?? []).map((entry) => {
    const cooling = typeof entry.cooldownUntil === 'number' && entry.cooldownUntil > now
    return {
      id: entry.id,
      label: entry.label,
      preview: entry.authType === 'oauth'
        ? describeOAuthEntry(entry, now)
        : (entry.apiKeyPreview || '未填密钥'),
      cooling,
      coolingLabel: cooling ? describeRemaining(entry.cooldownUntil as number, now) : '',
    }
  })
})

const stateLabel = computed(() => {
  const count = entries.value.length
  if (count === 0) return props.oauth ? '未登录' : '未配置'
  if (props.oauth) return count > 1 ? `${count} 个账号` : '已登录'
  return count > 1 ? `${count} 把密钥` : '已保存'
})

// 切空间 / 切 provider:所有瞬时态归零。留着上一条的「确认删除」是要出事的。
watch([spaceId, () => props.providerId], () => {
  resetTransientState()
  resetOAuthFlow()
  oauthMessage.value = null
  error.value = null
  draft.apiKey = ''
  draft.baseUrl = ''
  draft.label = ''
  poolExpanded.value = false
  if (rowSaveTimer) {
    clearTimeout(rowSaveTimer)
    rowSaveTimer = null
  }
  for (const field of ['apiKey', 'baseUrl', 'apiMode', 'region'] as const) {
    delete pendingRows[field]
  }
})

function resetTransientState(): void {
  replacingId.value = null
  replaceDraft.value = ''
  pendingDeleteId.value = null
}

function resetOAuthFlow(): void {
  oauthBusy.value = false
  oauthDevice.value = null
  oauthCodeEntry.value = null
  oauthCode.value = ''
}

function entryIds(): string[] {
  return (pool.value?.entries ?? []).map(entry => entry.id)
}

/** 所有写操作共用的一层壳:busy 闸 + 失败留话 + 成功把新摘要交回 store。 */
async function run(
  action: () => Promise<SpaceCredentialsSummary | null>,
  failure: string,
): Promise<boolean> {
  busy.value = true
  error.value = null
  try {
    const next = await action()
    if (!next) {
      error.value = spacesStore.lastError || failure
      return false
    }
    spaceProviders.applyCredentials(next)
    return true
  } finally {
    busy.value = false
  }
}

async function add(): Promise<void> {
  if (!draft.apiKey.trim()) return
  resetTransientState()
  const ok = await run(
    () => spacesStore.setCredential({
      id: spaceId.value,
      providerId: props.providerId,
      apiKey: draft.apiKey.trim(),
      baseUrl: draft.baseUrl.trim() || undefined,
      label: draft.label.trim() || undefined,
    }),
    '保存失败',
  )
  // 保存成功就清掉草稿:输入框里留着明文没有任何用处。
  if (ok) {
    draft.apiKey = ''
    draft.baseUrl = ''
    draft.label = ''
  }
}

function toggleReplace(entryId: string): void {
  pendingDeleteId.value = null
  replacingId.value = replacingId.value === entryId ? null : entryId
  replaceDraft.value = ''
}

async function replace(entryId: string, label: string): Promise<void> {
  const key = replaceDraft.value.trim()
  if (!key) return
  const ok = await run(
    () => spacesStore.setCredential({
      id: spaceId.value,
      providerId: props.providerId,
      apiKey: key,
      entryId,
      label,
    }),
    '保存失败',
  )
  if (ok) resetTransientState()
}

async function move(entryId: string, direction: 'up' | 'down'): Promise<void> {
  resetTransientState()
  const ids = entryIds()
  const index = ids.indexOf(entryId)
  const target = direction === 'up' ? index - 1 : index + 1
  if (index < 0 || target < 0 || target >= ids.length) return
  ;[ids[index], ids[target]] = [ids[target], ids[index]]
  await run(
    () => spacesStore.setCredentialPool({ id: spaceId.value, providerId: props.providerId, entryIds: ids }),
    '排序失败',
  )
}

async function remove(entryId: string): Promise<void> {
  if (pendingDeleteId.value !== entryId) {
    replacingId.value = null
    pendingDeleteId.value = entryId
    return
  }
  pendingDeleteId.value = null
  const ids = entryIds().filter(id => id !== entryId)
  // 后端拒绝空列表:删最后一条与「清除整段」是两个动作(批 D 勘误 10)。
  if (ids.length === 0) return
  await run(
    () => spacesStore.setCredentialPool({ id: spaceId.value, providerId: props.providerId, entryIds: ids }),
    '删除失败',
  )
}

async function changePolicy(policyValue: string): Promise<void> {
  resetTransientState()
  const ids = entryIds()
  if (ids.length === 0) return
  await run(
    () => spacesStore.setCredentialPool({
      id: spaceId.value,
      providerId: props.providerId,
      entryIds: ids,
      policy: policyValue,
    }),
    '切换策略失败',
  )
}

async function clear(): Promise<void> {
  resetTransientState()
  const ok = await run(
    () => spacesStore.clearCredential({ id: spaceId.value, providerId: props.providerId }),
    '清除失败',
  )
  if (ok) {
    draft.apiKey = ''
    draft.baseUrl = ''
    draft.label = ''
  }
}

/* ── per-space OAuth 登录(批 B6)──────────────────────────────────────────── */

/**
 * 登录完成的判据是「**池里多了一条带 token 的 oauth entry**」,不是 oauth 状态查询。
 *
 * 新登录那一刻还没有 entryId(它由后端在写入时分配),状态查询无从定位;而三种
 * 流程(device-code / pkce-callback / manual-pkce)的落地信号完全一致 —— 池里出现
 * 新条目。一个判据覆盖三条路。
 */
async function waitForNewOAuthEntry(
  knownIds: Set<string>,
  timeoutMs = 5 * 60_000,
  intervalMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await wait(intervalMs)
    const next = await spacesStore.getCredentials(spaceId.value)
    const list = next.providers[props.providerId]?.entries ?? []
    if (list.some(entry => entry.authType === 'oauth' && !knownIds.has(entry.id))) {
      spaceProviders.applyCredentials(next)
      return true
    }
  }
  return false
}

function oauthEntryIds(): Set<string> {
  return new Set(
    (pool.value?.entries ?? [])
      .filter(entry => entry.authType === 'oauth')
      .map(entry => entry.id),
  )
}

async function startOAuthLogin(): Promise<void> {
  resetTransientState()
  resetOAuthFlow()
  oauthMessage.value = null
  oauthBusy.value = true
  const known = oauthEntryIds()
  const label = draft.label.trim() || undefined

  try {
    const response = await oauthApi.start({
      providerId: props.providerId,
      spaceId: spaceId.value,
      ...(label ? { label } : {}),
    })
    if (!response.success) {
      oauthMessage.value = response.error || '登录未能开始'
      oauthBusy.value = false
      return
    }

    if (response.userCode && response.verificationUri) {
      oauthDevice.value = {
        userCode: response.userCode,
        verificationUri: response.verificationUri,
        flowId: response.flowId,
      }
      await pollDeviceFlow(response.flowId, response.pollIntervalMs ?? 5000)
      return
    }

    if (response.requiresCodeEntry) {
      oauthCodeEntry.value = {
        state: response.state || '',
        instructions: response.instructions || '把授权页给出的验证码粘贴到这里',
      }
      // 手输码这一支停在这里等用户,登录按钮解锁 —— 否则整块面板会被一个
      // 永远不会自己完成的流程锁住。
      oauthBusy.value = false
      return
    }

    const done = await waitForNewOAuthEntry(known)
    oauthMessage.value = done ? `${props.providerName} 已在本空间登录。` : '授权超时,请重试。'
    if (done) draft.label = ''
  } catch (err) {
    oauthMessage.value = err instanceof Error ? err.message : '登录失败'
  } finally {
    if (!oauthCodeEntry.value) oauthBusy.value = false
  }
}

async function pollDeviceFlow(flowId: string | undefined, intervalMs: number): Promise<void> {
  let delay = intervalMs
  for (let attempt = 0; attempt < 60; attempt++) {
    await wait(delay)
    const response = await oauthApi.devicePoll({
      providerId: props.providerId,
      flowId,
      spaceId: spaceId.value,
    })
    if (response.success && response.completed) {
      oauthDevice.value = null
      oauthMessage.value = '已在本空间登录。'
      draft.label = ''
      await spaceProviders.refresh()
      return
    }
    const status = response.pollStatus || response.error
    if (status === 'slow_down') {
      delay += 5000
      continue
    }
    if (status && status !== 'authorization_pending') {
      oauthDevice.value = null
      oauthMessage.value = `授权未完成:${status}`
      return
    }
  }
  oauthDevice.value = null
  oauthMessage.value = '授权超时,请重试。'
}

async function submitOAuthCode(): Promise<void> {
  const entry = oauthCodeEntry.value
  const code = oauthCode.value.trim()
  if (!entry || !code) return
  const label = draft.label.trim() || undefined
  busy.value = true
  try {
    const response = await oauthApi.callback({
      providerId: props.providerId,
      code,
      state: entry.state,
      spaceId: spaceId.value,
      ...(label ? { label } : {}),
    })
    if (!response.success) {
      oauthMessage.value = response.error || '验证码无效'
      return
    }
    oauthCodeEntry.value = null
    oauthCode.value = ''
    draft.label = ''
    oauthMessage.value = `${props.providerName} 已在本空间登录。`
    await spaceProviders.refresh()
  } finally {
    busy.value = false
  }
}

/**
 * 退出登录 = 删掉那一条 entry(同一 provider 的其他账号不动)。
 * 与删密钥同一条纪律:两段式就地确认,没有 Dialog、没有 `window.confirm`。
 */
async function logoutOAuth(entryId: string): Promise<void> {
  if (pendingDeleteId.value !== entryId) {
    pendingDeleteId.value = entryId
    return
  }
  pendingDeleteId.value = null
  busy.value = true
  error.value = null
  try {
    const response = await oauthApi.logout({
      providerId: props.providerId,
      spaceId: spaceId.value,
      entryId,
    })
    if (!response.success) {
      error.value = response.error || '退出失败'
      return
    }
    await spaceProviders.refresh()
  } finally {
    busy.value = false
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
</script>

<style scoped>
.space-pool {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  gap: var(--ui-space-2);
}

/* 披露小字。`.text-action` 是全局那条(styles/components.css),这里只管位置。 */
.pool-disclose {
  align-self: flex-start;
}

.pool-head {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  min-width: 0;
}

.pool-scope {
  font-size: var(--ui-font-size-sm);
  color: var(--ui-text-secondary);
  white-space: nowrap;
}

.pool-state {
  font-size: var(--ui-font-size-xs);
  color: var(--ui-text-tertiary);
}

.pool-state.is-set {
  color: var(--ui-text-secondary);
}

.pool-policy {
  min-width: 130px;
  margin-left: auto;
}

.pool-note {
  margin: 0;
  font-size: var(--ui-font-size-xs);
  color: var(--ui-text-tertiary);
  line-height: 1.6;
}

/* 批 E:策略灰态 —— 警示色而不是错误色。它不是一次失败,是"你选的那个暂时不在"。 */
.pool-note.is-degraded {
  color: var(--ui-status-warning-fg);
}

.pool-error {
  margin: 0;
  font-size: var(--ui-font-size-sm);
  color: var(--ui-status-danger-fg);
}

.entry-list {
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.entry-row {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  flex-wrap: wrap;
  min-width: 0;
  font-size: var(--ui-font-size-xs);
  color: var(--ui-text-secondary);
}

.entry-row.is-cooling {
  opacity: 0.7;
}

.entry-order {
  min-width: 1.4em;
  color: var(--ui-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.entry-label {
  color: var(--ui-text-primary);
}

.entry-preview {
  color: var(--ui-text-tertiary);
  font-family: var(--font-mono);
}

.entry-cooling {
  color: var(--ui-status-warning-fg);
}

.entry-actions {
  display: flex;
  align-items: center;
  gap: var(--ui-space-1);
  margin-left: auto;
}

.entry-replace {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  flex: 1 0 100%;
  padding-left: 1.4em;
}

.pool-edit {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  flex-wrap: wrap;
}

.pool-input {
  flex: 1 1 200px;
  min-width: 0;
}

.pool-input.is-url {
  flex: 1 1 160px;
}

.pool-input.is-label {
  flex: 0 1 120px;
}

.pool-action {
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

.pool-action.is-icon {
  padding: var(--ui-space-1);
  min-width: 1.8em;
}

.pool-action:hover:not(:disabled) {
  color: var(--ui-text-primary);
  border-color: var(--ui-border-default);
}

.pool-action:disabled {
  opacity: 0.45;
  cursor: default;
}

.pool-action.is-danger:hover:not(:disabled) {
  color: var(--ui-status-danger-fg);
  border-color: var(--ui-status-danger-fg);
}

.pool-action:focus-visible {
  outline: var(--ui-focus-ring-width) solid var(--ui-focus-ring-color);
  outline-offset: var(--ui-focus-ring-offset);
}
</style>
