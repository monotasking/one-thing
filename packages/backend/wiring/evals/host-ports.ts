/**
 * evals 的**宿主注入端口** —— 结构债 P4c 第十批。
 *
 * evals / evals-workbench 两域的二十五条数据面从手写 IPC 迁到通用 RPC 通道之后,
 * 处理者整只落在装配层。它们身上唯一一处 electron 触点是 `app.isPackaged`:
 * 「evals 仓在哪」这件事在开发态等于 `process.cwd()`(app 就是从仓库 checkout
 * 里跑起来的),打包态则没有任何有意义的 cwd,必须由用户在设置里显式配。
 *
 * 判据同 `configureShellHost` / `configureSkillsEnvironmentHost`:
 *  - **判定本身在域里**(下面的 `resolveEvalsRepoDir`),不在宿主里;
 *  - 宿主只回答它独有的那一位事实(`isPackaged`),桌面在 `main-process.ts` 注入;
 *  - **未注入 = 视为非打包**,于是 server / CLI / 测试拿到的是 `process.cwd()` ——
 *    与迁移前 `!app.isPackaged` 那条分支逐字同义(那两个宿主从来就没有 evals 面,
 *    这条兜底只在测试里被走到)。
 *
 * `repoDir` 也可注入,是给测试与将来别的宿主留的显式覆盖口:注入之后连设置都不读,
 * 直接以它为准。桌面不注入这一格。
 */
import { getSettings } from '../../stores/settings.js'

export interface EvalsHostPorts {
  /** 宿主是否处于打包态。未注入 = 视为非打包(开发态)。 */
  isPackaged?: () => boolean
  /**
   * 完全接管「evals 仓在哪」的判定。注入之后设置与 `isPackaged` 都不再参与 ——
   * 给测试和非 Electron 宿主留的显式口,桌面不用。
   */
  repoDir?: () => string | null
}

let ports: EvalsHostPorts = {}

export function configureEvalsHost(next: EvalsHostPorts): void {
  ports = next ?? {}
}

/**
 * 还原到**未注入**态(C0 R6)。`applyHostPorts` 的还原函数逆序调它,于是
 * `backend.dispose()` 之后这个进程回到"没有宿主声明过这件能力"。
 */
export function resetEvalsHost(): void {
  ports = {}
}

/** 当前注入的端口(诊断/测试用)。 */
export function getEvalsHostPorts(): EvalsHostPorts {
  return ports
}

interface EvalsSettingsShape {
  repoDir?: string
}

function getEvalsSettings(): EvalsSettingsShape {
  const settings = getSettings()
  return (settings as { evals?: EvalsSettingsShape })?.evals ?? {}
}

/**
 * evals 仓根目录,或 null。
 *
 * 顺序逐字沿用迁移前 `@main/ipc/evals.ts` 的 `getRepoDir()`:
 * 显式设置 → 开发态 `process.cwd()` → null。
 */
export function resolveEvalsRepoDir(): string | null {
  const injected = ports.repoDir?.()
  if (injected !== undefined) return injected
  const settings = getEvalsSettings()
  if (settings.repoDir) return settings.repoDir
  // In development the app runs from the repo checkout, so cwd is the repo
  // root. A packaged app has no meaningful cwd — require explicit config.
  if (!(ports.isPackaged?.() ?? false)) {
    return process.cwd()
  }
  return null
}
