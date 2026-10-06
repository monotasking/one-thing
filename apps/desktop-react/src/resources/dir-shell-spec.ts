import type { SerializedResourceSpec } from '@shared/ipc/resources'
import { canRunClientActions, revealLocalPath } from '../platform/host'

/**
 * **`dir:` 里住在客户端的那一条做法:`reveal`(在访达中显示)**(第④步批 1,决策 D275)。
 *
 * `dir:` 这个命名空间的自述与实现都在 core(`packages/backend/file/file-resource-spec.ts` /
 * `resource/resource-dir-provider.ts`):列目录、stat、建目录、改名、删除都在后端跑。只有「在文件管理器里
 * 定位」这一下只在用户的屏幕上发生 —— 所以 core 的自述里 `reveal` 是 `home: 'shell'`,core 照旧 plan
 * (夹读根、查路径在不在、过授权、落审计),执行经 shell dispatch 发给**认领了这条做法**的那扇壳。
 *
 * 这只文件就是认领的那一半:一份**只含这一条做法**的自述(后端据它判「你认领的是 core 自述里
 * `home: 'shell'` 的那几条,不是在抢命名空间」),与它的落点。
 *
 * ── 落点拿的是 core 夹过的路径 ──────────────────────────────────────────
 * 命令载荷里的 `planned` 是 core 那份 plan 的结果(`{ op: 'reveal', path }`,决策 D274):那条路径已经过了
 * 读根那把尺子。落点**只认它**,不自己从 `ref` 里再解一遍 —— 两处解析迟早有一处与尺子说的不是同一条路径。
 *
 * ── 浏览器壳不认领 ────────────────────────────────────────────────────────
 * 没有 preload 的客户端(浏览器壳)没有文件管理器可言;它若认领,AI 的「在访达中显示」会发给一扇做不了的
 * 壳。所以 `available()` 答 `false` 时 `shell-host.ts` 不交这份自述,AI 那一侧当场拿到
 * `ResourceHomeUnavailableError`(没有客户端在线),不是一次超时。
 */

export const DIR_SCHEME = 'dir'

/** 每次现造一份(续命指纹按字面判,同 `workbenchResourceSpec` 的理由)。 */
export function dirShellResourceSpec(): SerializedResourceSpec {
  return {
    scheme: DIR_SCHEME,
    title: 'Directories (the part that runs in this client)',
    reads: {},
    ops: {
      reveal: {
        title: 'Show this path in the file manager',
        params: { type: 'object', properties: {}, required: [] },
        effects: [],
        home: 'shell',
        entity: 'path',
      },
    },
    events: {},
  }
}

/** 这扇壳交不交这份自述。判据与 `platform/host.ts` 的 `canRunClientActions()` 是同一句。 */
export function dirShellAvailable(): boolean {
  return canRunClientActions()
}

/** 落点。只有 `reveal`;别的做法名是一次编程错误(core 不会发)。 */
export async function runDirShellOp(op: string, planned: unknown): Promise<string> {
  if (op !== 'reveal') throw new Error(`dir: this client only runs reveal, not ${JSON.stringify(op)}`)
  const target = (planned as { path?: unknown } | null)?.path
  if (typeof target !== 'string' || !target) throw new Error('dir: reveal needs the path the core planned')
  const outcome = await revealLocalPath(target)
  if (!outcome.ok) throw new Error(outcome.reason === 'failed' ? outcome.error : 'this client cannot reveal files')
  return `Showed ${target} in the file manager`
}
