import { useMemo } from 'react'
import '../content/blocks'
import { BlockView } from '../content/blocks/BlockView'
import { parseMarkdown } from '../content/markdown/parse'

/** `?todo-lab` 里一段「AI 回复里的任务清单」:走消息同一条 parse → BlockView,看 E1 的勾选框与缩进。 */
const SAMPLE = `计划如下:

- [x] 读 \`auth.ts\` 找到回调
- [ ] 改成**先刷新 token** 再重试
  - [ ] 覆盖过期那一支
  - 顺手看一眼日志
- [ ] 跑 \`gate:connect\`

1. 普通有序项
2. 第二项`

export function MessageTasksDemo() {
  const blocks = useMemo(() => parseMarkdown(SAMPLE), [])
  return (
    <div data-lab-message="" style={{ maxWidth: '640px', padding: 'var(--sp-3)', background: 'var(--surface-1)' }}>
      {blocks.map((entry, index) => (
        <BlockView key={index} block={entry.block} ctx={{ messageId: 'lab', streaming: false }} />
      ))}
    </div>
  )
}
