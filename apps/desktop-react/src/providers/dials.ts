import type { ProviderInfo } from '@shared/ipc/providers'
import {
  dialBaseUrlOf,
  dialRegionApplies,
  normalizeDialValue,
  type ProviderDialDescriptor,
  type ProviderDialFieldDescriptor,
  type ProviderDialOption as SharedDialOption,
} from '@shared/provider-dials'

/**
 * 计费档位(「旋钮」)。**哪几家有、各有什么选项、选错的代价那句话,都是各家
 * manifest 自己说的** —— 后端把 manifest 的 `dials` 投影成纯数据,随 `providers.getProviders`
 * 的 `ProviderInfo.dials` 下发(服务商自述试点 P4)。这里只剩壳要的几个读法 ——
 * 不点任何 provider 的名字,加一家带档位的服务商不用碰这个文件。
 *
 * 选项名与风险说明为什么不进 i18n 字典,理由写在 runtime `providers/dials.ts` 文件头
 * (一句被翻译得稍软的警告 = 一笔真金白银)。归一 / 地区适用 / 端点三个读法住在
 * `@shared/provider-dials`,它们与 manifest 里那几个函数逐个相等的证据在 runtime 的
 * `dial-descriptor.equivalence.test.ts` —— 这里不另写一份判据。
 */

export type ProviderDialOption = SharedDialOption
export type ProviderDialField = ProviderDialFieldDescriptor
export type ProviderDialSpec = ProviderDialDescriptor

/** 没有旋钮的 provider(或名册还没到)返回 `null` —— 常见情况不该多长出一个空对象。 */
export function providerDialsOf(info: Pick<ProviderInfo, 'dials'> | null | undefined): ProviderDialSpec | null {
  return info?.dials ?? null
}

/** 这一格该显示什么:存过就是存的那个,没存过就是这家 provider 自己的缺省。 */
export function resolveDialValue(field: ProviderDialField, stored: string | undefined): string {
  return normalizeDialValue(field, stored)
}

/** 地区那一行此刻画不画。 */
export function regionRowApplies(spec: ProviderDialSpec, apiMode: string): boolean {
  return dialRegionApplies(spec, apiMode)
}

/** 一次拨动写回设置的那一格。**档位与地址一起写**,理由见 runtime `DialSpec.baseUrlOf`。 */
export function dialPatchOf(
  spec: ProviderDialSpec,
  apiMode: string,
  region: string,
): Record<string, string> {
  const mode = normalizeDialValue(spec.apiMode, apiMode)
  const area = spec.region ? normalizeDialValue(spec.region, region) : ''
  const patch: Record<string, string> = { baseUrl: dialBaseUrlOf(spec, mode, area), [spec.apiModeKey]: mode }
  if (spec.regionKey) patch[spec.regionKey] = area
  return patch
}

/** 这一坑此刻存的档位。读的是 provider 配置上那两格(格名由 spec 自己说)。 */
export function storedDialsOf(
  spec: ProviderDialSpec,
  config: Record<string, unknown> | undefined,
): { apiMode: string; region: string } {
  return {
    apiMode: normalizeDialValue(spec.apiMode, config?.[spec.apiModeKey]),
    region: spec.region && spec.regionKey ? normalizeDialValue(spec.region, config?.[spec.regionKey]) : '',
  }
}
