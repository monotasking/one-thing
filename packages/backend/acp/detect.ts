/**
 * ACP agent 探测(A1-a,方案 `docs/design/acp-integration-2026-09.md` §3.2):装了没有、在哪、
 * 什么版本。只读 manifest 的 `detect` 一格,不猜。
 *
 * PATH 用的是**当下的** `process.env.PATH` —— 桌面在起后置服务之前已经把登录 shell 的 PATH
 * 灌进来了(`electron/login-shell-env.ts`),所以 Dock 起的应用也认得 Homebrew / npm 全局装的
 * CLI。探测只在 `registry.refresh()` 与 RPC `acp.detect` 时跑,**从不挂定时器**。
 *
 * 分两半:`locateAgentBin` 是同步的(几十次 `access` 系统调用,毫秒级),名册冷启动时先用它
 * 给出「装没装」;`detectAgent` 再异步补上版本号(要起一次子进程,3s 上限)。
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import type { AcpAgentDetect, AcpAgentManifest } from '@shared/contracts/acp'
import { compareAcpAgentVersions } from '@onething/backend/acp/acp-manifest'

export const ACP_DETECT_VERSION_TIMEOUT_MS = 3000

export interface AcpDetectEnvironment {
  /** 缺省 `process.env.PATH`。 */
  path?: string
  /** 缺省 `process.platform`。 */
  platform?: NodeJS.Platform
  now?: () => number
}

/** 这台 agent 要找的可执行名:`detect.bins`,缺席就用 `launch.command`。 */
export function agentBins(manifest: AcpAgentManifest): string[] {
  const bins = manifest.detect?.bins?.filter(Boolean)
  if (bins && bins.length > 0) return bins
  return manifest.launch?.command ? [manifest.launch.command] : []
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 在 PATH 上找一个可执行;带路径分隔符的名字按路径直接判(用户手加的绝对路径命令)。 */
export function whichSync(name: string, env: AcpDetectEnvironment = {}): string | undefined {
  const platform = env.platform ?? process.platform
  const extensions = platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : ['']
  if (name.includes('/') || name.includes('\\')) {
    for (const ext of extensions) {
      if (isExecutableFile(name + ext)) return path.resolve(name + ext)
    }
    return undefined
  }
  const dirs = (env.path ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * 同步半边:装没装、在哪。`launch.command === 'npx'` 的条目(注册表 npx 形)装没装 = 找不找得到
 * `npx` —— 包由 npx 现拉,本机不必预装。
 */
export function locateAgentBin(manifest: AcpAgentManifest, env: AcpDetectEnvironment = {}): AcpAgentDetect {
  const checkedAt = (env.now ?? Date.now)()
  const bins = manifest.launch?.command === 'npx' ? ['npx'] : agentBins(manifest)
  for (const bin of bins) {
    const found = whichSync(bin, env)
    if (found) return { installed: true, path: found, checkedAt }
  }
  return { installed: false, checkedAt }
}

/** 首行里第一个 `x.y` / `x.y.z`。 */
export function parseVersionLine(output: string): string | undefined {
  const firstLine = output.split(/\r?\n/).find(line => line.trim()) ?? ''
  return /\d+\.\d+(?:\.\d+)?/.exec(firstLine)?.[0]
}

function runVersion(file: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: ACP_DETECT_VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      const text = `${stdout ?? ''}`.trim() || `${stderr ?? ''}`.trim()
      if (error && !text) {
        resolve(undefined)
        return
      }
      resolve(parseVersionLine(text))
    })
  })
}

/**
 * 完整探测:先同步找,找到了且 manifest 写了 `versionArgs` 才跑一次取版本号(没写就不跑 ——
 * 不认识的 CLI 带 `--version` 起来也可能直接进 stdio 会话,白白挂 3s)。
 */
export async function detectAgent(manifest: AcpAgentManifest, env: AcpDetectEnvironment = {}): Promise<AcpAgentDetect> {
  const located = locateAgentBin(manifest, env)
  const versionArgs = manifest.detect?.versionArgs
  if (!located.installed || !located.path || !versionArgs || manifest.launch?.command === 'npx') return located
  const version = await runVersion(located.path, versionArgs)
  if (!version) return located
  const minVersion = manifest.detect?.minVersion
  const below = minVersion ? compareAcpAgentVersions(version, minVersion) : undefined
  return {
    ...located,
    version,
    ...(below !== undefined && below < 0 ? { belowMin: true } : {}),
  }
}
