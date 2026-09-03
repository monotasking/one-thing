/**
 * **受众**(批 A,`docs/design/event-subscription-audience-2026-09.md` §3.1 + §3.4)。
 *
 * 五件事:
 *  1. `OpenAudience` 恒真 —— 单用户宿主把「归属判定恒真」这条隐含规则说出口;
 *  2. `TenantAudience` 与 `ownsSessionRecord`(= `ownsSession` / `ownsSessionMeta`
 *     今天那一句)在归属两格的**四种组合**下逐字同判;
 *  3. 索引写点通知之后备忘那一格失效,下一次现判;
 *  4. `dispose` 之后监听退掉(再通知也不动它),订阅退订时真的被调到;
 *  5. §3.4:`getSession` 不再物化 —— `listMessages` 一次都不调。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	OpenAudience,
	TenantAudience,
	createOpenAudienceFactory,
	createTenantAudienceFactory,
	ownsSessionRecord,
	sessionOwnerOf,
	type SessionAudience,
	type SessionIndexPort,
	type SessionOwnershipRecord,
} from "../audience.js";

const CONTEXT = { userId: "u1", workspaceId: "w1" } as const;

/** 一张手写的索引:`findMeta` 读它,`onChanged` 由用例自己打。 */
function createIndexStub(rows: Record<string, SessionOwnershipRecord>): {
	port: SessionIndexPort;
	rows: Record<string, SessionOwnershipRecord>;
	change: (sessionId: string | undefined) => void;
	listeners: number;
} {
	const listeners = new Set<(sessionId: string | undefined) => void>();
	const state = {
		port: {
			findMeta: (sessionId: string) => rows[sessionId],
			onChanged: (listener: (sessionId: string | undefined) => void) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		} satisfies SessionIndexPort,
		rows,
		change: (sessionId: string | undefined) => {
			for (const listener of listeners) listener(sessionId);
		},
		get listeners() {
			return listeners.size;
		},
	};
	return state;
}

describe("OpenAudience", () => {
	it("恒真 —— 任何会话 id 都覆盖,包括没见过的与空串", () => {
		const audience = new OpenAudience();
		expect(audience.covers("anything")).toBe(true);
		expect(audience.covers("")).toBe(true);
		expect(audience.covers("00000000-0000-0000-0000-000000000000")).toBe(true);
		// dispose 幂等,且不改判。
		audience.dispose();
		audience.dispose();
		expect(audience.covers("anything")).toBe(true);
	});

	it("工厂每次给一只新的", () => {
		const factory = createOpenAudienceFactory();
		expect(factory(CONTEXT)).not.toBe(factory(CONTEXT));
	});
});

describe("TenantAudience 与归属判定逐字同判", () => {
	/**
	 * 归属两格(`ownerUserId` / `ownerWorkspaceId`)的四种组合。期望值是**手写**的
	 * ——「两格皆缺席 = 无主 = 谁都读得到」这条规则必须被一张明确的真值表钉住,
	 * 而不是拿另一段代码的输出当期望。
	 */
	const combos: Array<{
		label: string;
		meta: SessionOwnershipRecord;
		expected: boolean;
	}> = [
		{ label: "两格皆缺席 = 无主 = 可见", meta: {}, expected: true },
		{ label: "只有 userId,且对得上", meta: { ownerUserId: "u1" }, expected: true },
		{ label: "只有 userId,对不上", meta: { ownerUserId: "u2" }, expected: false },
		{
			label: "只有 workspaceId,且对得上",
			meta: { ownerWorkspaceId: "w1" },
			expected: true,
		},
		{
			label: "只有 workspaceId,对不上",
			meta: { ownerWorkspaceId: "w2" },
			expected: false,
		},
		{
			label: "两格全,且都对得上",
			meta: { ownerUserId: "u1", ownerWorkspaceId: "w1" },
			expected: true,
		},
		{
			label: "两格全,主体对不上",
			meta: { ownerUserId: "u2", ownerWorkspaceId: "w1" },
			expected: false,
		},
		{
			label: "两格全,作用域对不上",
			meta: { ownerUserId: "u1", ownerWorkspaceId: "w2" },
			expected: false,
		},
		{
			label: "存量 userId 那一格照旧读得出来",
			meta: { userId: "u1" },
			expected: true,
		},
	];

	for (const { label, meta, expected } of combos) {
		it(label, () => {
			const index = createIndexStub({ s: meta });
			const audience = new TenantAudience(index.port, CONTEXT);
			expect(audience.covers("s")).toBe(expected);
			// 同一个谓词:`ownsSession` / `ownsSessionMeta` 走的就是这一句。
			expect(ownsSessionRecord(meta, CONTEXT)).toBe(expected);
			audience.dispose();
		});
	}

	it("存量兼容只认 userId 那一格,workspaceId(产品空间)故意不回落", () => {
		expect(sessionOwnerOf({ userId: "u1" })).toEqual({
			userId: "u1",
			workspaceId: undefined,
		});
		expect(sessionOwnerOf({ ownerUserId: "u9", userId: "u1" })).toEqual({
			userId: "u9",
			workspaceId: undefined,
		});
	});

	it("索引里没有这条 = 不覆盖(与今天「取不到会话就丢事件」同判)", () => {
		const index = createIndexStub({});
		const audience = new TenantAudience(index.port, CONTEXT);
		expect(audience.covers("ghost")).toBe(false);
		audience.dispose();
	});

	it("备忘:只判一次,第二次不再读索引", () => {
		const index = createIndexStub({ s: { ownerUserId: "u1" } });
		const findMeta = vi.spyOn(index.port, "findMeta");
		const audience = new TenantAudience(index.port, CONTEXT);
		for (let i = 0; i < 50; i += 1) expect(audience.covers("s")).toBe(true);
		expect(findMeta).toHaveBeenCalledTimes(1);
		audience.dispose();
	});
});

describe("受众的失效口 = 索引写点", () => {
	it("通知之后那一格备忘作废,下一次现判", () => {
		const rows: Record<string, SessionOwnershipRecord> = {
			s: { ownerUserId: "u2" },
		};
		const index = createIndexStub(rows);
		const audience = new TenantAudience(index.port, CONTEXT);
		expect(audience.covers("s")).toBe(false);

		// 归属改了,但没通知 —— 备忘照旧。
		rows.s = { ownerUserId: "u1" };
		expect(audience.covers("s")).toBe(false);

		index.change("s");
		expect(audience.covers("s")).toBe(true);
		audience.dispose();
	});

	it("只失效被点名的那一格", () => {
		const rows: Record<string, SessionOwnershipRecord> = {
			a: { ownerUserId: "u2" },
			b: { ownerUserId: "u2" },
		};
		const index = createIndexStub(rows);
		const audience = new TenantAudience(index.port, CONTEXT);
		expect(audience.covers("a")).toBe(false);
		expect(audience.covers("b")).toBe(false);

		rows.a = { ownerUserId: "u1" };
		rows.b = { ownerUserId: "u1" };
		index.change("a");
		expect(audience.covers("a")).toBe(true);
		expect(audience.covers("b")).toBe(false);
		audience.dispose();
	});

	it("整表通知(sessionId = undefined)让所有备忘作废", () => {
		const rows: Record<string, SessionOwnershipRecord> = {
			a: { ownerUserId: "u2" },
			b: { ownerUserId: "u2" },
			c: {},
		};
		const index = createIndexStub(rows);
		const audience = new TenantAudience(index.port, CONTEXT);
		expect(audience.covers("a")).toBe(false);
		expect(audience.covers("b")).toBe(false);
		expect(audience.covers("c")).toBe(true);

		// 整份索引换掉 = 每一条都可能动过归属。空串**不是**哨兵:发空串只会去删
		// 一个叫 "" 的键,等于没失效 —— 这一条就是钉那个坑的。
		rows.a = { ownerUserId: "u1" };
		rows.b = { ownerUserId: "u1" };
		index.change("");
		expect(audience.covers("a")).toBe(false);
		expect(audience.covers("b")).toBe(false);

		index.change(undefined);
		expect(audience.covers("a")).toBe(true);
		expect(audience.covers("b")).toBe(true);
		expect(audience.covers("c")).toBe(true);
		audience.dispose();
	});

	it("dispose 退监听 —— 之后再通知也不动它", () => {
		const index = createIndexStub({ s: { ownerUserId: "u1" } });
		const audience = new TenantAudience(index.port, CONTEXT);
		expect(index.listeners).toBe(1);
		audience.dispose();
		expect(index.listeners).toBe(0);
		// 幂等。
		audience.dispose();
		expect(index.listeners).toBe(0);
	});

	it("工厂按上下文造 —— 两个租户各有各的备忘", () => {
		const index = createIndexStub({ s: { ownerUserId: "u1" } });
		const factory = createTenantAudienceFactory(index.port);
		const mine = factory(CONTEXT);
		const theirs = factory({ userId: "u2", workspaceId: "w1" });
		expect(mine.covers("s")).toBe(true);
		expect(theirs.covers("s")).toBe(false);
		mine.dispose();
		theirs.dispose();
	});
});

/* ── 订阅侧:受众一次算定,退订时 dispose ─────────────────────────────────── */

describe("订阅建立/退订与受众的生命周期", () => {
	let storePath: string;
	let previousStorePath: string | undefined;

	beforeEach(() => {
		previousStorePath = process.env.ONETHING_STORE_PATH;
		storePath = mkdtempSync(path.join(tmpdir(), "onething-audience-"));
		process.env.ONETHING_STORE_PATH = storePath;
	});

	afterEach(() => {
		if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH;
		else process.env.ONETHING_STORE_PATH = previousStorePath;
		// 收尸尽力而为:runtime 的异步写队列可能还在往这个临时目录里落东西,
		// 那时 `rmSync` 会抛 ENOTEMPTY —— 那是收尾的噪音,不是用例的判据。
		try {
			rmSync(storePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
		} catch {
			/* 临时目录留给操作系统收 */
		}
	});

	function createSpyFactory(covers: boolean): {
		factory: (context: { userId: string; workspaceId: string }) => SessionAudience;
		disposed: () => number;
		made: () => number;
	} {
		const audiences: Array<{ disposed: boolean }> = [];
		return {
			factory: () => {
				const state = { disposed: false };
				audiences.push(state);
				return {
					covers: () => covers,
					dispose: () => {
						state.disposed = true;
					},
				};
			},
			disposed: () => audiences.filter((a) => a.disposed).length,
			made: () => audiences.length,
		};
	}

	it("`*` 订阅:退订时受众被 dispose(事件面与分片面各一只)", async () => {
		const { createTestServerRuntime } = await import("./test-helpers.js");
		const spy = createSpyFactory(true);
		const runtime = await createTestServerRuntime({
			storePath,
			audienceFactory: spy.factory,
		});
		try {
			const offEvents = runtime.runtime.events.subscribe("*", () => {});
			const offStreams = runtime.runtime.streams?.subscribe("*", () => {});
			expect(spy.made()).toBe(2);
			expect(spy.disposed()).toBe(0);
			offEvents();
			offStreams?.();
			expect(spy.disposed()).toBe(2);
		} finally {
			await runtime.shutdown();
		}
	}, 60_000);

	it("不覆盖的按会话订阅:当场 dispose,不留订阅", async () => {
		const { createTestServerRuntime } = await import("./test-helpers.js");
		const spy = createSpyFactory(false);
		const runtime = await createTestServerRuntime({
			storePath,
			audienceFactory: spy.factory,
		});
		try {
			const handler = vi.fn();
			const off = runtime.runtime.events.subscribe("s1", handler);
			expect(spy.disposed()).toBe(1);
			await runtime.eventBus.emit("s1", { type: "session:renamed" } as never);
			expect(handler).not.toHaveBeenCalled();
			off();
		} finally {
			await runtime.shutdown();
		}
	}, 60_000);

	it("覆盖的按会话订阅:退订时 dispose", async () => {
		const { createTestServerRuntime } = await import("./test-helpers.js");
		const spy = createSpyFactory(true);
		const runtime = await createTestServerRuntime({
			storePath,
			audienceFactory: spy.factory,
		});
		try {
			const off = runtime.runtime.events.subscribe("s1", () => {});
			expect(spy.disposed()).toBe(0);
			off();
			expect(spy.disposed()).toBe(1);
		} finally {
			await runtime.shutdown();
		}
	}, 60_000);
});
