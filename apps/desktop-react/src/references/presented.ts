import type { PresentedResource } from '@shared/events/session-commands'
import { useWorkbenchStore } from '../workbench/store'
import { leavesOf, regionsInReadOrder } from '../workbench/tree'
import { flattenContent, presentedByContent } from '../workbench/kinds'
import type { ContentRef } from '../workbench/kinds'
import type { PaneNode } from '../workbench/tree'
import { referenceKindOf } from './registry'
import type { ResolvedSegment } from './segment'

/**
 * **这一轮摆在助手面前的资源**(09-18,正本 `docs/composer-open-dir-mentions-2026-09.md` §2.5.0)。
 *
 * 两家事实的并:这句话里引用了什么(`ReferenceKind.presents`),此刻工作台上开着什么
 * (`ContentKind.presents`)。发送时随命令走(`SendMessageCommand.presented`)。
 *
 * ── 为什么今天就收它,而它还没有读者 ────────────────────────────────────────────
 * 用户 09-18:「先不做鉴权,但留好入口」。入口就是这一格事实:后端今天只校验、不据此授权
 * (`packages/backend/session/presentation.ts`)。将来接鉴权是后端登记一位处理者的事,
 * 这只文件、发送路径与命令契约一行不改。
 *
 * ── 它说的是事实,不是请求 ────────────────────────────────────────────────────
 * 这里不判断「该不该放行」、不认识任何 scheme、不看路径在不在工作目录里 —— 那些是后端按资源
 * 自述裁决的事。壳说了算的只有一件:用户此刻眼前是什么。
 */

/**
 * **判据本体**(纯函数)。引用在前、开着的在后;同一条 `uri + via` 只出现一次。
 * 两个读法缺省走两张种类表,测试可以各递一只假的。
 */
export function collectPresented(
  segments: readonly ResolvedSegment[] | undefined,
  regions: Readonly<Record<string, PaneNode>>,
  refPresents: (kindId: string, value: unknown) => string | null = presentsOfReference,
  contentPresents: (ref: ContentRef) => string | null = presentedByContent,
): PresentedResource[] {
  const out: PresentedResource[] = []
  const seen = new Set<string>()
  const add = (uri: string | null, via: PresentedResource['via']) => {
    if (!uri) return
    const key = `${via}:${uri}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ uri, via })
  }

  for (const segment of segments ?? []) {
    if (segment.kindId !== null) add(refPresents(segment.kindId, segment.value), 'reference')
  }
  for (const regionId of regionsInReadOrder(regions)) {
    const tree = regions[regionId]
    if (!tree) continue
    for (const leaf of leavesOf(tree)) {
      for (const tab of leaf.tabs) {
        for (const part of flattenContent(tab)) add(contentPresents(part), 'open')
      }
    }
  }
  return out
}

function presentsOfReference(kindId: string, value: unknown): string | null {
  return referenceKindOf(kindId)?.presents?.(value) ?? null
}

/** 发送那一刻现读一次(非响应式:它是按下回车那一拍的快照,不是订阅)。 */
export function presentedNow(segments: readonly ResolvedSegment[] | undefined): PresentedResource[] {
  return collectPresented(segments, useWorkbenchStore.getState().regions)
}
