/**
 * Incremental structured parser for streaming tool-call arguments.
 *
 * Purpose: let the UI render partial arguments honestly. Every leaf field is
 * classified as 'closed' (its value's closing quote/bracket arrived) or 'open'
 * (still streaming). The renderer shows closed fields as settled text, mounts
 * a cursor on the single open field, and treats everything else as absent.
 *
 * Contract:
 * - O(delta): push() consumes only the appended bytes; internal state resumes.
 * - Never throws on malformed input — the last good view is kept and
 *   view().error is set. Honesty over completeness.
 * - Incomplete escape sequences (`\`, `\u12`, lone high surrogate) are
 *   withheld from the decoded value until they can decode cleanly, so the
 *   cursor never trails half a codepoint of mojibake.
 */

export type StreamingArgsFieldState = 'closed' | 'open'

export type StreamingArgsValueKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'object'
  | 'array'

export interface StreamingArgsField {
  /** Leaf path, e.g. 'path' or 'edits[1].newText'. */
  path: string
  state: StreamingArgsFieldState
  /** Decoded value for strings (prefix while open); raw JSON text otherwise. */
  value: string
  kind: StreamingArgsValueKind
}

export interface StreamingArgsView {
  /** Leaf fields in arrival order. */
  fields: StreamingArgsField[]
  /** Path of the field currently streaming — the cursor mount point. */
  openPath: string | null
  /** True once the top-level value has closed. */
  complete: boolean
  /** Total characters pushed so far (authoritative receive counter). */
  charsReceived: number
  /** Set when the input stopped being valid JSON; fields keep the last good state. */
  error?: string
}

export interface StreamingArgsParser {
  push(delta: string): void
  view(): StreamingArgsView
}

type ParserMode =
  | 'value-start'   // expecting a value
  | 'object-start'  // just after '{' — key or '}'
  | 'key-start'     // expecting a key (after ',')
  | 'in-key'
  | 'after-key'     // expecting ':'
  | 'in-string'
  | 'in-number'
  | 'in-literal'    // true / false / null
  | 'after-value'   // expecting ',' or container close
  | 'done'
  | 'error'

interface ContainerFrame {
  kind: 'object' | 'array'
  /** Current key (objects) — set while parsing the member value. */
  key: string
  /** Next element index (arrays). */
  index: number
  path: string
}

const HEX_RE = /^[0-9a-fA-F]{4}$/

function isJsonWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t'
}

function memberPath(frame: ContainerFrame | undefined): string {
  if (!frame) return ''
  if (frame.kind === 'array') {
    return frame.path ? `${frame.path}[${frame.index}]` : `[${frame.index}]`
  }
  return frame.path ? `${frame.path}.${frame.key}` : frame.key
}

export function createStreamingArgsParser(): StreamingArgsParser {
  const fields: StreamingArgsField[] = []
  const stack: ContainerFrame[] = []

  let mode: ParserMode = 'value-start'
  let charsReceived = 0
  let complete = false
  let error: string | undefined

  /** Field currently being written (open string/number/literal). */
  let currentField: StreamingArgsField | null = null

  // String decoding state (shared by keys and string values).
  let stringBuffer = ''
  let escapePending = false
  let unicodePending: string | null = null   // hex digits collected after \u
  let heldHighSurrogate: string | null = null
  let decodingKey = false

  // Number / literal accumulation.
  let scalarBuffer = ''

  function fail(message: string): void {
    if (mode === 'error') return
    mode = 'error'
    error = message
    if (currentField) {
      // Leave the field open — we genuinely do not know its end.
      currentField = null
    }
  }

  function flushHeldSurrogate(): void {
    if (heldHighSurrogate !== null) {
      stringBuffer += heldHighSurrogate
      heldHighSurrogate = null
    }
  }

  function appendDecoded(text: string): void {
    flushHeldSurrogate()
    stringBuffer += text
    syncOpenString()
  }

  function syncOpenString(): void {
    if (!decodingKey && currentField) {
      currentField.value = stringBuffer
    }
  }

  function openLeaf(kind: StreamingArgsValueKind): void {
    const frame = stack[stack.length - 1]
    const field: StreamingArgsField = {
      path: memberPath(frame),
      state: 'open',
      value: '',
      kind,
    }
    fields.push(field)
    currentField = field
  }

  function closeLeaf(value: string): void {
    if (currentField) {
      currentField.value = value
      currentField.state = 'closed'
      currentField = null
    }
  }

  function enterContainer(kind: 'object' | 'array'): void {
    const frame = stack[stack.length - 1]
    stack.push({
      kind,
      key: '',
      index: 0,
      path: memberPath(frame),
    })
  }

  function afterValueMode(): void {
    if (stack.length === 0) {
      complete = true
      mode = 'done'
      return
    }
    mode = 'after-value'
  }

  function closeContainer(expected: 'object' | 'array', ch: string): void {
    const frame = stack[stack.length - 1]
    if (!frame || frame.kind !== expected) {
      fail(`Unexpected '${ch}'`)
      return
    }
    stack.pop()
    afterValueMode()
  }

  function finishScalar(): void {
    // Numbers and literals close on the delimiter that follows them.
    closeLeaf(scalarBuffer)
    scalarBuffer = ''
  }

  function beginString(forKey: boolean): void {
    decodingKey = forKey
    stringBuffer = ''
    escapePending = false
    unicodePending = null
    heldHighSurrogate = null
    mode = forKey ? 'in-key' : 'in-string'
    if (!forKey) openLeaf('string')
  }

  function endString(): void {
    flushHeldSurrogate()
    if (decodingKey) {
      const frame = stack[stack.length - 1]
      if (frame) frame.key = stringBuffer
      mode = 'after-key'
    } else {
      closeLeaf(stringBuffer)
      afterValueMode()
    }
    stringBuffer = ''
  }

  function consumeStringChar(ch: string): void {
    if (unicodePending !== null) {
      unicodePending += ch
      if (unicodePending.length === 4) {
        if (!HEX_RE.test(unicodePending)) {
          fail(`Invalid unicode escape \\u${unicodePending}`)
          return
        }
        const code = Number.parseInt(unicodePending, 16)
        unicodePending = null
        const decoded = String.fromCharCode(code)
        if (code >= 0xd800 && code <= 0xdbff) {
          // Hold the high surrogate until its partner (or any other char)
          // arrives — never surface half a codepoint.
          flushHeldSurrogate()
          heldHighSurrogate = decoded
        } else {
          appendDecoded(decoded)
        }
      }
      return
    }

    if (escapePending) {
      escapePending = false
      switch (ch) {
        case '"': appendDecoded('"'); break
        case '\\': appendDecoded('\\'); break
        case '/': appendDecoded('/'); break
        case 'b': appendDecoded('\b'); break
        case 'f': appendDecoded('\f'); break
        case 'n': appendDecoded('\n'); break
        case 'r': appendDecoded('\r'); break
        case 't': appendDecoded('\t'); break
        case 'u': unicodePending = ''; break
        default: fail(`Invalid escape \\${ch}`)
      }
      return
    }

    if (ch === '\\') {
      escapePending = true
      return
    }
    if (ch === '"') {
      endString()
      return
    }
    appendDecoded(ch)
  }

  function consumeValueStart(ch: string): void {
    if (isJsonWhitespace(ch)) return
    if (ch === '"') { beginString(false); return }
    if (ch === '{') {
      enterContainer('object')
      mode = 'object-start'
      return
    }
    if (ch === '[') {
      enterContainer('array')
      mode = 'value-start'
      return
    }
    if (ch === ']' ) {
      // Empty array: '[' then ']'
      const frame = stack[stack.length - 1]
      if (frame?.kind === 'array' && frame.index === 0) {
        closeContainer('array', ch)
        return
      }
      fail(`Unexpected ']'`)
      return
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      openLeaf('number')
      scalarBuffer = ch
      mode = 'in-number'
      return
    }
    if (ch === 't' || ch === 'f') {
      openLeaf('boolean')
      scalarBuffer = ch
      mode = 'in-literal'
      return
    }
    if (ch === 'n') {
      openLeaf('null')
      scalarBuffer = ch
      mode = 'in-literal'
      return
    }
    fail(`Unexpected '${ch}'`)
  }

  function consumeChar(ch: string): void {
    switch (mode) {
      case 'value-start':
        consumeValueStart(ch)
        return

      case 'object-start':
        if (isJsonWhitespace(ch)) return
        if (ch === '"') { beginString(true); return }
        if (ch === '}') { closeContainer('object', ch); return }
        fail(`Unexpected '${ch}' in object`)
        return

      case 'key-start':
        if (isJsonWhitespace(ch)) return
        if (ch === '"') { beginString(true); return }
        fail(`Unexpected '${ch}' before key`)
        return

      case 'after-key':
        if (isJsonWhitespace(ch)) return
        if (ch === ':') { mode = 'value-start'; return }
        fail(`Expected ':' after key`)
        return

      case 'in-key':
      case 'in-string':
        consumeStringChar(ch)
        return

      case 'in-number':
        if (ch === '-' || ch === '+' || ch === '.' || ch === 'e' || ch === 'E' || (ch >= '0' && ch <= '9')) {
          scalarBuffer += ch
          if (currentField) currentField.value = scalarBuffer
          return
        }
        finishScalar()
        afterValueMode()
        consumeChar(ch)
        return

      case 'in-literal':
        scalarBuffer += ch
        if (scalarBuffer === 'true' || scalarBuffer === 'false' || scalarBuffer === 'null') {
          finishScalar()
          afterValueMode()
          return
        }
        if (!'true'.startsWith(scalarBuffer) && !'false'.startsWith(scalarBuffer) && !'null'.startsWith(scalarBuffer)) {
          fail(`Invalid literal '${scalarBuffer}'`)
        }
        return

      case 'after-value': {
        if (isJsonWhitespace(ch)) return
        const frame = stack[stack.length - 1]
        if (!frame) {
          fail(`Unexpected '${ch}' after top-level value`)
          return
        }
        if (ch === ',') {
          if (frame.kind === 'array') {
            frame.index += 1
            mode = 'value-start'
          } else {
            frame.key = ''
            mode = 'key-start'
          }
          return
        }
        if (ch === '}') { closeContainer('object', ch); return }
        if (ch === ']') { closeContainer('array', ch); return }
        fail(`Unexpected '${ch}'`)
        return
      }

      case 'done':
        if (isJsonWhitespace(ch)) return
        fail(`Trailing content after JSON value`)
        return

      case 'error':
        return
    }
  }

  // consumeChar mutates `mode` out of TS's narrowing sight — route the error
  // check through a helper so the loop's early-exit stays visible to the type
  // system without casts.
  function hasFailed(): boolean {
    return mode === 'error'
  }

  return {
    push(delta: string): void {
      charsReceived += delta.length
      if (hasFailed()) return
      for (let i = 0; i < delta.length; i++) {
        consumeChar(delta[i])
        if (hasFailed()) return
      }
    },

    view(): StreamingArgsView {
      return {
        fields,
        openPath: mode !== 'error' && currentField ? currentField.path : null,
        complete,
        charsReceived,
        ...(error ? { error } : {}),
      }
    },
  }
}

/** One-shot convenience for tests and non-incremental callers. */
export function parseStreamingArgs(text: string): StreamingArgsView {
  const parser = createStreamingArgsParser()
  parser.push(text)
  return parser.view()
}
