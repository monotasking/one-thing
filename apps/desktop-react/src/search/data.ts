import type { FileMock } from './types'

/**
 * 文件侧的静态 mock 表。之后接真实数据(索引器 / ripgrep)时,只有这张表换来源,
 * transitions / 组件一行不改 —— 和 expose/data.ts、stage/items.ts 同一个理由。
 *
 * 会话侧不在这里:它直接消费 expose/data.ts 的 SESSIONS,
 * 因为「检索面看到的会话」和「总览看到的会话」必须是同一批,不许有第二份事实。
 *
 * 路径取自 data/chat-mock.ts 那几张工具卡读过的真文件 —— 两处说的是同一批文件,
 * 所以在聊天里被读过的东西,在检索面里搜得到。
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
