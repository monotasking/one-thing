/**
 * ACP agent 的**自述**(manifest)—— 校验、注册表条目折叠、生效配置合成(A1-a,
 * 方案 `docs/design/acp-integration-2026-09.md` §3.2 / §3.9 / §9)。
 *
 * 全是纯函数:不读盘、不联网、不写日志。读盘(种子目录、注册表缓存)、联网(托管 fetch)
 * 与探测(PATH / 版本号)住装配层 `backend/wiring/acp/{registry,detect}.ts`;这里只回答
 * 「这坨 JSON 是不是一台 agent」「注册表那一行折成我们的形状长什么样」
 * 「manifest ⊕ 用户覆盖 = 进程管家拿到的哪一份配置」。
 *
 * 形状住 `@shared/contracts/acp.ts`(壳要画它)。本文件里**没有任何一台具体的 agent**:
 * 名册是 `resources/acp-agents/*.json` 与注册表,不是代码。
 */
import type { ACPAgentConfig, AcpAgentManifest } from '@shared/contracts/acp.js'

export type { AcpAgentManifest }

const AGENT_ID_PATTERN = /^[a-z0-9-]+$/
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isValidAcpAgentId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && AGENT_ID_PATTERN.test(value)
}

export function isValidAcpEnvKey(value: unknown): value is string {
  return typeof value === 'string' && ENV_KEY_PATTERN.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (isValidAcpEnvKey(key) && typeof item === 'string') out[key] = item
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 丢掉值为 undefined 的键 —— 落盘 / 逐字比对时「缺席」与「写了 undefined」是一回事。 */
function compact<T extends object>(value: T): T {
  const out = {} as T
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) (out as Record<string, unknown>)[key] = item
  }
  return out
}

export type AcpManifestParseResult =
  | { ok: true; manifest: AcpAgentManifest }
  | { ok: false; reason: string }

/**
 * 校验一份 manifest(种子文件)。`id` 只收 `[a-z0-9-]`,`name` 与 `launch.command` 必填;
 * 不认识的字段丢掉(种子文件里写错一个键不该让整台 agent 上不了榜,也不该原样流进壳)。
 */
export function parseAcpAgentManifest(raw: unknown): AcpManifestParseResult {
  if (!isRecord(raw)) return { ok: false, reason: 'manifest is not an object' }
  if (!isValidAcpAgentId(raw.id)) return { ok: false, reason: 'id must match [a-z0-9-]' }
  const name = nonEmptyString(raw.name)
  if (!name) return { ok: false, reason: `${raw.id}: name is required` }
  const launch = isRecord(raw.launch) ? raw.launch : undefined
  const command = nonEmptyString(launch?.command)
  if (!command) return { ok: false, reason: `${raw.id}: launch.command is required` }

  const manifest: AcpAgentManifest = compact({
    id: raw.id,
    name,
    description: nonEmptyString(raw.description),
    vendor: nonEmptyString(raw.vendor),
    icon: nonEmptyString(raw.icon),
    homepage: nonEmptyString(raw.homepage),
    launch: compact({
      command,
      args: stringArray(launch?.args),
      env: stringRecord(launch?.env),
    }),
    detect: parseDetect(raw.detect),
    install: parseInstall(raw.install),
    auth: parseAuth(raw.auth),
    configPaths: stringArray(raw.configPaths),
    quirks: parseQuirks(raw.quirks),
    experimental: raw.experimental === true ? true : undefined,
    registryId: isValidAcpAgentId(raw.registryId) ? raw.registryId : undefined,
    aliases: stringArray(raw.aliases)?.filter(isValidAcpAgentId),
  })
  return { ok: true, manifest }
}

function parseDetect(raw: unknown): AcpAgentManifest['detect'] {
  if (!isRecord(raw)) return undefined
  const detect = compact({
    bins: stringArray(raw.bins)?.filter(bin => bin.trim()),
    versionArgs: stringArray(raw.versionArgs),
    minVersion: nonEmptyString(raw.minVersion),
  })
  return Object.keys(detect).length > 0 ? detect : undefined
}

function parseInstall(raw: unknown): AcpAgentManifest['install'] {
  if (!isRecord(raw)) return undefined
  const install = compact({ npm: nonEmptyString(raw.npm), hint: nonEmptyString(raw.hint) })
  return Object.keys(install).length > 0 ? install : undefined
}

function parseAuth(raw: unknown): AcpAgentManifest['auth'] {
  if (!isRecord(raw)) return undefined
  const auth = compact({ hint: nonEmptyString(raw.hint), loginCommand: stringArray(raw.loginCommand) })
  return Object.keys(auth).length > 0 ? auth : undefined
}

function parseQuirks(raw: unknown): AcpAgentManifest['quirks'] {
  if (!isRecord(raw)) return undefined
  const quirks = compact({
    promptTimeoutMs: typeof raw.promptTimeoutMs === 'number' && raw.promptTimeoutMs > 0 ? raw.promptTimeoutMs : undefined,
    systemPromptMeta: raw.systemPromptMeta === 'claude-agent-acp' ? 'claude-agent-acp' as const : undefined,
  })
  return Object.keys(quirks).length > 0 ? quirks : undefined
}

// ── 官方注册表(§9)────────────────────────────────────────────────────────────

/** 注册表一行里我们读的那几格;其余字段原样忽略。 */
export interface AcpRegistryEntry {
  id: string
  name: string
  version?: string
  description?: string
  repository?: string
  website?: string
  icon?: string
  distribution: {
    npx?: { package: string; args?: string[]; env?: Record<string, string> }
    uvx?: { package: string; args?: string[]; env?: Record<string, string> }
    binary?: Record<string, { archive?: string; sha256?: string; cmd: string; args?: string[]; env?: Record<string, string> }>
  }
}

export interface AcpRegistryParseResult {
  entries: AcpRegistryEntry[]
  /** 被丢掉的条目(形状不对)。调用方记**一行** warn,不逐条刷屏。 */
  dropped: Array<{ id?: string; reason: string }>
}

/**
 * 解析注册表索引(`{ version, agents: AgentEntry[], extensions }`),或缓存里存的那个
 * `entries` 数组。容忍不认识的字段;坏条目丢掉并记进 `dropped`。
 */
export function parseAcpRegistryIndex(raw: unknown): AcpRegistryParseResult {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.agents) ? raw.agents : undefined
  if (!list) return { entries: [], dropped: [{ reason: 'registry index has no agents array' }] }
  const entries: AcpRegistryEntry[] = []
  const dropped: AcpRegistryParseResult['dropped'] = []
  const seen = new Set<string>()
  for (const item of list) {
    const parsed = parseAcpRegistryEntry(item)
    if (!parsed.ok) {
      dropped.push({ id: isRecord(item) && typeof item.id === 'string' ? item.id : undefined, reason: parsed.reason })
      continue
    }
    if (seen.has(parsed.entry.id)) continue
    seen.add(parsed.entry.id)
    entries.push(parsed.entry)
  }
  return { entries, dropped }
}

function parseAcpRegistryEntry(raw: unknown): { ok: true; entry: AcpRegistryEntry } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'entry is not an object' }
  if (!isValidAcpAgentId(raw.id)) return { ok: false, reason: 'id must match [a-z0-9-]' }
  const name = nonEmptyString(raw.name)
  if (!name) return { ok: false, reason: 'name is required' }
  const distribution = isRecord(raw.distribution) ? raw.distribution : undefined
  if (!distribution) return { ok: false, reason: 'distribution is required' }

  const pkg = (value: unknown) => {
    if (!isRecord(value)) return undefined
    const packageName = nonEmptyString(value.package)
    if (!packageName) return undefined
    return compact({ package: packageName, args: stringArray(value.args), env: stringRecord(value.env) })
  }
  let binary: AcpRegistryEntry['distribution']['binary']
  if (isRecord(distribution.binary)) {
    binary = {}
    for (const [platform, target] of Object.entries(distribution.binary)) {
      if (!isRecord(target)) continue
      const cmd = nonEmptyString(target.cmd)
      if (!cmd) continue
      binary[platform] = compact({
        archive: nonEmptyString(target.archive),
        sha256: nonEmptyString(target.sha256),
        cmd,
        args: stringArray(target.args),
        env: stringRecord(target.env),
      })
    }
    if (Object.keys(binary).length === 0) binary = undefined
  }
  const folded = compact({ npx: pkg(distribution.npx), uvx: pkg(distribution.uvx), binary })
  if (!folded.npx && !folded.uvx && !folded.binary) return { ok: false, reason: 'no known distribution form' }

  return {
    ok: true,
    entry: compact({
      id: raw.id,
      name,
      version: nonEmptyString(raw.version),
      description: nonEmptyString(raw.description),
      repository: nonEmptyString(raw.repository),
      website: nonEmptyString(raw.website),
      icon: nonEmptyString(raw.icon),
      distribution: folded,
    }),
  }
}

/** 注册表 `binary` 形的平台键:`darwin-aarch64` / `linux-x86_64` / `windows-x86_64` …… */
export function acpRegistryPlatformKey(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === 'win32' ? 'windows' : platform
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch
  return `${os}-${cpu}`
}

/** `@scope/pkg@1.2.3` → `@scope/pkg`;`pkg@1.2.3` → `pkg`;没有版本号原样。 */
export function stripNpmPackageVersion(spec: string): string {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

/** `./bin/goose.exe` → `goose`。 */
function executableName(cmd: string): string {
  const base = cmd.split(/[\\/]/).pop() ?? cmd
  return base.replace(/\.exe$/i, '')
}

/**
 * 注册表一行 → 我们的 manifest(§9 的折法):
 *  - `npx` 形 → `launch = npx -y <package@version> …args`,`install.npm` = 包名去版本号;
 *    探测走「PATH 上有没有 `npx`」。
 *  - `binary` 形 → **不自动下载**(签名 / 校验 / 更新是另一件事),只给 `install.hint`
 *    (仓库或官网);本平台有目标时,`launch` 写它解出来的**可执行名**加它的参数 ——
 *    装到 PATH 上之前起不来,探测也答未安装(于是缺省不启用);装上之后探测认领,不用
 *    再手填一遍命令。本平台没有目标就没有 `launch`,只能靠「复制为自定义」手填。
 *  - `uvx` 形 → 同 binary 口径:不替用户拉 Python 包,只给 hint 与 `detect.bins = [id]`。
 */
export function manifestFromRegistryEntry(entry: AcpRegistryEntry, platform: string = acpRegistryPlatformKey()): AcpAgentManifest {
  const hint = entry.repository ?? entry.website
  const base = compact({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    homepage: entry.website ?? entry.repository,
    icon: entry.icon,
  })
  const npx = entry.distribution.npx
  if (npx) {
    return compact({
      ...base,
      launch: compact({ command: 'npx', args: ['-y', npx.package, ...(npx.args ?? [])], env: npx.env }),
      install: { npm: stripNpmPackageVersion(npx.package) },
    }) as AcpAgentManifest
  }
  const target = entry.distribution.binary?.[platform]
  if (target) {
    const bin = executableName(target.cmd)
    return compact({
      ...base,
      launch: compact({ command: bin, args: target.args, env: target.env }),
      detect: { bins: [bin] },
      install: hint ? { hint } : undefined,
    }) as AcpAgentManifest
  }
  return compact({
    ...base,
    detect: { bins: [entry.id] },
    install: hint ? { hint } : undefined,
  }) as AcpAgentManifest
}

// ── 生效配置:manifest ⊕ 用户覆盖(§3.9 ①)──────────────────────────────────────

/** 覆盖里这些格原样胜出(写了就用覆盖的);`id` / 起法 / 环境变量另有规则。 */
const PASSTHROUGH_OVERRIDE_FIELDS = [
  'description',
  'cwd',
  'model',
  'unattended',
  'hostTools',
  'forwardMcpServers',
  'connectTimeoutMs',
  'promptTimeoutMs',
  'idleTimeoutMs',
  'maxBufferedUpdates',
  'maxSessionRecords',
  'basedOn',
  'secretEnv',
] as const satisfies ReadonlyArray<keyof ACPAgentConfig>

/**
 * 进程管家拿到的那一份:manifest 给缺省,覆盖里**写了的格**胜出。
 * `enabled` 覆盖没写时用 `defaults.enabled`(注册表按「探测到已安装」算出来传进来)。
 * 没有 `launch` 也没有覆盖命令的条目 `command` 是空串 —— 它上榜但不喂给管家。
 */
export function effectiveAgentConfig(
  manifest: AcpAgentManifest,
  override?: Partial<ACPAgentConfig>,
  defaults: { enabled?: boolean } = {},
): ACPAgentConfig {
  const launch = manifest.launch
  const env = { ...(launch?.env ?? {}), ...(override?.env ?? {}) }
  const config: ACPAgentConfig = {
    id: manifest.id,
    name: nonEmptyString(override?.name) ?? manifest.name,
    description: manifest.description,
    enabled: typeof override?.enabled === 'boolean' ? override.enabled : defaults.enabled === true,
    command: nonEmptyString(override?.command) ?? launch?.command ?? '',
    args: Array.isArray(override?.args) ? [...override.args] : [...(launch?.args ?? [])],
    env: Object.keys(env).length > 0 ? env : undefined,
    promptTimeoutMs: manifest.quirks?.promptTimeoutMs,
    // 连接要读的怪癖(A2-a):客户端据此决定 persona 走 `session/new._meta` 还是首条 prompt 头块。
    quirks: manifest.quirks?.systemPromptMeta ? { systemPromptMeta: manifest.quirks.systemPromptMeta } : undefined,
  }
  if (override) {
    for (const field of PASSTHROUGH_OVERRIDE_FIELDS) {
      const value = override[field]
      if (value !== undefined) (config as unknown as Record<string, unknown>)[field] = value
    }
  }
  return compact(config)
}

function sameStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? []
  const right = b ?? []
  return left.length === right.length && left.every((item, index) => item === right[index])
}

/**
 * 这条 `settings.acp.agents` 条目是不是**种子的拷贝**,而不是用户的意思。
 *
 * 起因:A1 之前 `DEFAULT_ACP_SETTINGS` 写死四条 agent,`normalizeACPSettings` 把它们并进
 * 每一份设置,设置一落盘,四条就作为「用户条目」躺在了老盘上。它们现在由种子文件提供;
 * 不把拷贝认出来,老用户的名册里每一台内置 agent 都会带着一份冒名的「用户覆盖」,
 * 缺省启用(= 探测到已安装)对他们永远不生效。
 *
 * 判据:id 同、命令同、参数同,**且 `enabled` 不是 `false`**。最后一格是因为旧的归一把
 * `enabled` 一律写成 `agent.enabled !== false`、而四条默认都是 `true` —— 盘上的 `false`
 * 只可能是用户亲手关的,那是意思,得留下。
 */
export function isSeedCopy(config: Partial<ACPAgentConfig> & { id?: string }, manifest: AcpAgentManifest): boolean {
  if (!manifest.launch) return false
  if (config.id !== manifest.id) return false
  if (config.enabled === false) return false
  if (config.basedOn) return false
  if ((config.command ?? '').trim() !== manifest.launch.command) return false
  return sameStrings(config.args, manifest.launch.args)
}

/** 用户手加的条目(没有种子、注册表可依)自己就是 manifest:起法照抄,探测看它的命令。 */
export function manifestFromUserConfig(config: ACPAgentConfig): AcpAgentManifest {
  return compact({
    id: config.id,
    name: nonEmptyString(config.name) ?? config.id,
    description: nonEmptyString(config.description),
    launch: config.command
      ? compact({ command: config.command, args: config.args, env: config.env })
      : undefined,
  }) as AcpAgentManifest
}

/** 「复制为自定义」:继承 `base` 的自述,换成自己的 id 与名字;别名与注册表身份不继承。 */
export function rebaseManifest(base: AcpAgentManifest, config: ACPAgentConfig): AcpAgentManifest {
  const { aliases: _aliases, registryId: _registryId, ...rest } = base
  return compact({ ...rest, id: config.id, name: nonEmptyString(config.name) ?? base.name })
}

/**
 * 覆盖条目里 A1-a 新加的两格的校验。返回第一条不合规的理由;全合规返回 undefined。
 * 写面(`addAgent` / `updateAgent`)拿它拒单;读面(设置归一)对应地丢掉脏值。
 */
export function describeAcpAgentConfigProblem(config: Partial<ACPAgentConfig>): string | undefined {
  if (config.basedOn !== undefined && !isValidAcpAgentId(config.basedOn)) {
    return 'basedOn must be an agent id ([a-z0-9-])'
  }
  if (config.secretEnv !== undefined) {
    if (!Array.isArray(config.secretEnv)) return 'secretEnv must be an array of environment variable names'
    const bad = config.secretEnv.find(key => !isValidAcpEnvKey(key))
    if (bad !== undefined) return `secretEnv key "${String(bad)}" is not a valid environment variable name`
  }
  return undefined
}

/** `1.2.3` 与 `1.2` 按段比大小;认不出的一方返回 undefined(不下判断)。 */
export function compareAcpAgentVersions(a: string, b: string): number | undefined {
  const parse = (value: string) => {
    const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(value)
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return undefined
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}
