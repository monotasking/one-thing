<template>
  <SettingsSection>
    <div class="panel-head">
      <span class="range-label">{{ rangeLabel }}</span>
      <div class="panel-controls">
        <div
          class="segmented"
          role="group"
          aria-label="Usage range"
        >
          <button
            v-for="option in RANGE_OPTIONS"
            :key="option.days"
            type="button"
            :class="{ active: rangeDays === option.days }"
            @click="setRange(option.days)"
          >
            {{ option.label }}
          </button>
        </div>
        <button
          type="button"
          class="refresh-btn"
          :class="{ spinning: loading }"
          :disabled="loading"
          aria-label="Refresh usage"
          @click="loadSummary"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      </div>
    </div>

    <div
      v-if="loading && !summary"
      class="usage-empty"
    >
      Loading usage...
    </div>

    <ErrorNote
      v-else-if="error && !summary"
      class="usage-error"
      :message="error"
    />

    <SettingsEmptyState
      v-else-if="totalRecords === 0"
      title="No usage recorded yet"
      description="Usage appears here after your next chat turn."
    />

    <template v-else-if="summary">
      <div class="top-grid">
        <!-- raw cost + per-provider bars -->
        <div class="cost-block">
          <div class="block-label">
            Raw token cost
          </div>
          <div class="raw-cost">
            {{ formatUSD(rawCost) }}<sup v-if="hasEstimate">*</sup>
          </div>
          <div
            v-if="hasEstimate"
            class="cost-footnote"
          >
            * subscription usage estimated at the official API rate
          </div>
          <!--
            厂商报价与本地价目并存(不覆盖):有报价的那部分,厂商值在前、本地
            估算在后。头顶那个大数字仍是本地估算 —— 只有它覆盖 100% 的记录。
          -->
          <div
            v-if="providerQuotedCost > 0"
            class="cost-footnote"
          >
            provider quoted {{ formatUSD(providerQuotedCost) }} · locally estimated {{ formatUSD(providerQuotedLocalCost) }}
          </div>

          <div class="provider-rows">
            <div
              v-for="provider in providerTotals"
              :key="provider.key"
              class="provider-row"
            >
              <div class="provider-head">
                <span class="provider-name">
                  <i
                    class="dot"
                    :style="{ background: provider.color }"
                  />
                  {{ provider.label }}
                </span>
                <span class="provider-cost">
                  {{ formatUSD(provider.cost) }}<template v-if="provider.subscriptionCostUSD > 0"> est.</template>
                </span>
              </div>
              <div class="provider-track">
                <i :style="{ width: providerBarWidth(provider), background: provider.color }" />
              </div>
              <div class="provider-sub">
                {{ shareOfCost(provider.cost) }} of cost · {{ formatCompactTokens(provider.tokens) }} tokens
              </div>
            </div>
          </div>
        </div>

        <!-- daily chart -->
        <div class="chart-block">
          <div class="chart-head">
            <span class="block-title">{{ metric === 'cost' ? 'Daily cost' : 'Daily tokens' }}</span>
            <div class="chart-controls">
              <div
                class="segmented small"
                role="group"
                aria-label="Chart metric"
              >
                <button
                  type="button"
                  :class="{ active: metric === 'cost' }"
                  @click="metric = 'cost'"
                >
                  Cost
                </button>
                <button
                  type="button"
                  :class="{ active: metric === 'tokens' }"
                  @click="metric = 'tokens'"
                >
                  Tokens
                </button>
              </div>
              <div class="legend">
                <span
                  v-for="series in chartSeries"
                  :key="series.key"
                  class="legend-item"
                >
                  <i :style="{ background: series.color }" />{{ series.label }}
                </span>
              </div>
            </div>
          </div>

          <div
            class="chart-wrap"
            @mouseleave="hover = null"
          >
            <svg
              ref="chartSvg"
              :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`"
              class="chart"
              role="img"
              :aria-label="metric === 'cost' ? 'Daily cost over the selected range' : 'Daily tokens over the selected range'"
              @mousemove="onChartMove"
            >
              <line
                v-for="tick in yTicks"
                :key="`g-${tick.y}`"
                :x1="PAD_L"
                :x2="VIEW_W - PAD_R"
                :y1="tick.y"
                :y2="tick.y"
                class="grid-line"
              />
              <text
                v-for="tick in yTicks"
                :key="`t-${tick.y}`"
                :x="PAD_L - 8"
                :y="tick.y + 3.5"
                text-anchor="end"
                class="axis-label"
              >{{ tick.label }}</text>

              <path
                v-for="layer in stackedLayers"
                :key="`${layer.key}-fill`"
                class="layer-fill"
                :d="layer.areaD"
                :fill="layer.fill"
                stroke="none"
              />
              <path
                v-for="layer in stackedLayers"
                :key="`${layer.key}-line`"
                :d="layer.lineD"
                fill="none"
                :stroke="layer.color"
                stroke-width="1.25"
                stroke-linejoin="round"
                stroke-linecap="round"
              />

              <line
                v-if="hover"
                :x1="hoverX"
                :x2="hoverX"
                :y1="PAD_T"
                :y2="VIEW_H - PAD_B"
                class="hover-line"
              />

              <text
                v-for="label in xLabels"
                :key="label.x"
                :x="label.x"
                :y="VIEW_H - 7"
                :text-anchor="label.anchor"
                class="axis-label"
              >{{ label.text }}</text>
            </svg>

            <div
              v-if="hover"
              class="chart-tip"
              :style="tipStyle"
              aria-hidden="true"
            >
              <div class="tip-date">
                {{ hover.bucketKey }}
              </div>
              <div
                v-for="row in hover.rows"
                :key="row.key"
                class="tip-row"
              >
                <span class="tip-name">
                  <i :style="{ background: row.color }" />{{ row.label }}
                </span>
                <span class="tip-value">{{ row.value }}</span>
              </div>
              <div class="tip-row total">
                <span class="tip-name">Total</span>
                <span class="tip-value">{{ hover.total }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- aggregate stats -->
      <div class="stats-strip">
        <div
          v-for="stat in statsStrip"
          :key="stat.label"
          class="stat-cell"
        >
          <span class="stat-label">{{ stat.label }}</span>
          <span class="stat-value">{{ stat.value }}</span>
          <span class="stat-sub">{{ stat.sub }}</span>
        </div>
      </div>

      <div class="bottom-grid">
        <!-- breakdown table -->
        <div class="breakdown-block">
          <div class="block-head">
            <span class="block-title">Breakdown</span>
            <div
              class="segmented small"
              role="group"
              aria-label="Breakdown view"
            >
              <button
                v-for="view in BREAKDOWN_VIEWS"
                :key="view.key"
                type="button"
                :class="{ active: breakdownView === view.key }"
                @click="breakdownView = view.key"
              >
                {{ view.label }}
              </button>
            </div>
          </div>

          <div class="table-head table-grid">
            <span>{{ breakdownNameLabel }}</span>
            <span class="num">Cost</span>
            <span class="num">Share</span>
            <span class="num">Tokens</span>
          </div>

          <div
            v-for="row in breakdownRows"
            :key="row.key"
            class="table-row table-grid"
          >
            <span class="cell-name">
              <i
                v-if="row.color"
                class="dot"
                :style="{ background: row.color }"
              />
              {{ row.name }}
            </span>
            <span class="num mono">
              {{ formatUSD(row.cost) }}<template v-if="row.estimated"> est.</template>
            </span>
            <span class="num mono sub">{{ row.share }}</span>
            <span class="num mono sub">{{ formatCompactTokens(row.tokens) }}</span>
          </div>
        </div>

        <!-- cost quality -->
        <div class="quality-block">
          <div class="block-head">
            <span class="block-title">Cost quality</span>
          </div>
          <div
            v-for="row in qualityRows"
            :key="row.label"
            class="quality-row"
          >
            <span class="quality-label">{{ row.label }}</span>
            <span
              class="quality-value mono"
              :class="{ strong: row.strong }"
            >{{ row.value }}</span>
          </div>
        </div>
      </div>

      <!-- by project -->
      <div
        v-if="projectRows.length > 0"
        class="projects-block"
      >
        <div class="block-head projects-head">
          <div class="projects-title">
            <span class="block-title">By project</span>
            <span class="projects-summary">{{ projectsSummary }}</span>
          </div>
          <input
            v-model.trim="projectFilter"
            type="search"
            class="project-filter"
            placeholder="Filter projects"
            aria-label="Filter projects"
          >
        </div>

        <div
          v-for="project in filteredProjectRows"
          :key="project.projectPath || '__none__'"
          class="project-row"
        >
          <div class="project-head">
            <span class="project-name">
              {{ project.displayName }}
              <small
                v-if="project.projectPath"
                class="project-path"
              >{{ project.projectPath }}</small>
            </span>
            <span class="project-cost mono">
              {{ formatUSD(project.cost) }}<template v-if="project.subscriptionCostUSD > 0"> est.</template>
            </span>
          </div>
          <div class="project-sub">
            {{ shareOfCost(project.cost) }} of cost · {{ formatCompactTokens(project.tokens) }} tokens ·
            {{ project.sessionCount }} {{ project.sessionCount === 1 ? 'session' : 'sessions' }} ·
            last active {{ shortDate(project.lastActiveTs) }}
          </div>
          <div class="project-split">
            <i
              v-for="segment in project.segments"
              :key="segment.key"
              :style="{ width: `${segment.widthPct}%`, background: segment.color }"
            />
          </div>
          <div class="project-foot">
            <span class="project-chips">
              <span
                v-for="chip in project.chips"
                :key="chip.key"
                class="chip"
              >
                <i :style="{ background: chip.color }" />{{ formatUSD(chip.cost) }}
              </span>
              <span
                v-if="project.moreProviders > 0"
                class="chip-more"
              >+{{ project.moreProviders }}</span>
            </span>
            <span class="project-models">{{ project.modelsLabel }}</span>
          </div>
        </div>

        <div
          v-if="filteredProjectRows.length === 0"
          class="usage-empty"
        >
          No projects match "{{ projectFilter }}".
        </div>
      </div>
    </template>
  </SettingsSection>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import ErrorNote from '@/components/common/ErrorNote.vue'
import {
  SettingsEmptyState,
  SettingsSection,
} from './settings-primitives'
import { platformApi } from '@/platform'
import type {
  GetUsageSummaryResponse,
  OnethingUsageBreakdownEntry,
  OnethingUsageBucket,
} from '@/types'

/* ── options ─────────────────────────────────────────────── */

const RANGE_OPTIONS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const
type RangeDays = (typeof RANGE_OPTIONS)[number]['days']

const BREAKDOWN_VIEWS = [
  { key: 'model', label: 'Model' },
  { key: 'day', label: 'Day' },
  { key: 'activity', label: 'Activity' },
] as const
type BreakdownView = (typeof BREAKDOWN_VIEWS)[number]['key']

type ChartMetric = 'cost' | 'tokens'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Providers billed as a flat subscription; their cost is an API-rate estimate. */
const PROVIDER_LABELS: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  zhipu: 'Zhipu',
  qwen: 'Qwen',
  gemini: 'Gemini',
  'github-copilot': 'Copilot',
  openrouter: 'OpenRouter',
  grok: 'Grok',
  acp: 'ACP',
}

/**
 * Chart series colors — mid-saturation tones that read on both light and dark
 * themes. Brand-adjacent, but brightened where the brand color is pure black.
 */
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#d97757',
  'claude-code': '#d97757',
  claude: '#d97757',
  codex: '#9ca3af',
  openai: '#9ca3af',
  chatgpt: '#9ca3af',
  gpt: '#9ca3af',
  deepseek: '#4d6bfe',
  gemini: '#8e75ff',
  kimi: '#3b82f6',
  zhipu: '#14b8a6',
  qwen: '#615ced',
  'github-copilot': '#8b949e',
  openrouter: '#a3a3a3',
  grok: '#f59e0b',
}
const OTHER_COLOR = '#78716c'
const FALLBACK_PALETTE = ['#d97757', '#4d6bfe', '#8e75ff', '#14b8a6', '#eab308', '#ec4899', '#22c55e', '#f97316']

const SOURCE_LABELS: Record<string, string> = {
  chat: 'Chat',
  title: 'Chat naming',
  memory: 'Memory',
  skill: 'Skill review',
  toc: 'Session outline',
  evals: 'Evals',
}

/** Providers stacked on the chart; everything else merges into "Other". */
const MAX_SERIES = 4

/* ── state ───────────────────────────────────────────────── */

const rangeDays = ref<RangeDays>(30)
const metric = ref<ChartMetric>('cost')
const breakdownView = ref<BreakdownView>('model')
const summary = ref<GetUsageSummaryResponse | null>(null)
const loading = ref(false)
const error = ref('')
/** Out-of-order responses must not overwrite a newer range selection. */
let loadSequence = 0

function setRange(days: RangeDays): void {
  if (rangeDays.value === days) return
  rangeDays.value = days
  void loadSummary()
}

async function loadSummary(): Promise<void> {
  const sequence = ++loadSequence
  loading.value = true
  error.value = ''
  try {
    const result = await platformApi.getUsageSummary({
      granularity: 'day',
      count: rangeDays.value,
    })
    if (sequence !== loadSequence) return
    summary.value = result
  } catch (err) {
    if (sequence !== loadSequence) return
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

/* ── shared helpers ──────────────────────────────────────── */

const buckets = computed<OnethingUsageBucket[]>(() => summary.value?.buckets ?? [])

function entryCost(entry: OnethingUsageBreakdownEntry): number {
  return entry.apiCostUSD + entry.subscriptionCostUSD
}

function bucketCost(bucket: OnethingUsageBucket): number {
  return bucket.apiCostUSD + bucket.subscriptionCostUSD
}

function shortDate(ts: number): string {
  const d = new Date(ts)
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`
}

const rangeLabel = computed(() => {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - (rangeDays.value - 1))
  return `${shortDate(start.getTime())} to ${shortDate(end.getTime())}`
})

const totalRecords = computed(() =>
  buckets.value.reduce((sum, bucket) => sum + bucket.records, 0),
)

const rawCost = computed(
  () => (summary.value?.totalApiCostUSD ?? 0) + (summary.value?.totalSubscriptionCostUSD ?? 0),
)

const hasEstimate = computed(() => (summary.value?.totalSubscriptionCostUSD ?? 0) > 0)

/**
 * 厂商自己报的成本(OpenRouter `usage.cost` / xAI ticks)与它同一批记录的本地
 * 价目估算。两个数**并排显示,永不互相覆盖**:厂商报价只覆盖部分记录,拿它
 * 换掉头顶那个总数会让总数不可比。
 */
const providerQuotedCost = computed(() => summary.value?.totalProviderCostUSD ?? 0)
const providerQuotedLocalCost = computed(
  () => summary.value?.pricingQuality?.providerReportedLocalCostUSD ?? 0,
)

function shareOfCost(cost: number): string {
  if (rawCost.value <= 0) return '0.0%'
  return `${((cost / rawCost.value) * 100).toFixed(1)}%`
}

/* ── provider aggregation ────────────────────────────────── */

interface ProviderTotal {
  key: string
  label: string
  color: string
  cost: number
  subscriptionCostUSD: number
  tokens: number
}

function providerLabel(key: string): string {
  if (PROVIDER_LABELS[key]) return PROVIDER_LABELS[key]
  return key.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Brand-family colour for a provider or model id. Exact palette hit first,
 * then fuzzy family matching so ids like `claude-code-agent` still land on
 * the Claude orange; true unknowns cycle the fallback palette by rank.
 */
function identityColor(id: string, rank: number): string {
  const key = id.toLowerCase()
  if (PROVIDER_COLORS[key]) return PROVIDER_COLORS[key]
  if (key.includes('claude') || key.includes('anthropic')) return PROVIDER_COLORS.anthropic
  if (key.includes('codex') || key.includes('gpt') || key.includes('openai') || /^o[134]/.test(key)) return PROVIDER_COLORS.codex
  if (key.includes('deepseek')) return PROVIDER_COLORS.deepseek
  if (key.includes('gemini')) return PROVIDER_COLORS.gemini
  if (key.includes('kimi') || key.includes('moonshot')) return PROVIDER_COLORS.kimi
  if (key.includes('glm') || key.includes('zhipu')) return PROVIDER_COLORS.zhipu
  if (key.includes('qwen')) return PROVIDER_COLORS.qwen
  if (key.includes('grok')) return PROVIDER_COLORS.grok
  return FALLBACK_PALETTE[rank % FALLBACK_PALETTE.length]
}

function providerColor(key: string, rank: number): string {
  return identityColor(key, rank)
}

const providerTotals = computed<ProviderTotal[]>(() => {
  const map = new Map<string, { cost: number; subscriptionCostUSD: number; tokens: number }>()
  for (const bucket of buckets.value) {
    for (const entry of bucket.byProvider) {
      const acc = map.get(entry.key) ?? { cost: 0, subscriptionCostUSD: 0, tokens: 0 }
      acc.cost += entryCost(entry)
      acc.subscriptionCostUSD += entry.subscriptionCostUSD
      acc.tokens += entry.usage.total
      map.set(entry.key, acc)
    }
  }
  return Array.from(map.entries())
    .map(([key, acc]) => ({
      key,
      label: providerLabel(key),
      cost: acc.cost,
      subscriptionCostUSD: acc.subscriptionCostUSD,
      tokens: acc.tokens,
    }))
    .sort((a, b) => b.cost - a.cost)
    // Fallback colours go by cost rank, not first-seen order, so the top
    // unknown provider always lands on the first palette colour.
    .map((provider, rank) => ({
      ...provider,
      color: providerColor(provider.key, rank),
    }))
})

function providerBarWidth(provider: ProviderTotal): string {
  const top = providerTotals.value[0]
  if (!top || top.cost <= 0 || provider.cost <= 0) return '0%'
  return `${(provider.cost / top.cost) * 100}%`
}

/* ── chart ───────────────────────────────────────────────── */

const VIEW_W = 560
const VIEW_H = 220
const PAD_L = 54
const PAD_R = 10
const PAD_T = 12
const PAD_B = 26
const PLOT_W = VIEW_W - PAD_L - PAD_R
const PLOT_H = VIEW_H - PAD_T - PAD_B

const OTHER_KEY = '__other__'

interface ChartSeries {
  key: string
  label: string
  color: string
}

/** Top providers by the active metric; the tail merges into a single "Other" band. */
const chartSeries = computed<ChartSeries[]>(() => {
  const ranked = [...providerTotals.value].sort((a, b) =>
    metric.value === 'cost' ? b.cost - a.cost : b.tokens - a.tokens,
  )
  const top = ranked.slice(0, MAX_SERIES)
  const series: ChartSeries[] = top.map(p => ({ key: p.key, label: p.label, color: p.color }))
  if (ranked.length > MAX_SERIES) series.push({ key: OTHER_KEY, label: 'Other', color: OTHER_COLOR })
  return series
})

function seriesValue(bucket: OnethingUsageBucket, key: string, topKeys: Set<string>): number {
  const pick = (entry: OnethingUsageBreakdownEntry): number =>
    metric.value === 'cost' ? entryCost(entry) : entry.usage.total
  if (key === OTHER_KEY) {
    return bucket.byProvider
      .filter(entry => !topKeys.has(entry.key))
      .reduce((sum, entry) => sum + pick(entry), 0)
  }
  const entry = bucket.byProvider.find(e => e.key === key)
  return entry ? pick(entry) : 0
}

function xAt(index: number, count: number): number {
  if (count <= 1) return PAD_L + PLOT_W / 2
  return PAD_L + (index / (count - 1)) * PLOT_W
}

/** Round the axis max up to a clean 1 / 1.5 / 2 / 2.5 / 3 / 5 × 10ⁿ step. */
function niceCeil(value: number): number {
  if (value <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(value))
  const normalized = value / mag
  for (const step of [1, 1.5, 2, 2.5, 3, 5, 10]) {
    if (normalized <= step) return step * mag
  }
  return 10 * mag
}

const dayTotals = computed<number[]>(() =>
  buckets.value.map(bucket =>
    metric.value === 'cost' ? bucketCost(bucket) : bucket.usage.total,
  ),
)

const yMax = computed(() => niceCeil(Math.max(0, ...dayTotals.value)))

function yAt(value: number): number {
  return PAD_T + PLOT_H * (1 - value / yMax.value)
}

const yTicks = computed(() => [
  { y: yAt(yMax.value), label: axisLabel(yMax.value) },
  { y: yAt(yMax.value / 2), label: axisLabel(yMax.value / 2) },
  { y: yAt(0), label: '0' },
])

const xLabels = computed(() => {
  const list = buckets.value
  const n = list.length
  if (n === 0) return []
  const indices = [...new Set([0, Math.floor((n - 1) / 2), n - 1])]
  return indices.map((i, position) => ({
    x: xAt(i, n),
    text: shortDate(list[i].startTs).toUpperCase(),
    anchor: position === 0 ? 'start' : position === indices.length - 1 ? 'end' : 'middle',
  }))
})

/**
 * Fritsch–Carlson monotone cubic: smooth like Catmull-Rom but mathematically
 * bounded by neighbouring points, so a band falling back to a zero day can
 * never overshoot below the baseline.
 */
function smoothLine(points: Array<[number, number]>): string {
  const n = points.length
  if (n < 3) return points.map(p => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')

  const slopes: number[] = []
  for (let i = 0; i < n - 1; i++) {
    slopes.push((points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0]))
  }
  const tangents: number[] = [slopes[0]]
  for (let i = 1; i < n - 1; i++) {
    tangents.push(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2)
  }
  tangents.push(slopes[n - 2])
  // Rescale segment tangents that would overshoot (the monotonicity guard).
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      tangents[i] = 0
      tangents[i + 1] = 0
      continue
    }
    const a = tangents[i] / slopes[i]
    const b = tangents[i + 1] / slopes[i]
    const magnitude = a * a + b * b
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude)
      tangents[i] = scale * a * slopes[i]
      tangents[i + 1] = scale * b * slopes[i]
    }
  }

  let d = ''
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1][0] - points[i][0]
    const c1x = points[i][0] + dx / 3
    const c1y = points[i][1] + (tangents[i] * dx) / 3
    const c2x = points[i + 1][0] - dx / 3
    const c2y = points[i + 1][1] - (tangents[i + 1] * dx) / 3
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${points[i + 1][0].toFixed(1)},${points[i + 1][1].toFixed(1)}`
  }
  return d
}

function linePath(points: Array<[number, number]>): string {
  return `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}` + smoothLine(points)
}

const stackedLayers = computed(() => {
  const list = buckets.value
  const n = list.length
  if (n === 0) return []
  const series = chartSeries.value
  const topKeys = new Set(series.filter(s => s.key !== OTHER_KEY).map(s => s.key))

  const baseline = new Array<number>(n).fill(0)
  return series.map(s => {
    const top: Array<[number, number]> = []
    const bottom: Array<[number, number]> = []
    for (let i = 0; i < n; i++) {
      const lower = baseline[i]
      const upper = lower + seriesValue(list[i], s.key, topKeys)
      baseline[i] = upper
      top.push([xAt(i, n), yAt(upper)])
      bottom.push([xAt(i, n), yAt(lower)])
    }
    return {
      key: s.key,
      areaD: linePath(top) + `L${bottom[n - 1][0].toFixed(1)},${bottom[n - 1][1].toFixed(1)}` + smoothLine([...bottom].reverse()) + 'Z',
      lineD: linePath(top),
      color: s.color,
      fill: `color-mix(in srgb, ${s.color} 22%, transparent)`,
    }
  })
})

/* ── chart hover ─────────────────────────────────────────── */

interface HoverState {
  index: number
  bucketKey: string
  total: string
  rows: Array<{ key: string; label: string; color: string; value: string }>
}

const chartSvg = ref<SVGElement | null>(null)
const hover = ref<HoverState | null>(null)

// New data or a metric switch makes the hover position/values stale.
watch([summary, metric], () => {
  hover.value = null
})

const hoverX = computed(() =>
  hover.value ? xAt(hover.value.index, buckets.value.length) : 0,
)

function formatMetric(value: number): string {
  return metric.value === 'cost' ? formatUSD(value) : `${formatCompactTokens(value)} tokens`
}

function onChartMove(event: MouseEvent): void {
  const el = chartSvg.value
  const list = buckets.value
  if (!el || list.length === 0) return
  const rect = el.getBoundingClientRect()
  const viewX = ((event.clientX - rect.left) / rect.width) * VIEW_W
  let index = 0
  if (list.length > 1) {
    index = Math.round(((viewX - PAD_L) / PLOT_W) * (list.length - 1))
    index = Math.min(list.length - 1, Math.max(0, index))
  }
  const bucket = list[index]
  const topKeys = new Set(chartSeries.value.filter(s => s.key !== OTHER_KEY).map(s => s.key))
  hover.value = {
    index,
    bucketKey: bucket.bucketKey,
    total: formatMetric(metric.value === 'cost' ? bucketCost(bucket) : bucket.usage.total),
    // Largest contributor first — the tooltip answers "what drove this day".
    rows: chartSeries.value
      .map(s => ({
        key: s.key,
        label: s.label,
        color: s.color,
        raw: seriesValue(bucket, s.key, topKeys),
      }))
      .sort((a, b) => b.raw - a.raw)
      .map(({ raw, ...row }) => ({ ...row, value: formatMetric(raw) })),
  }
}

const tipStyle = computed(() => {
  if (!hover.value) return {}
  const xPct = (xAt(hover.value.index, buckets.value.length) / VIEW_W) * 100
  // Sit beside the guide line, never on top of it: left of the line past
  // mid-chart, right of it otherwise.
  return xPct > 55
    ? { left: `calc(${xPct}% - 12px)`, transform: 'translateX(-100%)' }
    : { left: `calc(${xPct}% + 12px)`, transform: 'none' }
})

/* ── stats strip ─────────────────────────────────────────── */

const statsStrip = computed(() => {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let reasoning = 0
  let total = 0
  let activeDays = 0
  for (const bucket of buckets.value) {
    input += bucket.usage.input
    output += bucket.usage.output
    cacheRead += bucket.usage.cacheRead
    cacheWrite += bucket.usage.cacheWrite
    reasoning += bucket.usage.reasoning
    total += bucket.usage.total
    if (bucket.records > 0) activeDays += 1
  }
  const quality = summary.value?.pricingQuality
  const savings = quality?.cacheSavingsUSD ?? 0
  const cachedPct = input > 0 ? `${((cacheRead / input) * 100).toFixed(1)}%` : '0.0%'
  return [
    {
      label: 'Processed tokens',
      value: formatCompactTokens(total),
      sub: activeDays > 0 ? `${formatCompactTokens(total / activeDays)} per active day` : '—',
    },
    {
      label: 'Cached input',
      value: formatCompactTokens(cacheRead),
      sub: `${cachedPct} of observed input`,
    },
    {
      label: 'Uncached input',
      value: formatCompactTokens(Math.max(input - cacheRead, 0)),
      sub: `${formatCompactTokens(cacheWrite)} cache writes`,
    },
    {
      label: 'Output',
      value: formatCompactTokens(output),
      sub: `includes ${formatCompactTokens(reasoning)} reasoning`,
    },
    {
      label: 'Cache savings',
      value: formatUSD(savings),
      sub: savings > 0 && rawCost.value > 0 ? `${(savings / rawCost.value).toFixed(1)}x the raw token cost` : 'no cache discount yet',
    },
  ]
})

/* ── breakdown table ─────────────────────────────────────── */

interface BreakdownRow {
  key: string
  name: string
  color?: string
  cost: number
  estimated: boolean
  share: string
  tokens: number
}

const breakdownNameLabel = computed(() =>
  breakdownView.value === 'model' ? 'Model' : breakdownView.value === 'day' ? 'Day' : 'Activity',
)

/** Best-effort provider tint for a model id, so rows get a recognizable dot. */
function modelColor(modelId: string): string {
  return identityColor(modelId, 0)
}

function aggregateByDimension(
  pick: (bucket: OnethingUsageBucket) => OnethingUsageBreakdownEntry[],
): OnethingUsageBreakdownEntry[] {
  const map = new Map<string, OnethingUsageBreakdownEntry>()
  for (const bucket of buckets.value) {
    for (const entry of pick(bucket)) {
      const acc = map.get(entry.key) ?? {
        key: entry.key,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
        apiCostUSD: 0,
        subscriptionCostUSD: 0,
        records: 0,
      }
      acc.usage.total += entry.usage.total
      acc.apiCostUSD += entry.apiCostUSD
      acc.subscriptionCostUSD += entry.subscriptionCostUSD
      acc.records += entry.records
      map.set(entry.key, acc)
    }
  }
  return Array.from(map.values()).sort((a, b) => entryCost(b) - entryCost(a))
}

const breakdownRows = computed<BreakdownRow[]>(() => {
  if (breakdownView.value === 'day') {
    // Only active days — a 90-day range is mostly "$0.00 / 0.0% / 0" noise.
    return [...buckets.value]
      .reverse()
      .filter(bucket => bucket.records > 0)
      .map(bucket => ({
        key: bucket.bucketKey,
        name: bucket.bucketKey,
        cost: bucketCost(bucket),
        estimated: bucket.subscriptionCostUSD > 0,
        share: shareOfCost(bucketCost(bucket)),
        tokens: bucket.usage.total,
      }))
  }
  if (breakdownView.value === 'activity') {
    return aggregateByDimension(bucket => bucket.bySource ?? []).map(entry => ({
      key: entry.key,
      name: SOURCE_LABELS[entry.key] ?? entry.key,
      cost: entryCost(entry),
      estimated: entry.subscriptionCostUSD > 0,
      share: shareOfCost(entryCost(entry)),
      tokens: entry.usage.total,
    }))
  }
  return aggregateByDimension(bucket => bucket.byModel).map(entry => ({
    key: entry.key,
    name: entry.key,
    color: modelColor(entry.key),
    cost: entryCost(entry),
    estimated: entry.subscriptionCostUSD > 0,
    share: shareOfCost(entryCost(entry)),
    tokens: entry.usage.total,
  }))
})

/* ── cost quality ────────────────────────────────────────── */

const qualityRows = computed(() => {
  const quality = summary.value?.pricingQuality
  const priced = quality?.pricedTokens ?? 0
  const unpriced = quality?.unpricedTokens ?? 0
  const denominator = priced + unpriced
  const pct = (value: number) => (denominator > 0 ? `${((value / denominator) * 100).toFixed(1)}%` : '—')
  return [
    { label: 'Provider reported', value: pct(quality?.providerReportedTokens ?? 0), strong: false },
    { label: 'Model priced', value: pct(priced), strong: false },
    { label: 'Unpriced', value: pct(unpriced), strong: false },
    { label: 'Cache savings', value: formatUSD(quality?.cacheSavingsUSD ?? 0), strong: true },
  ]
})

/* ── by project ──────────────────────────────────────────── */

interface ProjectRow {
  projectPath: string
  displayName: string
  cost: number
  subscriptionCostUSD: number
  tokens: number
  sessionCount: number
  lastActiveTs: number
  segments: Array<{ key: string; color: string; widthPct: number }>
  chips: Array<{ key: string; color: string; cost: number }>
  moreProviders: number
  modelsLabel: string
}

const projectFilter = ref('')

/** Provider chips per project cap out at 3; the rest collapse into "+N". */
const MAX_PROJECT_CHIPS = 3

const projectRows = computed<ProjectRow[]>(() => {
  // byProject arrived across IPC; an older backend simply omits it and the
  // whole section stays hidden.
  return (summary.value?.byProject ?? []).map(project => {
    const cost = project.apiCostUSD + project.subscriptionCostUSD
    const providers = project.byProvider
      .map((entry, rank) => ({
        key: entry.key,
        color: identityColor(entry.key, rank),
        cost: entryCost(entry),
      }))
      .filter(entry => entry.cost > 0)
    const models = project.byModel.filter(entry => entryCost(entry) > 0 || entry.usage.total > 0)
    return {
      projectPath: project.projectPath,
      displayName: project.projectName || 'No project',
      cost,
      subscriptionCostUSD: project.subscriptionCostUSD,
      tokens: project.usage.total,
      sessionCount: project.sessionCount,
      lastActiveTs: project.lastActiveTs,
      segments: cost > 0
        ? providers.map(p => ({ key: p.key, color: p.color, widthPct: (p.cost / cost) * 100 }))
        : [],
      chips: providers.slice(0, MAX_PROJECT_CHIPS),
      moreProviders: Math.max(providers.length - MAX_PROJECT_CHIPS, 0),
      modelsLabel:
        models.slice(0, 2).map(entry => entry.key).join(' · ') +
        (models.length > 2 ? ` · +${models.length - 2}` : ''),
    }
  })
})

const filteredProjectRows = computed<ProjectRow[]>(() => {
  const query = projectFilter.value.toLowerCase()
  if (!query) return projectRows.value
  return projectRows.value.filter(
    project =>
      project.displayName.toLowerCase().includes(query) ||
      project.projectPath.toLowerCase().includes(query),
  )
})

const projectsSummary = computed(() => {
  const rows = projectRows.value
  const tokens = rows.reduce((sum, row) => sum + row.tokens, 0)
  const sessions = rows.reduce((sum, row) => sum + row.sessionCount, 0)
  return [
    formatUSD(rawCost.value),
    `${rows.length} ${rows.length === 1 ? 'project' : 'projects'}`,
    `${formatCompactTokens(tokens)} tokens`,
    `${sessions} ${sessions === 1 ? 'session' : 'sessions'}`,
  ].join(' · ')
})

/* ── formatters ──────────────────────────────────────────── */

function formatUSD(value: number | null | undefined): string {
  if (value == null) return '—'
  if (value === 0) return '$0.00'
  const decimals = value < 1 ? 4 : 2
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`
}

/** 3-significant-digit compact token counts: 48B / 46.2B / 1.27B / 142M / 103K. */
function formatCompactTokens(value: number): string {
  if (value >= 1e9) return `${parseFloat((value / 1e9).toPrecision(3))}B`
  if (value >= 1e6) return `${parseFloat((value / 1e6).toPrecision(3))}M`
  if (value >= 1e3) return `${parseFloat((value / 1e3).toPrecision(3))}K`
  return String(Math.round(value))
}

function axisLabel(value: number): string {
  if (metric.value === 'tokens') return formatCompactTokens(value)
  if (value >= 1000) return `$${parseFloat((value / 1000).toPrecision(3))}K`
  if (Number.isInteger(value)) return `$${value.toLocaleString('en-US')}`
  return `$${value.toFixed(2)}`
}

onMounted(() => {
  void loadSummary()
})
</script>

<style scoped>
/* ── panel header (section title hidden globally; page title says Usage) ── */
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
}

.range-label {
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.panel-controls {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.usage-empty {
  padding: 8px 0;
  font-size: 12px;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
}

.usage-error {
  margin: 8px 0;
}

.block-label {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-family: var(--type-mono-font, monospace);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.block-title {
  color: var(--settings-ink-2, var(--ui-text-secondary-fg));
  font-size: 13px;
  font-weight: 620;
}

.mono {
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
}

.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  margin-right: 6px;
  flex-shrink: 0;
}

/* ── segmented control ── */
.segmented {
  display: inline-flex;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
}

.segmented button {
  padding: 4px 10px;
  border: 0;
  border-left: 1px solid var(--settings-rule, var(--ui-border-default-border));
  background: transparent;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  cursor: pointer;
  font-family: var(--type-mono-font, monospace);
  font-size: 11px;
}

.segmented button:first-child {
  border-left: 0;
}

.segmented button.active {
  background: var(--settings-ink, var(--ui-text-primary-fg));
  color: var(--settings-paper, var(--ui-surface-app-bg));
}

.segmented.small button {
  padding: 2px 8px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  background: transparent;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  cursor: pointer;
}

.refresh-btn svg {
  width: 13px;
  height: 13px;
}

.refresh-btn:hover:not(:disabled) {
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

.refresh-btn:disabled {
  cursor: default;
}

.refresh-btn.spinning svg {
  animation: usage-spin 0.9s linear infinite;
}

@keyframes usage-spin {
  to { transform: rotate(360deg); }
}

/* ── top grid ── */
.top-grid {
  display: grid;
  grid-template-columns: minmax(250px, 320px) minmax(0, 1fr);
  gap: 32px;
  padding: 18px 0 20px;
  border-top: 1px solid var(--settings-rule, var(--ui-border-default-border));
}

.raw-cost {
  margin-top: 6px;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-family: var(--font-mono, monospace);
  font-size: 32px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.raw-cost sup {
  font-size: 15px;
  font-weight: 500;
}

.cost-footnote {
  margin-top: 2px;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 11px;
}

.provider-rows {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 20px;
}

.provider-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.provider-name {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  color: var(--settings-ink-2, var(--ui-text-secondary-fg));
  font-size: 12.5px;
  font-weight: 560;
}

.provider-cost {
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-family: var(--font-mono, monospace);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.provider-track {
  height: 3px;
  margin-top: 6px;
  background: color-mix(in oklab, var(--settings-ink, var(--ui-text-primary-fg)) 8%, transparent);
}

.provider-track i {
  display: block;
  height: 100%;
}

.provider-sub {
  margin-top: 5px;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

/* ── chart ── */
.chart-block {
  min-width: 0;
}

.chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.chart-controls {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.legend {
  display: inline-flex;
  gap: 10px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-size: 11px;
  white-space: nowrap;
}

.legend-item i {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  margin-right: 5px;
}

.chart-wrap {
  position: relative;
  margin-top: 10px;
}

.chart {
  display: block;
  width: 100%;
  height: auto;
}

.grid-line {
  stroke: var(--settings-rule-soft, var(--ui-border-subtle-border));
  stroke-width: 1;
  stroke-dasharray: 3 4;
}

.axis-label {
  fill: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 9px;
}

.hover-line {
  stroke: var(--settings-ink-3, var(--ui-text-muted-fg));
  stroke-width: 1;
}

.chart-tip {
  position: absolute;
  top: 8px;
  z-index: 2;
  min-width: 150px;
  padding: 7px 9px;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  background: var(--settings-paper, var(--ui-surface-app-bg));
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.12);
  pointer-events: none;
}

.tip-date {
  margin-bottom: 5px;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-weight: 620;
}

.tip-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 1px 0;
  font-size: 11px;
}

.tip-name {
  display: inline-flex;
  align-items: center;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
}

.tip-name i {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  margin-right: 5px;
}

.tip-value {
  color: var(--settings-ink-2, var(--ui-text-secondary-fg));
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
}

.tip-row.total {
  margin-top: 3px;
  padding-top: 4px;
  border-top: 1px solid var(--settings-rule-soft, var(--ui-border-subtle-border));
}

/* ── stats strip ── */
.stats-strip {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  border-top: 1px solid var(--settings-rule, var(--ui-border-default-border));
  border-bottom: 1px solid var(--settings-rule, var(--ui-border-default-border));
}

.stat-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 14px 16px 14px 0;
  border-left: 1px solid var(--settings-rule-soft, var(--ui-border-subtle-border));
}

.stat-cell:first-child {
  border-left: 0;
  padding-left: 0;
}

.stat-cell:not(:first-child) {
  padding-left: 16px;
}

.stat-label {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 11px;
  white-space: nowrap;
}

.stat-value {
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-family: var(--font-mono, monospace);
  font-size: 19px;
  font-weight: 620;
  font-variant-numeric: tabular-nums;
}

.stat-sub {
  overflow: hidden;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── bottom grid ── */
.bottom-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 32px;
  padding-top: 20px;
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.table-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 96px 58px 72px;
  gap: 12px;
  align-items: baseline;
}

.table-head {
  padding-bottom: 5px;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 11px;
}

.table-row {
  padding: 7px 0;
  border-top: 1px solid var(--settings-rule-soft, var(--ui-border-subtle-border));
  font-size: 12px;
}

.cell-name {
  display: block;
  overflow: hidden;
  color: var(--settings-ink-2, var(--ui-text-secondary-fg));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.num {
  text-align: right;
  white-space: nowrap;
}

.num.sub {
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-size: 11px;
}

/* ── cost quality ── */
.quality-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-top: 1px solid var(--settings-rule-soft, var(--ui-border-subtle-border));
}

.quality-row:first-of-type {
  border-top: 0;
}

.quality-label {
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-size: 12px;
}

.quality-value {
  color: var(--settings-ink-2, var(--ui-text-secondary-fg));
  font-size: 11.5px;
}

.quality-value.strong {
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-weight: 620;
}

/* ── by project ── */
.projects-block {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--settings-rule, var(--ui-border-default-border));
}

.projects-head {
  align-items: baseline;
}

.projects-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.projects-summary {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.project-filter {
  width: 180px;
  min-height: 24px;
  padding: 3px 8px;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  border-radius: 3px;
  background: transparent;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-size: 11.5px;
  outline: none;
}

.project-filter::placeholder {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
}

.project-filter:focus-visible {
  border-color: color-mix(in srgb, var(--settings-ink, var(--ui-text-primary-fg)) 40%, transparent);
}

.project-row {
  padding: 12px 0 10px;
  border-top: 1px solid var(--settings-rule-soft, var(--ui-border-subtle-border));
}

.project-row:first-of-type {
  border-top: 0;
}

.project-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.project-name {
  min-width: 0;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-size: 13px;
  font-weight: 620;
}

.project-path {
  margin-left: 8px;
  overflow: hidden;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: baseline;
}

.project-cost {
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-size: 13px;
  font-weight: 620;
  white-space: nowrap;
}

.project-sub {
  margin-top: 2px;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.project-split {
  display: flex;
  height: 3px;
  margin-top: 8px;
  background: color-mix(in oklab, var(--settings-ink, var(--ui-text-primary-fg)) 8%, transparent);
}

.project-split i {
  display: block;
  height: 100%;
}

.project-foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-top: 7px;
}

.project-chips {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.chip {
  display: inline-flex;
  align-items: center;
  color: var(--settings-ink-2, var(--ui-text-secondary-fg));
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.chip i {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  margin-right: 5px;
}

.chip-more {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 10.5px;
}

.project-models {
  overflow: hidden;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── narrow layouts stack ── */
@media (max-width: 860px) {
  .top-grid,
  .bottom-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .stats-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .stat-cell:nth-child(odd) {
    border-left: 0;
    padding-left: 0;
  }
}
</style>
