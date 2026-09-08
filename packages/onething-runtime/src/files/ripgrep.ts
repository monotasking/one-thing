import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { BlobReader, BlobWriter, ZipReader } from '@zip.js/zip.js'

const PLATFORM_CONFIG = {
  'arm64-darwin': { platform: 'aarch64-apple-darwin', extension: 'tar.gz' },
  'arm64-linux': { platform: 'aarch64-unknown-linux-gnu', extension: 'tar.gz' },
  'x64-darwin': { platform: 'x86_64-apple-darwin', extension: 'tar.gz' },
  'x64-linux': { platform: 'x86_64-unknown-linux-musl', extension: 'tar.gz' },
  'x64-win32': { platform: 'x86_64-pc-windows-msvc', extension: 'zip' },
} as const

const RIPGREP_VERSION = '14.1.1'

export type OnethingRipgrepPlatformKey = keyof typeof PLATFORM_CONFIG

export interface OnethingRipgrepRuntimeAdapters {
  createFetch?: () => typeof fetch
  fetch?: typeof fetch
  spawn?: typeof nodeSpawn
  logger?: Pick<Console, 'log' | 'error'>
  homeDir?: string
  pathEnv?: string
  platform?: NodeJS.Platform
  arch?: string
}

export interface OnethingRipgrepListFilesOptions {
  cwd: string
  glob?: string[]
  hidden?: boolean
  noIgnore?: boolean
  /**
   * **往下最多几层**(09-07 事故第三条修)。缺席 = `DEFAULT_LIST_FILES_MAX_DEPTH`。
   *
   * 没有它的时候,一个 18GB、带 16 个 node_modules 的目录能让 `rg --files` 跑到
   * 462% CPU、415GB 虚拟内存还不回来。给一个上限,是让「列文件」这件事的代价与
   * 目录有多深脱钩;`0` 表示不设限(调用方明说要整棵树时才用)。
   */
  maxDepth?: number
  /**
   * 上游喊停(换词 / 预算到点)。**收到就杀进程**,不是「不再读它的输出」——
   * 后者会把一条 462% CPU 的 rg 留在机器上。
   */
  signal?: AbortSignal
}

/**
 * 默认深度。8 层盖得住一份普通仓库的源码树(`src/a/b/c/d/e/f/g`),盖不住
 * `node_modules` 里那种深度 —— 而那正是要挡的东西。
 */
export const DEFAULT_LIST_FILES_MAX_DEPTH = 8

export interface OnethingRipgrepSearchOptions {
  cwd: string
  pattern: string
  glob?: string[]
  maxCount?: number
  ignoreCase?: boolean
  literal?: boolean
}

export interface OnethingRipgrepSearchResult {
  path: string
  lineNumber: number
  lineText: string
}

let configuredAdapters: OnethingRipgrepRuntimeAdapters = {}
let cachedRgPath: string | null = null

export function configureOnethingRipgrepRuntime(adapters: OnethingRipgrepRuntimeAdapters): void {
  configuredAdapters = { ...configuredAdapters, ...adapters }
}

export function resetOnethingRipgrepRuntimeForTests(): void {
  configuredAdapters = {}
  cachedRgPath = null
}

function adaptersWith(overrides: OnethingRipgrepRuntimeAdapters = {}): Required<Pick<OnethingRipgrepRuntimeAdapters, 'logger'>> & OnethingRipgrepRuntimeAdapters {
  return {
    ...configuredAdapters,
    ...overrides,
    logger: overrides.logger ?? configuredAdapters.logger ?? console,
  }
}

export function getOnethingRipgrepPlatformConfig(
  platformKey: string,
): (typeof PLATFORM_CONFIG)[OnethingRipgrepPlatformKey] | undefined {
  return PLATFORM_CONFIG[platformKey as OnethingRipgrepPlatformKey]
}

function getPlatform(adapters: OnethingRipgrepRuntimeAdapters): NodeJS.Platform {
  return adapters.platform ?? process.platform
}

function getArch(adapters: OnethingRipgrepRuntimeAdapters): string {
  return adapters.arch ?? process.arch
}

function getPathEnv(adapters: OnethingRipgrepRuntimeAdapters): string {
  return adapters.pathEnv ?? process.env.PATH ?? ''
}

function getSpawn(adapters: OnethingRipgrepRuntimeAdapters): typeof nodeSpawn {
  return adapters.spawn ?? nodeSpawn
}

function getFetch(adapters: OnethingRipgrepRuntimeAdapters): typeof fetch {
  const fetchImpl = adapters.createFetch?.() ?? adapters.fetch ?? globalThis.fetch
  if (!fetchImpl) throw new Error('A fetch implementation is required to download ripgrep.')
  return fetchImpl
}

function getBinDir(adapters: OnethingRipgrepRuntimeAdapters): string {
  return path.join(adapters.homeDir ?? os.homedir(), '.onething', 'bin')
}

async function which(command: string, adapters: OnethingRipgrepRuntimeAdapters): Promise<string | null> {
  const isWin = getPlatform(adapters) === 'win32'
  const pathSep = isWin ? ';' : ':'
  const extensions = isWin ? ['.exe', '.cmd', '.bat', ''] : ['']

  for (const dir of getPathEnv(adapters).split(pathSep)) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, command + ext)
      try {
        await fs.access(fullPath, fs.constants.X_OK)
        return fullPath
      } catch {
        // Continue searching.
      }
    }
  }
  return null
}

async function downloadRipgrep(adapters: OnethingRipgrepRuntimeAdapters): Promise<string> {
  const platformKey = `${getArch(adapters)}-${getPlatform(adapters)}` as OnethingRipgrepPlatformKey
  const config = PLATFORM_CONFIG[platformKey]

  if (!config) {
    throw new Error(`Unsupported platform: ${platformKey}`)
  }

  const binDir = getBinDir(adapters)
  await fs.mkdir(binDir, { recursive: true })

  const rgFilename = getPlatform(adapters) === 'win32' ? 'rg.exe' : 'rg'
  const rgPath = path.join(binDir, rgFilename)

  try {
    await fs.access(rgPath, fs.constants.X_OK)
    return rgPath
  } catch {
    // Need to download.
  }

  adapters.logger?.log('[Ripgrep] Downloading ripgrep...')

  const filename = `ripgrep-${RIPGREP_VERSION}-${config.platform}.${config.extension}`
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${filename}`

  const response = await getFetch(adapters)(url)
  if (!response.ok) {
    throw new Error(`Failed to download ripgrep: ${response.status}`)
  }

  const buffer = await response.arrayBuffer()
  const archivePath = path.join(binDir, filename)
  await fs.writeFile(archivePath, Buffer.from(buffer))

  if (config.extension === 'tar.gz') {
    await extractTarGz(archivePath, binDir, platformKey, adapters)
  } else if (config.extension === 'zip') {
    await extractZip(archivePath, rgPath)
  }

  await fs.unlink(archivePath)

  if (getPlatform(adapters) !== 'win32') {
    await fs.chmod(rgPath, 0o755)
  }

  adapters.logger?.log('[Ripgrep] Downloaded and installed ripgrep')
  return rgPath
}

async function extractTarGz(
  archivePath: string,
  destDir: string,
  platformKey: string,
  adapters: OnethingRipgrepRuntimeAdapters,
): Promise<void> {
  const args = ['tar', '-xzf', archivePath, '--strip-components=1']

  if (platformKey.endsWith('-darwin')) {
    args.push('--include=*/rg')
  } else if (platformKey.endsWith('-linux')) {
    args.push('--wildcards', '*/rg')
  }

  await new Promise<void>((resolve, reject) => {
    const proc = getSpawn(adapters)(args[0], args.slice(1), {
      cwd: destDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    proc.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`tar extraction failed: ${stderr}`))
      } else {
        resolve()
      }
    })

    proc.on('error', reject)
  })
}

async function extractZip(archivePath: string, destPath: string): Promise<void> {
  const fileBuffer = await fs.readFile(archivePath)
  const blob = new Blob([fileBuffer])
  const zipReader = new ZipReader(new BlobReader(blob))

  const entries = await zipReader.getEntries()
  let rgEntry: (typeof entries)[0] | undefined

  for (const entry of entries) {
    if (entry.filename.endsWith('rg.exe') && !entry.directory) {
      rgEntry = entry
      break
    }
  }

  if (!rgEntry || !('getData' in rgEntry)) {
    await zipReader.close()
    throw new Error('rg.exe not found in zip archive')
  }

  const rgBlob = await (rgEntry as any).getData(new BlobWriter())
  const rgBuffer = await rgBlob.arrayBuffer()
  await fs.writeFile(destPath, Buffer.from(rgBuffer))
  await zipReader.close()
}

export async function getOnethingRipgrepPath(
  adaptersOverride: OnethingRipgrepRuntimeAdapters = {},
): Promise<string> {
  const adapters = adaptersWith(adaptersOverride)
  if (cachedRgPath) return cachedRgPath

  const systemRg = await which('rg', adapters)
  if (systemRg) {
    cachedRgPath = systemRg
    adapters.logger.log('[Ripgrep] Using system ripgrep:', systemRg)
    return systemRg
  }

  const binDir = getBinDir(adapters)
  const rgFilename = getPlatform(adapters) === 'win32' ? 'rg.exe' : 'rg'
  const localRg = path.join(binDir, rgFilename)

  try {
    await fs.access(localRg, fs.constants.X_OK)
    cachedRgPath = localRg
    adapters.logger.log('[Ripgrep] Using local ripgrep:', localRg)
    return localRg
  } catch {
    // Need to download.
  }

  cachedRgPath = await downloadRipgrep(adapters)
  return cachedRgPath
}

/**
 * `rg --files` 的参数。**两条边界是这里立的**(09-07 事故第三条修):
 *
 *  · **不再 `--follow`** —— 跟符号链接会绕环。真机上那两条挂死的 rg 吃到 415GB
 *    虚拟内存,就是沿着链接在同一棵树里转圈;`--files` 本来也没有「必须跟链接」
 *    的语义,想看链接指向的东西就把那个目录本身当根。
 *  · **`--max-depth` 缺省 8**(`DEFAULT_LIST_FILES_MAX_DEPTH`),`maxDepth: 0`
 *    才是不设限。
 *
 * `--no-ignore` 这一格照旧由调用方说了算,但**默认不给** —— 尊重 `.gitignore`
 * 的那一路自然绕开 `node_modules`,这是最便宜的那条边界。
 */
export function buildOnethingRipgrepFileListArgs(options: Pick<OnethingRipgrepListFilesOptions, 'glob' | 'hidden' | 'noIgnore' | 'maxDepth'>): string[] {
  const args = ['--files']

  if (options.hidden !== false) {
    args.push('--hidden')
  }

  if (options.noIgnore) {
    args.push('--no-ignore')
  }

  const maxDepth = options.maxDepth ?? DEFAULT_LIST_FILES_MAX_DEPTH
  if (maxDepth > 0) {
    args.push(`--max-depth=${maxDepth}`)
  }

  args.push('--glob=!.git/*')

  if (options.glob) {
    for (const glob of options.glob) {
      args.push(`--glob=${glob}`)
    }
  }

  return args
}

export function buildOnethingRipgrepSearchArgs(options: OnethingRipgrepSearchOptions): string[] {
  const args = ['-n', '-H', '--color=never', '--hidden', '--field-match-separator=|']

  if (options.ignoreCase) args.push('--ignore-case')
  if (options.literal) args.push('--fixed-strings')

  if (options.glob) {
    for (const glob of options.glob) {
      args.push('--glob', glob)
    }
  }

  if (options.maxCount) {
    args.push('--max-count', String(options.maxCount))
  }

  args.push('--regexp', options.pattern, options.cwd)
  return args
}

export function parseOnethingRipgrepSearchOutput(stdout: string): OnethingRipgrepSearchResult[] {
  const results: OnethingRipgrepSearchResult[] = []

  const lines = stdout.trim().split(/\r?\n/)
  for (const line of lines) {
    if (!line) continue

    const [filePath, lineNumStr, ...rest] = line.split('|')
    if (!filePath || !lineNumStr) continue

    const lineNumber = Number.parseInt(lineNumStr, 10)
    if (!Number.isFinite(lineNumber)) continue

    results.push({
      path: filePath,
      lineNumber,
      lineText: rest.join('|'),
    })
  }

  return results
}

/**
 * 列一个目录下的文件(一行一条相对路径)。
 *
 * ## 这只生成器**一定会杀掉它起的进程**(09-07 事故第三条修)
 *
 * 从前它既不收 `signal`、也没有 `finally`、从不 `kill`:消费方 `break`(拿够了)、
 * 抛错、或者上游换词,它都只是不再读 stdout —— 而 `rg` 还在那儿跑。真机上两条这样
 * 的孤儿吃到 462% CPU / 415GB 虚拟内存,清空输入框也不死,因为**没有人握着它**。
 *
 * 现在三条一起成立:
 *  ① `signal` 一 abort 就 `kill()` 并且**不再 yield**;
 *  ② `try/finally` 兜住消费方的一切退出方式(`break` / `return` / `throw` 都会让
 *     `for await` 调生成器的 `return()`,于是 `finally` 一定跑);
 *  ③ `kill()` 是幂等的(进程已退出时是 no-op),所以正常走完也照调不误。
 *
 * **上限不在这里**:`--files` 没有 `--max-count` 这回事(那是搜内容的参数)。
 * 「够了」由消费方 `break` 表达,而 `break` 现在等于杀进程 —— 这就是上限。
 */
export async function* listOnethingRipgrepFiles(
  options: OnethingRipgrepListFilesOptions,
  adaptersOverride: OnethingRipgrepRuntimeAdapters = {},
): AsyncGenerator<string> {
  const adapters = adaptersWith(adaptersOverride)
  const signal = options.signal
  if (signal?.aborted) return
  const rgPath = await getOnethingRipgrepPath(adapters)
  const args = buildOnethingRipgrepFileListArgs(options)

  try {
    const stats = await fs.stat(options.cwd)
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${options.cwd}`)
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new Error(`Directory not found: ${options.cwd}`)
    }
    throw error
  }

  adapters.logger.log(`[Ripgrep] Spawning: ${rgPath} ${args.join(' ')}`)
  adapters.logger.log(`[Ripgrep] cwd: ${options.cwd}`)

  const proc = getSpawn(adapters)(rgPath, args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

  let processClosed = false
  let closeResolve: (() => void) | null = null
  const closePromise = new Promise<void>((resolve) => {
    closeResolve = resolve
  })

  proc.on('close', (code) => {
    adapters.logger.log(`[Ripgrep] Process closed with code: ${code}`)
    processClosed = true
    if (closeResolve) closeResolve()
  })

  proc.on('error', (error) => {
    adapters.logger.error('[Ripgrep] Spawn error:', error)
    processClosed = true
    if (closeResolve) closeResolve()
  })

  /**
   * 杀。**幂等**:进程已经退出时 `kill()` 是 no-op,所以哪条路上都无脑调。
   *
   * **只杀,不 `destroy()` stdout**:杀掉进程本身就会让管道 EOF,那条
   * `for await` 于是**正常结束**;主动 destroy 一条正在被异步迭代的流,Node 会
   * 把它判成 `ERR_STREAM_PREMATURE_CLOSE` 抛给消费方 —— 上游换个词换出一个异常,
   * 那是自己给自己造的错。destroy 留给 `finally` 那一次兜底(那时循环已经出来了)。
   */
  const kill = (): void => {
    try {
      if (!processClosed) proc.kill()
    } catch {
      // 已经没了。
    }
  }

  // 上游喊停 = 当场杀,不等这一轮 chunk 读完。
  const onAbort = (): void => kill()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    let buffer = ''

    try {
      for await (const chunk of proc.stdout!) {
        // 被打断的那一刻起**一条都不再交** —— 交出去的行会被上游当成「这次的结果」。
        if (signal?.aborted) return
        buffer += chunk.toString()
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (signal?.aborted) return
          if (line) yield line
        }
      }
    } catch (error) {
      /*
       * 是我们自己把进程按掉才让这条流断的 —— 那不是一个要往上抛的错误,
       * 而是「这一趟到此为止」。别的读流错照抛。
       */
      if (!signal?.aborted) throw error
      return
    }

    if (signal?.aborted) return
    if (buffer) yield buffer

    if (!processClosed) {
      await closePromise
    }
  } finally {
    // 消费方 break / 抛错 / 上游 abort / 正常走完 —— 四条路都到这里。
    signal?.removeEventListener('abort', onAbort)
    kill()
    try {
      // 这一句在循环之外,所以不会再变成 premature close;它只是把管道收干净。
      proc.stdout?.destroy()
    } catch {
      // 已经没了。
    }
  }
}

export async function searchOnethingRipgrep(
  options: OnethingRipgrepSearchOptions,
  adaptersOverride: OnethingRipgrepRuntimeAdapters = {},
): Promise<OnethingRipgrepSearchResult[]> {
  const adapters = adaptersWith(adaptersOverride)
  const rgPath = await getOnethingRipgrepPath(adapters)
  const args = buildOnethingRipgrepSearchArgs(options)

  const proc = getSpawn(adapters)(rgPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  proc.stdout?.on('data', (data) => {
    stdout += data.toString()
  })

  proc.stderr?.on('data', (data) => {
    stderr += data.toString()
  })

  const exitCode = await new Promise<number>((resolve) => {
    proc.on('close', (code) => resolve(code ?? 1))
  })

  if (exitCode === 1) {
    return []
  }

  if (exitCode !== 0) {
    throw new Error(`ripgrep failed: ${stderr}`)
  }

  return parseOnethingRipgrepSearchOutput(stdout)
}

export async function getRipgrepPath(): Promise<string> {
  return getOnethingRipgrepPath()
}

export async function* listFiles(options: OnethingRipgrepListFilesOptions): AsyncGenerator<string> {
  yield* listOnethingRipgrepFiles(options)
}

export async function search(options: OnethingRipgrepSearchOptions): Promise<OnethingRipgrepSearchResult[]> {
  return searchOnethingRipgrep(options)
}

export const OnethingRipgrep = {
  filepath: getOnethingRipgrepPath,
  files: listOnethingRipgrepFiles,
  search: searchOnethingRipgrep,
}

export const Ripgrep = {
  filepath: getRipgrepPath,
  files: listFiles,
  search,
}
