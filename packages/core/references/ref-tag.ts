/**
 * The `<ref/>` codec (`docs/design/reference-tag-2026-09.md` §2.1).
 *
 * One tag, self-closing, attributes are the data:
 *
 *     <ref type="…" path="…" line="12-30"/>
 *
 * **This module does not know a single kind.** It reads `type` as an opaque
 * string and every attribute as an opaque string; what a kind means, which
 * attributes it takes and how it is drawn live in the tables that read this
 * codec — `packages/onething-runtime/src/references/types/` on the wire side and
 * the shell's own registry on the drawing side. Adding a kind must not touch
 * this file, which is the whole reason it exists.
 *
 * Grammar, in full:
 *
 *   - the tag name is always `ref`; `type` is required and matches
 *     `[a-z][a-z0-9-]*`;
 *   - every other attribute is `name="value"`, **double quotes only**, with
 *     `& < > "` written as `&amp; &lt; &gt; &quot;`;
 *   - attribute order carries no meaning and unknown attributes are kept rather
 *     than rejected, so an older reader keeps working when a newer writer adds
 *     one;
 *   - the canonical form is self-closing; the lenient form
 *     `<ref …>text</ref>` is also accepted and its text becomes `label`,
 *     because models write it that way and accepting it is cheaper than
 *     teaching them not to;
 *   - **a tag never spans a line**. That single restriction is what makes the
 *     streaming half tractable: an unfinished `<ref` reaches at most to the end
 *     of its line, so the held-back tail is bounded (see
 *     `splitIncompleteRefTail`).
 *
 * Fenced and inline code are literal text by construction — a markdown parser
 * never hands their contents to a scanner — so there is no rule for them here.
 */

/** A parsed tag. `attrs` never contains `type`; `label`, when present, does. */
export interface RefTag {
	type: string
	attrs: Readonly<Record<string, string>>
}

/** A tag found inside a longer text, with its half-open span `[start, end)`. */
export interface RefTagHit {
	tag: RefTag
	start: number
	end: number
}

const TAG_OPEN = '<ref'
const TAG_CLOSE = '</ref>'
const TYPE_ATTRIBUTE = 'type'
const LABEL_ATTRIBUTE = 'label'

const TYPE_PATTERN = /^[a-z][a-z0-9-]*$/
/** `\s*name\s*=\s*"value"`, sticky so the body is consumed left to right. */
const ATTRIBUTE_PATTERN = /\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/y

/**
 * How far back the streaming split is willing to look for an unfinished tag.
 * Anything longer is prose that happens to contain a `<`, not a tag being
 * typed — holding it back would swallow real text.
 */
export const REF_TAG_MAX_TAIL_CHARS = 512

/**
 * Render the canonical form. Attribute order is the insertion order of
 * `attrs`, with `type` always first — the output has to be deterministic
 * because it is persisted into the session ledger and replayed byte for byte
 * on every history rebuild.
 */
export function formatRefTag(tag: RefTag): string {
	const parts = [`${TYPE_ATTRIBUTE}="${encodeEntities(tag.type)}"`]
	for (const [name, value] of Object.entries(tag.attrs)) {
		if (name === TYPE_ATTRIBUTE) continue
		parts.push(`${name}="${encodeEntities(value)}"`)
	}
	return `<ref ${parts.join(' ')}/>`
}

/**
 * Parse a string that is expected to be exactly one tag, in either form.
 * Anything else — surrounding text, two tags, a malformed one — answers null.
 *
 * `formatRefTag(parseRefTag(s)) === s` holds for every canonical `s`.
 */
export function parseRefTag(source: string): RefTag | null {
	const hits = scanRefTags(source)
	if (hits.length !== 1) return null
	const [hit] = hits
	if (hit.start !== 0 || hit.end !== source.length) return null
	return hit.tag
}

/** Every tag in a text, in order, both forms, non-overlapping. */
export function scanRefTags(text: string): RefTagHit[] {
	const hits: RefTagHit[] = []
	let from = 0

	while (from < text.length) {
		const start = text.indexOf(TAG_OPEN, from)
		if (start === -1) break

		const open = readOpenTag(text, start)
		if (open.status !== 'complete' || !open.tag) {
			from = start + TAG_OPEN.length
			continue
		}

		if (open.selfClosing) {
			hits.push({ tag: open.tag, start, end: open.end })
			from = open.end
			continue
		}

		const close = readCloseTag(text, open.end)
		if (close === null) {
			from = open.end
			continue
		}

		const label = decodeEntities(text.slice(open.end, close.start))
		hits.push({ tag: withLabel(open.tag, label), start, end: close.end })
		from = close.end
	}

	return hits
}

/**
 * Parse one opening tag on its own — what a markdown `html` node hands over.
 * `selfClosing: false` means the caller has to go find the matching close node
 * itself and fold the text between into `label`.
 */
export function parseRefOpenTag(
	source: string,
): { tag: RefTag; selfClosing: boolean } | null {
	const trimmed = source.trim()
	const open = readOpenTag(trimmed, 0)
	if (open.status !== 'complete' || !open.tag) return null
	if (open.end !== trimmed.length) return null
	return { tag: open.tag, selfClosing: open.selfClosing }
}

/** Whether a string is the closing half of the lenient form. */
export function isRefCloseTag(source: string): boolean {
	return source.trim() === TAG_CLOSE
}

/**
 * Split a still-growing text into the part that is safe to render and the
 * unfinished tag at its end.
 *
 * Without this, a tag arriving token by token is drawn as text (`<ref type="fi`)
 * and then swapped for a chip when it closes — one visible flicker per tag.
 * The tail is held back instead, so the first thing ever drawn is the chip.
 *
 * A tail is only held when it looks like a tag being typed: a prefix of `<ref`,
 * or `<ref` followed by a boundary character and not yet closed. It is given up
 * — left in `head` as the literal text it evidently is — as soon as it contains
 * a newline or grows past `REF_TAG_MAX_TAIL_CHARS`. At the end of a stream the
 * caller simply stops splitting: whatever never closed was always literal.
 */
export function splitIncompleteRefTail(text: string): {
	head: string
	tail: string
} {
	const floor = Math.max(0, text.length - REF_TAG_MAX_TAIL_CHARS)
	for (let index = text.length - 1; index >= floor; index -= 1) {
		if (text[index] !== '<') continue
		const candidate = text.slice(index)
		// A newline here means every earlier candidate contains one too.
		if (candidate.includes('\n')) break
		if (isIncompleteRefTail(candidate)) {
			return { head: text.slice(0, index), tail: candidate }
		}
	}
	return { head: text, tail: '' }
}

/**
 * Replace every tag with the words a reader should see instead. The outlets
 * that have no chips to draw — IM channels, the CLI's human output — go through
 * here, because XML reaching a chat window is an incident.
 *
 * `describe` lets a caller that owns a kind table override one kind's wording;
 * answering null falls back to `defaultRefTagText`.
 */
export function projectRefTagsToPlainText(
	text: string,
	describe?: (tag: RefTag) => string | null,
): string {
	const hits = scanRefTags(text)
	if (hits.length === 0) return text

	let out = ''
	let cursor = 0
	for (const hit of hits) {
		out += text.slice(cursor, hit.start)
		out += describe?.(hit.tag) ?? defaultRefTagText(hit.tag)
		cursor = hit.end
	}
	return out + text.slice(cursor)
}

/**
 * The words a tag stands for when nobody has said otherwise: whatever it was
 * labelled, else the most address-like attribute it carries, else its first
 * attribute — and only if it has none at all, the bare `type`. **Never empty**:
 * a projection that dropped the tag would delete what the sentence was about.
 */
export function defaultRefTagText(tag: RefTag): string {
	const { attrs } = tag

	const label = attrs[LABEL_ATTRIBUTE]
	if (label) return label

	const path = attrs.path
	if (path) return attrs.line ? `${path}:${attrs.line}` : path

	const href = attrs.href
	if (href) return href

	const name = attrs.name
	if (name) return name

	for (const value of Object.values(attrs)) {
		if (value) return value
	}
	return tag.type
}

/** Result of walking an opening tag. `tag` is null when the syntax is wrong. */
interface OpenTagScan {
	/**
	 * `complete` — a `>` was reached; `partial` — the text ran out first (this is
	 * the streaming case); `invalid` — not an opening tag at all.
	 */
	status: 'complete' | 'partial' | 'invalid'
	tag: RefTag | null
	end: number
	selfClosing: boolean
}

const INVALID_OPEN_TAG: OpenTagScan = {
	status: 'invalid',
	tag: null,
	end: -1,
	selfClosing: false,
}

function readOpenTag(text: string, start: number): OpenTagScan {
	if (!text.startsWith(TAG_OPEN, start)) return INVALID_OPEN_TAG

	// `<reference …>` is a different tag that happens to share a prefix. The
	// name only ends at whitespace, `/` or `>`.
	const boundary = text[start + TAG_OPEN.length]
	if (boundary === undefined) {
		return { status: 'partial', tag: null, end: -1, selfClosing: false }
	}
	if (!isTagNameBoundary(boundary)) return INVALID_OPEN_TAG

	let inQuote = false
	for (let index = start + TAG_OPEN.length; index < text.length; index += 1) {
		const char = text[index]
		// One tag, one line — a newline ends the search rather than the tag.
		if (char === '\n') return INVALID_OPEN_TAG
		if (char === '"') {
			inQuote = !inQuote
			continue
		}
		if (inQuote) continue
		// A second `<` before this one closed: whatever this is, it is not a tag.
		if (char === '<') return INVALID_OPEN_TAG
		if (char !== '>') continue

		const selfClosing = text[index - 1] === '/'
		const body = text.slice(
			start + TAG_OPEN.length,
			selfClosing ? index - 1 : index,
		)
		return {
			status: 'complete',
			tag: parseAttributes(body),
			end: index + 1,
			selfClosing,
		}
	}

	return { status: 'partial', tag: null, end: -1, selfClosing: false }
}

function isTagNameBoundary(char: string): boolean {
	return char === '/' || char === '>' || /\s/.test(char)
}

function parseAttributes(body: string): RefTag | null {
	// A Map, not an object literal: insertion order is the contract and
	// `fromEntries` defines own properties, so an attribute called `__proto__`
	// lands as data rather than as a prototype.
	const attrs = new Map<string, string>()
	let type: string | undefined
	let cursor = 0

	for (;;) {
		ATTRIBUTE_PATTERN.lastIndex = cursor
		const match = ATTRIBUTE_PATTERN.exec(body)
		if (!match) break
		cursor = ATTRIBUTE_PATTERN.lastIndex

		const name = match[1]
		const value = decodeEntities(match[2])
		if (name === TYPE_ATTRIBUTE) {
			// First occurrence wins, so a duplicate is deterministic rather than an
			// error the writer never sees.
			if (type === undefined) type = value
			continue
		}
		if (!attrs.has(name)) attrs.set(name, value)
	}

	// Anything the attribute grammar could not consume means this is not a tag.
	if (body.slice(cursor).trim() !== '') return null
	if (type === undefined || !TYPE_PATTERN.test(type)) return null

	return { type, attrs: Object.fromEntries(attrs) }
}

function readCloseTag(
	text: string,
	from: number,
): { start: number; end: number } | null {
	const close = text.indexOf(TAG_CLOSE, from)
	if (close === -1) return null
	const inner = text.slice(from, close)
	// No nesting, no line breaks: the lenient form holds plain label text only.
	if (inner.includes('\n') || inner.includes('<')) return null
	return { start: close, end: close + TAG_CLOSE.length }
}

function withLabel(tag: RefTag, label: string): RefTag {
	if (label.trim() === '') return tag
	const attrs = new Map(Object.entries(tag.attrs))
	// `Map.set` keeps an existing key in place, so the attribute order — and
	// therefore the rendered bytes — does not depend on which form was written.
	attrs.set(LABEL_ATTRIBUTE, label)
	return { type: tag.type, attrs: Object.fromEntries(attrs) }
}

function isIncompleteRefTail(candidate: string): boolean {
	if (candidate.length < TAG_OPEN.length) {
		return TAG_OPEN.startsWith(candidate)
	}
	if (!candidate.startsWith(TAG_OPEN)) return false

	const open = readOpenTag(candidate, 0)
	if (open.status === 'partial') return true
	if (open.status === 'invalid') return false
	// A complete tag whose attributes do not parse is literal text, not a tag
	// still being typed — releasing it is the honest answer.
	if (!open.tag) return false
	if (open.selfClosing) return false
	return readCloseTag(candidate, open.end) === null
}

function encodeEntities(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

function decodeEntities(value: string): string {
	// The reverse of the encode order — `&amp;` last — so a value that really
	// contained `&lt;` comes back as `&lt;` and not as `<`.
	return value
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, '>')
		.replace(/&lt;/g, '<')
		.replace(/&amp;/g, '&')
}
