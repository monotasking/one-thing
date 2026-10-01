/**
 * 陌生能力演练(法条「加功能不许改骨架」;`docs/design/reference-tag-2026-09.md` §3)。
 *
 * 编解码器那一句自我要求是「一个类型名都没有」。这只文件把它变成门,口径逐字
 * 照抄 `packages/core/resource/__tests__/stranger.test.ts`(同一条法条的同一种
 * 手段,那边扫 scheme,这边扫 type):
 *
 *   ① 现造一种设计时没想过的引用,走一遍全部六个口 —— 证明「不改骨架」是真的;
 *   ② **扫本目录的非测试文件,断言里面一个类型名都没有** —— 第一条只要写得出
 *      实现就会绿,第二条会在有人往 `ref-tag.ts` 里塞一行 `if (type === 'file')`
 *      的那天变红。
 *
 * 为什么按**词**扫而不是裸子串:`path` / `line` / `label` 这些**属性名**编解码器
 * 是认识的(缺省投影的次序就是拿它们排的,正本 §2.1 这么定的),被禁的只有
 * **类型名**。而 `reference` 这个类型名与本目录的名字、与 `RefTag` 的散文说明同形,
 * 所以它单独按「引号里的字面量」扫:`'reference'` / `"reference"` 是命中,
 * 「a reference tag」这样的散文不是。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	formatRefTag,
	parseRefTag,
	projectRefTagsToPlainText,
	scanRefTags,
	splitIncompleteRefTail,
} from '../ref-tag.js'

/** 一种编解码器从没听说过的引用。它只活在这只文件里。 */
const STRANGER_TYPE = 'drill-session'

/**
 * 内核不许提名字的类型全表:演练题那个,加上今天真登记的五种。加一种引用就往
 * 这里加一行 —— 这张表就是「core 里不出现任何能力的名字」的清单。
 */
const FORBIDDEN_TYPES = [
	STRANGER_TYPE,
	'file',
	'dir',
	'skill',
	'command',
	'reference',
] as const

/** 本目录里该有哪些非测试文件。写死,理由同 resource 那只:扫了零个文件的门永远绿。 */
const CODEC_FILES = ['index.ts', 'plain-text-stream.ts', 'ref-tag.ts']

describe('stranger reference drill: a type the codec has never heard of', () => {
	it('goes through every verb with no codec change', () => {
		const tag = {
			type: STRANGER_TYPE,
			attrs: { id: 'sess_1', message: 'msg_2', label: '那一条' },
		}

		const rendered = formatRefTag(tag)
		expect(rendered).toBe(
			`<ref type="${STRANGER_TYPE}" id="sess_1" message="msg_2" label="那一条"/>`,
		)
		expect(parseRefTag(rendered)).toEqual(tag)

		const text = `看 ${rendered} 这里`
		const [hit] = scanRefTags(text)
		expect(text.slice(hit.start, hit.end)).toBe(rendered)

		expect(projectRefTagsToPlainText(text)).toBe('看 那一条 这里')
		expect(
			projectRefTagsToPlainText(
				`看 <ref type="${STRANGER_TYPE}" id="sess_1"/>`,
			),
		).toBe('看 sess_1')

		expect(splitIncompleteRefTail(`看 <ref type="${STRANGER_TYPE}" id=`)).toEqual(
			{ head: '看 ', tail: `<ref type="${STRANGER_TYPE}" id=` },
		)
	})

	it('is not named anywhere in the codec — the gate for "加功能不许改骨架"', () => {
		const dir = fileURLToPath(new URL('../', import.meta.url))
		const files = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
			.map((entry) => entry.name)

		// 先确认真的扫到了东西。
		expect(files.sort()).toEqual(CODEC_FILES)

		const hits: string[] = []
		for (const type of FORBIDDEN_TYPES) {
			// 只认引号里的字面量:类型名是写进代码的字符串,散文不是。
			const named = new RegExp(`['"\`]${type}['"\`]`)
			for (const name of files) {
				if (named.test(readFileSync(join(dir, name), 'utf-8'))) {
					hits.push(`${name}:${type}`)
				}
			}
		}
		expect(hits).toEqual([])
	})
})
