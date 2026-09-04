import { createQueryFamily, useQuery } from './kernel'
import type { QuerySnapshot } from './kernel'
import { filesPort } from './files-port'
import { baseNameOf, classifyFileFailure } from './files-source'
import { resolveViewerSpec, specOf, specOfPath } from './viewer-kinds'
import type { ViewerFile } from './viewer-kinds'

/**
 * **文件预览的 peek 读**(检索重建 S4b;设计 `docs/design/search-index-2026-09.md`
 * §4.5 ②「文件类的预览一律复用查看器注册表 —— 预览就是查看器的 peek 态
 * (只读、无编辑、无持久化)」)。
 *
 * 后端 `file-excerpt` 的载荷**只有一条路径**(`capabilities/files.ts` 明说「一个
 * 字节都不读」),理由是对的:图片 / 视频那几型根本不该把字节搬过来,而「这个文件
 * 长什么样」已经有一个产地 —— 查看器注册表。于是壳这一侧要做的就是这件事:
 * **把那条路径读成一份 `ViewerFile`,交给 `resolveViewer` 分发**。
 *
 * ── 与查看器那条读路的关系:同一份判据,不同的量 ──────────────────────────
 * 定型与造型走的是**同两个函数**(`resolveViewerSpec(...).build(...)`),
 * 与 `data/viewer-source.ts` 的 `read()` 逐字相同 —— 所以加一种文件型,预览自动
 * 跟上(§4.5「加一种媒介 = 查看器加一个 handler,预览自动跟上」)。
 * 不同的只有两格,而且两格都是**因为它是 peek**:
 *
 *  1. `want` 是 `PEEK_BYTES`(64KB)而不是查看器的 5MB 一段 —— 预览窗只画一屏,
 *     为它读 5MB 是白烧;
 *  2. 它**不进 `useViewerSource`** —— 预览不许改「此刻打开的是哪个文件」,
 *     那正是零副作用那条硬规矩(§4.5 ④)。所以这里是自己一族 query,
 *     与查看器那台状态机完全不相干。
 *
 * `direct` 的那几型(图 / 播放条)在**读之前**就岔开:它们靠 `src` 显示,
 * 一个字节都不读 —— 与查看器同一条判据,同一处岔口。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(状态先行,09-01 用户令)
 * ══════════════════════════════════════════════════════════════════════════
 * ── 一、生命周期 ─────────────────────────────────────────────────────────
 * | 时机 | 这里发生什么 |
 * | --- | --- |
 * | 挂载 | **什么都不发**:族的格是被问出来的(选中了一条文件命中才建) |
 * | 首载 | 那一格 `phase==='initial' && inflight`;预览窗画 loading(120ms 后才画骨架) |
 * | 换宿主 | 不存在(数据源没有落点形态) |
 * | 换空间 | 不作废(路径是绝对路径,与空间无关) |
 * | 卸载 | 格留着 = 缓存;整族退役只有 `resetFilePeek()` 与 HMR dispose 两口 |
 *
 * ── 二、UI 生命状态 ──────────────────────────────────────────────────────
 * | 状态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | empty | 路径为空 | 不建格;预览窗画「这一类还没有预览」 |
 * | loading | `phase==='initial' && inflight` | 预览窗的 loading 那一格 |
 * | ready | 有 `data` | 查看器的 Body |
 * | error | 读失败 | **不抛**:定型成 `error` 型,由查看器的诚实态自己说 |
 * | 超量 | 文件比 `PEEK_BYTES` 大 | `truncated` 为真,查看器自己画「只是开头一段」 |
 *
 * ── 三、UI 交互状态 ──────────────────────────────────────────────────────
 * 这块是数据源,自己一个控件都不画。
 */

/**
 * peek 一次读多少字节。
 *
 * 64KB 不是随手取的:预览窗高不过一屏,一屏源码撑死几千字符;而查看器那一段是
 * 5MB(它要支持「继续加载」翻完整份文件)。为 peek 读 5MB 意味着选中一条 1MB 的
 * 日志就要等一次真实的传输 —— 而用户下一步很可能只是按 ↓ 换一行。
 */
export const PEEK_BYTES = 64 * 1024

/** 键面封顶(与另外两族同一条纪律:半小时前看过的那个文件不该占着内存)。 */
const CACHE_KEYS = 12
const recent: string[] = []

function remember(path: string): void {
  const at = recent.indexOf(path)
  if (at >= 0) recent.splice(at, 1)
  recent.push(path)
  while (recent.length > CACHE_KEYS) {
    const oldest = recent.shift()
    if (oldest !== undefined) filePeekQuery.drop(oldest)
  }
}

/**
 * 读一段并定型。**读失败不抛** —— 定型成 `error` 型交出去,由查看器的诚实态
 * (类型 + 大小 + 去 Finder)自己说那句话。抛出去会让预览窗画一条通用的
 * 「预览失败」,而那比「这个文件读不到,原因是 …」少说了一半。
 */
export const filePeekQuery = createQueryFamily<ViewerFile>(
  'search.filePeek',
  async (ctx) => {
    const path = ctx.key
    const name = baseNameOf(path)
    // direct 的那几型(图 / 播放条)一个字节都不读 —— 与查看器同一处岔口。
    const spec = specOfPath(path)
    if (spec.direct) return spec.build({ path, name, content: '', size: 0, want: 0 })

    const port = await filesPort()
    await port.ready()
    const response = await port.readContent(path, PEEK_BYTES)
    if (!response.success) {
      return specOf('error').build({
        path,
        name,
        content: '',
        size: 0,
        want: PEEK_BYTES,
        failure: classifyFileFailure(response.error),
        error: response.error,
      })
    }
    const content = response.content ?? ''
    const size = response.size ?? content.length
    return resolveViewerSpec({ path, size, isBinary: response.isBinary, content }).build({
      path,
      name,
      content,
      size,
      want: PEEK_BYTES,
      ...(response.mtimeMs === undefined ? {} : { mtimeMs: response.mtimeMs }),
    })
  },
)

/** 「读一次这个文件的开头一段」。幂等(`ensure` 的语义)。 */
export function ensureFilePeek(path: string): Promise<void> {
  if (!path) return Promise.resolve()
  remember(path)
  return filePeekQuery.get(path).ensure()
}

/**
 * 读法。**建格但不发请求** —— 发不发由 `ensureFilePeek` 说了算(它长在预览窗那条
 * 副作用上)。路径为空时订空串那一格:它永远没人问过,快照恒定是出厂那一份。
 */
export function useFilePeek(path: string): QuerySnapshot<ViewerFile> {
  return useQuery(filePeekQuery.get(path))
}

/** 测试与 HMR 用:整族回到出厂,键面一并清空。 */
export function resetFilePeek(): void {
  filePeekQuery.reset()
  recent.length = 0
}

/**
 * 模块级副作用的退役口(09-01 立法)。这个模块在模块作用域里留着一族 query 与
 * 那本键面账 —— 寿命就是「这个模块实例」,热更时必须退役。退役**复用已有的
 * 那一口拆卸**,不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetFilePeek()
  })
}
