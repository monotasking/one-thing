import { projectRefTagsToPlainText, splitIncompleteRefTail } from './ref-tag.js'

/**
 * The streaming companion of `projectRefTagsToPlainText`, for outlets that
 * receive a reply in pieces and forward each piece as it arrives.
 *
 * Projecting each piece on its own is not enough: a tag can be cut anywhere,
 * and half a tag projects to itself — so `<ref type="fi` reaches the chat
 * window as literal XML. This holds the unfinished tail back until it closes,
 * and releases it verbatim at the end of the stream, where an unfinished tag
 * has proven to be ordinary text.
 *
 * One instance per stream; it keeps no cross-stream state.
 */
export class RefTagPlainTextStream {
	private pending = ''

	/** Feed one piece; returns what is safe to forward now (possibly empty). */
	push(text: string): string {
		const { head, tail } = splitIncompleteRefTail(this.pending + text)
		this.pending = tail
		return head === '' ? '' : projectRefTagsToPlainText(head)
	}

	/** Whether anything is still being held back. */
	get held(): boolean {
		return this.pending !== ''
	}

	/** End of stream: release the held tail as the literal text it turned out to be. */
	flush(): string {
		const pending = this.pending
		this.pending = ''
		return pending === '' ? '' : projectRefTagsToPlainText(pending)
	}
}
