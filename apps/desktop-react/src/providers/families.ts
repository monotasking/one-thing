import { PROVIDER_FAMILIES, providerFamilyOf } from '@shared/provider-families'
import type { CustomProviderConfig, ProviderInfo } from '@shared/ipc/providers'
import type { ProviderFamilyView, ProviderMode, ProviderModeKind, RailGroup } from './types'

/**
 * 名册(`providers.list` 的 `ProviderInfo[]` + 设置里的自定义 provider)
 * → 左栏那张「家」的表。**纯函数**,没有 store、没有 React。
 *
 * 家族合并只认 `@shared/provider-families`。这里不重写一张表,也不按名字猜 ——
 * 那张表是聊天的模型选择器与启用开关的家族派生正在吃的同一张,漂开一次
 * 就会出现「设置里一家、聊天里两家」。
 */

/**
 * 两只**本地** provider。它们的 `requiresApiKey` / `requiresOAuth` 都是 false,
 * 所以光看名册那两格分不出「本地进程」与「配置漏了」—— 交接稿 §2 把它们点名
 * 列成「本地型(2)」,这里就照名点一次。
 *
 * 名点在**这一处**,别处一律读 `mode.kind`:多一个本地 provider 时改这里一行。
 */
export const LOCAL_MODE_KINDS: Readonly<Record<string, ProviderModeKind>> = {
  acp: 'acp',
  'claude-code-agent': 'localCli',
}

/**
 * 一条名册记录是哪一种模式。顺序即优先级:
 * 点名的本地两只 → 要 OAuth 的是订阅 → 其余按 API 密钥。
 *
 * 最后那一档是**兜底而不是猜**:一条既不要 key 也不要 OAuth、又不在本地表里的
 * 记录,在今天的名册里不存在;真长出来时它是一条云端记录,按 API 坑画是它唯一
 * 说得通的样子(那一坑本来就允许「没配密钥」)。
 */
export function modeKindOf(info: ProviderInfo): ProviderModeKind {
  const local = LOCAL_MODE_KINDS[info.id]
  if (local) return local
  if (info.requiresOAuth) return 'subscription'
  return 'api'
}

export function groupOfKind(kind: ProviderModeKind): RailGroup {
  if (kind === 'custom') return 'custom'
  if (kind === 'acp' || kind === 'localCli') return 'local'
  return 'cloud'
}

function toMode(info: ProviderInfo): ProviderMode {
  return {
    providerId: info.id,
    kind: modeKindOf(info),
    name: (info.name ?? '').trim() || info.id,
    requiresApiKey: info.requiresApiKey === true,
    requiresOAuth: info.requiresOAuth === true,
    oauthFlow: info.oauthFlow,
    defaultBaseUrl: info.defaultBaseUrl ?? '',
  }
}

/**
 * 家族内模式的排序:**API 在前、订阅在后**。
 *
 * 不用名册顺序,理由是名册顺序是注册顺序(claude-code 排在 claude 之后、
 * grok-oauth 紧跟 grok,但 codex 排在很后面),分段器上两家一个样式、一家反着
 * 就成了随机。判据固定下来,四家的分段器长得一样。
 */
const MODE_ORDER: Record<ProviderModeKind, number> = {
  api: 0,
  subscription: 1,
  localCli: 2,
  acp: 3,
  custom: 4,
}

/**
 * 家的显示名。家族有自己的 label(「Claude」而不是「Claude Code」),
 * 独立成家时用名册给的名字。
 */
function labelOfFamily(familyId: string, modes: ProviderMode[]): string {
  const family = PROVIDER_FAMILIES.find((f) => f.id === familyId)
  if (family) return family.label
  return modes[0]?.name ?? familyId
}

/**
 * 头部那句副语:家族取 **API 那位成员**的描述(它是这家的主业),
 * 独立成家取自己那条。名册没给就是空串 —— 空串的那一行不画,不编一句。
 */
function descriptionOf(familyId: string, infos: ProviderInfo[]): string {
  const primary = infos.find((i) => i.id === familyId) ?? infos[0]
  return (primary?.description ?? '').trim()
}

/**
 * 名册 + 自定义表 → 家的表。
 *
 * 顺序:云 → 本地 → 自定义(左栏三组的顺序),组内按名册顺序(自定义按设置顺序)。
 * 一家的 id = 家族键 / 自己的 provider id;`custom:<id>` 那种前缀不造 ——
 * 自定义 provider 的 id 本来就是唯一的。
 */
export function buildFamilies(
  providers: readonly ProviderInfo[],
  customProviders: readonly CustomProviderConfig[] = [],
): ProviderFamilyView[] {
  const byFamily = new Map<string, { infos: ProviderInfo[]; modes: ProviderMode[] }>()
  const order: string[] = []

  for (const info of providers) {
    if (!info?.id) continue
    // 自定义 provider 不该同时从两条路进来(名册里通常没有它们,但真有也不重复)。
    if (customProviders.some((c) => c.id === info.id)) continue
    const familyId = providerFamilyOf(info.id)?.id ?? info.id
    let bucket = byFamily.get(familyId)
    if (!bucket) {
      bucket = { infos: [], modes: [] }
      byFamily.set(familyId, bucket)
      order.push(familyId)
    }
    bucket.infos.push(info)
    bucket.modes.push(toMode(info))
  }

  const built: ProviderFamilyView[] = []
  for (const familyId of order) {
    const bucket = byFamily.get(familyId)
    if (!bucket) continue
    const modes = [...bucket.modes].sort((a, b) => MODE_ORDER[a.kind] - MODE_ORDER[b.kind])
    built.push({
      id: familyId,
      label: labelOfFamily(familyId, modes),
      // 一家只可能落在一组里 —— 组由**第一条**模式定(本地两只各自成家,
      // 云端家族的两条模式同组,不会出现跨组的家)。
      group: groupOfKind(modes[0]?.kind ?? 'api'),
      modes,
      description: descriptionOf(familyId, bucket.infos),
      custom: false,
    })
  }

  for (const custom of customProviders) {
    if (!custom?.id) continue
    const name = (custom.name ?? '').trim() || custom.id
    built.push({
      id: custom.id,
      label: name,
      group: 'custom',
      modes: [
        {
          providerId: custom.id,
          kind: 'custom',
          name,
          requiresApiKey: false,
          requiresOAuth: false,
          defaultBaseUrl: (custom.baseUrl ?? '').trim(),
        },
      ],
      description: (custom.description ?? '').trim(),
      custom: true,
    })
  }

  const groupRank: Record<RailGroup, number> = { cloud: 0, local: 1, custom: 2 }
  return built.sort((a, b) => groupRank[a.group] - groupRank[b.group])
}

/** 一家的全部 provider id。启用开关一次要写完这几个(家族一开全开)。 */
export function providerIdsOf(family: ProviderFamilyView): string[] {
  return family.modes.map((m) => m.providerId)
}

/** 找一家。找不到 = null,不拿第一家去顶。 */
export function findFamily(
  families: readonly ProviderFamilyView[],
  familyId: string | null,
): ProviderFamilyView | null {
  if (!familyId) return null
  return families.find((f) => f.id === familyId) ?? null
}

/**
 * 这一家此刻该显示哪一种模式。
 *  ① 用户点过的那一格(前提是它还在这一家里);
 *  ② 没点过 → **已经配好的第一格**(开面就落在能用的那一坑上);
 *  ③ 都没配 → 第一格。
 */
export function resolveMode(
  family: ProviderFamilyView,
  picked: string | undefined,
  isConfigured: (providerId: string) => boolean,
): ProviderMode {
  const chosen = family.modes.find((m) => m.providerId === picked)
  if (chosen) return chosen
  return family.modes.find((m) => isConfigured(m.providerId)) ?? family.modes[0]
}
