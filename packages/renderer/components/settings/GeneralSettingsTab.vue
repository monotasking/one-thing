<template>
  <div class="tab-content">
    <!-- 我的资料(docs/design/agent-dm-user.md §2.4):agent 一直有名字和脸,
         用户没有。这四行补的就是那一半 —— 模型面的称呼、dm 的目标、UI 的署名
         全部从这里取。放最顶是因为它是"这个应用里的我是谁"。 -->
    <SettingsSection title="我的资料">
      <SettingsGroup>
        <SettingRow
          label="名字"
          description="群聊署名、agent 对你的称呼。留空就是「用户」。"
        >
          <Input
            variant="ledger"
            :model-value="userProfile.name || ''"
            maxlength="24"
            placeholder="用户"
            spellcheck="false"
            @update:model-value="updateUserProfile({ name: $event })"
          />
        </SettingRow>

        <SettingRow
          label="句柄"
          description="agent 用 @句柄 点你、用 dm 找你。小写字母/数字/-/_,留空就是 user。"
        >
          <Input
            variant="ledger"
            :model-value="userProfile.handle || ''"
            maxlength="24"
            placeholder="user"
            spellcheck="false"
            @update:model-value="updateUserProfile({ handle: $event })"
            @blur="normalizeHandleOnBlur"
          />
        </SettingRow>

        <SettingRow
          label="头像"
          description="一个 emoji;选了图片就以图片为准。"
        >
          <div class="user-avatar-row">
            <AgentAvatar
              class="user-avatar-preview"
              :avatar="userProfile.avatar || USER_AVATAR_FALLBACK"
              :avatar-image="userProfile.avatarImage"
              :size="28"
            />
            <Input
              variant="ledger"
              class="user-avatar-input"
              :model-value="userProfile.avatar || ''"
              maxlength="16"
              placeholder="🙂"
              spellcheck="false"
              @update:model-value="updateUserProfile({ avatar: $event })"
            />
            <Button
              unstyled
              class="secondary-btn"
              native-type="button"
              :disabled="avatarImageBusy"
              @click="pickAvatarImage"
            >
              {{ avatarImageBusy ? '…' : (userProfile.avatarImage ? '换图片' : '选图片') }}
            </Button>
            <Button
              v-if="userProfile.avatarImage"
              unstyled
              class="secondary-btn"
              native-type="button"
              :disabled="avatarImageBusy"
              @click="updateUserProfile({ avatarImage: '' })"
            >
              清除
            </Button>
            <input
              ref="avatarFileInputRef"
              class="user-avatar-file-input"
              type="file"
              accept="image/*"
              @change="onAvatarFileChosen"
            >
          </div>
        </SettingRow>

        <SettingRow
          label="私聊消息系统通知"
          description="不在这间房时,私聊来消息弹一条系统通知。"
        >
          <Switch
            variant="ledger"
            :model-value="dmNotificationsEnabled"
            aria-label="私聊消息系统通知"
            @update:model-value="updateDmNotifications(Boolean($event))"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <!-- Mode (Light/Dark/System) -->
    <SettingsSection title="Mode">
      <SettingsGroup>
        <SettingRow
          label="Theme Mode"
          description="Choose a fixed appearance or follow the system setting."
        >
          <Select
            v-bind="LEDGER_SELECT"
            class="prefer-select"
            :model-value="settings.theme"
            :options="THEME_MODE_OPTIONS"
            aria-label="Theme Mode"
            @update:model-value="updateTheme(String($event) as 'light' | 'dark' | 'system')"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <!-- Theme Selection -->
    <SettingsSection title="Theme">
      <ThemeSelectorPanel @theme-change="handleThemeChange" />
    </SettingsSection>

    <!-- Typography -->
    <SettingsSection title="Typography">
      <SettingsGroup>
        <SettingRow
          label="Interface Density"
          description="Controls UI text scale and line height outside the chat message density setting."
        >
          <div class="segmented-control typography-density-control">
            <Button
              unstyled
              :class="['segment-btn', { active: currentTypographyDensity === 'compact' }]"
              native-type="button"
              @click="updateTypographyDensity('compact')"
            >
              Compact
            </Button>
            <Button
              unstyled
              :class="['segment-btn', { active: currentTypographyDensity === 'comfortable' }]"
              native-type="button"
              @click="updateTypographyDensity('comfortable')"
            >
              Comfortable
            </Button>
          </div>
        </SettingRow>

        <!-- 输入区宽度:极简裁决 —— 只给四档,不给像素。量尺住在
             components/chat/composer-width.ts,设置页一个数字都不认识。 -->
        <SettingRow
          label="Composer Width"
          description="How wide the input area is. Standard follows the reading column."
        >
          <Select
            v-bind="LEDGER_SELECT"
            class="prefer-select"
            :model-value="currentComposerWidth"
            :options="COMPOSER_WIDTH_OPTIONS"
            aria-label="Composer Width"
            @update:model-value="updateComposerWidth(String($event) as ComposerWidthGear)"
          />
        </SettingRow>

        <!-- Font Size -->
        <SettingRow description="Font size for chat text.">
          <template #label>
            <span class="setting-title-row">
              <span>Font Size</span>
              <Tooltip text="Reset font size">
                <Button
                  unstyled
                  class="reset-inline"
                  native-type="button"
                  aria-label="Reset font size"
                  @click="updateFontSize(defaultFontSize)"
                >
                  <RotateCcw :size="14" />
                </Button>
              </Tooltip>
            </span>
          </template>
          <InputNumber
            :model-value="currentFontSize"
            :min="minFontSize"
            :max="maxFontSize"
            aria-label="font size"
            @update:model-value="updateFontSize"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection title="Context Compact">
      <SettingsGroup>
        <SettingRow
          label="Enable automatic compact"
          description="Summarizes older chat history before the context limit. Memory writes during compact are controlled separately in Memory settings."
        >
          <Switch
            variant="ledger"
            :model-value="contextCompactEnabled"
            aria-label="Enable automatic compact"
            @update:model-value="updateContextCompactEnabled(Boolean($event))"
          />
        </SettingRow>

        <SettingRow
          label="Auto compact threshold"
          description="Compact older chat history when context usage reaches this percentage."
        >
          <InputNumber
            :model-value="contextCompactThreshold"
            :min="50"
            :max="100"
            :step="5"
            suffix="%"
            :disabled="!contextCompactEnabled"
            aria-label="auto compact threshold"
            @update:model-value="updateContextCompactThreshold"
          />
        </SettingRow>

        <SettingRow
          label="Keep recent turns"
          description="Keep this many recent turns verbatim before summarizing older context."
        >
          <InputNumber
            :model-value="contextCompactKeepRecentTurns"
            :min="1"
            :max="20"
            :disabled="!contextCompactEnabled"
            aria-label="recent turns to keep"
            @update:model-value="updateContextCompactKeepRecentTurns"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection title="Agent Turns">
      <SettingsGroup>
        <SettingRow
          label="Max turns per run"
          description="Model round-trips allowed before a response is cut off (finishReason 'max_turns'). Raise this for tool-heavy tasks that need many steps in a row."
        >
          <InputNumber
            :model-value="maxTurns"
            :min="1"
            :max="500"
            aria-label="max turns per run"
            @update:model-value="updateMaxTurns"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection title="Diagnostics">
      <SettingsGroup>
        <SettingRow
          label="诊断模式"
          description="出问题时打开:日志降到 debug(app.jsonl),并把 provider 请求正文转储到 log/dumps/。平时保持关闭 —— 转储会很大。查看:bun run log:tail。"
        >
          <Switch
            variant="ledger"
            :model-value="diagnosticsEnabled"
            aria-label="诊断模式"
            @update:model-value="updateDiagnosticsEnabled(Boolean($event))"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <!-- English Font -->
    <SettingsSection title="Fonts">
      <SettingsGroup>
        <SettingRow
          label="English Font"
          description="Primary Latin text face."
        >
          <Select
            v-bind="LEDGER_SELECT"
            class="font-select"
            :model-value="currentFontEn"
            :options="enFontOptions"
            aria-label="English Font"
            @update:model-value="updateFontEn(String($event))"
          >
            <template #option="{ option, label }">
              <span
                class="font-option"
                :style="{ fontFamily: (option as FontOption).family }"
              >{{ label }}</span>
            </template>
          </Select>
        </SettingRow>

        <!-- Chinese Font -->
        <SettingRow
          label="中文字体"
          description="Primary CJK text face."
        >
          <Select
            v-bind="LEDGER_SELECT"
            class="font-select"
            :model-value="currentFontZh"
            :options="zhFontOptions"
            aria-label="中文字体"
            @update:model-value="updateFontZh(String($event))"
          >
            <template #option="{ option, label }">
              <span
                class="font-option"
                :style="{ fontFamily: (option as FontOption).family }"
              >{{ label }}</span>
            </template>
          </Select>
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection title="Daily Notes">
      <SettingsGroup>
        <SettingRow
          label="Enable Search Everywhere daily notes"
          description="Adds the Daily tab and today shortcut."
        >
          <Switch
            variant="ledger"
            :model-value="dailyNotes.enabled !== false"
            aria-label="Enable Search Everywhere daily notes"
            @update:model-value="updateDailyNotes({ enabled: Boolean($event) })"
          />
        </SettingRow>

        <SettingRow
          label="Source Directory"
          description="Choose where daily note files are read from."
        >
          <div class="segmented-control">
            <Button
              unstyled
              :class="['segment-btn', { active: (dailyNotes.directoryMode || 'personal') === 'personal' }]"
              native-type="button"
              @click="updateDailyNotes({ directoryMode: 'personal' })"
            >
              Personal note dir
            </Button>
            <Button
              unstyled
              :class="['segment-btn', { active: dailyNotes.directoryMode === 'custom' }]"
              native-type="button"
              @click="updateDailyNotes({ directoryMode: 'custom' })"
            >
              Custom directory
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          v-if="dailyNotes.directoryMode === 'custom'"
          label="Custom Directory"
          description="Folder containing daily note files."
        >
          <div
            class="directory-field"
          >
            <Input
              variant="ledger"
              :model-value="dailyNotes.customDirectory || ''"
              placeholder="/path/to/daily-notes"
              spellcheck="false"
              @update:model-value="updateDailyNotes({ customDirectory: $event })"
            />
            <Button
              unstyled
              class="secondary-btn"
              native-type="button"
              :disabled="!canChooseLocalDirectory"
              @click="chooseDailyNoteDirectory"
            >
              Choose
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          label="Use Obsidian Daily Notes config"
          description="Reads .obsidian/daily-notes.json when available."
        >
          <Switch
            variant="ledger"
            :model-value="dailyNotes.useObsidianConfig !== false"
            aria-label="Use Obsidian Daily Notes config"
            @update:model-value="updateDailyNotes({ useObsidianConfig: Boolean($event) })"
          />
        </SettingRow>

        <SettingRow
          label="Fallback Date Format"
          description="Used when Obsidian daily note config is unavailable."
        >
          <Input
            variant="ledger"
            :model-value="dailyNotes.format || 'YYYY-MM-DD'"
            placeholder="YYYY-MM-DD"
            spellcheck="false"
            @update:model-value="updateDailyNotes({ format: $event })"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection title="Todo / Plan">
      <SettingsGroup>
        <SettingRow
          label="Enable todo card"
          description="Shows the markdown todo and plan card in chat."
        >
          <Switch
            variant="ledger"
            :model-value="todoPlan.enabled !== false"
            aria-label="Enable todo card"
            @update:model-value="updateTodoPlan({ enabled: Boolean($event) })"
          />
        </SettingRow>

        <SettingRow
          label="Markdown Directory"
          description="Folder where todo and plan markdown files are stored."
        >
          <div class="directory-field">
            <Input
              variant="ledger"
              :model-value="todoPlan.directory || ''"
              placeholder="Default: ~/.onething/todo-plan"
              spellcheck="false"
              @update:model-value="updateTodoPlan({ directory: $event })"
            />
            <Button
              unstyled
              class="secondary-btn"
              native-type="button"
              :disabled="!canChooseLocalDirectory"
              @click="chooseTodoPlanDirectory"
            >
              Choose
            </Button>
          </div>
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
import { computed, ref } from 'vue'
import { RotateCcw } from 'lucide-vue-next'
import type { SelectOptionLike } from '@/components/common/select'
import type { AppSettings, TypographyDensity } from '@/types'
import { normalizeComposerWidth } from '@shared/defaults/settings'
import type { DailyNoteSettings, UserProfileSettings } from '@shared/ipc/settings'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import { AVATAR_IMAGE_MAX_PX, downscaleImageToPngDataUrl } from '@/components/common/agent-avatar'
import { USER_AVATAR_FALLBACK } from '@/composables/useUserProfile'
import { normalizeCollabUserHandle } from '@onething/runtime/collab'
import { useMediaStore } from '@/stores/media'
import type { TodoPlanSettings } from '@shared/ipc/todo-plan'
import InputNumber from '@/components/common/InputNumber.vue'
import ThemeSelectorPanel from './ThemeSelectorPanel.vue'
import { getFontsByLang, DEFAULT_FONT_EN, DEFAULT_FONT_ZH } from '@shared/fonts'
import {
  SettingRow,
  SettingsGroup,
  SettingsSection,
} from './settings-primitives'
import { platformApi } from '@/platform'

const props = defineProps<{
  settings: AppSettings
}>()

const emit = defineEmits<{
  'update:settings': [settings: AppSettings]
}>()


/**
 * One spelling of "a settings-area dropdown", spread onto every Select on this
 * tab. `teleported` is not optional: the settings body is a scroll container,
 * and an in-flow panel gets clipped by it near the bottom of the page.
 */
const LEDGER_SELECT = {
  variant: 'ledger',
  size: 'small',
  teleported: true,
  fitInputWidth: true,
} as const

const THEME_MODE_OPTIONS: SelectOptionLike[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/**
 * 输入区宽度档位:**只暴露档位,不暴露数字**。四档背后的量尺(34rem /
 * 内容列 / 56rem / 撑满)住在 ChatPanel 的测量里 —— 这里连一个像素值都不该有。
 * 类型从 settings 上现取:少一条 import,就少一处与契约漂移的机会。
 */
type ComposerWidthGear = NonNullable<AppSettings['general']['composerWidth']>

const COMPOSER_WIDTH_OPTIONS: SelectOptionLike[] = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'standard', label: 'Standard' },
  { value: 'wide', label: 'Wide' },
  { value: 'full', label: 'Full' },
]

/** Font rows keep their own family on the option so the list previews itself. */
type FontOption = { value: string, label: string, family: string }

// Available fonts by language
const enFonts = getFontsByLang('en')
const zhFonts = getFontsByLang('zh')
const enFontOptions: SelectOptionLike[] = enFonts.map(font => (
  { value: font.id, label: font.name, family: font.family } satisfies FontOption
))
const zhFontOptions: SelectOptionLike[] = zhFonts.map(font => (
  { value: font.id, label: font.name, family: font.family } satisfies FontOption
))
const minFontSize = 12
const maxFontSize = 20
const defaultFontSize = 15

const currentFontSize = computed(() => props.settings.chat?.chatFontSize ?? defaultFontSize)
const currentTypographyDensity = computed<TypographyDensity>(() => (
  props.settings.general.typographyDensity === 'comfortable' ? 'comfortable' : 'compact'
))
/** 归一走 @shared 的那一个 —— 非法/缺失回落缺省档,判据不在这里再写一遍。 */
const currentComposerWidth = computed<ComposerWidthGear>(() =>
  normalizeComposerWidth(props.settings.general.composerWidth) ?? 'standard')
const currentFontEn = computed(() => props.settings.chat?.chatFontEn ?? DEFAULT_FONT_EN)
const currentFontZh = computed(() => props.settings.chat?.chatFontZh ?? DEFAULT_FONT_ZH)
const contextCompactEnabled = computed(() => props.settings.chat?.contextCompactEnabled !== false)
const diagnosticsEnabled = computed(() => props.settings.diagnostics?.enabled === true)
const contextCompactThreshold = computed(() => props.settings.chat?.contextCompactThreshold ?? 85)
const contextCompactKeepRecentTurns = computed(() => props.settings.chat?.contextCompactKeepRecentTurns ?? 6)
const maxTurns = computed(() => props.settings.chat?.maxTurns ?? 100)
const canChooseLocalDirectory = computed(() => platformApi.capabilities.localFileSystem)
const dailyNotes = computed<DailyNoteSettings>(() => ({
  enabled: true,
  directoryMode: 'personal',
  customDirectory: '',
  useObsidianConfig: true,
  format: 'YYYY-MM-DD',
  ...props.settings.general.dailyNotes,
}))
const todoPlan = computed<TodoPlanSettings>(() => ({
  enabled: true,
  directory: '',
  cardHeight: 360,
  pinned: false,
  docked: false,
  ...props.settings.general.todoPlan,
}))

/* ── 我的资料(agent-dm-user.md §2.4)──────────────────────────────────
   四个字段全落 `general.userProfile`,与其它 general 设置同一条保存链;
   句柄的清洗规则从 @onething/runtime/collab 取,与 dm 解析同一份实现。 */
const userProfile = computed<UserProfileSettings>(() => props.settings.general?.userProfile ?? {})

const dmNotificationsEnabled = computed(() => props.settings.general?.dmNotifications !== false)

function updateUserProfile(patch: Partial<UserProfileSettings>) {
  emit('update:settings', {
    ...props.settings,
    general: {
      ...props.settings.general,
      userProfile: { ...userProfile.value, ...patch },
    },
  })
}

function updateDmNotifications(enabled: boolean) {
  emit('update:settings', {
    ...props.settings,
    general: { ...props.settings.general, dmNotifications: enabled },
  })
}

/* 清洗放在 blur 而不是每次 input:边打字边被改写(「Yi」→「yi」)会把光标
   顶走,而句柄本来就只在保存后才有人读。 */
function normalizeHandleOnBlur(event: FocusEvent) {
  const raw = (event.target as HTMLInputElement).value
  if (!raw.trim()) return
  const normalized = normalizeCollabUserHandle(raw)
  if (normalized !== raw) updateUserProfile({ handle: normalized })
}

const avatarFileInputRef = ref<HTMLInputElement | null>(null)
const avatarImageBusy = ref(false)

function pickAvatarImage() {
  avatarFileInputRef.value?.click()
}

/* 与 agent 头像逐字同一条链:降采样 → 存进媒体库 → 字段里只留文件名。 */
async function onAvatarFileChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 无论成败都清空:同一个文件再选一次必须重新触发 change。
  input.value = ''
  if (!file) return

  avatarImageBusy.value = true
  try {
    const base64 = await downscaleImageToPngDataUrl(file, AVATAR_IMAGE_MAX_PX)
    const fileName = await useMediaStore().savePersonaAvatar({
      base64,
      label: userProfile.value.name || undefined,
    })
    if (fileName) updateUserProfile({ avatarImage: fileName })
  } catch {
    // 存不下就保持原样:头像是可选项,一次失败不该拦住别的设置。
  } finally {
    avatarImageBusy.value = false
  }
}

function updateTheme(theme: 'light' | 'dark' | 'system') {
  emit('update:settings', { ...props.settings, theme })
}

// Handle theme change from ThemeSelectorPanel
// This syncs localSettings with themeStore to prevent overwrites
function handleThemeChange(darkThemeId: string, lightThemeId: string) {
  emit('update:settings', {
    ...props.settings,
    general: {
      ...props.settings.general,
      darkThemeId,
      lightThemeId,
    },
  })
}

function updateFontSize(size: number) {
  emit('update:settings', {
    ...props.settings,
    chat: {
      ...props.settings.chat!,
      chatFontSize: Math.max(minFontSize, Math.min(maxFontSize, size)),
    },
  })
}

function updateTypographyDensity(typographyDensity: TypographyDensity) {
  emit('update:settings', {
    ...props.settings,
    general: {
      ...props.settings.general,
      typographyDensity,
    },
  })
}

function updateComposerWidth(composerWidth: ComposerWidthGear) {
  emit('update:settings', {
    ...props.settings,
    general: {
      ...props.settings.general,
      composerWidth,
    },
  })
}

function updateFontEn(fontId: string) {
  emit('update:settings', {
    ...props.settings,
    chat: {
      ...props.settings.chat!,
      chatFontEn: fontId,
    },
  })
}

function updateFontZh(fontId: string) {
  emit('update:settings', {
    ...props.settings,
    chat: {
      ...props.settings.chat!,
      chatFontZh: fontId,
    },
  })
}

function updateDiagnosticsEnabled(enabled: boolean) {
  emit('update:settings', {
    ...props.settings,
    diagnostics: { ...props.settings.diagnostics, enabled },
  })
}

function updateContextCompactEnabled(enabled: boolean) {
  emit('update:settings', {
    ...props.settings,
    chat: {
      ...props.settings.chat!,
      contextCompactEnabled: enabled,
    },
  })
}

function updateContextCompactThreshold(threshold: number) {
  emit('update:settings', {
    ...props.settings,
    chat: {
      ...props.settings.chat!,
      contextCompactThreshold: Math.max(50, Math.min(100, threshold)),
    },
  })
}

function updateContextCompactKeepRecentTurns(turns: number) {
  emit('update:settings', {
    ...props.settings,
    chat: {
      ...props.settings.chat!,
      contextCompactKeepRecentTurns: Math.max(1, Math.min(20, turns)),
    },
  })
}

function updateMaxTurns(turns: number) {
  emit('update:settings', {
    ...props.settings,
    chat: {
      ...props.settings.chat!,
      maxTurns: Math.max(1, Math.min(500, Math.round(turns))),
    },
  })
}

function updateDailyNotes(patch: Partial<DailyNoteSettings>) {
  emit('update:settings', {
    ...props.settings,
    general: {
      ...props.settings.general,
      dailyNotes: {
        ...dailyNotes.value,
        ...patch,
      },
    },
  })
}

function updateTodoPlan(patch: Partial<TodoPlanSettings>) {
  emit('update:settings', {
    ...props.settings,
    general: {
      ...props.settings.general,
      todoPlan: {
        ...todoPlan.value,
        ...patch,
      },
    },
  })
}

async function chooseDailyNoteDirectory() {
  if (!canChooseLocalDirectory.value) return
  const result = await platformApi.showOpenDialog({
    title: 'Choose Daily Notes Directory',
    properties: ['openDirectory'],
    defaultPath: dailyNotes.value.customDirectory || undefined,
  })
  if (!result.canceled && result.filePaths[0]) {
    updateDailyNotes({
      directoryMode: 'custom',
      customDirectory: result.filePaths[0],
    })
  }
}

async function chooseTodoPlanDirectory() {
  if (!canChooseLocalDirectory.value) return
  const result = await platformApi.showOpenDialog({
    title: 'Choose Todo / Plan Directory',
    properties: ['openDirectory'],
    defaultPath: todoPlan.value.directory || undefined,
  })
  if (!result.canceled && result.filePaths[0]) {
    updateTodoPlan({ directory: result.filePaths[0] })
  }
}


</script>

<style scoped>
/*
 * General tab — ledger 画线风.
 * Row/input/toggle/button visuals come from the SettingsPage :deep() layer;
 * only layout and tab-specific line-work live here.
 */
.tab-content {
  animation: fadeIn 0.15s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.setting-title-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.reset-inline {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default);
}

.reset-inline:hover {
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

.app-input-number {
  flex-shrink: 0;
}

/* P3: the dropdowns are `<Select variant="ledger">`; these two classes sit on
   the component root and may only carry layout — the paint is the variant's. */
.prefer-select {
  width: 100%;
  max-width: 176px;
  min-width: 0;
}

.font-select {
  width: 100%;
  max-width: 320px;
  min-width: 0;
}

/* The option previews itself in its own face; the label text is the sample. */
.font-option {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Segmented control: one ruled box; the active segment is marked by an
   accent underline (a line, not a filled pill). */
.segmented-control {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  width: 100%;
  max-width: 320px;
  min-width: 0;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  border-radius: 0;
  background: transparent;
}

.segment-btn {
  min-height: 30px;
  min-width: 0;
  padding-inline: 12px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-size: var(--type-label-size);
  line-height: var(--type-label-line-height);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default);
}

.segment-btn + .segment-btn {
  border-left: 1px solid var(--settings-rule-soft, var(--ui-border-subtle-border));
}

.segment-btn:hover {
  color: var(--settings-ink, var(--ui-text-primary-fg));
  background: transparent;
}

.segment-btn.active {
  color: var(--settings-accent, var(--ui-accent-primary-fg));
  background: transparent;
  box-shadow: inset 0 -2px 0 var(--settings-accent, var(--ui-accent-primary-fg));
}

.directory-field {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  min-width: 0;
}

.directory-field :deep(.app-input) {
  flex: 1;
  min-width: 0;
}

.secondary-btn {
  flex-shrink: 0;
  min-height: 32px;
  padding: 0 12px;
  cursor: pointer;
}

/* Disabled = dashed line + faint ink, not an opacity veil. */
.secondary-btn:disabled {
  border-style: dashed;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  cursor: not-allowed;
}

/* 我的资料 · 头像行:预览章 + emoji 输入 + 两枚文字动作,与目录行同一体例。 */
.user-avatar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

.user-avatar-preview {
  flex-shrink: 0;
  font-size: 22px;
}

.user-avatar-input {
  flex: 1;
  min-width: 0;
}

/* 文件选取器只是那两枚按钮的后端,自己从不出现。 */
.user-avatar-file-input {
  display: none;
}
</style>
