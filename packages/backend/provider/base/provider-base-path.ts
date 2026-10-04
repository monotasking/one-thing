/**
 * 点号 + 下标的简单路径(`choices[0].delta.reasoning_content`)—— 批 4 适配表的读法
 * (`docs/design/provider-settings-rework-2026-09.md` §7.1)。不是 JSONPath:没有通配、
 * 没有过滤,认不出的路径一律读作 `undefined`。
 *
 * `usage.ts` 的 `readPath` 只认点号且只返回数字,那是 usage 表的读法;这一份认下标、
 * 返回原值,两者不是同一件事。
 */

/** `'choices[0].delta.x'` → `['choices', 0, 'delta', 'x']`。空串 / 语法不对 → `undefined`。 */
export function parsePath(path: string): Array<string | number> | undefined {
	const trimmed = path.trim();
	if (!trimmed) return undefined;
	const segments: Array<string | number> = [];
	for (const part of trimmed.split(".")) {
		const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
		if (!match) return undefined;
		const [, name, indexes] = match;
		if (name) segments.push(name);
		else if (!indexes) return undefined;
		for (const index of indexes!.matchAll(/\[(\d+)\]/g)) segments.push(Number(index[1]));
	}
	return segments;
}

export function getPath(value: unknown, path: string): unknown {
	const segments = parsePath(path);
	if (!segments) return undefined;
	let cursor: unknown = value;
	for (const segment of segments) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = typeof segment === "number"
			? (Array.isArray(cursor) ? cursor[segment] : undefined)
			: (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}
