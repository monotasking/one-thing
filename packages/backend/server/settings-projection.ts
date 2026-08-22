/**
 * 设置面的 **http 投影** —— 出门脱敏、回来把脱敏值合并回真值。
 *
 * 结构债 P4c 第十一批之前这两只函数住在 `server/runtime.ts` 的 `settings`
 * facade adapter 旁边;那只 adapter 随四条数据面迁 `settingsRouter` 一起没了,
 * 而它带的**两道真护栏**必须留着 —— 于是整块搬到这里,由
 * `backend/rpc/domains/settings.ts` 在 `context.transport === 'http'` 那一支上
 * 逐字调用(同 `server/mcp-secrets.ts` 的判例:域文件可以 import server 下的
 * 纯投影模块)。
 *
 *  1. **出门脱敏**(`sanitizeSettingsForClient`):`apiKey` / `oauthToken` /
 *     `accessToken` / `refreshToken` / `idToken` 与 MCP server 的私密字段一律
 *     换成 `SERVER_REDACTED_SECRET`。桌面不脱敏 —— 它本来就在同一台机器上,
 *     脱了反而让设置页读不到自己刚填的值。
 *  2. **回来合并**(`mergeServerSettingsUpdate`):客户端交回来的设置若在敏感键
 *     上带着哨兵(或干脆没带这个键),用当前那份真值补齐,于是「只改个主题」
 *     不会把凭证洗掉。
 *
 * 行为逐字保留;唯一的变化是**读写的那份设置**:旧 adapter 读写的是 server
 * 自己那本 per-owner 缓存(`settingsByOwner` + `ServerSettingsStore`),
 * 现在与 mcp / oauth / agents / models / skills 同一条口径(拍板 #20)——
 * 一个 store 一份设置,web 与桌面读同一本 `<store>/settings.json`。
 */
import { mergeWithDefaults } from "@shared/defaults/settings.js";
import type { AppSettings } from "@shared/ipc/settings.js";
import {
	MCP_SERVER_PRIVATE_KEYS as mcpServerPrivateKeys,
	SERVER_REDACTED_SECRET,
	shouldRedactMcpPrivateValue,
} from "./mcp-secrets.js";

/** 出门要脱敏、回来要合并的敏感键。逐字沿用旧 `server/runtime.ts` 的那张表。 */
const sensitiveSettingKeys = new Set([
	"apiKey",
	"oauthToken",
	"accessToken",
	"refreshToken",
	"idToken",
]);

export function mergeServerSettingsUpdate(
	previousSettings: AppSettings | undefined,
	incomingSettings: unknown,
): AppSettings {
	const incoming = isRecord(incomingSettings)
		? (incomingSettings as Partial<AppSettings>)
		: {};
	const nextSettings = mergeWithDefaults(incoming);
	if (previousSettings) {
		preserveSensitiveSettings(nextSettings, previousSettings, incoming);
		preserveMcpServerPrivateSettings(nextSettings, previousSettings, incoming);
	}
	return nextSettings;
}

export function sanitizeSettingsForClient(settings: AppSettings): AppSettings {
	const sanitized = cloneJson(settings);
	redactSensitiveSettings(sanitized);
	redactMcpServerPrivateSettings(sanitized);
	return sanitized;
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shouldRedactSensitiveValue(value: unknown): boolean {
	return value !== undefined && value !== null && value !== "";
}

function redactSensitiveSettings(value: unknown): void {
	if (!value || typeof value !== "object") return;

	if (Array.isArray(value)) {
		for (const item of value) redactSensitiveSettings(item);
		return;
	}

	const record = value as Record<string, unknown>;
	for (const [key, child] of Object.entries(record)) {
		if (sensitiveSettingKeys.has(key) && shouldRedactSensitiveValue(child)) {
			record[key] = SERVER_REDACTED_SECRET;
		} else {
			redactSensitiveSettings(child);
		}
	}
}

function preserveSensitiveSettings(
	target: unknown,
	previous: unknown,
	incoming: unknown,
): void {
	if (
		!target ||
		!previous ||
		typeof target !== "object" ||
		typeof previous !== "object"
	)
		return;

	if (Array.isArray(target) && Array.isArray(previous)) {
		const incomingArray = Array.isArray(incoming) ? incoming : [];
		for (let index = 0; index < target.length; index += 1) {
			preserveSensitiveSettings(
				target[index],
				previous[index],
				incomingArray[index],
			);
		}
		return;
	}

	if (Array.isArray(target) || Array.isArray(previous)) return;

	const targetRecord = target as Record<string, unknown>;
	const previousRecord = previous as Record<string, unknown>;
	const incomingRecord = isRecord(incoming) ? incoming : {};

	for (const [key, previousValue] of Object.entries(previousRecord)) {
		if (sensitiveSettingKeys.has(key)) {
			if (!shouldRedactSensitiveValue(previousValue)) continue;
			const hasIncomingValue = Object.hasOwn(incomingRecord, key);
			const incomingValue = incomingRecord[key];
			if (!hasIncomingValue || incomingValue === SERVER_REDACTED_SECRET) {
				targetRecord[key] = cloneJson(previousValue);
			}
			continue;
		}

		preserveSensitiveSettings(
			targetRecord[key],
			previousValue,
			incomingRecord[key],
		);
	}
}

function redactMcpServerPrivateSettings(settings: AppSettings): void {
	const servers = settings.mcp?.servers;
	if (!Array.isArray(servers)) return;

	for (const server of servers) {
		if (!isRecord(server)) continue;
		for (const key of mcpServerPrivateKeys) {
			if (shouldRedactMcpPrivateValue(server[key])) {
				server[key] = SERVER_REDACTED_SECRET;
			}
		}
	}
}

function preserveMcpServerPrivateSettings(
	target: AppSettings,
	previous: AppSettings,
	incoming: unknown,
): void {
	if (!previous.mcp) return;
	if (!isRecord(incoming) || !Object.hasOwn(incoming, "mcp")) {
		target.mcp = cloneJson(previous.mcp);
		return;
	}

	const targetServers = Array.isArray(target.mcp?.servers)
		? target.mcp.servers
		: [];
	const previousServers = Array.isArray(previous.mcp?.servers)
		? previous.mcp.servers
		: [];
	const incomingServers =
		isRecord(incoming.mcp) && Array.isArray(incoming.mcp.servers)
			? incoming.mcp.servers
			: [];
	const targetById = mcpServersById(targetServers);
	const incomingById = mcpServersById(incomingServers);

	for (const previousServer of previousServers) {
		if (!isRecord(previousServer) || typeof previousServer.id !== "string")
			continue;
		const targetServer = targetById.get(previousServer.id);
		if (!targetServer) continue;
		const incomingServer = incomingById.get(previousServer.id);

		for (const key of mcpServerPrivateKeys) {
			const previousValue = previousServer[key];
			if (!shouldRedactMcpPrivateValue(previousValue)) continue;
			const hasIncomingValue = Boolean(
				incomingServer && Object.hasOwn(incomingServer, key),
			);
			const incomingValue = incomingServer?.[key];
			if (!hasIncomingValue || incomingValue === SERVER_REDACTED_SECRET) {
				targetServer[key] = cloneJson(previousValue);
			}
		}
	}
}

function mcpServersById(
	servers: unknown[],
): Map<string, Record<string, unknown>> {
	const byId = new Map<string, Record<string, unknown>>();
	for (const server of servers) {
		if (isRecord(server) && typeof server.id === "string") {
			byId.set(server.id, server);
		}
	}
	return byId;
}

