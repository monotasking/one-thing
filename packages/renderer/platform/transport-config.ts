/**
 * Web 传输面的**基址 / token 单槽端口**(React 壳方案 §5.6 甲案,
 * `docs/design/react-shell-2026-08.md`)。
 *
 * 现状:`platform/web.ts` 把 `/api/...` 当同源相对路径打,靠 apps/web 的 dev
 * 代理(`apps/web/dev-api-proxy.ts`)按发现文件定位真 core 并补上 Bearer。
 * 新的 React Electron 壳没有那层代理 —— 它的渲染层从 `file://` 或自己的 vite
 * dev server 加载,必须自己知道 `http://127.0.0.1:<port>` 和 token。
 *
 * 于是这里只加一个**单槽端口**,三条纪律:
 *
 *  1. **缺席 = 一个字节都不变**。没调用 `configureWebTransport` 时,
 *     `resolveApiUrl('/api/rpc')` 原样返回 `'/api/rpc'`,`applyAuthHeaders` 原样
 *     返回传进来的 headers(连空对象都不新造)。apps/web 因此零变化,更关键的是
 *     **决不双份注入** —— dev 代理已经在补 Bearer,这里再补一次就是两个来源。
 *  2. **EventSource 不能带 header**,所以配置了 token 时它走 `?token=` query;
 *     服务端只对 `GET /api/events` 认这条 query(`backend/server/http.ts`),
 *     且请求日志只记 pathname,token 不落盘。
 *  3. **本模块不认识任何域**。它只做"把一条 `/api/...` 路径翻译成一个绝对
 *     URL"和"给 fetch 补一个 Authorization",谁调用是调用者的事。
 */

export type WebTransportConfig = {
	/** 形如 `http://127.0.0.1:53219`;结尾的 `/` 会被剥掉。 */
	baseUrl: string;
	/** 发现文件里的 Bearer token;不给就只换基址不补鉴权。 */
	token?: string;
};

let current: WebTransportConfig | undefined;

/**
 * 装配这一槽。传 `undefined`(或不传)= 卸下,回到同源无 header 的现行行为
 * —— 测试用得上,产品代码里没有"卸下"的场景。
 */
export function configureWebTransport(config?: WebTransportConfig): void {
	if (!config) {
		current = undefined;
		return;
	}
	const baseUrl = config.baseUrl.replace(/\/+$/, "");
	current = config.token ? { baseUrl, token: config.token } : { baseUrl };
}

/** 只读快照,给诊断面用;没配置就是 `undefined`。 */
export function getWebTransportConfig(): WebTransportConfig | undefined {
	return current;
}

/**
 * 把一条以 `/` 开头的应用内路径翻成实际要打的 URL。
 * 未配置 = 原样返回(同源相对路径)。
 */
export function resolveApiUrl(path: string): string {
	if (!current) return path;
	if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path; // 已经是绝对 URL,不碰
	return `${current.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * 给 fetch 的 headers 补 `Authorization: Bearer …`。
 * 未配置(或没有 token)时**原样返回入参**,不新造对象 —— "缺席=零变化"。
 */
export function applyAuthHeaders(headers?: HeadersInit): HeadersInit | undefined {
	if (!current?.token) return headers;
	const merged = new Headers(headers);
	if (!merged.has("authorization")) {
		merged.set("authorization", `Bearer ${current.token}`);
	}
	return merged;
}

/**
 * EventSource 版:基址照翻,token 因为带不了 header 而进 query。
 * 未配置 = 原样返回。
 */
export function resolveEventSourceUrl(path: string): string {
	const resolved = resolveApiUrl(path);
	if (!current?.token) return resolved;
	const separator = resolved.includes("?") ? "&" : "?";
	return `${resolved}${separator}token=${encodeURIComponent(current.token)}`;
}
