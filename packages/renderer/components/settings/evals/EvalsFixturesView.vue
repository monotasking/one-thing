<template>
  <div class="evals-fixtures-view">
    <!-- Loading -->
    <div
      v-if="store.fixturesLoading"
      class="evals-loading"
    >
      Loading fixtures...
    </div>

    <!-- Error -->
    <ErrorNote
      v-else-if="store.fixturesError"
      class="evals-error"
      :message="store.fixturesError"
    />

    <!-- Empty -->
    <div
      v-else-if="store.fixtures.length === 0"
      class="evals-empty"
    >
      No fixtures yet. Fixtures are auto-exported when turns have negative signals (retries, tool errors, aborts).
    </div>

    <!-- Fixtures list -->
    <div
      v-else
      class="evals-fixtures-list"
    >
      <div class="evals-fixtures-header">
        <span class="evals-fixtures-count">{{ store.fixtures.length }} fixtures</span>
      </div>

      <div
        v-for="fixture in store.fixtures"
        :key="fixture.path"
        class="evals-fixture-row"
        :class="{ expanded: expandedFixture === fixture.path }"
      >
        <div
          class="evals-fixture-summary"
          @click="toggleFixture(fixture.path)"
        >
          <div class="evals-fixture-meta">
            <span class="evals-fixture-date">{{ formatDate(fixture.capturedAt) }}</span>
            <span class="evals-fixture-provider">{{ fixture.provider }}/{{ fixture.model }}</span>
          </div>
          <div class="evals-fixture-preview">
            {{ fixture.userMessagePreview }}
          </div>
          <div class="evals-fixture-actions">
            <button
              class="evals-small-btn"
              @click.stop="promoteFixture(fixture)"
            >
              ⬆️ Promote
            </button>
          </div>
        </div>

        <!-- Expanded: fixture JSON -->
        <div
          v-if="expandedFixture === fixture.path"
          class="evals-fixture-details"
        >
          <div
            v-if="fixtureLoading"
            class="evals-loading"
          >
            Loading fixture...
          </div>
          <pre
            v-else-if="store.selectedFixture"
            class="evals-fixture-json"
          >{{ JSON.stringify(store.selectedFixture, null, 2) }}</pre>
        </div>
      </div>
    </div>

    <!-- Promote dialog -->
    <Dialog
      v-model:open="showPromoteDialog"
      variant="paper"
      :width="520"
      :dividers="false"
      :style="promoteDialogVars"
    >
      <div class="evals-promote-dialog">
        <h3>Promote Fixture to Test Case</h3>

        <!-- Basic info -->
        <label class="evals-form-label">
          Case ID
          <Input
            v-model="promoteForm.caseId"
            variant="ledger"
            placeholder="e.g. linux-unix-syntax"
          />
        </label>
        <label class="evals-form-label">
          Description
          <Input
            v-model="promoteForm.description"
            type="textarea"
            variant="ledger"
            :rows="2"
            placeholder="What does this case verify?"
          />
        </label>

        <!-- Assistant response preview -->
        <div
          v-if="promotedFixtureData"
          class="evals-response-preview"
        >
          <div class="evals-section-label">
            📤 Assistant Response
          </div>
          <div class="evals-response-content">
            {{ responsePreview }}
          </div>
          <div class="evals-response-meta">
            <span
              class="evals-meta-badge"
              :class="hasToolCalls ? 'has-tools' : 'no-tools'"
            >
              🔧 {{ promotedFixtureData.toolCallCount ?? 0 }} tool calls
            </span>
            <span class="evals-meta-badge">{{ promotedFixtureData.finishReason ?? 'unknown' }}</span>
          </div>
        </div>

        <!-- Structured expect builder -->
        <div class="evals-expect-builder">
          <div class="evals-section-label">
            🔍 Expectations (AND logic)
          </div>

          <!-- Tool Call -->
          <div class="evals-expect-group">
            <div class="evals-expect-group-title">
              🔧 Tool Call
            </div>
            <Checkbox
              v-model="promoteForm.hasToolCalls"
              class="evals-check"
              size="small"
              aria-label="Must make tool calls"
            >
              Must make tool calls
              <span
                v-if="autoSuggest.hasToolCalls"
                class="evals-auto-badge"
              >🎯 auto</span>
            </Checkbox>
            <Checkbox
              v-if="promotedToolNames.length > 0"
              v-model="promoteForm.useFirstToolCall"
              class="evals-check"
              size="small"
              :aria-label="`First tool call: ${promotedToolNames[0]}`"
            >
              First tool call: {{ promotedToolNames[0] }}
            </Checkbox>
          </div>

          <!-- Skill -->
          <div
            v-if="promotedSkills.length > 0"
            class="evals-expect-group"
          >
            <div class="evals-expect-group-title">
              🧩 Skill
            </div>
            <Checkbox
              v-model="promoteForm.anySkillUsed"
              class="evals-check"
              size="small"
              aria-label="Must use any skill"
            >
              Must use any skill
              <span
                v-if="autoSuggest.anySkillUsed"
                class="evals-auto-badge"
              >🎯 auto</span>
            </Checkbox>
          </div>

          <!-- MCP -->
          <div
            v-if="promotedMCPTools.length > 0"
            class="evals-expect-group"
          >
            <div class="evals-expect-group-title">
              🔌 MCP
            </div>
            <Checkbox
              v-model="promoteForm.mcpToolUsed"
              class="evals-check"
              size="small"
              aria-label="Must use MCP tools"
            >
              Must use MCP tools
              <span
                v-if="autoSuggest.mcpToolUsed"
                class="evals-auto-badge"
              >🎯 auto</span>
            </Checkbox>
          </div>

          <!-- Output -->
          <div class="evals-expect-group">
            <div class="evals-expect-group-title">
              📝 Output
            </div>
            <label class="evals-form-label-sm">Must contain:
              <Input
                v-model="promoteForm.contains"
                variant="ledger"
                placeholder="e.g. comparison complete"
              />
            </label>
            <label class="evals-form-label-sm">Must NOT contain:
              <Input
                v-model="promoteForm.notContains"
                variant="ledger"
                placeholder="e.g. sorry, I cannot"
              />
            </label>
            <!-- Row, not a label: the number input is a second control and must
                 not sit inside the checkbox's own <label>. -->
            <div class="evals-checkbox-row">
              <Checkbox
                v-model="promoteForm.useMinLength"
                size="small"
                aria-label="Min output length"
              >
                Min output length:
              </Checkbox>
              <Input
                :model-value="promoteForm.minOutputLength"
                variant="ledger"
                type="number"
                size="small"
                class="evals-num-input"
                aria-label="Minimum output length in characters"
                @update:model-value="promoteForm.minOutputLength = Number($event)"
              />
              <span>chars</span>
              <span
                v-if="autoSuggest.useMinLength"
                class="evals-auto-badge"
              >🎯 auto</span>
            </div>
          </div>

          <!-- Notes -->
          <label class="evals-form-label-sm">Notes:
            <Input
              v-model="promoteForm.notes"
              type="textarea"
              variant="ledger"
              :rows="2"
              placeholder="Why this case exists, what to watch for..."
            />
          </label>
        </div>

        <!-- Snapshot links -->
        <div
          v-if="promotedFixtureData"
          class="evals-snapshot-links"
        >
          <span
            v-if="hasPromptSnapshot"
            class="evals-link"
            @click="viewSnapshot('prompt')"
          >📄 Prompt</span>
          <span
            v-if="hasContextSnapshot"
            class="evals-link"
            @click="viewSnapshot('context')"
          >💬 Context</span>
        </div>

        <div class="evals-promote-actions">
          <button
            class="evals-action-btn"
            @click="showPromoteDialog = false"
          >
            Cancel
          </button>
          <button
            class="evals-action-btn primary"
            @click="handlePromote"
          >
            Promote
          </button>
        </div>
      </div>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, type CSSProperties } from "vue";
import Checkbox from "@/components/common/Checkbox.vue";
import Dialog from "@/components/common/Dialog.vue";
import ErrorNote from "@/components/common/ErrorNote.vue";
import Input from "@/components/common/Input.vue";
import { useConfirm } from "@/composables/useConfirm";
import { SETTINGS_DIALOG_VARS } from "@/components/settings/settings-dialog-vars";
import { useEvalsStore } from "@/stores/evals";
import type { EvalFixtureMeta } from "@/stores/evals";
import { getLogger } from "@/services/log";

const log = getLogger("renderer.evals");

const { confirm, notice } = useConfirm();

/**
 * Teleported out of `.settings-page`, so the `--settings-*` aliases the sheet's
 * markup is written against have to come with it (see SETTINGS_DIALOG_VARS).
 */
const promoteDialogVars: CSSProperties = {
  ...SETTINGS_DIALOG_VARS,
  "--app-dialog-bg": "var(--settings-paper)",
  "--app-dialog-border": "var(--settings-rule)",
  "--app-dialog-body-padding": "24px",
} as CSSProperties;

const store = useEvalsStore();
const expandedFixture = ref<string | null>(null);
const fixtureLoading = ref(false);
const showPromoteDialog = ref(false);
const promoteTarget = ref<EvalFixtureMeta | null>(null);

// Structured promote form
const promoteForm = ref({
  caseId: "",
  description: "",
  // Tool Call
  hasToolCalls: false,
  useFirstToolCall: false,
  // Skill
  anySkillUsed: false,
  // MCP
  mcpToolUsed: false,
  // Output
  contains: "",
  notContains: "",
  useMinLength: false,
  minOutputLength: 100,
  // Meta
  notes: "",
});

// Parsed fixture data for preview
const promotedFixtureData = ref<{
  content?: string;
  toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
  toolCallCount?: number;
  finishReason?: string;
  promptSnapshotRef?: string;
  contextSnapshotRef?: string;
  skills?: Array<{ name: string }>;
  toolNames?: string[];
} | null>(null);

const responsePreview = computed(() => {
  const c = promotedFixtureData.value?.content ?? "";
  return c.length > 300 ? c.slice(0, 300) + "..." : c || "(no content)";
});

const hasToolCalls = computed(() =>
  (promotedFixtureData.value?.toolCallCount ?? 0) > 0,
);

const promotedToolNames = computed(() =>
  promotedFixtureData.value?.toolCalls?.map((tc) => tc.name) ?? [],
);

const promotedSkills = computed(() =>
  promotedFixtureData.value?.skills ?? [],
);

const promotedMCPTools = computed(() =>
  (promotedFixtureData.value?.toolNames ?? []).filter((n) =>
    n.startsWith("mcp__"),
  ),
);

const hasPromptSnapshot = computed(() =>
  !!promotedFixtureData.value?.promptSnapshotRef,
);
const hasContextSnapshot = computed(() =>
  !!promotedFixtureData.value?.contextSnapshotRef,
);

// Auto-suggestions
const autoSuggest = computed(() => {
  const data = promotedFixtureData.value;
  if (!data)
    return {
      hasToolCalls: false,
      anySkillUsed: false,
      mcpToolUsed: false,
      useMinLength: false,
    };

  const noTools = (data.toolCallCount ?? 0) === 0;
  const shortReply = (data.content?.length ?? 0) < 50;

  return {
    hasToolCalls: noTools,
    anySkillUsed:
      (data.skills?.length ?? 0) > 0 &&
      !data.toolCalls?.some(
        (tc) =>
          tc.name === "read" ||
          (tc.name === "bash" &&
            String(tc.args?.command ?? "").includes("SKILL.md")),
      ),
    mcpToolUsed:
      (data.toolNames?.some((n) => n.startsWith("mcp__")) ?? false) &&
      !data.toolCalls?.some((tc) => tc.name.startsWith("mcp__")),
    useMinLength: shortReply && noTools,
  };
});

function formatDate(ts: string) {
  if (!ts) return "Unknown";
  const d = new Date(ts);
  return d.toLocaleString();
}

async function toggleFixture(path: string) {
  if (expandedFixture.value === path) {
    expandedFixture.value = null;
    return;
  }
  expandedFixture.value = path;
  fixtureLoading.value = true;
  await store.loadFixture(path);
  fixtureLoading.value = false;
}

function promoteFixture(fixture: EvalFixtureMeta) {
  promoteTarget.value = fixture;

  // Reset form
  promoteForm.value = {
    caseId: "",
    description: "",
    hasToolCalls: false,
    useFirstToolCall: false,
    anySkillUsed: false,
    mcpToolUsed: false,
    contains: "",
    notContains: "",
    useMinLength: false,
    minOutputLength: 100,
    notes: "",
  };

  // Parse fixture data for preview and auto-suggest
  // The fixture needs to be loaded first
  promotedFixtureData.value = null;
  loadAndParseFixture(fixture.path);

  showPromoteDialog.value = true;
}

async function loadAndParseFixture(path: string) {
  try {
    const res = await store.loadFixture(path);
    // Wait briefly for the store to update
    await new Promise((r) => setTimeout(r, 50));
    const fixture = store.selectedFixture as Record<string, unknown> | null;
    if (!fixture) return;

    const ar = fixture.assistantResponse as
      | Record<string, unknown>
      | undefined;
    const ctx = fixture.context as Record<string, unknown> | undefined;

    promotedFixtureData.value = {
      content: ar?.content != null ? String(ar.content) : undefined,
      toolCalls: (ar?.toolCalls as Array<Record<string, unknown>>)?.map(
        (tc) => ({
          name: String(tc.name ?? ""),
          args: tc.args as Record<string, unknown> | undefined,
        }),
      ),
      toolCallCount:
        (ar?.toolCalls as Array<unknown>)?.length ?? 0,
      finishReason: ar?.finishReason != null ? String(ar.finishReason) : undefined,
      promptSnapshotRef:
        fixture.promptSnapshotRef != null
          ? String(fixture.promptSnapshotRef)
          : undefined,
      contextSnapshotRef:
        fixture.contextSnapshotRef != null
          ? String(fixture.contextSnapshotRef)
          : undefined,
      skills: (ctx?.skills as Array<{ name: string }>),
      toolNames: (ctx?.toolNames as string[]),
    };
  } catch {
    // Ignore parse errors
  }
}

function viewSnapshot(type: "prompt" | "context") {
  // Open snapshot in a new view or inline expansion
  const ref =
    type === "prompt"
      ? promotedFixtureData.value?.promptSnapshotRef
      : promotedFixtureData.value?.contextSnapshotRef;
  if (ref) {
    // For now, just log — full snapshot viewer is a future enhancement
    log.debug("evals snapshot view requested", { type, ref });
  }
}

async function handlePromote() {
  if (!promoteTarget.value) return;

  const expect: Record<string, unknown> = {};
  const f = promoteForm.value;

  if (f.hasToolCalls) expect.hasToolCalls = true;
  if (f.useFirstToolCall && promotedToolNames.value[0]) {
    expect.firstToolCall = promotedToolNames.value[0];
  }
  if (f.anySkillUsed) expect.anySkillUsed = true;
  if (f.mcpToolUsed) expect.mcpToolUsed = true;
  if (f.contains) expect.contains = f.contains;
  if (f.notContains) expect.notContains = f.notContains;
  if (f.useMinLength && f.minOutputLength) {
    expect.minOutputLength = f.minOutputLength;
  }
  if (f.notes) expect.notes = f.notes;

  // Maintain backward compat: cast to the old { firstToolCall?, contains?, notContains? }
  const compat = expect as {
    firstToolCall?: string;
    contains?: string;
    notContains?: string;
  };

  const res = await store.promoteFixture({
    fixturePath: promoteTarget.value.path,
    caseId: promoteForm.value.caseId,
    description: promoteForm.value.description,
    expect: compat,
  });

  if (res.success) {
    showPromoteDialog.value = false;
    const runNow = await confirm({
      title: "Case created",
      message: `Case created at ${res.casePath}.\n\nRun it once to verify it fails under the current prompt?`,
      confirmText: "Run it",
      cancelText: "Not now",
      variant: "paper",
    });
    if (runNow) {
      store.activeView = "runs";
    }
  } else {
    await notice({ title: "Promote failed", message: res.error, variant: "paper" });
  }
}
</script>

<style scoped>
.evals-fixtures-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.evals-fixtures-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
}

.evals-fixtures-count {
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--settings-ink-4);
}

/* Fixture rows: hairline ledger rows; expansion is a left ink rule */
.evals-fixture-row {
  border-bottom: 1px solid var(--settings-rule-soft);
}

.evals-fixture-row:first-of-type {
  border-top: 1px solid var(--settings-rule-soft);
}

.evals-fixture-row.expanded {
  box-shadow: inset 2px 0 0 var(--settings-accent);
}

.evals-fixture-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 4px 10px 8px;
  cursor: pointer;
}

.evals-fixture-summary:hover .evals-fixture-preview {
  color: var(--settings-ink);
}

.evals-fixture-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 200px;
}

.evals-fixture-date {
  font-size: 12px;
  color: var(--settings-ink-2);
  font-weight: 520;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evals-fixture-provider {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--settings-ink-4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evals-fixture-preview {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--settings-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evals-fixture-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

/* Text action: mono small, accent underline on hover */
.evals-small-btn {
  appearance: none;
  padding: 2px 0;
  border: none;
  border-radius: 0;
  background: transparent;
  font-family: var(--font-mono, monospace);
  color: var(--settings-ink-3);
  font-size: 11px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default);
}

.evals-small-btn:hover {
  color: var(--settings-ink);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--settings-accent);
}

.evals-fixture-details {
  padding: 4px 4px 14px 8px;
  border-top: 1px solid color-mix(in srgb, var(--settings-rule-soft) 32%, transparent);
}

.evals-fixture-json {
  margin: 0;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--settings-ink-2);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 500px;
  overflow-y: auto;
  line-height: 1.5;
}

/* Promote dialog: the paper sheet is `Dialog variant="paper"` since P2; the
   scroll and the field stack stay here. */
.evals-promote-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.evals-promote-dialog h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 620;
  color: var(--settings-ink);
}

.evals-promote-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
}

.evals-form-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--settings-ink-3);
  font-weight: 520;
}

/* Fields are `<Input variant="ledger">`; the variant owns the square
   hairline frame and accent focus. */

/* Outlined buttons: state lives in the edge line, never a fill */
.evals-action-btn {
  padding: 6px 16px;
  border: 1px solid var(--settings-rule);
  border-radius: 0;
  background: transparent;
  color: var(--settings-ink-2);
  font-size: 13px;
  font-weight: 520;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default), border-color var(--duration-fast) var(--ease-default);
}

.evals-action-btn:hover {
  color: var(--settings-ink);
  border-color: var(--settings-accent);
}

.evals-action-btn.primary {
  border-color: var(--settings-accent);
  color: var(--settings-accent);
}

.evals-loading,
.evals-empty {
  text-align: center;
  padding: 30px;
  color: var(--settings-ink-4);
  font-size: 13px;
}

.evals-error {
  margin: 24px 0;
}

/* ── Promote dialog: enhanced styles ── */
/* Response excerpt held by a left rule, no filled block */
.evals-response-preview {
  border-left: 1px solid color-mix(in srgb, var(--settings-rule) 55%, transparent);
  padding: 2px 0 2px 10px;
}

.evals-section-label {
  font-size: 13px;
  font-weight: 620;
  color: var(--settings-ink);
  margin-bottom: 8px;
}

.evals-response-content {
  font-size: 12px;
  color: var(--settings-ink-2);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.4;
  margin-bottom: 8px;
  max-height: 120px;
  overflow-y: auto;
}

.evals-response-meta {
  display: flex;
  gap: 6px;
}

/* Badges: outlined rings, zero fill — colour lives in ink and edge */
.evals-meta-badge {
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  padding: 1px 8px 2px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--settings-rule) 80%, transparent);
  background: transparent;
  color: var(--settings-ink-3);
  font-weight: 520;
}

.evals-meta-badge.has-tools {
  border-color: var(--ui-status-success-border, var(--ui-status-success-fg));
  color: var(--ui-status-success-fg);
}

.evals-meta-badge.no-tools {
  border-color: var(--ui-status-danger-border, var(--ui-status-danger-fg));
  color: var(--ui-status-danger-fg);
}

.evals-expect-builder {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.evals-expect-group {
  border-left: 1px solid color-mix(in srgb, var(--settings-rule) 55%, transparent);
  padding: 2px 0 2px 10px;
}

.evals-expect-group-title {
  font-size: 11px;
  font-weight: 620;
  color: var(--settings-ink-3);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

/* P3: the marks are `<Checkbox size="small">` — these rules place them on the
   sheet and never paint them. The `.app-checkbox` qualifier is deliberate:
   a bare `.evals-check` ties with the component's own `.app-checkbox` rule at
   (0,1,0) and the winner would be injection order (ui-system.md §1). */
.app-checkbox.evals-check {
  display: flex;
  padding: 3px 0;
}

.evals-checkbox-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--settings-ink-2);
  padding: 3px 0;
}

.evals-auto-badge {
  font-size: 9px;
  padding: 1px 6px 2px;
  border-radius: 999px;
  border: 1px solid var(--ui-status-info-border, var(--ui-status-info-fg));
  background: transparent;
  color: var(--ui-status-info-fg);
  font-weight: 600;
}

.evals-form-label-sm {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--settings-ink-3);
}

/* Small number field: layout only — the paint is the ledger variant's. */
.evals-num-input {
  max-width: 64px;
  font-variant-numeric: tabular-nums;
}

.evals-snapshot-links {
  display: flex;
  gap: 12px;
  padding: 6px 0;
}

.evals-link {
  font-size: 12px;
  color: var(--settings-accent);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.evals-link:hover {
  color: var(--settings-ink);
  text-decoration-color: var(--settings-accent);
}
</style>
