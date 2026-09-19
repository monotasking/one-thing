#!/usr/bin/env node
/**
 * gate:embed-runtime —— **嵌入器要在两个运行时下真跑得完,不许靠注释证明**。
 *
 * 这是根 CLAUDE.md 那条「原生模块只许 N-API,且不许靠注释证明 ABI」在**运行期**的
 * 另一半。`gate:native` 判的是「这块 `.node` 装不装得上」;这道门判的是「装上之后,
 * 连着跑一段真活,两个运行时下都不会把进程带走」。
 *
 * ## 起因(2026-09-18,桌面一天崩四次)
 *
 * 语义召回的嵌入器走 `onnxruntime-node`。ORT 的 **CPU 内存池**(`BFCArena`)每次扩容
 * 按 2 的幂翻倍、而且从不归还;每一批 32 条文本的 padding 长度各不相同,于是几批之内
 * 它就开口要 `posix_memalign(0x80000000)` —— 整整 2GiB。
 *
 *  - **系统 Node** 的 malloc 照给(顶多常驻涨到 1.2GB),所以 vitest / server / CLI
 *    一路绿灯,谁都没发现。
 *  - **Electron** 的 malloc 是 **PartitionAlloc**:单次申请到那一档它**不返回空指针**,
 *    直接 `EXC_BREAKPOINT`(SIGTRAP)掐掉整个进程。四份 .ips 同一条栈:
 *    `BFCArena::Extend` → `posix_memalign` → trap。原生 trap,JS 的 crash hook
 *    一行都写不出来,`app.jsonl` 里只有戛然而止。
 *
 * 修法是 `PIPELINE_OPTIONS` 里那一格 `enableCpuMemArena: false`
 * (`packages/onething-runtime/src/search/embedding/transformers-onnx.ts`)。
 * **这道门存在的唯一理由,就是那一格不许再靠一段注释活着。**
 *
 * ## 判据
 *
 *  ① **两个运行时都要跑完**:系统 Node 一遍、`ELECTRON_RUN_AS_NODE=1` 的 Electron
 *     一遍。任一非零退出即红,并把信号 / 退出码的**原话**打出来。`SIGTRAP` / `133`
 *     会被点名 —— 那一档就是 PartitionAlloc 拦下的超大单次申请。
 *  ② **Electron 下峰值 RSS ≤ 800MB**。这一条是**提前量**:没修那一版在翻到 2GiB
 *     之前就已经一路涨过 1.2GB,而修好之后实测 ≈239MB。所以它在进程还没死的时候就
 *     能抓到「内存池又被打开了」。Node 那半边**不设这条线** —— 它的 malloc 本来就
 *     照给,涨得高不高不是判据,它在这里当的是对照组。
 *
 * ## 跑的是产品自己的嵌入器
 *
 * 探针入口是 `scripts/gate-embed-runtime/entry.ts`,只 import
 * `createTransformersOnnxEmbedder`,一个 pipeline 选项都不替它做主;打包用的是**产品
 * 主进程同一份 esbuild 配方**(`shellEsbuildOptions`,原生相关一律 external,从仓的
 * node_modules 解析)。在门里抄一份选项就等于守着抄件 —— 那正是这道门要防的事。
 *
 * ## 模型从哪来 / 什么时候跳过
 *
 * 缺省 `<store>/models/embeddings/multilingual-e5-small`(store 根 =
 * `ONETHING_STORE_PATH` || `~/.onething`),`ONETHING_GATE_EMBED_MODEL_DIR` 可覆盖。
 * **只读,一个字节不写,不联网**(嵌入器本来就 `allowRemoteModels = false`)。
 * 目录不在 = **skipped + exit 0**,口径同 `gate:native` 在非 macOS 上跳过静态半边、
 * 同 `gate:search-index` ⑫ 的 opt-in —— 没有模型就没有推理可判,不冒充绿也不误报红。
 * 跳过那一行会打得很显眼,免得有人当成跑过了。
 *
 * 用法:`node scripts/gate-embed-runtime.mjs [--json]`
 * 旋钮:`ONETHING_GATE_EMBED_BATCHES`(缺省 40)、`ONETHING_GATE_EMBED_MODEL_DIR`、
 *       `ONETHING_GATE_EMBED_RSS_MB`(缺省 800)、`ONETHING_GATE_EMBED_TIMEOUT_MS`(缺省 10 分钟)。
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { shellEsbuildOptions } from '../apps/desktop-react/scripts/build-electron.mjs'
import { electronBinaryPath } from './gate-native-abi.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

/** 注册 id = 模型目录的那一层(`EmbedderCreateOptions.modelDir` 要的就是这一层)。 */
const EMBEDDER_ID = 'multilingual-e5-small'

const batches = Number.parseInt(process.env.ONETHING_GATE_EMBED_BATCHES ?? '40', 10)
const rssLimitMb = Number.parseInt(process.env.ONETHING_GATE_EMBED_RSS_MB ?? '800', 10)
const timeoutMs = Number.parseInt(process.env.ONETHING_GATE_EMBED_TIMEOUT_MS ?? '600000', 10)

/** store 根的判据与产品一致(`ONETHING_STORE_PATH` → `~/.onething`)。 */
function storeRoot() {
	const pinned = process.env.ONETHING_STORE_PATH
	return pinned !== undefined && pinned !== '' ? resolve(pinned) : join(homedir(), '.onething')
}

function modelDirPath() {
	const override = process.env.ONETHING_GATE_EMBED_MODEL_DIR
	if (override !== undefined && override !== '') return resolve(override)
	return join(storeRoot(), 'models', 'embeddings', EMBEDDER_ID)
}

/**
 * 产物落 `node_modules/.cache/` 下:那里被 git 忽略,而且**在 node_modules 里面** ——
 * external 掉的 `@huggingface/transformers` / `onnxruntime-node` 因此从仓自己的
 * node_modules 解析得到,不必给 esbuild 递任何路径。跑完删掉。
 */
const bundleDir = join(repoRoot, 'node_modules', '.cache', 'onething-gate-embed-runtime')
const bundleFile = join(bundleDir, 'probe.cjs')

async function buildProbe() {
	mkdirSync(bundleDir, { recursive: true })
	await build(shellEsbuildOptions({
		entryPoints: { probe: join(repoRoot, 'scripts/gate-embed-runtime/entry.ts') },
		outdir: bundleDir,
	}))
}

/** 在某个运行时下跑一遍探针,把读数 / 死法都带回来。 */
function runUnder(label, exe, extraEnv, modelDir) {
	const started = Date.now()
	const res = spawnSync(exe, [bundleFile], {
		cwd: repoRoot,
		encoding: 'utf8',
		timeout: timeoutMs,
		maxBuffer: 16 * 1024 * 1024,
		env: {
			...process.env,
			...extraEnv,
			ONETHING_GATE_EMBED_MODEL_DIR: modelDir,
			ONETHING_GATE_EMBED_BATCHES: String(batches),
		},
	})
	const wallMs = Date.now() - started
	const stdout = res.stdout ?? ''
	const stderr = res.stderr ?? ''
	const lines = stdout.split('\n').map(s => s.trim()).filter(Boolean)
	const progress = lines.filter(line => line.startsWith('batch ') || line.startsWith('ready '))

	const row = { label, exe, wallMs, progress, status: res.status, signal: res.signal ?? null }

	if (res.error) {
		row.ok = false
		row.message = res.error.message
		return row
	}

	const marker = stdout.indexOf('__GATE_EMBED_RESULT__')
	if (marker >= 0) {
		try {
			row.result = JSON.parse(stdout.slice(marker + '__GATE_EMBED_RESULT__'.length).split('\n')[0])
		} catch (err) {
			row.ok = false
			row.message = `结果那一行解析不了:${err.message}`
			return row
		}
	}

	if (res.status === 0 && row.result !== undefined) {
		row.ok = true
		return row
	}

	row.ok = false
	// **死法要说原话**。SIGTRAP / 133 单独点名:那一档不是「程序报了个错」,
	// 而是分配器在一次超大申请上直接把进程掐了(见文件头)。
	const trapped = res.signal === 'SIGTRAP' || res.status === 133
	const errMark = stderr.indexOf('__GATE_EMBED_ERROR__')
	const thrown = errMark >= 0 ? stderr.slice(errMark + '__GATE_EMBED_ERROR__'.length).trim() : stderr.trim()
	const how = res.signal !== null && res.signal !== undefined
		? `信号 ${res.signal}`
		: `退出码 ${res.status === null ? '(无)' : res.status}`
	row.message = [
		how,
		trapped ? 'SIGTRAP / exit 133 = 分配器当场掐进程,就是 PartitionAlloc 拦下一次 ≥2GiB 的单次申请那一类' : null,
		thrown ? thrown.split('\n').slice(0, 6).join(' / ').slice(0, 800) : null,
		progress.length > 0 ? `死在第 ${progress.length} 个读数之后(最后一行:${progress[progress.length - 1]})` : '一个读数都没打出来',
	].filter(Boolean).join(';')
	return row
}

function print(line) {
	if (!asJson) console.log(`[gate:embed-runtime] ${line}`)
}

async function main() {
	const modelDir = modelDirPath()
	const electron = electronBinaryPath()

	// ── 跳过口径:没有模型 / 没有 Electron,都没有东西可判。打得显眼,exit 0。
	const skipReason = !existsSync(modelDir)
		? `模型目录不在:${modelDir}\n`
			+ '           这道门只读已经下好的模型,不下载、不联网。要跑它,先在设置页「搜索 → 语义召回」\n'
			+ `           把模型下下来,或用 ONETHING_GATE_EMBED_MODEL_DIR 指向一份现成的 ${EMBEDDER_ID}。`
		: electron === undefined
			? 'node_modules/electron 没装或 dist 缺失 —— 这道门的另一半就是 Electron,没有它判不了。'
			: undefined

	if (skipReason !== undefined) {
		if (asJson) {
			process.stdout.write(`${JSON.stringify({ ok: true, skipped: true, reason: skipReason, modelDir }, null, 2)}\n`)
			process.exit(0)
		}
		console.log('[gate:embed-runtime] ============================================================')
		console.log('[gate:embed-runtime] skipped: 这道门这一次什么都没有验证。')
		console.log(`[gate:embed-runtime] skipped: ${skipReason}`)
		console.log('[gate:embed-runtime] ============================================================')
		process.exit(0)
	}

	print('嵌入器双运行时门(起因:2026-09-18 桌面一天崩四次,ORT CPU 内存池 × PartitionAlloc)')
	print(`模型目录 ${modelDir}(只读)`)
	print(`批次 ${batches} × 32 条变长文本;Electron 峰值 RSS 上限 ${rssLimitMb}MB`)
	print(`系统 Node ${process.versions.node} (MODULE_VERSION ${process.versions.modules})`)
	print(`Electron 二进制 ${electron}`)

	let red = 0
	const rows = []
	try {
		await buildProbe()
		print(`ok:   探针打包完成 ${bundleFile}`)

		const under = [
			{ label: 'node', exe: process.execPath, env: {}, rssLimit: undefined },
			{ label: 'electron', exe: electron, env: { ELECTRON_RUN_AS_NODE: '1' }, rssLimit: rssLimitMb },
		]
		for (const one of under) {
			print(`····  ${one.label} 起跑(单线程推理,几分钟很正常)`)
			const row = runUnder(one.label, one.exe, one.env, modelDir)
			for (const line of row.progress) print(`        ${one.label} | ${line}`)
			if (!row.ok) {
				red += 1
				print(`FAIL: ${one.label} 没跑完 —— ${row.message}`)
			} else {
				const r = row.result
				print(`ok:   ${one.label} ${r.batches} 批全过,峰值 RSS ${r.peakRssMb}MB,每批 ${r.msPerBatch}ms,ready ${r.readyMs}ms`)
				if (one.rssLimit !== undefined && r.peakRssMb > one.rssLimit) {
					red += 1
					row.ok = false
					row.rssOverBudget = true
					print(`FAIL: ${one.label} 峰值 RSS ${r.peakRssMb}MB 超过 ${one.rssLimit}MB —— `
						+ 'ORT 的 CPU 内存池像是又被打开了(修好那一版实测 ≈239MB)。')
				}
			}
			rows.push(row)
		}
	} finally {
		rmSync(bundleDir, { recursive: true, force: true })
	}

	if (asJson) {
		process.stdout.write(`${JSON.stringify({ ok: red === 0, modelDir, batches, rssLimitMb, rows }, null, 2)}\n`)
		process.exit(red === 0 ? 0 : 1)
	}

	print(`complete: 2 runtimes, ${red} failed`)
	if (red > 0) {
		console.error('[gate:embed-runtime] failed: 嵌入器在某个运行时下跑不完一段真活。')
		console.error('[gate:embed-runtime] failed: 先看 transformers-onnx.ts 的 PIPELINE_OPTIONS.session_options'
			+ ' —— `enableCpuMemArena: false` 还在不在。')
	}
	process.exit(red === 0 ? 0 : 1)
}

await main()
