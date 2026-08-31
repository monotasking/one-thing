import {
  getOnethingKimiBaseUrl,
  normalizeOnethingKimiApiMode,
  normalizeOnethingKimiRegion,
  onethingKimiRegionApplies,
} from '@onething/runtime/providers/kimi'
import {
  getOnethingQwenBaseUrl,
  normalizeOnethingQwenApiMode,
  normalizeOnethingQwenRegion,
} from '@onething/runtime/providers/qwen'

/**
 * 计费档位(「旋钮」)。**千问 / Kimi / 智谱三家有,别家没有。**
 *
 * ── 为什么这张表不进 i18n 字典 ────────────────────────────────────────────
 * 两条理由,都不是省事:
 *  ① 档位的**取值**(`standard` / `token-plan` / `coding-plan` / `cn` / `intl`)
 *     是写进设置文件、再被 runtime 拿去算 baseUrl 的**数据**。数据不翻译。
 *  ② 选项名与风险说明是**逐字**从生产那张表搬过来的
 *     (`packages/renderer/components/settings/provider/provider-dials.ts`),
 *     连全角逗号都没动。选错档位是**真扣钱**的:用按量的 Key 和地址去调订阅,
 *     会在订阅之外再按量扣一次。一句被翻译得稍软的警告 = 一笔真金白银。
 *     所以这几句话按「不许漂」处理,而不是按「文案」处理。
 *
 * ── 归一必须借用 runtime 的那几个函数 ──────────────────────────────────────
 * 生产那张表的文件头写着同一句话,理由也一样:渲染层自己写
 * `value === 'cn' ? … : …` 就是给同一件事开了第二个产地,而这件事错一次的代价
 * 是钱。所以下面 `normalize` 一律转手 `@onething/runtime/providers/*`,
 * baseUrl 也由它们算(`getOnethingQwenBaseUrl` / `getOnethingKimiBaseUrl`)。
 *
 * 智谱没有 runtime 归一函数(它只有两档、没有地区),所以那一格在这里写死 ——
 * 判据与 `useProviderSettings.ts:408-420` 逐字相同。
 */

export interface ProviderDialOption {
  value: string
  label: string
}

export interface ProviderDialField {
  /** 行首那个标签。 */
  label: string
  /** 无障碍名。测试也靠它定位。 */
  ariaLabel: string
  options: ProviderDialOption[]
  /** 归一到合法取值(缺省值由它给)。 */
  normalize(value: unknown): string
  /**
   * 这一格此刻有没有意义(Kimi 的编程套餐只有一个全球地址)。缺省恒 true。
   * 返回 false 时**整行收起**,而不是留一个拨了不动的选择器。
   */
  appliesTo?(apiMode: string): boolean
}

export interface ProviderDialSpec {
  providerId: string
  apiMode: ProviderDialField
  region?: ProviderDialField
  /** 选择器下面那句话。说的是**选错的代价**,不是功能介绍。 */
  note?: string
  /**
   * 这一对档位算出来的端点。写设置时**必须连 baseUrl 一起写** ——
   * 只写档位不写地址,请求还是发去旧地址,那正是「以为选对了、其实还在扣钱」。
   */
  baseUrlOf(apiMode: string, region: string): string
}

/** 智谱两档的地址。与 `useProviderSettings.ts:56-57` 同值。 */
const ZHIPU_STANDARD_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const ZHIPU_CODING_PLAN_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4'

const ZHIPU_DIALS: ProviderDialSpec = {
  providerId: 'zhipu',
  apiMode: {
    label: 'API mode',
    ariaLabel: 'Zhipu API mode',
    options: [
      { value: 'standard', label: 'Standard' },
      { value: 'coding-plan', label: 'Coding Plan' },
    ],
    normalize: (value) => (value === 'coding-plan' ? 'coding-plan' : 'standard'),
  },
  // 智谱没有地区,也没有风险说明 —— 生产那张表就是这样,这里不替它补一句。
  baseUrlOf: (apiMode) =>
    apiMode === 'coding-plan' ? ZHIPU_CODING_PLAN_BASE_URL : ZHIPU_STANDARD_BASE_URL,
}

const QWEN_DIALS: ProviderDialSpec = {
  providerId: 'qwen',
  apiMode: {
    label: '计费方式',
    ariaLabel: 'Qwen API mode',
    options: [
      { value: 'standard', label: 'API 按量付费 (sk-ws-)' },
      { value: 'token-plan', label: 'Token Plan 订阅 (sk-sp-)' },
      { value: 'coding-plan', label: 'Coding Plan 订阅 (sk-sp-)' },
    ],
    normalize: (value) => normalizeOnethingQwenApiMode(value),
  },
  region: {
    label: '版本',
    ariaLabel: 'Qwen region',
    options: [
      { value: 'cn', label: '国内版' },
      { value: 'intl', label: '海外版 (QwenCloud)' },
    ],
    normalize: (value) => normalizeOnethingQwenRegion(value),
  },
  note: '订阅用户必须选对档位。用通用 Key 和地址调用会走按量计费，在订阅之外额外扣钱。',
  baseUrlOf: (apiMode, region) =>
    getOnethingQwenBaseUrl(
      normalizeOnethingQwenApiMode(apiMode),
      normalizeOnethingQwenRegion(region),
    ),
}

const KIMI_DIALS: ProviderDialSpec = {
  providerId: 'kimi',
  apiMode: {
    label: '计费方式',
    ariaLabel: 'Kimi API mode',
    options: [
      { value: 'standard', label: '开放平台 按量付费' },
      { value: 'coding-plan', label: '编程套餐 Kimi Code 订阅' },
    ],
    normalize: (value) => normalizeOnethingKimiApiMode(value),
  },
  region: {
    label: '版本',
    ariaLabel: 'Kimi region',
    options: [
      { value: 'cn', label: '国内版 (moonshot.cn)' },
      { value: 'intl', label: '海外版 (moonshot.ai)' },
    ],
    normalize: (value) => normalizeOnethingKimiRegion(value),
    // 编程套餐(Kimi Code)只有一个全球地址,那一格在这时没有意义。
    appliesTo: (apiMode) => onethingKimiRegionApplies(normalizeOnethingKimiApiMode(apiMode)),
  },
  note: '编程套餐的 Key 与地址(api.kimi.com)和开放平台不通用：留着按量的那一套调用，会在订阅之外再按量扣一次钱。',
  baseUrlOf: (apiMode, region) =>
    getOnethingKimiBaseUrl(
      normalizeOnethingKimiApiMode(apiMode),
      normalizeOnethingKimiRegion(region),
    ),
}

const DIALS_BY_PROVIDER: Record<string, ProviderDialSpec> = {
  zhipu: ZHIPU_DIALS,
  qwen: QWEN_DIALS,
  kimi: KIMI_DIALS,
}

/** 没有旋钮的 provider 返回 `null` —— 常见情况不该多长出一个空对象。 */
export function providerDialsOf(providerId: string): ProviderDialSpec | null {
  return DIALS_BY_PROVIDER[providerId] ?? null
}

/** 这一格该显示什么:存过就是存的那个,没存过就是这家 provider 自己的缺省。 */
export function resolveDialValue(field: ProviderDialField, stored: string | undefined): string {
  return field.normalize(stored)
}

/** 地区那一行此刻画不画。 */
export function regionRowApplies(spec: ProviderDialSpec, apiMode: string): boolean {
  if (!spec.region) return false
  return spec.region.appliesTo?.(apiMode) ?? true
}

/** 一次拨动写回设置的那一格。**档位与地址一起写**,理由见 `baseUrlOf`。 */
export function dialPatchOf(
  spec: ProviderDialSpec,
  apiMode: string,
  region: string,
): Record<string, string> {
  const mode = spec.apiMode.normalize(apiMode)
  const area = spec.region ? spec.region.normalize(region) : ''
  const patch: Record<string, string> = { baseUrl: spec.baseUrlOf(mode, area) }
  if (spec.providerId === 'qwen') {
    patch.qwenApiMode = mode
    patch.qwenRegion = area
  } else if (spec.providerId === 'kimi') {
    patch.kimiApiMode = mode
    patch.kimiRegion = area
  } else {
    patch.zhipuApiMode = mode
  }
  return patch
}

/** 这一坑此刻存的档位。读的是 provider 配置上那两格。 */
export function storedDialsOf(
  spec: ProviderDialSpec,
  config: Record<string, unknown> | undefined,
): { apiMode: string; region: string } {
  const modeKey =
    spec.providerId === 'qwen'
      ? 'qwenApiMode'
      : spec.providerId === 'kimi'
        ? 'kimiApiMode'
        : 'zhipuApiMode'
  const regionKey = spec.providerId === 'qwen' ? 'qwenRegion' : 'kimiRegion'
  return {
    apiMode: spec.apiMode.normalize(config?.[modeKey]),
    region: spec.region ? spec.region.normalize(config?.[regionKey]) : '',
  }
}
