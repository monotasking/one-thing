/**
 * 文件名检索能力(按名扫,不看内容 —— 文件内容源是 S8,§13)。
 *
 * 设计:docs/design/search-index-2026-09.md §4.2 第二行 / §10 S2 行。
 */

import type {
  CapabilityManifest,
  FacetFilter,
  PreviewPayload,
  SearchCapability,
} from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { createOnethingSearchRuntimeAdapters } from '../providers.js'
import { legacyScanCapability } from './legacy.js'
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

export const filesSearchManifest: CapabilityManifest = {
  id: 'files',
  labelKey: 'search.capability.files',
  icon: 'FolderTree',
  kind: 'scan',
  // 扫描型唯一认的一格。声明它 = `fanout` 的 `narrowToDeclaredFacets` 才会把
  // 这个键递到这一路上(别的键与它无关,一格都收不到)。
  facets: [{ key: DIR_FACET, type: 'enum' }],
  // 扫描型这一期不设超时(`0` = core `deriveSignal` 只在 `timeoutMs > 0` 时才装计时器):
  // 旧扫描路一道刹车也没有,钉一个真预算会让慢盘 / 大店从「出结果」变成「没搜成」——
  // S2 的判据是行为零变化,不许多一道刹车。S3 换成索引型之后再钉真预算。
  budget: { default: 10, timeoutMs: 0 },
  order: 4,
  orderWhenIntent: { actions: 5 },
  relax: false,
  // **lazy**,而且答的只是一条路径(见下面 `filePreview`)。标 lazy 不是因为算得贵,
  // 是因为**壳选中了才该去开查看器的 peek 态** —— 随候选带一条路径等于让列表上
  // 十条命中各声明一次「请预备打开我」。
  preview: { mode: 'lazy' },
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
  const legacy = createOnethingSearchRuntimeAdapters(adapters)
  const scan = legacyScanCapability({
    manifest: filesSearchManifest,
    run: (query, limit, filters) => legacy.searchFiles(query, limit, scanDirOf(filters)),
    // 空词旧路答 `[]`;恒真是为了让 `all` 档的分组里有这一格(同 messages)。
    supports: () => true,
    target: result => ({ kind: 'file', payload: { filePath: result.filePath ?? '' } } satisfies FileTarget),
  })
  return { ...scan, preview: async candidates => filePreview(candidates) }
}
