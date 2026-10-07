/**
 * 插件命令声明的 `exec` 由**后端进程自己**起子进程(第④步批 4,`docs/design/two-process-2026-10.md` §2.5)。
 *
 * 从前这一件是宿主端口的一格,由 Electron 主进程注入(`execa` 被当成「宿主的依赖」,不想拖进
 * `dist/server/main.js` 那个单文件包)。拆进程之后插件管理器住在后端进程里,后端进程就是那个包,
 * 所以执行器也住在这里:`backend-launcher.ts` 在桌面档 / CLI 档把它填进宿主表的 `plugins` 一格。
 *
 * PATH 是这台后端进程的:桌面档在装配前补过登录 shell 的 PATH(`process-env`),CLI 档继承拉起它的终端 ——
 * 两种都比从前 Electron 主进程那一份更接近用户在终端里看到的。`reject: false`:命令失败也照实交回三格
 * (stdout / stderr / 退出码),不抛。
 *
 * `execa` 动态 import:import 本模块不做事(「import 不做事」那条纪律),第一次真执行时才加载。
 */
import type { PluginCommandExecResult } from './plugin-host-ports.js'

/** 一次插件命令的子进程执行。 */
export async function execPluginCommandInBackendProcess(
  command: string,
  args: string[] = [],
  options: { cwd?: string } = {},
): Promise<PluginCommandExecResult> {
  const { execa } = await import('execa')
  try {
    const result = await execa(command, args, {
      cwd: options.cwd,
      reject: false,
    })
    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? ''),
      stderr: typeof result.stderr === 'string' ? result.stderr : String(result.stderr ?? ''),
      exitCode: result.exitCode ?? (result.failed ? 1 : 0),
    }
  } catch (error) {
    const failed = error as { stdout?: unknown; stderr?: unknown; message?: string; exitCode?: number }
    return {
      stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
      stderr: typeof failed.stderr === 'string' && failed.stderr ? failed.stderr : failed.message ?? '',
      exitCode: typeof failed.exitCode === 'number' ? failed.exitCode : 1,
    }
  }
}
