/**
 * 文件名检索能力(按名扫,不看内容 —— 文件内容源是 S8,§13)。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 第二行。
 *
 * S5(2026-09-05)把匹配器与那张**搜索根列表**从 `providers.ts` 搬进来:
 * 「这一档搜哪几个目录」是这一类自己的语义,别的能力一个都不问它。
 */

import * as path from 'node:path'
import type {
  CapabilityManifest,
  FacetFilter,
  PreviewPayload,
  SearchCapability,
  SearchContext,
} from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { scanBackedCapability, type ScanRunOutcome, type SearchServiceResult } from './scan-adapter.js'
import { expandPath, matchRangesOf, normalizeSearchQuery } from './text-match.js'
import {
  firstCandidate,
  requireStringField,
  targetPayloadOf,
  type FileExcerptPreview,
} from './preview.js'

/** 这一类的目标形。 */
export interface FileTarget {
  kind: 'file'
  payload: { filePath: string }
}

/**
 * **扫描根**那一格过滤片(S4b)。
 *
 * 语义:「只扫这一个目录」。缺席 = 后端自己那张根列表(`getSearchDirs()`:当前
 * 会话的工作目录 + 两个笔记根 + 接入目录)。
 *
 * 它存在的理由是一件**旧行为**:S4b 之前文件那一档搜的是**壳**的
 * `useSessionCwd()` —— 渲染层那条活跃会话的工作目录。改读后端之后根变成了
 * `getSearchDirs()`,而它认的是**后端** `getCurrentSessionId()` 的工作目录,
 * 而 React 壳从不告诉后端当前会话是谁 —— 于是会话目录下的文件搜不到了。
 * 把根做成一格 facet、由壳结构地递进来,旧行为就回来了,而且不必写
 * `app-state.json`(那是一次会持久化的行为改动,按判例得先问用户)。
 *
 * **谁递得进来**:`search.query` 的本机可信那一支(`isHostLocallyTrusted()`,
 * 见 `backend/rpc/domains/search.ts`)。不可信的那一支根本走不到这个能力 ——
 * 它问的是 server 侧那个 per-owner 沙箱端口。所以这里不再自建一道信任判据:
 * 判据只该有一个产地。
 */
const DIR_FACET = 'dir'

/**
 * 这一档默认搜哪几个根:当前会话的工作目录 + 两个笔记根 + 接入目录,去重后按序。
 *
 * 去重是 `add` 自带的,所以某个根与会话工作目录重合时不会搜两遍。
 *
 * ── **它不是授权用的那张表**(09-07 事故第一条修)────────────────────────
 * S4b 之后有一阵子这张表被换成了 `access.fileRoots` —— 那是**授权**用的全集
 * (每一条可见会话的 workingDirectory + 笔记目录 + 接入目录)。真机上 492 条会话
 * 于是变成 31 个扫描根,其中一个是 18GB 带 16 个 node_modules 的目录,一次搜索
 * 起 31 条 `rg`,三条永不回来。**两张表回答的是两个问题**:
 *  · 「这一档去哪几个目录扫」= 这里这一张(当前语境),
 *  · 「这条路径准不准看」= `assertPath(fileRoots)`(全集)。
 * 用全集回答第一个问题,就是把一次检索变成一次全盘遍历。
 */
function getSearchDirs(adapters: OnethingSearchProvidersAdapters): string[] {
  const seen = new Set<string>()
  const dirs: string[] = []

  function add(p: string | undefined | null): void {
    if (!p) return
    const expanded = expandPath(p)
    if (!seen.has(expanded)) {
      seen.add(expanded)
      dirs.push(expanded)
    }
  }

  const sid = adapters.getCurrentSessionId()
  if (sid) add(adapters.getSession(sid)?.workingDirectory)

  // 笔记根 = 在册的笔记库的根(P3;从前是 `user_note_dir` / `work_note_dir` 两个
  // 变量)。端口缺席 = 这台宿主没有笔记领域,与「有库但一个都没启用」同样是空表。
  for (const vault of adapters.getNoteVaults?.() ?? []) add(vault.root)

  for (const dir of adapters.getConnectedDirectories?.() ?? []) add(dir)

  return dirs
}

/**
 * 按名扫盘。
 *
 * 第四格 `dir` 给了就**只扫那一个目录**,缺席就是 `getSearchDirs()` 那张根列表。
 * **不与根列表求交**:调用方递这一格进来正是因为那张列表答不出它要的根(见上面
 * `DIR_FACET` 的说明),求交等于把这一格变成一句空话。
 */
export async function searchFiles(
  query: string,
  limit: number,
  adapters: OnethingSearchProvidersAdapters,
  dir?: string,
  context?: SearchContext,
): Promise<ScanRunOutcome> {
  const dirs = dir ? [expandPath(dir)] : getSearchDirs(adapters)
  if (dirs.length === 0) return { items: [] }

  const q = normalizeSearchQuery(query)
  if (!q) return { items: [] }
  const results: SearchServiceResult[] = []
  /**
   * 上游那条(`fanout` 用 `budget.timeoutMs` 派生的)信号。它到了就是
   * 「时间到 / 换词了」—— **交已经扫到的那些并标 partial**,不抛、不作废。
   */
  const signal = context?.signal
  const aborted = (): boolean => signal?.aborted === true

  for (const cwd of dirs) {
    if (results.length >= limit || aborted()) break
    try {
      for await (const relPath of adapters.listFiles({
        cwd,
        hidden: false,
        // **不再 `--no-ignore`**(09-07 事故第三条修):尊重 `.gitignore` 是最便宜
        // 的那条边界 —— 用户仓库里 node_modules / build 产物本来就不该出现在
        // 「按名找文件」的结果里,而它们正是让一次扫描从毫秒变成分钟的东西。
        noIgnore: false,
        ...(signal === undefined ? {} : { signal }),
      })) {
        // 拿够了就 break —— 而 `break` 现在会把那条 rg 杀掉(见 `listOnethingRipgrepFiles`)。
        if (results.length >= limit || aborted()) break
        // 相对路径整条参与匹配(文件名与目录名都算命中)。
        if (!relPath.toLowerCase().includes(q)) continue

        const absPath = path.join(cwd, relPath)
        const dirLabel = path.basename(cwd)
        results.push({
          id: `file:${absPath}`,
          type: 'file',
          title: path.basename(relPath),
          subtitle: `${dirLabel}/${relPath}`,
          detail: cwd,
          filePath: absPath,
          matchRanges: matchRangesOf(path.basename(relPath), q),
        })
      }
    } catch {
      // 目录可以不存在。
    }
  }
  // 被打断 = 这一趟没走完。**只在真被打断时说** —— 拿够了 `limit` 是走完了一页,
  // 不是没扫完(那由 `cursor` 说)。
  return aborted() ? { items: results, partial: true } : { items: results }
}

export const filesSearchManifest: CapabilityManifest = {
  id: 'files',
  labelKey: 'search.capability.files',
  icon: 'FolderTree',
  kind: 'scan',
  // 扫描型唯一认的一格。声明它 = `fanout` 的 `narrowToDeclaredFacets` 才会把
  // 这个键递到这一路上(别的键与它无关,一格都收不到)。
  facets: [{ key: DIR_FACET, type: 'enum' }],
  /*
   * **3 秒**(09-07 事故第二/三条修)。
   *
   * 从前这里是 `0`(= 不装计时器),理由写着「钉一个预算会让慢盘从『出结果』变成
   * 『没搜成』」。那句话在当时是对的,但它假设的是「超时 = 整组作废」——真机上
   * 换来的是更坏的东西:一次扫描永不落地,而「不挑」那一档要收齐所有组才答,于是
   * **整发搜索一个结果都不出**,两条 rg 挂在 462% CPU 上。
   *
   * 现在超时有第三种结局:`searchFiles` 交已经扫到的那些并标 `partial`,`fanout`
   * 据此判成「答过了,没答完」而不是错误(见 `core/search/pipeline/fanout.ts`)。
   * 于是钉预算不再等于把慢盘判死 —— 它只是把「等多久」变成一个说得出口的数。
   */
  budget: { default: 10, timeoutMs: 3000 },
  order: 4,
  orderWhenIntent: { actions: 5 },
  relax: false,
  /*
   * **inline**(检索面终稿 §4;S4b 起是 `lazy`)。
   *
   * 从前标 lazy 的理由是「壳选中了才该去开查看器的 peek 态」。真机上它换来的是
   * 相反的东西:每停一行就发一次 `search.preview` 往返,而那一趟回来的**只有一条
   * 路径** —— 那条路径在候选身上一直就有(`filePath`)。一次往返换零新信息,
   * 而「什么时候开 peek」本来就是壳自己的节流,不该拿一次 RPC 去表达。
   *
   * 后端仍然一个字节都不读(见下面 `filePreview` 的整段理由)。
   */
  preview: { mode: 'inline' },
}

/**
 * 文件类的预览:**后端只给路径**(§4.5 ②那张表最后一行 +「文件类的预览一律复用
 * 查看器注册表」)。
 *
 * 这里刻意**不读一个字节**。理由不是省事:
 *  - 查看器已经按文件类型分发到文本 / 代码 / 图片 / 媒体 / PDF,后端再读一份正文
 *    就是在查看器旁边立第二个「这个文件长什么样」的产地,两个产地必然分叉;
 *  - 对图片 / 视频 / PDF 这些,「读正文」根本是错的动作(把字节搬过 RPC);
 *  - 零副作用(§4.5 ④)顺带兑现:不读就不可能碰 mtime,也不用去论证「读会不会
 *    改什么」。
 * 查看器不认识的类型由**查看器自己**诚实地画「不支持预览 · 在外部打开」——
 * 那句话的产地也只有一个。
 */
function filePreview(candidates: Parameters<NonNullable<SearchCapability['preview']>>[0]): PreviewPayload {
  const candidate = firstCandidate(candidates)
  const payload = targetPayloadOf(candidate, 'file')
  const path = requireStringField(payload, 'filePath', '这条文件命中')
  const excerpt: FileExcerptPreview = { path }
  return { kind: 'file-excerpt', payload: excerpt, title: candidate.title }
}

/**
 * 这一次要扫哪个目录。
 *
 * `FacetFilter` 有四种形(标量 / 数组 / 区间 / 排除),而「扫描根」只有**一个
 * 目录**说得通 —— 一次 `listFiles` 只吃一个 cwd。所以这里只收字符串标量,
 * 别的形一律当缺席(退回后端自己的根列表),不去发明「多根扫描」这种没人递过
 * 的语义。
 */
function scanDirOf(filters: Readonly<Record<string, FacetFilter>>): string | undefined {
  const value = filters[DIR_FACET]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function createFilesSearchCapability(
  adapters: OnethingSearchProvidersAdapters,
): SearchCapability {
  const scan = scanBackedCapability({
    manifest: filesSearchManifest,
    run: (query, limit, filters, context) => searchFiles(query, limit, adapters, scanDirOf(filters), context),
    // 空词这一路答 `[]`;恒真是为了让 `all` 档的分组里有这一格。
    supports: () => true,
    target: result => ({ kind: 'file', payload: { filePath: result.filePath ?? '' } } satisfies FileTarget),
    // 随候选带的那条路径 —— 与下面 `filePreview` 是**同一个投影**,不是第二份。
    preview: result => ({
      kind: 'file-excerpt',
      payload: { path: result.filePath ?? '' } satisfies FileExcerptPreview,
      title: result.title,
    }),
  })
  return { ...scan, preview: async candidates => filePreview(candidates) }
}
