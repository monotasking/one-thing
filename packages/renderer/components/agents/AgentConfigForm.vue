<template>
  <div class="agent-config-form">
    <div class="editor-scroll">
      <div class="editor-body">
        <label class="agent-field">
          <span class="field-label">Name</span>
          <input
            v-model="formName"
            class="ledger-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
          >
        </label>

        <!-- 身份:群聊花名册、消息署名、看板都读这两个字段。留空即不署身份。 -->
        <div class="agent-identity-row">
          <!-- maxlength 数的是 UTF-16 码元:👨‍💻 这类 ZWJ 组合要 5 个以上,卡太紧会打不出来。 -->
          <label class="agent-field agent-field-avatar">
            <span class="field-label">Avatar</span>
            <input
              v-model="formAvatar"
              class="ledger-input avatar-input"
              type="text"
              maxlength="16"
              autocomplete="off"
              spellcheck="false"
              placeholder="🤖"
            >
          </label>

          <!-- 图片头像。emoji 永远留着当回退(图片没了、别的纯文本行要用),
               所以这是"另加一层",不是"换掉那个输入框"。 -->
          <div class="agent-field agent-field-avatar-image">
            <span class="field-label">Picture</span>
            <div class="avatar-image-row">
              <AgentAvatar
                class="avatar-image-preview"
                :avatar="formAvatar"
                :avatar-image="formAvatarImage"
                :size="28"
              />
              <button
                class="text-action"
                type="button"
                :disabled="avatarImageBusy"
                @click="pickAvatarImage"
              >
                {{ avatarImageBusy ? '…' : (formAvatarImage ? 'replace' : 'choose') }}
              </button>
              <button
                v-if="formAvatarImage"
                class="text-action"
                type="button"
                :disabled="avatarImageBusy"
                @click="clearAvatarImage"
              >
                clear
              </button>
            </div>
            <input
              ref="avatarFileInputRef"
              class="avatar-file-input"
              type="file"
              accept="image/*"
              @change="onAvatarFileChosen"
            >
          </div>

          <label class="agent-field agent-field-title">
            <span class="field-label">Role</span>
            <input
              v-model="formTitle"
              class="ledger-input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="e.g. 产品经理"
            >
          </label>
        </div>

        <!-- 找 TA 说话的两个出口。执行会话不在这里:那是禁输入的基础设施
             视图(侧栏「执行现场」),从这儿点出去的一律是能说话的会话。
             草稿 agent 还没有 id,自然也还没有会话可开。
             右栏空间页不摆这一块 —— 资料块上已经有「发消息」。 -->
        <div
          v-if="showConversations && !isCreating && agent"
          class="agent-field agent-conversations"
        >
          <div class="prompt-header">
            <span class="field-label">Conversations</span>
            <Tooltip text="开一条只有你和 TA 的普通会话(可输入)">
              <button
                class="text-action"
                type="button"
                :disabled="openingChat"
                @click="openPrivateChat"
              >
                {{ openingChat ? '打开中…' : '私聊' }}
              </button>
            </Tooltip>
          </div>

          <p
            v-if="conversationError"
            class="field-hint"
          >
            {{ conversationError }}
          </p>

          <div class="agent-rooms">
            <span class="rooms-label">TA 的群聊</span>
            <p
              v-if="agentRooms.length === 0"
              class="field-hint"
            >
              还没有加入任何群聊。
            </p>
            <ol
              v-else
              class="agent-room-rows"
            >
              <li
                v-for="room in agentRooms"
                :key="room.id"
              >
                <button
                  class="agent-room-line"
                  type="button"
                  @click="emit('open-session', room.id)"
                >
                  <span class="agent-room-name">群「{{ room.name }}」</span>
                  <span
                    v-if="room.isPm"
                    class="agent-chip"
                  >PM</span>
                </button>
              </li>
            </ol>
          </div>
        </div>

        <div class="agent-field">
          <div class="prompt-header">
            <span class="field-label">System Prompt</span>
            <span class="prompt-counters">
              <span class="prompt-counter">{{ formPrompt.length }} chars</span>
              <span class="prompt-counter">{{ wordCount(formPrompt) }} words</span>
            </span>
          </div>

          <div class="prompt-templates">
            <span class="templates-label">templates</span>
            <button
              v-for="tpl in promptTemplates"
              :key="tpl.name"
              class="text-action template-action"
              type="button"
              @click="applyTemplate(tpl.prompt)"
            >
              {{ tpl.name }}
            </button>
          </div>

          <textarea
            v-model="formPrompt"
            class="ledger-textarea"
            rows="14"
            spellcheck="true"
            placeholder="Instruct the AI on how it should behave..."
          />
        </div>

        <div class="agent-field">
          <div class="prompt-header">
            <span class="field-label">Tools</span>
            <span class="prompt-counters">
              <span class="prompt-counter">{{ toolSummary }}</span>
            </span>
          </div>

          <div
            class="mode-switch"
            role="radiogroup"
            aria-label="Tool access"
          >
            <button
              class="mode-option"
              :class="{ 'is-on': followsGlobalTools }"
              type="button"
              role="radio"
              :aria-checked="followsGlobalTools"
              @click="setToolMode('global')"
            >
              follow global
            </button>
            <span class="mode-divider" />
            <button
              class="mode-option"
              :class="{ 'is-on': !followsGlobalTools }"
              type="button"
              role="radio"
              :aria-checked="!followsGlobalTools"
              @click="setToolMode('allowlist')"
            >
              allowlist
            </button>
          </div>

          <p class="field-hint">
            Work sessions always add the board tool — the collaboration protocol depends on it.
          </p>

          <template v-if="!followsGlobalTools">
            <p
              v-if="toolsLoading"
              class="field-hint"
            >
              loading tools…
            </p>
            <p
              v-else-if="toolChoices.length === 0"
              class="field-hint"
            >
              No tools available.
            </p>
            <div
              v-else
              class="tool-grid"
            >
              <button
                v-for="tool in toolChoices"
                :key="tool.id"
                class="tool-line"
                :class="{ 'is-on': isToolOn(tool.id) }"
                type="button"
                role="checkbox"
                :aria-checked="isToolOn(tool.id)"
                @click="onToggleTool(tool.id)"
              >
                <span class="tool-name">{{ tool.name }}</span>
                <span
                  v-if="tool.note"
                  class="tool-note"
                >{{ tool.note }}</span>
              </button>
            </div>
          </template>
        </div>

        <div class="agent-field">
          <span class="field-label">Model</span>

          <div class="model-row">
            <span class="model-row-label">provider</span>
            <Select
              v-bind="LEDGER_SELECT"
              :model-value="formModelProvider"
              :options="providerOptions"
              aria-label="Model provider"
              @update:model-value="formModelProvider = String($event ?? ''); onModelProviderChange()"
            />
            <Tooltip
              v-if="formModelProvider"
              text="Follow the session default again"
            >
              <button
                class="text-action"
                type="button"
                @click="clearModelBinding"
              >
                clear
              </button>
            </Tooltip>
          </div>

          <div class="model-row">
            <span class="model-row-label">model</span>
            <Select
              v-bind="LEDGER_SELECT"
              :model-value="formModelId"
              :options="modelOptions"
              :disabled="!formModelProvider"
              aria-label="Model"
              @update:model-value="formModelId = String($event ?? '')"
            />
          </div>

          <p
            v-if="modelWarning"
            class="field-hint"
          >
            {{ modelWarning }}
          </p>
        </div>

        <div class="agent-field">
          <span class="field-label">Boundaries</span>

          <div class="model-row">
            <span class="model-row-label">approvals</span>
            <Select
              v-bind="LEDGER_SELECT"
              :model-value="formPermissionMode"
              :options="permissionModeOptions"
              aria-label="Approvals"
              @update:model-value="formPermissionMode = String($event ?? '')"
            />
          </div>
          <p class="field-hint">
            {{ permissionModeHint }}
          </p>

          <div class="model-row">
            <span class="model-row-label">turns</span>
            <Select
              v-bind="LEDGER_SELECT"
              :model-value="formTurnBudget"
              :options="turnBudgetSelectOptions"
              aria-label="Turn budget"
              @update:model-value="formTurnBudget = String($event ?? '')"
            />
          </div>
          <p class="field-hint">
            Model round-trips this agent may spend on one run.
          </p>
        </div>

        <ErrorNote
          v-if="formError"
          class="ledger-error form-note"
          :message="formError"
        />
        <p
          v-else-if="formFeedback"
          class="ledger-note form-note"
        >
          {{ formFeedback }}
        </p>
      </div>
    </div>

    <div class="editor-footer">
      <button
        class="text-action"
        type="button"
        :disabled="saving"
        @click="onCancel"
      >
        cancel
      </button>
      <button
        class="text-action is-primary"
        type="button"
        :disabled="saving"
        @click="saveAgent"
      >
        {{ saving ? 'saving…' : 'save' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useConfirm } from '@/composables/useConfirm'
/**
 * Agent 配置表单 —— **唯一**一份(agent-space-workbench.md P0)。
 *
 * 管理页(AgentsPanelContent)与右栏空间页(AgentSpace)挂的是同一个组件,所以
 * "在右栏改了什么"和"在管理页改了什么"落到 agents.json 的是同一条路:字段、
 * 校验、save 载荷一个字都不分岔。宿主只负责给它一个 agent 和一块地方。
 *
 * 视觉在 `styles/agent-space.css`(`.agent-ledger` 前缀的普通表)—— 搬进子组件
 * 之后 scoped 样式够不到内部元素,那份表就是为此抽出来的。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { AgentDefinition } from '@/types'
import { useAgentsStore } from '@/stores/agents'
import { useSettingsStore } from '@/stores/settings'
import { useSessionsStore } from '@/stores/sessions'
import { useMediaStore } from '@/stores/media'
import { isProviderEnabledIn } from '@/stores/helpers/provider-model'
import { platformApi } from '@/platform'
import { providerFamilyDisplayName } from '@shared/provider-families'
import type { PermissionMode } from '@shared/ipc'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import { AVATAR_IMAGE_MAX_PX, downscaleImageToPngDataUrl } from '@/components/common/agent-avatar'
import ErrorNote from '@/components/common/ErrorNote.vue'
import Select from '@/components/common/Select.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import type { SelectOptionLike } from '@/components/common/select'
import {
  AGENT_PERMISSION_MODE_CHOICES,
  enterAllowlistMode,
  isFollowGlobal,
  isToolSelected,
  leaveAllowlistMode,
  modelBindingPayload,
  permissionModePayload,
  readToolAllowlist,
  readTurnBudget,
  toggleTool,
  toolAllowlistPayload,
  turnBudgetChoices,
  turnBudgetPayload,
  validateToolAllowlist,
  type ToolAllowlistState,
} from './agent-config-form'
import '@/styles/agent-space.css'

const props = withDefaults(defineProps<{
  /** 要编辑的人;`null` + isCreating = 草稿。 */
  agent: AgentDefinition | null
  isCreating?: boolean
  /** 「Conversations」那一块(私聊 + TA 的群聊)。窄栏由资料块承担,关掉。 */
  showConversations?: boolean
}>(), {
  isCreating: false,
  showConversations: true,
})

const emit = defineEmits<{
  /** 存完之后回传落库的那个 agent(草稿存完也走这条)。 */
  saved: [agent: AgentDefinition]
  cancel: []
  'open-session': [sessionId: string]
}>()

const agentsStore = useAgentsStore()
const settingsStore = useSettingsStore()
/** 批 B9:provider 开关的空间覆盖(default 空间恒 undefined)。 */
const sessionsStore = useSessionsStore()
const { confirm } = useConfirm()

const saving = ref(false)
const formName = ref('')
const formTitle = ref('')
const formAvatar = ref('')
/** Media library file name (see AgentDefinition.avatarImage), '' = emoji only. */
const formAvatarImage = ref('')
const formPrompt = ref('')
const formError = ref('')
const formFeedback = ref('')
const formTools = ref<ToolAllowlistState>(null)
const formModelProvider = ref('')
const formModelId = ref('')
const formModelThinking = ref('')
const formPermissionMode = ref('')
const formTurnBudget = ref('inherit')

/* Only the picker-facing fields: ToolDefinition carries a recursive JSON-schema
   type that makes Ref unwrapping explode (TS2589). */
interface ToolChoice {
  id: string
  name: string
  description: string
  /** Secondary mono label: the raw id, or why the id no longer resolves. */
  note: string
}

const availableTools = ref<ToolChoice[]>([])
const toolsLoading = ref(false)

function syncFormFromAgent() {
  if (props.isCreating) return
  const agent = props.agent
  formName.value = agent?.name || ''
  formTitle.value = agent?.title || ''
  formAvatar.value = agent?.avatar || ''
  formAvatarImage.value = agent?.avatarImage || ''
  formPrompt.value = agent?.systemPrompt || ''
  formTools.value = readToolAllowlist(agent?.tools)
  formModelProvider.value = agent?.model?.providerId || ''
  formModelId.value = agent?.model?.modelId || ''
  formModelThinking.value = agent?.model?.thinking || ''
  formPermissionMode.value = agent?.permissionMode || ''
  formTurnBudget.value = readTurnBudget(agent?.maxTurns)
}

function resetDraft() {
  formName.value = 'New Agent'
  formTitle.value = ''
  formAvatar.value = ''
  formAvatarImage.value = ''
  formPrompt.value = ''
  formTools.value = null
  formModelProvider.value = ''
  formModelId.value = ''
  formModelThinking.value = ''
  formPermissionMode.value = ''
  formTurnBudget.value = 'inherit'
  formError.value = ''
  formFeedback.value = ''
}

watch(() => props.agent, syncFormFromAgent, { immediate: true })
watch(() => props.isCreating, creating => {
  if (creating) resetDraft()
  else syncFormFromAgent()
})

/* ---- picture avatar (todo2-fix-plan P2) ----
 *
 * The bytes go to the media library and the FIELD stores only the file name
 * (see AgentDefinition.avatarImage) — a dataURL in agents.json would bloat a
 * file that every roster lookup reads. The downscale + size cap live in
 * common/agent-avatar.ts: the user's own avatar picker runs the same pipeline.
 */
const avatarFileInputRef = ref<HTMLInputElement | null>(null)
const avatarImageBusy = ref(false)

function pickAvatarImage(): void {
  formError.value = ''
  avatarFileInputRef.value?.click()
}

function clearAvatarImage(): void {
  formAvatarImage.value = ''
  formFeedback.value = ''
}

async function onAvatarFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Reset the input either way: picking the SAME file twice must fire again.
  input.value = ''
  if (!file) return

  avatarImageBusy.value = true
  formError.value = ''
  formFeedback.value = ''
  try {
    const base64 = await downscaleImageToPngDataUrl(file, AVATAR_IMAGE_MAX_PX)
    /* 懒取 store:媒体库只在用户真去挑图那一刻才需要,提前取会让不挂 pinia
       的面板单测在 setup 阶段就炸。 */
    const fileName = await useMediaStore().savePersonaAvatar({
      base64,
      label: formName.value.trim() || undefined,
    })
    if (!fileName) {
      formError.value = 'Failed to store the picture'
      return
    }
    formAvatarImage.value = fileName
    /* 只改了草稿:落库还是那颗 save 按钮,与其它字段同一条路。 */
    formFeedback.value = 'Picture ready — save to apply'
  } catch (err: any) {
    formError.value = err?.message || 'Failed to read the picture'
  } finally {
    avatarImageBusy.value = false
  }
}

/* ---- boundaries ---- */

const permissionModeChoices = AGENT_PERMISSION_MODE_CHOICES

const permissionModeHint = computed(() =>
  permissionModeChoices.find(choice => choice.value === formPermissionMode.value)?.hint ?? ''
)

/* The selected agent's own value stays selectable even when it matches no
   tier — see turnBudgetChoices. */
const turnBudgetOptions = computed(() => turnBudgetChoices(props.agent?.maxTurns))

const permissionModeOptions: SelectOptionLike[] = permissionModeChoices.map(choice => ({
  value: choice.value,
  label: choice.label,
}))

const turnBudgetSelectOptions = computed<SelectOptionLike[]>(() =>
  turnBudgetOptions.value.map(choice => ({ value: choice.value, label: choice.label }))
)

/* ---- tool allowlist ---- */

const followsGlobalTools = computed(() => isFollowGlobal(formTools.value))

/**
 * The picker lists globally enabled tools, plus any id the agent already has
 * that no longer resolves — dropping those silently would edit the allowlist
 * behind the user's back the first time they hit save.
 */
const toolChoices = computed<ToolChoice[]>(() => {
  const choices = [...availableTools.value]
  const known = new Set(choices.map(choice => choice.id))
  for (const id of formTools.value ?? []) {
    if (known.has(id)) continue
    choices.push({ id, name: id, description: '', note: 'unavailable' })
  }
  return choices
})

const toolSummary = computed(() => {
  if (followsGlobalTools.value) return 'all tools'
  const count = formTools.value?.length ?? 0
  return count === 1 ? '1 tool' : `${count} tools`
})

function setToolMode(mode: 'global' | 'allowlist') {
  formTools.value = mode === 'global'
    ? leaveAllowlistMode()
    : enterAllowlistMode(formTools.value)
  formError.value = ''
}

function isToolOn(toolId: string): boolean {
  return isToolSelected(formTools.value, toolId)
}

function onToggleTool(toolId: string) {
  formTools.value = toggleTool(formTools.value, toolId)
  formError.value = ''
}

async function loadTools() {
  if (typeof platformApi.getTools !== 'function') return
  toolsLoading.value = true
  try {
    const response = await platformApi.getTools()
    if (response?.success && response.tools) {
      availableTools.value = response.tools
        .filter(tool => tool.enabled !== false)
        .map(tool => ({
          id: tool.id,
          name: tool.name || tool.id,
          description: tool.description || '',
          note: tool.name && tool.name !== tool.id ? tool.id : '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }
  } catch {
    // The picker renders its empty note; the rest of the form still works.
  } finally {
    toolsLoading.value = false
  }
}

/* ---- model binding ---- */

/* Every provider is offered, not just the configured ones: binding an agent to
   a provider you are about to set up is legitimate, so an unusable pick earns a
   warning line rather than a missing option. */
const providerChoices = computed(() =>
  (settingsStore.availableProviders || []).map(provider => ({
    id: provider.id,
    name: providerFamilyDisplayName(provider.id, provider.name),
  }))
)

const modelChoices = computed(() => {
  const providerId = formModelProvider.value
  if (!providerId) return []
  const config = settingsStore.settings?.ai?.providers?.[providerId]
  const ids = [...(config?.selectedModels || [])]
  if (config?.model && !ids.includes(config.model)) ids.unshift(config.model)
  if (formModelId.value && !ids.includes(formModelId.value)) ids.unshift(formModelId.value)
  return ids.map(id => ({ id, name: settingsStore.getModelDisplayName(id) || id }))
})

/**
 * One spelling of "a dropdown on the agent ledger". `underline` is what
 * `.agent-ledger .ledger-select` hand-drew (a hairline, no frame); `teleported`
 * keeps the panel out of the form's scroll container.
 */
const LEDGER_SELECT = {
  class: 'ledger-select-field',
  variant: 'underline',
  size: 'small',
  teleported: true,
  fitInputWidth: true,
} as const

const providerOptions = computed<SelectOptionLike[]>(() => [
  { value: '', label: 'follow session default' },
  ...providerChoices.value.map(provider => ({ value: provider.id, label: provider.name })),
])

const modelOptions = computed<SelectOptionLike[]>(() => [
  { value: '', label: 'provider default' },
  ...modelChoices.value.map(model => ({ value: model.id, label: model.name })),
])

const modelWarning = computed(() => {
  const providerId = formModelProvider.value
  if (!providerId) return ''
  const config = settingsStore.settings?.ai?.providers?.[providerId]
  if (!config) {
    return 'This provider is not configured yet — drives fall back to the session default.'
  }
  // 批 B9:开关 per-space(第三参 = 空间覆盖,default 空间恒 undefined)。
  if (!isProviderEnabledIn(settingsStore.settings?.ai?.providers, providerId)) {
    return 'This provider is disabled in Settings — drives fall back to the session default.'
  }
  const provider = (settingsStore.availableProviders || []).find(item => item.id === providerId)
  if (provider?.requiresApiKey && !provider.requiresOAuth && !config.apiKey) {
    return 'This provider has no API key yet — drives fall back to the session default.'
  }
  return ''
})

function onModelProviderChange() {
  /* A provider switch invalidates the old model id — clear it first, or the
     stale value survives via modelChoices' "keep the bound model visible" arm
     and the pair silently crosses providers. */
  formModelId.value = ''
  if (!formModelProvider.value) {
    formModelThinking.value = ''
    return
  }
  formModelId.value = modelChoices.value[0]?.id || ''
}

function clearModelBinding() {
  formModelProvider.value = ''
  formModelId.value = ''
  formModelThinking.value = ''
}

/* ---- conversations: 私聊 + TA 的群聊 (todo2-fix-plan P1-3) ---- */

const openingChat = ref(false)
const conversationError = ref('')

/** TA 在哪些群里。「群」不含私聊房(agent-im-dm.md §4.1)。 */
const agentRooms = computed(() => {
  const agentId = props.agent?.id
  if (!agentId || props.isCreating) return []
  return sessionsStore.groupRoomSessions
    .filter(room => room.room?.memberAgentIds?.includes(agentId) || room.room?.pmAgentId === agentId)
    .map(room => ({
      id: room.id,
      name: (room.name || '').trim() || '未命名群聊',
      isPm: room.room?.pmAgentId === agentId,
      updatedAt: room.updatedAt || 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
})

/**
 * 私聊 = 一条绑到该 agent 的**普通**会话,不是它的执行会话。
 *
 * 复用优先:同一个 agent 反复点「私聊」不该攒出一串空会话,所以先找最近一条
 * 活着的普通会话;没有才新建,并且新建后立刻绑定 agent —— 绑定要在打开之前,
 * 否则第一条消息可能落在默认 agent 身上。
 */
async function openPrivateChat() {
  const agent = props.agent
  if (!agent || props.isCreating || openingChat.value) return

  openingChat.value = true
  conversationError.value = ''
  try {
    const existing = sessionsStore.sessions
      .filter(session =>
        session.agentId === agent.id &&
        (!session.kind || session.kind === 'chat') &&
        !session.isArchived)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]

    if (existing) {
      emit('open-session', existing.id)
      return
    }

    const created = await sessionsStore.createSessionWithoutSwitch(agent.name || 'Agent')
    if (!created) {
      conversationError.value = '新建会话失败,请重试。'
      return
    }
    const bound = await sessionsStore.updateSessionAgent(created.id, agent.id)
    if (!bound.success) {
      // 会话建出来了但没绑上 —— 说清楚,别让用户以为自己在跟这个 agent 说话。
      conversationError.value = bound.error || '会话已创建,但绑定 agent 失败。'
    }
    emit('open-session', created.id)
  } finally {
    openingChat.value = false
  }
}

/* ---- prompt templates ---- */

const promptTemplates = [
  {
    name: 'Developer',
    prompt: 'You are an expert software developer. Provide clean, well-documented, and performant code in TypeScript/JavaScript following industry best practices. Explain design decisions briefly and clearly.'
  },
  {
    name: 'Writer',
    prompt: 'You are a creative writer and copy editor. Focus on engaging, vivid prose with excellent structure and tone. Adapt your style based on the user\'s requests, maintaining high readability and style.'
  },
  {
    name: 'Analyst',
    prompt: 'You are a detail-oriented data analyst. Provide structured insights, markdown tables, and clear explanations. Focus on extracting quantitative patterns and validating claims with rigorous logic.'
  },
  {
    name: 'Concise AI',
    prompt: 'You are a helpful assistant. Keep all responses brief, direct, and focused. Avoid introductory and concluding conversational filler. Answer in bullet points whenever possible.'
  }
]

async function applyTemplate(templatePrompt: string) {
  if (formPrompt.value.trim()) {
    const accepted = await confirm({
      title: 'Overwrite prompt',
      message: 'Overwrite current system prompt with this template?',
      confirmText: 'Overwrite',
    })
    if (!accepted) return
  }
  formPrompt.value = templatePrompt
}

function wordCount(str: string): number {
  if (!str) return 0
  return str.trim().split(/\s+/).filter(Boolean).length
}

/* ---- save / cancel ---- */

function onCancel() {
  if (props.isCreating) {
    resetDraft()
  } else {
    syncFormFromAgent()
  }
  formError.value = ''
  formFeedback.value = ''
  emit('cancel')
}

async function saveAgent() {
  const name = formName.value.trim()
  if (!name) {
    formError.value = 'Name is required'
    return
  }

  const allowlistError = validateToolAllowlist(formTools.value)
  if (allowlistError) {
    formError.value = allowlistError
    return
  }

  saving.value = true
  formError.value = ''
  formFeedback.value = ''

  const configUpdates = {
    /* 空串必须落成 null:后端的 patchOptional 把 undefined 当"不改",
       只有显式 null 才清得掉已有的身份。 */
    title: formTitle.value.trim() || null,
    avatar: formAvatar.value.trim() || null,
    avatarImage: formAvatarImage.value.trim() || null,
    tools: toolAllowlistPayload(formTools.value),
    model: modelBindingPayload({
      providerId: formModelProvider.value,
      modelId: formModelId.value,
      thinking: formModelThinking.value,
    }),
    permissionMode: permissionModePayload(formPermissionMode.value) as PermissionMode | null,
    maxTurns: turnBudgetPayload(formTurnBudget.value, props.agent?.maxTurns),
  }

  try {
    if (props.isCreating) {
      /* createAgent only carries name + prompt; the tool/model fields ride the
         update channel right after so both stay on one save button. */
      const created = await agentsStore.createAgent(name, formPrompt.value)
      const agent = await agentsStore.updateAgent(created.id, configUpdates)
      formFeedback.value = 'Agent created'
      emit('saved', agent)
    } else if (props.agent) {
      const agent = await agentsStore.updateAgent(props.agent.id, {
        name,
        systemPrompt: formPrompt.value,
        ...configUpdates,
      })
      formFeedback.value = 'Agent saved'
      emit('saved', agent)
    }
    syncFormFromAgent()
  } catch (err: any) {
    formError.value = err?.message || 'Failed to save agent'
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadTools()
  if (!(settingsStore.availableProviders || []).length) {
    void settingsStore.loadProviders().catch(() => {
      // The provider list stays empty; the model row simply offers no options.
    })
  }
})

/** 宿主(管理页的退休/恢复)要知道表单是不是正在写盘。 */
defineExpose({ saving })
</script>

<style scoped>
.agent-config-form {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

/* P3: the four dropdowns are `<Select variant="underline">`, which owns the
   hairline and the caret. This is the footprint `.agent-ledger .ledger-select`
   used to give them — a NEW class on purpose: reusing `.ledger-select` would
   hand the component root that rule's `appearance/border/padding` paint too,
   and at (0,2,0) it would win over the component's own (0,1,0). The old
   `.agent-ledger .ledger-select` rules were removed with soul-memory (2026-08-06),
   which was their last consumer. */
.ledger-select-field {
  flex: 1;
  min-width: 0;
}
</style>
