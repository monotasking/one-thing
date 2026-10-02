/**
 * `RequestBodyBuilder` —— **请求体只在这里长出来**(设计稿 §3)。
 *
 * 每个策略(thinking / cache / toolChoice / sampling / extraBody)拿到的都是
 * 同一个 builder,自己往里写自己的字段;基类只排顺序,不做判断
 * (§3.1「Tell, don't ask」)。
 *
 * 路径是点分的:`set('stream_options.include_usage', true)` 会按需补出中间
 * 对象。**不支持数组下标** —— 需要整段数组就整段 `set()`,免得出现「半个
 * messages 数组」这种没有 owner 的中间态。
 */

const DATA_URI_PREFIX = "data:";

function splitPath(path: string): string[] {
	return path.split(".").filter((segment) => segment.length > 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * data URI 的 base64 载荷在 dump 里换成一行摘要
 * (`<data-uri:image/png 12345 bytes>`),其余原样(§2.10)。
 *
 * 真机上 provider dump 曾经写出 1.1G,大头就是这些块。
 */
function summarizeDataUri(value: string): string {
	const comma = value.indexOf(",");
	if (comma < 0) return `<data-uri:unknown ${value.length - DATA_URI_PREFIX.length} bytes>`;
	const header = value.slice(DATA_URI_PREFIX.length, comma);
	const payload = value.slice(comma + 1);
	const base64 = /;base64$/i.test(header);
	const mediaType = (base64 ? header.replace(/;base64$/i, "") : header) || "text/plain";
	let bytes: number;
	if (base64) {
		const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
		bytes = Math.max(Math.floor((payload.length * 3) / 4) - padding, 0);
	} else {
		bytes = payload.length;
	}
	return `<data-uri:${mediaType} ${bytes} bytes>`;
}

function redactForDump(value: unknown): unknown {
	if (typeof value === "string") {
		return value.startsWith(DATA_URI_PREFIX) ? summarizeDataUri(value) : value;
	}
	if (Array.isArray(value)) return value.map(redactForDump);
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) out[key] = redactForDump(entry);
		return out;
	}
	return value;
}

export class RequestBodyBuilder {
	private readonly body: Record<string, unknown>;

	constructor(seed?: Record<string, unknown>) {
		this.body = seed ? { ...seed } : {};
	}

	set(path: string, value: unknown): this {
		const segments = splitPath(path);
		if (segments.length === 0) return this;
		let cursor = this.body;
		for (const segment of segments.slice(0, -1)) {
			const next = cursor[segment];
			if (!isPlainObject(next)) cursor[segment] = {};
			cursor = cursor[segment] as Record<string, unknown>;
		}
		cursor[segments[segments.length - 1]!] = value;
		return this;
	}

	get<T = unknown>(path: string): T | undefined {
		const segments = splitPath(path);
		let cursor: unknown = this.body;
		for (const segment of segments) {
			if (!isPlainObject(cursor)) return undefined;
			cursor = cursor[segment];
		}
		return cursor as T | undefined;
	}

	has(path: string): boolean {
		return this.get(path) !== undefined;
	}

	delete(path: string): this {
		const segments = splitPath(path);
		if (segments.length === 0) return this;
		let cursor: unknown = this.body;
		for (const segment of segments.slice(0, -1)) {
			if (!isPlainObject(cursor)) return this;
			cursor = cursor[segment];
		}
		if (isPlainObject(cursor)) delete cursor[segments[segments.length - 1]!];
		return this;
	}

	/**
	 * 要发出去的那个对象。builder 是每回合一只,交出去之后就不该再写。
	 * 类型参数只是给调用方一个名字 —— 这个类本身不带泛型,免得
	 * `RequestBodyBuilder<A>` 和 `RequestBodyBuilder<B>` 在策略接口之间
	 * 互相不可赋值(每个策略都得接同一只 builder)。
	 */
	build<TBody extends object = Record<string, unknown>>(): TBody {
		return this.body as TBody;
	}

	/** 落盘用的那份:data URI 摘要化,其余原样。永远不含认证头(那不在体里)。 */
	forDump(): unknown {
		return redactForDump(this.body);
	}
}
