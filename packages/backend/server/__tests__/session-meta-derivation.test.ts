/**
 * 批 A §3.4:**`getSession` 不再物化**。
 *
 * 从前 `normalizeAppSession` 无条件 `listMessages(session.id)` 把整条会话组装一遍,
 * 只为填 `messageCount` / `previewText` 两个标量;而它挂在 `getSession` 上,于是
 * 每一条流式分片的归属判定都要付这笔钱(大会话真机 69ms/次)。
 *
 * 顺带钉住索引写点的通知口(§3.1 的失效口):命令面的索引写门与删会话那条路都要发。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionReads } from "../../session/reads.js";
import {
	clearAllSessionCache,
	findSessionIndexMeta,
	onSessionIndexChanged,
	updateSessionsIndexMetaForCommands,
} from "../../stores/sessions.js";
import { createAppBackedServerSessionStore } from "../runtime.js";
import { installStoreSessionLayerForTest } from "../../session/testing/store-layer.js";
let storeLayer: Awaited<ReturnType<typeof installStoreSessionLayerForTest>>;

describe("app 仓库背书的会话读面", () => {
	let storePath: string;
	let previousStorePath: string | undefined;

	beforeEach(async () => {
		previousStorePath = process.env.ONETHING_STORE_PATH;
		storePath = mkdtempSync(path.join(tmpdir(), "onething-meta-"));
		process.env.ONETHING_STORE_PATH = storePath;
		clearAllSessionCache();
		storeLayer = await installStoreSessionLayerForTest();
	});

	afterEach(async () => {
		await storeLayer?.dispose();
		vi.restoreAllMocks();
		clearAllSessionCache();
		if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH;
		else process.env.ONETHING_STORE_PATH = previousStorePath;
		rmSync(storePath, { recursive: true, force: true });
	});

	it("§3.4 `getSession` 一次都不调 `listMessages`", () => {
		const store = createAppBackedServerSessionStore(storePath);
		const created = store.createSession("meta-1", "读面不物化", {
			userId: "local-user",
			workspaceId: "default",
		});
		expect(created.id).toBe("meta-1");

		const listMessages = vi.spyOn(sessionReads, "listMessages");
		const session = store.getSession("meta-1");
		expect(session?.id).toBe("meta-1");
		// 唯一保留的那一行还在:agentId 缺省。
		expect(session?.agentId).toBeTruthy();
		expect(listMessages).not.toHaveBeenCalled();
	});

	it("§3.4 `saveSessionMeta` 也不再物化(它是第四个调用点)", () => {
		const store = createAppBackedServerSessionStore(storePath);
		const created = store.createSession("meta-2", "保存元数据", {
			userId: "local-user",
			workspaceId: "default",
		});

		const listMessages = vi.spyOn(sessionReads, "listMessages");
		store.saveSessionMeta(created);
		expect(listMessages).not.toHaveBeenCalled();
	});

	it("session 上没有 previewText 时,索引里那一格不被洗掉", () => {
		const store = createAppBackedServerSessionStore(storePath);
		const created = store.createSession("meta-4", "预览不被洗掉", {
			userId: "local-user",
			workspaceId: "default",
		});
		// 存量索引条目上有 previewText(老盘的常态:460 条里 6 条),而会话体没有。
		updateSessionsIndexMetaForCommands("meta-4", (meta) => {
			meta.previewText = "第一条用户消息的预览";
		});
		expect(findSessionIndexMeta("meta-4")?.previewText).toBe("第一条用户消息的预览");

		delete (created as { previewText?: string }).previewText;
		store.saveSessionMeta(created);
		expect(findSessionIndexMeta("meta-4")?.previewText).toBe("第一条用户消息的预览");
	});

	it("索引的按 id 视图与整份列表同答", () => {
		const store = createAppBackedServerSessionStore(storePath);
		store.createSession("meta-3", "按 id 找", {
			userId: "local-user",
			workspaceId: "default",
		});
		const fromList = store.getSessionsList().find((meta) => meta.id === "meta-3");
		expect(findSessionIndexMeta("meta-3")).toEqual(fromList);
		expect(findSessionIndexMeta("no-such-session")).toBeUndefined();
	});
});

describe("索引写点的通知口", () => {
	let storePath: string;
	let previousStorePath: string | undefined;

	beforeEach(async () => {
		previousStorePath = process.env.ONETHING_STORE_PATH;
		storePath = mkdtempSync(path.join(tmpdir(), "onething-index-port-"));
		process.env.ONETHING_STORE_PATH = storePath;
		clearAllSessionCache();
		storeLayer = await installStoreSessionLayerForTest();
	});

	afterEach(async () => {
		await storeLayer?.dispose();
		clearAllSessionCache();
		if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH;
		else process.env.ONETHING_STORE_PATH = previousStorePath;
		rmSync(storePath, { recursive: true, force: true });
	});

	it("命令面的索引写门发通知,删会话那条路也发,退订之后不再发", async () => {
		const store = createAppBackedServerSessionStore(storePath);
		store.createSession("port-1", "通知口", {
			userId: "local-user",
			workspaceId: "default",
		});

		const seen: Array<string | undefined> = [];
		const off = onSessionIndexChanged((sessionId) => seen.push(sessionId));

		updateSessionsIndexMetaForCommands("port-1", (meta) => {
			meta.name = "改过名";
		});
		expect(seen).toContain("port-1");

		seen.length = 0;
		await storeLayer.deleteSession("port-1");
		expect(seen).toContain("port-1");

		off();
		seen.length = 0;
		updateSessionsIndexMetaForCommands("port-1", () => {});
		expect(seen).toEqual([]);
	});
});
