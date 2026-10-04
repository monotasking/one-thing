/**
 * 工具副作用的**共用立面**。
 *
 * 这里住的东西原本长在 `builtin/bash.ts` 的 `analyze()` 里(以及 write/edit 各自
 * 抄了一份的 `filePermissionPattern`)。搬出来的理由只有一条:**同一个动作,谁跑
 * 都该长一个样**。
 *
 * 本地会话跑 `rm -rf ./dist` 时,审批卡的标题是那条命令、grant 的粒度是 `rm *`;
 * 外部 agent(Claude Code SDK)跑同一条命令时,此前只能拿到工具名 `Bash` —— 一次
 * 「总是允许 Bash」之后,任何命令都免审(`docs/audit/claude-code-sdk-audit-2026-08-11.md`
 * P0-4)。要让两侧长一样,唯一诚实的做法是让两侧调**同一个函数**;各写一份命令
 * 分析就是两套判据,迟早分家。
 *
 * 所以这个模块只做一件事:把「命令 / 路径 + 沙箱语境」翻成 `ToolEffect[]`。它不
 * 认识工具注册表、不认识 SDK、不读盘 —— 谁拿到 effects 谁去过 `enforcePermissionPolicy`。
 */

import { joinPaths, dirnamePath, isAbsolutePath, resolvePath } from '@onething/backend/storage/storage-primitives'
import type { ToolEffect, ToolPreview } from '@onething/backend/tool/tool-helpers'
import { classifyBashCommand, splitShellWords } from './bash-classifier.js'
import { expandCorePath, isCorePathContained } from './tool-sandbox.js'

/**
 * 文件类 effect 的资源粒度是**所在目录**,不是那一个文件 —— 一次「总是允许」
 * 覆盖的是这个目录下的写,而不是「以后随便写哪个文件」。write / edit 各自抄过
 * 一份,现在只有这一份。
 */
export function filePermissionPattern(targetPath: string): string {
  return joinPaths(dirnamePath(targetPath), '*')
}

const COMMAND_SEPARATORS = new Set(['&&', '||', ';', '|', '&'])

function resolveCommandDirectory(input: string, baseDir: string): string {
  const expanded = expandCorePath(input)
  return isAbsolutePath(expanded) ? resolvePath(expanded) : resolvePath(baseDir, expanded)
}

/** 命令里每一次 `cd` 的落点(逐次推进游标,`cd a && cd b` 的 b 是相对 a 的)。 */
export function extractCdDirectories(command: string, initialWorkingDir: string): string[] {
  const words = splitShellWords(command)
  const dirs: string[] = []
  let cursor = initialWorkingDir

  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'cd') continue
    const target = words[i + 1]
    if (!target || target.startsWith('-') || COMMAND_SEPARATORS.has(target)) continue
    const resolved = resolveCommandDirectory(target, cursor)
    dirs.push(resolved)
    cursor = resolved
  }

  return Array.from(new Set(dirs))
}

export interface BashPermissionAnalysisInput {
  command: string
  /** 这条命令实际跑在哪:本地 = 沙箱边界,外部 agent = 那次 SDK 会话的 cwd。 */
  workingDirectory: string
  /** 允许的根列表;`workingDirectory` 或 `cd` 落点不在其中即越界。 */
  sandboxRoots: string[]
}

function findSandboxRoot(sandboxRoots: string[], targetPath: string): string | undefined {
  return sandboxRoots.find(root => isCorePathContained(root, targetPath))
}

/**
 * 一条 shell 命令的副作用面。**命令级**:effect 的 resources 是分类器给出的命令
 * 模式(`rm *`、`git commit *`),不是「Bash」这个工具名。
 *
 * 分类是 allow 且不越界时返回**空 effects** —— 空 effects 在策略门那边等于直接
 * 放行(`permission/permission-policy.ts:171`)。这正是本地 `ls` 不弹卡的
 * 原因,外部 agent 接上同一套之后也一样:白名单命令不再骗用户去点「总是允许
 * Bash」,这是收紧信任面的前提而不是它的破口。
 */
export function analyzeBashPermission(
  input: BashPermissionAnalysisInput,
): { effects: ToolEffect[]; preview: ToolPreview } {
  const { command, workingDirectory, sandboxRoots } = input
  const matchedRoot = findSandboxRoot(sandboxRoots, workingDirectory)
  const permissionRoot = matchedRoot ?? workingDirectory
  const commandClassification = classifyBashCommand(command)
  const cdDirectories = extractCdDirectories(command, workingDirectory)
  const externalCdDirectories = cdDirectories.filter(dir => !findSandboxRoot(sandboxRoots, dir))
  const effects: ToolEffect[] = []

  if (!matchedRoot) {
    effects.push({
      kind: 'external_directory',
      resources: [workingDirectory, joinPaths(workingDirectory, '*')],
      barrier: true,
      external: true,
      metadata: {
        command,
        directory: workingDirectory,
        boundary: workingDirectory,
      },
    })
  }

  if (externalCdDirectories.length > 0) {
    effects.push({
      kind: 'external_directory',
      resources: externalCdDirectories.flatMap(dir => [dir, joinPaths(dir, '*')]),
      barrier: true,
      external: true,
      metadata: {
        command,
        directories: externalCdDirectories,
        boundary: workingDirectory,
        reason: 'Command changes directory outside the current work directory list',
      },
    })
  }

  if (commandClassification.decision === 'deny') {
    effects.push({
      kind: 'bash',
      resources: commandClassification.patterns.length > 0 ? commandClassification.patterns : ['*'],
      barrier: true,
      metadata: {
        command,
        patterns: commandClassification.patterns,
        reason: commandClassification.reason,
        commands: commandClassification.commands,
        hardDeny: true,
      },
    })
  } else if (commandClassification.decision === 'ask') {
    const patterns = commandClassification.patterns.length > 0
      ? commandClassification.patterns
      : ['*']
    effects.push({
      kind: 'bash',
      resources: patterns,
      barrier: true,
      metadata: {
        command,
        patterns,
        reason: commandClassification.reason,
        commands: commandClassification.commands,
        workingDirectory: permissionRoot,
      },
    })
  }

  return {
    effects,
    preview: {
      title: command,
      metadata: {
        command,
        workingDirectory,
        classification: commandClassification.decision,
        reason: commandClassification.reason,
      },
    },
  }
}
