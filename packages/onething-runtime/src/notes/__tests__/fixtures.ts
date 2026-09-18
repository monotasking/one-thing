/**
 * Obsidian CLI 的**真实 stdout 夹具**(2026-09-18 在本机 1.13.7 上抓的原文)。
 *
 * 为什么是原文而不是手编的字符串:这一层的全部难点就是「这个 CLI 说话的样子」
 * —— 退出码恒 0、错误在首行、`eval` 带 `=> ` 前缀、`Vault not found.` 不带
 * `Error:`。手编的夹具会跟着实现一起错。
 */

import type {
  NoteLivenessProbe,
  NoteProcessHandle,
  NoteProcessResult,
  NoteProcessRunOptions,
  NoteProcessRunner,
} from '../types.js'

export const CLI_FIXTURES = {
  vaultNotFound: 'Vault not found.\n',
  fileNotFound: 'Error: File "nope/nope.md" not found.\n',
  folderNotFound: 'Error: Folder "daily" not found.\n',
  vaultConfig: '=> {"attachmentFolderPath":"attatch","useMarkdownLinks":false,"newLinkFormat":"shortest"}\n',
  dailyOptions: '=> {"format":"YYYY-MM-DD-dddd","folder":"daily"}\n',
  attachmentPath: '=> "attatch/shot.png"\n',
  markdownLink: '=> [[00.00 JDex]]\n',
  dailyPath: '2026-09-08.md\n',
  searchContext: '[{"file":"notes/a.md","matches":[{"line":3,"text":"hello there"}]}]\n',
} as const

export interface FakeRunnerCall {
  command: string
  args: string[]
  timeoutMs?: number
}

export interface FakeRunner extends NoteProcessRunner {
  /** 每一次 `run` / `spawn` 的实参。**「一次 spawn 都没发生」全靠数它。** */
  readonly calls: FakeRunnerCall[]
  readonly kills: number
}

export interface FakeRunnerOptions {
  /** 按调用顺序回放;用完之后重复最后一条。 */
  outputs?: string[]
  /** 回放一条「超时」(handle 被 kill,done 拒绝)。 */
  timeoutOnCall?: number
}

export function createFakeRunner(options: FakeRunnerOptions = {}): FakeRunner {
  const calls: FakeRunnerCall[] = []
  let kills = 0
  const outputs = options.outputs ?? ['']

  const spawn = (runOptions: NoteProcessRunOptions): NoteProcessHandle => {
    const index = calls.length
    calls.push({ command: runOptions.command, args: [...runOptions.args], timeoutMs: runOptions.timeoutMs })
    const kill = (): void => { kills += 1 }
    if (options.timeoutOnCall === index) {
      kill()
      return {
        done: Promise.reject(new Error(`[notes] "${runOptions.command}" did not finish within ${runOptions.timeoutMs ?? 0}ms; the child was killed`)),
        kill,
      }
    }
    const stdout = outputs[Math.min(index, outputs.length - 1)]
    const result: NoteProcessResult = { code: 0, stdout, stderr: '' }
    return { done: Promise.resolve(result), kill }
  }

  return {
    run: runOptions => spawn(runOptions).done,
    spawn,
    get calls() { return calls },
    get kills() { return kills },
  }
}

export function createProbe(alive: boolean | null): NoteLivenessProbe {
  return { isAlive: async () => alive }
}
