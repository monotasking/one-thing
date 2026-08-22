<template>
  <section class="settings-section">
    <h3 class="section-title">
      Bash Tool Settings
    </h3>

    <!-- Enable Sandbox -->
    <div class="form-group">
      <div class="toggle-row">
        <label class="form-label">Enable Directory Sandbox</label>
        <Switch
          variant="ledger"
          :model-value="bashSettings.enableSandbox"
          aria-label="Enable Directory Sandbox"
          @update:model-value="updateSetting('enableSandbox', Boolean($event))"
        />
      </div>
      <p class="form-hint">
        Restrict command execution to allowed directories only
      </p>
    </div>

    <!-- Default Working Directory -->
    <div
      v-if="bashSettings.enableSandbox"
      class="form-group"
    >
      <label class="form-label">Default Working Directory</label>
      <div class="input-with-button">
        <Input
          variant="ledger"
          class="text-input"
          :model-value="bashSettings.defaultWorkingDirectory"
          placeholder="Leave empty to use current project directory"
          @update:model-value="updateSetting('defaultWorkingDirectory', $event)"
        />
        <Button
          unstyled
          class="browse-btn"
          @click="browseDirectory('default')"
        >
          Browse
        </Button>
      </div>
      <p class="form-hint">
        Commands will execute in this directory by default
      </p>
    </div>

    <!-- Allowed Directories -->
    <div
      v-if="bashSettings.enableSandbox"
      class="form-group"
    >
      <label class="form-label">Allowed Directories</label>
      <p class="form-hint">
        Commands can only access paths within these directories. Leave empty to use defaults.
      </p>

      <div
        v-if="bashSettings.allowedDirectories.length > 0"
        class="directory-list"
      >
        <div
          v-for="(dir, index) in bashSettings.allowedDirectories"
          :key="index"
          class="directory-item"
        >
          <span class="directory-path">{{ dir }}</span>
          <Button
            unstyled
            class="remove-btn"
            aria-label="Remove"
            @click="removeDirectory(index)"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <line
                x1="18"
                y1="6"
                x2="6"
                y2="18"
              />
              <line
                x1="6"
                y1="6"
                x2="18"
                y2="18"
              />
            </svg>
          </Button>
        </div>
      </div>
      <div
        v-else
        class="empty-hint"
      >
        Using default directories: project folder, ~/.onething, /tmp, ~/Downloads
      </div>

      <Button
        unstyled
        class="add-btn"
        @click="browseDirectory('add')"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <line
            x1="12"
            y1="5"
            x2="12"
            y2="19"
          />
          <line
            x1="5"
            y1="12"
            x2="19"
            y2="12"
          />
        </svg>
        Add Directory
      </Button>
    </div>

    <!-- Confirm Dangerous Commands -->
    <div class="form-group">
      <div class="toggle-row">
        <label class="form-label">Confirm Dangerous Commands</label>
        <Switch
          variant="ledger"
          :model-value="bashSettings.confirmDangerousCommands"
          aria-label="Confirm Dangerous Commands"
          @update:model-value="updateSetting('confirmDangerousCommands', Boolean($event))"
        />
      </div>
      <p class="form-hint">
        Require confirmation before executing rm, mv, git push, etc.
      </p>
    </div>

    <!-- Dangerous Command Whitelist -->
    <div
      v-if="bashSettings.confirmDangerousCommands"
      class="form-group"
    >
      <label class="form-label">Command Whitelist</label>
      <Input
        variant="ledger"
        class="text-input"
        :model-value="bashSettings.dangerousCommandWhitelist.join(', ')"
        placeholder="npm install, git push (comma separated)"
        @update:model-value="updateWhitelist"
      />
      <p class="form-hint">
        Commands starting with these prefixes will skip confirmation
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import Input from '@/components/common/Input.vue'
import Switch from '@/components/common/Switch.vue'
import { computed } from 'vue'
import type { AppSettings, BashToolSettings } from '@/types'
import { dialogApi } from '@/platform/dialog-client'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.settings-bash')

const props = defineProps<{
  settings: AppSettings
}>()

const emit = defineEmits<{
  'update:settings': [settings: AppSettings]
}>()

// Get bash settings with defaults
const bashSettings = computed<BashToolSettings>(() => {
  return props.settings.tools?.bash ?? {
    enableSandbox: true,
    defaultWorkingDirectory: '',
    allowedDirectories: [],
    confirmDangerousCommands: true,
    dangerousCommandWhitelist: [],
  }
})

function updateSetting<K extends keyof BashToolSettings>(key: K, value: BashToolSettings[K]) {
  const newBashSettings = { ...bashSettings.value, [key]: value }
  emit('update:settings', {
    ...props.settings,
    tools: {
      ...props.settings.tools,
      bash: newBashSettings,
    },
  })
}

function updateWhitelist(value: string) {
  const whitelist = value
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  updateSetting('dangerousCommandWhitelist', whitelist)
}

async function browseDirectory(mode: 'default' | 'add') {
  try {
    const result = await dialogApi.showOpen({
      properties: ['openDirectory'],
      title: mode === 'default' ? 'Select Default Working Directory' : 'Add Allowed Directory',
    })

    if (!result.canceled && result.filePaths.length > 0) {
      const selectedPath = result.filePaths[0]

      if (mode === 'default') {
        updateSetting('defaultWorkingDirectory', selectedPath)
      } else {
        // Add to allowed directories if not already present
        const current = [...bashSettings.value.allowedDirectories]
        if (!current.includes(selectedPath)) {
          current.push(selectedPath)
          updateSetting('allowedDirectories', current)
        }
      }
    }
  } catch (error) {
    log.error('directory picker failed', {}, error)
  }
}

function removeDirectory(index: number) {
  const current = [...bashSettings.value.allowedDirectories]
  current.splice(index, 1)
  updateSetting('allowedDirectories', current)
}
</script>

<style scoped>
/*
 * Bash settings — 画线风.
 * The two toggles are `<Switch variant="ledger">` and draw themselves;
 * .section-title chrome is drawn by the SettingsPage :deep() layer.
 */
.settings-section {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--settings-rule, var(--ui-border-default-border));
}

.form-group {
  margin-bottom: 20px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  display: block;
  margin-bottom: 6px;
}

.form-hint {
  font-size: 12px;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  margin-top: 4px;
  margin-bottom: 0;
}

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* Text input: square drafting box drawn by `<Input variant="ledger">`;
   the mono face for paths/commands stays local. */
.text-input :deep(.app-input-inner) {
  font-family: var(--font-mono, monospace);
  font-size: 12.5px;
}

/* Input with button */
.input-with-button {
  display: flex;
  gap: 8px;
}

.input-with-button .text-input {
  flex: 1;
}

.browse-btn {
  padding: 9px 14px;
  font-size: 13px;
  font-weight: 500;
  color: var(--settings-ink-2, var(--ui-text-primary-fg));
  background: transparent;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  border-radius: 0;
  cursor: pointer;
  transition: border-color var(--duration-normal), color var(--duration-normal);
  white-space: nowrap;
}

.browse-btn:hover {
  background: transparent;
  border-color: var(--settings-ink-3, var(--ui-text-muted-fg));
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

/* Directory list: ledger rows on hairlines, no boxes. */
.directory-list {
  display: flex;
  flex-direction: column;
  margin-top: 12px;
  margin-bottom: 12px;
}

.directory-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  background: transparent;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--settings-rule-soft, var(--ui-border-subtle-border, var(--ui-border-default-border))) 55%, transparent);
}

.directory-path {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 4px;
  background: transparent;
  border: none;
  border-radius: 0;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  cursor: pointer;
  transition: color var(--duration-normal);
}

.remove-btn:hover {
  background: transparent;
  color: var(--ui-status-danger-fg);
}

/* Empty state: dashed frame + faint ink. */
.empty-hint {
  font-size: 12px;
  color: var(--settings-ink-4, var(--ui-text-faint-fg, var(--ui-text-muted-fg)));
  padding: 10px 12px;
  background: transparent;
  border: 1px dashed var(--settings-rule, var(--ui-border-default-border));
  border-radius: 0;
  margin-top: 12px;
  margin-bottom: 12px;
}

/* Add row: text action, underline carries the hover. */
.add-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: color var(--duration-normal);
}

.add-btn:hover {
  background: transparent;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--settings-accent, var(--ui-accent-primary-fg));
}
</style>
