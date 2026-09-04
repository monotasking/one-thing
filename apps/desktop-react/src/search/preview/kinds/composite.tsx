import { useT } from '../../../i18n'
import { resolvePreviewRenderer } from '../registry'
import type { SearchPreviewProps, SearchPreviewRenderer } from '../registry'
import s from '../Preview.module.css'

/**
 * `kind: 'composite'` —— 多条一起看(设计
 * `docs/design/search-index-2026-09.md` §4.5 ③ 的 compare / batch 两行)。
 *
 * 后端组的形是 `{ layout: 'side-by-side' | 'grid', items: PreviewPayload[],
 * summary?: { total, shown, kinds } }`(`SearchService.comparePreview` /
 * `batchPreview`)。**这个渲染器自己不认识任何一种子 kind** —— 它把每一格再交回
 * 注册表(`resolvePreviewRenderer`),于是:
 *
 *  · 加一种预览媒介,compare / batch 自动会画它;
 *  · 缺渲染器的那一格**只塌自己那一格**(画一句「这一类还画不出来」),
 *    另外九格照旧 —— 与后端 batch「一条算不出不拖垮其余」是同一条纪律的壳侧一半。
 *
 * 递归是**有底**的:`composite` 里再嵌 `composite` 今天没有产地(服务层只在最外
 * 一层组它),真嵌了也只是多画一层网格,不会无限展开(载荷是有限的树)。
 */

interface CompositePayload {
  layout: 'side-by-side' | 'grid'
  items: Array<{ kind: string; payload: unknown; title?: string }>
  summary?: { total: number; shown: number; kinds: string[] }
}

/** 验而不信(同别的预览渲染器)。`layout` 认不得的按 grid 画 —— 那是更保守的一档。 */
export function compositePayloadOf(payload: unknown): CompositePayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const raw = payload as Partial<CompositePayload>
  if (!Array.isArray(raw.items)) return undefined
  const items = raw.items.filter(
    (item): item is { kind: string; payload: unknown; title?: string } =>
      typeof item === 'object' && item !== null && typeof (item as { kind?: unknown }).kind === 'string',
  )
  const summary = raw.summary
  return {
    layout: raw.layout === 'side-by-side' ? 'side-by-side' : 'grid',
    items,
    ...(typeof summary === 'object' && summary !== null
      && typeof summary.total === 'number' && typeof summary.shown === 'number'
      ? { summary: { total: summary.total, shown: summary.shown, kinds: Array.isArray(summary.kinds) ? summary.kinds : [] } }
      : {}),
  }
}

function CompositeBody({ payload, query }: SearchPreviewProps) {
  const t = useT()
  const composite = compositePayloadOf(payload)
  if (composite === undefined) return <p className={s.meta}>{t('search.previewMalformed')}</p>
  return (
    <div className={s.body} data-preview-layout={composite.layout}>
      {/*
        * 汇总那一行(batch 才有)。**文字读数**不是计数徽 —— 计数禁令管的是
        * tab / 列表 / 组头上挂的那种小圆点,一句「共 N 条 · 画出来 M 条」是读数。
        * `shown < total` 时它同时是那句「有几条没画出来」的诚实交代。
        */}
      {composite.summary !== undefined && (
        <p className={s.meta} data-readout="preview-summary">
          {t('search.previewBatchSummary', {
            total: composite.summary.total,
            shown: composite.summary.shown,
          })}
        </p>
      )}
      <div className={`${s.composite} ${composite.layout === 'side-by-side' ? s.side : s.grid}`}>
        {composite.items.map((item, index) => {
          const renderer = resolvePreviewRenderer(item.kind)
          return (
            <div className={s.cell} key={index} data-preview-kind={item.kind}>
              {item.title !== undefined && item.title.length > 0 && (
                <p className={s.title}>{item.title}</p>
              )}
              {renderer === undefined ? (
                // 缺渲染器**只塌这一格**(§4.3 的同一条纪律:壳没跟上不许把结果吞掉)。
                <p className={s.meta}>{t('search.previewUnavailable', { kind: item.kind })}</p>
              ) : (
                <renderer.Body payload={item.payload} query={query} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export const compositePreviewRenderer: SearchPreviewRenderer = {
  kind: 'composite',
  Body: CompositeBody,
}
