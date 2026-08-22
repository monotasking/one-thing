<template>
  <div class="evals-records-view">
    <!-- Filter bar -->
    <div class="evals-filter-bar">
      <div class="evals-filter-row">
        <Checkbox
          class="evals-filter-toggle"
          :model-value="store.recordsFilter.negativeOnly"
          aria-label="Only negative signals"
          @update:model-value="toggleNegativeOnly(Boolean($event))"
        >
          Only negative signals
        </Checkbox>

        <Select
          v-bind="LEDGER_SELECT"
          :model-value="localFilter.category"
          :options="CATEGORY_OPTIONS"
          aria-label="Filter by category"
          @update:model-value="localFilter.category = String($event ?? ''); applyFilters()"
        />

        <Input
          v-model="localFilter.sinceDate"
          variant="ledger"
          type="date"
          class="evals-date-input"
          aria-label="Show records since this date"
          @change="applyFilters"
        />

        <Select
          v-bind="LEDGER_SELECT"
          :model-value="localFilter.provider"
          :options="providerOptions"
          aria-label="Filter by provider"
          @update:model-value="localFilter.provider = String($event ?? ''); applyFilters()"
        />
      </div>

      <button
        class="evals-action-btn"
        @click="handleGenerateTriage"
      >
        Generate Triage Draft
      </button>
    </div>

    <!-- Triage result -->
    <div
      v-if="triageReport"
      class="evals-triage-preview"
    >
      <div class="evals-triage-header">
        <strong>Triage Report Generated</strong>
        <button
          class="evals-close-btn"
          @click="triageReport = null"
        >
          &times;
        </button>
      </div>
      <pre class="evals-triage-content">{{ triageReport }}</pre>
    </div>

    <!-- Loading -->
    <div
      v-if="store.recordsLoading"
      class="evals-loading"
    >
      Loading records...
    </div>

    <!-- Error -->
    <ErrorNote
      v-else-if="store.recordsError"
      class="evals-error"
      :message="store.recordsError"
    />

    <!-- Empty -->
    <div
      v-else-if="store.records.length === 0"
      class="evals-empty"
    >
      No evaluation records yet. Records are created when you interact with the assistant.
    </div>

    <!-- Records list -->
    <div
      v-else
      class="evals-records-list"
    >
      <div class="evals-records-header">
        <span class="evals-records-count">{{ store.recordsTotal }} records</span>
      </div>

      <div
        v-for="record in store.records"
        :key="`${record.sessionId}-${record.turnId}`"
        class="evals-record-row"
        :class="{ expanded: expandedRecord === recordKey(record) }"
        @click="toggleRecord(record)"
      >
        <div class="evals-record-summary">
          <div class="evals-record-meta">
            <span class="evals-record-date">{{ formatDate(record.ts) }}</span>
            <span class="evals-record-provider">{{ record.provider }}/{{ record.model }}</span>
          </div>
          <div class="evals-record-signals">
            <Tooltip
              v-if="record.signals.retried"
              text="Retried"
            >
              <span class="evals-signal-badge bad">&#x1F504;</span>
            </Tooltip>
            <Tooltip
              v-if="record.signals.editResent"
              text="Edit &amp; Resent"
            >
              <span class="evals-signal-badge bad">&#x270F;&#xFE0F;</span>
            </Tooltip>
            <Tooltip
              v-if="record.signals.toolErrors > 0"
              text="Tool Errors"
            >
              <span class="evals-signal-badge bad">&#x26A0;&#xFE0F;{{ record.signals.toolErrors }}</span>
            </Tooltip>
            <Tooltip
              v-if="record.signals.streamAborted"
              text="Aborted"
            >
              <span class="evals-signal-badge bad">&#x1F6D1;</span>
            </Tooltip>
            <Tooltip
              v-if="record.explicit === 'down'"
              text="Downvoted"
            >
              <span class="evals-signal-badge bad">&#x1F44E;</span>
            </Tooltip>
            <span
              v-if="!hasNegativeSignals(record)"
              class="evals-signal-badge good"
            >&#x2705;</span>
          </div>
        </div>

        <!-- Expanded details -->
        <div
          v-if="expandedRecord === recordKey(record)"
          class="evals-record-details"
        >
          <div class="evals-detail-row">
            <span class="evals-detail-label">Session</span>
            <span class="evals-detail-value monospace">{{ record.sessionId.slice(0, 12) }}...</span>
          </div>
          <div class="evals-detail-row">
            <span class="evals-detail-label">Turn</span>
            <span class="evals-detail-value monospace">{{ record.turnId.slice(0, 12) }}...</span>
          </div>
          <div
            v-if="record.judge"
            class="evals-detail-row"
          >
            <span class="evals-detail-label">Judge</span>
            <span class="evals-detail-value">
              Score: {{ record.judge.score.toFixed(2) }} | {{ record.judge.category }} &mdash; {{ record.judge.reason }}
            </span>
          </div>
          <div
            v-if="record.fixtureRef"
            class="evals-detail-row"
          >
            <span class="evals-detail-label">Fixture</span>
            <span class="evals-detail-value monospace fixture-path">{{ record.fixtureRef }}</span>
          </div>
          <div class="evals-detail-row">
            <span class="evals-detail-label">Signals</span>
            <span class="evals-detail-value">
              {{ signalSummary(record) }}
            </span>
          </div>
          <div class="evals-detail-row">
            <button
              class="evals-action-btn"
              @click.stop="openSession(record.sessionId)"
            >
              Open Session
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import Checkbox from "@/components/common/Checkbox.vue";
import ErrorNote from "@/components/common/ErrorNote.vue";
import Input from "@/components/common/Input.vue";
import Select from "@/components/common/Select.vue";
import Tooltip from "@/components/common/Tooltip.vue";
import type { SelectOptionLike } from "@/components/common/select";
import { useEvalsStore } from "@/stores/evals";
import type { EvalRecordView } from "@/stores/evals";

const store = useEvalsStore();
const expandedRecord = ref<string | null>(null);
const triageReport = ref<string | null>(null);

const localFilter = ref({
  category: "",
  sinceDate: "",
  provider: "",
});

const uniqueProviders = computed(() => {
  const set = new Set(store.records.map((r) => r.provider));
  return [...set].sort();
});

/**
 * One spelling of "a filter-bar dropdown" — the `.evals-form-select` box this
 * sheet used to hand-draw is exactly `variant: 'ledger'`. `teleported` keeps
 * the panel out of the settings scroll container.
 *
 * No `fitInputWidth` here on purpose: these sit in an inline filter row and are
 * pinned narrow by `.evals-filter-select` below, while option labels run long
 * ("Ignored Known Projects") — a panel matched to the control would clip them.
 */
const LEDGER_SELECT = {
  class: "evals-filter-select",
  variant: "ledger",
  size: "small",
  teleported: true,
} as const;

const CATEGORY_OPTIONS: SelectOptionLike[] = [
  { value: "", label: "All categories" },
  { value: "missed-directory-switch", label: "Missed Directory Switch" },
  { value: "ignored-skill-instructions", label: "Ignored Skills" },
  { value: "voice-mode-violation", label: "Voice Mode Violation" },
  { value: "ignored-known-projects", label: "Ignored Known Projects" },
  { value: "wrong-platform-behavior", label: "Wrong Platform" },
  { value: "ignored-agent-instructions", label: "Ignored Agent" },
  { value: "general-poor-response", label: "General Poor Response" },
  { value: "not-prompt-fault", label: "Not Prompt Fault" },
];

const providerOptions = computed<SelectOptionLike[]>(() => [
  { value: "", label: "All providers" },
  ...uniqueProviders.value.map((p) => ({ value: p, label: p })),
]);

function recordKey(r: EvalRecordView) {
  return `${r.sessionId}::${r.turnId}`;
}

function toggleRecord(r: EvalRecordView) {
  const key = recordKey(r);
  expandedRecord.value = expandedRecord.value === key ? null : key;
}

function toggleNegativeOnly(checked: boolean) {
  store.recordsFilter.negativeOnly = checked;
  applyFilters();
}

function applyFilters() {
  store.recordsFilter.category = localFilter.value.category;
  store.recordsFilter.provider = localFilter.value.provider;
  if (localFilter.value.sinceDate) {
    store.recordsFilter.sinceTs = new Date(localFilter.value.sinceDate).toISOString();
  } else {
    store.recordsFilter.sinceTs = undefined;
  }
  void store.loadRecords();
}

function hasNegativeSignals(r: EvalRecordView) {
  if (r.explicit === "down") return true;
  if (r.judge && r.judge.score < 0.5) return true;
  const s = r.signals;
  return s.retried || s.editResent || s.streamAborted || s.toolErrors > 0 || s.permissionDenied;
}

function signalSummary(r: EvalRecordView) {
  const parts: string[] = [];
  if (r.signals.retried) parts.push("Retried");
  if (r.signals.editResent) parts.push("Edit & Resent");
  if (r.signals.toolErrors > 0) parts.push(`Tool Errors: ${r.signals.toolErrors}`);
  if (r.signals.streamAborted) parts.push("Aborted");
  if (r.signals.permissionDenied) parts.push("Permission Denied");
  if (r.explicit === "down") parts.push("Downvoted");
  return parts.length > 0 ? parts.join(", ") : "None";
}

function formatDate(ts: string) {
  const d = new Date(ts);
  return d.toLocaleString();
}

function openSession(sessionId: string) {
  // Switch to session via the sessions RPC domain.
  import("@/platform/sessions-client").then(({ sessionsApi }) => {
    void sessionsApi.switch({ sessionId });
  });
}

async function handleGenerateTriage() {
  const res = await store.generateTriage(1);
  if (res.success && res.report) {
    triageReport.value = res.report;
  }
}
</script>

<style scoped>
.evals-records-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.evals-filter-bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.evals-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* `.app-select` is `width: 100%` by default (it is built for form fields), so
   an inline filter row has to pin it or it eats the whole line. */
.app-select.evals-filter-select {
  width: 190px;
  flex: 0 0 auto;
}

/* P3: `<Checkbox>` draws the mark; this only seats it in the filter row.
   `.app-checkbox` qualifies the selector so it outranks the component's own
   (0,1,0) rule instead of tying with it (ui-system.md §1). */
.app-checkbox.evals-filter-toggle {
  align-items: center;
  gap: 6px;
  color: var(--settings-ink-2);
  white-space: nowrap;
}

.evals-date-input {
  max-width: 160px;
  font-variant-numeric: tabular-nums;
}

/* Fields are `<Input variant="ledger">`; the variant owns the square
   hairline frame and accent focus. */
.evals-action-btn {
  padding: 5px 12px;
  border: 1px solid var(--settings-rule);
  border-radius: 0;
  background: transparent;
  color: var(--settings-ink-2);
  font-size: 12px;
  font-weight: 520;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default), border-color var(--duration-fast) var(--ease-default);
  white-space: nowrap;
}

.evals-action-btn:hover {
  color: var(--settings-ink);
  border-color: var(--settings-accent);
}

.evals-records-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
}

.evals-records-count {
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--settings-ink-4);
}

/* Record rows: hairline ledger rows; expansion is a left ink rule */
.evals-record-row {
  border-bottom: 1px solid var(--settings-rule-soft);
  padding: 10px 4px 10px 8px;
  cursor: pointer;
  transition: box-shadow var(--duration-fast) var(--ease-default);
}

.evals-record-row:first-of-type {
  border-top: 1px solid var(--settings-rule-soft);
}

.evals-record-row:hover .evals-record-date {
  color: var(--settings-ink);
}

.evals-record-row.expanded {
  box-shadow: inset 2px 0 0 var(--settings-accent);
}

.evals-record-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.evals-record-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.evals-record-date {
  font-size: 13px;
  color: var(--settings-ink-2);
  font-weight: 520;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evals-record-provider {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--settings-ink-4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evals-record-signals {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

/* Signal badges: outlined rings, zero fill — colour lives in the edge */
.evals-signal-badge {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  padding: 1px 7px 2px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--settings-rule) 80%, transparent);
  background: transparent;
}

.evals-signal-badge.bad {
  border-color: var(--ui-status-danger-border, var(--ui-status-danger-fg));
  color: var(--ui-status-danger-fg);
}

.evals-signal-badge.good {
  border-color: var(--ui-status-success-border, var(--ui-status-success-fg));
  color: var(--ui-status-success-fg);
}

.evals-record-details {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--settings-rule-soft);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.evals-detail-row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
}

.evals-detail-label {
  color: var(--settings-ink-4);
  min-width: 60px;
  flex-shrink: 0;
}

.evals-detail-value {
  color: var(--settings-ink-2);
  min-width: 0;
  overflow-wrap: anywhere;
}

.monospace {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

.fixture-path {
  word-break: break-all;
}

.evals-triage-preview {
  border: 1px solid var(--settings-rule);
  border-left: 2px solid var(--settings-accent);
}

.evals-triage-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-bottom: 1px solid var(--settings-rule-soft);
  font-size: 13px;
  color: var(--settings-ink);
}

.evals-close-btn {
  border: none;
  background: none;
  color: var(--settings-ink-4);
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
}

.evals-triage-content {
  padding: 14px;
  font-size: 12px;
  color: var(--settings-ink-2);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  max-height: 400px;
  overflow-y: auto;
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
</style>
