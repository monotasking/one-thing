/**
 * 「Obsidian 此刻是什么状态」—— **一只纯函数 + 一层薄包装**(P4)。
 *
 * 判据分两半,分开的理由是可测:
 *  · `judgeObsidianState` 只做判断(两个读数进,一个码出),四条分支各有一个用例;
 *  · `resolveObsidianState` 负责去拿那两个读数 —— 读一次名册(一次文件读)、
 *    试连一次 socket。**两样都不是 CLI 命令**,所以这条路不会把 Obsidian 拉起来。
 *
 * ## 四态的顺序不是随便排的
 *
 * | 读数 | 码 | 为什么排在这里 |
 * | --- | --- | --- |
 * | `obsidian.json` 一条候选路都没读到 | `not-installed` | 名册是 Obsidian 自己写的。它不在 = 这台机器上没装过。**先问它**,因为后面两个读数在没装的机器上都答 `false`,而「没装」与「装了但没开」是两句完全不同的话 |
 * | 名册里 `cli !== true` | `cli-not-registered` | 命令行通道是 Obsidian 设置里的一格开关,名册里就记着。**它必须排在探活前面**:通道没开时那只 socket 根本不存在,探活答 `false`,照那个答案说下去就成了「Obsidian 没有运行」—— 一句会把人支去开 app 的假话,而人要做的是去设置里开那格开关 |
 * | 探活答 `null` | `cli-not-registered` | 这个平台上没有探活手段(今天的 win32)。**不确定不许当活着**;屏上那句「去设置里看一眼」是这一档能给的最有用的话 |
 * | 探活答 `false` / `true` | `not-running` / `running` | — |
 *
 * 第二行是本单对派工单那张判法表的**一处增补**,理由就写在上面那一格里:
 * 少了它,`cli-not-registered` 在 macOS 上永远到不了(darwin 的探针不答 `null`),
 * 那一句文案就成了一句永远印不出来的话。
 */

import type { NoteSystemState } from '../types.js'
import type { ObsidianCli } from './cli.js'
import type { ObsidianRegistry, ObsidianRegistrySnapshot } from './registry.js'

/** 两个读数 → 一个码。纯函数。 */
export function judgeObsidianState(
  snapshot: Pick<ObsidianRegistrySnapshot, 'sourcePath' | 'cliRegistered'>,
  alive: boolean | null,
): NoteSystemState {
  if (snapshot.sourcePath === null) return 'not-installed'
  if (!snapshot.cliRegistered) return 'cli-not-registered'
  if (alive === null) return 'cli-not-registered'
  return alive ? 'running' : 'not-running'
}

/**
 * 去拿那两个读数再判。**一条 CLI 命令都不发**(见文件头)。
 *
 * 名册读不到时连探活都不发:一台没装 Obsidian 的机器上没有任何理由去连那只
 * socket。
 */
export async function resolveObsidianState(
  registry: ObsidianRegistry,
  cli: Pick<ObsidianCli, 'isAlive'>,
): Promise<NoteSystemState> {
  const snapshot = await registry.read()
  if (snapshot.sourcePath === null) return 'not-installed'
  if (!snapshot.cliRegistered) return 'cli-not-registered'
  return judgeObsidianState(snapshot, await cli.isAlive())
}
