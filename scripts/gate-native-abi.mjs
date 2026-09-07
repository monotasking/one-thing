#!/usr/bin/env node
/**
 * gate:native —— **原生模块只许 N-API,且不许靠注释证明 ABI**(根 CLAUDE.md 立法,
 * 2026-09-02;起因:`electron-builder.yml` 里写着「better-sqlite3 已按 Electron ABI
 * 编好」,实测它按 Node 22 v127 编、在 Electron v145 下加载失败,这句假话活了两个月)。
 *
 * ## 这道门判什么
 *
 * 同一份 `node_modules` 要同时喂两个运行时:桌面是 **Electron**(自带一份 V8 与它自己
 * 的 `NODE_MODULE_VERSION`),server / CLI / vitest 是**系统 Node**(另一份)。V8 ABI
 * 专属的 `.node` 在结构上就不可能两边都对。N-API 插件不同 —— 它只依赖 Node 导出的那套
 * ABI 稳定的 C 接口(`napi_*`),一块二进制两个运行时通吃。
 *
 * 于是每块二进制过两半判据:
 *
 *   ① **动态半边(真跑)**:在系统 Node 与 `ELECTRON_RUN_AS_NODE=1` 的 Electron 下各
 *      加载一次。任一失败即红,并把运行时自己的原话打出来(`NODE_MODULE_VERSION` 不符
 *      长什么样,由报错说了算,不由这个脚本转述)。
 *   ② **静态半边(`nm -u`,仅 macOS)**:扫未定义符号。出现 `_v8…` / `node::…` /
 *      `_ZN2v8…` 这类 V8 / Node 内部符号,就说明它绑的是 V8 ABI 而非 N-API —— 当场红,
 *      不必等到某天换 Electron 版本才炸。非 macOS 跳过这一半并打印跳过理由(Linux 的
 *      `nm -D` / Windows 的 dumpbin 判据不同,没验过的判据不冒充绿)。
 *
 * ## 为什么不是「查 package.json 有没有写 napi」
 *
 * 因为那又是一句注释。门必须真的把二进制喂给两个运行时。
 *
 * ## 覆盖面
 *
 * 枚举**这个仓今天真的装了 / 真的产出**的原生插件:
 *   - `fsevents`(macOS workspace watch 的 optional 运行依赖)
 *   - `node-pty`(终端)
 *   - `sherpa-onnx-node` + 当前平台的 `sherpa-onnx-<platform>-<arch>`(语音)
 *   - `onnxruntime-node` 与 `@img/sharp-<platform>-<arch>`(S7 起随
 *     `@huggingface/transformers` 进 node_modules;**产品不加载它们**——嵌入器写死
 *     `device: 'wasm'`——但它们真的被打进 app,而法条判的是「真的装了 / 真的产出」)
 *   - `sqlite-vec` 当前平台的 `vec0.dylib` / `.so` / `.dll`(语义召回,S7)——
 *     它**不是 Node 插件**,是一个 SQLite 可加载扩展,所以两半判据都换了尺子:
 *     动态半边不是 `process.dlopen`,而是
 *     `new DatabaseSync(':memory:', { allowExtension: true }).loadExtension(path)`
 *     再跑一句 `select vec_version()`(能装上还得真能用);静态半边不看 `napi_*`
 *     ——SQLite 扩展靠 `sqlite3_api` 结构体调宿主,一个 sqlite3 符号都不必导入
 *     ——只判「有没有 V8 / Node 内部符号」,那一条与别的目标逐字相同。
 * 没装 / 没构建的条目记 SKIP 并说明,不冒充绿也不误报红 —— 一块不存在的二进制没有 ABI
 * 可判。真正的红只有两种:**存在但装不上**,和**存在但绑了 V8 内部符号**。
 *
 * 用法:`node scripts/gate-native-abi.mjs [--json]`
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

/** 一条目标:名字 + 一段「在某个运行时里把它加载起来」的源码 + 要 nm 的那块二进制。 */
function targets() {
	const list = []

	// macOS workspace watching uses this optional runtime N-API addon. It is
	// intentionally not installed or required by Linux/Windows builds.
	if (process.platform === 'darwin') {
		list.push({
			name: 'fsevents',
			kind: 'require',
			specifier: 'fsevents',
			binary: join(repoRoot, 'node_modules', 'fsevents', 'fsevents.node'),
			packageDir: join(repoRoot, 'node_modules', 'fsevents'),
		})
	}

	// ── node-pty:一个普通的 npm 原生包,require 包名即可(它自己去找 .node)。
	list.push({
		name: 'node-pty',
		kind: 'require',
		specifier: 'node-pty',
		binary: findNodeAddon(join(repoRoot, 'node_modules', 'node-pty')),
		packageDir: join(repoRoot, 'node_modules', 'node-pty'),
	})

	// ── sherpa-onnx-node:壳包,真二进制在平台包里。两个都过门:壳包证明 require 链通,
	//    平台包证明那块 .node 本身是 N-API。
	list.push({
		name: 'sherpa-onnx-node',
		kind: 'require',
		specifier: 'sherpa-onnx-node',
		binary: findNodeAddon(join(repoRoot, 'node_modules', 'sherpa-onnx-node')),
		packageDir: join(repoRoot, 'node_modules', 'sherpa-onnx-node'),
	})
	const platformPkg = `sherpa-onnx-${process.platform}-${process.arch}`
	const platformDir = join(repoRoot, 'node_modules', platformPkg)
	list.push({
		name: platformPkg,
		kind: 'dlopen',
		binary: findNodeAddon(platformDir),
		packageDir: platformDir,
	})

	// ── sqlite-vec(检索重建 S7):SQLite 可加载扩展,不是 Node 插件。见文件头。
	const vecPkg = sqliteVecPlatformPackage()
	const vecDir = join(repoRoot, 'node_modules', vecPkg)
	list.push({
		name: vecPkg,
		kind: 'sqlite-extension',
		binary: findSqliteExtension(vecDir),
		packageDir: vecDir,
		hint: '`bun install` 会按平台装 sqlite-vec-<os>-<arch>;这台机器上没装就没有 ABI 可判',
	})

	/*
	 * ── `@huggingface/transformers` 拖进来的两个原生包(检索重建 S7)。
	 *
	 * 我们**不用**它们:拍点癸 a 选的是 wasm 后端,嵌入器里 `device: 'wasm'` 是写死的。
	 * 但它们真的躺在 `node_modules` 里、也真的被 electron-builder 打进了 app
	 * (`onnxruntime-node` 的 `bin/napi-v3/**` 与 `@img/sharp-<platform>`),
	 * 而法条判的是「这个仓真的装了 / 真的产出」的每一块二进制 —— 用不用是另一回事。
	 * 所以它们进这张表:是 N-API 就绿,不是就当场红。
	 */
	const ortNodeDir = join(repoRoot, 'node_modules', 'onnxruntime-node')
	list.push({
		name: 'onnxruntime-node',
		kind: 'dlopen',
		binary: join(ortNodeDir, 'bin', 'napi-v3', process.platform, process.arch, 'onnxruntime_binding.node'),
		packageDir: ortNodeDir,
		hint: 'onnxruntime-node 只对部分平台发 prebuild',
	})
	const sharpPkg = `sharp-${process.platform}-${process.arch}`
	const sharpDir = join(repoRoot, 'node_modules', '@img', sharpPkg)
	list.push({
		name: `@img/${sharpPkg}`,
		kind: 'dlopen',
		binary: findNodeAddon(sharpDir),
		packageDir: sharpDir,
		hint: 'sharp 按平台发子包;这台机器上没装就没有 ABI 可判',
	})

	return list
}

/** `sqlite-vec` 自己那套平台包命名(win32 → windows,其余同 process.platform)。 */
function sqliteVecPlatformPackage() {
	const os = process.platform === 'win32' ? 'windows' : process.platform
	return `sqlite-vec-${os}-${process.arch}`
}

/** 平台包里那一份 `vec0.<后缀>`。 */
function findSqliteExtension(pkgDir) {
	if (!existsSync(pkgDir)) return undefined
	const suffix = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'
	const file = join(pkgDir, `vec0.${suffix}`)
	return existsSync(file) ? file : undefined
}

/**
 * 在一个包目录里找**这台机器真会加载的那块** `.node`。
 *
 * 落点三种:包根(sherpa 平台包)、`build/Release`(node-gyp 产物)、
 * `prebuilds/<platform>-<arch>/`(prebuildify,node-pty 走这条)。
 * prebuilds 下必须按 `${process.platform}-${process.arch}` 精确取 —— 那里同时躺着
 * win32/linux 各档,随手取第一个会去 nm 一块 Windows DLL,读数没有意义。
 */
function findNodeAddon(pkgDir) {
	if (!existsSync(pkgDir)) return undefined
	const flat = [pkgDir, join(pkgDir, 'build', 'Release'), join(pkgDir, 'lib')]
	const here = join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`)
	for (const dir of [here, ...flat]) {
		if (!existsSync(dir)) continue
		let names
		try {
			names = readdirSync(dir)
		} catch {
			continue
		}
		const hit = names.find(n => n.endsWith('.node'))
		if (hit) return join(dir, hit)
	}
	return undefined
}

/** Electron 二进制的路径:`require('electron')` 导出的就是它。 */
function electronBinaryPath() {
	const pathFile = join(repoRoot, 'node_modules', 'electron', 'path.txt')
	const distDir = join(repoRoot, 'node_modules', 'electron', 'dist')
	if (!existsSync(pathFile) || !existsSync(distDir)) return undefined
	const rel = readFileSync(pathFile, 'utf8').trim()
	const full = join(distDir, rel)
	return existsSync(full) ? full : undefined
}

/** 一段在任意运行时里跑的加载程序:成功打 OK + versions,失败把原话吐到 stderr。 */
function loaderSource(target) {
	const payload = JSON.stringify({ kind: target.kind, specifier: target.specifier ?? null, binary: target.binary ?? null })
	return `
const t = ${payload};
try {
  if (t.kind === 'require') {
    const { createRequire } = require('node:module');
    const req = createRequire(${JSON.stringify(join(repoRoot, 'package.json'))});
    req(t.specifier);
  } else if (t.kind === 'sqlite-extension') {
    // SQLite 可加载扩展:装得上还不够,得真能用 —— 所以跑一句 vec_version()。
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:', { allowExtension: true });
    if (typeof db.enableLoadExtension === 'function') db.enableLoadExtension(true);
    db.loadExtension(t.binary);
    const row = db.prepare('SELECT vec_version() AS v').get();
    if (!row || typeof row.v !== 'string') throw new Error('loadExtension 过了,但 vec_version() 答不出来');
    db.close();
  } else {
    const m = { exports: {} };
    process.dlopen(m, t.binary);
  }
  process.stdout.write('__GATE_OK__' + JSON.stringify({
    node: process.versions.node,
    modules: process.versions.modules,
    electron: process.versions.electron || null,
  }));
} catch (err) {
  process.stderr.write('__GATE_ERR__' + (err && err.message ? err.message : String(err)));
  process.exit(3);
}
`
}

function runUnder(exe, target, extraEnv) {
	const res = spawnSync(exe, ['-e', loaderSource(target)], {
		cwd: repoRoot,
		encoding: 'utf8',
		env: { ...process.env, ...extraEnv },
		timeout: 120000,
	})
	const stdout = res.stdout ?? ''
	const stderr = res.stderr ?? ''
	if (res.error) return { ok: false, message: res.error.message }
	if (stdout.includes('__GATE_OK__')) {
		let versions = {}
		try {
			versions = JSON.parse(stdout.slice(stdout.indexOf('__GATE_OK__') + '__GATE_OK__'.length))
		} catch { /* 版本读不出来不影响「加载成功」这个判据 */ }
		return { ok: true, versions }
	}
	const marked = stderr.indexOf('__GATE_ERR__')
	const message = marked >= 0
		? stderr.slice(marked + '__GATE_ERR__'.length).trim()
		: (stderr.trim() || stdout.trim() || `exit ${res.status}`)
	// **整条原话都要留**:`NODE_MODULE_VERSION 127 vs 145` 那句在 Node 的报错里是
	// 第二、三行,按第一行截断正好把唯一有用的读数扔掉(施工中真踩过)。折行成一行,
	// 尾部再截长。
	const flattened = message.split('\n').map(s => s.trim()).filter(Boolean).join(' / ')
	return { ok: false, message: flattened.slice(0, 600) }
}

/**
 * 静态半边的两条判据。
 *
 * `nm -u` 打的是**这块 .node 要向宿主要的符号**。要什么,就等于绑了谁的 ABI:
 *  - `napi_*` —— 向 Node 要那套 ABI 稳定的 C 接口。这是 N-API,两个运行时通吃。
 *  - `_ZN2v8…` / `_ZN4node…`(C++ mangled)或 `_node_module_register`(老 NODE_MODULE
 *    宏的注册入口)—— 绑的是 V8 / Node 的内部 ABI,换一版 V8 就 NODE_MODULE_VERSION 不符。
 *
 * Mach-O 的符号带前导下划线(`_napi_get_boolean`),所以正则里不能用 `\b`。
 */
const V8_SYMBOL = /(_ZN2v8|_ZN4node|_ZNK2v8|_ZNK4node|node_module_register|^_+v8[A-Z])/
const NAPI_SYMBOL = /napi_/

/**
 * SQLite 扩展那一档的白名单(S7)。允许两类:`sqlite3_*`(直接调 sqlite 的口)与
 * **libc**(前导下划线开头的 C 运行时符号,`___memcpy_chk` / `_strtod` 这些)。
 * 本机 `vec0.dylib` 的读数是 21 条未定义符号、**全是 libc、零个 sqlite3_**
 * —— 扩展靠 `sqlite3_api` 结构体调宿主,不必导入 sqlite3 符号。所以这条规则的
 * 实际作用是**兜住第三类**:哪天有人拿一个偷偷链了 V8 的东西冒充「纯 C 扩展」,
 * 它在这里当场露馅。
 */
const SQLITE_EXTENSION_ALLOWED = /^_{1,3}(sqlite3_|[a-z])/

function scanUndefinedSymbols(binary, kind) {
	if (process.platform !== 'darwin') {
		return { checked: false, reason: `nm -u 判据只在 macOS 验过,${process.platform} 上跳过(不冒充绿)` }
	}
	let out
	try {
		out = execFileSync('nm', ['-u', binary], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
	} catch (err) {
		return { checked: false, reason: `nm -u 跑不动:${err.message.split('\n')[0]}` }
	}
	const lines = out.split('\n').map(s => s.trim()).filter(Boolean)
	const offenders = kind === 'sqlite-extension'
		? lines.filter(line => V8_SYMBOL.test(line) || !SQLITE_EXTENSION_ALLOWED.test(line))
		: lines.filter(line => V8_SYMBOL.test(line))
	const napiCount = lines.filter(line => NAPI_SYMBOL.test(line)).length
	return { checked: true, total: lines.length, napiCount, offenders: offenders.slice(0, 12) }
}

function main() {
	const electron = electronBinaryPath()
	const rows = []
	let red = 0

	for (const target of targets()) {
		const row = { name: target.name, binary: target.binary ?? null, status: 'ok', notes: [] }

		if (target.onlyOn && process.platform !== target.onlyOn) {
			row.status = 'skip'
			row.notes.push(`只在 ${target.onlyOn} 上存在,当前 ${process.platform}`)
			rows.push(row)
			continue
		}
		// `dlopen` 档非要那块 .node 不可;`require` 档只要包在就跑得动加载判据
		// (壳包 —— 比如 sherpa-onnx-node —— 自己不带二进制,真二进制在平台包里,
		// 那一块由平台包那一行去 nm;这一行判的是「整条 require 链在两个运行时下通不通」)。
		const packagePresent = existsSync(target.packageDir)
		const binaryPresent = Boolean(target.binary) && existsSync(target.binary)
		const needsBinary = target.kind === 'dlopen' || target.kind === 'sqlite-extension'
		if (!packagePresent || (needsBinary && !binaryPresent)) {
			row.status = 'skip'
			row.notes.push(target.hint
				? `没找到二进制 —— ${target.hint}`
				: '没安装 / 没找到 .node,这块二进制不存在就没有 ABI 可判')
			rows.push(row)
			continue
		}
		if (!binaryPresent) row.notes.push('壳包自身不带 .node,静态半边由它的平台包那一行负责')

		// ① 动态半边
		const underNode = runUnder(process.execPath, target, {})
		row.node = underNode
		if (!underNode.ok) { row.status = 'fail'; row.notes.push(`Node 下加载失败:${underNode.message}`) }

		if (!electron) {
			row.electron = { ok: false, skipped: true, message: 'node_modules/electron 没装或 dist 缺失' }
			row.notes.push('Electron 那半边没跑:node_modules/electron 不可用')
			if (row.status === 'ok') row.status = 'skip'
		} else {
			const underElectron = runUnder(electron, target, { ELECTRON_RUN_AS_NODE: '1' })
			row.electron = underElectron
			if (!underElectron.ok) { row.status = 'fail'; row.notes.push(`Electron 下加载失败:${underElectron.message}`) }
		}

		// ② 静态半边
		const symbols = binaryPresent
			? scanUndefinedSymbols(target.binary, target.kind)
			: { checked: false, reason: '这一行没有自己的 .node,静态半边不适用' }
		row.symbols = symbols
		if (symbols.checked && symbols.offenders.length > 0) {
			row.status = 'fail'
			row.notes.push(target.kind === 'sqlite-extension'
				? `未定义符号里有 sqlite3_* / libc 之外的东西(= 不是一份纯 C 的 SQLite 扩展):${symbols.offenders.join(' | ')}`
				: `未定义符号里有 V8/Node 内部符号(= 不是 N-API):${symbols.offenders.join(' | ')}`)
		} else if (!symbols.checked) {
			row.notes.push(symbols.reason)
		}

		if (row.status === 'fail') red += 1
		rows.push(row)
	}

	if (asJson) {
		process.stdout.write(`${JSON.stringify({ ok: red === 0, electron, rows }, null, 2)}\n`)
		process.exit(red === 0 ? 0 : 1)
	}

	console.log('[gate:native] 原生模块双运行时门')
	console.log(`[gate:native] 系统 Node ${process.versions.node} (MODULE_VERSION ${process.versions.modules})`)
	console.log(`[gate:native] Electron 二进制:${electron ?? '(不可用)'}`)
	for (const row of rows) {
		const mark = row.status === 'ok' ? 'ok  ' : row.status === 'skip' ? 'skip' : 'FAIL'
		console.log(`[gate:native] ${mark} ${row.name}`)
		if (row.binary) console.log(`[gate:native]        binary   ${row.binary}`)
		if (row.node) {
			console.log(`[gate:native]        node     ${row.node.ok ? `ok (MODULE_VERSION ${row.node.versions?.modules})` : `FAIL ${row.node.message}`}`)
		}
		if (row.electron) {
			console.log(`[gate:native]        electron ${row.electron.ok
				? `ok (electron ${row.electron.versions?.electron}, node ${row.electron.versions?.node}, MODULE_VERSION ${row.electron.versions?.modules})`
				: `${row.electron.skipped ? 'skip' : 'FAIL'} ${row.electron.message}`}`)
		}
		if (row.symbols?.checked) {
			console.log(`[gate:native]        symbols  undefined ${row.symbols.total}, napi_* ${row.symbols.napiCount}, v8/node 内部 ${row.symbols.offenders.length}`)
		}
		for (const note of row.notes) console.log(`[gate:native]        · ${note}`)
	}
	console.log(`[gate:native] complete: ${rows.length} targets, ${red} failed`)
	if (red > 0) {
		console.error('[gate:native] failed: 上面 FAIL 的每一条都意味着「一块二进制喂不了两个运行时」。')
		console.error('[gate:native] failed: 新原生依赖必须是 N-API(或 SQLite 这类内建 / 纯 C 扩展)。')
	}
	process.exit(red === 0 ? 0 : 1)
}

main()
