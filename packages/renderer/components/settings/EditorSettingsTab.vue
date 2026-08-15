<template>
  <div class="tab-content">
    <!-- Tabs -->
    <SettingsSection title="Tabs">
      <SettingsGroup>
        <SettingRow
          label="Max Open Tabs"
          description="Maximum number of tabs kept open in a panel."
        >
          <InputNumber
            :model-value="currentMaxTabs"
            :min="3"
            :max="30"
            aria-label="max open tabs"
            @update:model-value="updateGeneral('maxTabs', $event)"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <!-- Text Editor -->
    <SettingsSection title="Text Editor">
      <SettingsGroup>
        <SettingRow
          label="Tab Size"
          description="Number of spaces used for each tab stop."
        >
          <InputNumber
            :model-value="currentEditor.tabSize"
            :min="1"
            :max="8"
            aria-label="tab size"
            @update:model-value="updateEditor({ tabSize: $event })"
          />
        </SettingRow>

        <SettingRow label="Line Wrapping">
          <Switch
            variant="ledger"
            :model-value="currentEditor.lineWrapping"
            aria-label="Line Wrapping"
            @update:model-value="updateEditor({ lineWrapping: Boolean($event) })"
          />
        </SettingRow>

        <SettingRow
          label="Soft Wrap Column"
          description="Preferred text width before soft wrapping."
        >
          <InputNumber
            :model-value="currentEditor.softWrapColumn"
            :values="softWrapColumnOptionsWithCurrent"
            suffix="ch"
            aria-label="soft wrap column"
            @update:model-value="updateEditor({ softWrapColumn: $event })"
          />
        </SettingRow>

        <SettingRow label="Syntax Highlighting">
          <Switch
            variant="ledger"
            :model-value="currentEditor.syntaxHighlighting"
            aria-label="Syntax Highlighting"
            @update:model-value="updateEditor({ syntaxHighlighting: Boolean($event) })"
          />
        </SettingRow>

        <SettingRow label="Completions">
          <Switch
            variant="ledger"
            :model-value="currentEditor.completionEnabled"
            aria-label="Completions"
            @update:model-value="updateEditor({ completionEnabled: Boolean($event) })"
          />
        </SettingRow>

        <SettingRow
          label="Composer Height"
          description="Maximum height of the message composer."
        >
          <InputNumber
            :model-value="currentEditor.composerMaxHeight"
            :values="composerHeightOptionsWithCurrent"
            suffix="px"
            aria-label="composer height"
            @update:model-value="updateEditor({ composerMaxHeight: $event })"
          />
        </SettingRow>

        <SettingRow
          label="Note Attachment Folder"
          description="Required for non-Obsidian note roots."
        >
          <Input
            variant="ledger"
            :model-value="currentEditor.markdownNoteAttachmentDirectory"
            placeholder="Required for non-Obsidian note roots"
            spellcheck="false"
            @update:model-value="updateEditor({ markdownNoteAttachmentDirectory: $event })"
          />
        </SettingRow>

        <SettingRow
          label="Project Attachment Folder"
          description="Where project note attachments are written."
        >
          <Input
            variant="ledger"
            :model-value="currentEditor.markdownProjectAttachmentDirectory"
            placeholder="Default: project root"
            spellcheck="false"
            @update:model-value="updateEditor({ markdownProjectAttachmentDirectory: $event })"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>

    <!-- File Preview -->
    <SettingsSection title="File Preview">
      <SettingsGroup>
        <SettingRow
          label="Preview Size Limit"
          description="Maximum file size to render in the preview."
        >
          <InputNumber
            :model-value="currentMaxFilePreviewKB"
            :values="previewSizeOptionsWithCurrent"
            suffix="KB"
            aria-label="preview size limit"
            @update:model-value="updateGeneral('maxFilePreviewKB', $event)"
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>
  </div>
</template>

<script setup lang="ts">
import Switch from '@/components/common/Switch.vue'
import Input from '@/components/common/Input.vue'
import { computed } from 'vue'
import type { AppSettings, EditorSettings } from '@/types'
import {
  SettingRow,
  SettingsGroup,
  SettingsSection,
} from './settings-primitives'
import InputNumber from '@/components/common/InputNumber.vue'

const props = defineProps<{
  settings: AppSettings
}>()

const emit = defineEmits<{
  'update:settings': [settings: AppSettings]
}>()

const currentMaxTabs = computed(() => props.settings.general.maxTabs ?? 15)
const currentMaxFilePreviewKB = computed(() => props.settings.general.maxFilePreviewKB ?? 256)
const currentEditor = computed<Required<EditorSettings>>(() => ({
  tabSize: props.settings.general.editor?.tabSize ?? 2,
  lineWrapping: props.settings.general.editor?.lineWrapping ?? true,
  softWrapColumn: props.settings.general.editor?.softWrapColumn ?? 88,
  syntaxHighlighting: props.settings.general.editor?.syntaxHighlighting ?? true,
  completionEnabled: props.settings.general.editor?.completionEnabled ?? true,
  composerMaxHeight: props.settings.general.editor?.composerMaxHeight ?? 200,
  markdownNoteAttachmentDirectory: props.settings.general.editor?.markdownNoteAttachmentDirectory ?? '',
  markdownProjectAttachmentDirectory: props.settings.general.editor?.markdownProjectAttachmentDirectory ?? '',
}))

const softWrapColumnOptions = [40, 60, 72, 80, 88, 100, 120, 140, 160, 180, 200]
const composerHeightOptions = [80, 120, 160, 200, 240, 280, 320, 360, 400, 480, 560, 640]
const previewSizeOptions = [64, 128, 256, 384, 512, 768, 1024]

function withCurrentOption(options: number[], current: number): number[] {
  return Array.from(new Set([...options, current])).sort((a, b) => a - b)
}

const softWrapColumnOptionsWithCurrent = computed(() =>
  withCurrentOption(softWrapColumnOptions, currentEditor.value.softWrapColumn)
)
const composerHeightOptionsWithCurrent = computed(() =>
  withCurrentOption(composerHeightOptions, currentEditor.value.composerMaxHeight)
)
const previewSizeOptionsWithCurrent = computed(() =>
  withCurrentOption(previewSizeOptions, currentMaxFilePreviewKB.value)
)

function updateGeneral(key: string, value: number) {
  emit('update:settings', {
    ...props.settings,
    general: {
      ...props.settings.general,
      [key]: value,
    },
  })
}

function updateEditor(patch: EditorSettings) {
  emit('update:settings', {
    ...props.settings,
    general: {
      ...props.settings.general,
      editor: {
        ...currentEditor.value,
        ...patch,
      },
    },
  })
}
</script>

<style scoped>
/*
 * Editor tab — ledger 画线风.
 * Row/input visuals come from the SettingsPage :deep() layer; the four toggles
 * are `<Switch variant="ledger">` and draw themselves. Only layout lives here.
 */
.tab-content {
  animation: fadeIn 0.15s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.app-input-number {
  flex-shrink: 0;
}
</style>
