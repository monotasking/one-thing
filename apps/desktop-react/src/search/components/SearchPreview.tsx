import { useEffect, useMemo } from 'react'
import type { SearchItemRef, SearchPreviewPayload } from '@shared/ipc/search'
import { Highlight } from '../../expose/components/Highlight'
import { useDelayedFlag } from '../../components/useDelayedFlag'
import { SKELETON_DELAY_MS } from '../../components/motion'
import { useT } from '../../i18n'
import { getLogger } from '../../services/log'
import { ensureSearchPreview, useSearchPreview } from '../../data/search-catalog-source'
import type { SearchPreviewMode } from '../../data/search-catalog-source'
import { resolvePreviewRenderer } from '../preview'
import { originText } from '../transitions'
import type { SearchRow } from '../types'
import s from './SearchPanel.module.css'

/** 后端的原话只进日志(09-05 裁定:预览栏不露内部串)。 */
const log = getLogger('search.preview')

/**
 * **预览窗**(设计 `docs/design/search-index-2026-09.md` §4.5)。
 *
 * 它只做四件事,一件都不多:
 *  1. 决定这一次的预览**从哪来** —— inline(随候选带,零请求)还是 lazy(走
 *     `search.preview`);
 *  2. 把窗的**五种状态**画对(empty / loading / ready / error / 缺渲染器);
 *  3. 按载荷的 `kind` 从**预览渲染注册表**取组件;
 *  4. 缺渲染器时画「Row 放大版」(§4.5 ④原话)。
 *
 * **它不认识任何一种预览媒介**,也不认识任何一个能力 id。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(状态先行,09-01 用户令)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── 一、生命周期 ─────────────────────────────────────────────────────────
 * | 时机 | 这里发生什么 |
 * | --- | --- |
 * | 挂载 | 选中什么都没有时**一发请求都不出门**(items 空 → 订空串那一格) |
 * | 换选中(↑↓) | 换一格 key。上一格那一发跑完落在它自己那格上,**上不了屏** —— 「abort」在这一层是这个意思,代价与真 abort 的差别记在 `data/search-catalog-source.ts` 的 `SearchPreviewAnswer` 上 |
 * | 换宿主(舞台 / 浮窗 / 架子) | 不重挂(它是面板的子树,宿主换的是面板);窄档下它换成「行下展开」那一形,由 CSS 容器查询决定,不是两棵树 |
 * | 卸载 | 格留着 = 缓存;整族退役归 `resetSearchCatalog()` 与 HMR dispose |
 *
 * ── 二、UI 生命状态 ──────────────────────────────────────────────────────
 * | 状态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | empty | 一条都没选中 | 一句「选一条看看」,不画框 |
 * | loading | 还没有答案,而且**已经等了 `SKELETON_DELAY_MS`** | 骨架;那之内**什么都不换** —— 本来就是一瞬的事,闪一下骨架比等一下更烦 |
 * | ready | 有载荷 | 按 kind 取渲染器 |
 * | error | 后端答了 `error` | 一句**字典句**;原话进 `getLogger('search.preview')` + `data-preview-error`(09-05 裁定,列表不受影响) |
 * | 无预览 / 缺渲染器 | 自述没有 `preview` 那一格 / 注册表答 `undefined` | Row 放大版(标题 + 出处),**零解释句、零请求**;dev warn 一次 |
 * | 超量 | 载荷很长 / batch 很多格 | **窗自己滚**(见 .preview 的 overflow),不截断、不渐隐 —— 滚动条本来就会说「下面还有多少」 |
 *
 * ── 三、UI 交互状态 ──────────────────────────────────────────────────────
 * 预览窗**自己没有一个可交互的控件**(零副作用是硬规矩:不改已读、不进会话、
 * 不动播放队列)。rest 之外的态一个都没有,这不是漏写 —— 是这块面的定义。
 * 唯一的例外在 `file-excerpt` 里:它复用查看器的 Body,而那一份是只读 peek
 * (`onView` 是空函数、无 `onReveal`),理由写在那个文件头上。
 */

/**
 * 这一次要预览的东西。
 *
 * `inline` 在场 = 这一条的能力自述里说了 `preview: { mode: 'inline' }`,载荷已经
 * 随候选带回来了 —— **一发请求都不出门**。它只在**单选**时成立:多选要的是一份
 * 组合载荷(compare / batch),那必须问后端。
 */
export interface SearchPreviewProps {
  items: readonly SearchItemRef[]
  mode: SearchPreviewMode
  /** 单选且这一条随候选带了预览时的那一份。 */
  inline?: SearchPreviewPayload
  /** 缺渲染器时画「Row 放大版」要的那一行(单选才有)。 */
  row?: SearchRow
  /** 此刻的词(预览里标命中)。 */
  query: string
  /**
   * **这一类到底有没有预览**(自述里那格 `preview` 在不在)。
   *
   * 假 = 一发请求都不出门,窗里画**行的放大版**(标题 + 出处,零解释句)。
   * 从前 prompts / actions 这两类每停一行就白发一次请求,拿回来一句
   * 「capability prompts has no preview」画在屏幕上 —— 那是把内部话当界面。
   */
  previewable?: boolean
}

/**
 * 「这一次不必问后端」那**一个**空表(身份稳定)。
 *
 * 每次渲染现造一个 `[]` 会让下面那条副作用的依赖每帧都变 —— `ensure` 是幂等的
 * 所以不会真发请求,但那是一轮白跑,而且它会掩盖「依赖表到底该写什么」这个问题。
 */
const NO_ITEMS: readonly SearchItemRef[] = []

export function SearchPreview({
  items,
  mode,
  inline,
  row,
  query,
  previewable = true,
}: SearchPreviewProps) {
  const t = useT()
  /*
   * inline 在场时**不建格**:那一格永远没人问过,也就永远不会发请求。
   * `items` 由面板那只 memo 交下来(身份只在选中真的变了时才换),所以这只 memo
   * 的身份也跟着稳 —— 下面那条副作用因此按身份订就够了。
   */
  const lazyItems = useMemo(
    () => (inline === undefined && previewable ? items : NO_ITEMS),
    [items, inline, previewable],
  )
  const answer = useSearchPreview(lazyItems, mode)

  useEffect(() => {
    void ensureSearchPreview(lazyItems, mode)
  }, [lazyItems, mode])

  const pending = inline === undefined
    && previewable
    && answer.data === undefined
    && answer.error === undefined
  /*
   * 骨架的延迟走**库里那一件**(`useDelayedFlag` + `SKELETON_DELAY_MS`),不再自持
   * 一个 120ms 的计时器 —— 「多久算久」是一条规范,不是每处自己拍的数(落差 #20)。
   */
  const skeleton = useDelayedFlag(pending, SKELETON_DELAY_MS)

  if (items.length === 0) {
    return (
      <div className={s.preview} data-preview="empty">
        <p className={s.previewNote}>{t('search.previewEmpty')}</p>
      </div>
    )
  }

  if (pending) {
    return (
      <div className={s.preview} data-preview="loading">
        {/* 120ms 之内**什么都不画**:那一瞬的骨架是噪音,不是反馈。 */}
        {skeleton && <div className={s.previewSkeleton} aria-hidden="true" />}
      </div>
    )
  }

  const error = answer.data?.error ?? answer.error
  if (inline === undefined && previewable && error !== undefined) {
    /*
     * **只画字典句,原话进日志**(09-05 裁定,推翻 §4.5 ⑤「算不出画原话」)。
     * 用户看的是一块面,不是一条日志;而排障要的那句话一个字都没丢 ——
     * `getLogger('search.preview')` 收着,`data-preview-error` 把它留在 DOM 属性上
     * (门与排障读得到,屏幕上读不到)。
     */
    log.warn('preview could not be built', { error })
    return (
      <div className={s.preview} data-preview="error" data-preview-error={error}>
        <p className={s.previewNote}>{t('search.previewFailed')}</p>
      </div>
    )
  }

  const payload = inline ?? (previewable ? answer.data?.preview : undefined)
  if (payload === undefined) {
    /*
     * **行的放大版**:标题 + 出处,零解释句(09-05 裁定「无预览 = 最安静的形」)。
     * 拿不到那一行时才退回一句「这一类还没有预览」。
     */
    if (row !== undefined) {
      return (
        <div className={s.preview} data-preview="none">
          <p className={s.previewTitle}>
            <Highlight
              text={row.text}
              query={query}
              {...(row.highlight ? { ranges: row.highlight } : {})}
            />
          </p>
          <p className={s.previewOrigin}>{originText(row.origin)}</p>
        </div>
      )
    }
    return (
      <div className={s.preview} data-preview="empty">
        <p className={s.previewNote}>{t('search.previewNone')}</p>
      </div>
    )
  }

  const renderer = resolvePreviewRenderer(payload.kind)
  if (renderer === undefined) {
    /*
     * **Row 放大版**(§4.5 ④原话)。缺渲染器不是错误 —— 壳没跟上不许把结果吞掉
     * (§4.3 的同一条纪律)。画的就是这一行本来那三段里的两段:正文 + 出处,
     * 只是不再挤在一行里 —— **零解释句**(那句「这种预览还画不出来:<kind>」是
     * 内部话,09-05 裁定它下屏,dev 下由 `resolvePreviewRenderer` 自己 warn 一次)。
     */
    return (
      <div className={s.preview} data-preview="fallback" data-preview-kind={payload.kind}>
        <p className={s.previewTitle}>
          {payload.title ?? row?.text ?? ''}
        </p>
        {row !== undefined && (
          <p className={s.previewOrigin}>{originText(row.origin)}</p>
        )}
      </div>
    )
  }

  return (
    <div className={s.preview} data-preview="ready" data-preview-kind={payload.kind}>
      {payload.title !== undefined && payload.title.length > 0 && (
        <p className={s.previewTitle}>
          {/* 标题里也标命中 —— 会话概览那一形的标题就是命中的那个会话名。 */}
          <Highlight text={payload.title} query={query} />
        </p>
      )}
      <renderer.Body payload={payload.payload} query={query} />
    </div>
  )
}
