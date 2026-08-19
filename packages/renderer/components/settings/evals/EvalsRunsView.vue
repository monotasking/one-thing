<template>
  <div class="evals-runs-view">
    <!-- Run Panel -->
    <div class="evals-run-panel">
      <h3 class="evals-section-title">
        Run Evaluation
      </h3>

      <div
        v-if="store.runInProgress"
        class="evals-run-progress"
      >
        <div class="evals-run-progress-header">
          <span class="evals-run-status">Running...</span>
          <button
            class="evals-action-btn danger"
            @click="handleCancelRun"
          >
            Cancel
          </button>
        </div>

        <!-- Total progress bar -->
        <div
          v-if="runTotalCases > 0"
          class="evals-progress-bar-wrap"
        >
          <div
            class="evals-progress-bar"
            :style="{ width: runProgressPct + '%' }"
          />
          <span class="evals-progress-label">{{ runCompletedCases }} / {{ runTotalCases }} cases ({{ runProgressPct }}%)</span>
        </div>

        <!-- Progress per case -->
        <div class="evals-run-case-list">
          <div
            v-for="[caseId, cp] in store.runCaseProgress"
            :key="caseId"
            class="evals-run-case-item"
          >
            <span class="evals-run-case-name">{{ caseId }}</span>
            <span class="evals-run-case-score">
              {{ cp.passes }}/{{ cp.attempts }}
              <span
                v-if="cp.score > 0"
                class="evals-run-case-pct"
              >
                ({{ (cp.score * 100).toFixed(0) }}%)
              </span>
            </span>
          </div>
        </div>

        <ErrorNote
          v-if="store.runProgress?.type === 'error'"
          :message="store.runProgress.error"
        />
      </div>

      <!-- Run form -->
      <div
        v-else
        class="evals-run-form"
      >
        <div class="evals-run-form-row">
          <div class="evals-form-label">
            <span>Provider</span>
            <Select
              v-bind="LEDGER_SELECT"
              :model-value="runForm.providerId"
              :options="providerOptions"
              aria-label="Provider"
              @update:model-value="runForm.providerId = String($event ?? '')"
            />
          </div>

          <label class="evals-form-label">
            Model
            <Input
              v-model="runForm.model"
              variant="ledger"
              placeholder="deepseek-v4-pro"
            />
          </label>

          <label class="evals-form-label">
            Runs (k)
            <Input
              :model-value="runForm.runs"
              variant="ledger"
              type="number"
              min="1"
              max="10"
              class="evals-form-input-narrow"
              @update:model-value="runForm.runs = Number($event)"
            />
          </label>

          <button
            class="evals-action-btn primary"
            :disabled="!runForm.providerId || !runForm.model"
            @click="handleStartRun"
          >
            Start Run
          </button>

          <!-- Show error from a failed run start -->
          <ErrorNote
            v-if="runError"
            :message="runError"
          />
        </div>

        <!-- Ablation sections -->
        <div class="evals-run-form-cases">
          <span class="evals-case-select-hint">Ablation (disable prompt sections):</span>
          <div class="evals-case-checkboxes">
            <Checkbox
              v-for="s in ablationSections"
              :key="s.key"
              class="evals-case-checkbox"
              size="small"
              :model-value="runForm.disabledSections.includes(s.key)"
              :aria-label="`Disable prompt section ${s.label}`"
              @update:model-value="toggleInList(runForm.disabledSections, s.key, Boolean($event))"
            >
              {{ s.label }}
            </Checkbox>
          </div>
        </div>

        <!-- Case selection -->
        <div
          v-if="store.cases.length > 0"
          class="evals-run-form-cases"
        >
          <span class="evals-case-select-hint">Select cases to run (all if none selected):</span>
          <div class="evals-case-checkboxes">
            <Checkbox
              v-for="c in store.cases.filter(c => !c.isSentinel)"
              :key="c.id"
              class="evals-case-checkbox"
              size="small"
              :model-value="runForm.caseIds.includes(c.id)"
              :aria-label="`Run case ${c.id}`"
              @update:model-value="toggleInList(runForm.caseIds, c.id, Boolean($event))"
            >
              {{ c.id }}
            </Checkbox>
          </div>
        </div>
      </div>
    </div>

    <!-- Run results -->
    <div
      v-if="store.runProgress?.type === 'run-done' && store.runProgress.entry"
      class="evals-run-result"
    >
      <div class="evals-run-result-header">
        <strong>Run Complete</strong>
        <span class="evals-run-mean">
          Mean: {{ formatPct(store.runProgress.entry.mean) }} ({{ store.runProgress.entry.evalSetSize }} cases, {{ store.runProgress.entry.runs }} runs)
        </span>
      </div>
    </div>

    <!-- Run History: left-right split -->
    <h3
      class="evals-section-title"
      style="margin-top:24px"
    >
      Run History
    </h3>

    <div class="evals-runs-split">
      <!-- LEFT: Run list -->
      <div class="evals-runs-list-panel">
        <div
          v-if="store.resultsLoading"
          class="evals-loading"
        >
          Loading...
        </div>
        <ErrorNote
          v-else-if="store.resultsError"
          class="evals-error"
          :message="store.resultsError"
        />
        <div
          v-else-if="store.results.length === 0"
          class="evals-empty"
        >
          No runs yet.
        </div>
        <div
          v-for="(entry, idx) in store.results"
          :key="entry.ts"
          class="evals-run-list-row"
          :class="{ selected: store.selectedRunIdx === idx }"
          @click="selectRun(idx)"
        >
          <div class="evals-run-list-date">
            {{ formatDate(entry.ts) }}
          </div>
          <div class="evals-run-list-provider">
            {{ entry.provider }}{{ entry.model ? ' / ' + entry.model : '' }}
          </div>
          <div class="evals-run-list-stats">
            <span class="evals-run-list-mean">{{ formatPct(entry.mean) }}</span>
            <span class="evals-run-list-detail">{{ entry.evalSetSize }} cases</span>
          </div>
        </div>
      </div>

      <!-- RIGHT: Detail panel -->
      <div class="evals-runs-detail-panel">
        <div
          v-if="store.selectedRunIdx === null"
          class="evals-empty"
        >
          Select a run to view details
        </div>
        <div
          v-else-if="store.runDetailLoading"
          class="evals-loading"
        >
          Loading...
        </div>
        <div
          v-else-if="!store.runDetail"
          class="evals-empty"
        >
          No detail data available for this run
        </div>
        <div
          v-else
          class="evals-run-detail"
        >
          <div class="evals-detail-header">
            <span class="evals-detail-title">{{ store.runDetail.provider }} / {{ store.runDetail.model }}</span>
            <span class="evals-detail-meta">Mean: {{ selectedRunMean != null ? formatPct(selectedRunMean) : '—' }}</span>
          </div>
          <!-- Case cards -->
          <div
            v-for="[caseId, cd] in Object.entries(store.runDetail.cases)"
            :key="caseId"
            class="evals-detail-case"
          >
            <div class="evals-detail-case-header">
              <span class="evals-detail-case-name">{{ caseId }}</span>
              <span class="evals-detail-case-score">{{ formatPct(cd.score) }} ({{ cd.attempts.filter(a => a.pass).length }}/{{ cd.attempts.length }})</span>
            </div>
            <div
              v-for="a in cd.attempts"
              :key="a.index"
              class="evals-detail-attempt"
              :class="{ pass: a.pass, fail: !a.pass }"
            >
              <span class="evals-attempt-icon">{{ a.pass ? '✓' : '✗' }}</span>
              <span class="evals-attempt-label">#{{ a.index }}</span>
              <span class="evals-attempt-reason">{{ a.reason }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Comparison table (kept, appears when two runs are selected for compare) -->
    <div
      v-if="store.runComparison"
      class="evals-comparison"
    >
      <h3 class="evals-section-title">
        Comparison
        <span class="evals-compare-hint">
          {{ formatDate(store.runComparison.a.ts) }} &rarr; {{ formatDate(store.runComparison.b.ts) }}
        </span>
      </h3>

      <table class="evals-compare-table">
        <thead>
          <tr>
            <th>Case</th>
            <th class="evals-num-col">
              Previous
            </th>
            <th class="evals-num-col">
              Current
            </th>
            <th class="evals-num-col">
              Delta
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="comp in store.runComparison.comparisons"
            :key="comp.id"
            :class="{ improved: comp.delta > 0, regressed: comp.delta < 0 }"
          >
            <td>
              {{ comp.id }}
              <Tooltip
                v-if="isRetireCandidate(comp.id, store.compareIdxB)"
                text="Last 3 runs all 1.0"
              >
                <span class="evals-retire-icon">&#x1F3C1;</span>
              </Tooltip>
            </td>
            <td class="evals-num-col">
              {{ formatPct(comp.scoreA) }}
            </td>
            <td class="evals-num-col">
              {{ formatPct(comp.scoreB) }}
            </td>
            <td class="evals-num-col">
              <span
                v-if="comp.delta > 0"
                class="evals-delta-pos"
              >&uarr;+{{ formatPct(comp.delta) }}</span>
              <span
                v-else-if="comp.delta < 0"
                class="evals-delta-neg"
              >&darr;{{ formatPct(comp.delta) }}</span>
              <span v-else>&rarr;0</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import Checkbox from "@/components/common/Checkbox.vue";
import ErrorNote from "@/components/common/ErrorNote.vue";
import Input from "@/components/common/Input.vue";
import Select from "@/components/common/Select.vue";
import Tooltip from "@/components/common/Tooltip.vue";
import type { SelectOptionLike } from "@/components/common/select";
import { useEvalsStore } from "@/stores/evals";
import { platformApi } from "@/platform";
import { providersApi } from "@/platform/providers-client";
import { getLogger } from "@/services/log";

const log = getLogger("renderer.evals");

const store = useEvalsStore();

const runForm = ref({
  providerId: "",
  model: "deepseek-v4-pro",
  runs: 3,
  caseIds: [] as string[],
  disabledSections: [] as string[],
});

const providers = ref<Array<{ id: string; name: string }>>([]);

/** One spelling of "a settings-area dropdown" — the `.evals-form-select` box
 *  this sheet used to hand-draw is exactly `variant: 'ledger'`. `teleported`
 *  keeps the panel out of the settings scroll container. */
const LEDGER_SELECT = {
  variant: "ledger",
  size: "small",
  teleported: true,
  fitInputWidth: true,
} as const;

const providerOptions = computed<SelectOptionLike[]>(() =>
  providers.value.map(p => ({ value: p.id, label: p.name })),
);

/** Array-valued checkbox groups: `Checkbox` is a two-state control, so the
 *  membership bookkeeping the native `v-model` + `:value` pair did for free
 *  lives here instead. Mutates in place to keep the same ref identity. */
function toggleInList(list: string[], value: string, on: boolean) {
  const index = list.indexOf(value);
  if (on && index === -1) list.push(value);
  else if (!on && index !== -1) list.splice(index, 1);
}

// Keys must match the section names in buildRuntimeSystemPrompt
// (packages/onething-runtime/src/prompts/builder.ts) — a mismatched key
// silently disables nothing.
const ablationSections = [
  { key: "agent", label: "Agent" },
  { key: "voice", label: "Voice" },
  { key: "runtime-context", label: "Runtime Context" },
  { key: "workdir", label: "Work Directory" },
  { key: "active-project", label: "Active Project" },
  { key: "known-projects", label: "Known Projects" },
  { key: "context-variables", label: "Context Variables" },
  { key: "skills", label: "Skills" },
  { key: "os", label: "Platform/OS" },
  { key: "agents-md", label: "AGENTS.md" },
  { key: "plugins", label: "Plugins" },
];

const runTotalCases = computed(() => store.runProgress?.totalCases ?? 0);
const runCompletedCases = computed(() => store.runProgress?.completedCases ?? 0);
const runProgressPct = computed(() => {
  if (runTotalCases.value === 0) return 0;
  return Math.round((runCompletedCases.value / runTotalCases.value) * 100);
});

// Show error when a run failed to start (error is in runProgress but runInProgress is false)
const runError = computed(() =>
  !store.runInProgress && store.runProgress?.type === "error"
    ? store.runProgress.error
    : null,
);

// Mean of the selected historical run (not current runProgress)
const selectedRunMean = computed(() => {
  if (store.selectedRunIdx === null) return null;
  return store.results[store.selectedRunIdx]?.mean;
});

onMounted(async () => {
  try {
    const res = await providersApi.getProviders();
    if (res.success && res.providers) {
      providers.value = res.providers
        // The eval model caller only supports API-key providers; listing
        // OAuth providers here would offer options that always fail at run
        // start (see evals-provider-adapter resolveEvalsCredentials).
        .filter((p: any) => !p.requiresOAuth)
        .map((p: any) => ({
          id: p.id,
          name: p.name || p.id,
        }));
      if (providers.value.length > 0) {
        // Default to DeepSeek when configured, otherwise the first provider.
        const deepseek = providers.value.find((p) => p.id === "deepseek");
        runForm.value.providerId = deepseek?.id ?? providers.value[0].id;
      }
    }
  } catch {
    /* ignore */
  }
});

function formatDate(ts: string) {
  const d = new Date(ts);
  return d.toLocaleString();
}

function formatPct(v: number) {
  return (v * 100).toFixed(0) + "%";
}

function toggleCompare(idx: number) {
  if (store.compareIdxA === idx) {
    store.compareIdxA = null;
  } else if (store.compareIdxB === idx) {
    store.compareIdxB = null;
  } else if (store.compareIdxA === null) {
    store.compareIdxA = idx;
  } else if (store.compareIdxB === null) {
    store.compareIdxB = idx;
  } else {
    store.compareIdxA = store.compareIdxB;
    store.compareIdxB = idx;
  }
}

/** Check if a case has score 1.0 for the last 3 consecutive runs up to the given index. */
function isRetireCandidate(caseId: string, endIdx: number | null): boolean {
  if (endIdx === null || endIdx < 2) return false;
  const entries = store.results;
  for (let i = endIdx; i > endIdx - 3 && i >= 0; i--) {
    if ((entries[i].scores?.[caseId] ?? 0) !== 1) return false;
  }
  return true;
}

async function selectRun(idx: number) {
  store.selectedRunIdx = idx;
  const entry = store.results[idx];
  if (entry?.ts) {
    await store.loadRunDetail(entry.ts);
  }
}

async function handleStartRun() {
  const params = {
    caseIds: runForm.value.caseIds.length > 0 ? [...runForm.value.caseIds] : undefined,
    runs: runForm.value.runs,
    disabledSections: runForm.value.disabledSections.length > 0 ? [...runForm.value.disabledSections] : undefined,
    providerId: runForm.value.providerId,
    model: runForm.value.model,
  };
  log.debug("evals run form submitted", { ...params });
  await store.startRun(params);
}

function handleCancelRun() {
  void store.cancelRun();
}
</script>

<style scoped>
.evals-runs-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Ledger section title: uppercase small caps pulling a hairline */
.evals-section-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 620;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--settings-ink);
}

.evals-section-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--settings-rule-soft);
}

/* Run panel: no box, the section title rules it off */
.evals-run-panel {
  padding: 0 0 16px;
  border-bottom: 1px solid var(--settings-rule-soft);
}

.evals-run-form-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.evals-run-form-cases {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--settings-rule-soft);
}

.evals-case-select-hint {
  font-size: 12px;
  color: var(--settings-ink-4);
  display: block;
  margin-bottom: 6px;
}

.evals-case-checkboxes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* P3: `<Checkbox size="small">` draws the mark; this only seats it in the wrap
   row. `.app-checkbox` qualifies the selector so it outranks the component's
   own (0,1,0) rule instead of tying with it (ui-system.md §1). */
.app-checkbox.evals-case-checkbox {
  align-items: center;
  gap: 4px;
  color: var(--settings-ink-2);
}

.evals-run-progress {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.evals-run-progress-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.evals-run-status {
  font-size: 13px;
  font-weight: 600;
  color: var(--settings-accent);
}

/* Progress: outlined track, translucent accent ink as the datum */
.evals-progress-bar-wrap {
  position: relative;
  height: 22px;
  border: 1px solid var(--settings-rule);
  overflow: hidden;
}

.evals-progress-bar {
  height: 100%;
  background: color-mix(in srgb, var(--settings-accent) 24%, transparent);
  transition: width var(--duration-slow) var(--ease-default);
}

.evals-progress-label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--settings-ink-2);
}

.evals-action-btn.danger {
  color: var(--ui-status-danger-fg);
  border-color: var(--ui-status-danger-border, var(--ui-status-danger-fg));
}

.evals-action-btn.danger:hover {
  border-color: var(--ui-status-danger-fg);
}

.evals-run-case-list {
  display: flex;
  flex-direction: column;
}

.evals-run-case-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  padding: 4px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--settings-rule-soft) 32%, transparent);
}

.evals-run-case-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  color: var(--settings-ink-2);
}

.evals-run-case-score {
  flex-shrink: 0;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  color: var(--settings-ink-3);
}

.evals-run-case-pct {
  color: var(--settings-accent);
}

.evals-run-result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0 8px 10px;
  border-left: 2px solid var(--ui-status-success-fg);
  border-bottom: 1px solid var(--settings-rule-soft);
  font-size: 13px;
}

.evals-run-mean {
  font-variant-numeric: tabular-nums;
  font-weight: 620;
  color: var(--settings-ink-2);
}

/* ── Run History: left-right split ── */
.evals-runs-split {
  display: flex;
  gap: 16px;
  margin-top: 8px;
}

.evals-runs-list-panel {
  flex: 0 1 280px;
  min-width: 160px;
  border-right: 1px solid var(--settings-rule-soft);
  padding-right: 12px;
  overflow-y: auto;
  max-height: 480px;
}

/* Run rows: hairline ledger rows; selection is a left ink rule */
.evals-run-list-row {
  padding: 8px 4px 8px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--settings-rule-soft) 32%, transparent);
  cursor: pointer;
  transition: box-shadow var(--duration-fast) var(--ease-default);
}

.evals-run-list-row:hover .evals-run-list-date {
  color: var(--settings-ink);
}

.evals-run-list-row.selected {
  box-shadow: inset 2px 0 0 var(--settings-accent);
}

.evals-run-list-row.selected .evals-run-list-date {
  color: var(--settings-ink);
}

.evals-run-list-date {
  font-size: 12px;
  color: var(--settings-ink-2);
  font-weight: 520;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evals-run-list-provider {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--settings-ink-4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evals-run-list-stats {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 2px;
}

.evals-run-list-mean {
  font-size: 14px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--settings-ink);
}

.evals-run-list-detail {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--settings-ink-4);
}

.evals-runs-detail-panel {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  max-height: 480px;
}

.evals-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--settings-rule-soft);
  margin-bottom: 8px;
}

.evals-detail-title {
  font-size: 13px;
  font-weight: 620;
  color: var(--settings-ink);
}

.evals-detail-meta {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--settings-ink-3);
}

/* Case groups: hairline-separated ledger blocks, no cards */
.evals-detail-case {
  padding: 8px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--settings-rule-soft) 32%, transparent);
}

.evals-detail-case-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 4px;
}

.evals-detail-case-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  font-weight: 600;
  color: var(--settings-ink);
}

.evals-detail-case-score {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--settings-accent);
}

.evals-detail-attempt {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 11px;
}

.evals-detail-attempt.fail {
  color: var(--ui-status-danger-fg);
}

.evals-detail-attempt.pass {
  color: var(--ui-status-success-fg);
}

.evals-attempt-icon {
  flex-shrink: 0;
  font-weight: 700;
  min-width: 14px;
  text-align: center;
}

.evals-attempt-label {
  flex-shrink: 0;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  min-width: 20px;
}

.evals-attempt-reason {
  flex: 1;
  color: var(--settings-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Comparison */
.evals-comparison {
  margin-top: 8px;
}

.evals-compare-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--settings-ink-4);
  margin-left: 8px;
}

.evals-compare-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.evals-compare-table th {
  text-align: left;
  padding: 8px 12px 8px 0;
  border-bottom: 2px solid var(--settings-rule);
  color: var(--settings-ink-3);
  font-weight: 600;
}

.evals-compare-table td {
  padding: 7px 12px 7px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--settings-rule-soft) 32%, transparent);
  color: var(--settings-ink-2);
}

.evals-compare-table td:first-child {
  font-family: var(--font-mono, monospace);
  word-break: break-all;
}

.evals-num-col {
  text-align: right !important;
  width: 1%;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
}

/* Regression state lives in a left ink rule, not a filled row */
.evals-compare-table tr.improved td:first-child {
  box-shadow: inset 2px 0 0 var(--ui-status-success-fg);
  padding-left: 8px;
}

.evals-compare-table tr.regressed td:first-child {
  box-shadow: inset 2px 0 0 var(--ui-status-danger-fg);
  padding-left: 8px;
}

.evals-delta-pos {
  color: var(--ui-status-success-fg);
  font-weight: 600;
}

.evals-delta-neg {
  color: var(--ui-status-danger-fg);
  font-weight: 600;
}

.evals-retire-icon {
  margin-left: 4px;
  font-size: 12px;
}

/* Form elements */
.evals-form-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--settings-ink-3);
  font-weight: 520;
}

.evals-form-input-narrow {
  max-width: 70px;
  font-variant-numeric: tabular-nums;
}

/* Outlined text buttons: state lives in the edge line, never a fill */
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

.evals-action-btn:hover:not(:disabled) {
  color: var(--settings-ink);
  border-color: var(--settings-accent);
}

.evals-action-btn.primary {
  border-color: var(--settings-accent);
  color: var(--settings-accent);
}

.evals-action-btn:disabled {
  border-style: dashed;
  color: var(--settings-ink-4);
  cursor: not-allowed;
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
