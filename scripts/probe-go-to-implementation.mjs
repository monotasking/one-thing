#!/usr/bin/env node
/**
 * probe-go-to-implementation —— 端口缝的"边"探针(结构债 S 线 S2)。
 *
 * 用法:
 *   node --max-old-space-size=8192 scripts/probe-go-to-implementation.mjs [--verbose]
 *
 * 干什么:用 `typescript` 包起一个 LanguageService(配置取 `tsconfig.node.json`),
 * 对下面 PROBES 里每一条 `(file, needle, 期望实现文件)` 调
 * `LanguageService.getImplementationAtPosition` —— 也就是编辑器里 ⌘⌥click /
 * "Go to Implementation" 走的那条路 —— 断言它**落在**期望的实现文件上。
 *
 * 为什么不是 grep:S1 审计(docs/audit/port-seam-audit-2026-08.md §1.2)量出来的病灶正是
 * "类型检查器看得见、tsserver 的 gi 看不见"的鸭子口。只有真调 gi 才算证明缝上有边。
 *
 * 注意 `realpath: ts.sys.realpath` 那一行:workspace 包经 node_modules 软链解析,
 * 不给 realpath,LanguageService 会把同一个源文件当成两个,gi 直接空手而归(仓里踩过)。
 *
 * 这个脚本**不进 CI**,是 S2 的验收凭证与日后回归自查用的手动工具。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')

/**
 * 每条探针:
 *   file    仓库相对路径(消费点/使用点所在文件)
 *   needle  在该文件里定位光标的字符串;光标停在 needle 的最后一个标识符字符上
 *   nth     needle 的第几次出现(1 基,默认 1)
 *   expect  期望的实现文件(仓库相对路径前缀,任一命中即 PASS)
 *   note    这条缝是什么
 */
const PROBES = [
	// ── 1. 病历条:CoreSessionCommandEmitterLike / ...EventEmitterLike ← EventBus ──
	// 注意光标位置的语义差别:停在 `options.eventBus.emit` 的 **emit** 上,gi 找的是
	// 「这个方法的实现」——`EventBus` 自己没有声明 emit(它继承自 core 的 `CoreEventBus`),
	// 所以那里永远只会返回逐个声明了 emit 的对象。S2 装的是**口这一级**的边,所以探针
	// 停在口的类型引用与注入点上:
	{
		file: 'packages/core/events/ipc-operations.ts',
		needle: 'eventBus: CoreSessionCommandEmitterLike',
		expect: ['packages/backend/events/event-bus.ts'],
		note: '病历条 CoreSessionCommandEmitterLike → EventBus(全仓唯一生产供体)',
	},
	{
		file: 'packages/core/events/ipc-operations.ts',
		needle: 'options.eventBus',
		expect: ['packages/backend/rpc/domains/session-command.ts'],
		note: '病历条:消费点 → 装配层注入点',
	},
	{
		file: 'packages/core/events/ipc-operations.ts',
		needle: 'eventBus: CoreSessionEventEmitterLike',
		expect: ['packages/backend/events/event-bus.ts'],
		note: 'CoreSessionEventEmitterLike → EventBus',
	},

	// ── 2. 引擎五端口(消费点在 ProductStreamEngine 里的 this.ports.xxx)────────
	{
		file: 'packages/onething-runtime/src/engine/stream-engine.ts',
		needle: 'this.ports.router',
		expect: ['packages/backend/wiring/engine/stream-engine-bound.ts'],
		note: '引擎端口 router',
	},
	{
		file: 'packages/onething-runtime/src/engine/stream-engine.ts',
		needle: 'this.ports.roomIngress',
		expect: ['packages/backend/wiring/engine/stream-engine-bound.ts'],
		note: '引擎端口 roomIngress',
	},
	{
		file: 'packages/onething-runtime/src/engine/stream-engine.ts',
		needle: 'this.ports.pluginIntercept',
		expect: ['packages/backend/wiring/engine/stream-engine-bound.ts'],
		note: '引擎端口 pluginIntercept',
	},
	{
		file: 'packages/onething-runtime/src/engine/stream-engine.ts',
		needle: 'this.ports.agentBinding',
		expect: ['packages/backend/wiring/engine/stream-engine-bound.ts'],
		note: '引擎端口 agentBinding',
	},
	{
		file: 'packages/onething-runtime/src/engine/stream-engine.ts',
		needle: 'this.ports.steeringDelivery',
		expect: ['packages/backend/wiring/engine/stream-engine-bound.ts'],
		note: '引擎端口 steeringDelivery',
	},
]

/**
 * 其余缝按声明处抽样(≥30 条,core / runtime 两层都覆盖):光标停在接口名上,
 * 断言 gi 落到生产实现文件。清单是 S2 施工完成后按真实落点生成的,不是手抄的期望。
 */
const DECL_PROBES = [
	['packages/core/events/ipc-operations.ts', 'CoreSessionCommandEmitterLike', ['packages/backend/events/event-bus.ts', 'packages/backend/wiring/plugins/sessions.ts']],
	['packages/core/events/ipc-operations.ts', 'CoreSessionEventEmitterLike', ['packages/backend/events/event-bus.ts', 'packages/backend/wiring/plugins/sessions.ts']],
	['packages/core/engine/stream-runtime.ts', 'StreamEngineStoreAdapter', ['packages/backend/wiring/engine/stream-engine-runtime.ts']],
	['packages/core/engine/stream-runtime.ts', 'StreamEnginePermissionAdapter', ['packages/onething-runtime/src/product-stream-runtime.ts']],
	['packages/core/engine/stream-runtime.ts', 'StreamEngineProviderAdapter', ['packages/onething-runtime/src/providers/stream-provider-adapter.ts']],
	['packages/core/engine/stream-runtime.ts', 'StreamEngineHistoryAdapter', ['packages/onething-runtime/src/product-stream-runtime.ts']],
	['packages/core/engine/stream-runtime.ts', 'StreamEngineModelRegistryAdapter', ['packages/backend/wiring/engine/stream-engine-runtime.ts']],
	['packages/core/engine/stream-runtime.ts', 'StreamEngineCompactionAdapter', ['packages/onething-runtime/src/product-stream-runtime.ts']],
	['packages/core/engine/tool-orchestration.ts', 'CoreToolExecutionStore', ['packages/backend/wiring/engine/stream/tool-execution.ts']],
	['packages/core/engine/tool-orchestration.ts', 'ExecuteCoreToolAndUpdateOptions', ['packages/backend/wiring/engine/stream/tool-execution.ts']],
	['packages/core/engine/tool-step.ts', 'CreateToolStepWithFactoryOptions', ['packages/backend/wiring/engine/stream/tool-execution.ts']],
	['packages/core/engine/agent-loop-executor.ts', 'CoreAgentLoopToolExecutionStore', ['packages/backend/wiring/engine/stream/agent-loop-executor.ts']],
	['packages/core/engine/agent-loop-executor.ts', 'CoreAgentLoopToolInputProcessor', ['packages/backend/wiring/engine/stream/stream-processor.ts']],
	['packages/core/engine/agent-loop-executor.ts', 'CoreAgentLoopContentPartEmitter', ['packages/onething-runtime/src/engine/ipc-emitter.wiring.ts']],
	['packages/core/engine/agent-loop-executor.ts', 'CoreAgentLoopToolExecutionEmitter', ['packages/onething-runtime/src/engine/ipc-emitter.wiring.ts']],
	['packages/core/engine/stream-executor.ts', 'CoreStreamControllerRegistry', ['packages/backend/wiring/engine/stream/stream-executor.ts']],
	['packages/core/engine/stream-executor.ts', 'ExecuteCoreMessageStreamOptions', ['packages/backend/wiring/engine/stream/stream-executor.ts']],
	['packages/core/engine/stream-processor.ts', 'CoreStreamProcessorStore', ['packages/backend/wiring/engine/stream/stream-processor.ts']],
	['packages/core/engine/stream-processor.ts', 'CoreToolIdentityResolver', ['packages/core/engine/stream-processor.ts', 'packages/backend/wiring/engine/stream/stream-processor.ts']],
	['packages/core/engine/history.ts', 'CoreBuildHistoryMessagesOptions', ['packages/core/engine/history.ts', 'packages/onething-runtime/src/sessions/history-messages.ts', 'packages/core/session/projection/model-history.ts']],
	['packages/core/engine/message-content.ts', 'BuildMessageContentOptions', ['packages/core/engine/message-content.ts', 'packages/onething-runtime/src/sessions/history-messages.ts']],
	['packages/core/engine/event-only-emitter.ts', 'CoreEventOnlyEventBusLike', ['packages/backend/events/event-only-emitter.ts']],
	['packages/core/engine/event-only-emitter.ts', 'CoreEventOnlyStoreHooks', ['packages/backend/events/event-only-emitter.ts']],
	['packages/core/gateway-runtime.ts', 'CoreStreamChannelLike', ['packages/onething-runtime/src/gateway-runtime.ts']],
	['packages/core/permission/permission-policy.ts', 'PermissionBridge', ['packages/backend/wiring/tools/core/permission-policy.ts']],
	['packages/core/plugins/api-builder.ts', 'CorePluginAPIHost', ['packages/backend/wiring/plugins/api.ts']],
	['packages/core/plugins/manager.ts', 'CorePluginManagerHost', ['packages/backend/wiring/plugins/manager.ts']],
	['packages/core/plugins/scheduler.ts', 'CorePluginSchedulerHost', ['packages/onething-runtime/src/scheduler/scheduler.ts']],
	['packages/core/mcp/bridge-runtime.ts', 'CoreMCPBridgeRuntimeHost', ['packages/onething-runtime/src/mcp/bridge.wiring.ts']],
	['packages/core/runtime-facade.ts', 'RuntimeSessionsAdapter', ['packages/backend/server/runtime.ts']],
	['packages/core/runtime-facade.ts', 'RuntimeEventsAdapter', ['packages/backend/server/runtime.ts']],
	['packages/core/runtime-facade.ts', 'RuntimeStreamsAdapter', ['packages/backend/server/runtime.ts']],
	['packages/core/runtime-facade.ts', 'RuntimePermissionsAdapter', ['packages/backend/server/runtime.ts']],
	['packages/core/session/storage/jsonl/pager.ts', 'JsonlLogPageSource', ['packages/onething-runtime/src/sessions/storage-driver.ts']],
	['packages/core/session/storage/pagination.ts', 'ResolveSessionMessagesPageOptions', ['packages/onething-runtime/src/sessions/session-repository.ts']],
	['packages/core/logging/compat.ts', 'LegacyDuckLogger', ['packages/onething-runtime/src/logging/console-port.ts']],
	['packages/core/session/store-helpers.ts', 'CreateSessionWithAdaptersOptions', ['packages/onething-runtime/src/sessions/session-repository.ts']],
	['packages/core/session/store-helpers.ts', 'DeleteSessionWithAdaptersOptions', ['packages/onething-runtime/src/sessions/session-repository.ts']],
	['packages/onething-runtime/src/sessions/session-repository.ts', 'OnethingSessionRepositoryLogger', ['packages/onething-runtime/src/logging/console-port.ts']],
	['packages/onething-runtime/src/agent-loop/stream-runtime.ts', 'OnethingAgentLoopRuntimeHostAdapters', ['packages/backend/wiring/engine/stream/agent-loop-runtime.ts']],
	['packages/onething-runtime/src/triggers/skill-review.ts', 'OnethingSkillReviewAdapters', ['packages/backend/wiring/engine/triggers/skill-review.ts']],
	['packages/onething-runtime/src/tools/tool-execution-context.ts', 'ExecuteOnethingToolWithSessionContextOptions', ['packages/backend/rpc/domains/tools.ts']],
	['packages/onething-runtime/src/tools/tool-call-state.ts', 'ApplyOnethingToolCallUpdateOptions', ['packages/backend/rpc/domains/tools.ts']],
	['packages/onething-runtime/src/plugins/note-skills.ts', 'OnethingNoteSkillsPluginApi', ['packages/backend/wiring/plugins/types.ts', 'packages/backend/wiring/plugins/api.ts', 'packages/backend/wiring/plugins/manager.ts']],
	['packages/onething-runtime/src/plugins/ipc-operations.ts', 'OnethingPluginConfigAccess', ['packages/onething-runtime/src/plugins/config-access.ts']],
	['packages/onething-runtime/src/collab/actors/agent-actor.ts', 'CollabAgentOutbox', ['packages/onething-runtime/src/collab/actors/agent-replay.wiring.ts']],
	['packages/onething-runtime/src/sessions/storage-driver.ts', 'SessionStorageDriver', ['packages/onething-runtime/src/sessions/storage-driver.ts']],
	['packages/onething-runtime/src/sessions/stream-abort.ts', 'AbortOnethingStreamsForIpcOptions', ['packages/backend/rpc/domains/chat.ts']],
	['packages/onething-runtime/src/settings/settings-save.ts', 'SaveOnethingSettingsWithRuntimeEffectsOptions', ['packages/backend/rpc/domains/settings.ts']],
	['packages/onething-runtime/src/providers/provider-runtime.ts', 'OnethingChatTitleGenerationAdapters', ['packages/backend/rpc/domains/chat.ts']],
]

for (const [file, name, expect] of DECL_PROBES) {
	PROBES.push({ file, needle: name, decl: true, expect, note: `${name} 声明处 → 实现` })
}

// ── LanguageService ──────────────────────────────────────────────────────────

function createService() {
	const configPath = path.join(ROOT, 'tsconfig.node.json')
	const raw = ts.readConfigFile(configPath, ts.sys.readFile)
	if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, '\n'))
	const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, ROOT, undefined, configPath)

	const files = new Map()
	for (const f of parsed.fileNames) files.set(path.resolve(f), { version: 0 })

	const host = {
		getScriptFileNames: () => [...files.keys()],
		getScriptVersion: f => String(files.get(path.resolve(f))?.version ?? 0),
		getScriptSnapshot: f => {
			if (!ts.sys.fileExists(f)) return undefined
			return ts.ScriptSnapshot.fromString(ts.sys.readFile(f) ?? '')
		},
		getCurrentDirectory: () => ROOT,
		getCompilationSettings: () => parsed.options,
		getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
		// workspace 软链坑:不给 realpath,同一个源文件会被当成两份,gi 直接返回空。
		realpath: ts.sys.realpath,
	}
	return { service: ts.createLanguageService(host, ts.createDocumentRegistry()), files }
}

function resolvePosition(abs, needle, nth = 1, decl = false) {
	const text = fs.readFileSync(abs, 'utf8')
	if (decl) {
		// 声明处探针:光标必须停在 `interface|type|class X` 的 X 上,不能撞上某个使用点
		const m = new RegExp(`(?:interface|type|class)\\s+${needle}\\b`).exec(text)
		return m ? m.index + m[0].length - 1 : null
	}
	let idx = -1
	for (let i = 0; i < nth; i++) {
		idx = text.indexOf(needle, idx + 1)
		if (idx < 0) return null
	}
	// 光标停在 needle 最后一个标识符字符上(gi 认标识符,不认空白/标点)
	let pos = idx + needle.length - 1
	while (pos > idx && !/[A-Za-z0-9_$]/.test(text[pos])) pos--
	return pos
}

function main() {
	const { service, files } = createService()
	let pass = 0
	const failures = []

	for (const probe of PROBES) {
		const abs = path.join(ROOT, probe.file)
		const label = `${probe.file} :: ${probe.needle}`
		if (!files.has(path.resolve(abs))) {
			failures.push({ label, why: '文件不在 program 里', note: probe.note })
			console.log(`FAIL  ${label}  —— 文件不在 program 里`)
			continue
		}
		const pos = resolvePosition(abs, probe.needle, probe.nth ?? 1, probe.decl === true)
		if (pos == null) {
			failures.push({ label, why: `needle 未找到`, note: probe.note })
			console.log(`FAIL  ${label}  —— needle 未找到`)
			continue
		}
		let impls
		try {
			impls = service.getImplementationAtPosition(abs, pos) ?? []
		} catch (err) {
			failures.push({ label, why: `gi 抛错 ${err?.message}`, note: probe.note })
			console.log(`FAIL  ${label}  —— gi 抛错 ${err?.message}`)
			continue
		}
		const hitFiles = impls.map(i => path.relative(ROOT, i.fileName))
		const ok = hitFiles.some(h => probe.expect.some(e => h === e || h.startsWith(e)))
		if (ok) {
			pass++
			console.log(`PASS  ${label}  →  ${hitFiles.filter(h => probe.expect.some(e => h.startsWith(e))).join(', ')}`)
		} else {
			failures.push({ label, why: `gi 落点 ${hitFiles.length ? hitFiles.join(', ') : '(空)'};期望 ${probe.expect.join(' | ')}`, note: probe.note })
			console.log(`FAIL  ${label}  —— 落点 ${hitFiles.length ? hitFiles.join(', ') : '(空)'};期望 ${probe.expect.join(' | ')}`)
		}
		if (VERBOSE) console.log(`      (${probe.note}) 全部落点: ${hitFiles.join(', ') || '(空)'}`)
	}

	console.log('')
	console.log(`总计 ${PROBES.length} 条:PASS ${pass} / FAIL ${failures.length}`)
	if (failures.length) {
		console.log('')
		for (const f of failures) console.log(`  ✗ ${f.label}\n      ${f.note}\n      ${f.why}`)
		process.exitCode = 1
	}
}

main()
