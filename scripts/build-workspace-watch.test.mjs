import { afterEach, describe, expect, it } from 'vitest'
import { build as esbuild } from 'esbuild'
import { build as viteBuild } from 'vite'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, copyFile, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPackageWithOptions, statFile, extractFile, getRawHeader } from '@electron/asar'
import { parse } from 'yaml'
import { shellEsbuildOptions } from '../apps/desktop-react/scripts/build-electron.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const driverEntry = path.join(root, 'packages/backend/wiring/files/workspace-watch-driver.ts')
const fixtures = []
const children = []

afterEach(async () => {
  // This owner is independent of the driver's ready/close promises. A failing
  // probe must actually terminate before its package or watched root is removed.
  for (const owned of children.splice(0)) {
    if (!owned.closed) owned.child.kill('SIGKILL')
    await owned.completion
  }
  for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'workspace-watch-package-'))
  fixtures.push(directory)
  return directory
}

async function run(executable, runner, driver, directory, electron = false) {
  const home = path.join(directory, electron ? 'electron-home' : 'node-home')
  await mkdir(home)
  const watched = path.join(home, 'watched')
  await mkdir(watched)
  const child = spawn(executable, [runner, driver, watched], {
    cwd: home, env: { HOME: home, TMPDIR: home, TMP: home, TEMP: home,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
      PATH: '/usr/bin:/bin', ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = '', firstError, forced = false
  const owned = { child, closed: false, completion: undefined }
  owned.completion = new Promise(resolve => child.once('close', (code, signal) => {
    owned.closed = true
    resolve({ code, signal })
  }))
  children.push(owned)
  const remember = error => { firstError ??= error }
  child.on('error', remember)
  child.stdout.on('error', remember)
  child.stderr.on('error', remember)
  child.stdout.on('data', bytes => { stdout += bytes })
  child.stderr.on('data', bytes => { stderr += bytes })
  const timer = setTimeout(() => { forced = true; child.kill('SIGKILL') }, 20000)
  const close = await owned.completion.finally(() => clearTimeout(timer))
  if (firstError) throw firstError
  expect({ close, forced, stderr }).toEqual({ close: { code: 0, signal: null }, forced: false, stderr: '' })
  expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  const report = JSON.parse(stdout)
  expect(report).toMatchObject({ ready: true, closed: true, version: '2.3.2', historyDone: 0x10, errors: [] })
  expect(await readdir(watched)).toEqual([])
  return report
}

describe('workspace watcher runtime packaging', () => {
  it('pins the macOS optional runtime dependency in both installation contracts', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const npm = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
    const bun = await readFile(path.join(root, 'bun.lock'), 'utf8')
    expect(manifest.optionalDependencies.fsevents).toBe('2.3.2')
    expect(manifest.dependencies.fsevents).toBeUndefined()
    expect(npm.packages[''].optionalDependencies.fsevents).toBe('2.3.2')
    expect(npm.packages['node_modules/fsevents']).toMatchObject({ version: '2.3.2', optional: true, os: ['darwin'] })
    expect(npm.packages['node_modules/fsevents'].dev).not.toBe(true)
    expect(bun).toMatch(/"optionalDependencies":\s*\{\s*"fsevents": "2\.3\.2"/)
  })

  it('keeps the real driver native import external in the CLI, desktop and Server recipes', async () => {
    const directory = await fixture()
    for (const host of ['cli', 'desktop']) {
      const result = await esbuild({ ...shellEsbuildOptions({ entryPoints: { watch: driverEntry }, outdir: path.join(directory, host) }),
        metafile: true, logLevel: 'silent' })
      const output = Object.entries(result.metafile.outputs).find(([name]) => name.endsWith('watch.cjs'))[1]
      expect(output.imports).toContainEqual(expect.objectContaining({ path: 'fsevents', external: true }))
      expect(Object.keys(result.metafile.inputs).some(name => name.includes('node_modules/fsevents/'))).toBe(false)
    }
    const result = await viteBuild({ configFile: path.join(root, 'apps/server/vite.config.ts'),
      logLevel: 'silent', build: { ssr: driverEntry, outDir: path.join(directory, 'server'), write: false } })
    const chunk = result.output.find(item => item.type === 'chunk')
    expect(chunk.dynamicImports).toContain('fsevents')
    expect(Object.keys(chunk.modules).some(name => name.includes('node_modules/fsevents/'))).toBe(false)
  })

/**
 * 等这份归档真的写完。
 *
 * `@electron/asar` 的 `streamFilesystem` 以 `return out.end()` 收尾,而 `end()` 交回的
 * 是流本身、不是「写完了」的承诺 —— 于是 `pack()` resolve 的那一刻,尾巴可能还在
 * 内核缓冲里。机器一忙(全量跑),紧接着读回来的就是一串 NUL,看起来像归档偏移
 * 被写坏了,其实只是读得太早。等的是**头里声明的总长**,不是「等一会儿」。
 */
async function archiveComplete(archive) {
  const { header, headerSize } = getRawHeader(archive)
  let end = 0
  const walk = node => {
    if (node.files) { for (const child of Object.values(node.files)) walk(child); return }
    if (node.offset !== undefined) end = Math.max(end, Number(node.offset) + node.size)
  }
  walk(header)
  const total = 8 + headerSize + end
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if ((await lstat(archive)).size >= total) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`asar archive never reached its declared length (${total}): ${archive}`)
}

  it('keeps the desktop sibling entries and later packed offsets intact in the actual builder stream pipeline', async () => {
    const directory = await fixture()
    const staging = path.join(directory, 'staging'), resources = path.join(directory, 'resources')
    const content = new Map([
      ['apps/desktop-react/dist-electron/bundle-sibling.mjs', 'export const sibling = true\n'],
      ['apps/desktop-react/dist-electron/main.cjs', 'module.exports = "main remains readable"\n'],
      ['apps/desktop-react/dist-electron/preload.cjs', 'module.exports = "renderer preload remains readable"\n'],
      ['apps/desktop-react/dist-electron/search-worker.cjs', 'module.exports = "physical worker"\n'],
      ['apps/desktop-react/dist/index.html', '<html>packed renderer</html>\n'],
      ['package.json', JSON.stringify({ name: 'stream-pipeline-fixture', main: 'apps/desktop-react/dist-electron/main.cjs' })],
    ])
    const metadata = new Map(), files = []
    for (const [relative, text] of content) {
      const file = path.join(staging, relative)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, text)
      files.push(file)
      metadata.set(file, await lstat(file))
    }
    const config = parse(await readFile(path.join(root, 'electron-builder.yml'), 'utf8'))
    // Use electron-builder's real sorting, parent-directory flags, matching and
    // createPackageFromStreams integration; direct asar packing misses this bug.
    const { AsarPackager } = require('app-builder-lib/out/asar/asarUtil')
    const { getFileMatchers } = require('app-builder-lib/out/fileMatcher')
    const matcher = getFileMatchers(config, 'asarUnpack', staging, {
      macroExpander: value => value, customBuildOptions: {}, globalOutDir: directory, defaultSrc: staging,
    })[0]
    await new AsarPackager({ info: { getWorkspaceRoot: async () => directory } }, {
      defaultDestination: staging, resourcePath: resources, options: {}, unpackPattern: matcher.createFilter(),
    }).pack([{ src: staging, destination: staging, files, metadata }])
    const archive = path.join(resources, 'app.asar')
    await archiveComplete(archive)
    // 判据一:**打进包里的那些兄弟文件逐字节读得回来**。归档偏移一旦被
    // 「单文件 unpack」的 header 弄偏,这一趟就会读出别人的内容或读不出来。
    for (const [relative, text] of content) expect(extractFile(archive, relative).toString()).toBe(text)
    // 判据二:解包的**只有 worker 那一个文件**(工单 4 B3 回单文件)。
    // 2026-09-06/07 那轮把规则放宽成 `dist-electron/**` 并把这条断言改成
    // 「凡 dist-electron 下的都解包」,理由是 electron-builder 26.4 的流式归档
    // 在单文件 unpack 上有个 header/写入流不一致的坑。真跑下来判据一在单文件
    // 规则下是绿的 —— 那个坑在这条管线上复现不出来,而放宽的代价是
    // main.cjs / preload.cjs 一起出 asar、签名姿态跟着变。
    const unpacked = 'apps/desktop-react/dist-electron/search-worker.cjs'
    for (const relative of content.keys()) {
      expect(statFile(archive, relative).unpacked === true).toBe(relative === unpacked)
    }
  })

  it.runIf(process.platform === 'darwin')('loads the isolated actual package in Node and from the configured asar in Electron, then really closes', async () => {
    const directory = await fixture()
    const staging = path.join(directory, 'application')
    const packageDir = path.join(staging, 'node_modules/fsevents')
    await mkdir(packageDir, { recursive: true })
    const installed = path.dirname(require.resolve('fsevents/package.json'))
    for (const name of ['package.json', 'fsevents.js', 'fsevents.node']) await copyFile(path.join(installed, name), path.join(packageDir, name))
    await writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: 'isolated-workspace-watch', type: 'commonjs' }))
    const relativeDriver = 'apps/desktop-react/dist-electron/watch.cjs'
    await esbuild({ ...shellEsbuildOptions({ entryPoints: { watch: driverEntry }, outdir: path.join(staging, path.dirname(relativeDriver)) }), logLevel: 'silent' })
    const runner = path.join(directory, 'run.cjs')
    await writeFile(runner, `
const { createRequire } = require('node:module')
const selected = process.argv[2], watched = process.argv[3]
const load = createRequire(selected)
const errors = []
const { createWorkspaceWatchDriver } = load(selected)
const driver = createWorkspaceWatchDriver(watched, () => {}, error => errors.push(String(error)))
;(async () => {
  try { await driver.ready } finally { await driver.close() }
  const fsevents = load('fsevents')
  process.stdout.write(JSON.stringify({ ready: true, closed: true, errors,
    version: load('fsevents/package.json').version, historyDone: fsevents.constants.HistoryDone,
    executable: process.execPath, packagePath: load.resolve('fsevents') }))
})().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1 })
`)
    await run(process.execPath, runner, path.join(staging, relativeDriver), directory)
    const config = parse(await readFile(path.join(root, 'electron-builder.yml'), 'utf8'))
    const unpack = config.asarUnpack.find(rule => rule === '**/node_modules/fsevents/**')
    expect(unpack).toBe('**/node_modules/fsevents/**')
    const resources = path.join(directory, 'resources')
    await mkdir(resources)
    const archive = path.join(resources, 'app.asar')
    await createPackageWithOptions(staging, archive, { unpack })
    for (const name of ['package.json', 'fsevents.js', 'fsevents.node']) {
      const relative = `node_modules/fsevents/${name}`
      expect(statFile(archive, relative).unpacked).toBe(true)
      expect(await readFile(path.join(resources, 'app.asar.unpacked', relative))).toEqual(await readFile(path.join(installed, name)))
    }
    await run(require('electron'), runner, path.join(archive, relativeDriver), directory, true)
  }, 45000)
})
