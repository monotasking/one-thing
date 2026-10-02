/**
 * 「接口类型」下拉的选项(批 3 §6.1,`docs/design/provider-settings-rework-2026-09.md`)。
 *
 * 方言自述人话名(`Dialect.label`),这里只读表:**有名字的进下拉,没名字的不进** ——
 * 绑着某一家登录方式的那几份(Codex / Claude Code / Copilot / Kimi Code / grok 订阅)
 * 不自述名字,拿它去接一个转发站没有意义。加一份新方言 = 那一份自己写 `label`,别处零改。
 */
import "./dialects/index.js";
import { listDialects } from "./base/dialect.js";

export interface DialectOptionFacts {
	id: string;
	label: string;
}

export function listLabeledDialects(): DialectOptionFacts[] {
	const out: DialectOptionFacts[] = [];
	for (const dialect of listDialects()) {
		if (dialect.label) out.push({ id: dialect.id, label: dialect.label });
	}
	return out;
}

/** `providers.listDialects` 的答卷形状(错误成形归产品层,与别的 provider 查询口同一条)。 */
export function listLabeledDialectsForIpc(): {
	success: boolean;
	dialects?: DialectOptionFacts[];
	error?: string;
} {
	try {
		return { success: true, dialects: listLabeledDialects() };
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
}
