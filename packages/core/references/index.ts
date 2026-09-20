export {
	REF_TAG_MAX_TAIL_CHARS,
	defaultRefTagText,
	formatRefTag,
	isRefCloseTag,
	parseRefOpenTag,
	parseRefTag,
	projectRefTagsToPlainText,
	scanRefTags,
	splitIncompleteRefTail,
} from './ref-tag.js'
export type { RefTag, RefTagHit } from './ref-tag.js'

export { RefTagPlainTextStream } from './plain-text-stream.js'
