import { getBuiltinProviderManifest } from '@onething/runtime/providers/builtin-manifests'
import type { DialField, DialOption, DialSpec } from '@onething/runtime/providers/dials'

/**
 * 计费档位(「旋钮」)。**哪几家有、各有什么选项、选错的代价那句话,都是各家
 * manifest 自己说的**(`@onething/runtime/providers/builtin-manifests` 的 `dials`,
 * 数据本身在 `@onething/runtime/providers/dials`)。这里只剩壳要的几个读法 ——
 * 不点任何 provider 的名字,加一家带档位的服务商不用碰这个文件。
 *
 * 选项名与风险说明为什么不进 i18n 字典、归一为什么必须借 runtime 的函数,理由写在
 * runtime 那份文件头上(一句被翻译得稍软的警告 = 一笔真金白银)。
 */

export type ProviderDialOption = DialOption
export type ProviderDialField = DialField
export type ProviderDialSpec = DialSpec

/** 没有旋钮的 provider 返回 `null` —— 常见情况不该多长出一个空对象。 */
export function providerDialsOf(providerId: string): ProviderDialSpec | null {
  return getBuiltinProviderManifest(providerId)?.dials ?? null
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

/** 一次拨动写回设置的那一格。**档位与地址一起写**,理由见 `DialSpec.baseUrlOf`。 */
export function dialPatchOf(
  spec: ProviderDialSpec,
  apiMode: string,
  region: string,
): Record<string, string> {
  const mode = spec.apiMode.normalize(apiMode)
  const area = spec.region ? spec.region.normalize(region) : ''
  const patch: Record<string, string> = { baseUrl: spec.baseUrlOf(mode, area), [spec.apiModeKey]: mode }
  if (spec.regionKey) patch[spec.regionKey] = area
  return patch
}

/** 这一坑此刻存的档位。读的是 provider 配置上那两格(格名由 spec 自己说)。 */
export function storedDialsOf(
  spec: ProviderDialSpec,
  config: Record<string, unknown> | undefined,
): { apiMode: string; region: string } {
  return {
    apiMode: spec.apiMode.normalize(config?.[spec.apiModeKey]),
    region: spec.region && spec.regionKey ? spec.region.normalize(config?.[spec.regionKey]) : '',
  }
}
