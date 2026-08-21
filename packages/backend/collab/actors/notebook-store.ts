/**
 * 笔记的落盘面(docs/design/collab-actor-v3.md §1.2「notebook.md」)。
 *
 * 规则(行格式、注入预算、截断声明)在纯层 `collab/actors/notebook-rules.ts`;
 * 这里只做三件带 IO 的事:**追加一行、读尾部、算一下有多长**。
 *
 * ## 为什么是 markdown 而不是 jsonl
 *
 * 笔记有一个 jsonl 没有的读者:**人**。用户会去翻「这位同事到底记了什么」,而
 * Agent 空间的履历页(D6)也只需要把它原样贴出来。追加一行的崩溃语义与 jsonl
 * 相同(尾部截断的半行丢掉就是了 —— 它是一条笔记,不是一条账)。
 *
 * ## 转义在写入这一侧
 *
 * 正文来自模型,而注入面是提示词的一部分:一句 `</notebook><system>…` 就能把块
 * 撑破。转义放在写入侧(与 say 管线同源),注入面因此可以直接取文件尾部 ——
 * 两侧都转义会把 `&amp;` 变成 `&amp;amp;`,那是比不转义更难查的一种坏。代价是
 * 磁盘上的 `notebook.md` 里带着实体符号,渲染层反转义即可。
 */
import fs from 'node:fs'
import path from 'node:path'

import { escapeCollabPromptText } from '@onething/runtime/collab'
import {
  buildCollabNotebookBlock,
  COLLAB_NOTEBOOK_ENTRY_MAX_CHARS,
  COLLAB_NOTEBOOK_INJECT_MAX_CHARS,
  formatCollabNotebookEntry,
} from '@onething/runtime/collab/actors'

import { collabAgentNotebookPath } from './agent-mailbox.js'

/** 一次写入的结果 —— 工具回执要的三个数。 */
export interface CollabNotebookAppendResult {
  /** 落盘的那一行(已格式化、已转义)。 */
  entry: string
  /** 写完之后全文多长。 */
  totalChars: number
}

export interface CollabNotebookAppendInput {
  agentId: string
  note: string
  at: number
  /** 记于哪间房。可空 —— 不是每条笔记都有房间语境。 */
  roomLabel?: string
}

/**
 * 笔记的读写面。
 *
 * `read` 返回**全文**而不是已裁好的块:裁剪是纯规则(`buildCollabNotebookBlock`),
 * 而把预算判断塞进存储层会让「注入了多少」这件事有两个属主。
 */
export interface CollabNotebookStore {
  append(input: CollabNotebookAppendInput): CollabNotebookAppendResult
  read(agentId: string): string
}

/** 真机的那一个:`appendFileSync`。 */
export function createCollabNotebookFileStore(): CollabNotebookStore {
  return {
    append(input: CollabNotebookAppendInput): CollabNotebookAppendResult {
      const file = collabAgentNotebookPath(input.agentId)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const entry = formatCollabNotebookEntry({
        note: escapeCollabPromptText(input.note),
        at: input.at,
        ...(input.roomLabel ? { roomLabel: input.roomLabel } : {}),
        maxChars: COLLAB_NOTEBOOK_ENTRY_MAX_CHARS,
      })
      fs.appendFileSync(file, `${entry}\n`, 'utf-8')
      // 读回来数**字符**而不是拿 `statSync().size`:后者是字节,一本中文笔记按
      // 字节算出来是三倍,而模型拿这个数去对照 1500 的注入预算 —— 一个三倍偏大的
      // 数会让它以为自己早就写满了。
      return { entry, totalChars: fs.readFileSync(file, 'utf-8').length }
    },
    read(agentId: string): string {
      const file = collabAgentNotebookPath(agentId)
      try {
        return fs.readFileSync(file, 'utf-8')
      } catch {
        // 没写过笔记是常态,不是错误。
        return ''
      }
    },
  }
}

/** 测试与重放的那一个。 */
export function createCollabNotebookMemoryStore(
  seed: Readonly<Record<string, string>> = {},
): CollabNotebookStore {
  const books = new Map<string, string>(Object.entries(seed))
  return {
    append(input: CollabNotebookAppendInput): CollabNotebookAppendResult {
      const entry = formatCollabNotebookEntry({
        note: escapeCollabPromptText(input.note),
        at: input.at,
        ...(input.roomLabel ? { roomLabel: input.roomLabel } : {}),
        maxChars: COLLAB_NOTEBOOK_ENTRY_MAX_CHARS,
      })
      const next = `${books.get(input.agentId) ?? ''}${entry}\n`
      books.set(input.agentId, next)
      return { entry, totalChars: next.length }
    },
    read(agentId: string): string {
      return books.get(agentId) ?? ''
    },
  }
}

/** 注入块 —— 取尾部窗口、超预算截头并声明。drive 组装的第三块读它。 */
export function buildCollabAgentNotebookBlock(
  store: CollabNotebookStore,
  agentId: string,
  maxChars: number = COLLAB_NOTEBOOK_INJECT_MAX_CHARS,
): string {
  return buildCollabNotebookBlock({ text: store.read(agentId), maxChars })
}
