/**
 * 计费档位(「旋钮」)的**数据投影**与它的三个读法(服务商自述试点 P4,
 * `docs/design/architecture-direction-2026-10.md` §4)。
 *
 * 档位本身是各家 manifest 自己说的(runtime `providers/dials.ts` 的 `DialSpec`,住在各家
 * `vendors/<id>/manifest.ts`)。那份 spec 带函数(`normalize` / `appliesTo` / `baseUrlOf`),
 * 过不了进程边界;后端把它投影成这里的纯数据,经 `providers.getProviders` 的
 * `ProviderInfo.dials` 下发,壳只读这份数据。
 *
 * 三个读法与 spec 的函数**逐个相等**,证据在 runtime 的
 * `providers/__tests__/dial-descriptor.equivalence.test.ts`(对每家带档位的服务商,
 * 合法值 / 非法值 / `undefined` / 空串逐个比)。读法一旦与函数分家,那份测试先红 ——
 * 选错档位是真扣钱的,这里不许有第二个产地。
 *
 * 本文件是**纯**模块(壳的浏览器包也 import 它):零 import,不碰 node / electron / `process`。
 */

export interface ProviderDialOption {
  value: string
  label: string
}

/** 一格旋钮(档位或地区)。`defaultValue` 就是 spec 的 `normalize(undefined)`。 */
export interface ProviderDialFieldDescriptor {
  /** 行首那个标签(逐字,不进 i18n:理由在 runtime `providers/dials.ts` 文件头)。 */
  label: string
  /** 无障碍名。测试也靠它定位。 */
  ariaLabel: string
  options: ProviderDialOption[]
  /** 存的值不在 `options` 里(没存过 / 存了别的)时的取值。 */
  defaultValue: string
}

export interface ProviderDialRegionDescriptor extends ProviderDialFieldDescriptor {
  /**
   * 这一行在哪几个档位下有意义(Kimi 的编程套餐只有一个全球地址)。缺席 = 恒有意义。
   * 比较的是**归一之后**的档位。
   */
  appliesToApiModes?: string[]
}

export interface ProviderDialDescriptor {
  /** 档位落在 provider 配置上的哪一格(格名由那一家 manifest 声明)。 */
  apiModeKey: string
  /** 地区落在哪一格。没有地区的家缺席。 */
  regionKey?: string
  apiMode: ProviderDialFieldDescriptor
  region?: ProviderDialRegionDescriptor
  /** 选择器下面那句话。说的是**选错的代价**,不是功能介绍。 */
  note?: string
  /**
   * 档位 × 地区 → 端点。键都是**归一之后**的取值;没有地区的家用空串作地区键。
   * 写设置时**必须连 baseUrl 一起写**(理由见 runtime `DialSpec.baseUrlOf`)。
   */
  baseUrls: Record<string, Record<string, string>>
}

/** 归一:值在选项里就是它,否则是这一格的缺省。 */
export function normalizeDialValue(field: ProviderDialFieldDescriptor, value: unknown): string {
  return field.options.some((option) => option.value === value) ? (value as string) : field.defaultValue
}

/** 地区那一行在这个档位下有没有意义。没有地区的家恒为假。 */
export function dialRegionApplies(spec: ProviderDialDescriptor, apiMode: unknown): boolean {
  const region = spec.region
  if (!region) return false
  if (!region.appliesToApiModes) return true
  return region.appliesToApiModes.includes(normalizeDialValue(spec.apiMode, apiMode))
}

/** 这一对档位算出来的端点。输入先归一,所以非法值落在缺省那一格上。 */
export function dialBaseUrlOf(spec: ProviderDialDescriptor, apiMode: unknown, region: unknown): string {
  const mode = normalizeDialValue(spec.apiMode, apiMode)
  const area = spec.region ? normalizeDialValue(spec.region, region) : ''
  return spec.baseUrls[mode]?.[area] ?? ''
}
