import { describe, expect, it } from 'vitest'
import {
	REF_TAG_MAX_TAIL_CHARS,
	defaultRefTagText,
	formatRefTag,
	isRefCloseTag,
	parseRefOpenTag,
	parseRefTag,
	projectRefTagsToPlainText,
	scanRefTags,
	splitIncompleteRefTail,
} from '../ref-tag.js'
import { RefTagPlainTextStream } from '../plain-text-stream.js'

describe('formatRefTag / parseRefTag', () => {
	it('round-trips the canonical form byte for byte', () => {
		const sources = [
			'<ref type="a" path="/Users/me/proj/src/a.ts" line="12-30" symbol="parseToken"/>',
			'<ref type="b" path="/Users/me/proj/src/"/>',
			'<ref type="c" name="some-name"/>',
			'<ref type="d" href="https://example.com/spec" title="RFC 9110 §15"/>',
			'<ref type="e"/>',
		]
		for (const source of sources) {
			const tag = parseRefTag(source)
			expect(tag, source).not.toBeNull()
			expect(formatRefTag(tag!)).toBe(source)
		}
	})

	it('renders type first and then attributes in insertion order', () => {
		const rendered = formatRefTag({
			type: 'x',
			attrs: { zebra: '1', alpha: '2' },
		})
		expect(rendered).toBe('<ref type="x" zebra="1" alpha="2"/>')
		// Deterministic: the same input renders the same bytes every time, which
		// is what keeps a replayed ledger identical.
		expect(formatRefTag(parseRefTag(rendered)!)).toBe(rendered)
	})

	it('round-trips the four escaped entities', () => {
		const attrs = { v: 'a & b < c > d " e' }
		const rendered = formatRefTag({ type: 'x', attrs })
		expect(rendered).toBe('<ref type="x" v="a &amp; b &lt; c &gt; d &quot; e"/>')
		expect(parseRefTag(rendered)?.attrs).toEqual(attrs)
	})

	it('does not decode an escaped ampersand twice', () => {
		const attrs = { v: '&lt;not a tag&gt;' }
		const rendered = formatRefTag({ type: 'x', attrs })
		expect(parseRefTag(rendered)?.attrs).toEqual(attrs)
	})

	it('keeps unknown attributes instead of rejecting them', () => {
		const tag = parseRefTag('<ref type="x" future="1" path="/a"/>')
		expect(tag?.attrs).toEqual({ future: '1', path: '/a' })
	})

	it('accepts the lenient form and takes its text as the label', () => {
		expect(parseRefTag('<ref type="x" path="/a">the parser</ref>')).toEqual({
			type: 'x',
			attrs: { path: '/a', label: 'the parser' },
		})
	})

	it('lets the lenient text win over a label attribute, in place', () => {
		const tag = parseRefTag('<ref type="x" label="old" path="/a">new</ref>')
		expect(tag?.attrs).toEqual({ label: 'new', path: '/a' })
		expect(formatRefTag(tag!)).toBe('<ref type="x" label="new" path="/a"/>')
	})

	it('refuses anything but exactly one whole tag', () => {
		expect(parseRefTag('before <ref type="x"/>')).toBeNull()
		expect(parseRefTag('<ref type="x"/> after')).toBeNull()
		expect(parseRefTag('<ref type="x"/><ref type="y"/>')).toBeNull()
	})

	it('refuses a tag without a legal type', () => {
		expect(parseRefTag('<ref path="/a"/>')).toBeNull()
		expect(parseRefTag('<ref type="File"/>')).toBeNull()
		expect(parseRefTag('<ref type="1x"/>')).toBeNull()
		expect(parseRefTag("<ref type='x'/>")).toBeNull()
		expect(parseRefTag('<ref type="x" bare/>')).toBeNull()
	})

	it('never spans a line', () => {
		expect(parseRefTag('<ref type="x"\n path="/a"/>')).toBeNull()
		expect(parseRefTag('<ref type="x">two\nlines</ref>')).toBeNull()
	})

	it('reads an attribute named __proto__ as data', () => {
		const tag = parseRefTag('<ref type="x" __proto__="boom"/>')
		expect(tag?.attrs.__proto__).toBe('boom')
		expect(Object.getPrototypeOf(tag!.attrs)).toBe(Object.prototype)
	})
})

describe('scanRefTags', () => {
	it('reports exact spans in mixed text', () => {
		const first = '<ref type="a" path="/x"/>'
		const second = '<ref type="b">label</ref>'
		const text = `look at ${first} and then ${second}.`

		const hits = scanRefTags(text)
		expect(hits).toHaveLength(2)

		expect(hits[0].start).toBe(text.indexOf(first))
		expect(hits[0].end).toBe(text.indexOf(first) + first.length)
		expect(text.slice(hits[0].start, hits[0].end)).toBe(first)
		expect(hits[0].tag).toEqual({ type: 'a', attrs: { path: '/x' } })

		expect(hits[1].start).toBe(text.indexOf(second))
		expect(hits[1].end).toBe(text.indexOf(second) + second.length)
		expect(hits[1].tag).toEqual({ type: 'b', attrs: { label: 'label' } })
	})

	it('skips a malformed tag and keeps scanning past it', () => {
		const hits = scanRefTags('<ref nope/> <ref type="a"/> <reference type="a"/>')
		expect(hits).toHaveLength(1)
		expect(hits[0].tag.type).toBe('a')
	})

	it('tolerates a `>` inside an attribute value', () => {
		const hits = scanRefTags('<ref type="a" label="a > b"/>')
		expect(hits).toHaveLength(1)
		expect(hits[0].tag.attrs.label).toBe('a > b')
	})

	it('leaves an unclosed lenient tag alone', () => {
		expect(scanRefTags('<ref type="a">dangling')).toEqual([])
	})
})

describe('parseRefOpenTag / isRefCloseTag', () => {
	it('reads a self-closing tag', () => {
		expect(parseRefOpenTag('<ref type="a" path="/x"/>')).toEqual({
			tag: { type: 'a', attrs: { path: '/x' } },
			selfClosing: true,
		})
	})

	it('reads an opening tag that expects a closer', () => {
		expect(parseRefOpenTag('<ref type="a">')).toEqual({
			tag: { type: 'a', attrs: {} },
			selfClosing: false,
		})
	})

	it('refuses anything beyond the tag itself', () => {
		expect(parseRefOpenTag('<ref type="a">text')).toBeNull()
		expect(parseRefOpenTag('<reference type="a">')).toBeNull()
	})

	it('recognises the closer', () => {
		expect(isRefCloseTag('</ref>')).toBe(true)
		expect(isRefCloseTag(' </ref>\n')).toBe(true)
		expect(isRefCloseTag('</reference>')).toBe(false)
	})
})

describe('splitIncompleteRefTail', () => {
	it.each([
		['<'],
		['<r'],
		['<re'],
		['<ref'],
		['<ref ty'],
		['<ref type="x" path="/a b/c.ts"'],
		['<ref type="x" path="/a>b"'],
		['<ref type="x">partial label'],
		['<ref type="x">partial</re'],
	])('holds back the unfinished tail %j', (tail) => {
		const result = splitIncompleteRefTail(`已经上屏的文字 ${tail}`)
		expect(result.tail).toBe(tail)
		expect(result.head).toBe('已经上屏的文字 ')
	})

	it.each([
		['<ref type="x"/>'],
		['<ref type="x">done</ref>'],
		['<reference'],
		['<refe'],
		['<ref nope="1"/>'],
	])('releases %j — it is finished or it is not a tag', (candidate) => {
		const text = `已经上屏的文字 ${candidate}`
		expect(splitIncompleteRefTail(text)).toEqual({ head: text, tail: '' })
	})

	it('gives up once the tail crosses a line', () => {
		const text = '<ref type="x"\nstill going'
		expect(splitIncompleteRefTail(text)).toEqual({ head: text, tail: '' })
	})

	it('gives up once the tail is longer than the window', () => {
		const long = `<ref type="x" label="${'a'.repeat(REF_TAG_MAX_TAIL_CHARS)}"`
		expect(splitIncompleteRefTail(long)).toEqual({ head: long, tail: '' })

		const short = `<ref type="x" label="${'a'.repeat(32)}"`
		expect(splitIncompleteRefTail(short).tail).toBe(short)
	})

	it('holds only the trailing `<` of an ordinary comparison', () => {
		expect(splitIncompleteRefTail('a < b')).toEqual({
			head: 'a < b',
			tail: '',
		})
		expect(splitIncompleteRefTail('a < b <')).toEqual({
			head: 'a < b ',
			tail: '<',
		})
	})

	it('does not hold a finished tag that is followed by a stray `<`', () => {
		const text = '<ref type="x"/> and a < b'
		expect(splitIncompleteRefTail(text)).toEqual({ head: text, tail: '' })
	})

	it('holds nothing when there is nothing tag-like at the end', () => {
		expect(splitIncompleteRefTail('plain words')).toEqual({
			head: 'plain words',
			tail: '',
		})
	})
})

describe('projectRefTagsToPlainText', () => {
	it('uses the default projection order', () => {
		expect(
			projectRefTagsToPlainText('see <ref type="a" label="here" path="/x"/>'),
		).toBe('see here')
		expect(
			projectRefTagsToPlainText('see <ref type="a" path="/x" line="12"/>'),
		).toBe('see /x:12')
		expect(projectRefTagsToPlainText('see <ref type="a" path="/x"/>')).toBe(
			'see /x',
		)
		expect(
			projectRefTagsToPlainText('see <ref type="a" href="https://x/"/>'),
		).toBe('see https://x/')
		expect(projectRefTagsToPlainText('see <ref type="a" name="n"/>')).toBe(
			'see n',
		)
	})

	it('falls back to the first attribute and then to the type', () => {
		expect(defaultRefTagText({ type: 'a', attrs: { other: 'v' } })).toBe('v')
		expect(defaultRefTagText({ type: 'a', attrs: {} })).toBe('a')
	})

	it('lets a describe hook override one kind and pass on the rest', () => {
		const text = '<ref type="a" name="c"/> then <ref type="b" name="d"/>'
		expect(
			projectRefTagsToPlainText(text, (tag) =>
				tag.type === 'a' ? `/${tag.attrs.name}` : null,
			),
		).toBe('/c then d')
	})

	it('is idempotent and leaves untagged text untouched', () => {
		const once = projectRefTagsToPlainText('a <ref type="a" path="/x"/> b')
		expect(projectRefTagsToPlainText(once)).toBe(once)
		expect(projectRefTagsToPlainText('nothing here')).toBe('nothing here')
	})
})

describe('RefTagPlainTextStream', () => {
	it('never forwards half a tag', () => {
		const stream = new RefTagPlainTextStream()
		const source = 'open <ref type="a" path="/x"/> done'
		let out = ''
		for (const char of source) {
			const piece = stream.push(char)
			expect(piece).not.toMatch(/<ref/)
			out += piece
		}
		out += stream.flush()
		expect(out).toBe('open /x done')
		expect(stream.held).toBe(false)
	})

	it('releases an unfinished tag verbatim when the stream ends', () => {
		const stream = new RefTagPlainTextStream()
		expect(stream.push('text <ref type="a"')).toBe('text ')
		expect(stream.held).toBe(true)
		expect(stream.flush()).toBe('<ref type="a"')
		expect(stream.flush()).toBe('')
	})
})
