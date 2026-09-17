/**
 * 待办这一 scheme 的自述(正本 `apps/desktop-react/docs/todo-2026-09.md` §3,
 * 编辑改写见 `todo-editor-2026-09.md` §4)。
 *
 * ── 地址 ────────────────────────────────────────────────────────────────
 *   `todo:notes`                用户清单这一整组(单例):列出、新建
 *   `todo:note/<id>`            一份用户清单,`<id>` = 文件名去掉 `.md`
 *   `todo:session/<sessionId>`  一个会话的 AI 计划;文件不存在也是合法地址,读出来 `exists: false`
 *
 * ── 为什么后端不解析 markdown ───────────────────────────────────────────
 * 渲染与编辑都在壳里用**消息那一份**解析器做(「和消息一模一样」是用户的第一条要求);
 * 这里只管字节与行。改动一律是 `LineEdit`(`@onething/core/text`):按原文对账,
 * AI 在旁边用写文件工具插删了行也能落对位置,对不上就整批不写、如实说冲突。
 *
 * ── 为什么不给 AI 生成工具(`exposure.aiTool: false`)────────────────────
 * AI 今天用 `write` / `edit` 维护计划,提示词(`prompts/content/todo-rules.md`)与免审批
 * 都已调好;换成结构化工具是一次用户能感知的行为变化,留给用户定(方案 §9 留账 1)。
 * RPC、CLI、插件的 `api.resources` 照常能用。
 */

import type { JsonSchema, ResourceSpec } from '@onething/core/resource'

export const TODO_RESOURCE_SCHEME = 'todo'

const EMPTY: JsonSchema = { type: 'object', properties: {}, required: [] }

const DOCUMENT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    exists: { type: 'boolean', description: 'False when there is no file behind this address yet.' },
    title: { type: 'string', description: 'The first "# " heading, or a fallback derived from the id.' },
    filePath: { type: 'string', description: 'Absolute path of the markdown file.' },
    content: { type: 'string', description: 'The whole markdown text. Empty when the file does not exist.' },
    revision: { type: 'string', description: 'Short hash of the content; changes whenever the text changes.' },
    updatedAt: { type: 'number', description: 'Last modification time, epoch milliseconds (0 when absent).' },
    total: { type: 'number', description: 'How many "- [ ]" / "- [x]" task lines.' },
    done: { type: 'number', description: 'How many of those are checked.' },
  },
  required: ['exists', 'title', 'filePath', 'content', 'revision', 'updatedAt', 'total', 'done'],
}

const LINE_EDIT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    start: { type: 'number', description: 'Zero-based line index the edit starts at.' },
    expect: { type: 'array', items: { type: 'string' }, description: 'The lines the caller believes are at start.' },
    lines: { type: 'array', items: { type: 'string' }, description: 'Replacement lines; empty deletes.' },
    anchor: { type: 'string', description: 'For a pure insertion: the line right above the insertion point.' },
  },
  required: ['start', 'expect', 'lines'],
}

export const todoResourceSpec: ResourceSpec = {
  scheme: TODO_RESOURCE_SCHEME,
  title: 'Todo lists and plans',
  exposure: { aiTool: false },
  reads: {
    list: {
      title: 'List the user\'s todo lists (address: todo:notes)',
      query: EMPTY,
      result: {
        type: 'object',
        properties: {
          notes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string' },
                id: { type: 'string' },
                title: { type: 'string' },
                updatedAt: { type: 'number' },
                total: { type: 'number' },
                done: { type: 'number' },
              },
              required: ['ref', 'id', 'title', 'updatedAt', 'total', 'done'],
            },
          },
        },
        required: ['notes'],
      },
    },
    search: {
      title: 'Search every user list by title and by task text (address: todo:notes)',
      query: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Case-insensitive substring.' },
          limit: { type: 'number', description: 'Most task hits to return (default 50).' },
        },
        required: ['q'],
      },
      result: {
        type: 'object',
        properties: {
          lists: {
            type: 'array',
            items: {
              type: 'object',
              properties: { ref: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' } },
              required: ['ref', 'id', 'title'],
            },
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string' },
                id: { type: 'string' },
                title: { type: 'string', description: 'Title of the list the task belongs to.' },
                line: { type: 'number', description: 'Zero-based line index of the task.' },
                text: { type: 'string', description: 'The task text without its "- [ ] " prefix.' },
                done: { type: 'boolean' },
              },
              required: ['ref', 'id', 'title', 'line', 'text', 'done'],
            },
          },
          more: { type: 'number', description: 'How many task hits were left out by the limit.' },
        },
        required: ['lists', 'items', 'more'],
      },
    },
    document: {
      title: 'Read one list or one session plan as markdown (address: todo:note/<id> or todo:session/<id>)',
      query: EMPTY,
      result: DOCUMENT_SCHEMA,
    },
  },
  ops: {
    /**
     * 按行改。上界 `file_edit`:界面上的人自己点的是零效果(provider 按主体分档),
     * 其余主体(插件、脚本)按策略表问。
     */
    edit: {
      title: 'Apply line edits to a list or a plan, reconciled against the current text',
      params: {
        type: 'object',
        properties: {
          edits: { type: 'array', items: LINE_EDIT_SCHEMA },
          baseRevision: { type: 'string', description: 'The revision the edits were made against.' },
        },
        required: ['edits'],
      },
      effects: ['file_edit'],
      home: 'core',
      entity: 'document',
      describe: () => 'edit its lines',
    },
    create: {
      title: 'Create a new todo list (address: todo:notes)',
      params: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      effects: ['file_write'],
      home: 'core',
      entity: 'list',
      describe: () => 'create a list',
    },
    rename: {
      title: 'Rename a todo list',
      params: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      effects: ['file_edit'],
      home: 'core',
      entity: 'list',
      describe: () => 'rename it',
    },
    delete: {
      title: 'Delete a todo list file',
      params: EMPTY,
      effects: ['file_destructive_edit'],
      home: 'core',
      entity: 'list',
      describe: () => 'delete it',
    },
    createPlan: {
      title: 'Write the first item of a session plan that does not exist yet',
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      effects: ['file_write'],
      home: 'core',
      entity: 'plan',
      describe: () => 'start the plan',
    },
  },
  events: {
    /** 发在文档地址上;用户清单被外部改了时文件监听器分不出是哪一份,发在 `todo:notes` 上。 */
    changed: {
      title: 'The text changed',
      payload: {
        type: 'object',
        properties: {
          origin: { type: 'string', enum: ['app', 'external'], description: 'app = written through this backend; external = seen by the file watcher (the AI\'s file tools, another editor).' },
        },
        required: ['origin'],
      },
    },
    created: { title: 'A list or plan came into being', payload: EMPTY },
    deleted: { title: 'A list was deleted', payload: EMPTY },
  },
}
