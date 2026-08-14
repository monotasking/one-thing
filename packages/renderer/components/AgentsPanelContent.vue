<template>
  <!-- P4b:名册套上六面板共享骨架(PanelShell 控制条 / 内容 / 状态条)。主从两栏、
       四子视图、容器查询响应式全部原样 —— 换的是外框与左栏那一列行。 -->
  <div class="agents-panel agent-ledger">
    <PanelShell
      :busy="agentsStore.isLoading"
      :scroll="false"
      :padded="false"
    >
      <template #controls>
        <FilterSearchInput
          v-model="rosterQuery"
          size="compact"
          class="agents-search"
          placeholder="搜索 agent"
          label="搜索 agent"
        />
        <button
          class="agents-new u-focus-ring"
          type="button"
          @click="startCreate"
        >
          <Plus
            :size="13"
            :stroke-width="2"
          />
          新建
        </button>
      </template>

      <div
        class="agents-layout"
        :class="{ 'detail-active': agentDetailActive }"
      >
        <aside class="agents-list">
          <p
            v-if="agentsStore.isLoading"
            class="ledger-note"
          >
            loading…
          </p>
          <ErrorNote
            v-else-if="agentsStore.error"
            class="ledger-error"
            :message="agentsStore.error"
          />
          <p
            v-else-if="agentsStore.agents.length === 0"
            class="ledger-note"
          >
            No agents configured yet.
          </p>
          <p
            v-else-if="visibleActive.length === 0 && visibleRetired.length === 0"
            class="ledger-note"
          >
            没有匹配「{{ rosterQuery }}」的 agent。
          </p>

          <!-- 在职与已退休分两栏(域模型 §3.2):退休的不消失,只是沉到下面灰着 ——
               管理页是唯一还能看见并恢复它们的地方。

               设计稿画的是「运行中 / 空闲」两组 + 行尾停止钮 + 需确认橙 chip;那三样
               全部依赖"这个 agent 此刻在跑什么"这一维数据,而 agentsStore 里没有它,
               presence(computeAgentPresence)回答的是"在哪些会话里",不是"正在跑"。
               所以这里如实退化成在职 / 已退休 —— 等真有运行态数据源了,再往首列那颗
               点上加绿色、往行尾加停止钮,槽位是留着的。 -->
          <div class="ledger-body">
            <LedgerGroupHeader
              v-if="visibleActive.length > 0"
              label="在职"
              :count="visibleActive.length"
            />
            <ol
              v-if="visibleActive.length > 0"
              class="agent-rows"
            >
              <li
                v-for="agent in visibleActive"
                :key="agent.id"
                class="agent-row"
                :class="{ 'is-active': !isCreating && agent.id === activeAgentId }"
              >
                <button
                  class="row-line"
                  type="button"
                  @click="selectAgent(agent.id)"
                >
                  <span
                    class="row-dot"
                    aria-hidden="true"
                  />
                  <span class="row-body">
                    <span class="row-name">{{ agent.name }}</span>
                    <span class="row-meta">上次更新 {{ formatUpdated(agent.updatedAt) }}</span>
                  </span>
                  <span
                    v-if="agent.isDefault"
                    class="agent-chip"
                  >default</span>
                </button>
              </li>
            </ol>

            <template v-if="visibleRetired.length > 0">
              <LedgerGroupHeader
                label="已退休"
                :count="visibleRetired.length"
              />
              <ol class="agent-rows">
                <li
                  v-for="agent in visibleRetired"
                  :key="agent.id"
                  class="agent-row is-retired"
                  :class="{ 'is-active': !isCreating && agent.id === activeAgentId }"
                >
                  <button
                    class="row-line"
                    type="button"
                    @click="selectAgent(agent.id)"
                  >
                    <span
                      class="row-dot"
                      aria-hidden="true"
                    />
                    <span class="row-body">
                      <span class="row-name">{{ agent.name }}</span>
                      <span class="row-meta">上次更新 {{ formatUpdated(agent.updatedAt) }}</span>
                    </span>
                    <span class="agent-chip">已注销</span>
                  </button>
                </li>
              </ol>
            </template>
          </div>
        </aside>

        <section class="agent-editor">
          <div class="editor-header">
            <button
              class="text-action back-btn"
              type="button"
              @click="agentDetailActive = false"
            >
              ‹ back
            </button>
            <div class="editor-title">
              <h3>
                {{ isCreating ? 'New Agent' : selectedAgent?.name || 'Agent' }}
              </h3>
              <span>{{ editorSubtitle }}</span>
            </div>
            <Tooltip
              v-if="canRestore"
              text="重新入职:回到同事名册与激活链"
            >
              <button
                class="text-action"
                type="button"
                :disabled="saving"
                @click="restoreSelectedAgent"
              >
                恢复在职
              </button>
            </Tooltip>
            <Tooltip
              v-if="canDelete"
              text="退休:退出社交面与激活链,记录保留(从未被引用过的才真删)"
            >
              <button
                class="text-action is-danger"
                type="button"
                :disabled="saving"
                @click="deleteSelectedAgent"
              >
                退休
              </button>
            </Tooltip>
          </div>

          <!-- 资料块(agent-im-chat-ui.md §3.2)。空间页 = "我与 TA"的那一页,
               进来第一眼得是**这个人**:大头像 + 名字 + 职位 + 说明,以及两个
               动作。小卡(AgentContactCard)因此退役 —— 它承接的就是这一块。
               草稿 agent 还不是一个人,没有资料可摆。 -->
          <div
            v-if="!isCreating && selectedAgent"
            class="agent-profile"
          >
            <AgentAvatar
              class="profile-avatar"
              aria-hidden="true"
              :avatar="selectedAgent.avatar"
              :avatar-image="selectedAgent.avatarImage"
              :size="44"
            />
            <div class="profile-heading">
              <span class="profile-name">{{ selectedAgent.name }}</span>
              <span
                v-if="selectedAgent.title"
                class="profile-title"
              >{{ selectedAgent.title }}</span>
              <!-- 墓碑(域模型 §3.2):身份还在,只是不再接活。 -->
              <span
                v-if="selectedRetired"
                class="profile-tombstone"
              >已注销 · 记录保留</span>
            </div>
            <div class="profile-actions">
              <!-- 退休那句是**禁用理由**:按钮自己收不到 hover,浮层挂在外层
                   wrapper 上才说得出口;没退休就没什么可说的,整层静音。 -->
              <Tooltip
                text="已退休:不再接活,也开不了新私聊"
                :disabled="!selectedRetired"
              >
                <button
                  class="text-action"
                  type="button"
                  :disabled="selectedRetired || openingDm"
                  @click="startDmChat"
                >
                  {{ openingDm ? '打开中…' : '发消息' }}
                </button>
              </Tooltip>
              <Tooltip text="TA 的心智与能力:提示词、工具、模型、边界">
                <button
                  class="text-action"
                  type="button"
                  @click="detailTab = 'config'"
                >
                  配置
                </button>
              </Tooltip>
            </div>
          </div>
          <p
            v-if="!isCreating && selectedAgent?.description"
            class="profile-description"
          >
            {{ selectedAgent.description }}
          </p>
          <p
            v-if="!isCreating && historyError"
            class="field-hint profile-error"
          >
            {{ historyError }}
          </p>
          <!-- 退休 / 恢复 / 真删的结果:这三件事是名册面的动作,回执也归本页
               (保存那条在表单里)。 -->
          <ErrorNote
            v-if="lifecycleError"
            class="ledger-error profile-error"
            :message="lifecycleError"
          />
          <p
            v-else-if="lifecycleNote"
            class="ledger-note profile-error"
          >
            {{ lifecycleNote }}
          </p>

          <!-- 空间页四面(agent-im-chat-ui.md §3.2):配置 / 会话 / 文件 / 搜索。
               复用本页 .mode-switch 的画线开关句法,不再拉一套 Tabs 组件进来 ——
               这页整体是账页风,Tabs 的卡片皮不属于这儿。 -->
          <div
            v-if="!isCreating"
            class="mode-switch detail-tabs"
            role="tablist"
            aria-label="Agent 空间"
          >
            <template
              v-for="(tab, index) in DETAIL_TABS"
              :key="tab.key"
            >
              <span
                v-if="index > 0"
                class="mode-divider"
              />
              <button
                class="mode-option"
                :class="{ 'is-on': detailTab === tab.key }"
                type="button"
                role="tab"
                :aria-selected="detailTab === tab.key"
                @click="detailTab = tab.key"
              >
                {{ tab.label }}
              </button>
            </template>
          </div>

          <!-- 四面全部是共享件(agent-space-workbench.md P0):右栏空间页挂的是
               同一批组件,所以"在哪儿看到的账"永远是同一份。行的落点由本页决定
               —— 管理页盖在聊天区上,开完会话/文件必须把自己合上。 -->
          <AgentSessionsPane
            v-if="showSessions"
            :agent-id="historyAgentId"
            :agent-name="selectedAgent?.name"
            @open-session="openSessionAndClose"
          />

          <AgentFilesPane
            v-else-if="showFiles"
            :agent-id="historyAgentId"
            @open-file="openFileAndClose"
          />

          <AgentSearchPane
            v-else-if="showSearch"
            :agent-id="historyAgentId"
            :agent-name="selectedAgent?.name"
            @open-session="openSessionAndClose"
          />

          <AgentConfigForm
            v-show="showConfig"
            :agent="isCreating ? null : selectedAgent"
            :is-creating="isCreating"
            @saved="onAgentSaved"
            @cancel="onFormCancel"
            @open-session="openSessionAndClose"
          />
        </section>
      </div>

      <template #status>
        <span class="status-text">{{ statusText }}</span>
      </template>
    </PanelShell>
  </div>
</template>

<script setup lang="ts">
import { useConfirm } from '@/composables/useConfirm'
/**
 * Agents 管理页 —— **名册面**:新建 / 退休 / 恢复 / 通览,外加"这个人"的四面。
 *
 * 四面(配置 / 会话 / 文件 / 搜索)本身不长在这里:它们是 `components/agents/`
 * 下的共享件,右栏空间页挂的是同一批(agent-space-workbench.md P0)。本页只负责
 * 名册那一栏、资料块、以及"行点开之后去哪"—— 这页盖在聊天区上,所以开完会话
 * 或文件必须把自己合上,而右栏那边原地不动。
 *
 * 视觉在 `styles/agent-space.css`(`.agent-ledger` 前缀):markup 搬进子组件之后
 * scoped 样式够不到内部元素,那份表就是为此抽出来的。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { DEFAULT_AGENT_ID, useAgentsStore, type AgentDetailTab } from '@/stores/agents'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspaceStore } from '@/stores/workspace'
import { isActiveAgent, type AgentDefinition } from '@shared/ipc'
import { Plus } from 'lucide-vue-next'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import ErrorNote from '@/components/common/ErrorNote.vue'
import FilterSearchInput from '@/components/common/FilterSearchInput.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import PanelShell from '@/components/workspace/PanelShell.vue'
import LedgerGroupHeader from '@/components/workspace/LedgerGroupHeader.vue'
import { COLLAB_TAG_OPEN_FILE_EVENT } from '@/composables/collabInlineTags'
import AgentConfigForm from '@/components/agents/AgentConfigForm.vue'
import AgentSessionsPane from '@/components/agents/AgentSessionsPane.vue'
import AgentFilesPane from '@/components/agents/AgentFilesPane.vue'
import AgentSearchPane from '@/components/agents/AgentSearchPane.vue'
import { useAgentDmOpener } from '@/components/agents/use-agent-dm'
import { formatUpdated } from '@/components/agents/use-agent-history'
import '@/styles/agent-space.css'

const agentsStore = useAgentsStore()
const { confirm } = useConfirm()
const sessionsStore = useSessionsStore()
const workspaceStore = useWorkspaceStore()

/* 开出去的会话在聊天区,而这个面板正盖在聊天区上 —— 不合上就等于什么都没发生。 */
const emit = defineEmits<{ close: [] }>()

const activeAgentId = ref(DEFAULT_AGENT_ID)
const isCreating = ref(false)
/** 退休 / 恢复 正在写盘(保存是表单自己的事)。 */
const saving = ref(false)
/** 这两件事的回执。名册面的动作在名册面报账,别塞进表单。 */
const lifecycleNote = ref('')
const lifecycleError = ref('')
const agentDetailActive = ref(false)

const selectedAgent = computed(() =>
  agentsStore.agents.find(agent => agent.id === activeAgentId.value) ||
  agentsStore.defaultAgent
)

/* ---- 控制条:名册搜索 ---- */

const rosterQuery = ref('')

/** 名字与职位都算数 —— 记不住名字时人找的是"那个写文案的"。 */
function matchesQuery(agent: AgentDefinition): boolean {
  const query = rosterQuery.value.trim().toLowerCase()
  if (!query) return true
  return `${agent.name ?? ''} ${agent.title ?? ''}`.toLowerCase().includes(query)
}

const visibleActive = computed(() => agentsStore.activeAgents.filter(matchesQuery))
const visibleRetired = computed(() => agentsStore.retiredAgents.filter(matchesQuery))

/** 状态条:没筛选时报总数,筛了就先报筛出多少。 */
const statusText = computed(() => {
  const total = agentsStore.agents.length
  if (!rosterQuery.value.trim()) return `${total} 个 agent`
  return `筛出 ${visibleActive.value.length + visibleRetired.value.length} · 共 ${total} 个 agent`
})

/**
 * 生命周期(agent-domain-model.md §3.2)。管理页是这两个动作的**唯一**入口:
 * 「删除」按钮实际上是退休(被引用过的 agent 永不硬删),而恢复只在这儿。
 * default agent 两条都不给 —— 后端也硬拒,这里只是不让人白点。
 */
const selectedRetired = computed(() =>
  !!selectedAgent.value && !isActiveAgent(selectedAgent.value))

const canDelete = computed(() =>
  !isCreating.value &&
  !!selectedAgent.value &&
  selectedAgent.value.id !== DEFAULT_AGENT_ID &&
  !selectedRetired.value
)

const canRestore = computed(() =>
  !isCreating.value &&
  !!selectedAgent.value &&
  selectedAgent.value.id !== DEFAULT_AGENT_ID &&
  selectedRetired.value
)

const editorSubtitle = computed(() => {
  if (isCreating.value) return 'draft'
  if (selectedRetired.value) return '已注销 · 记录保留'
  return selectedAgent.value?.isDefault ? 'default agent' : 'custom agent'
})

/** 空间页四面(agent-im-chat-ui.md §3.2)。顺序即心智:先是谁,再是聊过什么。 */
const DETAIL_TABS: ReadonlyArray<{ key: AgentDetailTab; label: string }> = [
  { key: 'config', label: '配置' },
  { key: 'sessions', label: '会话' },
  { key: 'files', label: '文件' },
  { key: 'search', label: '搜索' },
]

const detailTab = ref<AgentDetailTab>('config')
/* 草稿 agent 只有配置那一面 —— 还没有 id,就还没有会话、文件与可搜的东西。 */
const showSessions = computed(() => !isCreating.value && detailTab.value === 'sessions')
const showFiles = computed(() => !isCreating.value && detailTab.value === 'files')
const showSearch = computed(() => !isCreating.value && detailTab.value === 'search')
const showConfig = computed(() => isCreating.value || detailTab.value === 'config')

/** 草稿 agent 还没有 id,自然也没有历史。 */
const historyAgentId = computed(() => (isCreating.value ? '' : selectedAgent.value?.id || ''))

/* ---- 资料块的两个动作 ---- */

const { openingDm, dmError: historyError, openDmRoom } = useAgentDmOpener()

/**
 * 「发消息」= 联系人区同一条链路(幂等建房 → 刷新列表 → 打开),不是配置面里
 * 那个「私聊」(那开的是绑 agent 的普通直聊会话)。
 */
async function startDmChat(): Promise<void> {
  const sessionId = await openDmRoom(historyAgentId.value)
  if (sessionId) openSessionAndClose(sessionId)
}

function openSessionAndClose(sessionId: string): void {
  if (!sessionId) return
  workspaceStore.openSession(sessionId)
  emit('close')
}

/** 点开走既有 openFile 链路(>1MB / 二进制的降级在那条链路上现成)。 */
function openFileAndClose(filePath: string): void {
  if (!filePath) return
  window.dispatchEvent(new CustomEvent(COLLAB_TAG_OPEN_FILE_EVENT, { detail: { filePath } }))
  emit('close')
}

/* ---- 名册 ---- */

/** 侧栏「配置 Agent」跳进来时把详情页停在那个 agent 上,并把请求吃掉 —— 否则
    下次再打开面板会莫名其妙又跳一次。 */
function consumePendingAgentDetail() {
  if (!agentsStore.pendingDetailAgentId) return
  // 先读 tab 再 consume:consume 会把 agentId 和 tab 一起清掉。
  const tab = agentsStore.pendingDetailTab
  const agentId = agentsStore.consumeAgentDetailRequest()
  if (!agentId) return
  selectAgent(agentId)
  if (tab) detailTab.value = tab
}

watch(() => agentsStore.pendingDetailAgentId, consumePendingAgentDetail)

function selectAgent(agentId: string) {
  isCreating.value = false
  activeAgentId.value = agentId
  agentDetailActive.value = true
  lifecycleNote.value = ''
  lifecycleError.value = ''
}

function startCreate() {
  isCreating.value = true
  activeAgentId.value = ''
  agentDetailActive.value = true
  detailTab.value = 'config'
}

/** 表单存完:草稿转正就把选中态挪到新人身上。 */
function onAgentSaved(agent: AgentDefinition) {
  isCreating.value = false
  activeAgentId.value = agent.id
}

function onFormCancel() {
  if (isCreating.value) {
    isCreating.value = false
    activeAgentId.value = agentsStore.defaultAgent?.id || DEFAULT_AGENT_ID
  }
  agentDetailActive.value = false
}

/**
 * 「删除」的两种结局(域模型 §3.2):被引用过 → 退休(留下墓碑,历史署名、房间
 * 成员条、履历照旧读得出);从未被引用过 → 真删掉。
 *
 * 确认文案在点之前就分岔,因为这两件事对用户是两个决定 —— 用一句「Delete?」
 * 盖住"其实只是退休"会让人以为记录被抹了,反过来也会让人以为还找得回来。
 */
async function deleteSelectedAgent() {
  const agent = selectedAgent.value
  if (!agent || agent.id === DEFAULT_AGENT_ID) return
  const accepted = await confirm({
    title: `让 ${agent.name} 退休?`,
    message: 'TA 会从同事名册、群成员候选与激活链里退出,不再被指派和发言。\n'
      + '历史消息署名、群成员条与履历全部保留 —— 从未被任何会话引用过的话,才会真删除。',
    confirmText: '退休',
    danger: true,
  })
  if (!accepted) return

  saving.value = true
  lifecycleNote.value = ''
  lifecycleError.value = ''
  try {
    const outcome = await agentsStore.deleteAgent(agent.id)
    if (outcome === 'deleted') {
      activeAgentId.value = agentsStore.defaultAgent?.id || agentsStore.agents[0]?.id || DEFAULT_AGENT_ID
    }
    isCreating.value = false
    // 退休的 agent 还在名册里(灰显),留在选中态上,恢复入口就在原地。
    lifecycleNote.value = outcome === 'retired' ? '已退休(记录保留)' : '已删除(从未被引用)'
  } catch (err: any) {
    lifecycleError.value = err?.message || 'Failed to retire agent'
  } finally {
    saving.value = false
  }
}

/** 重新入职(§8):status 翻回 active,身份/心智/能力三面一字不动。 */
async function restoreSelectedAgent() {
  const agent = selectedAgent.value
  if (!agent || agent.id === DEFAULT_AGENT_ID) return

  saving.value = true
  lifecycleNote.value = ''
  lifecycleError.value = ''
  try {
    await agentsStore.restoreAgent(agent.id)
    lifecycleNote.value = '已恢复在职'
  } catch (err: any) {
    lifecycleError.value = err?.message || 'Failed to restore agent'
  } finally {
    saving.value = false
  }
}

/* 群聊/直聊列表只在配置面的「Conversations」里用到,那块已经进了表单;这里留
   sessionsStore 只为让四面共用的 store 在本页也已初始化。 */
void sessionsStore

onMounted(async () => {
  try {
    await agentsStore.loadAgents()
    if (!agentsStore.agents.some(agent => agent.id === activeAgentId.value)) {
      activeAgentId.value = agentsStore.defaultAgent?.id || agentsStore.agents[0]?.id || DEFAULT_AGENT_ID
    }
  } catch {
    // Store error is rendered above.
  }

  /* 懒挂载的这一刻请求可能已经躺在 store 里了(侧栏先寄存再开面板),watch 不
     会为一个挂载前就存在的值触发,所以这里主动取一次。 */
  consumePendingAgentDetail()
})
</script>

<style scoped>
/*
 * Agents ledger — 画线风.
 * No background fills, no radii: state lives in the line.
 * P4b:外框换成 PanelShell(控制条 / 内容 / 26px 状态条),左栏那一列换成六面板
 * 共用的 44px 账线行(首列槽 + 两行体);右侧主从、四子视图、容器查询全部原样。
 */
.agents-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--ui-text-primary-fg);
  background: transparent;
  animation: ledger-fade 0.15s ease;
  container-type: inline-size;

  /* 滑入的详情面要一枚不透明底才盖得住底下的名册。区域面自绘归 Surface 档位管
     (ui-system §4 surface-literal)—— 所以借 PanelShell 声明的那枚变量转手,
     脱离 PanelShell 时 fallback 到 panel 面。 */
  --agents-pane-bg: var(--panel-shell-bg, var(--ui-surface-panel-bg));
}

@keyframes ledger-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ---- 控制条 ---- */
.agents-search {
  flex: 1;
  min-width: 0;
}

/* 「新建」是这个面板唯一的主动作,所以它是控制条上唯一一颗实心钮。 */
.agents-new {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 11px;
  border: none;
  border-radius: 7px;
  background: var(--ui-action-primary-bg);
  color: var(--ui-action-primary-fg);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color var(--duration-fast) var(--ease-default);
}

.agents-new:hover {
  background: var(--ui-action-primary-hover-bg);
}

/* ---- layout ---- */
.agents-layout {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(200px, 290px) minmax(0, 1fr);
  gap: 20px;
  padding: 8px 14px 14px;
  position: relative;
  overflow: hidden;
}

.ledger-body {
  position: relative;
}

/* ---- agent rows(44px 账线行)---- */
.agent-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.agent-row {
  position: relative;
  border-bottom: 1px solid var(--ui-border-subtle-border);
}

/* 已退休:整行压暗、徽标转中性墨色。行还在(才点得进去恢复),只是不再是在职
   的那一栏 —— 分组头已经说了这是哪一栏,所以这里只需要一层灰。 */
.agent-row.is-retired .row-name {
  color: var(--ui-text-muted-fg);
}

.agent-row.is-retired .agent-chip {
  border-color: color-mix(in srgb, var(--ui-text-muted-fg) 45%, transparent);
  color: var(--ui-text-muted-fg);
}

.row-line {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 44px;
  padding: 0 6px;
  appearance: none;
  background: transparent;
  border: none;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.row-line:hover {
  background: var(--ui-state-hover-bg);
}

/* 选中 = 左 2px 墨边 + 主色字,不涂底(ui-system §1:账线域的选中态)。 */
.agent-row.is-active .row-line {
  box-shadow: inset 2px 0 0 var(--ui-accent-primary-fg);
}

.agent-row.is-active .row-name {
  color: var(--ui-accent-primary-fg);
}

/* 首列 6px 槽位,跨面板与 Media 的徽章、Music 的序号对齐。
   在职空心一档、退休再淡一档 —— 绿色留给"正在跑",而这一维数据还不存在
   (见模板里那段注释),所以这里一颗绿点都不画。 */
.row-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ui-border-strong-border);
}

.agent-row.is-retired .row-dot {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--ui-border-strong-border);
}

.agent-row.is-active .row-dot {
  background: var(--ui-accent-primary-fg);
}

.row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.row-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: var(--font-weight-medium, 500);
  color: var(--ui-text-primary-fg);
}

.row-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

/* ---- editor sheet ---- */
.agent-editor {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: transparent;
}

.editor-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 8px 0 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-border-strong-border) 55%, transparent);
}

.agent-editor .back-btn {
  display: none; /* shown in stacked mode only */
  flex-shrink: 0;
}

.editor-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.editor-title h3 {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-display, var(--font-serif, serif));
  font-size: 15px;
  font-weight: var(--font-weight-semibold, 600);
  color: var(--ui-text-primary-fg);
}

.editor-title span {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  white-space: nowrap;
}

/* ── 资料块(agent-im-chat-ui.md §3.2)──────────────────────────────────
   空间页的第一眼是"这个人":一枚圆章 + 名字 + 职位 + 两个动作。画线风照旧 ——
   一条发丝线收底,没有卡片皮,没有阴影。 */
.agent-profile {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-border-default-border) 45%, transparent);
}

/* 画线圆章,与成员章、退役的联系人卡同一句法。 */
.profile-avatar {
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--ui-text-primary-fg) 32%, transparent);
  border-radius: 50%;
  font-size: 21px;
  line-height: 1;
}

.profile-avatar.agent-avatar-image {
  border-radius: 50%;
}

.profile-heading {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.profile-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: var(--font-weight-semibold, 600);
  color: var(--ui-text-primary-fg);
}

.profile-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--ui-text-muted-fg);
}

/* 墓碑:压暗一档,身份还在。 */
.profile-tombstone {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

.profile-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 14px;
}

.profile-description {
  flex: 0 0 auto;
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--ui-text-secondary-fg);
}

.profile-error {
  flex: 0 0 auto;
  margin-top: 6px;
}

.detail-tabs {
  flex: 0 0 auto;
  align-self: flex-start;
  padding: 10px 0 0;
}

.text-action:focus-visible,
.row-line:focus-visible {
  outline: 1px solid var(--ui-accent-primary-fg);
  outline-offset: -1px;
}

/* Narrow panel (not just narrow viewport): stack list/editor as slide-over */
@container (max-width: 640px) {
  .agents-layout {
    display: block;
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    padding: 8px 12px 12px;
  }

  .agents-list {
    width: 100%;
    height: 100%;
    position: absolute;
    top: 0;
    left: 0;
    padding: 8px 12px 12px;
    box-sizing: border-box;
    transform: translateX(0);
    transition: transform var(--duration-slow) var(--ease-out);
    z-index: 1;
  }

  .agent-editor {
    width: 100%;
    height: 100%;
    position: absolute;
    top: 0;
    left: 0;
    padding: 0 12px 12px;
    box-sizing: border-box;
    transform: translateX(100%);
    transition: transform var(--duration-slow) var(--ease-out);
    z-index: 2;
    background: var(--agents-pane-bg);
  }

  .detail-active .agents-list {
    transform: translateX(-20%);
  }

  .detail-active .agent-editor {
    transform: translateX(0);
  }

  .agent-editor .back-btn {
    display: inline-block;
  }
}

@media (prefers-reduced-motion: reduce) {
  .agents-panel {
    animation: none;
  }

  .agents-list,
  .agent-editor {
    transition: none;
  }
}

/* ---- list column ---- */
.agents-list {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 0 2px 8px 0;
  background: transparent;
}

/* 名册栏的滚动条(原本与 .editor-scroll 合写一条,后者已进 agent-space.css)。 */
.agents-list::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.agents-list::-webkit-scrollbar-track {
  background: transparent;
}

.agents-list::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--ui-text-muted-fg) 18%, transparent);
}

.agents-list::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--ui-text-muted-fg) 32%, transparent);
}

.status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
