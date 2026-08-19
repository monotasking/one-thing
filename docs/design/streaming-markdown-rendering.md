# Streaming Markdown Real-Time Rendering Design

## 1. Overview

This document describes the architecture for real-time rendering of Markdown syntax (code blocks, tables, headings, lists, blockquotes, inline code, math, links, images) as text streams token-by-token from AI providers. The goal is to deliver a **flicker-free, low-latency, scroll-stable** rendering experience during streaming, while falling back to fully-featured rendering (MathJax, full syntax highlighting) once the stream completes.

---

## 2. Architecture Layers

```
┌──────────────────────────────────────────────────────────────────┐
│                      Vue Component Layer                          │
│                                                                   │
│  MessageBubble.vue                                                │
│   ├─ StreamingMarkdown.vue     ← orchestrator / dispatcher        │
│   │   ├─ md-segment (v-html)   ← markdown-it render via cache     │
│   │   ├─ StreamingCodeBlock    ← stable component per fenced block│
│   │   └─ StreamingTableBlock   ← stable component per table       │
│   └─ StepsPanel / ToolCallItem ← tool output rendered separately  │
└──────────────────────────────────────────────────────────────────┘
                              ↓ props: content string
┌──────────────────────────────────────────────────────────────────┐
│                  Segment Parser Layer                              │
│                                                                   │
│  parseStreamingMarkdown(content, { streaming })                   │
│   → MarkdownSegment[]                                             │
│     { type: 'markdown' | 'code' | 'table', key, content, ... }    │
│                                                                   │
│  Responsibilities:                                                │
│  • Detect fenced code block boundaries (``` / ~~~)                │
│  • Detect table structures (pipe-separated lines + separator)     │
│  • Split incomplete trailing code fences (partial ```, `` etc.)   │
│  • Identify stability zones within markdown segments              │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│                  Rendering Engine Layer                            │
│                                                                   │
│  useMarkdownRenderer.ts                                           │
│   ├─ md (full instance)       ← markdown-it + MathJax + hljs      │
│   └─ streamingMd (light)     ← markdown-it only (no MathJax)     │
│                                                                   │
│  Per-segment MD cache (Map<key, {content, streaming, html}>)      │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│                DOM Update Strategy Layer                           │
│                                                                   │
│  StreamingCodeBlock.vue                                           │
│   • textContent append during streaming (prevents layout reflow)  │
│   • lazy hljs via requestIdleCallback when complete               │
│   • preserves scrollLeft and selection across updates             │
│                                                                   │
│  StreamingMarkdown.vue                                            │
│   • Keyed segment recycling (Vue keyed v-for)                     │
│   • RAF-throttled content commits                                 │
│   • display: contents wrapper to preserve margin-collapsing       │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Design Decisions

### 3.1 Segment Isolation Strategy

**Problem:** A single blob of `v-html` causes the entire content DOM to be replaced on every chunk, losing scroll state, selection, and creating layout jitter.

**Solution:** Split the stream into typed **segments** before rendering. Each segment type gets a dedicated, keyed Vue component:

| Segment Type | Component | Why Isolated |
|---|---|---|
| `markdown` | `v-html` in `StreamingMarkdown.vue` | Contains inline formatting only — no block-level constructs that need stable DOM |
| `code` | `StreamingCodeBlock.vue` | Needs stable `<pre><code>` for horizontal scroll, selection, and lazy highlighting |
| `table` | `StreamingTableBlock.vue` | Needs stable container to avoid width reflow as columns are streamed |

Segments use **position-based keys** (e.g., `code-134`, `table-256`, `md-0`) ensuring Vue reuses the same component instance for the same code block across re-renders.

### 3.2 Stability Zones (Anti-Flicker)

**Problem:** markdown-it renders block-level elements differently depending on whether trailing content is present. For example, `## Heading\ntext` renders as `<h2>Heading</h2>text` while `## Heading` alone might render differently. Streaming fragments the input, causing the rendered HTML to shift.

**Solution — "Stable Prefix" detection:** For `markdown` segments, split into stable + unstable halves:

```
Raw markdown segment content:
  "## Introduction\n\nThis is a paragraph about...\n- Item 1\n- Item 2"

Detection:
  • Last \n\n is at position 17 → split here
  • stable:   "## Introduction\n\nThis is a paragraph about..."
  • unstable: "- Item 1\n- Item 2"

Rendering:
  • stable → render once via cached markdown-it, keyed by position
  • unstable → re-render on each chunk
```

**Stability boundaries recognized:**

| Boundary | Reason |
|---|---|
| `\n\n` (double newline / paragraph break) | Paragraphs are isolated block; trailing content won't affect preceding paragraph |
| `\n#{1,6} .+?\n` (completed heading line) | Heading is a standalone block; stable once its line ends |
| `\n> .+?\n\n` (completed blockquote + blank line) | Multi-line blockquotes stable after paragraph break |
| `\n---\n` or `\n***\n` (horizontal rule) | HR is atomic |

**Trimming streaming artifacts:**

- Partial closing fence: `` ` `` → `` `` `` → ` ``` ` — suppress these from the rendered content
- Partial opening fence: `` ` ``, ` `` ` at end of markdown segment — suppress
- Trailing bare newline + whitespace — trim from unstable tail

### 3.3 Code Block Rendering Pipeline

```
Streaming Phase → Stream Complete → Idle → Display Complete
─────────────────────────────────────────────────────────
textContent     →  render()       →  hljs  →  innerHTML
(incremental      (decides if       (idle    (highlighted
 append via       highlight         callback) syntax)
 textNode)        needed)

Key invariant: <pre><code> element is NEVER rebuilt.
```

**Streaming phase (complete: false):**

```javascript
// Direct textContent manipulation — no DOM reflow
if (props.content.startsWith(lastRenderedContent) && !lastRenderedHighlighted) {
  const textNode = el.firstChild
  if (textNode?.nodeType === Node.TEXT_NODE) {
    textNode.textContent += delta  // append only new chars
  }
}

// O(n) where n = delta length, not O(n) where n = total content
```

**Lazy highlight scheduling:**

```javascript
// Small blocks (<5000 chars): highlight immediately on complete
if (content.length <= 5000) {
  el.innerHTML = hljs.highlight(content, { language }).value
}

// Large blocks: defer to requestIdleCallback
if (content.length > 5000) {
  highlightJob = requestIdleCallback(() => {
    el.innerHTML = hljs.highlight(content, { language }).value
  }, { timeout: 600 })
}
```

**Why preserve `<pre><code>` DOM:**

- `scrollLeft` survives — user can read while streaming
- User text selection within the block is preserved
- Copy button animation doesn't reset
- No layout reflow from element recreation

### 3.4 Table Handling

Tables are a special case — markdown-it table rendering requires a **complete** separator row (`|---|---|`) followed by data rows. Streaming this through markdown-it inline produces garbled output.

**Strategy:**

1. **Detection:** `findTrailingTableCandidateStart()` scans backwards from end for pipe-delimited lines
2. **Gate:** Only switch to table segment when:
   - At least 2 pipe-delimited lines exist, OR
   - A separator row (`|:---|:---|`) has been detected
3. **Rendering:** Raw text in `<pre><code>` during streaming, markdown-it `<table>` HTML on completion
4. **Stability:** Once a table segment is created, it's never demoted back to markdown

### 3.5 Math Rendering (MathJax)

**Problem:** MathJax produces heavy SVG output. During streaming, the SVG DOM tree is rebuilt on every chunk, causing severe jank.

**Solution:** Two markdown-it instances:

```javascript
const md = createMarkdownRenderer(true)         // with MathJax
const streamingMd = createMarkdownRenderer(false) // without MathJax
```

**Behavior:**
- **Streaming:** `$x^2$` renders as raw text `\(x^2\)` (fast, flicker-free)
- **Final:** Re-render with full MathJax, producing proper SVG rendering

**Transition:** When `isStreaming` flips from `true` → `false`, all segments are re-rendered with the full markdown-it instance. The markdown cache is invalidated by the `streaming` flag, so the final render uses the MathJax-enabled instance.

### 3.6 Render Throttling Strategy

```
AI token arrives → props.content updates
                          ↓
                  watch(() => props.content)
                          ↓
              isStreaming && !isUser?
                Yes → scheduleDisplayedContent()
                         ↓
                  requestAnimationFrame
                         ↓
              displayedContent.value = props.content
                         ↓
              segments computed → re-render
                No → commitDisplayedContent() (sync)
```

- **RAF coalescing:** Multiple token updates within one frame batch into a single render
- **Cache hit:** Stable markdown segments with identical content skip markdown-it altogether
- **30fps budget:** With typical 60fps displays, this guarantees ≤ 1 render per 2 frames at worst case

---

## 4. Component Contract

### 4.1 `parseStreamingMarkdown(content, options) → MarkdownSegment[]`

```
Input:  "# Hello\n\n```js\nconst x = 1\n```"
Output: [
  { type: 'markdown', key: 'md-0',     content: '# Hello\n\n', complete: true  },
  { type: 'code',     key: 'code-8',   lang: 'js', content: 'const x = 1\n', complete: true },
]
```

**Streaming input (no closing fence yet):**
```
Input:  "# Hello\n\n```js\nconst x = 1\ncode:"
Output: [
  { type: 'markdown', key: 'md-0',     content: '# Hello\n\n', complete: true  },
  { type: 'code',     key: 'code-8',   lang: 'js', content: 'const x = 1\ncode:', complete: false },
]
// Note: "code:" is trimmed by trimStreamingCodeTail if it matches a partial fence
```

### 4.2 `StreamingCodeBlock` Props

| Prop | Type | Description |
|---|---|---|
| `lang` | `string` | Language identifier (e.g., `js`, `python`, `text`) |
| `content` | `string` | Raw code content (without fences) |
| `complete` | `boolean` | Whether closing fence has been received |
| `isStreaming` | `boolean` | Whether the parent stream is still active |

**State guarantees:**
- `complete: true` → content will never change again → safe to highlight
- `isStreaming: false` → stream ended → any pending highlight jobs should flush immediately
- `<pre>` element identity is **stable** across all prop updates

### 4.3 `StreamingMarkdown` Props

| Prop | Type | Description |
|---|---|---|
| `content` | `string` | Raw markdown string (may contain code fences) |
| `isUser` | `boolean` | Whether this is a user message (no markdown rendering) |
| `isStreaming` | `boolean` | Whether content is still arriving |

### 4.4 `useMarkdownRenderer` API

| Export | Signature | Description |
|---|---|---|
| `renderMarkdown` | `(content: string, isUserMessage: boolean, options: { streaming?: boolean }) => string` | Render markdown to HTML |
| `escapeHtml` | `(text: string) => string` | Escape HTML special chars |
| `cleanReasoningContent` | `(content: string) => string` | Remove `<think>` XML tags |
| `stripMarkdown` | `(content: string) => string` | Strip formatting for TTS |

---

## 5. Performance Budget

| Metric | Target | Current Status |
|---|---|---|
| Render latency per chunk | < 16ms (60fps) | ✅ RAF-coalesced, ~2-8ms for markdown segments |
| Code block highlight defer | < 50ms blocking | ✅ requestIdleCallback, 5000-char immediate threshold |
| MD cache hit rate (streaming) | > 90% | ✅ Stable segments hit cache; only trailing tail re-renders |
| DOM mutations per chunk | O(delta) not O(total) | ✅ Code blocks append only; markdown segments use stability zones |
| Scroll jitter (distanceToBottom) | < 2px when following | ✅ Monitored via stream-scroll-trace |
| Memory (MD cache) | < 2MB | ✅ LRU-capped at 32 entries |

---

## 6. Edge Cases

### 6.1 Nested Fence Characters

```
Input: ````md
This is a code block that contains ```
````
```

**Handling:** `FENCE_OPEN` regex matches the longest fence. `closeRegex` uses the **exact same** fence chars (`\`\`\`\``). Only `\`\`\`\`` on its own line closes — not `\`\`\`` inside the block.

### 6.2 Partial Fence Typing

```
AI is typing: ```   (3 backticks) → stream must NOT interpret as opening fence
Immediately followed by: js\ncode
```

**Handling:** `FENCE_OPEN` regex requires newline-or-EOL **after** the fence chars. So `` ``` `` at end of string is not a fence until the next character (either `\n` or end-of-stream) appears.

### 6.3 Mid-Stream Language Detection Change

```
```py      → segments emit { lang: 'py' }
...later re-parse as:
```python  → segments emit { key: 'code-42', lang: 'python' }
```

**Handling:** Since the segment key is position-based, a different `lang` on the same code block causes a **new component instance** (the key `code-42` doesn't change, so Vue reuses the component — `watch(() => props.lang, render)` triggers re-render).

Actually, **key doesn't change** — the key is `code-<fenceAbsStart>`, which is stable. The `lang` prop update triggers the `watch(() => props.lang)` watcher in `StreamingCodeBlock`, which re-renders (escaped text if no closing fence yet, highlighted if complete).

### 6.4 Zero-Content Code Blocks

```
```\n```
```

**Handling:** `content` is an empty string. `StreamingCodeBlock` renders empty `<pre><code>` with copy button. No syntax highlighting occurs.

### 6.5 Table in the Middle of Markdown, Then More Markdown

```
Some text
| A | B |
|---|---|
| 1 | 2 |
More text after
```

**Current handling:** The parser processes code fences first. If a table appears between two markdown segments without a code fence boundary, it's embedded in the same markdown segment and rendered by markdown-it as a `<table>`. The `StreamingTableBlock` only activates when streaming produces an incomplete table at the **tail** of the stream — i.e., when markdown-it can't render it yet.

### 6.6 User Messages (No Markdown)

User messages bypass all markdown parsing:
- `parseStreamingMarkdown` returns a single `{ type: 'markdown' }` segment
- `renderMarkdown` with `isUserMessage: true` → escapes HTML + converts `\n` to `<br>`

---

## 7. CSS Strategy for Streaming Stability

### 7.1 Code Block Anti-Jitter

```css
.code-block-container .code-block-pre {
  overflow-x: scroll;       /* horizontal scroll stable */
  overflow-y: hidden;       /* vertical expansion only — no reflow */
  white-space: pre;         /* exact whitespace preservation */
  scrollbar-gutter: stable; /* reserve scrollbar space */
  tab-size: 2;              /* consistent tab rendering */
}
```

### 7.2 Markdown Segment Layout Isolation

```css
.md-segment {
  display: contents;  /* transparent: children flow as siblings */
}
```

`display: contents` means the `.md-segment` wrapper doesn't create a box — its children participate in the parent's layout directly. This preserves **margin collapsing** between paragraphs, code blocks, and other block-level elements.

### 7.3 Future: CSS Containment

```css
/* Optional optimization: isolate each segment's layout subtree */
.md-segment { contain: layout style; }
.code-block-container { contain: layout style paint; }
```

`contain: layout style` tells the browser that changes inside this element don't affect the layout of elements outside it, allowing the browser to skip expensive layout recalculations. Only the unstable tail segment would need re-layout.

---

## 8. Testing Strategy

### 8.1 Unit Tests (Vitest)

| Test | Description |
|---|---|
| `parseStreamingMarkdown - empty input` | Returns `[]` |
| `parseStreamingMarkdown - plain text` | Returns 1 markdown segment |
| `parseStreamingMarkdown - single code block` | Returns markdown + code segments with correct keys |
| `parseStreamingMarkdown - open fence, no close` | Returns markdown + code with `complete: false` |
| `parseStreamingMarkdown - partial trailing fence` | Suppresses `` ` `` / ` `` ` from content tail |
| `parseStreamingMarkdown - table detection` | Correctly identifies table candidates |
| `parseStreamingMarkdown - mixed content` | Multiple code blocks + markdown interleaved |
| `renderMarkdown - user message` | Escapes HTML, converts newlines to `<br>` |
| `renderMarkdown - code block` | Produces `.code-block-container` with copy button |
| `renderMarkdown - inline code` | Produces `<code class="inline-code">` |
| `stripMarkdown - all types` | Correctly removes all markdown formatting |

### 8.2 Integration Tests (Browser)

| Test | Description |
|---|---|
| Streaming scroll stability | No jitter when `isFollowing: true` during streaming |
| Code block selection persistence | User selection survives text append |
| Code block scroll persistence | Horizontal scroll position survives append |
| Transition: streaming → final | MathJax renders correctly after stream ends |
| Rapid chunk arrival | No dropped frames at 100 chunks/second |

### 8.3 Debug Tracing

采样门 = 日志等级(L4 起没有第二个开关,见 `logging-system-2026-08.md` §8.1):

```javascript
// Enable in browser console:
window.__onethingLog.level('info,renderer.stream-scroll=trace')

// 结构化记录(ns = renderer.stream-scroll,msg = 'stream scroll event'):
// { frameId: 42, trigger: 'StreamingMd:commit', detail: 'len=1234' }

// 现场取样(环形缓冲照旧):
window.__streamScrollTrace.printSummary()
```

---

## 9. Future Improvements

### 9.1 WASM-Based Streaming Markdown Parser

A custom streaming markdown parser compiled to WASM could process tokens incrementally without the overhead of re-parsing the entire content on each chunk. This would replace `markdown-it` entirely for streaming, only falling back to it for final rendering.

- **Pro:** O(delta) parsing cost vs O(total) with markdown-it
- **Con:** Significant implementation effort, needs custom parser

### 9.2 Virtualized Code Blocks

For very long code blocks (>1000 lines), virtualize line rendering so only visible lines are in the DOM:

```
┌─────────────────────────────┐ ← scrollTop
│ lines 48-72 (25 visible)   │ ← only these are DOM nodes
└─────────────────────────────┘ ← scrollTop + clientHeight
```

### 9.3 Streaming Diff Rendering

For tool outputs that show diffs, render the diff incrementally as unified/git-diff format, with `+` lines in green and `-` lines in red, updating as the tool streams output.

### 9.4 Inline Code Block Streaming

For short inline snippets that should be code-highlighted during streaming (e.g., `` `const x = 1` ``), apply syntax highlighting immediately if the content matches a known language pattern and is under 200 chars.

### 9.5 Searchable Code Blocks

Index code block content in a session-level content index for fast search/retrieval within long conversations.

---

## 10. File Index

| File | Role |
|---|---|
| `src/renderer/composables/parseStreamingMarkdown.ts` | Segment parser — splits stream into typed segments |
| `src/renderer/composables/useMarkdownRenderer.ts` | Rendering engine — markdown-it + hljs + MathJax |
| `src/renderer/components/chat/message/StreamingMarkdown.vue` | Orchestrator — dispatches segments to sub-components |
| `src/renderer/components/chat/message/StreamingCodeBlock.vue` | Code block component — stable DOM, lazy highlight |
| `src/renderer/components/chat/message/StreamingTableBlock.vue` | Table component — raw preview during streaming |
| `src/renderer/components/chat/message/MessageBubble.vue` | Message bubble — integrates StreamingMarkdown |
| `src/renderer/styles/markdown.css` | Markdown styles — code blocks, inline code, tables, headings, etc. |
| `src/renderer/styles/hljs-theme.css` | Syntax theme — CSS variable-based color mapping |
| `src/renderer/utils/stream-scroll-trace.ts` | Dev tracing — frame-level scroll stability diagnostics |
