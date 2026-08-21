/**
 * 装前清单预读(file: 开发通道)—— 选中 tarball 即可安装。
 *
 * 包名本来就写在 tarball 里的 `package/package.json`,让用户再抄一遍纯属冗余:
 * 宿主自己知道名字,而安装链的名字一致性闸(core install.ts §1.5)本来就会在
 * 装后校验。这里把那份情报**提前**到用户点头之前,顺带把 `package/plugin.json`
 * 的声明摊开给确认页 —— 与市场确认页同一套披露口径:先看清单,再装。
 *
 * 零新依赖:node:zlib 解 gzip + 手写 512 字节块 tar 遍历。tar 只需读 header 的
 * name/size/typeflag,不必引入完整实现。
 *
 * **预读结果不是信任来源**。它只喂 UI 预填与披露;真正的名字一致性、SRI、
 * 零运行时依赖、内置撞名、失败回滚,一律仍由安装链自己在装后判定。谁都可以
 * 造一个"说自己叫 A、装出来是 B"的 tarball —— 那种包会照旧被安装链回滚。
 */
import fs from 'fs'
import { gunzipSync } from 'zlib'
import type {
  PluginTarballSummary,
  ReadPluginTarballErrorCode,
  ReadPluginTarballResponse,
} from '@shared/ipc/plugins.js'

/** v1 单一 scope(分发设计 §2.7):pluginId = 包名去 scope。 */
export const PLUGIN_PACKAGE_SCOPE = '@onething-plugins'

/** `@onething-plugins/<id>`;id 要当目录名用,所以不收 `/`、`..`、大写与空白。 */
const PACKAGE_NAME_PATTERN = /^@onething-plugins\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/

/** tarball 上限:插件是 bundle 后的分发物,几 MB 顶天;更大的先拒绝再说。 */
const MAX_TARBALL_BYTES = 32 * 1024 * 1024
/** 解压上限(gunzipSync 自己会抛):防 gzip 炸弹把主进程内存吃干。 */
const MAX_INFLATED_BYTES = 96 * 1024 * 1024

const TAR_BLOCK_SIZE = 512

/** npm pack 的固定根目录;`./` 前缀是某些 tar 实现的写法,一并归一。 */
const PACKAGE_JSON_ENTRY = 'package/package.json'
const MANIFEST_ENTRY = 'package/plugin.json'

class TarballReadError extends Error {
  constructor(readonly code: ReadPluginTarballErrorCode, message: string) {
    super(message)
    this.name = 'TarballReadError'
  }
}

function fail(code: ReadPluginTarballErrorCode, message: string): ReadPluginTarballResponse {
  return { success: false, errorCode: code, error: message }
}

function readHeaderString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.toString('utf-8', 0, end === -1 ? raw.length : end).trim()
}

/**
 * tar 的数值字段是 NUL/空格收尾的八进制字符串。
 *
 * GNU 的 base-256 扩展(最高位置 1)只在 > 8GB 的成员上出现 —— 插件 tarball
 * 不可能碰到,遇到就明确拒绝而不是猜一个数出来。
 */
function parseOctalField(block: Buffer, offset: number, length: number): number {
  if ((block[offset] ?? 0) & 0x80) {
    throw new TarballReadError('not-tar', 'This tarball uses GNU base-256 numeric fields, which are not supported')
  }
  const text = readHeaderString(block, offset, length)
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) {
    throw new TarballReadError('not-tar', `Malformed tar header field ("${text.slice(0, 16)}")`)
  }
  return Number.parseInt(text, 8)
}

/**
 * header 校验和 —— "这到底是不是 tar" 的唯一可靠判据。
 *
 * 少了它,一个碰巧能解 gzip 的随机文件会被当成"没有 package.json 的 tar",
 * 用户收到的错误就指错了方向。
 */
function headerChecksumMatches(block: Buffer): boolean {
  let declared: number
  try {
    declared = parseOctalField(block, 148, 8)
  } catch {
    return false
  }
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) {
    // 校验和字段本身按空格参与计算。
    const byte = i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0)
    unsigned += byte
    signed += byte > 127 ? byte - 256 : byte
  }
  return declared === unsigned || declared === signed
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) {
    if (block[i] !== 0) return false
  }
  return true
}

/** pax 扩展头(typeflag 'x')的记录格式:`<len> <key>=<value>\n`。只取 path。 */
function parsePaxPath(data: Buffer): string | null {
  const text = data.toString('utf-8')
  let cursor = 0
  while (cursor < text.length) {
    const space = text.indexOf(' ', cursor)
    if (space === -1) break
    const length = Number.parseInt(text.slice(cursor, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = text.slice(space + 1, cursor + length).replace(/\n$/, '')
    const eq = record.indexOf('=')
    if (eq > 0 && record.slice(0, eq) === 'path') return record.slice(eq + 1)
    cursor += length
  }
  return null
}

function normalizeEntryName(name: string): string {
  return name.replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * 遍历 tar,只取 `wanted` 里的成员,取齐即停。
 *
 * 支持的边界:ustar 的 prefix 长名拼接、GNU 长名扩展(typeflag 'L')、
 * pax 的 path 覆盖(typeflag 'x')。目录/符号链接/硬链接/设备等一律跳过 ——
 * 我们只认普通文件。
 */
export function readTarMembers(buffer: Buffer, wanted: readonly string[]): Map<string, Buffer> {
  const targets = new Set(wanted)
  const found = new Map<string, Buffer>()
  let offset = 0
  let pendingLongName: string | null = null
  let pendingPaxPath: string | null = null
  let sawAnyHeader = false

  while (offset + TAR_BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK_SIZE)
    // 归档结尾是两个全零块;见到第一个就收工(截断的归档也按结束处理)。
    if (isZeroBlock(header)) break
    if (!headerChecksumMatches(header)) {
      throw new TarballReadError(
        'not-tar',
        sawAnyHeader
          ? 'The archive is corrupt: a tar header failed its checksum'
          : 'The file is gzip but its contents are not a tar archive',
      )
    }
    sawAnyHeader = true

    const size = parseOctalField(header, 124, 12)
    const typeFlag = String.fromCharCode(header[156] ?? 0)
    offset += TAR_BLOCK_SIZE
    const dataEnd = offset + size
    if (dataEnd > buffer.length) {
      throw new TarballReadError('not-tar', 'The archive is truncated: a member extends past end of file')
    }
    const data = buffer.subarray(offset, dataEnd)
    // 成员数据按 512 字节向上取整占块。
    offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE

    if (typeFlag === 'L') {
      pendingLongName = data.toString('utf-8').replace(/\0+$/, '')
      continue
    }
    if (typeFlag === 'x') {
      pendingPaxPath = parsePaxPath(data)
      continue
    }
    // 'g' = pax 全局头,与单个成员无关;跳过且不清 pending。
    if (typeFlag === 'g') continue

    const ustar = header.toString('latin1', 257, 262) === 'ustar'
    const rawName = readHeaderString(header, 0, 100)
    const prefix = ustar ? readHeaderString(header, 345, 155) : ''
    const name = normalizeEntryName(
      pendingPaxPath ?? pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName),
    )
    pendingPaxPath = null
    pendingLongName = null

    // '0' / '\0' = 普通文件(老 tar 用 NUL);其余成员类型不是我们要的东西。
    if (typeFlag !== '0' && typeFlag !== '\0') continue
    if (targets.has(name) && !found.has(name)) {
      found.set(name, Buffer.from(data))
      if (found.size === targets.size) break
    }
  }

  return found
}

function parseJsonMember(data: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString('utf-8'))
  } catch (error) {
    throw new TarballReadError(
      'invalid-package-json',
      `${label} inside the tarball is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TarballReadError('invalid-package-json', `${label} inside the tarball is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * `package.json` 的 author 允许是 `{ name, email }` 对象形式 —— 披露行要的是
 * 一句人话,不是 `[object Object]`。
 */
function readAuthor(value: unknown): string | undefined {
  if (typeof value === 'string') return optionalString(value)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return optionalString((value as { name?: unknown }).name)
  }
  return undefined
}

/**
 * 读一个本地 .tgz 的清单摘要:包名/版本(package.json)+ 声明(plugin.json)。
 *
 * 失败一律是**结构化拒绝**,不猜:文件不在、不是 gzip、不是 tar、没有
 * package.json、name 不符命名契约,各自有 errorCode,UI 据此说清为什么装不了。
 * 唯一的降级是 `plugin.json` 缺失/坏 —— 那种包装得上但永远不会被加载,
 * 摘要照给并把这句话摆到确认页上。
 */
export function readPluginTarballSummary(filePath: string): ReadPluginTarballResponse {
  const trimmed = typeof filePath === 'string' ? filePath.trim() : ''
  if (!trimmed) return fail('not-found', 'No tarball path was given')

  let stat: fs.Stats
  try {
    stat = fs.statSync(trimmed)
  } catch {
    return fail('not-found', `No such file: ${trimmed}`)
  }
  if (!stat.isFile()) {
    return fail('not-found', `Not a file: ${trimmed} (the file: dev channel also accepts a plugin directory, but only a .tgz can be inspected before installing)`)
  }
  if (stat.size > MAX_TARBALL_BYTES) {
    return fail('too-large', `The tarball is ${Math.round(stat.size / 1024 / 1024)}MB, over the ${MAX_TARBALL_BYTES / 1024 / 1024}MB limit`)
  }

  let raw: Buffer
  try {
    raw = fs.readFileSync(trimmed)
  } catch (error) {
    return fail('unreadable', `Cannot read ${trimmed}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (raw.length < 2 || raw[0] !== 0x1f || raw[1] !== 0x8b) {
    return fail('not-gzip', 'The file is not a gzip archive — plugin packages are npm .tgz tarballs')
  }

  let inflated: Buffer
  try {
    inflated = gunzipSync(raw, { maxOutputLength: MAX_INFLATED_BYTES })
  } catch (error) {
    return fail('not-gzip', `Cannot decompress the tarball: ${error instanceof Error ? error.message : String(error)}`)
  }

  let members: Map<string, Buffer>
  try {
    members = readTarMembers(inflated, [PACKAGE_JSON_ENTRY, MANIFEST_ENTRY])
  } catch (error) {
    if (error instanceof TarballReadError) return fail(error.code, error.message)
    return fail('not-tar', `Cannot read the tar archive: ${error instanceof Error ? error.message : String(error)}`)
  }

  const packageJson = members.get(PACKAGE_JSON_ENTRY)
  if (!packageJson) {
    return fail('missing-package-json', 'The tarball has no package/package.json — it was not produced by `npm pack`')
  }

  let pkgRecord: Record<string, unknown>
  try {
    pkgRecord = parseJsonMember(packageJson, 'package.json')
  } catch (error) {
    if (error instanceof TarballReadError) return fail(error.code, error.message)
    throw error
  }

  const pkg = optionalString(pkgRecord.name)
  if (!pkg) return fail('missing-name', 'package.json inside the tarball has no "name"')
  if (!PACKAGE_NAME_PATTERN.test(pkg)) {
    return fail(
      'name-contract',
      `Package name "${pkg}" does not match the plugin naming contract ${PLUGIN_PACKAGE_SCOPE}/<id> `
      + '(v1 accepts a single scope; the plugin id is the package name minus the scope and is used as a directory name)',
    )
  }
  const version = optionalString(pkgRecord.version)
  if (!version) return fail('missing-version', `package.json inside the tarball has no "version" for ${pkg}`)

  const summary: PluginTarballSummary = {
    path: trimmed,
    pkg,
    pluginId: pkg.slice(PLUGIN_PACKAGE_SCOPE.length + 1),
    version,
  }
  // package.json 先兜底描述/作者:manifest 缺席或坏掉时,确认页也不至于
  // 只剩一个包名。下面 manifest 读到什么就覆盖什么。
  const pkgDescription = optionalString(pkgRecord.description)
  if (pkgDescription) summary.description = pkgDescription
  const pkgAuthor = readAuthor(pkgRecord.author)
  if (pkgAuthor) summary.author = pkgAuthor

  const manifestMember = members.get(MANIFEST_ENTRY)
  if (!manifestMember) {
    // 装得上,但 npm-ledger 扫描要求 plugin.json 存在才认这个包是插件 —— 说清楚。
    summary.manifestIssue = 'No plugin.json in the tarball: it would install but never load as a plugin.'
    return { success: true, summary }
  }

  let manifest: Record<string, unknown>
  try {
    manifest = parseJsonMember(manifestMember, 'plugin.json')
  } catch (error) {
    summary.manifestIssue = error instanceof Error
      ? `Cannot read plugin.json: ${error.message}`
      : 'Cannot read plugin.json'
    return { success: true, summary }
  }

  // 声明取自 manifest 原文(与市场索引条目同形),披露拼装因此可以同一套。
  const displayName = optionalString(manifest.name)
  if (displayName) summary.displayName = displayName
  const description = optionalString(manifest.description)
  if (description) summary.description = description
  const author = readAuthor(manifest.author)
  if (author) summary.author = author
  const minAppVersion = optionalString(manifest.minAppVersion)
  if (minAppVersion) summary.minAppVersion = minAppVersion
  if (manifest.contributes !== undefined) summary.contributes = manifest.contributes

  return { success: true, summary }
}
