import {
  OnethingScratchpadStore,
  OnethingScratchpadWatcher,
  type ScratchpadChangedPayload,
  type ScratchpadDocument,
} from '@onething/runtime/scratchpad'
import { getStorePath } from '../stores/paths.js'

/**
 * Host injection points. The Electron host broadcasts changes to its windows;
 * headless hosts leave it unset.
 */
export interface ScratchpadHostPorts {
  broadcastChanged?: (payload: ScratchpadChangedPayload) => void
}

let hostPorts: ScratchpadHostPorts = {}

export function configureScratchpadHost(ports: ScratchpadHostPorts): void {
  hostPorts = ports
}

function broadcast(payload: ScratchpadChangedPayload): void {
  hostPorts.broadcastChanged?.(payload)
}

export const scratchpadStore = new OnethingScratchpadStore({
  getDefaultStorePath: () => getStorePath(),
  notifyChanged: broadcast,
})

// The AI edits the paper with the ordinary write/edit tools, which do not go
// through this store, so the watcher is what tells the UI those edits happened.
const scratchpadWatcher = new OnethingScratchpadWatcher({
  store: scratchpadStore,
  notifyChanged: broadcast,
  onError: error => console.error('[scratchpad] watch failed:', error),
})

export function startScratchpadWatcher(): Promise<void> {
  return scratchpadWatcher.start()
}

export function stopScratchpadWatcher(): void {
  scratchpadWatcher.stop()
}

export function readScratchpad(sessionId: string): Promise<ScratchpadDocument> {
  return scratchpadStore.read(sessionId)
}

export function updateScratchpad(sessionId: string, content: string): Promise<ScratchpadDocument> {
  return scratchpadStore.update(sessionId, content)
}

export function removeScratchpad(sessionId: string): Promise<void> {
  return scratchpadStore.remove(sessionId)
}

export function adoptScratchpad(fromSessionId: string, toSessionId: string): Promise<void> {
  return scratchpadStore.adopt(fromSessionId, toSessionId)
}

// --- 瞬态尾块(P1 · AI 静默感知) ---

/**
 * 一块尾巴的正文上限。超了从**头部**截断:纸是往下写的,最近写的那几行才是
 * "用户此刻在想什么",而完整内容始终在文件里(块头带着绝对路径,模型可以用
 * 文件工具去读)。
 */
const SCRATCHPAD_TAIL_MAX_CHARS = 16_384
const TRUNCATION_NOTE = '[前文已截断,完整内容读文件]'

/**
 * 块内的自描述说明。写在**块里**而不是 system prompt 里,是为了不动缓存前缀:
 * 这块东西每轮都可能变,放进前缀等于每轮把整个前缀作废。
 */
const SCRATCHPAD_PREAMBLE = [
  '(这是用户的草稿纸。用户可能随时在纸上补充想法、材料、文件路径;它是背景参考,',
  '不是正式消息 —— 除非用户正式发出,不要逐条直接回复纸上内容,但要让它影响你的行动。',
  '你也可以用文件工具读写这张纸。)',
].join('\n')

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export interface ScratchpadTail {
  text: string
  version: number
}

/**
 * 本 turn 的草稿纸尾块。空纸 / 没有这张纸 → undefined(零开销,什么都不挂)。
 *
 * `version` 就是文件 mtime —— 与渲染层拿到的是同一个数,水位线才对得上。
 */
export async function buildScratchpadTail(sessionId: string): Promise<ScratchpadTail | undefined> {
  if (!sessionId) return undefined
  let document: ScratchpadDocument
  try {
    document = await scratchpadStore.read(sessionId)
  } catch {
    return undefined
  }
  const content = document.content
  if (!content.trim()) return undefined

  const body = content.length > SCRATCHPAD_TAIL_MAX_CHARS
    ? `${TRUNCATION_NOTE}\n${content.slice(content.length - SCRATCHPAD_TAIL_MAX_CHARS)}`
    : content

  const text = [
    `<scratchpad path="${escapeAttribute(document.filePath)}" version="${document.version}">`,
    SCRATCHPAD_PREAMBLE,
    body,
    '</scratchpad>',
  ].join('\n')

  return { text, version: document.version }
}

/**
 * 注入进 agent-loop 的 hook。产品层拿到的是**这个对象**,不是这个模块 ——
 * 依赖方向单向(产品 ← 装配),所以走注入而不是 import。
 */
export const scratchpadRuntimeHooks = {
  buildTail(sessionId: string): Promise<ScratchpadTail | undefined> {
    return buildScratchpadTail(sessionId)
  },
}
