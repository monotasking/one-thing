import type { FileMock } from './types'

/**
 * 文件侧的静态 mock 表 —— **D1 之后这里是全壳仅存的检索素材 mock**。
 *
 * 会话侧已经接真数据(data/sessions-source.ts → sessions.listMeta / getSegments);
 * 文件侧还没有,因为它要的是另一样东西:一个能在工作目录里按内容搜的服务
 * (ripgrep / 索引器)。壳里没有,后端的 `search` 域是**网页搜索**不是文件搜索,
 * 所以这一侧仍然是这张表 —— 这是一个诚实标注的缺口,不是忘了换。
 *
 * 换的时候只有这张表换来源,transitions / 组件一行不改 ——
 * 和会话侧刚刚走过的那条路一样。
 *
 * 路径取自 data/chat-mock.ts 那几张工具卡读过的真文件 —— 两处说的是同一批文件。
 */
export const FILES: FileMock[] = [
  {
    path: 'packages/onething-runtime/src/providers/model-capability.ts',
    time: '14:20',
    lines: [
      {
        line: 12,
        text: 'export function onethingModelSupportsImageGeneration(entry: ModelEntry): boolean {',
      },
      { line: 18, text: "  if (entry.capabilities?.output) return entry.capabilities.output.includes('image')" },
      { line: 24, text: "  return entry.modalities?.includes('image') ?? false" },
    ],
  },
  {
    path: 'packages/onething-runtime/src/providers/model-registry.ts',
    time: '昨天',
    lines: [
      { line: 96, text: 'const catalogCache = new Map<string, ModelEntry[]>()' },
      { line: 131, text: '  // 缓存键跟着目录键走,换目录立刻失效,不再按时间过期' },
      { line: 207, text: 'export function findModelEntry(id: string): ModelEntry | undefined {' },
    ],
  },
  {
    path: 'docs/design/provider-oop-2026-08.md',
    time: '周一',
    lines: [
      { line: 3, text: '# Provider 抽象:Wire × Dialect' },
      { line: 41, text: '能力判定收敛到一个纯函数,请求装配 / 徽标 / 生图路由三处都调它。' },
    ],
  },
]
