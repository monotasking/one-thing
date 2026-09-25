/**
 * ACP agent **名册**(A1-a,方案 `docs/design/acp-integration-2026-09.md` §3.2 / §9 / §11.2)。
 *
 * 三个来源,一次合并:
 *  1. 内置种子 `resources/acp-agents/*.json`(打包时随 `extraResources` 搬走,与 skills 同一条规则);
 *  2. ACP 官方注册表(托管 fetch,走 `network.proxy`),落 `<store>/acp/registry-cache.json`,
 *     TTL 24h,失败用缓存、没缓存只用种子;
 *  3. 用户手加 / 覆盖:`settings.acp.agents[]`。
 *
 * 同 id:用户覆盖 > 种子 > 注册表。`effective = manifest ⊕ 覆盖`(只覆盖覆盖里写了的格),
 * `enabled` 覆盖没写时 = 探测到已安装。进程管家(`ACPManager`)吃的是 `effective`,不再直接吃设置。
 *
 * **这里不认识任何一台具体的 agent**:种子 id 与注册表 id 不同名的对应(`registryId`)、旧 id
 * 的认回(`aliases`)都写在种子文件里。加一台 agent = 加一个 JSON 文件,本文件零改动。
 *
 * 状态全在实例上(种子、注册表条目、探测结果、监听),没有模块级 `let` —— 实例归
 * `AcpSubsystem` 所有,随 backend 生灭。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  ACPAgentConfig,
  ACPSettings,
  AcpAgentDetect,
  AcpAgentManifest,
  AcpAgentSource,
} from '@onething/runtime/acp'
import {
  acpRegistryPlatformKey,
  effectiveAgentConfig,
  isSeedCopy,
  manifestFromRegistryEntry,
  manifestFromUserConfig,
  parseAcpAgentManifest,
  parseAcpRegistryIndex,
  rebaseManifest,
  type AcpRegistryEntry,
} from '@onething/runtime/acp/manifest'
import { getLogger } from '../logging/index.js'
import { detectAgent, locateAgentBin } from './detect.js'

const log = getLogger('app.acp.registry')

export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
export const ACP_REGISTRY_TTL_MS = 24 * 60 * 60 * 1000
const ACP_REGISTRY_FETCH_TIMEOUT_MS = 15_000

/** 名册里的一行。 */
export interface AcpAgentRosterEntry {
  manifest: AcpAgentManifest
  source: AcpAgentSource
  /** 用户在 `settings.acp.agents` 里写的那一条(种子拷贝不算);没有 = 全用 manifest。 */
  override?: ACPAgentConfig
  /** 进程管家拿到的那一份。 */
  effective: ACPAgentConfig
  detect?: AcpAgentDetect
}

/** 注册表拉取只要这三样;测试注入一只假的,永不联网。 */
export type AcpRegistryFetch = (
  url: string,
  init: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface AcpAgentRegistryDeps {
  /** 种子目录(`resources/acp-agents`)。每次 refresh 现取,宿主端口可能晚到。 */
  seedDir: () => string
  /** `<store>/acp/registry-cache.json`。 */
  cachePath: () => string
  /** 当下的 `settings.acp`。 */
  settings: () => ACPSettings
  /** 缺省不给 = 永不联网(测试与未接网络的宿主)。 */
  fetch?: () => AcpRegistryFetch
  detect?: (manifest: AcpAgentManifest) => Promise<AcpAgentDetect>
  locate?: (manifest: AcpAgentManifest) => AcpAgentDetect
  now?: () => number
  /** 注册表 `binary` 形的平台键;缺省按本机算。 */
  platform?: string
  registryUrl?: string
  ttlMs?: number
}

export interface AcpRegistryRefreshOptions {
  /** 缺省 true。false = 只重读种子与缓存、重新探测。 */
  network?: boolean
  /** true = 不看 TTL,立刻重拉(RPC `acp.refreshRegistry`)。 */
  force?: boolean
  signal?: AbortSignal
}

interface RegistryCacheFile {
  fetchedAt: number
  entries: unknown
}

export class AcpAgentRegistry {
  private readonly deps: AcpAgentRegistryDeps
  private seeds: AcpAgentManifest[] = []
  private registryEntries: AcpRegistryEntry[] = []
  private fetchedAt: number | undefined
  private readonly detections = new Map<string, AcpAgentDetect>()
  private readonly listeners = new Set<() => void>()
  private localLoaded = false

  constructor(deps: AcpAgentRegistryDeps) {
    this.deps = deps
  }

  /**
   * 同步读种子与注册表缓存,并同步判一遍「装没装」(不取版本号)。冷启动时名册靠它先能用,
   * 之后联网与完整探测在后台补;幂等(第二次起只在 `refresh` 里重读)。
   */
  loadLocal(): void {
    if (this.localLoaded) return
    this.localLoaded = true
    this.loadSeeds()
    this.loadCache()
    const locate = this.deps.locate ?? ((manifest: AcpAgentManifest) => locateAgentBin(manifest))
    for (const entry of this.rosterWithoutLoad(this.deps.settings())) {
      try {
        this.detections.set(entry.manifest.id, locate(entry.manifest))
      } catch (error) {
        log.warn('acp agent locate failed', { agentId: entry.manifest.id }, error)
      }
    }
  }

  /** 名册。`settings` 缺席 = 读当下的设置;设置域刚改完、还没落盘时由调用方递新值。 */
  roster(settings?: ACPSettings): AcpAgentRosterEntry[] {
    this.loadLocal()
    return this.rosterWithoutLoad(settings ?? this.deps.settings())
  }

  /** 旧 id → 现 id(来自种子的 `aliases`)。进程管家据此把老会话里的旧 id 认回来。 */
  aliases(): Record<string, string> {
    this.loadLocal()
    const out: Record<string, string> = {}
    for (const seed of this.seeds) {
      for (const alias of seed.aliases ?? []) out[alias] = seed.id
    }
    return out
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 重读种子 → (按需)拉注册表 → 探测全部。名册变了才通知(探测时刻 `checkedAt` 不算变化)。
   * 失败不抛:联网失败用缓存,探测失败那一台答未安装。
   */
  async refresh(options: AcpRegistryRefreshOptions = {}): Promise<void> {
    this.loadLocal()
    const before = this.snapshot()
    this.loadSeeds()
    if (options.network !== false) await this.maybeFetchRegistry(options)
    if (options.signal?.aborted) return
    await this.detectManifests(this.roster().map(entry => entry.manifest))
    if (options.signal?.aborted) return
    if (this.snapshot() !== before) this.emitChanged()
  }

  /** 探测一台(`agentId`)或全部。RPC `acp.detect` 与设置页打开时调;不轮询。 */
  async detect(agentId?: string): Promise<void> {
    const before = this.snapshot()
    const manifests = this.roster()
      .map(entry => entry.manifest)
      .filter(manifest => !agentId || manifest.id === agentId)
    await this.detectManifests(manifests)
    if (this.snapshot() !== before) this.emitChanged()
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private rosterWithoutLoad(settings: ACPSettings): AcpAgentRosterEntry[] {
    const seedById = new Map(this.seeds.map(seed => [seed.id, seed]))
    // 种子已经代表的注册表条目(同 id,或种子声明的 `registryId`)不再单独上榜。
    const claimedRegistryIds = new Set<string>()
    for (const seed of this.seeds) {
      claimedRegistryIds.add(seed.id)
      if (seed.registryId) claimedRegistryIds.add(seed.registryId)
    }
    const platform = this.deps.platform ?? acpRegistryPlatformKey()
    const registryManifests = this.registryEntries
      .filter(entry => !claimedRegistryIds.has(entry.id))
      .map(entry => manifestFromRegistryEntry(entry, platform))
    const registryById = new Map(registryManifests.map(manifest => [manifest.id, manifest]))

    const aliasTargets = new Map<string, string>()
    for (const seed of this.seeds) {
      for (const alias of seed.aliases ?? []) aliasTargets.set(alias, seed.id)
    }
    const presentIds = new Set((settings.agents ?? []).map(agent => agent?.id).filter(Boolean))

    const overrides = new Map<string, ACPAgentConfig>()
    for (const raw of settings.agents ?? []) {
      if (!raw?.id) continue
      // 旧 id 认回(`codex-cli` → `codex`):只在新 id 没有自己的条目时改名,免得两条打架。
      const target = aliasTargets.get(raw.id)
      const config = target && !presentIds.has(target) ? { ...raw, id: target } : raw
      if (overrides.has(config.id)) continue
      const manifest = seedById.get(config.id) ?? registryById.get(config.id)
      // A1 之前写死在 defaults 里、被归一写回老盘的四条 —— 是种子的拷贝,不是用户的意思。
      if (manifest && isSeedCopy(config, manifest)) continue
      overrides.set(config.id, config)
    }

    const row = (manifest: AcpAgentManifest, source: AcpAgentSource): AcpAgentRosterEntry => {
      const override = overrides.get(manifest.id)
      const detect = this.detections.get(manifest.id)
      return {
        manifest,
        source,
        ...(override ? { override } : {}),
        effective: effectiveAgentConfig(manifest, override, { enabled: detect?.installed === true }),
        ...(detect ? { detect } : {}),
      }
    }

    const rows: AcpAgentRosterEntry[] = this.seeds.map(seed => row(seed, 'builtin'))
    for (const override of overrides.values()) {
      if (seedById.has(override.id) || registryById.has(override.id)) continue
      const base = override.basedOn ? seedById.get(override.basedOn) ?? registryById.get(override.basedOn) : undefined
      if (override.basedOn && !base) {
        log.warn('acp agent basedOn target missing', { agentId: override.id, basedOn: override.basedOn })
      }
      const manifest = base ? rebaseManifest(base, override) : manifestFromUserConfig(override)
      rows.push(row(manifest, 'user'))
    }
    for (const manifest of registryManifests) rows.push(row(manifest, 'registry'))
    return rows
  }

  private loadSeeds(): void {
    let dir: string
    try {
      dir = this.deps.seedDir()
    } catch (error) {
      log.warn('acp seed dir unavailable', {}, error)
      this.seeds = []
      return
    }
    if (!existsSync(dir)) {
      log.info('acp seed dir missing', { dir })
      this.seeds = []
      return
    }
    const seeds: AcpAgentManifest[] = []
    const rejected: Array<{ file: string; reason: string }> = []
    const seen = new Set<string>()
    for (const file of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(path.join(dir, file), 'utf8'))
      } catch (error) {
        rejected.push({ file, reason: error instanceof Error ? error.message : String(error) })
        continue
      }
      const parsed = parseAcpAgentManifest(raw)
      if (!parsed.ok) {
        rejected.push({ file, reason: parsed.reason })
        continue
      }
      if (seen.has(parsed.manifest.id)) {
        rejected.push({ file, reason: `duplicate id ${parsed.manifest.id}` })
        continue
      }
      seen.add(parsed.manifest.id)
      seeds.push(parsed.manifest)
    }
    // 坏种子只记一行:其余照常上榜,一个写错的文件不拖垮整张名册。
    if (rejected.length > 0) log.warn('acp seed manifests rejected', { dir, rejected })
    this.seeds = seeds
  }

  private loadCache(): void {
    const file = this.deps.cachePath()
    if (!existsSync(file)) return
    try {
      const cache = JSON.parse(readFileSync(file, 'utf8')) as Partial<RegistryCacheFile>
      const parsed = parseAcpRegistryIndex(cache.entries)
      if (parsed.dropped.length > 0) log.warn('acp registry cache entries dropped', { file, dropped: parsed.dropped })
      this.registryEntries = parsed.entries
      this.fetchedAt = typeof cache.fetchedAt === 'number' ? cache.fetchedAt : undefined
    } catch (error) {
      log.warn('acp registry cache unreadable', { file }, error)
    }
  }

  private registryEnabled(): boolean {
    return this.deps.settings().registry?.enabled !== false
  }

  private async maybeFetchRegistry(options: AcpRegistryRefreshOptions): Promise<void> {
    if (!this.registryEnabled()) return
    const fetchFactory = this.deps.fetch
    if (!fetchFactory) return
    const now = (this.deps.now ?? Date.now)()
    const ttl = this.deps.ttlMs ?? ACP_REGISTRY_TTL_MS
    if (!options.force && this.fetchedAt !== undefined && now - this.fetchedAt < ttl) return

    const url = this.deps.registryUrl ?? ACP_REGISTRY_URL
    // 每次真的要联网都记一行:「开关关着 = 零请求」要能从日志上核对(gate:acp 就这么核)。
    log.info('acp registry fetching', { url, force: options.force === true })
    const timeout = AbortSignal.timeout(ACP_REGISTRY_FETCH_TIMEOUT_MS)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    try {
      const response = await fetchFactory()(url, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const parsed = parseAcpRegistryIndex(await response.json())
      if (parsed.dropped.length > 0) log.warn('acp registry entries dropped', { url, dropped: parsed.dropped })
      if (parsed.entries.length === 0) throw new Error('registry has no usable entries')
      this.registryEntries = parsed.entries
      this.fetchedAt = now
      this.writeCache({ fetchedAt: now, entries: parsed.entries })
    } catch (error) {
      if (options.signal?.aborted) return
      // 离线 / 被墙 / 形状变了:用缓存(没有就只用种子),记一行。
      log.warn('acp registry fetch failed; using cache', {
        url,
        cached: this.registryEntries.length,
      }, error)
    }
  }

  private writeCache(cache: RegistryCacheFile): void {
    const file = this.deps.cachePath()
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(cache, null, 2))
      renameSync(tmp, file)
    } catch (error) {
      log.warn('acp registry cache write failed', { file }, error)
    }
  }

  private async detectManifests(manifests: AcpAgentManifest[]): Promise<void> {
    const detect = this.deps.detect ?? ((manifest: AcpAgentManifest) => detectAgent(manifest))
    await Promise.all(manifests.map(async manifest => {
      try {
        this.detections.set(manifest.id, await detect(manifest))
      } catch (error) {
        log.warn('acp agent detect failed', { agentId: manifest.id }, error)
        this.detections.set(manifest.id, { installed: false, checkedAt: (this.deps.now ?? Date.now)() })
      }
    }))
  }

  /** 变化判据:名册逐字比,探测时刻不算。 */
  private snapshot(): string {
    return JSON.stringify(this.rosterWithoutLoad(this.deps.settings()), (key, value) =>
      key === 'checkedAt' ? undefined : value)
  }

  private emitChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        log.warn('acp registry listener failed', {}, error)
      }
    }
  }
}
