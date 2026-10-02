/**
 * per-space overlay —— `workspaces/<id>/space.json`(批 B2)。
 *
 * overlay 是**追加层**,不是替换层:生效值 = 全局 settings ∪ 本空间 overlay。
 * 全局层继续存在且全空间共享(零迁移,老用户无感),空间只往上加东西。
 *
 * 三条硬约束:
 *  1. **不走 `mergeWithDefaults`**。那是白名单式重建,有静默吞掉白名单外字段的
 *     前科(`storage` / `evals` 两个既有漏项),overlay 独立解析、独立落盘。
 *  2. **不碰 settings.json**。overlay 是另一份文件,两边互不覆盖。
 *  3. schema 从第一天就留位(`overlay` 对象里后续还要放更多东西),所以落盘形状是
 *     `{ overlay: {...} }` 而不是把 connectedDirectories 平铺在根上。批 B7 填进
 *     `selectedModels`,批 B9 填进 `defaultSelection` / `providerEnabled` —— 留位
 *     这一手到今天为止兑现了三次,文件形状一次没变。**C2 又把那三格搬走了**
 *     (整套 provider 设置去了 `providers.json`),文件形状还是没变。
 *
 * 设计见 `docs/design/workspace-spaces-2026-08.md` 批 B。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { notifySpaceDataChanged } from './notifications.js'
import { ensureSpaceDir, spaceDir } from './persistence.js'
import { DEFAULT_SPACE_ID, isValidSpaceId } from './types.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('spaces')

/**
 * overlay 的字段随切片增长,文件形状不变(始终 `{ overlay: {...} }`)。
 *
 * **C2 之后 overlay 只剩接入目录**:B7/B9 塞进来的三格 provider 偏好
 * (`selectedModels` / `defaultSelection` / `providerEnabled`)已经整体并进
 * `workspaces/<id>/providers.json`。它们在类型与解析里保留,**只为读**:
 * 一次性迁移要从老 overlay 里取值,而写路已经不再产出它们。
 */
export interface SpaceOverlay {
  connectedDirectories?: string[]
  /**
   * per-space「选了哪些模型」(批 B7)。`{ [providerId]: modelId[] }`。
   *
   * **只存「选了哪些」,不复制目录**:models.dev 那 ~500KB 的模型目录缓存留在
   * 全局 settings(§3),空间之间共享 —— 每个空间复制一份目录纯属浪费,而且
   * 刷新一次目录要写 N 份。
   *
   * 缺席 ≠ 空:`selectedModels` 整个字段缺席时,视图层落回全局 settings.ai
   * (刚建的空间不该看起来像「一个模型都没有」);某个 provider 的键存在但是
   * 空数组时,那就是用户在这个空间把它清空了 —— 两者必须能分辨,所以归一时
   * **保留空数组**,只丢掉非法形状。
   */
  selectedModels?: Record<string, string[]>
  /**
   * per-space「默认 provider + 默认模型」(批 B9)。
   *
   * 推翻批 B7 的「默认模型有意留全局」——用户 08-17 原话:「不同的空间,它的默认
   * 模型以及这个模型列表都是要不一样的。」
   *
   * **provider 与 model 是一对,不是两格**:一个 model id 只在它自己的 provider
   * 下有意义,拆成两个平行字段的第一天就能出现「provider=deepseek /
   * model=glm-5」这种谁也解释不清的组合。所以整体存成一个选择。
   *
   * 缺席 = 这个空间**没表达过**默认(回落全局 `settings.ai.provider` +
   * `settings.ai.providers[pid].model`)—— 刚建的空间开出来就能直接用;表达过
   * 即以空间为准。`model` 可以单独缺席(只钉 provider),那一格再落回该 provider
   * 的全局默认模型。
   */
  defaultSelection?: SpaceDefaultSelection
  /**
   * per-space「provider 启用开关」(批 B9)。`{ [providerId]: boolean }`。
   *
   * 用户 08-17 原话:「Provider 的开关也要是独立的。」与 `selectedModels` 同风格,
   * 但**逐 provider 缺席**:某个 provider 的键不在 = 这个空间没表达过它的开关
   * (回落全局 `settings.ai.providers[pid].enabled`,缺省 true)。整字段缺席 =
   * 一个都没表达过 —— 新空间不该突然全灭。
   *
   * **家族语义不在这里**:Kimi 这类「API + 订阅」家族的成员可见性由渲染层的
   * `isProviderEnabledIn` 统一派生(family 开关挂在 API 成员上),本字段只是它的
   * 逐成员数据源。判据分家 = 家族卡上打开、模型选择器里不出现。
   */
  providerEnabled?: Record<string, boolean>
}

/** 「默认用哪个 provider 的哪个模型」——批 B9。model 缺席 = 只钉 provider。 */
export interface SpaceDefaultSelection {
  provider: string
  model?: string
}

/** 落盘形状。`overlay` 是唯一的一级键 —— 给未来的非 overlay 段(如 meta)留位。 */
export interface SpaceFile {
  overlay: SpaceOverlay
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 目录归一:trim + 去尾斜杠,只用于**相等判定**(去重),不改写用户存的原文。
 * 与 project-dirs 的 `canonicalizeProjectRoot` 同一口径 —— 两处目录概念在同一个
 * 会话里并排出现,判据分家的第一天不会有人发现,第一百天没人能解释。
 */
export function canonicalizeSpaceDirectory(dir: string): string {
  const trimmed = dir.trim()
  const stripped = trimmed.replace(/[/\\]+$/, '')
  return stripped || trimmed
}

/**
 * 目录清单归一:丢非字符串/空串/相对路径,尾斜杠不敏感去重,保留首次出现顺序。
 * 只收绝对路径 —— 与 `normalizeConnectedDirectories`(全局层)同一条门槛,
 * 否则两层的收货标准不一样,合并后会冒出全局层永远不可能存在的相对路径。
 */
export function normalizeSpaceDirectories(dirs: unknown): string[] {
  if (!Array.isArray(dirs)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of dirs) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (!(trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed))) continue
    const key = canonicalizeSpaceDirectory(trimmed)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

/**
 * `selectedModels` 归一:丢非法 provider 键与非字符串 id,去重保序。
 * **空数组保留**(见 `SpaceOverlay.selectedModels` 的注释:空 ≠ 缺席);
 * 整个值不是对象时返回 `undefined`,由调用方决定判废还是当缺席。
 */
export function normalizeSpaceSelectedModels(
  value: unknown,
): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string[]> = {}
  for (const [providerId, ids] of Object.entries(value)) {
    const provider = typeof providerId === 'string' ? providerId.trim() : ''
    if (!provider) continue
    if (!Array.isArray(ids)) continue
    const models: string[] = []
    const seen = new Set<string>()
    for (const raw of ids) {
      if (typeof raw !== 'string') continue
      const trimmed = raw.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      models.push(trimmed)
    }
    out[provider] = models
  }
  return out
}

/**
 * `defaultSelection` 归一(批 B9)。provider 必须是非空字符串 —— 一个没有 provider
 * 的 model 不是「选择」,是半句话,收下它只会让下游去猜。返回 `undefined` = 当缺席
 * (回落全局),**不判废整份 overlay**:半句话是字段级脏值,不是结构不认。
 */
export function normalizeSpaceDefaultSelection(
  value: unknown,
): SpaceDefaultSelection | undefined {
  if (!isRecord(value)) return undefined
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  if (!provider) return undefined
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  return model ? { provider, model } : { provider }
}

/**
 * `providerEnabled` 归一(批 B9):只收 `boolean`,provider 键 trim 后非空。
 * 非布尔值(`'true'` / `1` / `null`)一律丢弃 —— 它们在「缺席 = 回落全局」的语义下
 * 无处安放,当成 true 就是替用户表达了一次他没表达过的东西。
 * 整个值不是对象时返回 `undefined`,由调用方决定判废还是当缺席。
 */
export function normalizeSpaceProviderEnabled(
  value: unknown,
): Record<string, boolean> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, boolean> = {}
  for (const [providerId, enabled] of Object.entries(value)) {
    const provider = typeof providerId === 'string' ? providerId.trim() : ''
    if (!provider) continue
    if (typeof enabled !== 'boolean') continue
    out[provider] = enabled
  }
  return out
}

/**
 * 生效接入目录 = 全局层 ∪ space overlay。全局在前(它是所有空间的共同底座,
 * 顺序上先出现更符合「谁是底、谁是加料」的直觉),去重尾斜杠不敏感。
 */
export function mergeConnectedDirectories(
  global: readonly string[],
  overlay: readonly string[] | undefined,
): string[] {
  return normalizeSpaceDirectories([...global, ...(overlay ?? [])])
}

/**
 * 整份解析。与 index.json 一致:**结构不认就整份判废**(返回 null),调用方退回
 * 空 overlay —— 半份 overlay 比空 overlay 更难排查(用户看见三条目录里少了一条,
 * 而日志里什么都没有)。字段级的脏值(数组里混进数字)按归一规则丢弃,不判废整份。
 */
export function parseSpaceFile(value: unknown): SpaceFile | null {
  if (!isRecord(value)) return null
  if (value.overlay === undefined) return { overlay: {} }
  if (!isRecord(value.overlay)) return null
  const overlay: SpaceOverlay = {}
  if (value.overlay.connectedDirectories !== undefined) {
    if (!Array.isArray(value.overlay.connectedDirectories)) return null
    overlay.connectedDirectories = normalizeSpaceDirectories(value.overlay.connectedDirectories)
  }
  if (value.overlay.selectedModels !== undefined) {
    const selectedModels = normalizeSpaceSelectedModels(value.overlay.selectedModels)
    if (!selectedModels) return null
    overlay.selectedModels = selectedModels
  }
  if (value.overlay.defaultSelection !== undefined) {
    // 结构不认(不是对象)= 整份判废,与上面两格同一条;对象里 provider 是脏的
    // 只丢这一格 —— 那是字段级脏值,退成「这个空间没表达过默认」即可。
    if (!isRecord(value.overlay.defaultSelection)) return null
    const defaultSelection = normalizeSpaceDefaultSelection(value.overlay.defaultSelection)
    if (defaultSelection) overlay.defaultSelection = defaultSelection
  }
  if (value.overlay.providerEnabled !== undefined) {
    const providerEnabled = normalizeSpaceProviderEnabled(value.overlay.providerEnabled)
    if (!providerEnabled) return null
    overlay.providerEnabled = providerEnabled
  }
  return { overlay }
}

/** 只接受门口卡死过的 id —— id 是路径片段,非法 id 一律当 default。 */
function resolveOverlaySpaceId(spaceId: string | undefined | null): string {
  return spaceId && isValidSpaceId(spaceId) ? spaceId : DEFAULT_SPACE_ID
}

export function spaceFilePath(spaceId: string): string {
  return path.join(spaceDir(resolveOverlaySpaceId(spaceId)), 'space.json')
}

/**
 * 读缓存。key 是**绝对文件路径**,不是 spaceId —— 换 store 根(headless 宿主、
 * 测试)天然换 key,不需要额外的失效钩子,也就不需要 persistence 反向依赖本模块。
 *
 * 为什么要缓存:这条读路径挂在 analyze 热路径上(每次 write/edit/bash 审批判定
 * 各一次,read 也一次),同步读盘虽小也没必要每次都做。
 */
const overlayCache = new Map<string, SpaceOverlay>()

export function resetSpaceOverlayCacheForTests(): void {
  overlayCache.clear()
}

/** 缺文件 / 坏文件 / 读不动 = 空 overlay。overlay 缺席永远等价于「这个空间没加料」。 */
export function readSpaceOverlay(spaceId: string | undefined | null): SpaceOverlay {
  const filePath = spaceFilePath(resolveOverlaySpaceId(spaceId))
  const cached = overlayCache.get(filePath)
  if (cached) return cached
  let overlay: SpaceOverlay = {}
  try {
    if (fs.existsSync(filePath)) {
      const parsed = parseSpaceFile(JSON.parse(fs.readFileSync(filePath, 'utf-8')))
      if (parsed) overlay = parsed.overlay
      else log.warn('space overlay schema validation failed, treating as empty', { filePath })
    }
  } catch (err) {
    log.warn('space overlay read failed', { filePath }, err)
  }
  overlayCache.set(filePath, overlay)
  return overlay
}

/**
 * 整层写入(不是 patch):调用方给什么就是什么。overlay 只有一格时 patch 与整写
 * 无差别,但字段变多之后「漏传 = 清空」是个陷阱,所以入口就定成整写,由 IPC 层
 * 显式决定要不要先读后并。
 */
export function writeSpaceOverlay(
  spaceId: string | undefined | null,
  overlay: SpaceOverlay,
): SpaceOverlay {
  const id = resolveOverlaySpaceId(spaceId)
  const next: SpaceOverlay = {}
  if (overlay.connectedDirectories !== undefined) {
    next.connectedDirectories = normalizeSpaceDirectories(overlay.connectedDirectories)
  }
  // **C2 起 provider 三格不再落盘**:`selectedModels` / `defaultSelection` /
  // `providerEnabled` 已经并进 `workspaces/<id>/providers.json`(整套 provider
  // 设置)。读侧仍认识它们(迁移要从这里取值),但任何一次写回都会把它们清掉 ——
  // 「读得进、写不出」正是一次性迁移收尾的形状,不需要第二个开关。
  ensureSpaceDir(id)
  const filePath = spaceFilePath(id)
  const file: SpaceFile = { overlay: next }
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8')
  overlayCache.set(filePath, next)
  // 跨窗口缓存过期(批 B9-0):落盘之后叫一声,宿主广播给所有窗口。写盘先、
  // 通知后 —— 反过来收到通知的人会读到旧文件。
  notifySpaceDataChanged({ spaceId: id, kind: 'overlay' })
  return next
}

/** 本空间 overlay 里登记的接入目录(不含全局层)。 */
export function getSpaceOverlayConnectedDirectories(
  spaceId: string | undefined | null,
): string[] {
  return readSpaceOverlay(spaceId).connectedDirectories ?? []
}

/**
 * 本空间 overlay 里登记的「选了哪些模型」(不含全局层)。
 *
 * 返回 `undefined` = 这个空间**没有**表达过模型选择(落回全局);返回 `{}` 或
 * 某 provider 为 `[]` = 表达过、就是空的。两者不能合并 —— 合并等于让「刚建的
 * 空间」和「用户手动清空」长成同一副样子。
 */
export function getSpaceOverlaySelectedModels(
  spaceId: string | undefined | null,
): Record<string, string[]> | undefined {
  return readSpaceOverlay(spaceId).selectedModels
}

/**
 * 本空间 overlay 里登记的默认选择(不含全局层)。
 *
 * 返回 `undefined` = 这个空间**没有**表达过默认(落回全局 `settings.ai`)。
 * 与 `selectedModels` 不同的是这里没有「表达成空」这一态:清空一个默认选择就是
 * 回落全局,没有第三种意思。
 */
export function getSpaceOverlayDefaultSelection(
  spaceId: string | undefined | null,
): SpaceDefaultSelection | undefined {
  return readSpaceOverlay(spaceId).defaultSelection
}

/**
 * 本空间 overlay 里登记的 provider 开关(不含全局层)。
 * 返回 `undefined` = 一个都没表达过;键缺席 = 那个 provider 没表达过 —— 两层缺席
 * 都落回全局。
 */
export function getSpaceOverlayProviderEnabled(
  spaceId: string | undefined | null,
): Record<string, boolean> | undefined {
  return readSpaceOverlay(spaceId).providerEnabled
}
